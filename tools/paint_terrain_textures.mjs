import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const conceptPath = join(root, 'docs', 'images', 'terrain-upgrade-concept-v1.png');
const outDir = join(root, 'assets', 'source', 'terrain_painted');
const effectsDir = join(root, 'assets', 'effects');
mkdirSync(outDir, { recursive: true });
mkdirSync(effectsDir, { recursive: true });

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 64) {
    throw new Error(`${name} must be an integer >= 64`);
  }
  return value;
}

const textureSize = envInt('TERRAIN_PAINTED_TEXTURE_SIZE', 512);
if (!existsSync(conceptPath)) {
  throw new Error(`missing concept image: ${conceptPath}`);
}
const concept = readPngRgba(conceptPath);
const sourcePools = collectConceptPools(concept);

const specs = [
  {
    key: 'grass',
    file: 'grass_painted_v1.png',
    seed: 71001,
    pool: sourcePools.grass,
    base: [66, 134, 46, 255],
    mid: [108, 166, 54, 255],
    light: [168, 198, 72, 255],
    dark: [34, 92, 32, 255],
    lift: [-2, 0, -7],
    exposure: 1.02,
    saturation: 0.92,
    sourceBlend: 0.08,
    broadCells: 18,
    detailCells: 64,
  },
  {
    key: 'meadow',
    file: 'meadow_painted_v1.png',
    seed: 72001,
    pool: sourcePools.grass,
    base: [72, 136, 52, 255],
    mid: [116, 166, 60, 255],
    light: [174, 200, 82, 255],
    dark: [36, 92, 38, 255],
    lift: [-2, 1, -6],
    exposure: 1.02,
    saturation: 0.88,
    sourceBlend: 0.08,
    broadCells: 16,
    detailCells: 58,
  },
  {
    key: 'dirt',
    file: 'dirt_painted_v1.png',
    seed: 73001,
    pool: sourcePools.dirt,
    base: [154, 94, 48, 255],
    mid: [190, 128, 66, 255],
    light: [238, 184, 96, 255],
    dark: [104, 68, 42, 255],
    lift: [3, 1, -6],
    exposure: 1.03,
    saturation: 0.82,
    sourceBlend: 0.06,
    broadCells: 11,
    detailCells: 54,
  },
  {
    key: 'rock',
    file: 'rock_painted_v1.png',
    seed: 74001,
    pool: sourcePools.rock,
    base: [94, 92, 84, 255],
    mid: [134, 128, 112, 255],
    light: [184, 174, 146, 255],
    dark: [64, 66, 62, 255],
    lift: [-2, -2, -4],
    exposure: 0.94,
    saturation: 0.54,
    sourceBlend: 0.22,
    broadCells: 5,
    detailCells: 19,
  },
];

function main() {
  for (const spec of specs) {
    const pixels = makePaintedSourceTexture(textureSize, spec);
    writeFileSync(join(outDir, spec.file), encodePngRgba(textureSize, textureSize, pixels));
  }
  writeFileSync(join(effectsDir, 'grass_card_atlas.png'), encodePngRgba(1024, 1024, makeGrassCardAtlas(1024)));

  console.log(`${outDir}/painted terrain source textures (${textureSize}x${textureSize})`);
  console.log(`${effectsDir}/grass_card_atlas.png (1024x1024)`);
  console.log(`concept samples grass=${sourcePools.grass.length} dirt=${sourcePools.dirt.length} rock=${sourcePools.rock.length}`);
}

function collectConceptPools(image) {
  const grass = [];
  const dirt = [];
  const rock = [];
  for (let y = 0; y < image.height; y += 2) {
    const yf = y / image.height;
    for (let x = 0; x < image.width; x += 2) {
      const i = (y * image.width + x) * 4;
      const r = image.pixels[i];
      const g = image.pixels[i + 1];
      const b = image.pixels[i + 2];
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      const maxc = Math.max(r, g, b);
      const minc = Math.min(r, g, b);
      const sat = maxc - minc;
      const isSky = yf < 0.34 && b > 130 && b > r * 1.08 && b >= g * 0.82;
      const isRoad = yf > 0.34 && luma < 55 && sat < 45;
      const isCurb = yf > 0.34 && ((r > 185 && g < 135 && b < 125) || luma > 228);
      if (isSky || isRoad || isCurb) {
        continue;
      }
      const packed = packColor(r, g, b, 255);
      if (yf > 0.26 && g > 72 && g > r * 0.84 && g > b * 1.04 && sat > 20 && luma > 55 && luma < 205) {
        grass.push(packed);
      }
      if (yf > 0.38 && r > 92 && g > 58 && b < 150 && r > b * 1.22 && g > b * 1.02 && luma > 70 && luma < 210) {
        dirt.push(packed);
      }
      if (yf > 0.34 && luma > 72 && luma < 218 && sat < 64 && Math.abs(r - g) < 56 && Math.abs(g - b) < 62) {
        rock.push(packed);
      }
    }
  }
  if (grass.length <= 512 || dirt.length <= 512 || rock.length <= 256) {
    throw new Error(`insufficient concept samples: grass=${grass.length} dirt=${dirt.length} rock=${rock.length}`);
  }
  return { grass, dirt, rock };
}

