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
const authoredKartSources = [
  ['kart_body', resolve(root, 'assets/models/kart/kart_body.glb'), 10002n],
  ['kart_wheel', resolve(root, 'assets/models/kart/kart_wheel.glb'), 10008n],
];
for (const [name, sourcePath, firstId] of authoredKartSources) {
  const primitives = decodeGlbPrimitives(await readFile(sourcePath));
  for (let index = 0; index < primitives.length; index += 1) {
    const id = firstId + BigInt(index);
    const artifact = encodeVmg1(primitives[index], id);
    const output = resolve(outputDir, `${name}_p${index}.vmg1`);
    await writeFile(output, artifact);
    console.log(`${basename(output)} ${artifact.byteLength} bytes`);
  }
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
    [19.6, 1.2, 367.5], [254.8, 1.25, 367.5], [411.6, 1.54, 313.6], [465.5, 1.89, 220.5],
    [313.6, 2.08, 107.8], [450.8, 2.43, -58.8], [396.9, 2.72, -254.8], [200.9, 2.86, -333.2],
    [-44.1, 2.77, -333.2], [-284.2, 2.52, -323.4], [-450.8, 2.23, -215.6],
    [-387.1, 1.89, -83.3], [-303.8, 1.69, 9.8], [-436.1, 1.4, 151.9], [-411.6, 1.25, 289.1],
    [-230.3, 1.2, 367.5],
  ];
  const trunks = [];
  const crowns = [];
  const fences = [];
  const rocks = [];
  const signs = [];
  for (let segment = 0; segment < points.length; segment += 1) {
    const from = points[segment];
    const to = points[(segment + 1) % points.length];
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const length = Math.hypot(dx, dz);
    const right = [dz / length, 0, -dx / length];
    const yaw = Math.atan2(dx, dz);
    const samples = Math.max(1, Math.floor(length / 58));
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
        crowns.push(sceneInstance(
          [tree[0], tree[1] + 8.1 * treeScale, tree[2]],
          [10.5 * treeScale, 12.5 * treeScale, 10.5 * treeScale],
          yaw,
        ));
        crowns.push(sceneInstance(
          [tree[0], tree[1] + 13.0 * treeScale, tree[2]],
          [7.4 * treeScale, 9.2 * treeScale, 7.4 * treeScale],
          yaw + 0.35,
        ));
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
    }
    if (segment % 3 === 0) {
      const side = segment % 2 === 0 ? 1 : -1;
      const center = [
        from[0] + right[0] * side * 15,
        from[1] + 3.2,
        from[2] + right[2] * side * 15,
      ];
      signs.push(sceneInstance(center, [6.0, 3.2, 0.55], yaw));
    }
  }
  return [
    sceneryMesh('scenery_tree_trunks.vmg1', 11300n, cylinderTemplate(8), trunks),
    sceneryMesh('scenery_tree_crowns.vmg1', 11301n, coneTemplate(8), crowns),
    sceneryMesh('scenery_fences.vmg1', 11302n, beveledBoxTemplate(0.18), fences),
    sceneryMesh('scenery_rocks.vmg1', 11303n, icosahedronTemplate(), rocks),
    sceneryMesh('scenery_signs.vmg1', 11304n, beveledBoxTemplate(0.12), signs),
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
