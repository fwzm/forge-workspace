'use strict';

const fs = require('fs');
const path = require('path');

// Static asset serving for the workspace UI. Isolated from the JSON API module
// so each response path has a single, explicit content type.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, target));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write('forbidden', 'utf8');
    res.end();
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.write('not found', 'utf8');
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.write(data);
    res.end();
  });
}

module.exports = { serveStatic };