function makePaintedSourceTexture(size, spec) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const broad = fbmTile(u, v, spec.broadCells, spec.seed, 5);
      const detail = fbmTile(u + 0.17, v - 0.09, spec.detailCells, spec.seed + 11, 4);
      const ridge = ridgedTile(u - 0.09, v + 0.13, spec.detailCells, spec.seed + 29);
      let color = colorMix(spec.base, spec.light, clamp(0.24 + broad * 0.10 + detail * 0.16, 0, 1));
      color = colorMix(color, spec.mid, clamp(0.16 + detail * 0.18, 0, 0.34));
      color = colorMix(color, spec.dark, ridge * (spec.key === 'grass' || spec.key === 'meadow' ? 0.055 : 0.12));
      color = colorMix(color, poolColorAt(spec.pool, u, v, spec.seed + 41), spec.sourceBlend);

      if (spec.key === 'grass' || spec.key === 'meadow') {
        const blade = strandSignal(u, v, spec.key === 'grass' ? 64 : 52, -0.38, spec.seed + 7);
        const crossBlade = strandSignal(u + 0.08, v - 0.04, spec.key === 'grass' ? 92 : 74, -0.74, spec.seed + 17);
        const clump = ridgedTile(u + 0.06, v - 0.05, spec.key === 'grass' ? 11 : 9, spec.seed + 53);
        const bladeDetail = blade * 0.68 + crossBlade * 0.32;
        color = colorMix(color, spec.dark, clump * (spec.key === 'grass' ? 0.018 : 0.016));
        color = addColor(color, (bladeDetail - 0.5) * 4.2, (bladeDetail - 0.5) * 5.0, (detail - 0.5) * 1.8);
      } else if (spec.key === 'dirt') {
        const dryLine = lineSignal(u, v, 18, 0.18, spec.seed + 13, 0.034);
        const fineScrape = lineSignal(u + 0.04, v - 0.08, 32, 0.24, spec.seed + 17, 0.012);
        const crossStroke = lineSignal(u - 0.06, v + 0.12, 12, -0.58, spec.seed + 31, 0.026);
        const compact = ridgedTile(u + 0.03, v - 0.08, 18, spec.seed + 37);
        const warmPatch = fbmTile(u + 0.18, v - 0.12, 9, spec.seed + 43, 4);
        color = colorMix(color, [214, 142, 72, 255], warmPatch * 0.070);
        color = colorMix(color, spec.light, dryLine * 0.24 + crossStroke * 0.11);
        color = colorMix(color, spec.dark, compact * 0.040 + fineScrape * 0.028);
        color = addColor(color, (detail - 0.5) * 5.0, (detail - 0.5) * 3.6, (ridge - 0.5) * 2.0);
      } else if (spec.key === 'rock') {
        const strata = lineSignal(u, v, 17, 0.22, spec.seed + 19, 0.048);
        const hairline = lineSignal(u + 0.04, v - 0.08, 42, 0.14, spec.seed + 23, 0.014);
        color = colorMix(color, spec.light, strata * 0.14);
        color = colorMix(color, spec.dark, hairline * 0.11);
      }

      color = gradeColor(color, spec.exposure, spec.saturation, spec.lift);
      putPixel(pixels, (y * size + x) * 4, color);
    }
  }

  if (spec.key === 'grass') {
    paintGrassLayer(pixels, size, spec, 0.00285, false);
  } else if (spec.key === 'meadow') {
    paintGrassLayer(pixels, size, spec, 0.00185, true);
    paintFlowerFlecks(pixels, size, spec.seed + 207, 0.00050);
  } else if (spec.key === 'dirt') {
    paintDirtLayer(pixels, size, spec);
  } else if (spec.key === 'rock') {
    paintRockLayer(pixels, size, spec);
  }

  return pixels;
}

