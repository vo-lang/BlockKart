import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  ['lowpoly_terrain_lod.glb', 11001n, 'lowpoly_terrain.vmg1', 2],
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
for (const [name, id, outputName, triangleStride] of sources) {
  const source = await readFile(resolve(sourceDir, name));
  const decoded = decodeGlb(source);
  const artifact = encodeVmg1(
    triangleStride === undefined ? decoded : decimateTriangles(decoded, triangleStride),
    id,
  );
  const output = resolve(outputDir, outputName ?? `${name.slice(0, -4)}.vmg1`);
  await writeFile(output, artifact);
  console.log(`${basename(output)} ${artifact.byteLength} bytes`);
}

function decimateTriangles(mesh, stride) {
  const remap = new Map();
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle += stride) {
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
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
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
      const base = positions.length / 3;
      for (const value of primitivePositions) positions.push(value);
      for (const value of primitiveNormals) normals.push(value);
      for (const value of primitiveTexcoords) texcoords.push(value);
      for (const index of primitiveIndices) indices.push(base + index);
    }
  }
  if (positions.length === 0 || indices.length === 0) throw new Error('GLB contains no triangles');
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texcoords: new Float32Array(texcoords),
    indices: new Uint32Array(indices),
  };
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
