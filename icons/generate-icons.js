// generate-icons.js
// Generates icon PNGs from scratch using only Node.js built-ins.
// Run: node icons/generate-icons.js
//
// Icon design: outer outline ring + filled center dot, #1D1D1F on transparent.
// Dimensions follow the spec: ring radius = 7.5/20 of icon, dot radius = 3/20.
// Stroke width scales inversely with size for optical consistency.

'use strict';

const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');

// ── Minimal PNG encoder ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len      = Buffer.allocUnsafe(4);
  const crcBytes = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  crcBytes.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crcBytes]);
}

function encodePNG(width, height, rgba) {
  const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Prepend a filter byte (None = 0x00) to each scanline.
  const raw = Buffer.allocUnsafe(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon rasteriser ───────────────────────────────────────────────────────────

// Color: #1D1D1F
const R = 0x1D, G = 0x1D, B = 0x1F;

function renderIcon(size, ringRadius, dotRadius, strokeWidth) {
  const rgba = Buffer.alloc(size * size * 4); // all zeros = transparent
  const cx   = size / 2;
  const cy   = size / 2;

  // Use oversampling (4×) for smoother antialiasing on small sizes.
  const ss   = 4;
  const ssSq = ss * ss;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accum = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Ring: pixel is "on" if within strokeWidth/2 of the ring radius.
          const distToRing = Math.abs(dist - ringRadius);
          const onRing = distToRing <= strokeWidth / 2;

          // Dot: pixel is "on" if within the dot radius.
          const onDot = dist <= dotRadius;

          if (onRing || onDot) accum++;
        }
      }

      const alpha = Math.round((accum / ssSq) * 255);
      if (alpha > 0) {
        const i    = (y * size + x) * 4;
        rgba[i]    = R;
        rgba[i + 1]= G;
        rgba[i + 2]= B;
        rgba[i + 3]= alpha;
      }
    }
  }

  return rgba;
}

// ── Icon specs ────────────────────────────────────────────────────────────────

const SPECS = [
  { size:  16, stroke: 1.8 },
  { size:  32, stroke: 1.5 },
  { size:  48, stroke: 1.3 },
  { size: 128, stroke: 1.2 },
];

const outDir = path.join(__dirname);

for (const { size, stroke } of SPECS) {
  const ringR  = size * 7.5 / 20;
  const dotR   = size * 3   / 20;

  const rgba   = renderIcon(size, ringR, dotR, stroke);
  const png    = encodePNG(size, size, rgba);
  const dest   = path.join(outDir, `icon${size}.png`);

  fs.writeFileSync(dest, png);
  console.log(`✓  icon${size}.png  (${png.length} bytes)  ring r=${ringR.toFixed(1)} dot r=${dotR.toFixed(1)} stroke=${stroke}`);
}

console.log('\nAll icons written to icons/');
