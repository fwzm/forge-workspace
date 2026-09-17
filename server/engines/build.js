'use strict';

const vm = require('vm');
const crypto = require('crypto');

// Build stage: syntax-checks every .js file in the tree, validates JSON files,
// and emits a deterministic bundle artifact (concatenated sources + SHA-256).
function build(files) {
  const started = Date.now();
  const errors = [];
  const checked = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    if (path.endsWith('.js')) {
      try {
        // eslint-disable-next-line no-new
        new vm.Script(content, { filename: `repo://${path}` });
        checked.push(path);
      } catch (e) {
        errors.push({ file: path, message: `Syntax error: ${e.message}` });
      }
    } else if (path.endsWith('.json')) {
      try {
        JSON.parse(content);
        checked.push(path);
      } catch (e) {
        errors.push({ file: path, message: `Invalid JSON: ${e.message}` });
      }
    }
  }
  const bundleParts = [];
  for (const path of checked.filter((p) => p.endsWith('.js')).sort()) {
    bundleParts.push(`/* ==== ${path} ==== */\n${files[path]}`);
  }
  const bundle = bundleParts.join('\n\n');
  return {
    ok: errors.length === 0,
    errors,
    artifact: {
      name: 'bundle.js',
      hash: crypto.createHash('sha256').update(bundle, 'utf8').digest('hex'),
      size: bundle.length,
      files: checked,
      durationMs: Date.now() - started,
    },
  };
}

module.exports = { build };
