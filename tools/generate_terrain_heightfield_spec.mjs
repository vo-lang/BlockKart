import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  clamp,
  contourLevels,
  heightmapSize,
  heightfieldSpec,
  heroSegmentEnd,
  heroSegmentStart,
  mix,
  offsetTrackPoint,
  sampleTrack,
  spawnDistance,
  targetTerrainWorldY,
  terrainDepth,
  terrainHeight,
  terrainWidth,
  terrainY,
  trackLength,
  trackWidth,
} from './terrain_heightfield_spec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docsDir = join(root, 'docs');
const imageDir = join(docsDir, 'images');
mkdirSync(imageDir, { recursive: true });

const previewWidth = 1400;
const previewHeight = 980;
const margin = 54;
const mapW = previewWidth - margin * 2;
const mapH = previewHeight - margin * 2;

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

const contourGrid = envInt('TERRAIN_CONTOUR_GRID', 176);
const previewHeightmapSize = envInt('TERRAIN_PREVIEW_HEIGHTMAP_SIZE', heightmapSize);

function worldToSvg(x, z) {
  return {
    x: margin + ((x + terrainWidth * 0.5) / terrainWidth) * mapW,
    y: margin + ((z + terrainDepth * 0.5) / terrainDepth) * mapH,
  };
}

function heightColor(y) {
  const t = clamp((y - terrainY) / terrainHeight, 0, 1);
  if (t < 0.18) return '#5ea4cf';
  if (t < 0.34) return '#9fca74';
  if (t < 0.52) return '#c5d77b';
  if (t < 0.7) return '#cbb06d';
  return '#a6724b';
}

function trackPolyline(start = 0, end = trackLength, count = 420, lateral = 0) {
  const points = [];
  const span = end - start;
  for (let i = 0; i <= count; i++) {
    const d = start + (i / count) * span;
    const p = lateral === 0 ? sampleTrack(d) : offsetTrackPoint(d, lateral);
    points.push({ x: p.x, z: p.z });
  }
  return points;
}

