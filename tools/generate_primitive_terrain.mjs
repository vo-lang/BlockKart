import { Buffer } from 'node:buffer';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  clamp,
  heightmapSize,
  mix,
  noise2,
  shoulderWidth,
  splatSize,
  smoothstep,
  targetTerrainWorldY,
  terrainContext,
  terrainDepth,
  terrainHeight,
  terrainSplatWeights,
  terrainWidth,
  terrainY,
  trackPoints,
} from './terrain_heightfield_spec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'maps', 'primitive_track');
const paintedSourceDir = join(root, 'assets', 'source', 'terrain_painted');
const effectsDir = join(root, 'assets', 'effects');
const grassCardAtlasPath = join(effectsDir, 'grass_card_atlas.png');
mkdirSync(outDir, { recursive: true });

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 2) {
    throw new Error(`${name} must be an integer >= 2`);
  }
  return value;
}

const outputHeightmapSize = envInt('TERRAIN_HEIGHTMAP_SIZE', heightmapSize);
const outputSplatSize = envInt('TERRAIN_SPLAT_SIZE', splatSize);
const terrainMaterialTextureSize = envInt('TERRAIN_MATERIAL_TEXTURE_SIZE', 512);
const lowpolyTerrainSegments = envInt('TERRAIN_LOWPOLY_SEGMENTS', 144);
const lowpolyTerrainLodSegments = envInt('TERRAIN_LOWPOLY_LOD_SEGMENTS', Math.max(24, Math.floor(lowpolyTerrainSegments / 2)));
const heightGridSize = envInt('TERRAIN_HEIGHT_GRID_SIZE', 257);
const roadsideGrassDensityScale = 0.42;
const roadsideDetailDensityScale = 0.60;
const roadsideGrassLodScale = 0.82;
const roadsideGrassLodFarCap = 62;
const roadsideDetailLodScale = 0.90;
const roadsideDetailLodFarCap = 58;
const roadsidePrimitiveChunkCellSize = 36;

function roadsideGrassLodFar(distance) {
  return Math.min(distance * roadsideGrassLodScale, roadsideGrassLodFarCap);
}

function roadsideDetailLodFar(distance) {
  return Math.min(distance * roadsideDetailLodScale, roadsideDetailLodFarCap);
}

function makeHeightmap() {
  const pixels = Buffer.alloc(outputHeightmapSize * outputHeightmapSize * 2);
  for (let row = 0; row < outputHeightmapSize; row++) {
    const z = (row / (outputHeightmapSize - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < outputHeightmapSize; col++) {
      const x = (col / (outputHeightmapSize - 1) - 0.5) * terrainWidth;
      const y = visualTerrainWorldY(x, z);
      pixels.writeUInt16BE(Math.round(clamp((y - terrainY) / terrainHeight, 0, 1) * 65535), (row * outputHeightmapSize + col) * 2);
    }
  }
  return encodePngGray16(outputHeightmapSize, outputHeightmapSize, pixels);
}

function makeTerrainSplat() {
  const pixels = Buffer.alloc(outputSplatSize * outputSplatSize * 4);
  for (let row = 0; row < outputSplatSize; row++) {
    const z = (row / (outputSplatSize - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < outputSplatSize; col++) {
      const x = (col / (outputSplatSize - 1) - 0.5) * terrainWidth;
      const weights = terrainSplatWeights(x, z, col, row);
      const i = (row * outputSplatSize + col) * 4;
      pixels[i] = Math.round(weights.grass * 255);
      pixels[i + 1] = Math.round(weights.meadow * 255);
      pixels[i + 2] = Math.round(weights.dirt * 255);
      pixels[i + 3] = Math.round(weights.rock * 255);
    }
  }
  return encodePngRgba(outputSplatSize, outputSplatSize, pixels);
}

function makeTexture(size, sample) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      putPixel(pixels, (y * size + x) * 4, sample(x, y, size));
    }
  }
  return encodePngRgba(size, size, pixels);
}

function makePaintedTexture(size, sample, paint) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      putPixel(pixels, (y * size + x) * 4, sample(x, y, size));
    }
  }
  paint(pixels, size);
  return encodePngRgba(size, size, pixels);
}

function putPixel(pixels, index, color) {
  pixels[index] = Math.round(clamp(color[0], 0, 255));
  pixels[index + 1] = Math.round(clamp(color[1], 0, 255));
  pixels[index + 2] = Math.round(clamp(color[2], 0, 255));
  pixels[index + 3] = color.length > 3 ? Math.round(clamp(color[3], 0, 255)) : 255;
}

function colorMix(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t), mix(a[3] ?? 255, b[3] ?? 255, t)];
}

function fract(v) {
  return v - Math.floor(v);
}

function smooth01(t) {
  const v = clamp(t, 0, 1);
  return v * v * (3 - 2 * v);
}

function valueNoiseUnit(u, v, scale, salt = 0) {
  const gx = u * scale;
  const gy = v * scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const tx = smooth01(gx - ix);
  const ty = smooth01(gy - iy);
  const sx = salt * 101;
  const sy = salt * -73;
  const n00 = noise2(ix + sx, iy + sy);
  const n10 = noise2(ix + 1 + sx, iy + sy);
  const n01 = noise2(ix + sx, iy + 1 + sy);
  const n11 = noise2(ix + 1 + sx, iy + 1 + sy);
  return mix(mix(n00, n10, tx), mix(n01, n11, tx), ty);
}

function fbmUnit(u, v, scale, salt = 0, octaves = 5) {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  let frequency = scale;
  for (let i = 0; i < octaves; i++) {
    value += valueNoiseUnit(u + i * 0.037, v - i * 0.029, frequency, salt + i * 17) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return total > 0 ? value / total : 0;
}

function ridgedUnit(u, v, scale, salt = 0) {
  return 1 - Math.abs(fbmUnit(u, v, scale, salt, 4) * 2 - 1);
}

function lineSignal(u, v, count, angle, salt = 0, width = 0.06) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const warp = (fbmUnit(u, v, 5.5, salt, 4) - 0.5) * 0.16;
  const line = Math.abs(fract((u * dx + v * dy + warp) * count) - 0.5);
  return smooth01((width - line) / Math.max(0.0001, width));
}

function strandSignal(u, v, count, angle, salt = 0) {
  const coord = u * Math.cos(angle) + v * Math.sin(angle);
  const warp = (fbmUnit(u, v, 12, salt, 3) - 0.5) * 0.045;
  return 0.5 + 0.5 * Math.sin((coord + warp) * Math.PI * 2 * count);
}

function speckleSignal(u, v, scale, threshold, salt = 0) {
  return smooth01((valueNoiseUnit(u, v, scale, salt) - threshold) / Math.max(0.0001, 1 - threshold));
}

function clumpSignal(u, v, scale, salt = 0, radius = 0.34) {
  const gx = u * scale;
  const gy = v * scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let best = 10;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox + valueNoiseUnit(ix + ox, iy + oy, 1, salt);
      const cy = iy + oy + valueNoiseUnit(ix + ox, iy + oy, 1, salt + 19);
      best = Math.min(best, Math.hypot(gx - cx, gy - cy));
    }
  }
  return smooth01((radius - best) / Math.max(0.0001, radius));
}

function applyDelta(color, r, g, b) {
  color[0] += r;
  color[1] += g;
  color[2] += b;
  return color;
}

function gradeTerrainColor(color, exposure, saturation, lift = [0, 0, 0]) {
  const luma = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
  color[0] = (luma + (color[0] - luma) * saturation) * exposure + lift[0];
  color[1] = (luma + (color[1] - luma) * saturation) * exposure + lift[1];
  color[2] = (luma + (color[2] - luma) * saturation) * exposure + lift[2];
  return color;
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function wrapCoord(v, size) {
  const n = Math.floor(v) % size;
  return n < 0 ? n + size : n;
}

function blendPixel(pixels, size, x, y, color, alpha) {
  const xi = wrapCoord(x, size);
  const yi = wrapCoord(y, size);
  const i = (yi * size + xi) * 4;
  const a = clamp(alpha * ((color[3] ?? 255) / 255), 0, 1);
  pixels[i] = Math.round(mix(pixels[i], color[0], a));
  pixels[i + 1] = Math.round(mix(pixels[i + 1], color[1], a));
  pixels[i + 2] = Math.round(mix(pixels[i + 2], color[2], a));
  pixels[i + 3] = 255;
}

function drawBrushStroke(pixels, size, cx, cy, length, width, angle, color, alpha = 1) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const rx = Math.max(0.8, length * 0.5);
  const ry = Math.max(0.5, width * 0.5);
  const bound = Math.ceil(Math.max(rx, ry) + 2);
  for (let oy = -bound; oy <= bound; oy++) {
    for (let ox = -bound; ox <= bound; ox++) {
      const lx = ox * ca + oy * sa;
      const ly = -ox * sa + oy * ca;
      const nx = Math.abs(lx) / rx;
      const ny = Math.abs(ly) / ry;
      const d = nx * nx + ny * ny;
      if (d > 1) {
        continue;
      }
      const taper = smooth01(1 - Math.pow(nx, 1.45));
      const softEdge = smooth01(1 - d);
      const bristle = 0.72 + 0.28 * noise2(Math.floor(cx + ox * 3), Math.floor(cy + oy * 5));
      blendPixel(pixels, size, cx + ox, cy + oy, color, alpha * taper * softEdge * bristle);
    }
  }
}

function drawPaintDot(pixels, size, cx, cy, radiusX, radiusY, angle, color, alpha = 1) {
  drawBrushStroke(pixels, size, cx, cy, radiusX * 2, radiusY * 2, angle, color, alpha);
}

function paintGrassStrokes(pixels, size, seed, density, palette) {
  const rand = seededRandom(seed);
  const count = Math.round(size * size * density);
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const field = fbmUnit(u, v, 5.5, seed % 97, 4);
    const angle = -0.75 + field * 0.55 + (rand() - 0.5) * 0.62;
    const len = mix(10, 34, Math.pow(rand(), 0.58));
    const width = mix(1.1, 3.6, rand());
    const color = palette[Math.floor(rand() * palette.length)];
    drawBrushStroke(pixels, size, x, y, len, width, angle, color, mix(0.16, 0.42, rand()));
  }
}

function paintGrassClumps(pixels, size, seed, density) {
  const rand = seededRandom(seed);
  const count = Math.round(size * size * density);
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const clumpSize = mix(18, 58, rand());
    const color = rand() > 0.38 ? [58, 128, 52, 255] : [160, 178, 88, 255];
    for (let j = 0; j < 5; j++) {
      drawBrushStroke(
        pixels,
        size,
        x + (rand() - 0.5) * clumpSize * 0.65,
        y + (rand() - 0.5) * clumpSize * 0.65,
        clumpSize * mix(0.42, 0.95, rand()),
        mix(3.0, 8.0, rand()),
        rand() * Math.PI * 2,
        color,
        mix(0.09, 0.22, rand()),
      );
    }
  }
}

function paintFlowerFlecks(pixels, size, seed, density) {
  const rand = seededRandom(seed);
  const count = Math.round(size * size * density);
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const color = rand() > 0.34 ? [236, 204, 66, 255] : [238, 236, 218, 255];
    drawPaintDot(pixels, size, x, y, mix(1.0, 2.8, rand()), mix(0.8, 2.1, rand()), rand() * Math.PI, color, mix(0.35, 0.78, rand()));
  }
}

function paintDirtMarks(pixels, size, seed) {
  const rand = seededRandom(seed);
  const scratchCount = Math.round(size * size * 0.0028);
  for (let i = 0; i < scratchCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const light = rand() > 0.48;
    const color = light ? [228, 174, 100, 255] : [88, 58, 40, 255];
    drawBrushStroke(pixels, size, x, y, mix(8, 46, rand()), mix(1.0, 3.2, rand()), mix(-0.5, 0.45, rand()), color, mix(0.14, 0.34, rand()));
  }
  const pebbleCount = Math.round(size * size * 0.0036);
  for (let i = 0; i < pebbleCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const color = rand() > 0.5 ? [176, 148, 106, 255] : [102, 74, 52, 255];
    drawPaintDot(pixels, size, x, y, mix(1.0, 4.8, rand()), mix(0.8, 3.2, rand()), rand() * Math.PI, color, mix(0.18, 0.52, rand()));
  }
}