function paintGrassLayer(pixels, size, spec, density, meadow) {
  const rand = seededRandom(spec.seed + 101);
  const clumpCount = Math.round(size * size * (meadow ? 0.000018 : 0.000018));
  for (let i = 0; i < clumpCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = mix(5, meadow ? 14 : 17, Math.pow(rand(), 0.7));
    const color = colorMix(spec.dark, spec.mid, mix(0.18, 0.58, rand()));
    for (let j = 0; j < 4; j++) {
      drawBrushStroke(
        pixels,
        size,
        x + (rand() - 0.5) * radius,
        y + (rand() - 0.5) * radius,
        radius * mix(0.28, meadow ? 0.76 : 0.70, rand()),
        mix(0.9, meadow ? 3.2 : 3.6, rand()),
        rand() * Math.PI * 2,
        color,
        mix(0.010, meadow ? 0.032 : 0.038, rand()),
      );
    }
  }

  const strokeCount = Math.round(size * size * density * (meadow ? 1.05 : 0.80));
  for (let i = 0; i < strokeCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const flow = fbmTile(u, v, 7, spec.seed + 137, 4);
    const color = colorMix(poolColorAt(spec.pool, u, v, spec.seed + i), rand() > 0.58 ? spec.light : spec.dark, mix(0.18, 0.42, rand()));
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(4.2, meadow ? 14.0 : 16.0, Math.pow(rand(), 0.62)),
      mix(0.44, meadow ? 1.45 : 1.80, rand()),
      rand() > 0.30 ? rand() * Math.PI * 2 : -0.72 + flow * 0.66 + (rand() - 0.5) * 0.62,
      gradeColor(color, 1.02, meadow ? 0.92 : 0.94, spec.lift),
      mix(0.12, meadow ? 0.25 : 0.28, rand()),
    );
  }

  const bladeCount = Math.round(size * size * (meadow ? 0.0072 : 0.0094));
  for (let i = 0; i < bladeCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const flow = fbmTile(u + 0.09, v - 0.04, meadow ? 38 : 46, spec.seed + 191, 3);
    const warm = poolColorAt(spec.pool, u, v, spec.seed + i * 3 + 19);
    const base = rand() > 0.42 ? colorMix(warm, spec.light, mix(0.16, 0.38, rand())) : colorMix(warm, spec.dark, mix(0.18, 0.42, rand()));
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(3.8, meadow ? 11.5 : 15.0, Math.pow(rand(), 0.58)),
      mix(0.34, meadow ? 1.05 : 1.48, rand()),
      -0.62 + flow * 1.08 + (rand() - 0.5) * 0.44,
      gradeColor(base, 1.04, meadow ? 0.94 : 0.96, spec.lift),
      mix(0.18, meadow ? 0.38 : 0.42, rand()),
    );
  }

  const highlightCount = Math.round(size * size * (meadow ? 0.0026 : 0.0020));
  for (let i = 0; i < highlightCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const flow = fbmTile(u - 0.11, v + 0.07, meadow ? 30 : 36, spec.seed + 231, 3);
    const warm = rand() > 0.70 ? [188, 178, 86, 255] : spec.light;
    const shade = rand() > 0.76 ? spec.dark : colorMix(spec.mid, warm, mix(0.42, 0.78, rand()));
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(4.0, meadow ? 13.0 : 15.0, Math.pow(rand(), 0.62)),
      mix(0.34, meadow ? 1.15 : 1.35, rand()),
      -0.72 + flow * 1.12 + (rand() - 0.5) * 0.52,
      gradeColor(shade, 1.05, meadow ? 0.96 : 0.98, spec.lift),
      mix(0.16, meadow ? 0.34 : 0.36, rand()),
    );
  }

  const bladeMarkCount = Math.round(size * size * (meadow ? 0.0105 : 0.0120));
  for (let i = 0; i < bladeMarkCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const flow = fbmTile(u + 0.04, v - 0.10, meadow ? 42 : 48, spec.seed + 293, 3);
    const tone = rand();
    let color;
    if (tone > 0.74) {
      color = colorMix(spec.light, [192, 190, 92, 255], meadow ? 0.46 : 0.30);
    } else if (tone < 0.24) {
      color = colorMix(spec.dark, [34, 98, 34, 255], 0.42);
    } else {
      color = colorMix(spec.mid, poolColorAt(spec.pool, u, v, spec.seed + i * 11), 0.18);
    }
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(2.8, meadow ? 9.0 : 10.5, Math.pow(rand(), 0.56)),
      mix(0.26, meadow ? 0.80 : 0.94, rand()),
      -0.78 + flow * 1.06 + (rand() - 0.5) * 0.50,
      gradeColor(color, 1.04, meadow ? 1.00 : 1.02, spec.lift),
      mix(0.20, meadow ? 0.48 : 0.52, rand()),
    );
  }
}

function paintFlowerFlecks(pixels, size, seed, density) {
  const rand = seededRandom(seed);
  const count = Math.round(size * size * density);
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const warm = rand() > 0.36;
    const color = warm ? [229, 202, 65, 255] : [232, 232, 212, 255];
    drawPaintDot(pixels, size, x, y, mix(0.8, 2.5, rand()), mix(0.7, 1.9, rand()), rand() * Math.PI, color, mix(0.32, 0.70, rand()));
  }
}