function polyline(points) {
  return points
    .map((p) => {
      const s = worldToSvg(p.x, p.z);
      return `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
    })
    .join(' ');
}

function contourSegments(levels) {
  const cols = contourGrid;
  const rows = contourGrid;
  const xs = Array.from({ length: cols }, (_, c) => -terrainWidth * 0.5 + (c / (cols - 1)) * terrainWidth);
  const zs = Array.from({ length: rows }, (_, r) => -terrainDepth * 0.5 + (r / (rows - 1)) * terrainDepth);
  const heights = zs.map((z) => xs.map((x) => targetTerrainWorldY(x, z)));
  const byLevel = new Map(levels.map((level) => [level, []]));

  function edgePoint(a, b, level) {
    const t = clamp((level - a.h) / Math.max(0.0001, b.h - a.h), 0, 1);
    return { x: mix(a.x, b.x, t), z: mix(a.z, b.z, t) };
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p = [
        { x: xs[c], z: zs[r], h: heights[r][c] },
        { x: xs[c + 1], z: zs[r], h: heights[r][c + 1] },
        { x: xs[c + 1], z: zs[r + 1], h: heights[r + 1][c + 1] },
        { x: xs[c], z: zs[r + 1], h: heights[r + 1][c] },
      ];
      for (const level of levels) {
        const intersections = [];
        for (const [a, b] of [
          [p[0], p[1]],
          [p[1], p[2]],
          [p[2], p[3]],
          [p[3], p[0]],
        ]) {
          if ((a.h < level && b.h >= level) || (b.h < level && a.h >= level)) {
            intersections.push(edgePoint(a, b, level));
          }
        }
        if (intersections.length === 2) {
          byLevel.get(level).push(intersections);
        } else if (intersections.length === 4) {
          byLevel.get(level).push([intersections[0], intersections[1]]);
          byLevel.get(level).push([intersections[2], intersections[3]]);
        }
      }
    }
  }

  return byLevel;
}

function makeHeightmapPng() {
  const pixels = Buffer.alloc(previewHeightmapSize * previewHeightmapSize);
  for (let row = 0; row < previewHeightmapSize; row++) {
    const z = (row / (previewHeightmapSize - 1) - 0.5) * terrainDepth;
    for (let col = 0; col < previewHeightmapSize; col++) {
      const x = (col / (previewHeightmapSize - 1) - 0.5) * terrainWidth;
      const y = targetTerrainWorldY(x, z);
      pixels[row * previewHeightmapSize + col] = Math.round(clamp((y - terrainY) / terrainHeight, 0, 1) * 255);
    }
  }
  return encodePngGray(previewHeightmapSize, previewHeightmapSize, pixels);
}

function makeSvg() {
  const spec = heightfieldSpec();
  const contours = contourSegments(contourLevels);
  const contourSvg = [];
  for (const level of contourLevels) {
    const major = level % 2 === 0;
    const color = level < 0 ? '#2379ad' : level >= 5 ? '#8a4f24' : '#3d693d';
    for (const segment of contours.get(level)) {
      const a = worldToSvg(segment[0].x, segment[0].z);
      const b = worldToSvg(segment[1].x, segment[1].z);
      contourSvg.push(
        `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-opacity="${major ? 0.9 : 0.55}" stroke-width="${major ? 1.7 : 1.0}" stroke-linecap="round"/>`,
      );
    }
  }

  const reliefCells = [];
  const reliefCols = 70;
  const reliefRows = 50;
  const cellW = mapW / reliefCols;
  const cellH = mapH / reliefRows;
  for (let r = 0; r < reliefRows; r++) {
    const z = -terrainDepth * 0.5 + ((r + 0.5) / reliefRows) * terrainDepth;
    for (let c = 0; c < reliefCols; c++) {
      const x = -terrainWidth * 0.5 + ((c + 0.5) / reliefCols) * terrainWidth;
      const p = worldToSvg(x, z);
      reliefCells.push(
        `<rect x="${(p.x - cellW * 0.5).toFixed(1)}" y="${(p.y - cellH * 0.5).toFixed(1)}" width="${(cellW + 0.3).toFixed(1)}" height="${(cellH + 0.3).toFixed(1)}" fill="${heightColor(targetTerrainWorldY(x, z))}" opacity="0.42"/>`,
      );
    }
  }

  const road = trackPolyline();
  const heroRoad = trackPolyline(heroSegmentStart, heroSegmentEnd, 110);
  const creek = trackPolyline(heroSegmentStart + trackLength * 0.01, heroSegmentEnd - trackLength * 0.03, 76, -43);

  function text(x, y, value, size = 22, fill = '#1b2b22') {
    return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}" font-weight="700">${value}</text>`;
  }

  function label(featureId, dx, dz, value, fill = '#1b2b22') {
    const feature = spec.features.find((item) => item.id === featureId);
    if (!feature) {
      return '';
    }
    const p = worldToSvg(feature.x + dx, feature.z + dz);
    return `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-family="Arial, sans-serif" font-size="18" fill="${fill}" font-weight="700">${value}</text>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${previewWidth}" height="${previewHeight}" viewBox="0 0 ${previewWidth} ${previewHeight}">
  <rect width="100%" height="100%" fill="#eef4df"/>
  <rect x="${margin}" y="${margin}" width="${mapW}" height="${mapH}" rx="16" fill="#dfe9cf" stroke="#8ba075" stroke-width="3"/>
  <g>${reliefCells.join('\n    ')}</g>
  <g>${contourSvg.join('\n    ')}</g>
  <polyline points="${polyline(road)}" fill="none" stroke="#f2e9d7" stroke-width="54" stroke-opacity="0.52" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(road)}" fill="none" stroke="#222326" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(heroRoad)}" fill="none" stroke="#ffcc4a" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(creek)}" fill="none" stroke="#1b9ee7" stroke-width="9" stroke-linecap="round" stroke-dasharray="18 10"/>
  ${label('central_ravine', -62, 10, 'central basin cut', '#11679d')}
  ${label('inner_left_mesa', -72, -26, 'inner mesa +13m')}
  ${label('left_outer_highland', -96, 18, 'left highland')}
  ${label('right_outer_highland', 28, -36, 'right highland')}
  ${label('far_back_ridge_left', -48, -36, 'far ridge')}
  ${text(68, 38, 'BlockKart Height Field Spec V2', 28)}
  ${text(68, 70, '真实高度场：颜色和等高线都来自同一个 targetTerrainWorldY(x,z)', 18, '#445342')}
  <g transform="translate(1030 70)">
    <rect x="0" y="0" width="300" height="196" rx="12" fill="#ffffff" fill-opacity="0.76" stroke="#8ba075"/>
    ${text(18, 34, 'Height Levels', 20)}
    <line x1="20" y1="60" x2="76" y2="60" stroke="#2379ad" stroke-width="3"/>
    ${text(92, 66, '-2 / -1 valley', 15, '#11679d')}
    <line x1="20" y1="92" x2="76" y2="92" stroke="#3d693d" stroke-width="3"/>
    ${text(92, 98, '0 / 1 / 2 slope', 15, '#344d32')}
    <line x1="20" y1="124" x2="76" y2="124" stroke="#8a4f24" stroke-width="3"/>
    ${text(92, 130, '5 / 6 / 7 hill', 15, '#70401e')}
    <line x1="20" y1="156" x2="76" y2="156" stroke="#ffcc4a" stroke-width="7"/>
    ${text(92, 162, 'first acceptance slice', 15, '#57430b')}
  </g>
</svg>`;
}

function encodePngGray(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    pixels.copy(raw, row * (width + 1) + 1, row * width, (row + 1) * width);
  }
  return encodePng(width, height, 0, raw);
}

function encodePng(width, height, colorType, raw) {
  const chunks = [
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, colorType, 0, 0, 0])])),
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

const specPath = join(docsDir, 'terrain-heightfield-spec-v1.json');
const heightmapPath = join(imageDir, 'terrain-heightmap-target-v1.png');
const svgPath = join(imageDir, 'terrain-heightfield-spec-v1.svg');

writeFileSync(specPath, `${JSON.stringify(heightfieldSpec(), null, 2)}\n`);
writeFileSync(heightmapPath, makeHeightmapPng());
writeFileSync(svgPath, makeSvg());

console.log(specPath);
console.log(heightmapPath);
console.log(svgPath);
