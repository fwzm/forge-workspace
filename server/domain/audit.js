'use strict';

const { id } = require('../core/ids');
const { assertString } = require('../core/validation');

const MAX_ENTRIES = 5000;

// Append-only audit trail of every significant state change.
class AuditLog {
  constructor() {
    this.entries = [];
    this.seq = 0;
  }

  append(actor, action, target, details) {
    this.seq += 1;
    const entry = {
      seq: this.seq,
      id: id('audit'),
      timestamp: Date.now(),
      actor: actor ? { type: actor.type || 'user', id: actor.id || 'unknown', role: actor.role || 'unknown' } : { type: 'system', id: 'system', role: 'system' },
      action,
      target: target ? { type: target.type, id: target.id } : null,
      details: details === undefined ? null : details,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    return entry;
  }

  filter(opts) {
    const o = opts || {};
    return this.entries.filter((e) => {
      if (o.action && !e.action.startsWith(o.action)) return false;
      if (o.actorId && e.actor.id !== o.actorId) return false;
      if (o.targetType && (!e.target || e.target.type !== o.targetType)) return false;
      if (o.targetId && (!e.target || e.target.id !== o.targetId)) return false;
      if (o.since && e.timestamp < o.since) return false;
      return true;
    });
  }

  tail(n) {
    return this.entries.slice(-(n || 50));
  }

  serialize() {
    return { seq: this.seq, entries: this.entries };
  }

  static deserialize(data) {
    const log = new AuditLog();
    if (data && Array.isArray(data.entries)) {
      log.entries = data.entries;
      log.seq = data.seq || data.entries.length;
    }
    return log;
  }
}

module.exports = { AuditLog };
