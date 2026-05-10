import { defaultTerrainRecipeRelativePath, terrainRecipe } from './terrain_recipe.mjs';

export const activeTerrainRecipe = terrainRecipe;
export const mapScale = terrainRecipe.terrain.mapScale;
export const landmarkScale = terrainRecipe.terrain.landmarkScale ?? 1;
export const terrainWidth = terrainRecipe.terrain.widthUnits * mapScale;
export const terrainDepth = terrainRecipe.terrain.depthUnits * mapScale;
export const terrainY = terrainRecipe.terrain.minY;
export const terrainHeight = terrainRecipe.terrain.height;
export const heightmapSize = terrainRecipe.terrain.heightmapSize;
export const splatSize = terrainRecipe.terrain.splatSize;
export const trackWidth = terrainRecipe.track.width;
export const trackClearance = terrainRecipe.track.clearance;
export const shoulderWidth = terrainRecipe.corridor.shoulderWidth;
export const terrainBlendWidth = terrainRecipe.corridor.terrainBlendWidth;
export const trackPointCount = terrainRecipe.track.controlPoints?.length ?? terrainRecipe.track.pointCount;
export const centerlineSampleCount = terrainRecipe.track.centerlineSampleCount;
export const contourLevels = terrainRecipe.contours?.levels ?? [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8];

export function mix(a, b, t) {
  return a * (1 - t) + b * t;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function bell(center, radius, x) {
  const d = (x - center) / Math.max(0.0001, radius);
  return Math.exp(-d * d);
}

export function radialBell(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / Math.max(0.0001, rx);
  const dz = (z - cz) / Math.max(0.0001, rz);
  return Math.exp(-(dx * dx + dz * dz));
}

export function orientedBell(x, z, feature) {
  const dx = x - feature.x;
  const dz = z - feature.z;
  const along = dx * feature.forward.x + dz * feature.forward.z;
  const across = dx * feature.right.x + dz * feature.right.z;
  const alongN = along / Math.max(0.0001, feature.length);
  const acrossN = across / Math.max(0.0001, feature.width);
  return Math.exp(-(alongN * alongN + acrossN * acrossN));
}

export function cyclicDistance(a, b, length) {
  const d = Math.abs((((a - b) % length) + length) % length);
  return Math.min(d, length - d);
}

export function noise2(x, y) {
  let n = (x * 374761393 + y * 668265263) >>> 0;
  n = ((n ^ (n >>> 13)) * 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) & 255) / 255;
}

export function blockNoise(x, z, size, salt = 0) {
  return noise2(Math.floor(x / size) + salt * 37, Math.floor(z / size) - salt * 53);
}

function terrainValueNoise(x, z, size, salt = 0) {
  const gx = x / Math.max(0.0001, size);
  const gz = z / Math.max(0.0001, size);
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const tx = smoothstep(0, 1, gx - ix);
  const tz = smoothstep(0, 1, gz - iz);
  const n00 = noise2(ix + salt * 37, iz - salt * 53);
  const n10 = noise2(ix + 1 + salt * 37, iz - salt * 53);
  const n01 = noise2(ix + salt * 37, iz + 1 - salt * 53);
  const n11 = noise2(ix + 1 + salt * 37, iz + 1 - salt * 53);
  return mix(mix(n00, n10, tx), mix(n01, n11, tx), tz);
}

export function baseTrackPoint(i) {
  if (Array.isArray(terrainRecipe.track.controlPoints)) {
    return trackPointFromControlPoint(terrainRecipe.track.controlPoints[i % terrainRecipe.track.controlPoints.length]);
  }
  const t = i / trackPointCount;
  const a = t * Math.PI * 2;
  const rxCfg = terrainRecipe.track.radiusX;
  const rzCfg = terrainRecipe.track.radiusZ;
  const heightCfg = terrainRecipe.track.height;
  const rx = mapScale * (rxCfg.base + rxCfg.sinAmplitude * Math.sin(a * rxCfg.sinFrequency + rxCfg.sinPhase));
  const rz = mapScale * (rzCfg.base + rzCfg.cosAmplitude * Math.cos(a * rzCfg.cosFrequency + rzCfg.cosPhase));
  return {
    x: Math.sin(a) * rx,
    y: heightCfg.amplitude * Math.sin(a * heightCfg.sinFrequency + heightCfg.sinPhase),
    z: Math.cos(a) * rz,
  };
}