function paintDirtLayer(pixels, size, spec) {
  const rand = seededRandom(spec.seed + 103);
  const broadStrokeCount = Math.round(size * size * 0.00145);
  for (let i = 0; i < broadStrokeCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const warm = poolColorAt(spec.pool, u, v, spec.seed + i * 7);
    const color = rand() > 0.38 ? colorMix(warm, spec.light, mix(0.34, 0.68, rand())) : colorMix(spec.dark, warm, mix(0.42, 0.72, rand()));
    const angle = rand() > 0.74 ? mix(-0.72, -0.38, rand()) : mix(0.06, 0.34, rand());
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(28, 118, Math.pow(rand(), 0.58)),
      mix(2.0, 8.5, rand()),
      angle,
      gradeColor(color, 1.02, 0.90, spec.lift),
      mix(0.10, 0.28, rand()),
    );
  }

  const scuffCount = Math.round(size * size * 0.0030);
  for (let i = 0; i < scuffCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const color = rand() > 0.42 ? colorMix(poolColorAt(spec.pool, u, v, spec.seed + i), spec.light, 0.56) : colorMix(spec.dark, poolColorAt(spec.pool, u, v, spec.seed + i), 0.66);
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(12, 72, Math.pow(rand(), 0.58)),
      mix(0.8, 4.2, rand()),
      rand() > 0.70 ? mix(-0.66, -0.24, rand()) : mix(0.04, 0.36, rand()),
      gradeColor(color, 1.02, 0.88, spec.lift),
      mix(0.11, 0.32, rand()),
    );
  }

  const dryChipCount = Math.round(size * size * 0.0013);
  for (let i = 0; i < dryChipCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const color = rand() > 0.34 ? [232, 176, 92, 255] : [154, 92, 48, 255];
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(5.0, 18.0, rand()),
      mix(1.0, 3.4, rand()),
      mix(-0.16, 0.46, rand()),
      color,
      mix(0.15, 0.34, rand()),
    );
  }

  const pebbleCount = Math.round(size * size * 0.0042);
  for (let i = 0; i < pebbleCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const color = rand() > 0.52 ? [190, 162, 112, 255] : [118, 80, 52, 255];
    drawPaintDot(pixels, size, x, y, mix(0.8, 4.4, rand()), mix(0.7, 3.0, rand()), rand() * Math.PI, color, mix(0.16, 0.46, rand()));
  }
}

function paintRockLayer(pixels, size, spec) {
  const rand = seededRandom(spec.seed + 107);
  const facetCount = Math.round(size * size * 0.0017);
  for (let i = 0; i < facetCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const u = x / size;
    const v = y / size;
    const color = colorMix(poolColorAt(spec.pool, u, v, spec.seed + i), rand() > 0.46 ? spec.light : spec.dark, mix(0.20, 0.48, rand()));
    drawBrushStroke(
      pixels,
      size,
      x,
      y,
      mix(20, 88, Math.pow(rand(), 0.65)),
      mix(2.0, 9.0, rand()),
      mix(-0.38, 0.85, rand()),
      gradeColor(color, 0.94, 0.54, spec.lift),
      mix(0.08, 0.25, rand()),
    );
  }
}

function makeGrassCardAtlas(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 96;
    pixels[i + 1] = 150;
    pixels[i + 2] = 54;
  }
  const cell = size / 2;
  const variants = [
    { seed: 8101, blades: 106, width: 0.64, height: 0.74, dark: [18, 94, 22, 255], mid: [44, 158, 24, 255], light: [116, 220, 38, 255], dry: [116, 146, 48, 255], nap: false },
    { seed: 8201, blades: 116, width: 0.70, height: 0.78, dark: [20, 102, 24, 255], mid: [54, 172, 26, 255], light: [132, 232, 44, 255], dry: [126, 154, 54, 255], nap: false },
    { seed: 8301, blades: 142, width: 0.92, height: 0.40, dark: [16, 90, 22, 255], mid: [46, 158, 30, 255], light: [126, 218, 48, 255], dry: [124, 146, 58, 255], nap: true },
    { seed: 8401, blades: 152, width: 0.98, height: 0.38, dark: [18, 100, 24, 255], mid: [58, 174, 32, 255], light: [144, 232, 52, 255], dry: [134, 156, 62, 255], nap: true },
  ];
  for (let i = 0; i < variants.length; i++) {
    const x0 = (i % 2) * cell;
    const y0 = Math.floor(i / 2) * cell;
    paintGrassCardCell(pixels, size, x0, y0, cell, variants[i]);
  }
  return pixels;
}