function paintRockFacets(pixels, size, seed) {
  const rand = seededRandom(seed);
  const facetCount = Math.round(size * size * 0.0016);
  for (let i = 0; i < facetCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const color = rand() > 0.46 ? [198, 184, 144, 255] : [86, 86, 80, 255];
    drawBrushStroke(pixels, size, x, y, mix(18, 72, rand()), mix(2.0, 8.0, rand()), mix(-0.35, 0.85, rand()), color, mix(0.10, 0.25, rand()));
  }
}

function makeGrassTexture() {
  return makePaintedTexture(terrainMaterialTextureSize, (x, y, size) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const broad = fbmUnit(u, v, 3.6, 1, 5);
    const clump = fbmUnit(u + 0.11, v - 0.08, 8.5, 4, 5);
    const meadowClump = fbmUnit(u - 0.17, v + 0.19, 17, 26, 4);
    const coolPocket = ridgedUnit(u + 0.27, v - 0.15, 7.5, 18);
    const tuft = clumpSignal(u + 0.02, v - 0.04, 18, 61, 0.36);
    const broadTuft = clumpSignal(u - 0.21, v + 0.16, 8.2, 62, 0.46);
    const blades =
      strandSignal(u, v, 58, -0.35, 2) * 0.20 +
      strandSignal(u + 0.09, v - 0.03, 92, 0.08, 3) * 0.14 +
      strandSignal(u - 0.04, v + 0.07, 144, -0.58, 6) * 0.08 +
      fbmUnit(u - 0.13, v + 0.09, 86, 28, 3) * 0.58;
    const micro = fbmUnit(u, v, 54, 11, 3);
    let color = colorMix([72, 138, 56, 255], [134, 184, 76, 255], 0.22 + broad * 0.20 + clump * 0.09);
    color = colorMix(color, [48, 104, 52, 255], coolPocket * 0.060);
    color = colorMix(color, [154, 180, 84, 255], smooth01((meadowClump - 0.60) / 0.40) * 0.065);
    color = colorMix(color, [86, 154, 62, 255], tuft * 0.13 + broadTuft * 0.07);
    color = colorMix(color, [170, 190, 92, 255], smooth01((tuft - 0.74) / 0.26) * 0.085);
    applyDelta(color, (blades - 0.5) * 12.0, (blades - 0.5) * 13.5, (micro - 0.5) * 5.0);
    if (speckleSignal(u, v, 128, 0.976, 5) > 0.45) color = colorMix(color, [178, 166, 88, 255], 0.038);
    return gradeTerrainColor(color, 0.99, 0.84, [1, 2, -5]);
  }, (pixels, size) => {
    paintGrassClumps(pixels, size, 91031, 0.00018);
    paintGrassStrokes(pixels, size, 91032, 0.0056, [
      [42, 106, 44, 255],
      [66, 142, 54, 255],
      [98, 168, 64, 255],
      [154, 176, 82, 255],
      [178, 188, 102, 255],
    ]);
  });
}

function makeMeadowTexture() {
  return makePaintedTexture(terrainMaterialTextureSize, (x, y, size) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const clump = fbmUnit(u, v, 7.5, 6, 5);
    const herb = strandSignal(u, v, 54, -0.18, 7) * 0.30 + fbmUnit(u, v, 34, 8, 3) * 0.70;
    const moss = ridgedUnit(u - 0.16, v + 0.2, 8.5, 45);
    const field = fbmUnit(u + 0.21, v - 0.18, 16, 48, 4);
    const flowerCluster = clumpSignal(u + 0.13, v - 0.18, 20, 71, 0.22);
    const whitePetals = speckleSignal(u + 0.31, v - 0.21, 140, 0.984, 10) * flowerCluster;
    const yellowPetals = speckleSignal(u - 0.11, v + 0.29, 120, 0.978, 75) * flowerCluster;
    let color = colorMix([82, 144, 64, 255], [150, 188, 82, 255], 0.22 + clump * 0.24 + moss * 0.04);
    color = colorMix(color, [184, 176, 96, 255], smooth01((field - 0.60) / 0.40) * 0.085);
    color = colorMix(color, [58, 114, 58, 255], ridgedUnit(u - 0.11, v + 0.08, 12, 49) * 0.040);
    applyDelta(color, (herb - 0.5) * 9.0, (herb - 0.5) * 10.0, (fbmUnit(u, v, 72, 46, 3) - 0.5) * 4.4);
    if (speckleSignal(u, v, 96, 0.966, 9) > 0.35) color = colorMix(color, [188, 170, 92, 255], 0.050);
    if (yellowPetals > 0.42) color = colorMix(color, [236, 210, 70, 255], 0.40);
    if (whitePetals > 0.48) color = colorMix(color, [238, 238, 220, 255], 0.44);
    return gradeTerrainColor(color, 0.99, 0.82, [1, 2, -5]);
  }, (pixels, size) => {
    paintGrassClumps(pixels, size, 92031, 0.00024);
    paintGrassStrokes(pixels, size, 92032, 0.0062, [
      [48, 116, 48, 255],
      [76, 148, 58, 255],
      [116, 168, 70, 255],
      [168, 178, 86, 255],
      [190, 178, 96, 255],
    ]);
    paintFlowerFlecks(pixels, size, 92033, 0.00072);
  });
}

function makeDirtTexture() {
  return makePaintedTexture(terrainMaterialTextureSize, (x, y, size) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const compact = fbmUnit(u, v, 7.5, 12, 5);
    const fine = fbmUnit(u, v, 42, 13, 3);
    const grit = fbmUnit(u - 0.19, v + 0.23, 96, 22, 3);
    const dryStreak = lineSignal(u, v, 28, 0.2, 14, 0.030);
    const darkerRidge = ridgedUnit(u + 0.13, v - 0.17, 12, 15);
    const compactedLayer = ridgedUnit(u - 0.08, v + 0.11, 22, 23);
    const pebble = clumpSignal(u - 0.19, v + 0.09, 48, 82, 0.16);
    let color = colorMix([146, 92, 50, 255], [218, 156, 82, 255], 0.24 + compact * 0.26 + fine * 0.06);
    color = colorMix(color, [94, 62, 42, 255], darkerRidge * 0.08);
    color = colorMix(color, [168, 116, 70, 255], compactedLayer * 0.07);
    applyDelta(color, (grit - 0.5) * 9, (grit - 0.5) * 6, (grit - 0.5) * 3);
    if (dryStreak > 0) color = colorMix(color, [232, 176, 98, 255], dryStreak * 0.09);
    if (speckleSignal(u, v, 150, 0.958, 16) > 0.22) color = colorMix(color, [78, 56, 42, 255], 0.070);
    if (pebble > 0.60 || speckleSignal(u + 0.27, v - 0.12, 190, 0.978, 17) > 0.34) color = colorMix(color, [182, 150, 104, 255], 0.08);
    return gradeTerrainColor(color, 1.02, 0.88, [2, -1, -5]);
  }, (pixels, size) => {
    paintDirtMarks(pixels, size, 93031);
  });
}

function makeRockTexture() {
  return makePaintedTexture(terrainMaterialTextureSize, (x, y, size) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const face = fbmUnit(u, v, 5.8, 20, 5);
    const strata = lineSignal(u, v, 22, 0.22, 21, 0.046);
    const hairline = lineSignal(u + 0.07, v - 0.03, 48, 0.17, 22, 0.015);
    const coolShadow = ridgedUnit(u, v, 10, 23);
    const mineral = fbmUnit(u + 0.21, v - 0.16, 36, 24, 3);
    const facet = clumpSignal(u + 0.08, v + 0.04, 15, 93, 0.42);
    let color = colorMix([104, 102, 92, 255], [172, 158, 132, 255], 0.24 + face * 0.36);
    color = colorMix(color, [194, 180, 140, 255], strata * 0.10 + facet * 0.06);
    color = colorMix(color, [82, 84, 80, 255], coolShadow * 0.10 + hairline * 0.08);
    applyDelta(color, (mineral - 0.5) * 7, (mineral - 0.5) * 6, (mineral - 0.5) * 5);
    return gradeTerrainColor(color, 0.94, 0.76, [-1, -1, -3]);
  }, (pixels, size) => {
    paintRockFacets(pixels, size, 94031);
  });
}

function materialHeight(kind, x, y, size) {
  const u = x / Math.max(1, size - 1);
  const v = y / Math.max(1, size - 1);
	if (kind === 'grass') {
		return fbmUnit(u, v, 32, 30, 4) * 0.072 + ridgedUnit(u + 0.05, v - 0.03, 76, 31) * 0.026 + clumpSignal(u - 0.02, v + 0.04, 34, 131, 0.24) * 0.018 + lineSignal(u + 0.07, v - 0.03, 108, -0.26, 231, 0.007) * 0.006;
	}
	if (kind === 'meadow') {
		return fbmUnit(u, v, 28, 32, 4) * 0.082 + ridgedUnit(u - 0.03, v + 0.06, 62, 33) * 0.030 + clumpSignal(u + 0.08, v - 0.02, 28, 133, 0.28) * 0.022 + lineSignal(u - 0.04, v + 0.08, 92, -0.20, 233, 0.008) * 0.006;
	}
	  if (kind === 'dirt') {
	    return fbmUnit(u, v, 22, 34, 5) * 0.085 + lineSignal(u, v, 20, 0.19, 35, 0.024) * 0.020 + ridgedUnit(u - 0.08, v + 0.11, 34, 39) * 0.012;
	  }
  if (kind === 'rock') {
    return fbmUnit(u, v, 18, 36, 5) * 0.16 + lineSignal(u, v, 22, 0.22, 37, 0.046) * 0.105 + lineSignal(u + 0.07, v - 0.03, 48, 0.17, 38, 0.015) * 0.035;
  }
  return fbmUnit(u, v, 20, 38, 4) * 0.12;
}

function makeNormalTexture(kind, strength) {
  const size = terrainMaterialTextureSize;
  return makeTexture(size, (x, y) => {
    const xl = (x - 1 + size) % size;
    const xr = (x + 1) % size;
    const yu = (y - 1 + size) % size;
    const yd = (y + 1) % size;
    const texelToUvScale = size * 0.24;
    const dx = (materialHeight(kind, xr, y, size) - materialHeight(kind, xl, y, size)) * strength * texelToUvScale;
    const dy = (materialHeight(kind, x, yd, size) - materialHeight(kind, x, yu, size)) * strength * texelToUvScale;
    const len = Math.hypot(dx, dy, 1) || 1;
    return [128 - (dx / len) * 127, 128 - (dy / len) * 127, 128 + (1 / len) * 127, 255];
  });
}

function makeMetallicRoughnessTexture(roughness, variation = 0.06) {
  return makeTexture(terrainMaterialTextureSize, (x, y, size) => {
    const u = x / Math.max(1, size - 1);
    const v = y / Math.max(1, size - 1);
    const n = fbmUnit(u, v, 28, 42, 4) - 0.5;
    const micro = fbmUnit(u, v, 96, 43, 3) - 0.5;
    return [0, clamp((roughness + n * variation + micro * variation * 0.35) * 255, 0, 255), 0, 255];
  });
}

