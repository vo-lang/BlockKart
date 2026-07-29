import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  ['lowpoly_terrain_lod.glb', 11001n, 'lowpoly_terrain_a.vmg1', 2, 0],
  ['lowpoly_terrain_lod.glb', 11010n, 'lowpoly_terrain_b.vmg1', 2, 1],
  ['road_asphalt.glb', 11002n],
  ['road_center_dashes.glb', 11003n],
  ['road_curbs.glb', 11004n],
  ['road_edge_lines.glb', 11005n],
  ['road_shoulders.glb', 11006n],
  ['road_edge_grime.glb', 11007n],
  ['road_tire_grime.glb', 11008n],
  ['hero_creek_ribbon.glb', 11009n],
];
const sourceDir = resolve(root, 'assets/maps/primitive_track');
const outputDir = resolve(root, 'generated/render');

await mkdir(outputDir, { recursive: true });
for (const [name, id, outputName, trianglePartitions, partitionIndex] of sources) {
  const source = await readFile(resolve(sourceDir, name));
  const decoded = decodeGlb(source);
  const artifact = encodeVmg1(
    trianglePartitions === undefined
      ? decoded
      : partitionTriangles(decoded, trianglePartitions, partitionIndex),
    id,
  );
  const output = resolve(outputDir, outputName ?? `${name.slice(0, -4)}.vmg1`);
  await writeFile(output, artifact);
  console.log(`${basename(output)} ${artifact.byteLength} bytes`);
}
const roadside = decodeRoadsidePrimitives(
  await readFile(resolve(sourceDir, 'roadside_primitives.bin')),
);
for (const chunk of buildRoadsideMeshes(roadside)) {
  const output = resolve(
    outputDir,
    `roadside_s${chunk.slot}_c${chunk.chunk}.vmg1`,
  );
  const artifact = encodeVmg1(chunk.mesh, chunk.id);
  await writeFile(output, artifact);
  console.log(`${basename(output)} ${artifact.byteLength} bytes`);
}
for (const kartMesh of buildHeroKartMeshes()) {
  const artifact = encodeVmg1(kartMesh.mesh, kartMesh.id);
  const output = resolve(outputDir, kartMesh.name);
  await writeFile(output, artifact);
  console.log(`${basename(output)} ${artifact.byteLength} bytes`);
}
for (const gameplayMesh of buildGameplayMeshes()) {
  const artifact = encodeVmg1(gameplayMesh.mesh, gameplayMesh.id);
  const output = resolve(outputDir, gameplayMesh.name);
  await writeFile(output, artifact);
  console.log(`${basename(output)} ${artifact.byteLength} bytes`);
}
for (const scenery of buildSceneryMeshes()) {
  const artifact = encodeVmg1(scenery.mesh, scenery.id);
  const output = resolve(outputDir, scenery.name);
  await writeFile(output, artifact);
  console.log(`${basename(output)} ${artifact.byteLength} bytes`);
}

function decodeRoadsidePrimitives(bytes) {
  if (
    bytes.byteLength < 20
    || bytes.readUInt32LE(0) !== 1280327510
    || bytes.readUInt32LE(4) !== 1
    || bytes.readUInt32LE(12) !== 8
  ) {
    throw new Error('invalid BlockKart roadside primitive layer');
  }
  const count = bytes.readUInt32LE(8);
  if (bytes.byteLength !== 20 + count * 92) {
    throw new Error('invalid BlockKart roadside primitive layout');
  }
  const instances = [];
  let offset = 20;
  for (let index = 0; index < count; index += 1) {
    const slot = bytes.readUInt32LE(offset);
    const flags = bytes.readUInt32LE(offset + 4);
    const position = readFloatVector(bytes, offset + 8, 3);
    const rotation = readFloatVector(bytes, offset + 20, 4);
    const scale = readFloatVector(bytes, offset + 36, 3);
    const tint = readFloatVector(bytes, offset + 48, 4);
    const atlas = readFloatVector(bytes, offset + 76, 4);
    if (slot >= 8) throw new Error('invalid BlockKart roadside primitive slot');
    instances.push({ slot, flags, position, rotation, scale, tint, atlas });
    offset += 92;
  }
  return instances;
}

function readFloatVector(bytes, offset, width) {
  return Array.from({ length: width }, (_, index) =>
    bytes.readFloatLE(offset + index * 4));
}

function buildRoadsideMeshes(instances) {
  const chunks = [];
  const maxVertices = 12_000;
  for (let slot = 0; slot < 8; slot += 1) {
    const template = roadsideTemplate(slot);
    const matching = instances.filter((instance) => instance.slot === slot);
    const perChunk = Math.max(1, Math.floor(maxVertices / template.positions.length));
    for (let start = 0, chunk = 0; start < matching.length; start += perChunk, chunk += 1) {
      const mesh = instantiateRoadsideTemplate(
        template,
        matching.slice(start, start + perChunk),
        slot,
      );
      chunks.push({
        slot,
        chunk,
        id: BigInt(11100 + slot * 20 + chunk),
        mesh,
      });
    }
  }
  return chunks;
}

function instantiateRoadsideTemplate(template, instances, slot) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (const instance of instances) {
    const base = positions.length / 3;
    for (let vertex = 0; vertex < template.positions.length; vertex += 1) {
      const local = template.positions[vertex];
      const scaled = [
        local[0] * instance.scale[0],
        local[1] * instance.scale[1],
        local[2] * instance.scale[2],
      ];
      const world = rotateQuaternion(scaled, instance.rotation);
      positions.push(
        world[0] + instance.position[0],
        world[1] + instance.position[1],
        world[2] + instance.position[2],
      );
      const normalScale = [
        template.normals[vertex][0] / Math.max(0.0001, instance.scale[0]),
        template.normals[vertex][1] / Math.max(0.0001, instance.scale[1]),
        template.normals[vertex][2] / Math.max(0.0001, instance.scale[2]),
      ];
      const normal = normalize3(rotateQuaternion(normalScale, instance.rotation));
      normals.push(...normal);
      const uv = template.texcoords[vertex];
      if (slot === 0 && instance.atlas[2] > 0 && instance.atlas[3] > 0) {
        texcoords.push(
          instance.atlas[0] + uv[0] * instance.atlas[2],
          instance.atlas[1] + uv[1] * instance.atlas[3],
        );
      } else {
        texcoords.push(...uv);
      }
    }
    for (const index of template.indices) indices.push(base + index);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texcoords: new Float32Array(texcoords),
    indices: new Uint32Array(indices),
  };
}

