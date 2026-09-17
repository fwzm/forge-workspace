'use strict';

// JSON response primitives, isolated so every response path shares one
// explicitly-encoded output channel (OWASP JSON hardening: markup-significant
// characters are neutralized so the body cannot terminate an element even if a
// client misinterprets the content type).
function encodeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function sendJson(res, status, payload) {
  const body = encodeJson(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.write(body, 'utf8');
  res.end();
}

function sendAttachment(res, filename, value) {
  const body = encodeJson(value);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.write(body, 'utf8');
  res.end();
}

module.exports = { encodeJson, sendJson, sendAttachment };
