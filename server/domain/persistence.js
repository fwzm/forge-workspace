'use strict';

const fs = require('fs');
const path = require('path');
const { ForgeError, CODES, invalidInput } = require('../core/errors');

// Full-state persistence: atomic JSON writes (tmp + rename) into the data dir.
class Persistence {
  constructor(dataDir, fileName) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, fileName || 'workspace.json');
    this.tmp = this.file + '.tmp';
    fs.mkdirSync(dataDir, { recursive: true });
  }

  exists() {
    return fs.existsSync(this.file);
  }

  save(state) {
    let json;
    try {
      json = JSON.stringify(state, null, 1);
    } catch (e) {
      throw new ForgeError(CODES.IO, `Failed to serialize workspace state: ${e.message}`);
    }
    try {
      fs.writeFileSync(this.tmp, json, 'utf8');
      fs.renameSync(this.tmp, this.file);
    } catch (e) {
      throw new ForgeError(CODES.IO, `Failed to write workspace state: ${e.message}`);
    }
    return { file: this.file, bytes: Buffer.byteLength(json) };
  }

  load() {
    if (!this.exists()) return null;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      throw new ForgeError(CODES.IO, `Failed to read workspace state: ${e.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new ForgeError(CODES.IO, `Workspace state file is corrupt (not valid JSON): ${e.message}`, { file: this.file });
    }
  }

  clear() {
    try {
      if (this.exists()) fs.unlinkSync(this.file);
      return true;
    } catch (e) {
      throw new ForgeError(CODES.IO, `Failed to remove workspace state: ${e.message}`);
    }
  }
}

function validateImportedState(data) {
  if (!data || typeof data !== 'object') throw invalidInput('imported workspace must be a JSON object');
  if (data.format !== 'forge.workspace') throw invalidInput('imported data is not a forge workspace (missing format:"forge.workspace")');
  if (typeof data.version !== 'number') throw invalidInput('imported workspace is missing a numeric version');
  if (data.version > 1) throw invalidInput(`imported workspace version ${data.version} is newer than supported version 1`);
  return data;
}

module.exports = { Persistence, validateImportedState };
