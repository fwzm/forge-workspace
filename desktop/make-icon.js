'use strict';

// Generates desktop\forge.ico deterministically: a dark rounded square with
// a stylized light-blue "F" hammer-mark, as 32px + 16px PNG-embedded ICO
// entries (Vista+ format). Run: node desktop/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table;
  if (!table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c;
    }
    return crc32(buf);
  }
  c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ (-1)) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgba, w, h) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Draw one icon size into an RGBA buffer.
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [13, 17, 23, 255];      // #0d1117
  const fg = [122, 167, 216, 255];   // #7aa7d8
  const accent = [79, 140, 201, 255];
  const radius = Math.max(2, Math.round(size * 0.18));
  const set = (x, y, c) => {
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  };
  const u = size / 32; // design grid unit (design done at 32)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-square mask
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const inside = dx >= radius || dy >= radius
        ? (dx >= 0 && dy >= 0)
        : ((radius - dx) * (radius - dx) + (radius - dy) * (radius - dy) <= radius * radius + radius);
      if (!inside) { set(x, y, [0, 0, 0, 0]); continue; }
      set(x, y, bg);
    }
  }

  // "F" bars on the design grid (32 units), scaled.
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0 * u); y < Math.round(y1 * u) && y < size; y++) {
      for (let x = Math.round(x0 * u); x < Math.round(x1 * u) && x < size; x++) {
        if (y >= 0 && x >= 0) set(x, y, c);
      }
    }
  };
  rect(9, 6, 13, 26, fg);   // stem
  rect(9, 6, 24, 10, fg);   // top bar
  rect(9, 15, 20, 19, accent); // mid bar (accent)
  rect(9, 6, 10, 26, fg);   // stem edge shading
  return buf;
}

function buildIco(sizes) {
  const pngs = sizes.map((s) => encodePng(drawIcon(s), s, s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + entries.length;
  pngs.forEach((png, i) => {
    const size = sizes[i];
    entries[i * 16 + 0] = size >= 256 ? 0 : size;      // width
    entries[i * 16 + 1] = size >= 256 ? 0 : size;      // height
    entries[i * 16 + 2] = 0;                            // palette
    entries[i * 16 + 3] = 0;                            // reserved
    entries.writeUInt16LE(1, i * 16 + 4);               // color planes
    entries.writeUInt16LE(32, i * 16 + 6);              // bpp
    entries.writeUInt32LE(png.length, i * 16 + 8);      // data size
    entries.writeUInt32LE(offset, i * 16 + 12);         // data offset
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}

if (require.main === module) {
  const out = path.join(__dirname, 'forge.ico');
  const ico = buildIco([32, 16]);
  fs.writeFileSync(out, ico);
  console.log(`wrote ${out} (${ico.length} bytes)`);
}

module.exports = { buildIco, drawIcon, encodePng };