function trackPointFromControlPoint(point) {
  const x = point.x ?? point.xMapScale * mapScale;
  const z = point.z ?? point.zMapScale * mapScale;
  return {
    x,
    y: point.y ?? 0,
    z,
    width: point.width ?? trackWidth,
    id: point.id,
  };
}

function catmullRom(a, b, c, d, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * b.x + (-a.x + c.x) * t + (2 * a.x - 5 * b.x + 4 * c.x - d.x) * t2 + (-a.x + 3 * b.x - 3 * c.x + d.x) * t3),
    y: 0.5 * (2 * b.y + (-a.y + c.y) * t + (2 * a.y - 5 * b.y + 4 * c.y - d.y) * t2 + (-a.y + 3 * b.y - 3 * c.y + d.y) * t3),
    z: 0.5 * (2 * b.z + (-a.z + c.z) * t + (2 * a.z - 5 * b.z + 4 * c.z - d.z) * t2 + (-a.z + 3 * b.z - 3 * c.z + d.z) * t3),
    width: 0.5 * (2 * b.width + (-a.width + c.width) * t + (2 * a.width - 5 * b.width + 4 * c.width - d.width) * t2 + (-a.width + 3 * b.width - 3 * c.width + d.width) * t3),
  };
}

function straightenSpawnRun(points) {
  const cfg = terrainRecipe.track.spawnStraighten;
  if (!cfg) {
    return;
  }
  const entry = points[cfg.entryIndex];
  const anchor = points[cfg.anchorIndex];
  const targetIndex = cfg.targetIndex ?? cfg.anchorIndex + 1;
  const dx = anchor.x - entry.x;
  const dz = anchor.z - entry.z;
  const len = Math.max(0.0001, Math.hypot(dx, dz));
  points[targetIndex] = {
    x: anchor.x + (dx / len) * cfg.length,
    y: anchor.y,
    z: anchor.z + (dz / len) * cfg.length,
  };
}

function buildTrackPoints() {
  if (Array.isArray(terrainRecipe.track.controlPoints)) {
    const anchors = terrainRecipe.track.controlPoints.map(trackPointFromControlPoint);
    const samplesPerSegment = terrainRecipe.track.samplesPerSegment ?? 12;
    const points = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[(i - 1 + anchors.length) % anchors.length];
      const b = anchors[i];
      const c = anchors[(i + 1) % anchors.length];
      const d = anchors[(i + 2) % anchors.length];
      for (let s = 0; s < samplesPerSegment; s++) {
        points.push(catmullRom(a, b, c, d, s / samplesPerSegment));
      }
    }
    return points;
  }
  const points = Array.from({ length: trackPointCount }, (_, i) => baseTrackPoint(i));
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 2 && Math.hypot(first.x - last.x, first.z - last.z) < 0.01) {
    points.pop();
  }
  straightenSpawnRun(points);
  return points;
}

export const trackPoints = buildTrackPoints();

export const trackSegments = trackPoints.map((point, i) => {
  const next = trackPoints[(i + 1) % trackPoints.length];
  return Math.hypot(next.x - point.x, next.z - point.z);
});
export const trackLength = trackSegments.reduce((sum, length) => sum + length, 0);
export const spawnDistance = trackLength * terrainRecipe.track.spawnDistanceFactor;
export const heroSegmentStart = spawnDistance + trackLength * terrainRecipe.heroSegment.startOffset;
export const heroSegmentEnd = spawnDistance + trackLength * terrainRecipe.heroSegment.endOffset;
export const heroSegmentCenter = spawnDistance + trackLength * terrainRecipe.heroSegment.centerOffset;