function roadsideTemplate(slot) {
  if (slot === 0) {
    return {
      positions: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]],
      normals: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
      texcoords: [[0, 1], [1, 1], [1, 0], [0, 0]],
      indices: [0, 1, 2, 0, 2, 3],
    };
  }
  if (slot === 5) return cylinderTemplate(6);
  if (slot === 6 || slot === 7) return octahedronTemplate();
  return beveledBoxTemplate(slot === 1 ? 0.06 : slot === 4 ? 0.34 : 0.20);
}

function cylinderTemplate(segments) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2;
    const x = Math.cos(angle) * 0.5;
    const z = Math.sin(angle) * 0.5;
    positions.push([x, -0.5, z], [x, 0.5, z]);
    normals.push([x * 2, 0, z * 2], [x * 2, 0, z * 2]);
    texcoords.push([segment / segments, 1], [segment / segments, 0]);
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const lower = segment * 2;
    const upper = lower + 1;
    const nextLower = next * 2;
    const nextUpper = nextLower + 1;
    indices.push(lower, nextLower, nextUpper, lower, nextUpper, upper);
  }
  return { positions, normals, texcoords, indices };
}

function octahedronTemplate() {
  const vertices = [
    [0, 0.5, 0], [0.5, 0, 0], [0, 0, 0.5], [-0.5, 0, 0],
    [0, 0, -0.5], [0, -0.5, 0],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4],
    [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1],
  ];
  return facetedTemplate(vertices, faces);
}

function icosahedronTemplate() {
  const phi = (1 + Math.sqrt(5)) / 2;
  const vertices = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ].map((value) => normalize3(value).map((component) => component * 0.5));
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return facetedTemplate(vertices, faces);
}

function uvSphereTemplate(longitudes, latitudes) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (let latitude = 0; latitude <= latitudes; latitude += 1) {
    const v = latitude / latitudes;
    const polar = v * Math.PI;
    const vertical = Math.cos(polar);
    const radius = Math.sin(polar);
    for (let longitude = 0; longitude <= longitudes; longitude += 1) {
      const u = longitude / longitudes;
      const azimuth = u * Math.PI * 2;
      const normal = [
        Math.sin(azimuth) * radius,
        vertical,
        Math.cos(azimuth) * radius,
      ];
      positions.push(normal.map((component) => component * 0.5));
      normals.push(normal);
      texcoords.push([u, v]);
    }
  }
  const stride = longitudes + 1;
  for (let latitude = 0; latitude < latitudes; latitude += 1) {
    for (let longitude = 0; longitude < longitudes; longitude += 1) {
      const a = latitude * stride + longitude;
      const b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions, normals, texcoords, indices };
}