function paintGrassCarpetCell(pixels, size, x0, y0, cell, variant) {
  const rand = seededRandom(variant.seed);
  const undercoatCount = Math.round(variant.blades * 0.72);
  for (let i = 0; i < undercoatCount; i++) {
    const x = x0 + cell * mix(0.025, 0.975, rand());
    const y = y0 + cell * mix(0.025, 0.975, rand());
    const u = (x - x0) / cell;
    const v = (y - y0) / cell;
    const edgeFade =
      smooth01(Math.min(u, v, 1 - u, 1 - v) / 0.060) *
      (0.82 + 0.18 * smooth01((variant.coverage - Math.hypot(u - 0.5, v - 0.5)) / 0.44));
    if (edgeFade <= 0.03 || rand() > edgeFade * variant.coverage * 0.88) {
      continue;
    }
    const flow = fbmTile(u + 0.19, v - 0.13, 5, variant.seed + 19, 3);
    const angle = variant.angle + (flow - 0.5) * 0.76 + (rand() - 0.5) * 0.46;
    let color = colorMix(variant.mid, variant.light, mix(0.06, 0.38, rand()));
    if (rand() > 0.72) {
      color = colorMix(color, variant.dry, mix(0.10, 0.28, rand()));
    }
    drawAlphaBrushStroke(
      pixels,
      size,
      x,
      y,
      cell * mix(0.085, 0.230, Math.pow(rand(), 0.72)),
      cell * mix(0.020, 0.058, rand()),
      angle,
      color,
      mix(0.08, 0.19, rand()) * mix(0.72, 1.0, edgeFade),
    );
  }

  for (let i = 0; i < variant.blades; i++) {
    const x = x0 + cell * mix(0.025, 0.975, rand());
    const y = y0 + cell * mix(0.025, 0.975, rand());
    const u = (x - x0) / cell;
    const v = (y - y0) / cell;
    const edgeFade =
      smooth01(Math.min(u, v, 1 - u, 1 - v) / 0.055) *
      (0.82 + 0.18 * smooth01((variant.coverage - Math.hypot(u - 0.5, v - 0.5)) / 0.44));
    if (edgeFade <= 0.03 || rand() > edgeFade * variant.coverage) {
      continue;
    }
    const flow = fbmTile(u + 0.19, v - 0.13, 5, variant.seed + 29, 3);
    const angle = variant.angle + (flow - 0.5) * 0.92 + (rand() - 0.5) * 0.64;
    const length = cell * mix(0.050, 0.138, Math.pow(rand(), 0.72));
    const width = cell * mix(0.0085, 0.0220, Math.pow(rand(), 1.12));
    let color = colorMix(variant.dark, variant.mid, mix(0.52, 0.92, rand()));
    if (rand() > 0.56) {
      color = colorMix(color, variant.light, mix(0.10, 0.44, rand()));
    }
    if (rand() > 0.90) {
      color = colorMix(color, variant.dry, mix(0.12, 0.34, rand()));
    }
    drawAlphaBrushStroke(pixels, size, x, y, length, width, angle, color, mix(0.30, 0.55, rand()) * mix(0.72, 1.0, edgeFade));
  }
  const shortBladeCount = Math.round(variant.blades * 0.36);
  for (let i = 0; i < shortBladeCount; i++) {
    const x = x0 + cell * mix(0.035, 0.965, rand());
    const y = y0 + cell * mix(0.035, 0.965, rand());
    const u = (x - x0) / cell;
    const v = (y - y0) / cell;
    const edgeFade = smooth01(Math.min(u, v, 1 - u, 1 - v) / 0.06);
    if (rand() > edgeFade * 0.92) {
      continue;
    }
    const angle = variant.angle + (rand() - 0.5) * 1.35;
    const color = colorMix(colorMix(variant.dark, variant.mid, mix(0.48, 0.90, rand())), variant.light, Math.pow(rand(), 2.0) * 0.42);
    drawAlphaBrushStroke(
      pixels,
      size,
      x,
      y,
      cell * mix(0.028, 0.072, rand()),
      cell * mix(0.0085, 0.0185, rand()),
      angle,
      color,
      mix(0.24, 0.46, rand()) * mix(0.72, 1.0, edgeFade),
    );
  }
}

