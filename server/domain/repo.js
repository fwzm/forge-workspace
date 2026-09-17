'use strict';

const crypto = require('crypto');
const { splitLines, unifiedDiff } = require('../core/diff');
const { merge3 } = require('./merge');
const { ForgeError, CODES, notFound, invalidInput } = require('../core/errors');
const { assertRepoPath, assertBranchName, assertString } = require('../core/validation');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function conflictMarkers(detail, oursLabel, theirsLabel) {
  const lines = [`<<<<<<< ${oursLabel}`];
  if (detail.ours !== null && detail.ours !== undefined) lines.push(...splitLines(detail.ours));
  lines.push('=======');
  if (detail.theirs !== null && detail.theirs !== undefined) lines.push(...splitLines(detail.theirs));
  lines.push(`>>>>>>> ${theirsLabel}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Virtual repository: content-addressed blobs, flat trees, hash-chained commits,
// branch refs, working tree with dirty tracking, and a merge state machine.
// Paths always use forward slashes. Commits are deterministic given identical
// (tree, parents, message, author, timestamp).
// ---------------------------------------------------------------------------
class Repository {
  constructor(name) {
    this.name = name || 'virtual-repo';
    this.blobs = new Map();     // hash -> content
    this.trees = new Map();     // treeHash -> { path: blobHash }
    this.commits = new Map();   // commitHash -> { hash, tree, parents, message, author, timestamp }
    this.branches = new Map();  // name -> commitHash
    this.head = { branch: 'main', commit: null }; // null commit = unborn branch
    this.workingTree = new Map(); // path -> content (shadow of checked-out files + edits)
    this.worktreeBase = null;     // commit hash the working tree was materialized from
    this.mergeState = null;       // { source, sourceCommit, baseCommit, baseHead, conflicts: [paths] }
    this._deleted = null;         // Set of paths deleted relative to worktreeBase
  }

  // -- blob / tree helpers ---------------------------------------------------
  putBlob(content) {
    const h = sha256(content);
    this.blobs.set(h, content);
    return h;
  }

  treeOf(commitHash) {
    if (commitHash === null || commitHash === undefined) return {};
    const c = this.commits.get(commitHash);
    if (!c) throw notFound('Commit', commitHash);
    return this.trees.get(c.tree) || {};
  }

  treeHashFromEntries(entries) {
    const sorted = {};
    for (const k of Object.keys(entries).sort()) sorted[k] = entries[k];
    const h = sha256('tree:' + JSON.stringify(sorted));
    if (!this.trees.has(h)) this.trees.set(h, sorted);
    return h;
  }

  // -- working tree file operations -------------------------------------------
  writeFile(path, content) {
    assertRepoPath(path);
    assertString(content, 'content', { max: 512 * 1024 });
    this.workingTree.set(path, String(content));
    return { path, size: String(content).length };
  }

  readFile(path) {
    assertRepoPath(path);
    if (this.workingTree.has(path)) return this.workingTree.get(path);
    const tree = this.treeOf(this.head.commit);
    if (Object.prototype.hasOwnProperty.call(tree, path)) return this.blobs.get(tree[path]);
    throw notFound('File', path);
  }

  deleteFile(path) {
    assertRepoPath(path);
    if (!this.workingTree.has(path) && !Object.prototype.hasOwnProperty.call(this.treeOf(this.head.commit), path)) {
      throw notFound('File', path);
    }
    this.workingTree.delete(path);
    this._deleted = this._deleted || new Set();
    this._deleted.add(path);
    return { path, deleted: true };
  }

  renameFile(from, to) {
    assertRepoPath(from);
    assertRepoPath(to);
    if (from === to) throw invalidInput('rename source and target are identical', { from, to });
    const content = this.readFile(from); // throws when missing
    this.workingTree.delete(from);
    this.workingTree.set(to, content);
    this._deleted = this._deleted || new Set();
    this._deleted.add(from);
    return { from, to };
  }

  listFiles() {
    const paths = new Set(Object.keys(this.treeOf(this.head.commit)));
    for (const p of this.workingTree.keys()) paths.add(p);
    return [...paths]
      .filter((p) => !this._deleted || !this._deleted.has(p) || this.workingTree.has(p))
      .sort();
  }

  // status: working tree vs HEAD tree. Absence of a shadow copy means
  // "unchanged" (materialized/dropped); explicit deletions live in _deleted.
  status() {
    const headTree = this.treeOf(this.head.commit);
    const wt = this.workingTree;
    const modified = [];
    const added = [];
    const deleted = [];
    for (const [p, content] of wt) {
      if (Object.prototype.hasOwnProperty.call(headTree, p)) {
        if (this.blobs.get(headTree[p]) !== content) modified.push(p);
      } else {
        added.push(p);
      }
    }
    for (const p of Object.keys(headTree)) {
      if (!wt.has(p) && this._deleted && this._deleted.has(p)) deleted.push(p);
    }
    return {
      clean: modified.length === 0 && added.length === 0 && deleted.length === 0,
      modified: modified.sort(), added: added.sort(), deleted: deleted.sort(),
      branch: this.head.branch, commit: this.head.commit,
      merging: this.mergeState ? { source: this.mergeState.source, conflicts: [...this.mergeState.conflicts] } : null,
    };
  }

  isDirty() {
    return !this.status().clean;
  }

  // -- commits / branches --------------------------------------------------------
  commit(message, author, opts) {
    const o = opts || {};
    assertString(message, 'message', { min: 1, max: 512 });
    assertString(author, 'author', { min: 1, max: 128 });
    if (this.mergeState && !o.merge) {
      throw new ForgeError(CODES.STATE, 'Repository is in merging state; resolve conflicts and complete the merge or abort it');
    }
    const entries = {};
    const headTree = this.treeOf(this.head.commit);
    for (const p of Object.keys(headTree)) entries[p] = headTree[p];
    for (const [p, content] of this.workingTree) entries[p] = this.putBlob(content);
    if (this._deleted) for (const p of this._deleted) delete entries[p];
    if (this.mergeState && o.merge) {
      for (const p of this.mergeState.conflicts) {
        if (!this.workingTree.has(p)) {
          throw new ForgeError(CODES.CONFLICT, `Conflicted file was not resolved (missing from working tree): ${p}`, { path: p });
        }
      }
    }
    const tree = this.treeHashFromEntries(entries);
    const timestamp = o.timestamp !== undefined ? o.timestamp : Date.now();
    const parents = o.parents || (this.head.commit ? [this.head.commit] : []);
    const payload = JSON.stringify({ tree, parents, message, author, timestamp });
    const hash = sha256('commit:' + payload);
    if (!this.commits.has(hash)) {
      this.commits.set(hash, { hash, tree, parents, message, author, timestamp });
    }
    this.head.commit = hash;
    this.branches.set(this.head.branch, hash);
    this.worktreeBase = hash;
    this._deleted = null;
    const wasMerge = Boolean(this.mergeState);
    if (wasMerge) this.mergeState = null;
    // Drop shadow copies whose content now equals HEAD (worktree becomes clean).
    const newTree = this.trees.get(tree) || {};
    for (const [p, content] of [...this.workingTree]) {
      if (Object.prototype.hasOwnProperty.call(newTree, p) && this.blobs.get(newTree[p]) === content) {
        this.workingTree.delete(p);
      }
    }
    return this.commits.get(hash);
  }

  checkout(ref, opts) {
    const force = opts && opts.force === true;
    if (this.mergeState) {
      throw new ForgeError(CODES.STATE, 'Cannot checkout during an unfinished merge; resolve or abort it first');
    }
    const dirty = this.isDirty();
    if (dirty && !force) {
      const st = this.status();
      throw new ForgeError(CODES.DIRTY_WORKTREE,
        `Working tree has uncommitted changes (${[...st.modified, ...st.added, ...st.deleted].join(', ') || 'unknown'}); commit first or pass force:true`,
        { status: st });
    }
    let target;
    if (this.branches.has(ref)) {
      target = { branch: ref, commit: this.branches.get(ref) };
    } else if (this.commits.has(ref)) {
      target = { branch: null, commit: ref };
    } else {
      throw notFound('Branch or commit', ref);
    }
    this.head = target;
    const tree = this.treeOf(target.commit);
    this.workingTree = new Map();
    for (const [p, bh] of Object.entries(tree)) this.workingTree.set(p, this.blobs.get(bh));
    this._deleted = null;
    this.worktreeBase = target.commit;
    return { ref, mode: target.branch ? 'branch' : 'detached', commit: target.commit };
  }

  checkoutBranch(ref, opts) {
    return this.checkout(ref, opts);
  }

  createBranch(name, fromRef) {
    assertBranchName(name);
    if (this.branches.has(name)) throw new ForgeError(CODES.STATE, `Branch already exists: ${name}`);
    const from = fromRef || (this.head.branch || this.head.commit);
    let commitHash;
    if (this.branches.has(from)) commitHash = this.branches.get(from);
    else if (this.commits.has(from)) commitHash = from;
    else throw notFound('Branch or commit', from);
    this.branches.set(name, commitHash);
    return { name, commit: commitHash };
  }

  deleteBranch(name) {
    assertBranchName(name);
    if (!this.branches.has(name)) throw notFound('Branch', name);
    if (this.head.branch === name) throw new ForgeError(CODES.STATE, `Cannot delete the checked-out branch: ${name}`);
    this.branches.delete(name);
    return { deleted: name };
  }

  listBranches() {
    const out = [];
    for (const [name, commit] of this.branches) {
      out.push({ name, commit, current: this.head.branch === name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // -- history / diffs --------------------------------------------------------------
  log(limit) {
    const out = [];
    let c = this.head.commit;
    const max = limit || 50;
    while (c && out.length < max) {
      const meta = this.commits.get(c);
      out.push({ hash: meta.hash, message: meta.message, author: meta.author, timestamp: meta.timestamp, parents: meta.parents });
      c = meta.parents[0] || null;
    }
    return out;
  }

  resolveRef(ref) {
    if (ref === null || ref === undefined || ref === 'HEAD') return this.head.commit;
    if (ref === 'HEAD~1') {
      const c = this.commits.get(this.head.commit);
      return c && c.parents[0] ? c.parents[0] : null;
    }
    if (this.branches.has(ref)) return this.branches.get(ref);
    if (this.commits.has(ref)) return ref;
    throw notFound('Ref (branch or commit)', ref);
  }

  snapshot(ref) {
    const tree = this.treeOf(this.resolveRef(ref));
    const out = {};
    for (const [p, bh] of Object.entries(tree)) out[p] = this.blobs.get(bh);
    return out;
  }

  diffRefs(aRef, bRef) {
    const a = this.snapshot(aRef === undefined ? null : aRef);
    const b = this.snapshot(bRef === undefined ? null : bRef);
    const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const files = [];
    for (const p of paths) {
      const inA = Object.prototype.hasOwnProperty.call(a, p);
      const inB = Object.prototype.hasOwnProperty.call(b, p);
      if (!inA && !inB) continue;
      const kind = !inA ? 'added' : !inB ? 'deleted' : (a[p] === b[p] ? 'equal' : 'modified');
      if (kind === 'equal') continue;
      const patch = unifiedDiff(splitLines(inA ? a[p] : ''), splitLines(inB ? b[p] : ''), { aLabel: `a/${p}`, bLabel: `b/${p}` });
      files.push({
        path: p, kind,
        additions: kind === 'deleted' ? 0 : splitLines(inB ? b[p] : '').filter((_, i, arr) => true).length - (inA && inB ? splitLines(a[p]).length : 0),
        deletions: kind === 'added' ? 0 : (inA && inB ? Math.max(0, splitLines(a[p]).length - splitLines(b[p]).length) : splitLines(a[p]).length),
        patch,
      });
    }
    return { from: aRef === undefined ? 'HEAD' : (aRef === null ? 'HEAD' : aRef), to: bRef === undefined ? 'HEAD' : (bRef === null ? 'HEAD' : bRef), files };
  }

  diffWorkingTree(path) {
    const headTree = this.treeOf(this.head.commit);
    const before = Object.prototype.hasOwnProperty.call(headTree, path) ? this.blobs.get(headTree[path]) : '';
    const after = this.workingTree.has(path) ? this.workingTree.get(path) : '';
    return unifiedDiff(splitLines(before), splitLines(after), { aLabel: `HEAD:${path}`, bLabel: `worktree:${path}` });
  }

  // -- merge machinery -----------------------------------------------------------------
  ancestors(startCommit) {
    const seen = new Map(); // hash -> min depth
    const queue = [[startCommit, 0]];
    while (queue.length) {
      const [h, d] = queue.shift();
      if (h === null || h === undefined) continue;
      if (seen.has(h) && seen.get(h) <= d) continue;
      seen.set(h, d);
      const meta = this.commits.get(h);
      for (const p of meta.parents) queue.push([p, d + 1]);
    }
    return seen;
  }

  mergeBase(aCommit, bCommit) {
    const aa = this.ancestors(aCommit);
    const ab = this.ancestors(bCommit);
    let best = null;
    for (const [h, d] of aa) {
      if (ab.has(h) && (best === null || d < best.depth)) best = { commit: h, depth: d };
    }
    return best ? best.commit : null;
  }

  isAncestor(ancestor, descendant) {
    const seen = new Set();
    const queue = [descendant];
    while (queue.length) {
      const h = queue.shift();
      if (!h || seen.has(h)) continue;
      if (h === ancestor) return true;
      seen.add(h);
      for (const p of this.commits.get(h).parents) queue.push(p);
    }
    return false;
  }

  // Merge `sourceRef` (branch) into the current branch. Returns one of:
  //  { status: 'up-to-date' }
  //  { status: 'fast-forward', commit }
  //  { status: 'clean', commit, files }
  //  { status: 'conflict', conflicts, details }
  merge(sourceRef, opts) {
    const o = opts || {};
    if (this.mergeState) throw new ForgeError(CODES.STATE, `A merge is already in progress with ${this.mergeState.source}`);
    if (!this.branches.has(sourceRef)) throw notFound('Branch', sourceRef);
    const ours = this.head.commit;
    const theirs = this.branches.get(sourceRef);
    if (ours === theirs || this.isAncestor(theirs, ours)) return { status: 'up-to-date' };
    if (this.isAncestor(ours, theirs)) {
      this.head.commit = theirs;
      this.branches.set(this.head.branch, theirs);
      const tree = this.treeOf(theirs);
      this.workingTree = new Map();
      for (const [p, bh] of Object.entries(tree)) this.workingTree.set(p, this.blobs.get(bh));
      this.worktreeBase = theirs;
      return { status: 'fast-forward', commit: theirs };
    }
    const base = this.mergeBase(ours, theirs);
    if (base === null) throw new ForgeError(CODES.CONFLICT, 'Unrelated histories: no common ancestor', { ours, theirs });

    const baseFiles = this.snapshot(base);
    const oursFiles = this.snapshot(ours);
    const theirsFiles = this.snapshot(theirs);
    const paths = [...new Set([...Object.keys(baseFiles), ...Object.keys(oursFiles), ...Object.keys(theirsFiles)])].sort();
    const result = {};         // path -> content (merged, no markers)
    const conflicts = [];
    const conflictDetails = []; // { path, base, ours, theirs } (null content = deleted on that side)

    for (const p of paths) {
      const inB = Object.prototype.hasOwnProperty.call(baseFiles, p);
      const inO = Object.prototype.hasOwnProperty.call(oursFiles, p);
      const inT = Object.prototype.hasOwnProperty.call(theirsFiles, p);
      if (!inO && !inT) continue; // deleted on both sides
      if (inO && inT && oursFiles[p] === theirsFiles[p]) { result[p] = oursFiles[p]; continue; }
      if (!inB) {
        // added after the merge base
        if (inO && inT) {
          conflicts.push(p);
          conflictDetails.push({ path: p, base: null, ours: oursFiles[p], theirs: theirsFiles[p] });
        } else if (inO) {
          result[p] = oursFiles[p];
        } else {
          result[p] = theirsFiles[p];
        }
        continue;
      }
      if (!inO || !inT) {
        const survivor = inO ? oursFiles[p] : theirsFiles[p];
        if (survivor === baseFiles[p]) continue; // the surviving side did not modify it: delete wins
        // one side deleted, the other modified: conflict
        conflicts.push(p);
        conflictDetails.push({ path: p, base: baseFiles[p], ours: inO ? oursFiles[p] : null, theirs: inT ? theirsFiles[p] : null });
        continue;
      }
      // modified on both sides
      if (oursFiles[p] === baseFiles[p]) { result[p] = theirsFiles[p]; continue; }
      if (theirsFiles[p] === baseFiles[p]) { result[p] = oursFiles[p]; continue; }
      const m = merge3(splitLines(baseFiles[p]), splitLines(oursFiles[p]), splitLines(theirsFiles[p]));
      if (m.conflicts.length === 0) {
        result[p] = m.text;
      } else {
        conflicts.push(p);
        conflictDetails.push({ path: p, base: baseFiles[p], ours: oursFiles[p], theirs: theirsFiles[p] });
      }
    }

    if (conflicts.length > 0) {
      this.mergeState = { source: sourceRef, sourceCommit: theirs, baseCommit: base, baseHead: ours, conflicts };
      const wt = new Map();
      for (const [p, content] of Object.entries(result)) wt.set(p, content);
      for (const d of conflictDetails) {
        wt.set(d.path, conflictMarkers(d, 'ours', 'theirs'));
      }
      this.workingTree = wt;
      this._deleted = null;
      return { status: 'conflict', conflicts: [...conflicts], details: conflictDetails.map((d) => ({ path: d.path })) };
    }

    this.workingTree = new Map(Object.entries(result));
    this._deleted = null;
    const commit = this.commit(o.message || `Merge branch '${sourceRef}' into ${this.head.branch}`, o.author || 'forge-system', {
      merge: true,
      parents: [ours, theirs],
      timestamp: o.timestamp,
    });
    return { status: 'clean', commit: commit.hash, files: Object.keys(result).sort() };
  }

  // Resolve one conflicted file: pick 'ours' | 'theirs' | write manual content.
  resolveConflict(path, choice, content) {
    if (!this.mergeState) throw new ForgeError(CODES.STATE, 'No merge in progress');
    if (!this.mergeState.conflicts.includes(path)) throw notFound('Conflicted file', path);
    if (choice === 'ours' || choice === 'theirs') {
      const src = this.snapshot(choice === 'ours' ? this.mergeState.baseHead : this.mergeState.sourceCommit);
      if (Object.prototype.hasOwnProperty.call(src, path)) {
        this.workingTree.set(path, src[path]);
      } else {
        this.workingTree.delete(path); // that side deleted the file
        this._deleted = this._deleted || new Set();
        this._deleted.add(path);
      }
    } else if (choice === 'manual') {
      assertString(content, 'content', { max: 512 * 1024 });
      this.workingTree.set(path, String(content));
    } else {
      throw invalidInput(`choice must be 'ours' | 'theirs' | 'manual'`, { choice });
    }
    this.mergeState.conflicts = this.mergeState.conflicts.filter((p) => p !== path);
    return { path, resolved: true, remaining: [...this.mergeState.conflicts] };
  }

  abortMerge() {
    if (!this.mergeState) throw new ForgeError(CODES.STATE, 'No merge in progress');
    const back = this.mergeState.baseHead;
    const tree = this.treeOf(back);
    this.workingTree = new Map();
    for (const [p, bh] of Object.entries(tree)) this.workingTree.set(p, this.blobs.get(bh));
    this.mergeState = null;
    this._deleted = null;
    return { aborted: true, restored: back };
  }

  completeMerge(message, author, opts) {
    if (!this.mergeState) throw new ForgeError(CODES.STATE, 'No merge in progress');
    if (this.mergeState.conflicts.length > 0) {
      throw new ForgeError(CODES.CONFLICT, `Unresolved conflicts: ${this.mergeState.conflicts.join(', ')}`, { conflicts: [...this.mergeState.conflicts] });
    }
    const { source, sourceCommit, baseHead } = this.mergeState;
    const commit = this.commit(message || `Merge branch '${source}' into ${this.head.branch}`, author, {
      merge: true, parents: [baseHead, sourceCommit], timestamp: opts && opts.timestamp,
    });
    return { status: 'clean', commit: commit.hash };
  }

  serialize() {
    return {
      name: this.name,
      blobs: [...this.blobs],
      trees: [...this.trees],
      commits: [...this.commits],
      branches: [...this.branches],
      head: this.head,
      workingTree: [...this.workingTree],
      worktreeBase: this.worktreeBase,
      mergeState: this.mergeState,
    };
  }

  static deserialize(data) {
    if (!data || !Array.isArray(data.blobs) || !Array.isArray(data.commits)) {
      throw invalidInput('repository state is malformed');
    }
    const r = new Repository(data.name);
    r.blobs = new Map(data.blobs);
    r.trees = new Map(data.trees || []);
    r.commits = new Map(data.commits);
    r.branches = new Map(data.branches || []);
    r.head = data.head || { branch: 'main', commit: null };
    r.workingTree = new Map(data.workingTree || []);
    r.worktreeBase = data.worktreeBase || null;
    r.mergeState = data.mergeState || null;
    return r;
  }
}

module.exports = { Repository, sha256 };