function kartBodyTemplate() {
  const vertices = [
    [-0.50, -0.38, -0.48], [0.50, -0.38, -0.48],
    [0.50, -0.38, 0.50], [-0.50, -0.38, 0.50],
    [-0.36, 0.38, -0.40], [0.36, 0.38, -0.40],
    [0.43, 0.10, 0.46], [-0.43, 0.10, 0.46],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return facetedTemplate(vertices, faces);
}

function driverTorsoTemplate() {
  const vertices = [
    [-0.38, -0.5, -0.30], [0.38, -0.5, -0.30], [0.38, -0.5, 0.30], [-0.38, -0.5, 0.30],
    [-0.28, 0.5, -0.22], [0.28, 0.5, -0.22], [0.28, 0.5, 0.22], [-0.28, 0.5, 0.22],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return facetedTemplate(vertices, faces);
}

function wheelTemplate(segments) {
  const template = cylinderTemplate(segments);
  return {
    ...template,
    positions: template.positions.map(([x, y, z]) => [y, x, z]),
    normals: template.normals.map(([x, y, z]) => [y, x, z]),
  };
}

function torusTemplate(majorSegments, minorSegments, majorRadius, minorRadius) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (let major = 0; major < majorSegments; major += 1) {
    const majorAngle = major / majorSegments * Math.PI * 2;
    const majorCosine = Math.cos(majorAngle);
    const majorSine = Math.sin(majorAngle);
    for (let minor = 0; minor < minorSegments; minor += 1) {
      const minorAngle = minor / minorSegments * Math.PI * 2;
      const minorCosine = Math.cos(minorAngle);
      const minorSine = Math.sin(minorAngle);
      positions.push([
        minorSine * minorRadius,
        (majorRadius + minorCosine * minorRadius) * majorCosine,
        (majorRadius + minorCosine * minorRadius) * majorSine,
      ]);
      normals.push([
        minorSine,
        minorCosine * majorCosine,
        minorCosine * majorSine,
      ]);
      texcoords.push([major / majorSegments, minor / minorSegments]);
    }
  }
  for (let major = 0; major < majorSegments; major += 1) {
    const nextMajor = (major + 1) % majorSegments;
    for (let minor = 0; minor < minorSegments; minor += 1) {
      const nextMinor = (minor + 1) % minorSegments;
      const a = major * minorSegments + minor;
      const b = nextMajor * minorSegments + minor;
      const c = nextMajor * minorSegments + nextMinor;
      const d = major * minorSegments + nextMinor;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, normals, texcoords, indices };
}

function buildHeroKartMeshes() {
  const box = beveledBoxTemplate(0.28);
  const slimBox = beveledBoxTemplate(0.10);
  const sphere = uvSphereTemplate(20, 12);
  const cylinder = cylinderTemplate(16);
  const primary = mergeMeshes([
    meshFromTemplate(kartBodyTemplate(), [
      sceneInstanceEuler([0, 0.06, 0.04], [1.72, 0.56, 2.32], [0, 0, 0]),
      sceneInstanceEuler([0, 0.12, -1.20], [1.34, 0.44, 1.06], [0.05, 0, 0]),
    ]),
    meshFromTemplate(box, [
      sceneInstanceEuler([-0.94, 0.16, -0.18], [0.52, 0.42, 1.58], [0, 0.03, 0]),
      sceneInstanceEuler([0.94, 0.16, -0.18], [0.52, 0.42, 1.58], [0, -0.03, 0]),
      sceneInstanceEuler([-0.74, 0.28, 0.92], [0.62, 0.48, 0.72], [0, 0, 0]),
      sceneInstanceEuler([0.74, 0.28, 0.92], [0.62, 0.48, 0.72], [0, 0, 0]),
      sceneInstanceEuler([0, 0.16, -1.62], [1.64, 0.22, 0.26], [0, 0, 0]),
    ]),
    meshFromTemplate(sphere, [
      sceneInstanceEuler([-0.94, 0.24, -0.26], [0.58, 0.48, 1.48], [0, 0, 0]),
      sceneInstanceEuler([0.94, 0.24, -0.26], [0.58, 0.48, 1.48], [0, 0, 0]),
      sceneInstanceEuler([-0.73, 0.35, 0.89], [0.67, 0.52, 0.70], [0, 0, 0]),
      sceneInstanceEuler([0.73, 0.35, 0.89], [0.67, 0.52, 0.70], [0, 0, 0]),
    ]),
  ]);
  const rubber = mergeMeshes([
    meshFromTemplate(box, [
      sceneInstanceEuler([0, 0.68, 0.47], [0.82, 0.96, 0.46], [-0.18, 0, 0]),
      sceneInstanceEuler([0, -0.28, 0.08], [1.88, 0.14, 2.78], [0, 0, 0]),
      sceneInstanceEuler([0, 0.29, 1.20], [1.16, 0.56, 0.58], [0, 0, 0]),
      sceneInstanceEuler([0, 0.70, 1.03], [0.42, 0.34, 0.46], [-0.08, 0, 0]),
      sceneInstanceEuler([0, 0.08, -1.74], [2.12, 0.14, 0.16], [0, 0, 0]),
      sceneInstanceEuler([0, 0.10, 1.65], [2.24, 0.15, 0.18], [0, 0, 0]),
      sceneInstanceEuler([-1.14, 0.13, 0.03], [0.12, 0.14, 1.48], [0, 0, 0]),
      sceneInstanceEuler([1.14, 0.13, 0.03], [0.12, 0.14, 1.48], [0, 0, 0]),
    ]),
    meshFromTemplate(torusTemplate(18, 7, 0.29, 0.055), [
      sceneInstanceEuler([0, 0.87, -0.27], [1.0, 1.0, 1.0], [0.24, Math.PI * 0.5, 0]),
    ]),
  ]);
  const gold = mergeMeshes([
    meshFromTemplate(slimBox, [
      sceneInstanceEuler([0, 0.34, -1.47], [1.34, 0.08, 0.18], [0, 0, 0]),
      sceneInstanceEuler([0, 0.38, -1.13], [0.24, 0.08, 0.84], [0, 0, 0]),
      sceneInstanceEuler([-1.18, 0.22, -0.12], [0.10, 0.12, 1.46], [0, 0.02, 0]),
      sceneInstanceEuler([1.18, 0.22, -0.12], [0.10, 0.12, 1.46], [0, -0.02, 0]),
      sceneInstanceEuler([-0.96, 0.44, 0.58], [0.20, 0.055, 0.52], [0, 0, -0.04]),
      sceneInstanceEuler([0.96, 0.44, 0.58], [0.20, 0.055, 0.52], [0, 0, 0.04]),
      sceneInstanceEuler([0, 0.27, 1.66], [1.94, 0.12, 0.17], [0, 0, 0]),
      sceneInstanceEuler([-0.70, 0.56, 1.32], [0.11, 0.52, 0.11], [0, 0, -0.10]),
      sceneInstanceEuler([0.70, 0.56, 1.32], [0.11, 0.52, 0.11], [0, 0, 0.10]),
      sceneInstanceEuler([0, 1.65, 0.59], [0.07, 0.34, 0.055], [0, 0, 0]),
    ]),
    meshFromTemplate(torusTemplate(18, 6, 0.48, 0.025), [
      sceneInstanceEuler([0, 0.43, -1.26], [1.24, 0.72, 1], [Math.PI * 0.5, 0, 0]),
    ]),
  ]);
  const driver = meshFromTemplate(sphere, [
    sceneInstanceEuler([0, 1.44, 0.25], [0.66, 0.70, 0.68], [0, 0, 0]),
    sceneInstanceEuler([-0.31, 0.91, -0.20], [0.20, 0.20, 0.20], [0, 0, 0]),
    sceneInstanceEuler([0.31, 0.91, -0.20], [0.20, 0.20, 0.20], [0, 0, 0]),
  ]);
  const visor = meshFromTemplate(slimBox, [
    sceneInstanceEuler([0, 1.45, -0.10], [0.62, 0.22, 0.10], [-0.07, 0, 0]),
    sceneInstanceEuler([0, 0.74, 0.20], [0.56, 0.16, 0.40], [-0.18, 0, 0]),
    sceneInstanceEuler([0, 0.45, 1.51], [0.72, 0.10, 0.08], [0, 0, 0]),
    sceneInstanceEuler([0, 0.61, 1.51], [0.72, 0.08, 0.08], [0, 0, 0]),
  ]);
  const metal = mergeMeshes([
    meshFromTemplate(cylinder, [
      sceneInstanceEuler([-0.66, 0.18, 1.70], [0.25, 0.58, 0.25], [Math.PI * 0.5, 0, 0]),
      sceneInstanceEuler([0.66, 0.18, 1.70], [0.25, 0.58, 0.25], [Math.PI * 0.5, 0, 0]),
      sceneInstanceEuler([0, -0.11, 1.06], [0.15, 2.12, 0.15], [0, 0, Math.PI * 0.5]),
      sceneInstanceEuler([0, -0.11, -1.18], [0.14, 2.08, 0.14], [0, 0, Math.PI * 0.5]),
    ]),
    meshFromTemplate(slimBox, [
      sceneInstanceEuler([-0.72, -0.04, 0.94], [0.86, 0.08, 0.10], [0, -0.36, 0]),
      sceneInstanceEuler([0.72, -0.04, 0.94], [0.86, 0.08, 0.10], [0, 0.36, 0]),
      sceneInstanceEuler([-0.72, -0.04, -1.04], [0.86, 0.08, 0.10], [0, 0.36, 0]),
      sceneInstanceEuler([0.72, -0.04, -1.04], [0.86, 0.08, 0.10], [0, -0.36, 0]),
      sceneInstanceEuler([0, 0.36, 1.48], [0.90, 0.10, 0.10], [0, 0, 0]),
    ]),
  ]);
  const tailLights = meshFromTemplate(sphere, [
    sceneInstanceEuler([-0.70, 0.49, 1.54], [0.24, 0.18, 0.11], [0, 0, 0]),
    sceneInstanceEuler([0.70, 0.49, 1.54], [0.24, 0.18, 0.11], [0, 0, 0]),
  ]);
  const suitAccent = mergeMeshes([
    meshFromTemplate(driverTorsoTemplate(), [
      sceneInstanceEuler([0, 0.89, 0.32], [0.68, 0.84, 0.52], [-0.15, 0, 0]),
    ]),
    meshFromTemplate(sphere, [
      sceneInstanceEuler([-0.28, 1.05, 0.14], [0.32, 0.28, 0.32], [0, 0, 0]),
      sceneInstanceEuler([0.28, 1.05, 0.14], [0.32, 0.28, 0.32], [0, 0, 0]),
      sceneInstanceEuler([0, 1.44, 0.25], [0.18, 0.715, 0.695], [0, 0, 0]),
    ]),
    meshFromTemplate(slimBox, [
      sceneInstanceEuler([-0.25, 0.94, -0.10], [0.18, 0.16, 0.56], [0.48, 0, -0.08]),
      sceneInstanceEuler([0.25, 0.94, -0.10], [0.18, 0.16, 0.56], [0.48, 0, 0.08]),
      sceneInstanceEuler([0, 1.16, 0.55], [0.42, 0.11, 0.07], [-0.15, 0, 0]),
    ]),
  ]);

  const tire = meshFromTemplate(torusTemplate(20, 10, 0.33, 0.12), [
    sceneInstanceEuler([0, 0, 0], [1.0, 1.0, 1.0], [0, 0, 0]),
  ]);
  const rim = mergeMeshes([
    meshFromTemplate(torusTemplate(18, 7, 0.215, 0.045), [
      sceneInstanceEuler([0, 0, 0], [1.0, 1.0, 1.0], [0, 0, 0]),
    ]),
    meshFromTemplate(wheelTemplate(18), [
      sceneInstanceEuler([-0.105, 0, 0], [0.035, 0.46, 0.46], [0, 0, 0]),
      sceneInstanceEuler([0.105, 0, 0], [0.035, 0.46, 0.46], [0, 0, 0]),
    ]),
  ]);
  const hub = meshFromTemplate(wheelTemplate(18), [
    sceneInstanceEuler([0, 0, 0], [0.22, 0.28, 0.28], [0, 0, 0]),
  ]);
  const spokes = meshFromTemplate(slimBox, Array.from({ length: 8 }, (_, index) => {
    const angle = index / 8 * Math.PI * 2;
    return sceneInstanceEuler(
      [0, Math.cos(angle) * 0.14, Math.sin(angle) * 0.14],
      [0.11, 0.055, 0.32],
      [angle, 0, 0],
    );
  }));
  const wheelHighlight = meshFromTemplate(torusTemplate(18, 5, 0.255, 0.014), [
    sceneInstanceEuler([-0.112, 0, 0], [1.0, 1.0, 1.0], [0, 0, 0]),
    sceneInstanceEuler([0.112, 0, 0], [1.0, 1.0, 1.0], [0, 0, 0]),
  ]);

  return [
    { name: 'kart_body_p0.vmg1', id: 10002n, mesh: primary },
    { name: 'kart_body_p1.vmg1', id: 10003n, mesh: rubber },
    { name: 'kart_body_p2.vmg1', id: 10004n, mesh: gold },
    { name: 'kart_body_p3.vmg1', id: 10005n, mesh: driver },
    { name: 'kart_body_p4.vmg1', id: 10006n, mesh: visor },
    { name: 'kart_body_p5.vmg1', id: 10007n, mesh: metal },
    { name: 'kart_body_p6.vmg1', id: 10013n, mesh: tailLights },
    { name: 'kart_body_p7.vmg1', id: 10014n, mesh: suitAccent },
    { name: 'kart_wheel_p0.vmg1', id: 10008n, mesh: tire },
    { name: 'kart_wheel_p1.vmg1', id: 10009n, mesh: rim },
    { name: 'kart_wheel_p2.vmg1', id: 10010n, mesh: hub },
    { name: 'kart_wheel_p3.vmg1', id: 10011n, mesh: spokes },
    { name: 'kart_wheel_p4.vmg1', id: 10012n, mesh: wheelHighlight },
  ];
}

function buildGameplayMeshes() {
  const token = mergeMeshes([
    meshFromTemplate(torusTemplate(12, 5, 0.34, 0.07), [
      sceneInstanceEuler([0, 0, 0], [1, 1, 1], [0, Math.PI * 0.5, 0]),
    ]),
    meshFromTemplate(icosahedronTemplate(), [
      sceneInstanceEuler([0, 0, 0], [0.48, 0.48, 0.22], [0, 0, 0]),
    ]),
  ]);
  const barrel = mergeMeshes([
    meshFromTemplate(cylinderTemplate(12), [
      sceneInstanceEuler([0, 0, 0], [1.0, 1.55, 1.0], [0, 0, 0]),
    ]),
    meshFromTemplate(torusTemplate(12, 4, 0.50, 0.05), [
      sceneInstanceEuler([0, -0.45, 0], [1, 1, 1], [0, 0, 0]),
      sceneInstanceEuler([0, 0.45, 0], [1, 1, 1], [0, 0, 0]),
    ]),
  ]);
  const boostPad = mergeMeshes([
    meshFromTemplate(beveledBoxTemplate(0.08), [
      sceneInstanceEuler([0, 0, 0], [1.0, 0.12, 1.0], [0, 0, 0]),
    ]),
    meshFromTemplate(beveledBoxTemplate(0.10), [
      sceneInstanceEuler([-0.26, 0.10, 0.16], [0.16, 0.08, 0.48], [0, -0.55, 0]),
      sceneInstanceEuler([0.26, 0.10, 0.16], [0.16, 0.08, 0.48], [0, 0.55, 0]),
      sceneInstanceEuler([-0.26, 0.10, -0.24], [0.16, 0.08, 0.48], [0, -0.55, 0]),
      sceneInstanceEuler([0.26, 0.10, -0.24], [0.16, 0.08, 0.48], [0, 0.55, 0]),
    ]),
  ]);
  return [
    { name: 'gameplay_token.vmg1', id: 11400n, mesh: token },
    { name: 'gameplay_barrel.vmg1', id: 11401n, mesh: barrel },
    { name: 'gameplay_boost_pad.vmg1', id: 11402n, mesh: boostPad },
  ];
}

function meshFromTemplate(template, instances) {
  return instantiateRoadsideTemplate(template, instances, 99);
}

function mergeMeshes(meshes) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    for (const value of mesh.positions) positions.push(value);
    for (const value of mesh.normals) normals.push(value);
    for (const value of mesh.texcoords) texcoords.push(value);
    for (const index of mesh.indices) indices.push(base + index);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texcoords: new Float32Array(texcoords),
    indices: new Uint32Array(indices),
  };
}

