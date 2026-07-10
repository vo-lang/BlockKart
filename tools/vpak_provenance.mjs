#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceModules = [
  { module: 'github.com/vo-lang/blockkart', root },
  { module: 'github.com/vo-lang/voplay', root: path.resolve(root, '../voplay') },
  { module: 'github.com/vo-lang/vogui', root: path.resolve(root, '../vogui') },
  { module: 'github.com/vo-lang/vopack', root: path.resolve(root, '../vopack') },
].sort((a, b) => b.module.length - a.module.length);
const packRelative = 'assets/blockkart.vpak';
const provenanceRelative = 'assets/blockkart.vpak.provenance.json';
const internalManifestPath = '.vopack/manifest.json';
const producerScripts = [
  'vo.mod',
  'vo.lock',
  'vo.work',
  'tools/pack_primitive_assets.vo',
  'tools/generate_primitive_terrain.mjs',
  'tools/paint_terrain_textures.mjs',
  'tools/terrain_heightfield_spec.mjs',
  'tools/terrain_recipe.mjs',
  'tools/vpak_provenance.mjs',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileFact(relative) {
  const bytes = readFileSync(path.join(root, relative));
  return { path: relative, sha256: sha256(bytes), size: bytes.length };
}

function workspaceFileFact(owner, base, relative) {
  const bytes = readFileSync(path.join(base, relative));
  return { path: `workspace:${owner}/${relative}`, sha256: sha256(bytes), size: bytes.length };
}

function voImports(source) {
  const imports = new Set();
  for (const match of source.matchAll(/\bimport\s+"([^"]+)"/g)) imports.add(match[1]);
  for (const block of source.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
    for (const match of block[1].matchAll(/"([^"]+)"/g)) imports.add(match[1]);
  }
  return [...imports];
}

function resolveWorkspacePackage(importPath) {
  const owner = workspaceModules.find((entry) => importPath === entry.module || importPath.startsWith(`${entry.module}/`));
  if (!owner) return null;
  return { ...owner, packagePath: importPath.slice(owner.module.length).replace(/^\//, '') };
}

function voWorkspaceSourceClosure() {
  const pending = voImports(readFileSync(path.join(root, 'tools/pack_primitive_assets.vo'), 'utf8'));
  const visitedPackages = new Set();
  const facts = [];
  const usedModules = new Set();
  while (pending.length > 0) {
    const importPath = pending.pop();
    const resolved = resolveWorkspacePackage(importPath);
    if (!resolved || visitedPackages.has(importPath)) continue;
    visitedPackages.add(importPath);
    usedModules.add(resolved.module);
    const packageDir = path.join(resolved.root, resolved.packagePath);
    const packageFiles = readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.vo'))
      .map((entry) => path.posix.join(resolved.packagePath, entry.name))
      .sort();
    for (const relative of packageFiles) {
      facts.push(workspaceFileFact(resolved.module, resolved.root, relative));
      pending.push(...voImports(readFileSync(path.join(resolved.root, relative), 'utf8')));
    }
  }
  for (const moduleName of [...usedModules].sort()) {
    const entry = workspaceModules.find((candidate) => candidate.module === moduleName);
    facts.push(workspaceFileFact(entry.module, entry.root, 'vo.mod'));
  }
  return facts.sort((a, b) => a.path.localeCompare(b.path));
}

function recursiveFiles(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [relative];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => recursiveFiles(path.posix.join(relative, entry.name)))
    .sort();
}

function readVpak() {
  const bytes = readFileSync(path.join(root, packRelative));
  if (bytes.length < 96 || bytes.subarray(0, 4).toString('utf8') !== 'VPAK') {
    throw new Error('invalid BlockKart vpak header');
  }
  const footer = bytes.subarray(bytes.length - 32);
  const pathPoolOffset = Number(footer.readBigUInt64LE(0));
  const pathPoolSize = Number(footer.readBigUInt64LE(8));
  const entryTableOffset = Number(footer.readBigUInt64LE(16));
  const entryCount = footer.readUInt32LE(24);
  const pathPool = bytes.subarray(pathPoolOffset, pathPoolOffset + pathPoolSize);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = entryTableOffset + index * 48;
    const pathOffset = bytes.readUInt32LE(offset);
    const pathLength = bytes.readUInt16LE(offset + 4);
    const compression = bytes.readUInt8(offset + 6);
    const dataOffset = Number(bytes.readBigUInt64LE(offset + 8));
    const rawSize = Number(bytes.readBigUInt64LE(offset + 16));
    const storedSize = Number(bytes.readBigUInt64LE(offset + 24));
    const checksum = bytes.readUInt32LE(offset + 32);
    const entryPath = pathPool.subarray(pathOffset, pathOffset + pathLength).toString('utf8');
    const stored = bytes.subarray(dataOffset, dataOffset + storedSize);
    if ((crc32(stored) >>> 0) !== checksum) {
      throw new Error(`vpak checksum mismatch: ${entryPath}`);
    }
    entries.push({ path: entryPath, compression, rawSize, storedSize, checksum, stored });
  }
  const manifestEntry = entries.find((entry) => entry.path === internalManifestPath);
  if (!manifestEntry || manifestEntry.compression !== 0) {
    throw new Error('vpak internal manifest is missing or compressed');
  }
  const manifest = JSON.parse(manifestEntry.stored.toString('utf8'));
  return { bytes, entries, manifest };
}

function canonicalProducer() {
  const { bytes, entries, manifest } = readVpak();
  const publicEntries = entries.filter((entry) => entry.path !== internalManifestPath);
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const assetByPath = new Map(assets.map((asset) => [asset.path, asset]));
  const entryPaths = publicEntries.map((entry) => entry.path).sort();
  const manifestPaths = assets.map((asset) => asset.path).sort();
  if (JSON.stringify(entryPaths) !== JSON.stringify(manifestPaths)) {
    throw new Error('vpak entry table and internal manifest asset set differ');
  }
  for (const asset of assets) {
    if (!asset.sourcePath || asset.sourcePath !== asset.path) {
      throw new Error(`vpak source path is not canonical: ${asset.path}`);
    }
    const source = readFileSync(path.join(root, asset.sourcePath));
    const sourceCrc = `crc32:${(crc32(source) >>> 0).toString(16).padStart(8, '0')}`;
    if (asset.contentHash !== sourceCrc) {
      throw new Error(`vpak source content hash mismatch: ${asset.path}`);
    }
    for (const dependency of asset.dependencies ?? []) {
      if (!assetByPath.has(dependency)) {
        throw new Error(`vpak dependency is not packed: ${asset.path} -> ${dependency}`);
      }
    }
  }
  const payloadInputs = [...new Set(assets.map((asset) => asset.sourcePath))].sort();
  const lineageInputs = [
    ...producerScripts,
    'terrain/recipes/primitive_concept_v1.json',
    'docs/images/terrain-upgrade-concept-v1.png',
    ...recursiveFiles('assets/source/terrain_painted'),
  ];
  const inputPaths = [...new Set([...payloadInputs, ...lineageInputs])].sort();
  const workspaceSourceInputs = voWorkspaceSourceClosure();
  const archiveEntries = publicEntries
    .map((entry) => {
      const asset = assetByPath.get(entry.path);
      const source = fileFact(asset.sourcePath);
      return {
        path: entry.path,
        kind: asset.type,
        sourcePath: asset.sourcePath,
        sourceSha256: source.sha256,
        sourceSize: source.size,
        contentHash: asset.contentHash,
        dependencies: [...(asset.dependencies ?? [])].sort(),
        compression: entry.compression,
        rawSize: entry.rawSize,
        storedSize: entry.storedSize,
        storedChecksum: entry.checksum,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const producer = {
    schemaVersion: 1,
    kind: 'blockkart.vpakProducerManifest',
    owner: 'BlockKart',
    command: ['vo', 'run', 'tools/pack_primitive_assets.vo'],
    pack: fileFact(packRelative),
    inputs: [...inputPaths.map(fileFact), ...workspaceSourceInputs].sort((a, b) => a.path.localeCompare(b.path)),
    workspaceSourceInputCount: workspaceSourceInputs.length,
    payloadInputCount: payloadInputs.length,
    archiveEntryCount: archiveEntries.length,
    archiveEntries,
    internalManifest: {
      pack: manifest.pack,
      version: manifest.version,
      assetCount: assets.length,
      sha256: sha256(JSON.stringify(manifest)),
    },
    upstream: [
      {
        id: 'primitive-terrain-assets',
        command: ['node', 'tools/generate_primitive_terrain.mjs'],
        inputs: [
          fileFact('tools/generate_primitive_terrain.mjs'),
          fileFact('tools/terrain_heightfield_spec.mjs'),
          fileFact('tools/terrain_recipe.mjs'),
          fileFact('terrain/recipes/primitive_concept_v1.json'),
          ...recursiveFiles('assets/source/terrain_painted').map(fileFact),
          fileFact('assets/effects/grass_card_atlas.png'),
        ],
        outputs: payloadInputs
          .filter((entry) => entry.startsWith('assets/maps/primitive_track/'))
          .map(fileFact),
      },
      {
        id: 'painted-terrain-textures',
        command: ['node', 'tools/paint_terrain_textures.mjs'],
        inputs: [
          fileFact('tools/paint_terrain_textures.mjs'),
          fileFact('docs/images/terrain-upgrade-concept-v1.png'),
          ...recursiveFiles('assets/source/terrain_painted').map(fileFact),
        ],
        outputs: [
          ...recursiveFiles('assets/source/terrain_painted').map(fileFact),
          fileFact('assets/effects/grass_card_atlas.png'),
        ],
      },
    ],
  };
  return { ...producer, producerDigest: sha256(JSON.stringify(producer)) };
}

function buildPack() {
  const voBin = process.env.VO_BIN;
  if (!voBin) throw new Error('VO_BIN is required for --build');
  execFileSync(voBin, ['run', 'tools/pack_primitive_assets.vo'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VOWORK: 'auto' },
  });
}

const mode = process.argv[2] ?? '--check';
if (mode === '--build') buildPack();
const producer = canonicalProducer();
const encoded = `${JSON.stringify(producer, null, 2)}\n`;
if (mode === '--build' || mode === '--write') {
  writeFileSync(path.join(root, provenanceRelative), encoded);
  console.log(`blockkart vpak provenance: wrote ${producer.archiveEntryCount} entries ${provenanceRelative}`);
} else if (mode === '--check') {
  if (!existsSync(path.join(root, provenanceRelative))) {
    throw new Error(`missing ${provenanceRelative}`);
  }
  const current = readFileSync(path.join(root, provenanceRelative), 'utf8');
  if (current !== encoded) throw new Error(`${provenanceRelative} is stale; rebuild the vpak producer manifest`);
  console.log(`blockkart vpak provenance: ok entries=${producer.archiveEntryCount} payloadInputs=${producer.payloadInputCount}`);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