export function sampleTrack(distance) {
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
      distance: ((distance % trackLength) + trackLength) % trackLength,
    };
  }
  return { ...trackPoints[0], distance: 0 };
}

export function trackFrameAt(distance) {
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

export function offsetTrackPoint(distance, lateral) {
  const frame = trackFrameAt(distance);
  return {
    x: frame.center.x + frame.right.x * lateral,
    y: frame.center.y,
    z: frame.center.z + frame.right.z * lateral,
    forward: frame.forward,
    right: frame.right,
    distance: ((distance % trackLength) + trackLength) % trackLength,
    lateral,
  };
}

export const centerline = Array.from({ length: centerlineSampleCount }, (_, i) => {
  const d = (i / centerlineSampleCount) * trackLength;
  return sampleTrack(d);
});

export function nearestRoad(x, z) {
  let best = centerline[0];
  let bestIndex = 0;
  let bestD = Infinity;
  for (let i = 0; i < centerline.length; i++) {
    const point = centerline[i];
    const d = Math.hypot(x - point.x, z - point.z);
    if (d < bestD) {
      best = point;
      bestIndex = i;
      bestD = d;
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

export function terrainContext(x, z) {
  const nearest = nearestRoad(x, z);
  const halfTrack = trackWidth * 0.5;
  const edgeDistance = Math.max(0, nearest.distance - halfTrack);
  const heroMaskCfg = terrainRecipe.corridor.heroMask;
  const heroDistance = cyclicDistance(nearest.trackDistance, heroSegmentCenter, trackLength);
  const heroMask =
    1 - smoothstep(trackLength * heroMaskCfg.innerTrackLengthFactor, trackLength * heroMaskCfg.outerTrackLengthFactor, heroDistance);
  const heroSpanMask =
    smoothstep(
      heroSegmentStart + trackLength * heroMaskCfg.spanStartIn,
      heroSegmentStart + trackLength * heroMaskCfg.spanStartOut,
      nearest.trackDistance,
    ) *
    (1 -
      smoothstep(
        heroSegmentEnd + trackLength * heroMaskCfg.spanEndIn,
        heroSegmentEnd + trackLength * heroMaskCfg.spanEndOut,
        nearest.trackDistance,
      ));
  return { nearest, halfTrack, edgeDistance, heroMask, heroSpanMask };
}

function materializeFeatureScales(feature) {
  const out = { ...feature };
  if (out.x === undefined && out.xMapScale !== undefined) {
    out.x = out.xMapScale * mapScale;
  }
  if (out.z === undefined && out.zMapScale !== undefined) {
    out.z = out.zMapScale * mapScale;
  }
  if (out.radiusX === undefined && out.radiusXMapScale !== undefined) {
    out.radiusX = out.radiusXMapScale * mapScale;
  }
  if (out.radiusZ === undefined && out.radiusZMapScale !== undefined) {
    out.radiusZ = out.radiusZMapScale * mapScale;
  }
  if (out.length === undefined && out.lengthMapScale !== undefined) {
    out.length = out.lengthMapScale * mapScale;
  }
  if (out.width === undefined && out.widthMapScale !== undefined) {
    out.width = out.widthMapScale * mapScale;
  }
  return out;
}

export function elevationFeatureDefinitions() {
  return terrainRecipe.landforms.map(materializeFeatureScales);
}

export function resolvedElevationFeatures() {
  return elevationFeatureDefinitions().map((feature) => {
    if (feature.distanceOffset !== undefined) {
      const anchor = offsetTrackPoint(spawnDistance + trackLength * feature.distanceOffset, feature.lateral);
      return { ...feature, x: anchor.x, z: anchor.z, forward: anchor.forward, right: anchor.right, distance: anchor.distance };
    }
    if ((feature.kind === 'oriented_hill' || feature.kind === 'oriented_valley') && feature.forward === undefined) {
      const angle = ((feature.angleDeg ?? 0) * Math.PI) / 180;
      const forward = { x: Math.sin(angle), z: Math.cos(angle) };
      const right = { x: forward.z, z: -forward.x };
      return { ...feature, forward, right };
    }
    return feature;
  });
}

function featureHeight(feature, x, z) {
  if (feature.kind === 'oriented_hill' || feature.kind === 'oriented_valley') {
    return feature.height * orientedBell(x, z, feature);
  }
  if (feature.kind === 'radial_mound' || feature.kind === 'radial_valley') {
    return feature.height * radialBell(x, z, feature.x, feature.z, feature.radiusX, feature.radiusZ);
  }
  return 0;
}

function broadHorizonHeight(x, z) {
  const horizonCfg = terrainRecipe.horizon;
  const back = horizonCfg.back;
  const side = horizonCfg.side;
  const facet = horizonCfg.facet;
  const farFold = horizonCfg.farFold;
  const horizon =
    back.height * smoothstep(back.startMapScale * mapScale, back.endMapScale * mapScale, Math.abs(z + back.zOffsetMapScale * mapScale)) +
    side.height * smoothstep(side.startMapScale * mapScale, side.endMapScale * mapScale, Math.abs(x));
  const faceted =
    facet.sinAmplitude * Math.sin((x * facet.sinX + z * facet.sinZ) / (facet.sinWavelengthMapScale * mapScale)) +
    facet.cosAmplitude * Math.cos((x * facet.cosX + z * facet.cosZ) / (facet.cosWavelengthMapScale * mapScale));
  const fold =
    farFold.amplitude *
    Math.sin((x + farFold.xOffset) / (farFold.wavelengthMapScale * mapScale)) *
    smoothstep(farFold.fadeStartMapScale * mapScale, farFold.fadeEndMapScale * mapScale, Math.abs(z));
  return horizon + faceted + fold;
}

function macroTerrainHeight(ctx, x, z) {
  const macro = terrainRecipe.macroTerrain;
  if (!macro) {
    return 0;
  }
  let height = macro.baseLift ?? 0;

  const roadValley = macro.roadValley;
  if (roadValley) {
    const hero = Math.max(ctx.heroMask, ctx.heroSpanMask);
    const sideScale = ctx.nearest.signedLateral >= 0 ? (roadValley.rightScale ?? 1) : (roadValley.leftScale ?? 1);
    const rise = smoothstep(roadValley.riseStart, roadValley.risePeak, ctx.edgeDistance);
    const farBlend = smoothstep(roadValley.softFallStart, roadValley.softFallEnd, ctx.edgeDistance);
    const farScale = mix(1, roadValley.minimumFarScale ?? 0.55, farBlend);
    height += roadValley.height * sideScale * (1 + hero * (roadValley.heroBoost ?? 0)) * rise * farScale;
  }

  for (const wave of macro.rollingWaves ?? []) {
    const wavelength = Math.max(0.0001, wave.wavelengthMapScale * mapScale);
    const raw = 0.5 + 0.5 * Math.sin((x * wave.xFactor + z * wave.zFactor) / wavelength + (wave.phase ?? 0));
    height += wave.amplitude * (Math.pow(clamp(raw, 0, 1), wave.power ?? 1) - (wave.center ?? 0));
  }

  for (const basin of macro.broadBasins ?? []) {
    const cx = basin.xMapScale * mapScale;
    const cz = basin.zMapScale * mapScale;
    const rx = basin.radiusXMapScale * mapScale;
    const rz = basin.radiusZMapScale * mapScale;
    height += basin.height * radialBell(x, z, cx, cz, rx, rz);
  }

  const relief = macro.localRelief;
  if (relief) {
    const roadFade = smoothstep(relief.fadeStart ?? 28, relief.fadeEnd ?? 96, ctx.edgeDistance);
    const w1 = Math.max(0.0001, (relief.wavelengthA ?? 46) * mapScale);
    const w2 = Math.max(0.0001, (relief.wavelengthB ?? 34) * mapScale);
    const w3 = Math.max(0.0001, (relief.wavelengthC ?? 62) * mapScale);
    const lumpy =
      0.55 * Math.sin((x * 0.8 + z * 0.35) / w1 + (relief.phaseA ?? 0)) * Math.sin((z * 0.9 - x * 0.2) / w2 + (relief.phaseB ?? 0)) +
      0.32 * Math.sin((x * -0.45 + z * 0.95) / w3 + (relief.phaseC ?? 0)) +
      0.18 * Math.cos((x * 1.2 + z * 0.7) / Math.max(0.0001, w2 * 0.72));
    height += (relief.amplitude ?? 1.4) * roadFade * lumpy;
  }

  return height;
}

function roadProfileHeight(ctx, x, z) {
  const hero = Math.max(ctx.heroMask, ctx.heroSpanMask);
  const side = ctx.nearest.signedLateral >= 0 ? 1 : -1;
  const edge = ctx.edgeDistance;
  const profile = terrainRecipe.corridor.roadProfile;
  const roadY = ctx.nearest.point.y - trackClearance + terrainRecipe.corridor.roadYOffset;
  if (ctx.nearest.distance <= ctx.halfTrack) {
    return roadY;
  }
  const shoulderDrop =
    (profile.shoulderDrop.base + profile.shoulderDrop.hero * hero) *
    smoothstep(0, shoulderWidth * profile.shoulderDrop.edgeEndShoulderFactor, edge);
  const ditch =
    (profile.ditch.base + profile.ditch.hero * hero) *
    bell(shoulderWidth * profile.ditch.centerShoulderFactor, shoulderWidth * profile.ditch.radiusShoulderFactor, edge);
  const cutFace =
    (profile.cutFace.base + profile.cutFace.hero * hero) *
    bell(shoulderWidth * profile.cutFace.centerShoulderFactor, shoulderWidth * profile.cutFace.radiusShoulderFactor, edge);
  const nearHill =
    (profile.nearHill.base + hero * (side > 0 ? profile.nearHill.heroRight : profile.nearHill.heroLeft)) *
    bell(shoulderWidth * profile.nearHill.centerShoulderFactor, shoulderWidth * profile.nearHill.radiusShoulderFactor, edge);
  const outerHill =
    (profile.outerHill.base + profile.outerHill.hero * hero) *
    bell(shoulderWidth * profile.outerHill.centerShoulderFactor, shoulderWidth * profile.outerHill.radiusShoulderFactor, edge);
  const erosion =
    profile.erosion.amplitude *
    Math.sin((x * profile.erosion.xFactor + z * profile.erosion.zFactor) / (profile.erosion.wavelengthMapScaleFactor * mapScale)) *
    (1 - smoothstep(shoulderWidth * profile.erosion.fadeStartShoulderFactor, shoulderWidth * profile.erosion.fadeEndShoulderFactor, edge));
  return roadY + shoulderDrop + ditch + cutFace + nearHill + outerHill + erosion;
}

export function targetLandformHeight(x, z) {
  let height = broadHorizonHeight(x, z);
  for (const feature of resolvedElevationFeatures()) {
    height += featureHeight(feature, x, z);
  }
  return height;
}

export function targetTerrainWorldY(x, z) {
  const ctx = terrainContext(x, z);
  const hero = Math.max(ctx.heroMask, ctx.heroSpanMask);
  const land = targetLandformHeight(x, z) + macroTerrainHeight(ctx, x, z);
  const road = roadProfileHeight(ctx, x, z);
  const blendCfg = terrainRecipe.corridor.blend;
  const blendStart = shoulderWidth * (blendCfg.startShoulderFactor + hero * blendCfg.heroStartShoulderFactor);
  const blendEnd = shoulderWidth + terrainBlendWidth + hero * blendCfg.heroEndExtra;
  const blend = smoothstep(blendStart, blendEnd, ctx.edgeDistance);
  const cutCfg = terrainRecipe.corridor.cutReinforcement;
  const cutReinforcement = land * hero * (cutCfg.base + blend * cutCfg.blend);
  return clamp(mix(road, land, blend) + cutReinforcement, terrainY + 0.12, terrainY + terrainHeight - 0.28);
}

export function terrainSplatWeights(x, z, col = 0, row = 0) {
  const ctx = terrainContext(x, z);
  const y = targetTerrainWorldY(x, z);
  const edge = ctx.edgeDistance;
  const hero = Math.max(ctx.heroMask, ctx.heroSpanMask);
  const roadEdgeMask = 1 - smoothstep(0, shoulderWidth * 1.55, edge);
  const nearRoadFade = 1 - smoothstep(shoulderWidth * 0.32, shoulderWidth * 3.2, edge);
  const bankBreakup = terrainValueNoise(x + ctx.nearest.signedLateral * 0.7, z - ctx.nearest.trackDistance * 0.05, 34, 18);
  const fineBreakup = terrainValueNoise(x, z, 12, 21);
  const fieldClumps = smoothstep(0.54, 0.86, terrainValueNoise(x + 83, z - 41, 92, 31));
  const sunlitShelf = smoothstep(0.50, 0.86, terrainValueNoise(x - 127, z + 68, 150, 35));
  const exposedBankPatch = smoothstep(0.46, 0.82, terrainValueNoise(ctx.nearest.trackDistance, ctx.nearest.signedLateral * 8, 88, 24));
  const grassyBankPatch = smoothstep(0.62, 0.9, terrainValueNoise(ctx.nearest.trackDistance + 41, ctx.nearest.signedLateral * -6, 92, 27));
  const terracePhase = Math.abs((((edge * 0.22 + ctx.nearest.trackDistance * 0.018 + bankBreakup * 1.7) % 1) + 1) % 1 - 0.5);
  const terraceLine =
    (1 - smoothstep(0.055, 0.22, terracePhase)) *
    smoothstep(shoulderWidth * 1.02, shoulderWidth * 1.78, edge) *
    (1 - smoothstep(shoulderWidth * 2.10, shoulderWidth * 2.92, edge)) *
    0.022;
  const dustyShoulder =
    bell(shoulderWidth * 0.30, shoulderWidth * 0.24, edge) *
    (0.30 + 0.12 * fineBreakup + 0.07 * bankBreakup);
  const compactShoulder =
    (1 - smoothstep(0, shoulderWidth * 0.28, edge)) *
    (0.38 + 0.07 * fineBreakup + 0.05 * bankBreakup);
  const gravelLip =
    bell(shoulderWidth * 0.16, shoulderWidth * 0.16, edge) *
    (0.26 + 0.15 * fineBreakup + 0.08 * exposedBankPatch);
  const shoulderCore =
    bell(shoulderWidth * 0.34, shoulderWidth * 0.24, edge) * 0.42 +
    bell(shoulderWidth * 0.78, shoulderWidth * 0.36, edge) * 0.12;
  const roadScuff = shoulderCore * (0.34 + 0.10 * fineBreakup + 0.07 * bankBreakup);
  const nearCutFace =
    bell(shoulderWidth * 0.86, shoulderWidth * 0.38, edge) *
    (0.42 + hero * 0.10 + 0.12 * bankBreakup + 0.10 * exposedBankPatch);
  const cutFace =
    (nearCutFace +
      bell(shoulderWidth * 1.50, shoulderWidth * 0.56, edge) * (0.28 + hero * 0.12) +
      bell(shoulderWidth * 2.18, shoulderWidth * 0.72, edge) * (0.06 + hero * 0.03)) *
    (0.32 + 0.12 * bankBreakup + 0.06 * fineBreakup + 0.12 * exposedBankPatch);
  const highFace =
    smoothstep(4.2, 12.4, y) *
    (0.08 + 0.18 * terrainValueNoise(x, z, 42, 8)) *
    (1 - roadEdgeMask * 0.42);
  const lowBasin = (1 - smoothstep(-0.6, 5.8, y)) * (1 - roadEdgeMask * 0.62);
  const wornMeadowBand =
    bell(shoulderWidth * 2.95, shoulderWidth * 1.95, edge) *
    (0.24 + hero * 0.08 + grassyBankPatch * 0.18) *
    (1 - cutFace * 0.44) *
    (0.68 + 0.32 * fineBreakup);
  const outerGrassShelf =
    bell(shoulderWidth * 4.35, shoulderWidth * 2.3, edge) *
    (0.34 + grassyBankPatch * 0.24 + sunlitShelf * 0.18) *
    (1 - exposedBankPatch * 0.28);
  const broadMeadow =
    (smoothstep(0.54, 0.88, terrainValueNoise(x, z, 72, 12)) * 0.34 + fieldClumps * 0.18) *
    (1 - nearRoadFade * 0.58) *
    (1 - highFace * 0.7);
  const basinMeadow =
    lowBasin *
    (0.22 + 0.18 * terrainValueNoise(x, z, 36, 14)) *
    (1 - cutFace * 0.5);
  const wornGrass = roadEdgeMask * 0.08 + lowBasin * 0.08;
  const shoulderDirtFalloff = 1 - smoothstep(0.75, 2.65, edge);
  const cutMaterialReveal = smoothstep(shoulderWidth * 1.16, shoulderWidth * 1.92, edge);
  const visualCutFace = cutFace * cutMaterialReveal;
  const visualTerraceLine = terraceLine * cutMaterialReveal;
  const cutDirtFalloff =
    smoothstep(shoulderWidth * 1.06, shoulderWidth * 1.48, edge) *
    (1 - smoothstep(shoulderWidth * 2.22, shoulderWidth * 3.05, edge));
  const grassFingerNoise = terrainValueNoise(ctx.nearest.trackDistance * 0.46, ctx.nearest.signedLateral * 5.8 + edge * 1.7, 74, 44);
  const grassFingerOffset = (grassFingerNoise - 0.5) * 1.05;
  const grassTongueNoise = terrainValueNoise(ctx.nearest.trackDistance * 0.82 + 17, ctx.nearest.signedLateral * 7.2 - edge * 2.8, 38, 52);
  const grassTongues =
    smoothstep(0.38, 0.70, grassTongueNoise) *
    bell(1.55, 1.25, edge) *
    (0.72 + 0.34 * grassyBankPatch + 0.18 * bankBreakup);
  const grassCover = clamp(smoothstep(0.34 + grassFingerOffset, 1.45 + grassFingerOffset, edge) + grassTongues * 0.82, 0, 1);
  const exposedSoilPatch =
    smoothstep(0.54, 0.86, terrainValueNoise(ctx.nearest.trackDistance * 0.72 + 31, ctx.nearest.signedLateral * 6.4 - edge * 1.8, 82, 47)) *
    (0.45 + exposedBankPatch * 0.35 + fineBreakup * 0.20) *
    (1 - grassTongues * 0.72);
  const roadWearLip = bell(0.42, 0.52, edge) * (0.24 + fineBreakup * 0.12 + bankBreakup * 0.07);
  const grassReturn = smoothstep(0.20, 1.15, edge);
  const meadowReturn = smoothstep(5.8, 12.0, edge);
  const dirtShoulder =
    (1 - smoothstep(0.10, 0.80, edge)) *
    (0.48 + fineBreakup * 0.10 + bankBreakup * 0.07 + exposedSoilPatch * 0.10);
  const grassCutLip =
    smoothstep(0.34, 1.40, edge) *
    (1 - smoothstep(5.8, 10.2, edge)) *
    (0.82 + grassTongues * 0.50 + grassyBankPatch * 0.28 + sunlitShelf * 0.14);

  let dirt =
    (roadWearLip * 0.36 +
      compactShoulder * 0.26 +
      dustyShoulder * 0.18 +
      gravelLip * 0.16 +
      roadScuff * 0.12 +
      dirtShoulder * 0.42) *
      (0.52 + shoulderDirtFalloff * 0.48) +
    visualCutFace * (0.14 + exposedSoilPatch * 0.18 + exposedBankPatch * 0.05) * cutDirtFalloff +
    visualTerraceLine * (0.025 + exposedSoilPatch * 0.035) +
    lowBasin * 0.01;
  dirt += (1 - smoothstep(0.04, 0.66, edge)) * (0.30 + exposedSoilPatch * 0.10 + fineBreakup * 0.03);
  dirt *= mix(1.0, 0.08, grassCover) + exposedSoilPatch * mix(0.02, 0.10, 1 - grassCover);
  let meadow = (wornMeadowBand * 0.64 + broadMeadow * 0.36 + basinMeadow * 0.52 + outerGrassShelf * 0.28) * (1 - nearCutFace * 0.20);
  let rock =
    visualCutFace * (0.12 + nearCutFace * 0.04) * cutDirtFalloff * (0.46 + exposedSoilPatch * 0.20) +
    visualTerraceLine * 0.006 +
    highFace * 0.38;
  let grass = Math.max(
    0.24,
    1.12 -
      dirt * 0.72 -
      meadow * 0.16 -
      rock * 0.46 +
      wornGrass * 0.28 +
      outerGrassShelf * 0.84 +
      broadMeadow * 0.16 +
      sunlitShelf * 0.10,
  );
  const curbGrassMat = smoothstep(0.48, 1.25, edge) * (1 - smoothstep(5.8, 9.4, edge));
  const roadsideTurfMat = smoothstep(0.32, 0.95, edge) * (1 - smoothstep(6.6, 10.8, edge)) * (1 - visualCutFace * 0.55);
  const curbRockReveal = smoothstep(shoulderWidth * 0.72, shoulderWidth * 1.50, edge);
  dirt *= mix(1.0, 0.10, curbGrassMat);
  dirt *= mix(1.0, 0.045, roadsideTurfMat);
  rock *= mix(0.06, 1.0, curbRockReveal);
  meadow *= mix(0.30, 1.0, meadowReturn);
  grass += curbGrassMat * (1.34 + grassTongues * 0.55 + grassCutLip * 0.52);
  grass += roadsideTurfMat * 1.72;
  meadow += roadsideTurfMat * 0.24;
  grass = grass * mix(0.86, 1.28, grassReturn) + grassCover * 1.08 + grassCutLip * 0.72 + grassTongues * 0.56;
  meadow *= mix(0.18, 1.0, meadowReturn);

  const sum = Math.max(0.0001, grass + meadow + dirt + rock);
  return {
    grass: grass / sum,
    meadow: meadow / sum,
    dirt: dirt / sum,
    rock: rock / sum,
  };
}

export function heightfieldSpec() {
  return {
    version: 1,
    name: 'BlockKart terrain height field spec v1',
    sourceRecipe: terrainRecipe.agentIteration?.editObject ?? defaultTerrainRecipeRelativePath,
    target: terrainRecipe.target,
    coordinateSystem: {
      x: 'world east-west',
      z: 'world north-south',
      y: 'world elevation in meters',
      origin: 'track/map center',
    },
    terrain: {
      width: terrainWidth,
      depth: terrainDepth,
      minY: terrainY,
      maxY: terrainY + terrainHeight,
      roadWidth: trackWidth,
      shoulderWidth,
    },
    heroSegment: {
      startDistance: heroSegmentStart,
      centerDistance: heroSegmentCenter,
      endDistance: heroSegmentEnd,
      intent: terrainRecipe.heroSegment.intent,
    },
    features: resolvedElevationFeatures().map((feature) => ({ ...feature })),
  };
}