function templateToMesh(template) {
  return {
    positions: new Float32Array(template.positions.flat()),
    normals: new Float32Array(template.normals.flat()),
    texcoords: new Float32Array(template.texcoords.flat()),
    indices: new Uint32Array(template.indices),
  };
}

function buildSceneryMeshes() {
  const points = [
    [19.6, 1.2, 367.5], [254.8, 1.8, 367.5], [411.6, 5.2, 313.6], [465.5, 9.8, 220.5],
    [313.6, 12.8, 107.8], [450.8, 16.0, -58.8], [396.9, 22.0, -254.8], [200.9, 26.5, -333.2],
    [-44.1, 24.5, -333.2], [-284.2, 20.0, -323.4], [-450.8, 15.0, -215.6],
    [-387.1, 9.8, -83.3], [-303.8, 6.5, 9.8], [-436.1, 4.2, 151.9], [-411.6, 2.6, 289.1],
    [-230.3, 1.6, 367.5],
  ];
  const trunks = [];
  const crowns = [];
  const darkCrowns = [];
  const broadleafCrowns = [];
  const fences = [];
  const rocks = [];
  const cliffs = [];
  const mountains = [];
  const signs = [];
  const chevrons = [];
  const tireBlack = [];
  const tireRed = [];
  const tireWhite = [];
  const snowcaps = [];
  const flowersGold = [];
  const flowersBlue = [];
  const paddockBlue = [];
  const paddockGold = [];
  const spectators = [];
  const grandstands = [];
  for (let segment = 0; segment < points.length; segment += 1) {
    const from = points[segment];
    const to = points[(segment + 1) % points.length];
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const length = Math.hypot(dx, dz);
    const right = [dz / length, 0, -dx / length];
    const yaw = Math.atan2(dx, dz);
    const samples = Math.max(1, Math.floor(length / 30));
    for (let sample = 0; sample < samples; sample += 1) {
      const along = (sample + 0.45) / samples;
      const base = [
        from[0] + dx * along,
        from[1] + (to[1] - from[1]) * along,
        from[2] + dz * along,
      ];
      for (const side of [-1, 1]) {
        const salt = segment * 97 + sample * 31 + (side > 0 ? 11 : 3);
        const distance = 24 + (salt % 7) * 4.3;
        const tree = [
          base[0] + right[0] * side * distance,
          base[1],
          base[2] + right[2] * side * distance,
        ];
        const treeScale = 0.82 + (salt % 5) * 0.09;
        trunks.push(sceneInstance(tree, [2.2 * treeScale, 8.5 * treeScale, 2.2 * treeScale], yaw));
        darkCrowns.push(sceneInstance(
          [tree[0], tree[1] + 7.2 * treeScale, tree[2]],
          [11.8 * treeScale, 11.2 * treeScale, 11.8 * treeScale],
          yaw,
        ));
        crowns.push(sceneInstance(
          [tree[0], tree[1] + 12.8 * treeScale, tree[2]],
          [8.6 * treeScale, 10.4 * treeScale, 8.6 * treeScale],
          yaw + 0.35,
        ));
        crowns.push(sceneInstance(
          [tree[0], tree[1] + 17.1 * treeScale, tree[2]],
          [5.4 * treeScale, 7.0 * treeScale, 5.4 * treeScale],
          yaw - 0.20,
        ));
        if ((salt + segment) % 3 !== 1) {
          const forestDistance = distance + 20 + salt % 9;
          const forestTree = [
            base[0] + right[0] * side * forestDistance +
              dx / length * ((salt % 5) - 2) * 2.3,
            base[1] + 0.4,
            base[2] + right[2] * side * forestDistance +
              dz / length * ((salt % 5) - 2) * 2.3,
          ];
          const forestScale = 0.58 + (salt % 4) * 0.08;
          trunks.push(sceneInstance(
            forestTree,
            [1.9 * forestScale, 7.0 * forestScale, 1.9 * forestScale],
            yaw + 0.2,
          ));
          darkCrowns.push(sceneInstance(
            [forestTree[0], forestTree[1] + 6.4 * forestScale, forestTree[2]],
            [10.2 * forestScale, 10.0 * forestScale, 10.2 * forestScale],
            yaw,
          ));
          crowns.push(sceneInstance(
            [forestTree[0], forestTree[1] + 11.0 * forestScale, forestTree[2]],
            [6.8 * forestScale, 8.2 * forestScale, 6.8 * forestScale],
            yaw + 0.4,
          ));
        }
        if ((salt + segment) % 4 === 0) {
          broadleafCrowns.push(sceneInstance(
            [
              tree[0] + right[0] * side * 5.2,
              tree[1] + 5.0 * treeScale,
              tree[2] + right[2] * side * 5.2,
            ],
            [8.0 * treeScale, 6.5 * treeScale, 8.0 * treeScale],
            yaw + 0.6,
          ));
        }
      }
      if (sample % 2 === 0) {
        const flowerSide = (sample + segment) % 4 < 2 ? -1 : 1;
        const flowerDistance = 17.2 + (sample % 3) * 1.4;
        const flowerBase = [
          base[0] + right[0] * flowerSide * flowerDistance,
          base[1] + 0.55,
          base[2] + right[2] * flowerSide * flowerDistance,
        ];
        const targetFlowers = (sample + segment) % 3 === 0 ? flowersBlue : flowersGold;
        for (let bloom = -2; bloom <= 2; bloom += 1) {
          targetFlowers.push(sceneInstanceEuler(
            [
              flowerBase[0] + dx / length * bloom * 0.9 + right[0] * flowerSide * Math.abs(bloom) * 0.25,
              flowerBase[1] + (Math.abs(bloom) % 2) * 0.2,
              flowerBase[2] + dz / length * bloom * 0.9 + right[2] * flowerSide * Math.abs(bloom) * 0.25,
            ],
            [0.38, 0.62, 0.38],
            [0, yaw + bloom * 0.4, 0],
          ));
        }
      }
      if (sample % 2 === 0) {
        for (const side of [-1, 1]) {
          const fenceDistance = 13.8;
          const center = [
            base[0] + right[0] * side * fenceDistance,
            base[1] + 1.0,
            base[2] + right[2] * side * fenceDistance,
          ];
          fences.push(sceneInstance(center, [0.45, 2.4, 0.45], yaw));
          fences.push(sceneInstance(
            [center[0] + dx / length * 3.2, center[1] + 0.35, center[2] + dz / length * 3.2],
            [0.34, 0.34, 7.0],
            yaw,
          ));
        }
      }
      if (sample % 3 === 1) {
        const rockDistance = 18 + (segment % 4) * 3;
        rocks.push(sceneInstance(
          [
            base[0] - right[0] * rockDistance,
            base[1] + 0.7,
            base[2] - right[2] * rockDistance,
          ],
          [2.8 + segment % 3, 2.0 + sample % 2, 2.5 + sample % 3],
          yaw + sample,
        ));
      }
      if (sample % 5 === 2 && (segment < 4 || segment > 12 || segment === 7 || segment === 8)) {
        for (const side of [-1, 1]) {
          const tireCenter = [
            base[0] + right[0] * side * 11.4,
            base[1] + 0.72,
            base[2] + right[2] * side * 11.4,
          ];
          const stack = (segment + sample + (side > 0 ? 1 : 0)) % 3;
          const target = stack === 0 ? tireRed : stack === 1 ? tireWhite : tireBlack;
          target.push(sceneInstanceEuler(
            tireCenter,
            [0.92, 1.32, 1.32],
            [0, yaw, 0],
          ));
        }
      }
    }
    if (segment % 3 === 0) {
      const side = segment % 2 === 0 ? 1 : -1;
      const center = [
        from[0] + right[0] * side * 15,
        from[1] + 3.2,
        from[2] + right[2] * side * 15,
      ];
      signs.push(sceneInstance(center, [6.0, 3.2, 0.55], yaw));
      for (let arrow = -1; arrow <= 1; arrow += 1) {
        const offset = arrow * 1.55;
        const arrowCenter = [
          center[0] + right[0] * offset - dx / length * 0.34,
          center[1],
          center[2] + right[2] * offset - dz / length * 0.34,
        ];
        chevrons.push(
          sceneInstanceEuler(
            [arrowCenter[0] - right[0] * 0.34, arrowCenter[1] + 0.46, arrowCenter[2] - right[2] * 0.34],
            [1.18, 0.27, 0.12],
            [0, yaw, 0.68],
          ),
          sceneInstanceEuler(
            [arrowCenter[0] - right[0] * 0.34, arrowCenter[1] - 0.46, arrowCenter[2] - right[2] * 0.34],
            [1.18, 0.27, 0.12],
            [0, yaw, -0.68],
          ),
        );
      }
    }
  }
  for (const instance of [
    [[330, 18, 280], [54, 38, 44], 0.3],
    [[372, 24, 252], [46, 52, 38], 0.9],
    [[-338, 20, 302], [60, 42, 48], 0.1],
    [[-430, 27, -15], [56, 60, 46], 0.6],
    [[420, 31, -160], [64, 70, 52], -0.4],
    [[-180, 38, -405], [82, 78, 64], 0.8],
  ]) {
    cliffs.push(sceneInstance(instance[0], instance[1], instance[2]));
  }
  for (const instance of [
    [[-455, 68, -490], [155, 190, 135], 0.1],
    [[-180, 82, -548], [170, 230, 150], -0.2],
    [[125, 75, -560], [182, 215, 152], 0.3],
    [[420, 72, -500], [150, 205, 138], -0.4],
    [[-555, 58, 90], [130, 175, 122], 0.2],
    [[560, 64, 80], [135, 185, 128], -0.1],
  ]) {
    mountains.push(sceneInstance(instance[0], instance[1], instance[2]));
    snowcaps.push(sceneInstance(
      [instance[0][0], instance[0][1] + instance[1][1] * 0.31, instance[0][2]],
      [instance[1][0] * 0.42, instance[1][1] * 0.34, instance[1][2] * 0.42],
      instance[2],
    ));
  }

  for (const x of [112, 148, 184, 220]) {
    const side = x % 72 === 4 ? -1 : 1;
    const z = side < 0 ? 329 : 405;
    const target = x % 72 === 4 ? paddockBlue : paddockGold;
    target.push(sceneInstanceEuler([x, 4.4, z], [8.8, 7.4, 8.8], [0, Math.PI * 0.25, 0]));
    grandstands.push(
      sceneInstanceEuler([x, 0.9, z], [9.5, 1.3, 7.5], [0, Math.PI * 0.5, 0]),
      sceneInstanceEuler([x, 2.3, z + side * 3.2], [9.5, 1.1, 2.1], [0, Math.PI * 0.5, 0]),
    );
    for (let row = 0; row < 2; row += 1) {
      for (let person = -3; person <= 3; person += 1) {
        spectators.push(sceneInstanceEuler(
          [x + person * 2.0, 3.8 + row * 1.6, z + side * (1.6 + row * 2.2)],
          [0.74, 1.15, 0.74],
          [0, 0, 0],
        ));
      }
    }
  }

  const lodgeWood = [
    sceneInstanceEuler([318, 6.8, 402], [24, 10, 18], [0, -0.22, 0]),
    sceneInstanceEuler([318, 16.4, 402], [22, 9, 16], [0, -0.22, 0]),
    sceneInstanceEuler([296, 5.0, 402], [2.2, 12, 2.2], [0, 0, 0]),
    sceneInstanceEuler([340, 5.0, 402], [2.2, 12, 2.2], [0, 0, 0]),
    sceneInstanceEuler([318, 9.2, 382], [24, 1.0, 2.2], [0, -0.22, 0]),
  ];
  const lodgeRoof = [
    sceneInstanceEuler([318, 23.2, 397], [28, 1.1, 13], [0.58, -0.22, 0]),
    sceneInstanceEuler([318, 23.2, 407], [28, 1.1, 13], [-0.58, -0.22, 0]),
  ];
  const lodgePlaster = [
    sceneInstanceEuler([318, 15.8, 391.5], [18, 6.6, 1.0], [0, -0.22, 0]),
    sceneInstanceEuler([318, 15.8, 412.5], [18, 6.6, 1.0], [0, -0.22, 0]),
  ];
  const lodgeWindows = [
    sceneInstanceEuler([310, 16.4, 390.8], [3.8, 3.0, 0.35], [0, -0.22, 0]),
    sceneInstanceEuler([326, 16.4, 390.8], [3.8, 3.0, 0.35], [0, -0.22, 0]),
  ];
  const raceBanners = [
    sceneInstanceEuler([164, 7.0, 335], [18, 4.0, 0.35], [0, 0, 0]),
    sceneInstanceEuler([-340, 12.0, -260], [22, 4.5, 0.35], [0, 0.7, 0]),
  ];
  return [
    sceneryMesh('scenery_tree_trunks.vmg1', 11300n, cylinderTemplate(8), trunks),
    sceneryMesh('scenery_tree_crowns.vmg1', 11301n, coneTemplate(8), crowns),
    sceneryMesh('scenery_fences.vmg1', 11302n, beveledBoxTemplate(0.18), fences),
    sceneryMesh('scenery_rocks.vmg1', 11303n, icosahedronTemplate(), rocks),
    sceneryMesh('scenery_signs.vmg1', 11304n, beveledBoxTemplate(0.12), signs),
    sceneryMesh('scenery_tree_crowns_dark.vmg1', 11305n, coneTemplate(8), darkCrowns),
    sceneryMesh('scenery_broadleaf.vmg1', 11306n, icosahedronTemplate(), broadleafCrowns),
    sceneryMesh('scenery_cliffs.vmg1', 11307n, icosahedronTemplate(), cliffs),
    sceneryMesh('scenery_mountains.vmg1', 11308n, coneTemplate(7), mountains),
    sceneryMesh('scenery_chevrons.vmg1', 11309n, beveledBoxTemplate(0.14), chevrons),
    sceneryMesh('scenery_tire_black.vmg1', 11310n, wheelTemplate(10), tireBlack),
    sceneryMesh('scenery_tire_red.vmg1', 11311n, wheelTemplate(10), tireRed),
    sceneryMesh('scenery_tire_white.vmg1', 11312n, wheelTemplate(10), tireWhite),
    sceneryMesh('scenery_lodge_wood.vmg1', 11313n, beveledBoxTemplate(0.24), lodgeWood),
    sceneryMesh('scenery_lodge_roof.vmg1', 11314n, beveledBoxTemplate(0.12), lodgeRoof),
    sceneryMesh('scenery_lodge_plaster.vmg1', 11315n, beveledBoxTemplate(0.18), lodgePlaster),
    sceneryMesh('scenery_lodge_windows.vmg1', 11316n, beveledBoxTemplate(0.08), lodgeWindows),
    sceneryMesh('scenery_race_banners.vmg1', 11317n, beveledBoxTemplate(0.10), raceBanners),
    sceneryMesh('scenery_snowcaps.vmg1', 11318n, coneTemplate(7), snowcaps),
    sceneryMesh('scenery_flowers_gold.vmg1', 11319n, icosahedronTemplate(), flowersGold),
    sceneryMesh('scenery_flowers_blue.vmg1', 11320n, icosahedronTemplate(), flowersBlue),
    sceneryMesh('scenery_paddock_blue.vmg1', 11321n, coneTemplate(4), paddockBlue),
    sceneryMesh('scenery_paddock_gold.vmg1', 11322n, coneTemplate(4), paddockGold),
    sceneryMesh('scenery_spectators.vmg1', 11323n, uvSphereTemplate(8, 5), spectators),
    sceneryMesh('scenery_grandstands.vmg1', 11324n, beveledBoxTemplate(0.18), grandstands),
  ];
}

