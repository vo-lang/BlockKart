import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'docs', 'images');
mkdirSync(outDir, { recursive: true });

const mapScale = 2.45;
const terrainWidth = 360 * mapScale;
const terrainDepth = 360 * mapScale;
const trackWidth = 17.5;
const samples = 360;
const trackPointCount = 24;
const svgWidth = 1400;
const svgHeight = 980;
const margin = 54;
const mapW = svgWidth - margin * 2;
const mapH = svgHeight - margin * 2;

function baseTrackPoint(i) {
  const t = i / trackPointCount;
  const a = t * Math.PI * 2;
  const rx = mapScale * (86 + 12 * Math.sin(a * 3 + 0.35));
  const rz = mapScale * (66 + 9 * Math.cos(a * 2 - 0.2));
  return {
    x: Math.sin(a) * rx,
    y: 0.45 * Math.sin(a * 2 + 0.4),
    z: Math.cos(a) * rz,
  };
}

function straightenSpawnRun(points) {
  const entry = points[10];
  const anchor = points[11];
  const dx = anchor.x - entry.x;
  const dz = anchor.z - entry.z;
  const len = Math.max(0.0001, Math.hypot(dx, dz));
  points[12] = {
    x: anchor.x + (dx / len) * 62,
    y: anchor.y,
    z: anchor.z + (dz / len) * 62,
  };
}

const trackPoints = Array.from({ length: trackPointCount }, (_, i) => baseTrackPoint(i));
straightenSpawnRun(trackPoints);
const trackSegments = trackPoints.map((point, i) => {
  const next = trackPoints[(i + 1) % trackPoints.length];
  return Math.hypot(next.x - point.x, next.z - point.z);
});
const trackLength = trackSegments.reduce((sum, length) => sum + length, 0);
const spawnDistance = trackLength * 0.44;
const heroStart = spawnDistance + trackLength * 0.01;
const heroEnd = spawnDistance + trackLength * 0.19;
const heroCenter = spawnDistance + trackLength * 0.09;

function sampleTrack(distance) {
  let d = ((distance % trackLength) + trackLength) % trackLength;
  for (let i = 0; i < trackPoints.length; i++) {
    const segLen = trackSegments[i];
    if (d > segLen) {
      d -= segLen;
      continue;
    }
    const point = trackPoints[i];
    const next = trackPoints[(i + 1) % trackPoints.length];
    const t = segLen > 0 ? d / segLen : 0;
    return {
      x: mix(point.x, next.x, t),
      y: mix(point.y, next.y, t),
      z: mix(point.z, next.z, t),
      distance,
    };
  }
  return { ...trackPoints[0], distance };
}

function trackFrameAt(distance) {
  const center = sampleTrack(distance);
  const prev = sampleTrack(distance - 4);
  const next = sampleTrack(distance + 4);
  const fx = next.x - prev.x;
  const fz = next.z - prev.z;
  const fl = Math.max(0.0001, Math.hypot(fx, fz));
  const forward = { x: fx / fl, z: fz / fl };
  const right = { x: forward.z, z: -forward.x };
  return { center, forward, right };
}

function offsetTrackPoint(distance, lateral) {
  const frame = trackFrameAt(distance);
  return {
    x: frame.center.x + frame.right.x * lateral,
    z: frame.center.z + frame.right.z * lateral,
    forward: frame.forward,
    right: frame.right,
  };
}

const centerline = Array.from({ length: samples }, (_, i) => {
  const d = (i / samples) * trackLength;
  return sampleTrack(d);
});

function nearestRoad(x, z) {
  let best = centerline[0];
  let bestIndex = 0;
  let bestD = Infinity;
  for (let i = 0; i < centerline.length; i++) {
    const p = centerline[i];
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < bestD) {
      best = p;
      bestD = d;
      bestIndex = i;
    }
  }
  const prev = centerline[(bestIndex + centerline.length - 1) % centerline.length];
  const next = centerline[(bestIndex + 1) % centerline.length];
  const fx = next.x - prev.x;
  const fz = next.z - prev.z;
  const fl = Math.max(0.0001, Math.hypot(fx, fz));
  const right = { x: fz / fl, z: -fx / fl };
  const signedLateral = (x - best.x) * right.x + (z - best.z) * right.z;
  return { point: best, distance: bestD, trackDistance: best.distance, signedLateral };
}