function paintGrassCardCell(pixels, size, x0, y0, cell, variant) {
  const rand = seededRandom(variant.seed);
  const baseRootY = y0 + cell * (variant.nap ? 0.86 : 0.94);
  const rootX = x0 + cell * 0.5;
  const rootSpread = cell * variant.width * (variant.nap ? 0.72 : 0.42);
  const bodyCount = Math.round(variant.blades * (variant.nap ? 0.16 : 0.22));
  for (let i = 0; i < bodyCount; i++) {
    const rootOffset = (rand() - 0.5) * rootSpread * 0.98;
    const rootY = baseRootY - cell * (variant.nap ? mix(0.00, 0.11, rand()) : mix(0.00, 0.035, rand()));
    const height = cell * variant.height * mix(variant.nap ? 0.24 : 0.38, variant.nap ? 0.60 : 0.84, Math.pow(rand(), 0.72));
    const bend = (rand() - 0.5) * cell * mix(0.020, variant.nap ? 0.15 : 0.18, rand());
    const color = colorMix(variant.dark, variant.mid, mix(0.18, 0.72, rand()));
    drawAlphaBrushStroke(
      pixels,
      size,
      rootX + rootOffset + bend * 0.18,
      rootY - height * 0.45,
      height,
      cell * mix(variant.nap ? 0.075 : 0.090, variant.nap ? 0.145 : 0.185, Math.pow(rand(), 0.70)),
      -Math.PI * 0.5 + (bend / Math.max(1, height)) * 0.55 + (rand() - 0.5) * 0.22,
      color,
      mix(0.42, 0.64, rand()),
    );
  }
  const massCount = Math.round(variant.blades * (variant.nap ? 0.24 : 0.30));
  for (let i = 0; i < massCount; i++) {
    const rootOffset = (rand() - 0.5) * rootSpread * 1.10;
    const rootY = baseRootY - cell * (variant.nap ? mix(0.00, 0.15, Math.pow(rand(), 1.35)) : mix(0.00, 0.040, rand()));
    const height = cell * variant.height * mix(variant.nap ? 0.28 : 0.46, variant.nap ? 0.78 : 0.96, Math.pow(rand(), 0.62));
    const bend = (rand() - 0.5) * cell * mix(0.025, variant.nap ? 0.22 : 0.26, rand());
    const cx = rootX + rootOffset + bend * 0.28;
    const cy = rootY - height * 0.48;
    const angle = -Math.PI * 0.5 + (bend / Math.max(1, height)) * 0.70 + (rand() - 0.5) * (variant.nap ? 0.34 : 0.26);
    let color = colorMix(variant.dark, variant.mid, mix(0.32, 0.78, rand()));
    if (rand() > 0.70) {
      color = colorMix(color, variant.light, mix(0.08, 0.28, rand()));
    }
    drawAlphaBrushStroke(
      pixels,
      size,
      cx,
      cy,
      height,
      cell * mix(variant.nap ? 0.030 : 0.040, variant.nap ? 0.070 : 0.092, Math.pow(rand(), 0.90)),
      angle,
      color,
      mix(0.58, 0.86, rand()),
    );
  }
  const undercoatCount = Math.round(variant.blades * (variant.nap ? 0.20 : 0.24));
  for (let i = 0; i < undercoatCount; i++) {
    const rootOffset = (rand() - 0.5) * rootSpread * 1.06;
    const rootY = baseRootY - cell * (variant.nap ? mix(0.00, 0.13, Math.pow(rand(), 1.45)) : mix(0.00, 0.035, rand()));
    const bladeHeight = -cell * variant.height * mix(0.16, variant.nap ? 0.66 : 0.54, Math.pow(rand(), 0.78));
    const bend = (rand() - 0.5) * cell * mix(0.020, variant.nap ? 0.24 : 0.16, rand());
    const width = mix(cell * 0.0140, cell * 0.0360, Math.pow(rand(), 1.02));
    let color = colorMix(variant.dark, variant.mid, mix(0.24, 0.70, rand()));
    if (rand() > 0.82) {
      color = colorMix(color, variant.dry, mix(0.10, 0.24, rand()));
    }
    drawGrassCardStroke(pixels, size, rootX + rootOffset, rootY, bladeHeight, width, bend, color, mix(0.62, 0.90, rand()));
  }
  for (let i = 0; i < variant.blades; i++) {
    const rootOffset = (rand() - 0.5) * rootSpread;
    const rootY = baseRootY - cell * (variant.nap ? mix(0.00, 0.12, Math.pow(rand(), 1.55)) : mix(0.00, 0.030, rand()));
    const bladeHeight = -cell * variant.height * mix(variant.nap ? 0.16 : 0.38, variant.nap ? 0.88 : 1.0, Math.pow(rand(), variant.nap ? 0.76 : 0.52));
    const bend = (rand() - 0.5) * cell * mix(0.035, variant.nap ? 0.30 : 0.30, rand());
    const width = mix(cell * (variant.nap ? 0.0100 : 0.0120), cell * (variant.nap ? 0.0260 : 0.0340), Math.pow(rand(), 1.05));
    const color = colorMix(colorMix(variant.dark, variant.mid, mix(0.48, 0.96, rand())), variant.light, Math.pow(rand(), 2.2) * 0.56);
    const alpha = mix(0.82, 1.0, rand());
    drawGrassCardStroke(pixels, size, rootX + rootOffset, rootY, bladeHeight, width, bend, color, alpha);
  }
  for (let i = 0; i < (variant.nap ? 12 : 24); i++) {
    const x = rootX + (rand() - 0.5) * rootSpread * 1.08;
    const y = baseRootY - cell * mix(0.00, variant.nap ? 0.13 : 0.055, rand());
    const color = colorMix(variant.dark, variant.mid, mix(0.42, 0.82, rand()));
    drawAlphaDot(pixels, size, x, y, cell * mix(0.006, variant.nap ? 0.013 : 0.022, rand()), cell * mix(0.005, variant.nap ? 0.011 : 0.018, rand()), color, mix(0.44, variant.nap ? 0.66 : 0.78, rand()));
  }
  sculptGrassCardAlpha(pixels, size, x0, y0, cell, variant.seed, variant.nap);
  hardenGrassCardAlpha(pixels, size, x0, y0, cell, variant.nap);
}

function sculptGrassCardAlpha(pixels, size, x0, y0, cell, seed, nap = false) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(size, Math.ceil(x0 + cell));
  const bottom = Math.min(size, Math.ceil(y0 + cell));
  for (let y = top; y < bottom; y++) {
    const v = (y + 0.5 - y0) / cell;
    const topFade = smooth01(v / (nap ? 0.10 : 0.055));
    const bottomFade = 1.0 - smooth01((v - (nap ? 0.94 : 0.985)) / (nap ? 0.070 : 0.045));
    const vertical = topFade * bottomFade;
    for (let x = left; x < right; x++) {
      const u = (x + 0.5 - x0) / cell;
      const i = (y * size + x) * 4;
      const alpha = pixels[i + 3] / 255;
      if (alpha <= 0) {
        continue;
      }
      const center = 1.0 - Math.abs(u - 0.5) * 2.0;
      const side = nap ? smooth01(center / 0.24) : smooth01(center / 0.30);
      const ragged = 0.82 + 0.18 * hashNoise(Math.floor(u * 53), Math.floor(v * 37), seed + 503);
      const columnBreak = 0.86 + 0.14 * hashNoise(Math.floor(u * (nap ? 47 : 67)), Math.floor(v * 11), seed + 907);
      const rootMass = nap ? 0.88 : mix(0.58, 1.0, smooth01((v - 0.42) / 0.50));
      const mask = clamp(side * ragged * columnBreak * rootMass * vertical, 0, 1);
      pixels[i + 3] = Math.round(alpha * mask * 255);
    }
  }
}