function sceneryMesh(name, id, template, instances) {
  return { name, id, mesh: instantiateRoadsideTemplate(template, instances, 99) };
}

function sceneInstance(position, scale, yaw) {
  const half = yaw * 0.5;
  return {
    slot: 0,
    position,
    scale,
    rotation: [0, Math.sin(half), 0, Math.cos(half)],
    tint: [1, 1, 1, 1],
    atlas: [0, 0, 0, 0],
  };
}

function sceneInstanceEuler(position, scale, rotation) {
  const [rx, ry, rz] = rotation;
  const sx = Math.sin(rx * 0.5);
  const cx = Math.cos(rx * 0.5);
  const sy = Math.sin(ry * 0.5);
  const cy = Math.cos(ry * 0.5);
  const sz = Math.sin(rz * 0.5);
  const cz = Math.cos(rz * 0.5);
  return {
    slot: 0,
    position,
    scale,
    rotation: [
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz,
    ],
    tint: [1, 1, 1, 1],
    atlas: [0, 0, 0, 0],
  };
}

function coneTemplate(segments) {
  const vertices = [[0, 0.5, 0]];
  for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2;
    vertices.push([Math.cos(angle) * 0.5, -0.5, Math.sin(angle) * 0.5]);
  }
  const faces = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const current = 1 + segment;
    const next = 1 + (segment + 1) % segments;
    faces.push([0, next, current]);
    if (segment >= 1 && segment < segments - 1) faces.push([1, current, next]);
  }
  return facetedTemplate(vertices, faces);
}