function mix(a, b, t) {
  return a * (1 - t) + b * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function cyclicDistance(a, b, length) {
  const d = Math.abs((((a - b) % length) + length) % length);
  return Math.min(d, length - d);
}

function bell(center, radius, x) {
  const d = (x - center) / Math.max(0.0001, radius);
  return Math.exp(-d * d);
}

function radialBell(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / Math.max(0.0001, rx);
  const dz = (z - cz) / Math.max(0.0001, rz);
  return Math.exp(-(dx * dx + dz * dz));
}

function orientedBell(x, z, feature) {
  const dx = x - feature.x;
  const dz = z - feature.z;
  const along = dx * feature.forward.x + dz * feature.forward.z;
  const across = dx * feature.right.x + dz * feature.right.z;
  const alongN = along / Math.max(0.0001, feature.length);
  const acrossN = across / Math.max(0.0001, feature.width);
  return Math.exp(-(alongN * alongN + acrossN * acrossN));
}

function targetHeight(x, z) {
  const nearest = nearestRoad(x, z);
  const edgeDistance = Math.max(0, nearest.distance - trackWidth * 0.5);
  const hero = 1 - smoothstep(trackLength * 0.12, trackLength * 0.2, cyclicDistance(nearest.trackDistance, heroCenter, trackLength));
  const side = nearest.signedLateral >= 0 ? 1 : -1;

  const roadCut = -1.25 * (1 - smoothstep(trackWidth * 0.5, trackWidth * 0.5 + 11, nearest.distance));
  const shoulderDitch = -0.75 * bell(10, 5.8, edgeDistance) * (0.65 + hero * 0.35);
  const cutBank = (1.25 + hero * 2.15) * bell(20, 8.2, edgeDistance);
  const nearHill = (0.75 + hero * (side > 0 ? 2.25 : 1.55)) * bell(54, 24, edgeDistance);
  const outerHill = (0.65 + hero * 1.45) * bell(92, 38, edgeDistance);

  const leftCreekA = offsetTrackPoint(spawnDistance + trackLength * 0.04, -42);
  const leftCreekB = offsetTrackPoint(spawnDistance + trackLength * 0.12, -46);
  const rightHill = offsetTrackPoint(spawnDistance + trackLength * 0.12, 72);
  const leftHill = offsetTrackPoint(spawnDistance + trackLength * 0.08, -78);
  const overlook = offsetTrackPoint(spawnDistance + trackLength * 0.15, 48);
  const farRidge = offsetTrackPoint(spawnDistance + trackLength * 0.2, 112);

  const creek =
    -1.25 * orientedBell(x, z, { ...leftCreekA, length: 92, width: 15 }) -
    0.95 * orientedBell(x, z, { ...leftCreekB, length: 86, width: 15 });
  const heroRightHill = 4.7 * orientedBell(x, z, { ...rightHill, length: 118, width: 62 });
  const heroLeftHill = 3.6 * orientedBell(x, z, { ...leftHill, length: 112, width: 54 });
  const overlookMound = 3.1 * radialBell(x, z, overlook.x, overlook.z, 42, 32);
  const farRollingRidge = 2.8 * orientedBell(x, z, { ...farRidge, length: 168, width: 78 });

  const broad =
    1.8 * radialBell(x, z, -112 * mapScale, -96 * mapScale, 82 * mapScale, 58 * mapScale) +
    1.6 * radialBell(x, z, 98 * mapScale, -86 * mapScale, 78 * mapScale, 62 * mapScale) +
    1.35 * radialBell(x, z, -118 * mapScale, 72 * mapScale, 72 * mapScale, 78 * mapScale) +
    1.45 * radialBell(x, z, 52 * mapScale, 116 * mapScale, 92 * mapScale, 70 * mapScale);
  const valley =
    -0.95 * radialBell(x, z, -34 * mapScale, -4 * mapScale, 56 * mapScale, 88 * mapScale) -
    0.65 * radialBell(x, z, 88 * mapScale, 32 * mapScale, 58 * mapScale, 72 * mapScale);
  const horizon =
    1.25 * smoothstep(84 * mapScale, 178 * mapScale, Math.abs(z + 142 * mapScale)) +
    0.9 * smoothstep(120 * mapScale, 180 * mapScale, Math.abs(x));
  const facet = 0.25 * Math.sin((x + z * 0.34) / (34 * mapScale)) + 0.18 * Math.cos((x * 0.2 - z) / (38 * mapScale));

  return roadCut + shoulderDitch + cutBank + nearHill + outerHill + creek + heroRightHill + heroLeftHill + overlookMound + farRollingRidge + broad + valley + horizon + facet;
}

function worldToSvg(x, z) {
  const sx = margin + ((x + terrainWidth * 0.5) / terrainWidth) * mapW;
  const sy = margin + ((z + terrainDepth * 0.5) / terrainDepth) * mapH;
  return { x: sx, y: sy };
}

function polyline(points) {
  return points.map((p) => {
    const s = worldToSvg(p.x, p.z);
    return `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
  }).join(' ');
}

function trackPolyline(start = 0, end = trackLength, count = 260, lateral = 0) {
  const points = [];
  const span = end - start;
  for (let i = 0; i <= count; i++) {
    const d = start + (i / count) * span;
    const p = lateral === 0 ? sampleTrack(d) : offsetTrackPoint(d, lateral);
    points.push({ x: p.x, z: p.z });
  }
  return points;
}

function contourSegments(levels) {
  const cols = 156;
  const rows = 156;
  const xs = Array.from({ length: cols }, (_, c) => -terrainWidth * 0.5 + (c / (cols - 1)) * terrainWidth);
  const zs = Array.from({ length: rows }, (_, r) => -terrainDepth * 0.5 + (r / (rows - 1)) * terrainDepth);
  const heights = zs.map((z) => xs.map((x) => targetHeight(x, z)));
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
        for (const [a, b] of [[p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]]]) {
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

function text(x, y, value, size = 22, fill = '#1b2b22') {
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}" font-weight="700">${value}</text>`;
}

function labelWorld(x, z, value, size = 18, fill = '#26362d') {
  const p = worldToSvg(x, z);
  return `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}" font-weight="700">${value}</text>`;
}

function lineWorld(a, b, color = '#26362d') {
  const p0 = worldToSvg(a.x, a.z);
  const p1 = worldToSvg(b.x, b.z);
  return `<line x1="${p0.x.toFixed(1)}" y1="${p0.y.toFixed(1)}" x2="${p1.x.toFixed(1)}" y2="${p1.y.toFixed(1)}" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="7 7"/>`;
}

const levels = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7];
const segments = contourSegments(levels);
const contourSvg = [];
for (const level of levels) {
  const major = level % 2 === 0;
  const color = level < 0 ? '#2575a8' : level >= 5 ? '#8a4f24' : '#446b42';
  for (const segment of segments.get(level)) {
    const a = worldToSvg(segment[0].x, segment[0].z);
    const b = worldToSvg(segment[1].x, segment[1].z);
    contourSvg.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-opacity="${major ? 0.84 : 0.54}" stroke-width="${major ? 1.7 : 1.0}" stroke-linecap="round"/>`);
  }
}

const road = trackPolyline(0, trackLength, 420);
const heroRoad = trackPolyline(heroStart, heroEnd, 96);
const creek = trackPolyline(heroStart + trackLength * 0.01, heroEnd - trackLength * 0.02, 64, -42);
const leftBank = offsetTrackPoint(spawnDistance + trackLength * 0.075, -76);
const rightHill = offsetTrackPoint(spawnDistance + trackLength * 0.12, 72);
const overlook = offsetTrackPoint(spawnDistance + trackLength * 0.15, 48);
const roadCut = offsetTrackPoint(spawnDistance + trackLength * 0.055, 0);
const farRidge = offsetTrackPoint(spawnDistance + trackLength * 0.2, 112);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="#edf3df"/>
  <rect x="${margin}" y="${margin}" width="${mapW}" height="${mapH}" rx="16" fill="#dfe9cf" stroke="#8ba075" stroke-width="3"/>
  <g opacity="0.55">
    <circle cx="${worldToSvg(rightHill.x, rightHill.z).x.toFixed(1)}" cy="${worldToSvg(rightHill.x, rightHill.z).y.toFixed(1)}" r="142" fill="#c7d48f"/>
    <circle cx="${worldToSvg(leftBank.x, leftBank.z).x.toFixed(1)}" cy="${worldToSvg(leftBank.x, leftBank.z).y.toFixed(1)}" r="126" fill="#c7d48f"/>
    <circle cx="${worldToSvg(overlook.x, overlook.z).x.toFixed(1)}" cy="${worldToSvg(overlook.x, overlook.z).y.toFixed(1)}" r="84" fill="#d8bd82"/>
  </g>
  <g>${contourSvg.join('\n    ')}</g>
  <polyline points="${polyline(road)}" fill="none" stroke="#211d1b" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(road)}" fill="none" stroke="#f3ead6" stroke-width="52" stroke-opacity="0.45" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(road)}" fill="none" stroke="#1b1d20" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(heroRoad)}" fill="none" stroke="#ffcf5a" stroke-width="10" stroke-opacity="0.96" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${polyline(creek)}" fill="none" stroke="#1d9ee6" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="18 10"/>
  ${lineWorld({ x: roadCut.x, z: roadCut.z - 18 }, roadCut, '#3d3d34')}
  ${lineWorld({ x: rightHill.x + 24, z: rightHill.z - 30 }, rightHill, '#70401e')}
  ${lineWorld({ x: leftBank.x - 34, z: leftBank.z + 30 }, leftBank, '#70401e')}
  ${lineWorld({ x: overlook.x + 56, z: overlook.z + 22 }, overlook, '#70401e')}
  ${lineWorld({ x: farRidge.x + 78, z: farRidge.z - 34 }, farRidge, '#70401e')}
  ${labelWorld(roadCut.x, roadCut.z - 22, '路堑 / road cut -1m', 20)}
  ${labelWorld(rightHill.x + 28, rightHill.z - 34, '右侧主丘 +6m', 20)}
  ${labelWorld(leftBank.x - 190, leftBank.z + 34, '左侧切坡 +4m', 20)}
  ${labelWorld(overlook.x + 60, overlook.z + 26, '台地 / overlook +5m', 20)}
  ${labelWorld(farRidge.x + 82, farRidge.z - 40, '远景滚坡 +4m', 20)}
  ${labelWorld(creek[30].x - 82, creek[30].z + 12, '沟谷 / creek -2m', 20, '#11679d')}
  ${text(68, 38, 'BlockKart Terrain Elevation Concept V1', 28)}
  ${text(68, 70, '目标：先按概念图雕出路堑、丘陵、沟谷、台地，再由 heightmap 拟合', 18, '#445342')}
  <g transform="translate(1040 70)">
    <rect x="0" y="0" width="285" height="170" rx="12" fill="#ffffff" fill-opacity="0.72" stroke="#8ba075"/>
    ${text(18, 34, '等高线', 20)}
    <line x1="20" y1="58" x2="72" y2="58" stroke="#2575a8" stroke-width="3"/>
    ${text(86, 64, '-2 / -1 沟谷', 15, '#11679d')}
    <line x1="20" y1="88" x2="72" y2="88" stroke="#446b42" stroke-width="3"/>
    ${text(86, 94, '0 / 1 / 2 草坡', 15, '#344d32')}
    <line x1="20" y1="118" x2="72" y2="118" stroke="#8a4f24" stroke-width="3"/>
    ${text(86, 124, '5 / 6 / 7 丘顶', 15, '#70401e')}
    <line x1="20" y1="148" x2="72" y2="148" stroke="#ffcf5a" stroke-width="6"/>
    ${text(86, 154, '第一验收段', 15, '#57430b')}
  </g>
</svg>
`;

writeFileSync(join(outDir, 'terrain-elevation-concept-v1.svg'), svg);
console.log(join(outDir, 'terrain-elevation-concept-v1.svg'));