function hardenGrassCardAlpha(pixels, size, x0, y0, cell, nap = false) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(size, Math.ceil(x0 + cell));
  const bottom = Math.min(size, Math.ceil(y0 + cell));
  const threshold = nap ? 26 : 30;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * size + x) * 4;
      if (pixels[i + 3] >= threshold) {
        pixels[i + 3] = 255;
      } else {
        pixels[i + 3] = 0;
      }
    }
  }
}

function drawAlphaBrushStroke(pixels, size, cx, cy, length, width, angle, color, alpha = 1) {
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
      const taper = smooth01(1 - Math.pow(nx, 1.36));
      const softEdge = smooth01(1 - d);
      const bristle = 0.74 + 0.26 * hashNoise(Math.floor(cx + ox * 5), Math.floor(cy + oy * 7), 1201);
      blendAlphaPixel(pixels, size, Math.round(cx + ox), Math.round(cy + oy), color, alpha * taper * softEdge * bristle);
    }
  }
}

function drawGrassCardStroke(pixels, size, rootX, rootY, height, width, bend, color, alpha) {
  const steps = 18;
  let prevX = rootX;
  let prevY = rootY;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sway = Math.sin(t * Math.PI) * bend + (t * t) * bend * 0.38;
    const x = rootX + sway;
    const y = rootY + height * t;
    const radius = mix(width * 1.02, Math.max(0.38, width * 0.16), t);
    const tipFade = 1 - smooth01((t - 0.72) / 0.28) * 0.54;
    const dx = x - prevX;
    const dy = y - prevY;
    const segLen = Math.max(0.8, Math.hypot(dx, dy));
    drawAlphaBrushStroke(pixels, size, (prevX + x) * 0.5, (prevY + y) * 0.5, segLen + radius * 1.6, radius * 1.46, Math.atan2(dy, dx), color, alpha * tipFade);
    prevX = x;
    prevY = y;
  }
}

function drawAlphaDot(pixels, size, cx, cy, radiusX, radiusY, color, alpha) {
  const minX = Math.max(0, Math.floor(cx - radiusX - 1));
  const maxX = Math.min(size - 1, Math.ceil(cx + radiusX + 1));
  const minY = Math.max(0, Math.floor(cy - radiusY - 1));
  const maxY = Math.min(size - 1, Math.ceil(cy + radiusY + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = (x + 0.5 - cx) / Math.max(0.001, radiusX);
      const dy = (y + 0.5 - cy) / Math.max(0.001, radiusY);
      const d = dx * dx + dy * dy;
      if (d > 1) {
        continue;
      }
      blendAlphaPixel(pixels, size, x, y, color, alpha * smooth01(1 - d));
    }
  }
}