function beveledBoxTemplate(bevel) {
  const height = Math.max(0.18, bevel);
  const vertices = [
    [-0.5, -height, -0.5], [0.5, -height, -0.5], [0.5, -height, 0.5], [-0.5, -height, 0.5],
    [-0.38, height, -0.38], [0.38, height, -0.38], [0.38, height, 0.38], [-0.38, height, 0.38],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return facetedTemplate(vertices, faces);
}

function facetedTemplate(vertices, faces) {
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (const face of faces) {
    const edgeA = subtract3(vertices[face[1]], vertices[face[0]]);
    const edgeB = subtract3(vertices[face[2]], vertices[face[0]]);
    const normal = normalize3(cross3(edgeA, edgeB));
    const base = positions.length;
    for (let corner = 0; corner < 3; corner += 1) {
      positions.push(vertices[face[corner]]);
      normals.push(normal);
      texcoords.push(corner === 0 ? [0, 0] : corner === 1 ? [1, 0] : [0.5, 1]);
      indices.push(base + corner);
    }
  }
  return { positions, normals, texcoords, indices };
}

function rotateQuaternion(vector, quaternion) {
  const [x, y, z, w] = quaternion;
  const dot = x * vector[0] + y * vector[1] + z * vector[2];
  const cross = [
    y * vector[2] - z * vector[1],
    z * vector[0] - x * vector[2],
    x * vector[1] - y * vector[0],
  ];
  const scale = w * w - x * x - y * y - z * z;
  return [
    2 * dot * x + scale * vector[0] + 2 * w * cross[0],
    2 * dot * y + scale * vector[1] + 2 * w * cross[1],
    2 * dot * z + scale * vector[2] + 2 * w * cross[2],
  ];
}

function subtract3(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize3(vector) {
  const length = Math.hypot(...vector);
  return length > 0.000001
    ? [vector[0] / length, vector[1] / length, vector[2] / length]
    : [0, 1, 0];
}

function partitionTriangles(mesh, partitions, partitionIndex) {
  const remap = new Map();
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (let triangle = partitionIndex; triangle < mesh.indices.length / 3; triangle += partitions) {
    for (let corner = 0; corner < 3; corner += 1) {
      const sourceIndex = mesh.indices[triangle * 3 + corner];
      let targetIndex = remap.get(sourceIndex);
      if (targetIndex === undefined) {
        targetIndex = remap.size;
        remap.set(sourceIndex, targetIndex);
        for (let component = 0; component < 3; component += 1) {
          positions.push(mesh.positions[sourceIndex * 3 + component]);
          normals.push(mesh.normals[sourceIndex * 3 + component]);
        }
        for (let component = 0; component < 2; component += 1) {
          texcoords.push(mesh.texcoords[sourceIndex * 2 + component]);
        }
      }
      indices.push(targetIndex);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texcoords: new Float32Array(texcoords),
    indices: new Uint32Array(indices),
  };
}

function decodeGlb(bytes) {
  const { json, binary } = decodeGlbDocument(bytes);
  const primitives = decodeGlbPrimitiveRecords(json, binary);
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (const primitive of primitives) {
    const base = positions.length / 3;
    for (const value of primitive.positions) positions.push(value);
    for (const value of primitive.normals) normals.push(value);
    for (const value of primitive.texcoords) texcoords.push(value);
    for (const index of primitive.indices) indices.push(base + index);
  }
  if (positions.length === 0 || indices.length === 0) throw new Error('GLB contains no triangles');
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texcoords: new Float32Array(texcoords),
    indices: new Uint32Array(indices),
  };
}

function decodeGlbPrimitives(bytes) {
  const { json, binary } = decodeGlbDocument(bytes);
  return decodeGlbPrimitiveRecords(json, binary);
}

function decodeGlbDocument(bytes) {
  if (
    bytes.byteLength < 20
    || bytes.readUInt32LE(0) !== 0x46546c67
    || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.byteLength
  ) {
    throw new Error('invalid GLB header');
  }
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < bytes.byteLength) {
    const length = bytes.readUInt32LE(offset);
    const kind = bytes.readUInt32LE(offset + 4);
    offset += 8;
    const chunk = bytes.subarray(offset, offset + length);
    offset += length;
    if (kind === 0x4e4f534a) {
      json = JSON.parse(chunk.toString('utf8').replace(/\0+$/u, ''));
    } else if (kind === 0x004e4942) {
      binary = chunk;
    }
  }
  if (json === null || binary === null) throw new Error('GLB is missing JSON or BIN');
  return { json, binary };
}

function decodeGlbPrimitiveRecords(json, binary) {
  const primitives = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) throw new Error('only triangle GLB primitives are supported');
      const primitivePositions = readAccessor(json, binary, primitive.attributes.POSITION, 3);
      const primitiveNormals = primitive.attributes.NORMAL === undefined
        ? new Float32Array(primitivePositions.length)
        : readAccessor(json, binary, primitive.attributes.NORMAL, 3);
      const primitiveTexcoords = primitive.attributes.TEXCOORD_0 === undefined
        ? new Float32Array(primitivePositions.length / 3 * 2)
        : readAccessor(json, binary, primitive.attributes.TEXCOORD_0, 2);
      const primitiveIndices = readIndices(json, binary, primitive.indices);
      primitives.push({
        positions: primitivePositions,
        normals: primitiveNormals,
        texcoords: primitiveTexcoords,
        indices: primitiveIndices,
      });
    }
  }
  if (primitives.length === 0) throw new Error('GLB contains no triangles');
  return primitives;
}

