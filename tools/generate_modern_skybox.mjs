import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'skybox');
const size = Number.parseInt(process.env.BLOCKKART_SKYBOX_SIZE ?? '1024', 10);
mkdirSync(outDir, { recursive: true });

const faces = ['right', 'left', 'front', 'back', 'top', 'bottom'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(0.000001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hash2(x, y, salt = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function colorMix(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t), 255];
}

function skyColor(face, u, v) {
  if (face === 'top') {
    const radial = Math.hypot(u - 0.5, v - 0.5);
    return colorMix([42, 151, 235, 255], [72, 196, 244, 255], clamp(radial * 0.75, 0, 1));
  }
  if (face === 'bottom') {
    return colorMix([207, 240, 218, 255], [174, 228, 218, 255], v);
  }
  const top = [37, 145, 232, 255];
  const upper = [55, 190, 242, 255];
  const horizon = [177, 241, 232, 255];
  const groundBounce = [231, 247, 218, 255];
  let c = colorMix(top, upper, smoothstep(0.05, 0.52, v));
  c = colorMix(c, horizon, smoothstep(0.38, 0.78, v));
  c = colorMix(c, groundBounce, smoothstep(0.70, 1.0, v) * 0.72);
  const sunX = face === 'right' ? 0.10 : face === 'front' ? 0.92 : -1.0;
  if (sunX >= 0) {
    const glow = Math.exp(-((u - sunX) * (u - sunX) / 0.055 + (v - 0.23) * (v - 0.23) / 0.075));
    c = colorMix(c, [255, 232, 156, 255], glow * 0.23);
  }
  return c;
}

const cloudSets = {
  top: [
    { x: 0.16, y: 0.18, s: 0.12 },
    { x: 0.38, y: 0.36, s: 0.10 },
    { x: 0.60, y: 0.20, s: 0.12 },
    { x: 0.82, y: 0.34, s: 0.10 },
  ],
  front: [
    { x: 0.14, y: 0.18, s: 0.12 },
    { x: 0.34, y: 0.30, s: 0.08 },
    { x: 0.54, y: 0.20, s: 0.10 },
    { x: 0.76, y: 0.32, s: 0.08 },
    { x: 0.88, y: 0.15, s: 0.11 },
  ],
  back: [
    { x: 0.18, y: 0.20, s: 0.11 },
    { x: 0.42, y: 0.30, s: 0.08 },
    { x: 0.64, y: 0.17, s: 0.12 },
    { x: 0.86, y: 0.28, s: 0.08 },
  ],
  left: [
    { x: 0.18, y: 0.28, s: 0.08 },
    { x: 0.34, y: 0.18, s: 0.11 },
    { x: 0.58, y: 0.31, s: 0.08 },
    { x: 0.78, y: 0.16, s: 0.10 },
  ],
  right: [
    { x: 0.15, y: 0.16, s: 0.09 },
    { x: 0.34, y: 0.30, s: 0.08 },
    { x: 0.57, y: 0.20, s: 0.12 },
    { x: 0.82, y: 0.28, s: 0.08 },
  ],
};

function cloudAlpha(u, v, cloud, salt) {
  let alpha = 0;
  for (let i = 0; i < 5; i++) {
    const ox = (hash2(i, salt, 1) - 0.5) * cloud.s * 1.45;
    const oy = (hash2(i, salt, 2) - 0.5) * cloud.s * 0.56;
    const sx = cloud.s * mix(0.55, 1.25, hash2(i, salt, 3));
    const sy = cloud.s * mix(0.26, 0.58, hash2(i, salt, 4));
    const dx = (u - cloud.x - ox) / sx;
    const dy = (v - cloud.y - oy) / sy;
    alpha += Math.exp(-(dx * dx + dy * dy) * 1.85);
  }
  return clamp(smoothstep(0.36, 1.18, alpha), 0, 1);
}

function sample(face, x, y) {
  const u = x / Math.max(1, size - 1);
  const v = y / Math.max(1, size - 1);
  let c = skyColor(face, u, v);
  const clouds = cloudSets[face] ?? [];
  for (let i = 0; i < clouds.length; i++) {
    const a = cloudAlpha(u, v, clouds[i], i + face.length * 11);
    if (a <= 0) continue;
    const shade = 1 - smoothstep(clouds[i].y - clouds[i].s * 0.2, clouds[i].y + clouds[i].s * 0.7, v) * 0.22;
    const cloud = [255 * shade, 255 * shade, 248 * shade, 255];
    c = colorMix(c, cloud, a * 0.86);
  }
  return c;
}

function makeFace(face) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = sample(face, x, y);
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(clamp(c[0], 0, 255));
      pixels[i + 1] = Math.round(clamp(c[1], 0, 255));
      pixels[i + 2] = Math.round(clamp(c[2], 0, 255));
      pixels[i + 3] = 255;
    }
  }
  return encodePngRgba(size, size, pixels);
}

function encodePngRgba(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return encodePng(width, height, raw);
}

function encodePng(width, height, raw) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk('IDAT', deflateSync(raw, { level: 5 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const body = Buffer.concat([typeBytes, data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

for (const face of faces) {
  writeFileSync(join(outDir, `${face}.png`), makeFace(face));
}

console.log(`modern skybox generated (${size}x${size})`);