function writeTerrainMaterialTextures() {
  const albedoSources = [
    ['grass_painted_v1.png', 'grass_texture.png'],
    ['meadow_painted_v1.png', 'meadow_texture.png'],
    ['dirt_painted_v1.png', 'dirt_texture.png'],
    ['rock_painted_v1.png', 'rock_texture.png'],
  ];
  for (const [sourceName, targetName] of albedoSources) {
    const sourcePath = join(paintedSourceDir, sourceName);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing painted terrain source ${sourcePath}; run node tools/paint_terrain_textures.mjs first`);
    }
    copyFileSync(sourcePath, join(outDir, targetName));
  }

	const outputs = [
		['grass_normal.png', makeNormalTexture('grass', 0.34)],
		['grass_mr.png', makeMetallicRoughnessTexture(0.72, 0.05)],
		['meadow_normal.png', makeNormalTexture('meadow', 0.32)],
    ['meadow_mr.png', makeMetallicRoughnessTexture(0.72, 0.05)],
	    ['dirt_normal.png', makeNormalTexture('dirt', 0.20)],
    ['dirt_mr.png', makeMetallicRoughnessTexture(0.77, 0.05)],
    ['rock_normal.png', makeNormalTexture('rock', 0.42)],
    ['rock_mr.png', makeMetallicRoughnessTexture(0.69, 0.06)],
  ];
  for (const [name, data] of outputs) {
    writeFileSync(join(outDir, name), data);
  }
}

function requireBakedEffectTextures() {
  if (!existsSync(grassCardAtlasPath)) {
    throw new Error(`missing baked grass card atlas ${grassCardAtlasPath}; run node tools/paint_terrain_textures.mjs first`);
  }
}

function terrainVertexColor(x, z, col = 0, row = 0) {
  const weights = terrainSplatWeights(x, z, col, row);
  const grass = [54, 138, 36, 255];
  const meadow = [80, 150, 40, 255];
  const dirt = [158, 94, 48, 255];
  const rock = [112, 108, 94, 255];
  let color = [0, 0, 0, 255];
  for (const [source, weight] of [
    [grass, weights.grass],
    [meadow, weights.meadow],
    [dirt, weights.dirt],
    [rock, weights.rock],
  ]) {
    color[0] += source[0] * weight;
    color[1] += source[1] * weight;
    color[2] += source[2] * weight;
  }
  const noise = noise2(Math.floor(x * 0.12 + 3100), Math.floor(z * 0.12 - 1700));
  const fine = noise2(Math.floor(x * 0.48 - 1100), Math.floor(z * 0.48 + 2300));
  const stroke = 0.5 + 0.5 * Math.sin(x * 0.050 + z * 0.018 + noise * 2.3);
  const greenCover = weights.grass + weights.meadow * 0.68;
  const shade = 0.70 + noise * 0.13 + fine * 0.040 + stroke * 0.055;
  return [
    clamp(color[0] * shade - greenCover * 5 + weights.dirt * 4, 0, 255),
    clamp(color[1] * (shade + greenCover * 0.018), 0, 255),
    clamp(color[2] * shade - greenCover * 3, 0, 255),
    255,
  ];
}

function visualTerrainWorldY(x, z) {
  return targetTerrainWorldY(x, z) - terrainRoadDeckSink(x, z);
}

function terrainRoadDeckSink(x, z) {
  const ctx = terrainContext(x, z);
  const fullSinkEdge = roadShoulderOuterOffset + 2.6;
  const fadeEnd = Math.max(fullSinkEdge + 6.0, shoulderWidth * 1.35);
  const fade = 1 - smoothstep(fullSinkEdge, fadeEnd, ctx.edgeDistance);
  return roadTerrainSinkDepth * fade;
}

function terrainRoadKeepoutMask(x, z) {
  const ctx = terrainContext(x, z);
  return ctx.edgeDistance <= roadTerrainCullMargin;
}

function terrainTriangleInRoadKeepout(positions, roadKeepoutMask, a, b, c) {
  if (roadKeepoutMask[a] || roadKeepoutMask[b] || roadKeepoutMask[c]) {
    return true;
  }
  const ia = a * 3;
  const ib = b * 3;
  const ic = c * 3;
  return (
    terrainRoadKeepoutMask((positions[ia] + positions[ib]) * 0.5, (positions[ia + 2] + positions[ib + 2]) * 0.5) ||
    terrainRoadKeepoutMask((positions[ib] + positions[ic]) * 0.5, (positions[ib + 2] + positions[ic + 2]) * 0.5) ||
    terrainRoadKeepoutMask((positions[ic] + positions[ia]) * 0.5, (positions[ic + 2] + positions[ia + 2]) * 0.5) ||
    terrainRoadKeepoutMask(
      (positions[ia] + positions[ib] + positions[ic]) / 3,
      (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3,
    )
  );
}

function buildLowpolyTerrainMesh(segments) {
  const globalPositions = [];
  const globalUvs = [];
  const globalColors = [];
  const globalRoadKeepoutMask = [];
  for (let row = 0; row <= segments; row++) {
    const v = row / segments;
    const z = (v - 0.5) * terrainDepth;
    for (let col = 0; col <= segments; col++) {
      const u = col / segments;
      const x = (u - 0.5) * terrainWidth;
      const y = visualTerrainWorldY(x, z);
      globalPositions.push(x, y, z);
      globalUvs.push(u * 18, v * 18);
      globalColors.push(...terrainVertexColor(x, z, col, row).map((channel) => channel / 255));
      globalRoadKeepoutMask.push(terrainRoadKeepoutMask(x, z));
    }
  }
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const rowStride = segments + 1;
  const appendTri = (a, b, c) => {
    const normal = faceNormal(globalPositions, a, b, c);
    const base = positions.length / 3;
    for (const index of [a, b, c]) {
      positions.push(globalPositions[index * 3], globalPositions[index * 3 + 1], globalPositions[index * 3 + 2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(globalUvs[index * 2], globalUvs[index * 2 + 1]);
      colors.push(globalColors[index * 4], globalColors[index * 4 + 1], globalColors[index * 4 + 2], globalColors[index * 4 + 3]);
    }
    indices.push(base, base + 1, base + 2);
  };
  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < segments; col++) {
      const a = row * rowStride + col;
      const b = a + 1;
      const c = a + rowStride;
      const d = c + 1;
      if (!terrainTriangleInRoadKeepout(globalPositions, globalRoadKeepoutMask, a, c, b)) {
        appendTri(a, c, b);
      }
      if (!terrainTriangleInRoadKeepout(globalPositions, globalRoadKeepoutMask, b, c, d)) {
        appendTri(b, c, d);
      }
    }
  }
  appendRoadsideTerrainCorridor({ positions, normals, uvs, colors, indices }, primitiveTrackVisualSampleCount());
  return { positions, normals, uvs, colors, indices };
}

function appendRoadsideTerrainCorridor(mesh, sampleCount) {
  const offsets = [roadTerrainCorridorInnerOffset, roadTerrainCorridorInnerOffset + 1.8, roadTerrainCorridorInnerOffset + 4.9, roadTerrainCorridorOuterOffset];
  for (const side of [-1, 1]) {
    const startVertex = mesh.positions.length / 3;
    for (let i = 0; i <= sampleCount; i++) {
      let d = (i / sampleCount) * voTrackLength;
      if (i === sampleCount) d = 0;
      const pose = voTrackPoseAt(d);
      for (let j = 0; j < offsets.length; j++) {
        const offset = offsets[j];
        const edgeT = j / (offsets.length - 1);
        const base = addVec(pose.position, scaleVec(pose.right, side * (pose.halfWidth + offset)));
        const y = visualTerrainWorldY(base.x, base.z) + 0.018;
        const color = roadsideTerrainCorridorColor(base.x, base.z, edgeT, d, side);
        appendMeshVertex(mesh, { x: base.x, y, z: base.z }, edgeT * 2.5, d / 24.0, color);
      }
    }
    for (let i = 0; i < sampleCount; i++) {
      for (let j = 0; j < offsets.length - 1; j++) {
        const base = startVertex + i * offsets.length + j;
        const next = base + offsets.length;
        if (side < 0) {
          appendIndexedFace(mesh, base, next, base + 1);
          appendIndexedFace(mesh, base + 1, next, next + 1);
        } else {
          appendIndexedFace(mesh, base, base + 1, next);
          appendIndexedFace(mesh, base + 1, next + 1, next);
        }
      }
    }
  }
}

function roadsideTerrainCorridorColor(x, z, edgeT, distance, side) {
  const u = Math.floor((x / terrainWidth + 0.5) * outputSplatSize);
  const v = Math.floor((z / terrainDepth + 0.5) * outputSplatSize);
  const terrain = terrainVertexColor(x, z, u, v).map((channel) => channel / 255);
  const dirtNoise = trackScatterRand(Math.floor(distance * 0.43) + (side > 0 ? 211 : 389), 15.7);
  const wornDirt = [0.48 + dirtNoise * 0.08, 0.38 + dirtNoise * 0.06, 0.21 + dirtNoise * 0.04, 1];
  const grassBlend = smoothstep(0.22, 0.92, edgeT);
  return [
    mix(wornDirt[0], terrain[0] * 1.02, grassBlend),
    mix(wornDirt[1], terrain[1] * 1.04, grassBlend),
    mix(wornDirt[2], terrain[2] * 0.98, grassBlend),
    1,
  ];
}

function appendIndexedFace(mesh, a, b, c) {
  const normal = faceNormal(mesh.positions, a, b, c);
  for (const index of [a, b, c]) {
    const base = index * 3;
    mesh.normals[base] = normal[0];
    mesh.normals[base + 1] = normal[1];
    mesh.normals[base + 2] = normal[2];
  }
  mesh.indices.push(a, b, c);
}

function validateTerrainMeshRoadKeepout(mesh, label) {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];
    if (meshTriangleTouchesRoadKeepout(mesh.positions, a, b, c)) {
      throw new Error(`${label} emitted a terrain triangle inside the road keepout at ${formatTriangleDebug(mesh.positions, a, b, c)}`);
    }
  }
}

function formatTriangleDebug(positions, a, b, c) {
  const ids = [a, b, c];
  return ids
    .map((index) => {
      const i = index * 3;
      const ctx = terrainContext(positions[i], positions[i + 2]);
      return `(${positions[i].toFixed(2)},${positions[i + 2].toFixed(2)} edge=${ctx.edgeDistance.toFixed(2)})`;
    })
    .join(' ');
}

function meshTriangleTouchesRoadKeepout(positions, a, b, c) {
  const ia = a * 3;
  const ib = b * 3;
  const ic = c * 3;
  return (
    terrainRoadKeepoutMask(positions[ia], positions[ia + 2]) ||
    terrainRoadKeepoutMask(positions[ib], positions[ib + 2]) ||
    terrainRoadKeepoutMask(positions[ic], positions[ic + 2]) ||
    terrainRoadKeepoutMask((positions[ia] + positions[ib]) * 0.5, (positions[ia + 2] + positions[ib + 2]) * 0.5) ||
    terrainRoadKeepoutMask((positions[ib] + positions[ic]) * 0.5, (positions[ib + 2] + positions[ic + 2]) * 0.5) ||
    terrainRoadKeepoutMask((positions[ic] + positions[ia]) * 0.5, (positions[ic + 2] + positions[ia + 2]) * 0.5) ||
    terrainRoadKeepoutMask(
      (positions[ia] + positions[ib] + positions[ic]) / 3,
      (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3,
    )
  );
}

function faceNormal(positions, a, b, c) {
  const ia = a * 3;
  const ib = b * 3;
  const ic = c * 3;
  const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
  const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
  const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const len = Math.max(0.0001, Math.hypot(nx, ny, nz));
  return [nx / len, ny / len, nz / len];
}

const voTrackSegments = trackPoints.map((point, i) => {
  const next = trackPoints[(i + 1) % trackPoints.length];
  return Math.hypot(next.x - point.x, next.y - point.y, next.z - point.z);
});
const voTrackLength = voTrackSegments.reduce((sum, length) => sum + length, 0);

function wrapTrackDistance(distance) {
  return ((distance % voTrackLength) + voTrackLength) % voTrackLength;
}

function voTrackSampleAt(distance) {
  let d = wrapTrackDistance(distance);
  for (let i = 0; i < trackPoints.length; i++) {
    const segLen = voTrackSegments[i];
    if (d > segLen) {
      d -= segLen;
      continue;
    }
    const point = trackPoints[i];
    const next = trackPoints[(i + 1) % trackPoints.length];
    const t = segLen > 0 ? d / segLen : 0;
    const position = {
      x: mix(point.x, next.x, t),
      y: mix(point.y, next.y, t),
      z: mix(point.z, next.z, t),
    };
    return {
      position,
      halfWidth: mix(point.width ?? 18, next.width ?? 18, t) * 0.5,
      distance: wrapTrackDistance(distance),
    };
  }
  return voTrackSampleAt(0);
}

function voTrackPoseAt(distance) {
  const sample = voTrackSampleAt(distance);
  const prev = voTrackSampleAt(distance - 4.0);
  const next = voTrackSampleAt(distance + 4.0);
  const fx = next.position.x - prev.position.x;
  const fy = next.position.y - prev.position.y;
  const fz = next.position.z - prev.position.z;
  const fl = Math.max(0.0001, Math.hypot(fx, fy, fz));
  const forward = { x: fx / fl, y: fy / fl, z: fz / fl };
  const rl = Math.max(0.0001, Math.hypot(-forward.z, forward.x));
  const right = { x: -forward.z / rl, y: 0, z: forward.x / rl };
  return {
    position: sample.position,
    forward,
    right,
    halfWidth: sample.halfWidth,
    distance: sample.distance,
  };
}

function primitiveTrackVisualSampleCount() {
  return clamp(Math.ceil(voTrackLength / 3.4), 64, 420);
}

function primitiveTrackDecalSampleCount() {
  return Math.max(48, Math.floor(primitiveTrackVisualSampleCount() / 2));
}

function roadSurfacePoint(pos, height) {
  const terrainYAtPoint = targetTerrainWorldY(pos.x, pos.z);
  return { x: pos.x, y: Math.max(pos.y, terrainYAtPoint) + height, z: pos.z };
}

function createMesh() {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

function appendMeshVertex(mesh, pos, u, v, color = [1, 1, 1, 1], normal = { x: 0, y: 1, z: 0 }) {
  const n = normalizeVec(normal);
  mesh.positions.push(pos.x, pos.y, pos.z);
  mesh.normals.push(n.x, n.y, n.z);
  mesh.uvs.push(u, v);
  mesh.colors.push(color[0], color[1], color[2], color[3]);
}

function buildRoadRibbonMesh(sampleCount, edgeInset, height) {
	const mesh = createMesh();
	const columns = 7;
	for (let i = 0; i <= sampleCount; i++) {
		let d = (i / sampleCount) * voTrackLength;
		if (i === sampleCount) d = 0;
		const pose = voTrackPoseAt(d);
		const halfWidth = Math.max(1.0, pose.halfWidth - edgeInset);
		const v = d / 18.0;
		for (let j = 0; j < columns; j++) {
			const u = j / (columns - 1);
			const lateral = (u * 2.0 - 1.0) * halfWidth;
      const pos = roadSurfacePoint(addVec(pose.position, scaleVec(pose.right, lateral)), height);
      appendMeshVertex(mesh, pos, u, v);
    }
  }
  for (let i = 0; i < sampleCount; i++) {
    const row = i * columns;
    const next = (i + 1) * columns;
    for (let j = 0; j < columns - 1; j++) {
      const base = row + j;
      const nextBase = next + j;
      mesh.indices.push(base, base + 1, nextBase, base + 1, nextBase + 1, nextBase);
    }
  }
  return mesh;
}

function buildRoadShoulderMesh(sampleCount, innerOffset, outerOffset, height) {
  const mesh = createMesh();
  const columns = 4;
  for (const side of [-1, 1]) {
    const startVertex = mesh.positions.length / 3;
    for (let i = 0; i <= sampleCount; i++) {
      let d = (i / sampleCount) * voTrackLength;
      if (i === sampleCount) d = 0;
      const pose = voTrackPoseAt(d);
      const v = d / 18.0;
      for (let j = 0; j < columns; j++) {
        const edgeT = j / (columns - 1);
        const offset = mix(innerOffset, outerOffset, smoothstep(0, 1, edgeT));
        const base = addVec(pose.position, scaleVec(pose.right, side * (pose.halfWidth + offset)));
        const deckY = roadSurfacePoint(base, mix(height, roadShoulderOuterHeight, edgeT)).y;
        const terrainYAtPoint = visualTerrainWorldY(base.x, base.z) + 0.055;
        const y = mix(deckY, Math.max(terrainYAtPoint, deckY - 0.26), smoothstep(0.55, 1.0, edgeT));
        appendMeshVertex(mesh, { x: base.x, y, z: base.z }, edgeT, v, roadShoulderVertexColor(d, side, edgeT));
      }
    }
    for (let i = 0; i < sampleCount; i++) {
      for (let j = 0; j < columns - 1; j++) {
        const base = startVertex + i * columns + j;
        const next = base + columns;
        if (side < 0) {
          mesh.indices.push(base, next, base + 1, base + 1, next, next + 1);
        } else {
          mesh.indices.push(base, base + 1, next, base + 1, next + 1, next);
        }
      }
    }
  }
  return mesh;
}

function roadShoulderVertexColor(distance, side, edgeT) {
		const coarse = trackScatterRand(Math.floor(distance * 0.17) + (side > 0 ? 113 : 241), 9.3);
		const fine = trackScatterRand(Math.floor(distance * 0.73) + (side > 0 ? 409 : 587), 17.9);
  const jitter = 0.88 + coarse * 0.10 + fine * 0.04;
  const innerDirt = [0.96, 0.82, 0.66, 1];
  const compacted = [0.82, 0.70, 0.58, 1];
  const outerGrass = [0.66, 1.03, 0.58, 1];
  const midBlend = smoothstep(0.0, 0.54, edgeT);
  const grassBlend = smoothstep(0.50, 1.0, edgeT);
  const dirt = [
    mix(innerDirt[0], compacted[0], midBlend),
    mix(innerDirt[1], compacted[1], midBlend),
    mix(innerDirt[2], compacted[2], midBlend),
    1,
  ];
  return [
    mix(dirt[0], outerGrass[0], grassBlend) * jitter,
    mix(dirt[1], outerGrass[1], grassBlend) * jitter,
    mix(dirt[2], outerGrass[2], grassBlend) * jitter,
    1,
  ];
}

function buildRoadEdgeLinesMesh(sampleCount, height) {
  const mesh = createMesh();
  for (const side of [-1, 1]) {
    const startVertex = mesh.positions.length / 3;
    for (let i = 0; i <= sampleCount; i++) {
      let d = (i / sampleCount) * voTrackLength;
      if (i === sampleCount) d = 0;
      const pose = voTrackPoseAt(d);
      const inner = pose.halfWidth - 1.42;
      const outer = pose.halfWidth - 1.12;
      let low = -outer;
      let high = -inner;
      if (side > 0) {
        low = inner;
        high = outer;
      }
      const p0 = roadSurfacePoint(addVec(pose.position, scaleVec(pose.right, low)), height);
      const p1 = roadSurfacePoint(addVec(pose.position, scaleVec(pose.right, high)), height);
      const v = d / 18.0;
      appendMeshVertex(mesh, p0, 0, v);
      appendMeshVertex(mesh, p1, 1, v);
    }
    for (let i = 0; i < sampleCount; i++) {
      const base = startVertex + i * 2;
      if (side < 0) {
        mesh.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      } else {
        mesh.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }
  return mesh;
}

function buildRoadCenterDashesMesh(sampleCount, height) {
	const mesh = createMesh();
	const step = voTrackLength / sampleCount;
  const dashWidth = 0.46;
  for (let i = 0; i < sampleCount; i += 8) {
    const d0 = i * step + step * 0.36;
    const d1 = Math.min(i * step + step * 3.05, voTrackLength);
    const p0 = voTrackPoseAt(d0);
    const p1 = voTrackPoseAt(d1);
    const base = mesh.positions.length / 3;
    appendMeshVertex(mesh, roadSurfacePoint(subVec(p0.position, scaleVec(p0.right, dashWidth * 0.5)), height), 0, d0 / 18.0);
    appendMeshVertex(mesh, roadSurfacePoint(addVec(p0.position, scaleVec(p0.right, dashWidth * 0.5)), height), 1, d0 / 18.0);
    appendMeshVertex(mesh, roadSurfacePoint(subVec(p1.position, scaleVec(p1.right, dashWidth * 0.5)), height), 0, d1 / 18.0);
    appendMeshVertex(mesh, roadSurfacePoint(addVec(p1.position, scaleVec(p1.right, dashWidth * 0.5)), height), 1, d1 / 18.0);
    mesh.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
	return mesh;
}

function buildRoadCurbBlocksMesh(step, baseHeight) {
	const mesh = createMesh();
	const count = Math.max(1, Math.floor(voTrackLength / step));
	for (let i = 0; i < count; i++) {
		const distance = (i + 0.5) * step;
		const pose = voTrackPoseAt(distance);
		for (const side of [-1, 1]) {
			const redBlock = (i + (side > 0 ? 1 : 0)) % 2 === 0;
			const color = redBlock ? [0.92, 0.24, 0.14, 1] : [0.98, 0.93, 0.82, 1];
			appendCurbBlock(mesh, pose, side, step * 0.58, baseHeight, color);
		}
	}
	return mesh;
}

function appendCurbBlock(mesh, pose, side, length, baseHeight, color) {
	const innerDistance = pose.halfWidth - roadAsphaltEdgeInset + roadCurbRoadClearance;
	const outerDistance = Math.min(pose.halfWidth + roadCurbOuterOffset - roadCurbShoulderClearance, innerDistance + roadCurbWidth);
	const halfLength = length * 0.5;
	const point = (distance, forwardOffset) => roadSurfacePoint(addVec(addVec(pose.position, scaleVec(pose.right, side * distance)), scaleVec(pose.forward, forwardOffset)), baseHeight);
	const backInner = point(innerDistance, -halfLength);
	const backOuter = point(outerDistance, -halfLength);
	const frontInner = point(innerDistance, halfLength);
	const frontOuter = point(outerDistance, halfLength);
	appendQuadFace(mesh, backInner, backOuter, frontInner, frontOuter, { x: 0, y: 1, z: 0 }, color);
}

function appendQuadFace(mesh, p0, p1, p2, p3, normal, color) {
	const actual = crossVec(subVec(p1, p0), subVec(p2, p0));
	const flip = dotVec(actual, normal) < 0;
	const corners = flip ? [p0, p2, p1, p3] : [p0, p1, p2, p3];
	const base = mesh.positions.length / 3;
	for (const [index, corner] of corners.entries()) {
		appendMeshVertex(mesh, corner, index % 2, index > 1 ? 1 : 0, color, normal);
	}
	mesh.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
}

function shadeColor(color, factor) {
	return [color[0] * factor, color[1] * factor, color[2] * factor, color[3]];
}

function buildCreekRibbonMesh(sampleCount, start, end, width, height) {
	const mesh = createMesh();
	for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const d = start + (end - start) * t;
    const pose = voTrackPoseAt(d);
    const wobble = Math.sin(t * Math.PI * 5.4) * 3.6 + Math.sin(t * Math.PI * 13.0 + 0.7) * 1.1;
    const center = addVec(pose.position, scaleVec(pose.right, -(pose.halfWidth + 30.0 + wobble)));
    const halfWidth = width * (0.42 + 0.12 * Math.sin(t * Math.PI * 7.0 + 1.3));
    const p0 = roadSurfacePoint(subVec(center, scaleVec(pose.right, halfWidth)), height);
    const p1 = roadSurfacePoint(addVec(center, scaleVec(pose.right, halfWidth)), height);
    appendMeshVertex(mesh, p0, 0, d / 18.0);
    appendMeshVertex(mesh, p1, 1, d / 18.0);
  }
  for (let i = 0; i < sampleCount; i++) {
    const base = i * 2;
    mesh.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  return mesh;
}

function buildProjectedDecalMesh(desc) {
  const mesh = createMesh();
  const count = desc.count;
  const startDistance = desc.startDistance ?? 0;
  const endDistance = desc.endDistance ?? voTrackLength;
  const length = endDistance - startDistance;
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const seed = desc.seed + i * 9151 + side * 1973;
      const distance = startDistance + ((i + trackScatterRand(seed, 5.1)) / count) * length;
      const pose = voTrackPoseAt(distance);
      let lateral = desc.lateralMin;
      if (desc.lateralMax > desc.lateralMin) {
        lateral += trackScatterRand(seed, 1.9) * (desc.lateralMax - desc.lateralMin);
      }
      if (desc.edgeRelative) {
        lateral += pose.halfWidth;
      }
      const along = desc.alongJitter > 0 ? (trackScatterRand(seed, 2.5) - 0.5) * desc.alongJitter : 0;
      const center = addVec(addVec(pose.position, scaleVec(pose.right, side * lateral)), scaleVec(pose.forward, along));
      const width = desc.widthMin + (desc.widthMax - desc.widthMin) * trackScatterRand(seed, 3.1);
      const decalLength = desc.lengthMin + (desc.lengthMax - desc.lengthMin) * trackScatterRand(seed, 3.7);
      const yaw = (trackScatterRand(seed, 4.3) - 0.5) * desc.yawJitter;
      const forward = normalizeVec(addVec(scaleVec(pose.forward, Math.cos(yaw)), scaleVec(pose.right, Math.sin(yaw))));
      const right = normalizeVec(crossVec(forward, { x: 0, y: 1, z: 0 }));
      appendProjectedDecalQuad(mesh, center, right, forward, width, decalLength, desc.surfaceOffset, desc.color, desc.projectToTerrain);
    }
  }
  return mesh;
}

function appendProjectedDecalQuad(mesh, center, right, forward, width, length, surfaceOffset, color, projectToTerrain) {
  const base = mesh.positions.length / 3;
  const halfW = width * 0.5;
  const halfL = length * 0.5;
  const corners = [
    subVec(subVec(center, scaleVec(right, halfW)), scaleVec(forward, halfL)),
    subVec(addVec(center, scaleVec(right, halfW)), scaleVec(forward, halfL)),
    addVec(subVec(center, scaleVec(right, halfW)), scaleVec(forward, halfL)),
    addVec(addVec(center, scaleVec(right, halfW)), scaleVec(forward, halfL)),
  ];
  const uvs = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  for (let i = 0; i < corners.length; i++) {
    const corner = { ...corners[i] };
    if (projectToTerrain) {
      corner.y = visualTerrainWorldY(corner.x, corner.z);
    }
    corner.y += surfaceOffset;
    appendMeshVertex(mesh, corner, uvs[i][0], uvs[i][1], color);
  }
  mesh.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
}

function buildPrimitiveTrackMeshAssets() {
	const visualSampleCount = primitiveTrackVisualSampleCount();
	const decalSampleCount = primitiveTrackDecalSampleCount();
	const startDistance = voTrackLength * 0.052;
		return {
			roadAsphalt: buildRoadRibbonMesh(visualSampleCount, roadAsphaltEdgeInset, 0.420),
			roadShoulders: buildRoadShoulderMesh(visualSampleCount, roadShoulderInnerOffset, roadShoulderOuterOffset, 0.330),
			roadCurbs: buildRoadCurbBlocksMesh(4.4, 0.430),
				roadEdgeLines: buildRoadEdgeLinesMesh(visualSampleCount, 0.640),
			roadCenterDashes: buildRoadCenterDashesMesh(visualSampleCount, 0.635),
    roadTireGrime: buildProjectedDecalMesh({
      seed: 7113,
      count: Math.floor(decalSampleCount / 4),
      lateralMin: 1.2,
      lateralMax: 5.0,
      widthMin: 0.20,
      widthMax: 0.54,
      lengthMin: 1.4,
      lengthMax: 4.5,
      yawJitter: Math.PI * 0.16,
      alongJitter: 2.5,
      surfaceOffset: 0.485,
      color: [0.09, 0.071, 0.055, 0.22],
      projectToTerrain: false,
    }),
    roadEdgeGrime: buildProjectedDecalMesh({
      seed: 33091,
      count: Math.floor(decalSampleCount * 1.45),
      lateralMin: -0.54,
      lateralMax: 0.02,
      edgeRelative: true,
      widthMin: 0.052,
      widthMax: 0.18,
      lengthMin: 0.16,
      lengthMax: 0.62,
      yawJitter: Math.PI * 0.38,
      alongJitter: 4.2,
      surfaceOffset: 0.450,
      color: [0.55, 0.384, 0.227, 0.17],
      projectToTerrain: true,
    }),
    heroCreek: buildCreekRibbonMesh(96, startDistance - voTrackLength * 0.025, startDistance + voTrackLength * 0.130, 3.6, 0.18),
  };
}

const BAKED_PRIMITIVE_LAYER_MAGIC = 1280327510;
const BAKED_PRIMITIVE_LAYER_VERSION = 1;
const bakedRoadsidePrimitiveSlotCount = 8;
const primitiveFlags = {
	noShadow: 1,
	wind: 2,
	yBillboard: 8,
	atlasUV: 16,
};
const roadAsphaltEdgeInset = 0.78;
const roadShoulderInnerOffset = -roadAsphaltEdgeInset + 0.02;
const roadShoulderOuterOffset = 2.45;
const roadShoulderOuterHeight = 0.145;
const roadPhysicsOuterOffset = roadShoulderOuterOffset;
const roadTerrainSinkDepth = 0.72;
const roadTerrainCullMargin = 1.95;
const roadTerrainCorridorInnerOffset = roadTerrainCullMargin + 0.32;
const roadTerrainCorridorOuterOffset = roadTerrainCorridorInnerOffset + 8.4;
const roadCurbRoadClearance = 0.34;
const roadCurbOuterOffset = 0.58;
const roadCurbShoulderClearance = 0.06;
const roadCurbWidth = 0.84;
const roadsideGrassEdgeClearance = roadShoulderOuterOffset + 0.80;
const primitiveSlots = {
  grassCard: 0,
  dirtStroke: 1,
  palePebble: 2,
  pebble: 3,
  stone: 4,
  flowerStem: 5,
  flowerYellow: 6,
  flowerWhite: 7,
};

function makeBakedRoadsidePrimitiveLayer() {
  const instances = [];
  const billboardCardFlags = primitiveFlags.noShadow | primitiveFlags.wind | primitiveFlags.yBillboard | primitiveFlags.atlasUV;
  const lowBillboardCardFlags = primitiveFlags.noShadow | primitiveFlags.yBillboard | primitiveFlags.atlasUV;
  const cardFlags = billboardCardFlags;
  const lowCardFlags = lowBillboardCardFlags;

  const edgeFringe = [
    grassCardPrototype({ weight: 1.30, scaleMin: [1.05, 1, 1.18], scaleMax: [2.02, 1, 2.42], atlas: [0.5, 0.5, 0.5, 0.5], wind: 0.040, lodFar: roadsideGrassLodFar(62), flags: billboardCardFlags }),
    grassCardPrototype({ weight: 1.10, scaleMin: [1.02, 1, 1.22], scaleMax: [1.96, 1, 2.52], atlas: [0, 0.5, 0.5, 0.5], wind: 0.040, lodFar: roadsideGrassLodFar(62), flags: billboardCardFlags }),
    grassCardPrototype({ weight: 0.70, scaleMin: [1.00, 1, 1.12], scaleMax: [1.98, 1, 2.28], atlas: [0.5, 0, 0.5, 0.5], wind: 0.060, lodFar: roadsideGrassLodFar(68), flags: billboardCardFlags }),
  ];
  const edgeCards = [
    grassCardPrototype({ weight: 1.25, scaleMin: [1.18, 1, 1.18], scaleMax: [2.36, 1, 2.62], atlas: [0.5, 0, 0.5, 0.5], wind: 0.070, lodFar: roadsideGrassLodFar(82), flags: billboardCardFlags }),
    grassCardPrototype({ weight: 1.05, scaleMin: [1.15, 1, 1.22], scaleMax: [2.28, 1, 2.74], atlas: [0, 0, 0.5, 0.5], wind: 0.075, lodFar: roadsideGrassLodFar(82), flags: billboardCardFlags }),
    grassCardPrototype({ weight: 0.95, scaleMin: [1.18, 1, 0.92], scaleMax: [2.42, 1, 1.86], atlas: [0, 0.5, 0.5, 0.5], wind: 0.060, lodFar: roadsideGrassLodFar(78), flags: billboardCardFlags }),
  ];
  const meadowNap = [
    grassCardPrototype({ weight: 1.20, scaleMin: [1.10, 1, 0.60], scaleMax: [2.28, 1, 1.34], atlas: [0.5, 0.5, 0.5, 0.5], wind: 0.026, lodFar: roadsideGrassLodFar(76), flags: lowCardFlags }),
    grassCardPrototype({ weight: 1.05, scaleMin: [1.08, 1, 0.64], scaleMax: [2.20, 1, 1.42], atlas: [0, 0.5, 0.5, 0.5], wind: 0.026, lodFar: roadsideGrassLodFar(76), flags: lowCardFlags }),
    grassCardPrototype({ weight: 0.85, scaleMin: [1.10, 1, 0.78], scaleMax: [2.30, 1, 1.64], atlas: [0.5, 0, 0.5, 0.5], wind: 0.024, lodFar: roadsideGrassLodFar(80), flags: cardFlags }),
  ];
  const meadowMass = [
    grassCardPrototype({ weight: 1.10, scaleMin: [0.92, 1, 0.76], scaleMax: [1.98, 1, 1.56], atlas: [0.5, 0, 0.5, 0.5], wind: 0.070, lodFar: roadsideGrassLodFar(108), flags: cardFlags }),
    grassCardPrototype({ weight: 0.95, scaleMin: [0.88, 1, 0.80], scaleMax: [1.88, 1, 1.66], atlas: [0, 0, 0.5, 0.5], wind: 0.070, lodFar: roadsideGrassLodFar(108), flags: cardFlags }),
  ];
  const outerCards = [
    grassCardPrototype({ weight: 1.15, scaleMin: [0.58, 1, 0.28], scaleMax: [1.22, 1, 0.64], atlas: [0.5, 0.5, 0.5, 0.5], wind: 0.028, lodFar: roadsideGrassLodFar(88), flags: lowCardFlags }),
    grassCardPrototype({ weight: 1.00, scaleMin: [0.56, 1, 0.30], scaleMax: [1.16, 1, 0.68], atlas: [0, 0.5, 0.5, 0.5], wind: 0.028, lodFar: roadsideGrassLodFar(88), flags: lowCardFlags }),
  ];

  addBakedTrackBand(instances, {
    seed: 4453,
    density: 2.25 * roadsideGrassDensityScale,
    lateralMin: roadsideGrassEdgeClearance,
    lateralMax: 4.2,
    edgeRelative: true,
    edgeClearance: roadsideGrassEdgeClearance,
    alongJitter: 0.70,
    lateralJitter: 0.52,
    surfaceOffset: 0.035,
    mask: soilLipGrassMask,
    maskMin: 0.015,
    prototypes: edgeFringe,
  });
  addBakedTrackBand(instances, {
    seed: 4457,
    density: 1.35 * roadsideGrassDensityScale,
    lateralMin: roadsideGrassEdgeClearance + 0.20,
    lateralMax: 3.3,
    edgeRelative: true,
    edgeClearance: roadsideGrassEdgeClearance,
    alongJitter: 0.56,
    lateralJitter: 0.34,
    surfaceOffset: 0.038,
    mask: soilLipGrassMask,
    maskMin: 0.018,
    prototypes: edgeFringe,
  });
  addBakedTrackBand(instances, {
    seed: 4461,
    density: 0.74 * roadsideGrassDensityScale,
    lateralMin: roadsideGrassEdgeClearance + 0.35,
    lateralMax: 7.2,
    edgeRelative: true,
    edgeClearance: roadsideGrassEdgeClearance,
    alongJitter: 0.78,
    lateralJitter: 0.82,
    surfaceOffset: 0.040,
    mask: soilLipGrassMask,
    maskMin: 0.030,
    prototypes: edgeCards,
  });
  addBakedTrackBand(instances, {
    seed: 4483,
    density: 0.32 * roadsideGrassDensityScale,
    lateralMin: roadsideGrassEdgeClearance,
    lateralMax: 18.5,
    edgeRelative: true,
    edgeClearance: roadsideGrassEdgeClearance,
    alongJitter: 0.92,
    lateralJitter: 1.55,
    surfaceOffset: 0.055,
    mask: meadowCarpetMask,
    maskMin: 0.06,
    exclusionMask: barePatchMask,
    exclusionThreshold: 0.99,
    prototypes: meadowNap,
  });
  addBakedTrackBand(instances, {
    seed: 4469,
    density: 0.052 * roadsideGrassDensityScale,
    lateralMin: 4.2,
    lateralMax: 21.5,
    edgeRelative: true,
    edgeClearance: roadsideGrassEdgeClearance,
    alongJitter: 1.20,
    lateralJitter: 1.80,
    surfaceOffset: 0.060,
    mask: meadowCarpetMask,
    maskMin: 0.08,
    exclusionMask: barePatchMask,
    exclusionThreshold: 0.99,
    prototypes: meadowMass,
  });
  addBakedTrackBand(instances, {
    seed: 4489,
    density: 0.015 * roadsideGrassDensityScale,
    lateralMin: 12.0,
    lateralMax: 44.0,
    edgeRelative: true,
    edgeClearance: roadsideGrassEdgeClearance,
    alongJitter: 1.70,
    lateralJitter: 3.2,
    surfaceOffset: 0.045,
    mask: grassFieldMask,
    maskMin: 0.26,
    exclusionMask: barePatchMask,
    exclusionThreshold: 0.96,
    prototypes: outerCards,
  });
  addBakedTrackBand(instances, {
    seed: 7819,
    density: 0.17 * roadsideDetailDensityScale,
    lateralMin: 0.20,
    lateralMax: 3.2,
    edgeRelative: true,
    alongJitter: 1.8,
    lateralJitter: 0.75,
    surfaceOffset: 0.08,
    mask: edgeChipMask,
    maskMin: 0.10,
    alignToTrack: true,
    prototypes: [
      flatDetailPrototype({ slot: primitiveSlots.dirtStroke, weight: 1.3, scaleMin: [0.055, 0.010, 0.14], scaleMax: [0.18, 0.020, 0.46], tintMin: [0.56, 0.39, 0.24, 1], tintMax: [0.84, 0.60, 0.36, 1], lodFar: roadsideDetailLodFar(58) }),
      flatDetailPrototype({ slot: primitiveSlots.palePebble, weight: 0.28, scaleMin: [0.050, 0.014, 0.070], scaleMax: [0.16, 0.026, 0.22], tintMin: [0.54, 0.52, 0.44, 1], tintMax: [0.76, 0.70, 0.58, 1], lodFar: roadsideDetailLodFar(56) }),
    ],
  });
  addBakedTrackBand(instances, {
    seed: 7309,
    density: 0.17 * roadsideDetailDensityScale,
    lateralMin: 0.70,
    lateralMax: 7.2,
    edgeRelative: true,
    alongJitter: 1.1,
    lateralJitter: 1.0,
    surfaceOffset: 0.13,
    mask: pebbleMask,
    maskMin: 0.12,
    prototypes: [
      flatDetailPrototype({ slot: primitiveSlots.pebble, weight: 1.0, scaleMin: [0.11, 0.050, 0.11], scaleMax: [0.36, 0.14, 0.32], tintMin: [0.58, 0.54, 0.44, 1], tintMax: [0.84, 0.78, 0.64, 1], lodFar: roadsideDetailLodFar(64) }),
      flatDetailPrototype({ slot: primitiveSlots.stone, weight: 0.65, scaleMin: [0.15, 0.065, 0.13], scaleMax: [0.46, 0.17, 0.40], tintMin: [0.56, 0.54, 0.46, 1], tintMax: [0.80, 0.76, 0.64, 1], lodFar: roadsideDetailLodFar(66) }),
    ],
  });
  addBakedFlowerBand(instances);

  return {
    count: instances.length,
    buffer: encodeBakedPrimitiveLayer(instances, bakedRoadsidePrimitiveSlotCount),
  };
}

function grassCardPrototype(desc) {
  return {
    slot: primitiveSlots.grassCard,
    weight: desc.weight ?? 1,
    scaleMin: desc.scaleMin,
    scaleMax: desc.scaleMax,
    tintMin: desc.tintMin ?? [0.40, 0.70, 0.24, 1],
    tintMax: desc.tintMax ?? [0.92, 1.00, 0.52, 1],
    yawJitter: Math.PI * 2,
    pitch: Math.PI * 0.5,
    yOffset: desc.yOffset ?? 0,
    bottomAnchor: true,
    flags: desc.flags,
    lodFar: desc.lodFar,
    windStrength: desc.wind,
    atlasUV: desc.atlas,
  };
}

function flatDetailPrototype(desc) {
  return {
    slot: desc.slot,
    weight: desc.weight ?? 1,
    scaleMin: desc.scaleMin,
    scaleMax: desc.scaleMax,
    tintMin: desc.tintMin,
    tintMax: desc.tintMax,
    yawJitter: Math.PI * 2,
    flags: primitiveFlags.noShadow,
    lodFar: desc.lodFar,
  };
}

function addBakedTrackBand(instances, desc) {
  const count = desc.count ?? Math.ceil(voTrackLength * desc.density);
  const sides = desc.side ? [desc.side] : [-1, 1];
  for (const side of sides) {
    for (let i = 0; i < count; i++) {
      const seed = desc.seed + i * 7919 + side * 3571;
      const pose = voTrackPoseAt(((i + trackScatterRand(seed, 1.3)) / count) * voTrackLength);
      let lateral = desc.lateralMin;
      if (desc.lateralMax > desc.lateralMin) {
        lateral += trackScatterRand(seed, 2.1) * (desc.lateralMax - desc.lateralMin);
      }
      if (desc.edgeRelative) {
        lateral += pose.halfWidth;
      }
      lateral += (trackScatterRand(seed, 2.7) - 0.5) * (desc.lateralJitter ?? 0);
      if (desc.edgeRelative && desc.edgeClearance !== undefined) {
        lateral = Math.max(lateral, pose.halfWidth + desc.edgeClearance);
      }
      const along = (trackScatterRand(seed, 3.4) - 0.5) * (desc.alongJitter ?? voTrackLength / count * 0.72);
      const basePos = addVec(addVec(pose.position, scaleVec(pose.right, side * lateral)), scaleVec(pose.forward, along));
      const surfacePos = { x: basePos.x, y: visualTerrainWorldY(basePos.x, basePos.z), z: basePos.z };
      if (desc.mask) {
        const density = clamp(desc.mask(surfacePos), 0, 1);
        if (density < (desc.maskMin ?? 0) || trackScatterRand(seed, 9.9) > density) {
          continue;
        }
      }
      if (desc.exclusionMask && desc.exclusionMask(surfacePos) >= (desc.exclusionThreshold ?? 0.5)) {
        continue;
      }
      if (terrainSlopeAt(surfacePos.x, surfacePos.z) > (desc.slopeMax ?? 0.95)) {
        continue;
      }
      const proto = pickBakedPrototype(desc.prototypes, seed + 19);
      const cluster = proto.cluster ?? desc.cluster ?? 1;
      for (let c = 0; c < cluster; c++) {
        const cseed = seed + c * 2971;
        const radius = desc.clusterRadius ?? 0;
        const clusterOffset = c === 0 ? { x: 0, y: 0, z: 0 } : addVec(scaleVec(pose.right, (trackScatterRand(cseed, 1.2) - 0.5) * radius), scaleVec(pose.forward, (trackScatterRand(cseed, 1.8) - 0.5) * radius));
        const pos = addVec(surfacePos, clusterOffset);
        pos.y = visualTerrainWorldY(pos.x, pos.z) + (desc.surfaceOffset ?? 0) + (proto.yOffset ?? 0);
        const baseYaw = desc.alignToTrack ? Math.atan2(pose.forward.x, pose.forward.z) : 0;
        const clusterYaw = c === 0 ? 0 : Math.PI * (0.42 + 0.18 * trackScatterRand(cseed, 2.4));
        instances.push(makeBakedInstance(proto, pos, baseYaw + clusterYaw, cseed));
      }
    }
  }
}

function addBakedFlowerBand(instances) {
  const count = Math.ceil(voTrackLength * 0.070);
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const seed = 9101 + i * 7919 + side * 3571;
      const pose = voTrackPoseAt(((i + trackScatterRand(seed, 1.3)) / count) * voTrackLength);
      const lateral = pose.halfWidth + 3.4 + trackScatterRand(seed, 2.1) * 9.0 + (trackScatterRand(seed, 2.7) - 0.5) * 1.3;
      const along = (trackScatterRand(seed, 3.4) - 0.5) * 1.2;
      const pos = addVec(addVec(pose.position, scaleVec(pose.right, side * lateral)), scaleVec(pose.forward, along));
      const surface = { x: pos.x, y: visualTerrainWorldY(pos.x, pos.z), z: pos.z };
      const mask = flowerPatchMask(surface);
      if (mask < 0.40 || trackScatterRand(seed, 9.9) > mask || barePatchMask(surface) > 0.5) {
        continue;
      }
      const stemHeight = 0.34 + trackScatterRand(seed, 4.4) * 0.28;
      const stem = {
        slot: primitiveSlots.flowerStem,
        scaleMin: [0.045, stemHeight, 0.045],
        scaleMax: [0.060, stemHeight, 0.060],
        tintMin: [0.56, 0.76, 0.48, 1],
        tintMax: [0.78, 0.94, 0.64, 1],
        flags: primitiveFlags.noShadow,
        yawJitter: Math.PI * 2,
        lodFar: roadsideDetailLodFar(72),
      };
      const headYellow = trackScatterRand(seed, 5.0) > 0.34;
      const head = {
        slot: headYellow ? primitiveSlots.flowerYellow : primitiveSlots.flowerWhite,
        scaleMin: [0.15, 0.09, 0.15],
        scaleMax: [0.28, 0.16, 0.28],
        tintMin: headYellow ? [0.90, 0.76, 0.32, 1] : [0.82, 0.86, 0.86, 1],
        tintMax: headYellow ? [1.0, 0.96, 0.64, 1] : [1.0, 1.0, 0.96, 1],
        flags: primitiveFlags.noShadow,
        yawJitter: Math.PI * 2,
        lodFar: roadsideDetailLodFar(72),
      };
      instances.push(makeBakedInstance(stem, { x: surface.x, y: surface.y + 0.18, z: surface.z }, 0, seed));
      instances.push(makeBakedInstance(head, { x: surface.x, y: surface.y + stemHeight + 0.30, z: surface.z }, 0, seed + 33));
    }
  }
}

function makeBakedInstance(proto, pos, baseYaw, seed) {
  const yaw = baseYaw + (trackScatterRand(seed, 4.6) - 0.5) * (proto.yawJitter ?? 0);
  const rotation = quatMul(quatFromAxisAngle([0, 1, 0], yaw), quatFromAxisAngle([1, 0, 0], proto.pitch ?? 0));
  const scale = randomVec3(proto.scaleMin ?? [1, 1, 1], proto.scaleMax ?? proto.scaleMin ?? [1, 1, 1], seed);
  const anchoredY = pos.y + (proto.bottomAnchor ? scale[2] * 0.48 : 0);
  return {
    slot: proto.slot,
    flags: proto.flags ?? 0,
    position: [pos.x, anchoredY, pos.z],
    rotation,
    scale,
    tint: randomColor(proto.tintMin ?? [0, 0, 0, 0], proto.tintMax ?? proto.tintMin ?? [0, 0, 0, 0], seed),
    lodNear: proto.lodNear ?? 0,
    lodFar: proto.lodFar ?? 0,
    windStrength: proto.windStrength ?? 0,
    atlasUV: proto.atlasUV ?? [0, 0, 0, 0],
  };
}

function pickBakedPrototype(prototypes, seed) {
  const total = prototypes.reduce((sum, proto) => sum + (proto.weight ?? 1), 0);
  let pick = trackScatterRand(seed, 5.2) * total;
  for (const proto of prototypes) {
    pick -= proto.weight ?? 1;
    if (pick <= 0) {
      return proto;
    }
  }
  return prototypes[prototypes.length - 1];
}

function randomVec3(min, max, seed) {
  return [
    mix(min[0], max[0], trackScatterRand(seed, 6.1)),
    mix(min[1], max[1], trackScatterRand(seed, 6.7)),
    mix(min[2], max[2], trackScatterRand(seed, 7.3)),
  ];
}

function randomColor(min, max, seed) {
  return [
    mix(min[0], max[0], trackScatterRand(seed, 10.1)),
    mix(min[1], max[1], trackScatterRand(seed, 10.7)),
    mix(min[2], max[2], trackScatterRand(seed, 11.3)),
    mix(min[3], max[3], trackScatterRand(seed, 11.9)),
  ];
}

function encodeBakedPrimitiveLayer(instances, slotCount) {
  const out = Buffer.alloc(20 + instances.length * 92);
  out.writeUInt32LE(BAKED_PRIMITIVE_LAYER_MAGIC, 0);
  out.writeUInt32LE(BAKED_PRIMITIVE_LAYER_VERSION, 4);
  out.writeUInt32LE(instances.length, 8);
  out.writeUInt32LE(slotCount, 12);
  out.writeUInt32LE(0, 16);
  let offset = 20;
  for (const instance of instances) {
    out.writeUInt32LE(instance.slot, offset);
    offset += 4;
    out.writeUInt32LE(instance.flags, offset);
    offset += 4;
    for (const v of instance.position) {
      out.writeFloatLE(v, offset);
      offset += 4;
    }
    for (const v of instance.rotation) {
      out.writeFloatLE(v, offset);
      offset += 4;
    }
    for (const v of instance.scale) {
      out.writeFloatLE(v, offset);
      offset += 4;
    }
    for (const v of instance.tint) {
      out.writeFloatLE(v, offset);
      offset += 4;
    }
    out.writeFloatLE(instance.lodNear, offset);
    offset += 4;
    out.writeFloatLE(instance.lodFar, offset);
    offset += 4;
    out.writeFloatLE(instance.windStrength, offset);
    offset += 4;
    for (const v of instance.atlasUV) {
      out.writeFloatLE(v, offset);
      offset += 4;
    }
  }
  return out;
}

function roadClearance(pos) {
  return terrainContext(pos.x, pos.z).edgeDistance;
}

function edgeChipMask(pos) {
  return scatterPatchMask(pos, 0.030, 0.145, 0.08);
}

function pebbleMask(pos) {
  return scatterPatchMask(pos, 0.022, 0.115, 0.18);
}

function flowerPatchMask(pos) {
  return scatterPatchMask(pos, 0.014, 0.045, 0.42);
}

function meadowCarpetMask(pos) {
  const edge = roadClearance(pos);
  if (edge < roadsideGrassEdgeClearance || edge > 44.0) {
    return 0;
  }
  return saturate((edge - roadsideGrassEdgeClearance) / 1.05) * (1 - saturate((edge - 36.0) / 8.0)) * scatterPatchMask(pos, 0.012, 0.052, 0.99);
}

function soilLipGrassMask(pos) {
  const edge = roadClearance(pos);
  if (edge < roadsideGrassEdgeClearance || edge > 10.0) {
    return 0;
  }
  return saturate((edge - roadsideGrassEdgeClearance) / 0.55) * (1 - saturate((edge - 7.8) / 2.2)) * scatterPatchMask(pos, 0.016, 0.070, 0.99);
}

function grassFieldMask(pos) {
  const edge = roadClearance(pos);
  if (edge < 4.5) {
    return 0;
  }
  return saturate((edge - 4.5) / 16.0) * (1 - saturate((edge - 150.0) / 70.0)) * scatterPatchMask(pos, 0.012, 0.064, 0.92);
}

function barePatchMask(pos) {
  return primitiveNoise2D(pos.x * 0.020 + 91.0, pos.z * 0.020 - 37.0) > 0.975 ? 1 : 0;
}

function scatterPatchMask(pos, macroScale, fineScale, floor) {
  const macro = primitiveNoise2D(pos.x * macroScale + 17.0, pos.z * macroScale - 23.0);
  const fine = primitiveNoise2D(pos.x * fineScale - 71.0, pos.z * fineScale + 43.0);
  return saturate(floor + macro * 0.62 + fine * 0.28);
}

function primitiveNoise2D(x, z) {
  let v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  v -= Math.floor(v);
  return v < 0 ? v + 1 : v;
}

function saturate(v) {
  return clamp(v, 0, 1);
}

function terrainSlopeAt(x, z) {
  const center = visualTerrainWorldY(x, z);
  const step = 1.0;
  const dx = (visualTerrainWorldY(x + step, z) - center) / step;
  const dz = (visualTerrainWorldY(x, z + step) - center) / step;
  return Math.hypot(dx, dz);
}

function quatFromAxisAngle(axis, angle) {
  if (!angle) {
    return [0, 0, 0, 1];
  }
  const half = angle * 0.5;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function trackScatterRand(seed, salt) {
  let v = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  v -= Math.floor(v);
  return v < 0 ? v + 1 : v;
}

function addVec(a, b) {
  return { x: a.x + b.x, y: (a.y ?? 0) + (b.y ?? 0), z: a.z + b.z };
}

function subVec(a, b) {
  return { x: a.x - b.x, y: (a.y ?? 0) - (b.y ?? 0), z: a.z - b.z };
}

function scaleVec(v, scale) {
  return { x: v.x * scale, y: (v.y ?? 0) * scale, z: v.z * scale };
}

function crossVec(a, b) {
	return {
		x: (a.y ?? 0) * (b.z ?? 0) - a.z * (b.y ?? 0),
		y: a.z * b.x - a.x * (b.z ?? 0),
		z: a.x * (b.y ?? 0) - (a.y ?? 0) * b.x,
	};
}

function dotVec(a, b) {
	return a.x * b.x + (a.y ?? 0) * (b.y ?? 0) + a.z * b.z;
}

function normalizeVec(v) {
	const len = Math.max(0.0001, Math.hypot(v.x, v.y ?? 0, v.z));
	return { x: v.x / len, y: (v.y ?? 0) / len, z: v.z / len };
}

function makeLowpolyTerrainGlb(mesh) {
  const buffers = [];
  const bufferViews = [];
  const accessors = [];

  function addBufferData(data, target = 0) {
    const byteOffset = buffers.reduce((sum, part) => sum + part.length, 0);
    const viewIndex = bufferViews.length;
    const view = { buffer: 0, byteOffset, byteLength: data.length };
    if (target) {
      view.target = target;
    }
    buffers.push(pad4(data, 0));
    bufferViews.push(view);
    return viewIndex;
  }

  function addArray(typedArray, target, type, componentType, count, min, max) {
    const data = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const viewIndex = addBufferData(data, target);
    const accessor = { bufferView: viewIndex, byteOffset: 0, componentType, count, type };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    const accessorIndex = accessors.length;
    accessors.push(accessor);
    return accessorIndex;
  }

  const bounds = positionBounds(mesh.positions);
  const positionAccessor = addArray(Float32Array.from(mesh.positions), 34962, 'VEC3', 5126, mesh.positions.length / 3, bounds.min, bounds.max);
  const normalAccessor = addArray(Float32Array.from(mesh.normals), 34962, 'VEC3', 5126, mesh.normals.length / 3);
  const uvAccessor = addArray(Float32Array.from(mesh.uvs), 34962, 'VEC2', 5126, mesh.uvs.length / 2);
  const colorAccessor = addArray(Float32Array.from(mesh.colors), 34962, 'VEC4', 5126, mesh.colors.length / 4);
  const indexAccessor = addArray(Uint32Array.from(mesh.indices), 34963, 'SCALAR', 5125, mesh.indices.length);
  const bin = Buffer.concat(buffers);
  const json = {
    asset: { version: '2.0', generator: 'BlockKart primitive terrain tool' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'primitive_lowpoly_terrain' }],
    meshes: [
      {
        name: 'primitive_lowpoly_terrain',
        primitives: [
          {
            attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor, COLOR_0: colorAccessor },
            indices: indexAccessor,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'vertex_painted_lowpoly_terrain',
        doubleSided: false,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          roughnessFactor: 0.92,
          metallicFactor: 0,
        },
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad4(bin, 0);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  return Buffer.concat([header, glbChunk(jsonChunk, 0x4e4f534a), glbChunk(binChunk, 0x004e4942)]);
}

function makeStaticMeshGlb(mesh, options) {
  const buffers = [];
  const bufferViews = [];
  const accessors = [];

  function addArray(typedArray, target, type, componentType, count, min, max) {
    const data = pad4(Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength), 0);
    const byteOffset = buffers.reduce((sum, part) => sum + part.length, 0);
    const viewIndex = bufferViews.length;
    buffers.push(data);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: typedArray.byteLength, target });
    const accessor = { bufferView: viewIndex, byteOffset: 0, componentType, count, type };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    const accessorIndex = accessors.length;
    accessors.push(accessor);
    return accessorIndex;
  }

  const bounds = positionBounds(mesh.positions);
  const positionAccessor = addArray(Float32Array.from(mesh.positions), 34962, 'VEC3', 5126, mesh.positions.length / 3, bounds.min, bounds.max);
  const normalAccessor = addArray(Float32Array.from(mesh.normals), 34962, 'VEC3', 5126, mesh.normals.length / 3);
  const uvAccessor = addArray(Float32Array.from(mesh.uvs), 34962, 'VEC2', 5126, mesh.uvs.length / 2);
  const colorAccessor = addArray(Float32Array.from(mesh.colors), 34962, 'VEC4', 5126, mesh.colors.length / 4);
  const indexAccessor = addArray(Uint32Array.from(mesh.indices), 34963, 'SCALAR', 5125, mesh.indices.length);
  const bin = Buffer.concat(buffers);
  const baseColor = options.baseColor ?? [1, 1, 1, 1];
  const material = {
    name: options.materialName,
    doubleSided: options.doubleSided ?? false,
    pbrMetallicRoughness: {
      baseColorFactor: baseColor,
      roughnessFactor: options.roughness ?? 0.9,
      metallicFactor: 0,
    },
  };
  if (options.alphaMode) {
    material.alphaMode = options.alphaMode;
  } else if (baseColor[3] < 1) {
    material.alphaMode = 'BLEND';
  }
  const json = {
    asset: { version: '2.0', generator: 'BlockKart primitive mesh tool' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: options.nodeName }],
    meshes: [
      {
        name: options.nodeName,
        primitives: [
          {
            attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor, COLOR_0: colorAccessor },
            indices: indexAccessor,
            material: 0,
          },
        ],
      },
    ],
    materials: [material],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad4(bin, 0);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  return Buffer.concat([header, glbChunk(jsonChunk, 0x4e4f534a), glbChunk(binChunk, 0x004e4942)]);
}

function positionBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }
  return { min, max };
}

function makeHeightGridBinary(size) {
  const headerBytes = 40;
  const out = Buffer.alloc(headerBytes + size * size * 4);
  out.writeUInt32LE(0x3147544d, 0);
  out.writeUInt32LE(1, 4);
  out.writeUInt32LE(size, 8);
  out.writeUInt32LE(size, 12);
  out.writeFloatLE(0, 16);
  out.writeFloatLE(0, 20);
  out.writeFloatLE(0, 24);
  out.writeFloatLE(terrainWidth, 28);
  out.writeFloatLE(terrainDepth, 32);
  out.writeUInt32LE(0, 36);
  let offset = headerBytes;
  for (let row = 0; row < size; row++) {
    const z = (row / (size - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < size; col++) {
      const x = (col / (size - 1) - 0.5) * terrainWidth;
      out.writeFloatLE(visualTerrainWorldY(x, z), offset);
      offset += 4;
    }
  }
  return out;
}

function pad4(buffer, fill) {
  const pad = (4 - (buffer.length % 4)) % 4;
  return pad === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(pad, fill)]);
}

function glbChunk(data, type) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
}

function encodePngGray16(width, height, pixels) {
  const rowBytes = width * 2;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (rowBytes + 1)] = 0;
    pixels.copy(raw, row * (rowBytes + 1) + 1, row * rowBytes, (row + 1) * rowBytes);
  }
  return encodePng(width, height, 16, 0, raw);
}

function encodePngRgba(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    const rowStart = row * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, row * width * 4, (row + 1) * width * 4);
  }
  return encodePng(width, height, 8, 6, raw);
}

function encodePng(width, height, bitDepth, colorType, raw) {
  const chunks = [
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([bitDepth, colorType, 0, 0, 0])])),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function staticMapMesh({ name, model, material, cullDistance = 1400, cullRadius = 900 }) {
  const mesh = {
    name,
    model,
    collision: 'none',
  };
  if (material) {
    mesh.material = material;
  }
  mesh.pickMode = 'disabled';
  mesh.cullDistance = cullDistance;
  mesh.cullRadius = cullRadius;
  mesh.frustumCull = true;
  return mesh;
}

function makePrimitiveMapAsset() {
  return {
    version: 1,
    name: 'blockkart_primitive_track',
    meshes: [
      staticMapMesh({
        name: 'road_asphalt',
        model: 'road_asphalt.glb',
        material: {
          baseColor: { r: 0.05098, g: 0.06275, b: 0.06667, a: 1.0 },
          baseColorSet: true,
          roughness: 0.90,
          uvScale: 8.4,
          detailStrength: 0.92,
          macroBlend: 0.08,
          roughnessResponse: 0.54,
          toonRampResponse: 0.04,
        },
      }),
      staticMapMesh({
        name: 'road_shoulders',
        model: 'road_shoulders.glb',
        material: {
          baseColor: { r: 0.58, g: 0.42, b: 0.23, a: 1.0 },
          baseColorSet: true,
          roughness: 0.98,
          uvScale: 7.4,
          detailStrength: 1.62,
          macroBlend: 0.34,
          roughnessResponse: 0.90,
          toonRampResponse: 0.10,
        },
      }),
      staticMapMesh({ name: 'road_curbs', model: 'road_curbs.glb' }),
      staticMapMesh({ name: 'road_edge_lines', model: 'road_edge_lines.glb' }),
      staticMapMesh({ name: 'road_center_dashes', model: 'road_center_dashes.glb' }),
      staticMapMesh({ name: 'road_tire_grime', model: 'road_tire_grime.glb' }),
      staticMapMesh({
        name: 'hero_creek',
        model: 'hero_creek_ribbon.glb',
        material: {
          baseColor: { r: 0.13725, g: 0.62353, b: 0.87843, a: 0.82 },
          baseColorSet: true,
          roughness: 0.22,
          uvScale: 1.0,
        },
        cullDistance: 1200,
        cullRadius: 650,
      }),
    ],
    meshTerrains: [
      {
        name: 'lowpoly_terrain',
        model: 'lowpoly_terrain.glb',
        lodLevels: [{ model: 'lowpoly_terrain_lod.glb', distance: 460 }],
        heightGrid: 'lowpoly_terrain_height_grid.bin',
        splat: {
          control: 'terrain_splat_large.png',
          layers: [
            { texture: 'grass_texture.png', normal: 'grass_normal.png', metallicRoughness: 'grass_mr.png', uvScale: 7.8, normalScale: 0.24 },
            { texture: 'meadow_texture.png', normal: 'meadow_normal.png', metallicRoughness: 'meadow_mr.png', uvScale: 6.8, normalScale: 0.22 },
            { texture: 'dirt_texture.png', normal: 'dirt_normal.png', metallicRoughness: 'dirt_mr.png', uvScale: 5.2, normalScale: 0.16 },
            { texture: 'rock_texture.png', normal: 'rock_normal.png', metallicRoughness: 'rock_mr.png', uvScale: 4.2, normalScale: 0.30 },
          ],
          tuning: {
            macroScale: 0.84,
            macroStrength: 0.38,
            detailNear: 115,
            detailFar: 620,
            slopeStart: 0.16,
            slopeEnd: 0.58,
            slopeDirtStrength: 0.30,
            slopeRockStrength: 0.52,
            antiTileStrength: 0.55,
            detailStrength: 0.82,
            normalNear: 110,
            normalFar: 560,
            heightBlendStrength: 0.10,
            heightLow: -3.0,
            heightHigh: 24.0,
            curvatureStrength: 0.18,
          },
        },
        material: {
          roughness: 0.92,
          uvScale: 1.0,
          detailStrength: 1.08,
          macroBlend: 0.08,
          roughnessResponse: 0.88,
          toonRampResponse: 0.18,
        },
        tag: 'primitive_lowpoly_terrain',
        cullDistance: 1500,
        cullRadius: 900,
        frustumCull: true,
      },
    ],
    primitiveLayers: [
      {
        name: 'roadside_meadow',
        source: 'roadside_primitives.bin',
        kind: 'static',
        chunkCellSize: roadsidePrimitiveChunkCellSize,
        preloadChunks: true,
        slots: [
          'grass_card',
          'dirt_stroke',
          'pale_stone',
          'pebble',
          'stone',
          'flower_stem',
          'flower_yellow',
          'flower_white',
        ],
      },
    ],
  };
}

const heightmapPath = join(outDir, 'heightmap_large.png');
const splatPath = join(outDir, 'terrain_splat_large.png');
const lowpolyTerrainPath = join(outDir, 'lowpoly_terrain.glb');
const lowpolyTerrainLodPath = join(outDir, 'lowpoly_terrain_lod.glb');
const heightGridPath = join(outDir, 'lowpoly_terrain_height_grid.bin');
const roadsidePrimitivePath = join(outDir, 'roadside_primitives.bin');
const mapAssetPath = join(outDir, 'blockkart.map.json');
const roadAssetPaths = {
  roadAsphalt: join(outDir, 'road_asphalt.glb'),
  roadShoulders: join(outDir, 'road_shoulders.glb'),
  roadCurbs: join(outDir, 'road_curbs.glb'),
  roadEdgeLines: join(outDir, 'road_edge_lines.glb'),
  roadCenterDashes: join(outDir, 'road_center_dashes.glb'),
  roadTireGrime: join(outDir, 'road_tire_grime.glb'),
  roadEdgeGrime: join(outDir, 'road_edge_grime.glb'),
  heroCreek: join(outDir, 'hero_creek_ribbon.glb'),
};
const lowpolyMesh = buildLowpolyTerrainMesh(lowpolyTerrainSegments);
const lowpolyLodMesh = buildLowpolyTerrainMesh(lowpolyTerrainLodSegments);
validateTerrainMeshRoadKeepout(lowpolyMesh, 'lowpoly_terrain');
validateTerrainMeshRoadKeepout(lowpolyLodMesh, 'lowpoly_terrain_lod');
const primitiveTrackMeshes = buildPrimitiveTrackMeshAssets();
const bakedRoadsidePrimitives = makeBakedRoadsidePrimitiveLayer();
requireBakedEffectTextures();
writeTerrainMaterialTextures();
writeFileSync(heightmapPath, makeHeightmap());
writeFileSync(splatPath, makeTerrainSplat());
writeFileSync(lowpolyTerrainPath, makeLowpolyTerrainGlb(lowpolyMesh));
writeFileSync(lowpolyTerrainLodPath, makeLowpolyTerrainGlb(lowpolyLodMesh));
writeFileSync(heightGridPath, makeHeightGridBinary(heightGridSize));
writeFileSync(roadsidePrimitivePath, bakedRoadsidePrimitives.buffer);
writeFileSync(roadAssetPaths.roadAsphalt, makeStaticMeshGlb(primitiveTrackMeshes.roadAsphalt, { nodeName: 'primitive_road_asphalt', materialName: 'primitive_road_asphalt_white', roughness: 0.82 }));
writeFileSync(roadAssetPaths.roadShoulders, makeStaticMeshGlb(primitiveTrackMeshes.roadShoulders, { nodeName: 'primitive_road_shoulders', materialName: 'primitive_road_shoulders_dirt', baseColor: [0.58, 0.42, 0.23, 1], roughness: 0.96 }));
writeFileSync(roadAssetPaths.roadCurbs, makeStaticMeshGlb(primitiveTrackMeshes.roadCurbs, { nodeName: 'primitive_road_curbs', materialName: 'primitive_road_curbs_vertex', roughness: 0.72 }));
writeFileSync(roadAssetPaths.roadEdgeLines, makeStaticMeshGlb(primitiveTrackMeshes.roadEdgeLines, { nodeName: 'primitive_road_edge_lines', materialName: 'primitive_road_edge_lines_white', roughness: 0.64, doubleSided: true }));
writeFileSync(roadAssetPaths.roadCenterDashes, makeStaticMeshGlb(primitiveTrackMeshes.roadCenterDashes, { nodeName: 'primitive_road_center_dashes', materialName: 'primitive_road_center_dashes_white', roughness: 0.64 }));
writeFileSync(roadAssetPaths.roadTireGrime, makeStaticMeshGlb(primitiveTrackMeshes.roadTireGrime, { nodeName: 'primitive_road_tire_grime', materialName: 'primitive_road_tire_grime_alpha', roughness: 0.99, doubleSided: true, alphaMode: 'BLEND' }));
writeFileSync(roadAssetPaths.roadEdgeGrime, makeStaticMeshGlb(primitiveTrackMeshes.roadEdgeGrime, { nodeName: 'primitive_road_edge_grime', materialName: 'primitive_road_edge_grime_alpha', roughness: 0.99, doubleSided: true, alphaMode: 'BLEND' }));
writeFileSync(roadAssetPaths.heroCreek, makeStaticMeshGlb(primitiveTrackMeshes.heroCreek, { nodeName: 'primitive_hero_creek_ribbon', materialName: 'primitive_hero_creek_white', baseColor: [1, 1, 1, 0.82], roughness: 0.22, doubleSided: true, alphaMode: 'BLEND' }));
writeFileSync(mapAssetPath, `${JSON.stringify(makePrimitiveMapAsset(), null, 2)}\n`);
console.log(`${outDir}/terrain material textures (${terrainMaterialTextureSize}x${terrainMaterialTextureSize})`);
console.log(`${heightmapPath} (${outputHeightmapSize}x${outputHeightmapSize})`);
console.log(`${splatPath} (${outputSplatSize}x${outputSplatSize})`);
console.log(`${lowpolyTerrainPath} (${lowpolyMesh.indices.length / 3} tris)`);
console.log(`${lowpolyTerrainLodPath} (${lowpolyLodMesh.indices.length / 3} tris)`);
console.log(`${heightGridPath} (${heightGridSize}x${heightGridSize})`);
console.log(`${roadsidePrimitivePath} (${bakedRoadsidePrimitives.count} baked instances)`);
console.log(`${mapAssetPath} (map manifest)`);
console.log(`${outDir}/road static meshes (${primitiveTrackVisualSampleCount()} samples)`);