function readAccessor(json, binary, accessorIndex, width) {
  if (accessorIndex === undefined) throw new Error('missing GLB accessor');
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  if (accessor.componentType !== 5126 || accessor.type !== `VEC${width}` || accessor.sparse) {
    throw new Error('unsupported GLB vertex accessor');
  }
  const stride = view.byteStride ?? width * 4;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Float32Array(accessor.count * width);
  for (let element = 0; element < accessor.count; element += 1) {
    for (let component = 0; component < width; component += 1) {
      values[element * width + component] =
        binary.readFloatLE(start + element * stride + component * 4);
    }
  }
  return values;
}

function readIndices(json, binary, accessorIndex) {
  if (accessorIndex === undefined) throw new Error('non-indexed GLB primitives are unsupported');
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const bytes = accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 0;
  if (bytes === 0 || accessor.type !== 'SCALAR' || accessor.sparse) {
    throw new Error('unsupported GLB index accessor');
  }
  const stride = view.byteStride ?? bytes;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Uint32Array(accessor.count);
  for (let index = 0; index < accessor.count; index += 1) {
    values[index] = bytes === 4
      ? binary.readUInt32LE(start + index * stride)
      : binary.readUInt16LE(start + index * stride);
  }
  return values;
}

function encodeVmg1(mesh, id) {
  const vertexCount = mesh.positions.length / 3;
  const output = Buffer.alloc(21 + vertexCount * 32 + mesh.indices.length * 4);
  output.write('VMG1', 0, 'ascii');
  output.writeBigUInt64LE(id, 4);
  output.writeUInt32LE(vertexCount, 12);
  output.writeUInt32LE(mesh.indices.length, 16);
  output[20] = 0;
  let offset = 21;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let component = 0; component < 3; component += 1) {
      output.writeFloatLE(mesh.positions[vertex * 3 + component], offset);
      offset += 4;
    }
    for (let component = 0; component < 3; component += 1) {
      output.writeFloatLE(mesh.normals[vertex * 3 + component], offset);
      offset += 4;
    }
    for (let component = 0; component < 2; component += 1) {
      output.writeFloatLE(mesh.texcoords[vertex * 2 + component], offset);
      offset += 4;
    }
  }
  for (const index of mesh.indices) {
    output.writeUInt32LE(index, offset);
    offset += 4;
  }
  return output;
}