function blendAlphaPixel(pixels, size, x, y, color, alpha) {
  const i = (y * size + x) * 4;
  const srcA = clamp(alpha * ((color[3] ?? 255) / 255), 0, 1);
  const dstA = pixels[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0.0001) {
    return;
  }
  pixels[i] = Math.round((color[0] * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
  pixels[i + 1] = Math.round((color[1] * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
  pixels[i + 2] = Math.round((color[2] * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
  pixels[i + 3] = Math.round(outA * 255);
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
      const taper = smooth01(1 - Math.pow(nx, 1.42));
      const softEdge = smooth01(1 - d);
      const bristle = 0.76 + 0.24 * hashNoise(Math.floor(cx + ox * 5), Math.floor(cy + oy * 7), 911);
      blendPixel(pixels, size, cx + ox, cy + oy, color, alpha * taper * softEdge * bristle);
    }
  }
}

function drawPaintDot(pixels, size, cx, cy, radiusX, radiusY, angle, color, alpha = 1) {
  drawBrushStroke(pixels, size, cx, cy, radiusX * 2, radiusY * 2, angle, color, alpha);
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

function poolColorAt(pool, u, v, salt) {
  if (!pool.length) {
    return [128, 128, 128, 255];
  }
  const n = valueNoiseTile(u + salt * 0.0013, v - salt * 0.0017, 73, salt);
  return unpackColor(pool[Math.floor(clamp(n, 0, 0.999999) * pool.length)]);
}

function strandSignal(u, v, count, angle, salt = 0) {
  const coord = u * Math.cos(angle) + v * Math.sin(angle);
  const warp = (fbmTile(u, v, 12, salt, 3) - 0.5) * 0.050;
  return 0.5 + 0.5 * Math.sin((coord + warp) * Math.PI * 2 * count);
}

function lineSignal(u, v, count, angle, salt = 0, width = 0.05) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const warp = (fbmTile(u, v, 7, salt, 4) - 0.5) * 0.13;
  const line = Math.abs(fract((u * dx + v * dy + warp) * count) - 0.5);
  return smooth01((width - line) / Math.max(0.0001, width));
}

function fbmTile(u, v, cells, salt, octaves) {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  let frequency = Math.max(2, Math.round(cells));
  for (let i = 0; i < octaves; i++) {
    value += valueNoiseTile(u + i * 0.031, v - i * 0.027, frequency, salt + i * 31) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total > 0 ? value / total : 0;
}

function ridgedTile(u, v, cells, salt) {
  return 1 - Math.abs(fbmTile(u, v, cells, salt, 4) * 2 - 1);
}

function valueNoiseTile(u, v, cells, salt = 0) {
  const scale = Math.max(2, Math.round(cells));
  const gx = fract(u) * scale;
  const gy = fract(v) * scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const tx = smooth01(gx - ix);
  const ty = smooth01(gy - iy);
  const n00 = hashNoise(mod(ix, scale), mod(iy, scale), salt);
  const n10 = hashNoise(mod(ix + 1, scale), mod(iy, scale), salt);
  const n01 = hashNoise(mod(ix, scale), mod(iy + 1, scale), salt);
  const n11 = hashNoise(mod(ix + 1, scale), mod(iy + 1, scale), salt);
  return mix(mix(n00, n10, tx), mix(n01, n11, tx), ty);
}

function hashNoise(x, y, salt = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function readPngRgba(path) {
  const data = readFileSync(path);
  const signature = data.subarray(0, 8);
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!signature.equals(expected)) {
    throw new Error(`${path} is not a PNG file`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunkData = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      if (chunkData[12] !== 0) {
        throw new Error(`${path} uses interlacing; only non-interlaced PNG is supported`);
      }
    } else if (type === 'IDAT') {
      idat.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${path} must be 8-bit RGB or RGBA PNG`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const rows = Buffer.alloc(rowBytes * height);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channels ? rows[rowStart + x - channels] : 0;
      const up = y > 0 ? rows[rowStart - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= channels ? rows[rowStart - rowBytes + x - channels] : 0;
      const value = raw[input++];
      if (filter === 0) {
        rows[rowStart + x] = value;
      } else if (filter === 1) {
        rows[rowStart + x] = (value + left) & 255;
      } else if (filter === 2) {
        rows[rowStart + x] = (value + up) & 255;
      } else if (filter === 3) {
        rows[rowStart + x] = (value + Math.floor((left + up) / 2)) & 255;
      } else if (filter === 4) {
        rows[rowStart + x] = (value + paeth(left, up, upLeft)) & 255;
      } else {
        throw new Error(`${path} has unsupported PNG filter ${filter}`);
      }
    }
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < rows.length; i += channels, o += 4) {
    pixels[o] = rows[i];
    pixels[o + 1] = rows[i + 1];
    pixels[o + 2] = rows[i + 2];
    pixels[o + 3] = channels === 4 ? rows[i + 3] : 255;
  }
  return { width, height, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
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
    chunk('IDAT', deflateSync(raw, { level: 6 })),
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

function putPixel(pixels, index, color) {
  pixels[index] = Math.round(clamp(color[0], 0, 255));
  pixels[index + 1] = Math.round(clamp(color[1], 0, 255));
  pixels[index + 2] = Math.round(clamp(color[2], 0, 255));
  pixels[index + 3] = color.length > 3 ? Math.round(clamp(color[3], 0, 255)) : 255;
}

function packColor(r, g, b, a) {
  return ((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255);
}

function unpackColor(v) {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function addColor(color, r, g, b) {
  return [color[0] + r, color[1] + g, color[2] + b, color[3] ?? 255];
}

function colorMix(a, b, t) {
  const v = clamp(t, 0, 1);
  return [mix(a[0], b[0], v), mix(a[1], b[1], v), mix(a[2], b[2], v), mix(a[3] ?? 255, b[3] ?? 255, v)];
}

function gradeColor(color, exposure, saturation, lift = [0, 0, 0]) {
  const luma = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
  return [
    (luma + (color[0] - luma) * saturation) * exposure + lift[0],
    (luma + (color[1] - luma) * saturation) * exposure + lift[1],
    (luma + (color[2] - luma) * saturation) * exposure + lift[2],
    color[3] ?? 255,
  ];
}

function wrapCoord(v, size) {
  const n = Math.floor(v) % size;
  return n < 0 ? n + size : n;
}

function smooth01(t) {
  const v = clamp(t, 0, 1);
  return v * v * (3 - 2 * v);
}

function fract(v) {
  return v - Math.floor(v);
}

function mod(v, d) {
  const n = v % d;
  return n < 0 ? n + d : n;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

main();
