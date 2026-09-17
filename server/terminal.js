'use strict';

const { ForgeError } = require('./core/errors');

// ---------------------------------------------------------------------------
// Workspace shell. Commands execute against real domain APIs with the caller's
// permissions (actor = local admin). Returns { lines } for the UI.
// ---------------------------------------------------------------------------
function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function execute(ws, line, actor) {
  const argv = tokenize(String(line || '').trim());
  if (argv.length === 0) return { lines: [] };
  const cmd = argv[0];
  const args = argv.slice(1);
  const out = [];
  const repo = ws.repo;

  switch (cmd) {
    case 'help':
      out.push(
        'FORGE shell — commands:',
        '  ls [dir]                 list repository files',
        '  cat <path>               print a file',
        '  write <path> <text>      create/overwrite a file (single line)',
        '  rm <path>                delete a file',
        '  mv <from> <to>           rename a file',
        '  status                   working tree status',
        '  diff [path]              working tree vs HEAD',
        '  commit -m <message>      commit the working tree',
        '  log [n]                  commit history',
        '  branch [name]            list branches / create one',
        '  branch -d <name>         delete a branch',
        '  checkout <ref>           switch branch (or -b <name> to create)',
        '  merge <branch>           merge a branch into the current one',
        '  resolve <path> ours|theirs   resolve a merge conflict',
        '  merge-continue [msg]     commit a resolved merge',
        '  merge-abort              abort an in-progress merge',
        '  tasks | task <id>        task DAG / one task',
        '  agents                   agent roster',
        '  issues                   issue list',
        '  pr [id]                  pull requests',
        '  pr open <src> <tgt> <title...>',
        '  pr approve|reject|merge|close <id>',
        '  ci [ref|pr:<id>]         run the CI pipeline',
        '  runs                     CI run history',
        '  audit [n]                audit log tail',
        '  messages [n]             agent message tail',
        '  demo next | demo run | demo seed',
        '  whoami | export | reset [seed]',
      );
      break;
    case 'ls': {
      const prefix = args[0] ? args[0].replace(/\/$/, '') + '/' : '';
      const files = repo.listFiles().filter((p) => p.startsWith(prefix));
      if (files.length === 0) out.push('(empty)');
      const dirs = new Set();
      for (const p of files) {
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) out.push(rest);
        else dirs.add(rest.slice(0, slash + 1));
      }
      for (const d of [...dirs].sort()) out.push(d);
      break;
    }
    case 'cat': {
      if (!args[0]) { out.push('usage: cat <path>'); break; }
      const content = ws.readFile(args[0]);
      const contentLines = content.split('\n');
      if (contentLines.length && contentLines[contentLines.length - 1] === '') contentLines.pop();
      out.push(...contentLines);
      break;
    }
    case 'write': {
      if (args.length < 2) { out.push('usage: write <path> <text>'); break; }
      const [path, ...rest] = args;
      ws.writeFile(actor, path, rest.join(' ') + '\n');
      out.push(`wrote ${path}`);
      break;
    }
    case 'rm': {
      ws.deleteFile(actor, args[0]);
      out.push(`deleted ${args[0]}`);
      break;
    }
    case 'mv': {
      ws.renameFile(actor, args[0], args[1]);
      out.push(`renamed ${args[0]} -> ${args[1]}`);
      break;
    }
    case 'status': {
      const st = repo.status();
      out.push(`branch: ${st.branch} @ ${(st.commit || 'unborn').slice(0, 10)}`);
      if (st.merging) out.push(`MERGING: source=${st.merging.source} conflicts=${st.merging.conflicts.join(', ') || 'none pending'}`);
      for (const m of st.modified) out.push(`  modified: ${m}`);
      for (const a of st.added) out.push(`  added:    ${a}`);
      for (const d of st.deleted) out.push(`  deleted:  ${d}`);
      if (st.clean && !st.merging) out.push('clean');
      break;
    }
    case 'diff': {
      const paths = args.length ? args : repo.listFiles();
      let any = false;
      for (const p of paths) {
        const patch = repo.diffWorkingTree(p);
        if (patch) { out.push(patch); any = true; }
      }
      if (!any) out.push('(no working tree changes)');
      break;
    }
    case 'commit': {
      let message = null;
      if (args[0] === '-m') message = args.slice(1).join(' ');
      else message = args.join(' ');
      if (!message) { out.push('usage: commit -m <message>'); break; }
      const c = ws.commit(actor, message);
      out.push(`committed ${c.hash.slice(0, 10)} on ${repo.head.branch}: ${c.message}`);
      break;
    }
    case 'log': {
      const n = Math.min(parseInt(args[0] || '10', 10) || 10, 100);
      for (const c of repo.log(n)) {
        out.push(`${c.hash.slice(0, 10)} ${c.author.padEnd(10)} ${c.message}${c.parents.length > 1 ? ' (merge)' : ''}`);
      }
      break;
    }
    case 'branch': {
      if (args[0] === '-d') {
        ws.deleteBranch(actor, args[1]);
        out.push(`deleted branch ${args[1]}`);
      } else if (args[0]) {
        ws.createBranch(actor, args[0]);
        out.push(`created branch ${args[0]}`);
      } else {
        for (const b of repo.listBranches()) out.push(`${b.current ? '* ' : '  '}${b.name} @ ${b.commit.slice(0, 10)}`);
      }
      break;
    }
    case 'checkout': {
      if (args[0] === '-b') {
        ws.createBranch(actor, args[1]);
        ws.checkoutBranch(actor, args[1], {});
        out.push(`created and switched to ${args[1]}`);
      } else {
        ws.checkoutBranch(actor, args[0], {});
        out.push(`switched to ${args[0]} (${repo.head.branch ? 'branch' : 'detached'})`);
      }
      break;
    }
    case 'merge': {
      const res = ws.mergeRepo(actor, args[0], {});
      if (res.status === 'up-to-date') out.push('already up to date');
      else if (res.status === 'fast-forward') out.push(`fast-forwarded to ${res.commit.slice(0, 10)}`);
      else if (res.status === 'clean') out.push(`merged cleanly as ${res.commit.slice(0, 10)} (${res.files.length} files)`);
      else if (res.status === 'conflict') {
        out.push(`CONFLICT in ${res.conflicts.length} file(s): ${res.conflicts.join(', ')}`);
        out.push('resolve with: resolve <path> ours|theirs, then merge-continue');
      }
      break;
    }
    case 'resolve': {
      const choice = args[1];
      if (!['ours', 'theirs'].includes(choice)) { out.push('usage: resolve <path> ours|theirs'); break; }
      const r = ws.resolveConflict(actor, args[0], choice);
      out.push(`resolved ${args[0]} (${choice}); remaining: ${r.remaining.length}`);
      break;
    }
    case 'merge-continue': {
      const r = ws.completeMerge(actor, args.length ? args.join(' ') : undefined, {});
      out.push(`merge committed as ${r.commit.slice(0, 10)}`);
      break;
    }
    case 'merge-abort': {
      ws.abortMerge(actor);
      out.push('merge aborted; working tree restored');
      break;
    }
    case 'tasks': {
      for (const t of ws.tasks.list()) {
        out.push(`${t.id}  ${t.status.padEnd(10)} ${t.type.padEnd(10)} ${t.title}`);
      }
      break;
    }
    case 'task': {
      const t = ws.tasks.get(args[0]);
      out.push(JSON.stringify({ ...t, dependencies: t.dependencies }, null, 1));
      break;
    }
    case 'agents': {
      for (const a of ws.agents.list()) out.push(`${a.id}  ${a.type.padEnd(10)} ${a.status.padEnd(8)} ${a.name}`);
      break;
    }
    case 'issues': {
      for (const i of ws.issues) out.push(`${i.id}  [${i.state}] ${i.title}`);
      break;
    }
    case 'pr': {
      if (args[0] === 'open') {
        const pr = ws.openPr(actor, { sourceBranch: args[1], targetBranch: args[2], title: args.slice(3).join(' ') || 'PR from shell' });
        out.push(`opened ${pr.id}: ${pr.sourceBranch} -> ${pr.targetBranch}`);
      } else if (['approve', 'reject', 'merge', 'close'].includes(args[0])) {
        const id = args[1];
        if (args[0] === 'approve') ws.reviewPr(actor, id, { type: 'approve', comment: 'approved via shell' });
        if (args[0] === 'reject') ws.reviewPr(actor, id, { type: 'request_changes', comment: 'changes requested via shell' });
        if (args[0] === 'merge') ws.mergePr(actor, id);
        if (args[0] === 'close') ws.closePr(actor, id);
        const pr = ws.prs.get(id);
        out.push(`${id} is now ${pr.state}`);
      } else if (args[0]) {
        const pr = ws.prs.get(args[0]);
        out.push(JSON.stringify({ id: pr.id, state: pr.state, title: pr.title, source: pr.sourceBranch, target: pr.targetBranch, reviews: pr.reviews.length, headSha: pr.headSha }, null, 1));
      } else {
        for (const pr of ws.prs.list()) out.push(`${pr.id}  [${pr.state}] ${pr.sourceBranch} -> ${pr.targetBranch}: ${pr.title}`);
      }
      break;
    }
    case 'ci': {
      let opts = {};
      if (args[0] && args[0].startsWith('pr:')) opts = { prId: args[0].slice(3) };
      else if (args[0]) opts = { ref: args[0] };
      const run = await ws.runCi(actor, opts);
      out.push(`run ${run.id} on ${run.ref}@${run.sha.slice(0, 10)} -> ${run.status}`);
      for (const s of run.stages) out.push(`  ${s.name.padEnd(12)} ${s.status}`);
      break;
    }
    case 'runs': {
      for (const r of ws.ciRuns.slice(-20)) out.push(`${r.id}  ${r.ref}@${r.sha.slice(0, 8)} ${r.status} (${r.stages.map((s) => s.status === 'success' ? '.' : 'X').join('')})`);
      break;
    }
    case 'audit': {
      const n = Math.min(parseInt(args[0] || '20', 10) || 20, 200);
      for (const e of ws.audit.tail(n)) {
        out.push(`#${e.seq} ${new Date(e.timestamp).toISOString().slice(11, 19)} ${e.actor.id.padEnd(10)} ${e.action.padEnd(22)} ${e.target ? `${e.target.type}:${String(e.target.id).slice(0, 20)}` : ''}`);
      }
      break;
    }
    case 'messages': {
      const n = Math.min(parseInt(args[0] || '10', 10) || 10, 100);
      for (const m of ws.messages.slice(-n)) {
        out.push(`${m.id} ${m.agent || '-'} task=${m.task || '-'} status=${m.status} artifacts=${m.artifacts.length}`);
      }
      break;
    }
    case 'demo': {
      const sub = args[0] || 'next';
      if (sub === 'seed') { ws.seedDemo(actor); out.push(`seeded scenario with ${ws.demo.steps.length} steps`); }
      else if (sub === 'next') out.push(JSON.stringify(await ws.demoNext(actor)));
      else if (sub === 'run') out.push(JSON.stringify(await ws.demoRunAll(actor)));
      else out.push('usage: demo seed|next|run');
      break;
    }
    case 'whoami': {
      out.push(`${actor.type}:${actor.id} role=${actor.role}`);
      break;
    }
    case 'export': {
      out.push(`workspace serialized: ${Buffer.byteLength(ws.exportJson(), 'utf8')} bytes (use GET /api/export to download)`);
      break;
    }
    case 'reset': {
      ws.resetWorkspace(actor, { seed: args[0] === 'seed' });
      out.push(`workspace reset${args[0] === 'seed' ? ' and demo seeded' : ''}`);
      break;
    }
    default:
      throw new ForgeError('FORGE_INVALID_INPUT', `unknown command: ${cmd} (try "help")`);
  }
  return { lines: out };
}

module.exports = { execute, tokenize };
