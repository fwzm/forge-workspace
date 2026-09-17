'use strict';

const { assertPrTransition } = require('../core/statemachine');
const { notFound, invalidInput, ForgeError, CODES } = require('../core/errors');
const { assertString, assertEnum } = require('../core/validation');

const PR_REVIEW_TYPES = ['comment', 'request_changes', 'approve'];

// ---------------------------------------------------------------------------
// Pull-request model: open -> (comment | request_changes | approve)* -> merged | closed.
// Approvals are head-scoped: an approval only counts while the PR head commit
// is the one that was reviewed.
// ---------------------------------------------------------------------------
class PullRequests {
  constructor() {
    this.prs = new Map();
  }

  get(id) {
    const pr = this.prs.get(id);
    if (!pr) throw notFound('Pull request', id);
    return pr;
  }

  list() {
    return [...this.prs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  open({ id, title, sourceBranch, targetBranch, description, author, headSha }) {
    assertString(title, 'title', { min: 1, max: 200 });
    assertString(sourceBranch, 'sourceBranch', { min: 1 });
    assertString(targetBranch, 'targetBranch', { min: 1 });
    if (sourceBranch === targetBranch) {
      throw invalidInput('source and target branch must differ', { sourceBranch, targetBranch });
    }
    const duplicate = this.list().find((p) =>
      ['open', 'changes_requested', 'approved'].includes(p.state) &&
      p.sourceBranch === sourceBranch && p.targetBranch === targetBranch);
    if (duplicate) {
      throw new ForgeError(CODES.STATE, `An open PR already exists for ${sourceBranch} -> ${targetBranch}: ${duplicate.id}`);
    }
    const pr = {
      id,
      title,
      description: description || '',
      sourceBranch,
      targetBranch,
      state: 'open',
      headSha,
      author: author || 'unknown',
      reviews: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mergedAt: null,
      mergeCommit: null,
      closedAt: null,
    };
    this.prs.set(id, pr);
    return pr;
  }

  addReview(pr, { reviewer, reviewerRole, type, comment, findings }) {
    assertEnum(type, 'review type', PR_REVIEW_TYPES);
    if (type !== 'comment') {
      assertPrTransition(pr, type === 'approve' ? 'approved' : 'changes_requested');
    }
    const review = {
      id: `rev-${pr.reviews.length + 1}-${pr.id.slice(-6)}`,
      reviewer: reviewer || 'unknown',
      reviewerRole: reviewerRole || 'unknown',
      type,
      comment: comment || null,
      findings: Array.isArray(findings) ? findings : [],
      headSha: pr.headSha,
      timestamp: Date.now(),
    };
    pr.reviews.push(review);
    if (type === 'approve') {
      assertPrTransition(pr, 'approved');
      pr.state = 'approved';
    } else if (type === 'request_changes') {
      assertPrTransition(pr, 'changes_requested');
      pr.state = 'changes_requested';
    }
    pr.updatedAt = Date.now();
    return review;
  }

  // Distinct reviewers whose approval matches the current head commit.
  validApprovals(pr) {
    const approvers = new Set();
    for (const r of pr.reviews) {
      if (r.type === 'approve' && r.headSha === pr.headSha) approvers.add(r.reviewer);
    }
    return [...approvers];
  }

  markMerged(pr, mergeCommit) {
    assertPrTransition(pr, 'merged');
    pr.state = 'merged';
    pr.mergedAt = Date.now();
    pr.updatedAt = pr.mergedAt;
    pr.mergeCommit = mergeCommit;
    return pr;
  }

  close(pr) {
    assertPrTransition(pr, 'closed');
    pr.state = 'closed';
    pr.closedAt = Date.now();
    pr.updatedAt = pr.closedAt;
    return pr;
  }

  syncHead(pr, newSha) {
    if (pr.headSha !== newSha) {
      pr.headSha = newSha;
      pr.updatedAt = Date.now();
    }
  }

  serialize() {
    return this.list();
  }

  static deserialize(arr) {
    const store = new PullRequests();
    for (const pr of arr || []) store.prs.set(pr.id, { ...pr, reviews: [...(pr.reviews || [])] });
    return store;
  }
}

module.exports = { PullRequests, PR_REVIEW_TYPES };
