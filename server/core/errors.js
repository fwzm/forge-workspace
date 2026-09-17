'use strict';

class ForgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
    this.details = details === undefined ? null : details;
  }
}

const CODES = {
  INVALID_TRANSITION: 'FORGE_INVALID_TRANSITION',
  INVALID_INPUT: 'FORGE_INVALID_INPUT',
  CYCLE: 'FORGE_CYCLE',
  NOT_FOUND: 'FORGE_NOT_FOUND',
  DIRTY_WORKTREE: 'FORGE_DIRTY_WORKTREE',
  CONFLICT: 'FORGE_CONFLICT',
  PERMISSION_DENIED: 'FORGE_PERMISSION_DENIED',
  MERGE_GATE: 'FORGE_MERGE_GATE',
  STATE: 'FORGE_STATE',
  IO: 'FORGE_IO',
};

function invalidTransition(from, to, reason) {
  return new ForgeError(CODES.INVALID_TRANSITION,
    `Illegal state transition: ${from} -> ${to}${reason ? ` (${reason})` : ''}`,
    { from, to, reason: reason || null });
}

function invalidInput(message, details) {
  return new ForgeError(CODES.INVALID_INPUT, message, details);
}

function notFound(what, id) {
  return new ForgeError(CODES.NOT_FOUND, `${what} not found: ${id}`, { target: id });
}

function permissionDenied(action, actor) {
  return new ForgeError(CODES.PERMISSION_DENIED,
    `Permission denied: role "${actor && actor.role}" cannot perform "${action}"`,
    { action, role: actor ? actor.role : null });
}

function isForgeError(e) {
  return e instanceof ForgeError;
}

module.exports = { ForgeError, CODES, invalidTransition, invalidInput, notFound, permissionDenied, isForgeError };
