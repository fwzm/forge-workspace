'use strict';

let seq = 0;

function id(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;
}

function resetSeq(n) {
  seq = n || 0;
}

module.exports = { id, resetSeq };
