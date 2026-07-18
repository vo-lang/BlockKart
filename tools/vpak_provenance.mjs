#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const HEADER_SIZE = 64;
const ENTRY_SIZE = 48;
const FOOTER_SIZE = 32;
const DEFAULT_ALIGNMENT = 16;
const EXPECTED_PAYLOAD_COUNT = 37;
const MAX_VPAK_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_OBSERVED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1024;
const MAX_IMPORTS = 4096;
const MAX_PACKAGES = 1024;
const MAX_SNAPSHOT_EDGES = 100_000;
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 64;
const MAX_PATH_BYTES = 1024;
const MAX_VPAK_PATH_BYTES = 4096;
const MAX_TOTAL_PATH_BYTES = 4 * 1024 * 1024;
const JSON_LIMITS = Object.freeze({
  maxJsonBytes: MAX_METADATA_BYTES,
  maxJsonCollectionEntries: 4096,
  maxJsonDepth: 64,
  maxJsonObjectKeys: 128,
  maxJsonTokens: 100_000,
  maxJsonTotalCollectionEntries: 20_000,
  maxJsonTotalObjectKeyBytes: 1024 * 1024,
  maxObjectKeyBytes: 256,
});
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameNativePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toUpperCase() === normalizedRight.toUpperCase()
    : normalizedLeft === normalizedRight;
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameNodeIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size;
}

function canonicalDirectory(candidate, label) {
  const canonical = realpathSync.native(path.resolve(candidate));
  const metadata = lstatSync(canonical, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a real directory: ${candidate}`);
  }
  return canonical;
}

const root = canonicalDirectory(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'BlockKart root',
);
const packRelative = 'assets/blockkart.vpak';
const provenanceRelative = 'assets/blockkart.vpak.provenance.json';
const transactionDirectoryEnvironment = 'BLOCKKART_VPAK_TRANSACTION_DIR';
const packOutputEnvironment = 'BLOCKKART_VPAK_OUTPUT';
const internalManifestPath = '.vopack/manifest.json';
const producerScripts = [
  '.gitattributes',
  'vo.mod',
  'vo.work',
  'tools/pack_primitive_assets.vo',
  'tools/generate_primitive_terrain.mjs',
  'tools/paint_terrain_textures.mjs',
  'tools/terrain_heightfield_spec.mjs',
  'tools/terrain_recipe.mjs',
  'tools/vpak_provenance.mjs',
];

const fileObservations = new Map();
const directoryObservations = new Map();
const sourceRootObservations = new Map();
const observedPaths = new Set();
let voBinaryObservation;
let observedBytes = 0;
let observedPathBytes = 0;
let walkEntries = 0;

function resolveProducerOutputs() {
  const requested = process.env[transactionDirectoryEnvironment];
  if (requested === undefined || requested === '') {
    return Object.freeze({
      pack: packRelative,
      provenance: provenanceRelative,
      transactionDirectory: null,
    });
  }
  if (
    typeof requested !== 'string'
    || !path.isAbsolute(requested)
    || /[\u0000-\u001f\u007f]/u.test(requested)
  ) {
    throw new Error(`${transactionDirectoryEnvironment} must be an absolute path without control characters`);
  }
  const resolved = path.resolve(requested);
  const canonical = realpathSync.native(resolved);
  const metadata = lstatSync(resolved, { bigint: true });
  const assetsDirectory = canonicalDirectory(path.join(root, 'assets'), 'BlockKart assets root');
  if (
    !sameNativePath(requested, resolved)
    || !sameNativePath(canonical, resolved)
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !sameNativePath(path.dirname(resolved), assetsDirectory)
    || !/^\.blockkart-vpak-transaction-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(path.basename(resolved))
  ) {
    throw new Error(
      `${transactionDirectoryEnvironment} must name a real direct child of assets with a producer transaction name`,
    );
  }
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  return Object.freeze({
    pack: `${relative}/blockkart.vpak`,
    provenance: `${relative}/blockkart.vpak.provenance.json`,
    transactionDirectory: resolved,
  });
}

const producerOutputs = resolveProducerOutputs();

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function portableCollisionKey(relative) {
  return relative.toLowerCase();
}

function validatePortableComponent(component, label, { requireLowercase = false } = {}) {
  if (
    typeof component !== 'string'
    || component.length === 0
    || component === '.'
    || component === '..'
    || !(requireLowercase ? /^[a-z0-9._-]+$/u : /^[A-Za-z0-9._-]+$/u).test(component)
    || Buffer.byteLength(component, 'utf8') > 255
    || component.endsWith('.')
    || component.endsWith(' ')
    || WINDOWS_RESERVED_NAMES.has(component.split('.')[0].toUpperCase())
  ) {
    throw new Error(`${label} is not a portable path component: ${JSON.stringify(component)}`);
  }
}

function validatePortableRelative(
  relative,
  label,
  {
    allowEmpty = false,
    allowInternalManifest = false,
    maxBytes = MAX_PATH_BYTES,
    requireLowercase = false,
    reserveVopackNamespace = false,
  } = {},
) {
  if (allowEmpty && relative === '') return [];
  if (
    typeof relative !== 'string'
    || relative.length === 0
    || relative.includes('\\')
    || relative.includes('\0')
    || relative.startsWith('/')
    || path.posix.isAbsolute(relative)
    || Buffer.byteLength(relative, 'utf8') > maxBytes
  ) {
    throw new Error(`${label} is not a bounded portable relative path: ${JSON.stringify(relative)}`);
  }
  const components = relative.split('/');
  for (const component of components) {
    validatePortableComponent(component, label, { requireLowercase });
  }
  if (
    reserveVopackNamespace
    && components[0] === '.vopack'
    && (!allowInternalManifest || relative !== internalManifestPath)
  ) {
    throw new Error(`${label} uses the reserved .vopack namespace: ${JSON.stringify(relative)}`);
  }
  return components;
}

function validatePortablePathSet(
  paths,
  label,
  {
    allowInternalManifest = false,
    maxBytes = MAX_PATH_BYTES,
    requireLowercase = false,
    reserveVopackNamespace = false,
  } = {},
) {
  const keys = new Map();
  for (const relative of paths) {
    validatePortableRelative(relative, `${label} path`, {
      allowInternalManifest,
      maxBytes,
      requireLowercase,
      reserveVopackNamespace,
    });
    const key = portableCollisionKey(relative);
    const previous = keys.get(key);
    if (previous !== undefined) {
      throw new Error(`${label} contains a case-insensitive duplicate: ${previous} and ${relative}`);
    }
    keys.set(key, relative);
  }
  for (const [key, relative] of keys) {
    const components = key.split('/');
    for (let length = 1; length < components.length; length += 1) {
      const ancestor = components.slice(0, length).join('/');
      if (keys.has(ancestor)) {
        throw new Error(`${label} contains a file/directory collision: ${keys.get(ancestor)} and ${relative}`);
      }
    }
  }
}

function pathWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function chargeObservedPath(base, relative) {
  const key = `${base}\0${relative}`;
  if (observedPaths.has(key)) return;
  observedPaths.add(key);
  observedPathBytes += Buffer.byteLength(relative, 'utf8');
  if (!Number.isSafeInteger(observedPathBytes) || observedPathBytes > MAX_TOTAL_PATH_BYTES) {
    throw new Error(`producer traversal exceeds the ${MAX_TOTAL_PATH_BYTES}-byte aggregate path limit`);
  }
}

function resolveContained(base, relative, label, { allowEmpty = false } = {}) {
  const components = validatePortableRelative(relative, label, { allowEmpty });
  chargeObservedPath(base, relative);
  const candidate = path.resolve(base, ...components);
  if (!pathWithin(base, candidate)) throw new Error(`${label} escapes its declared workspace root`);
  return candidate;
}

function readStableRegularFile(base, relative, label, maxBytes = MAX_SOURCE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_VPAK_BYTES) {
    throw new Error(`invalid byte limit for ${label}`);
  }
  const candidate = resolveContained(base, relative, label);
  const canonical = realpathSync.native(candidate);
  if (!sameNativePath(canonical, candidate)) {
    throw new Error(`${label} must not traverse symbolic-link path components: ${relative}`);
  }
  const cached = fileObservations.get(candidate);
  if (cached !== undefined) {
    const current = lstatSync(candidate, { bigint: true });
    if (!sameStat(cached.metadata, current)) throw new Error(`${label} changed after it was first read`);
    if (cached.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    return cached;
  }
  const before = lstatSync(candidate, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file without symbolic links`);
  }
  if (before.size > BigInt(maxBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  const size = Number(before.size);
  if (observedBytes > MAX_TOTAL_OBSERVED_BYTES - size) {
    throw new Error(`producer inputs exceed the ${MAX_TOTAL_OBSERVED_BYTES}-byte aggregate limit`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(candidate, fsConstants.O_RDONLY | noFollow);
  let bytes;
  let opened;
  try {
    opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) {
      throw new Error(`${label} changed before it was read`);
    }
    bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count <= 0) throw new Error(`${label} was truncated while it was read`);
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, size) !== 0) {
      throw new Error(`${label} grew while it was read`);
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(candidate, { bigint: true });
    if (!sameStat(opened, after) || !sameStat(opened, pathAfter)) {
      throw new Error(`${label} changed while it was read`);
    }
  } finally {
    closeSync(descriptor);
  }
  observedBytes += size;
  if (!Number.isSafeInteger(observedBytes) || observedBytes > MAX_TOTAL_OBSERVED_BYTES) {
    throw new Error(`producer inputs exceed the ${MAX_TOTAL_OBSERVED_BYTES}-byte aggregate limit`);
  }
  const observation = Object.freeze({
    bytes,
    digest: sha256(bytes),
    metadata: opened,
    path: candidate,
    size,
  });
  fileObservations.set(candidate, observation);
  return observation;
}

function entryKind(metadata) {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'special';
}

function snapshotDirectory(directory, label, { charge = false } = {}) {
  const entries = [];
  const handle = opendirSync(directory);
  try {
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (entries.length >= MAX_WALK_ENTRIES) {
        throw new Error(`${label} exceeds the ${MAX_WALK_ENTRIES}-entry directory limit`);
      }
      if (charge) {
        walkEntries += 1;
        if (!Number.isSafeInteger(walkEntries) || walkEntries > MAX_WALK_ENTRIES) {
          throw new Error(`producer traversal exceeds the ${MAX_WALK_ENTRIES}-entry limit`);
        }
        chargeObservedPath(directory, entry.name);
      }
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  return entries.map((entry) => {
    validatePortableComponent(entry.name, `${label} entry`);
    const child = path.join(directory, entry.name);
    const metadata = lstatSync(child, { bigint: true });
    const kind = entryKind(metadata);
    if (kind === 'symlink' || kind === 'special') {
      throw new Error(`${label} contains a ${kind} filesystem entry: ${entry.name}`);
    }
    if (
      (entry.isFile() && kind !== 'file')
      || (entry.isDirectory() && kind !== 'directory')
      || entry.isSymbolicLink()
    ) {
      throw new Error(`${label} directory entry changed while it was enumerated: ${entry.name}`);
    }
    return Object.freeze({ kind, name: entry.name });
  });
}

function readStableDirectory(base, relative, label, { allowEmpty = false } = {}) {
  const directory = resolveContained(base, relative, label, { allowEmpty });
  const canonical = realpathSync.native(directory);
  if (!sameNativePath(canonical, directory)) {
    throw new Error(`${label} must not traverse symbolic-link path components`);
  }
  const before = lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const signature = snapshotDirectory(directory, label, { charge: true });
  const after = lstatSync(directory, { bigint: true });
  if (!sameStat(before, after)) throw new Error(`${label} changed while it was enumerated`);
  const previous = directoryObservations.get(directory);
  if (
    previous !== undefined
    && (
      !sameStat(previous.metadata, after)
      || JSON.stringify(previous.signature) !== JSON.stringify(signature)
    )
  ) {
    throw new Error(`${label} changed after it was first enumerated`);
  }
  directoryObservations.set(directory, Object.freeze({ metadata: after, signature }));
  return signature;
}

function revalidateObservedInputs() {
  currentVoBinary();
  for (const observation of fileObservations.values()) {
    const current = lstatSync(observation.path, { bigint: true });
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || !sameStat(observation.metadata, current)
      || !sameNativePath(realpathSync.native(observation.path), observation.path)
    ) {
      throw new Error(`producer input changed before publication: ${observation.path}`);
    }
  }
  for (const [directory, observation] of directoryObservations) {
    const before = lstatSync(directory, { bigint: true });
    const signature = snapshotDirectory(directory, `observed directory ${directory}`);
    const after = lstatSync(directory, { bigint: true });
    if (
      !before.isDirectory()
      || before.isSymbolicLink()
      || !sameStat(before, after)
      || !sameStat(observation.metadata, after)
      || JSON.stringify(observation.signature) !== JSON.stringify(signature)
      || !sameNativePath(realpathSync.native(directory), directory)
    ) {
      throw new Error(`producer source directory changed before publication: ${directory}`);
    }
  }
  for (const [directory, observation] of sourceRootObservations) {
    const current = lstatSync(directory, { bigint: true });
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || !sameStat(observation, current)
      || !sameNativePath(realpathSync.native(directory), directory)
    ) {
      throw new Error(`project snapshot source root changed before publication: ${directory}`);
    }
  }
}

function fileFact(relative, maxBytes = MAX_SOURCE_BYTES) {
  const observation = readStableRegularFile(root, relative, `BlockKart input ${relative}`, maxBytes);
  return { path: relative, sha256: observation.digest, size: observation.size };
}

function workspaceFileFact(owner, base, relative) {
  const observation = readStableRegularFile(base, relative, `${owner} input ${relative}`);
  return {
    path: `workspace:${owner}/${relative}`,
    sha256: observation.digest,
    size: observation.size,
  };
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validateSnapshotConstraint(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') >= 255
  ) {
    throw new Error(`${label} must be a bounded canonical version constraint`);
  }
  const match = value.match(/^[\^~]?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u);
  if (match === null) throw new Error(`${label} is not a canonical version constraint: ${value}`);
  const maxU64 = (1n << 64n) - 1n;
  for (const component of match.slice(1, 4)) {
    if (BigInt(component) > maxU64) throw new Error(`${label} contains an overflowing version component`);
  }
  if (match[4] !== undefined) {
    for (const identifier of match[4].split('.')) {
      if (/^[0-9]+$/u.test(identifier)) {
        if ((identifier.length > 1 && identifier.startsWith('0')) || BigInt(identifier) > maxU64) {
          throw new Error(`${label} contains a non-canonical numeric prerelease identifier`);
        }
      }
    }
  }
  return value;
}

function validateSnapshotModuleIdentity(value, label) {
  if (
    typeof value !== 'string'
    || !value.startsWith('github.com/')
    || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new Error(`${label} must be a bounded canonical github.com module`);
  }
  const components = value.split('/');
  if (components.length < 3 || components.some((component) => !/^[a-z0-9][a-z0-9._-]*$/u.test(component))) {
    throw new Error(`${label} is not a canonical github.com module: ${value}`);
  }
  for (const component of components) validatePortableComponent(component, label);
  if (components.length > 3) {
    const suffix = components.at(-1).match(/^v([0-9]+)$/u);
    if (
      suffix !== null
      && (
        (suffix[1].length > 1 && suffix[1].startsWith('0'))
        || BigInt(suffix[1]) < 2n
        || BigInt(suffix[1]) > (1n << 64n) - 1n
      )
    ) {
      throw new Error(`${label} has a non-canonical major-version suffix`);
    }
  }
  return value;
}

function validateSnapshotDependencies(value, label) {
  if (!Array.isArray(value) || value.length > MAX_PACKAGES) {
    throw new Error(`${label} must contain at most ${MAX_PACKAGES} dependencies`);
  }
  let previous = '';
  return value.map((dependency, index) => {
    exactKeys(dependency, ['module', 'constraint'], `${label}[${index}]`);
    const module = validateSnapshotModuleIdentity(dependency.module, `${label}[${index}].module`);
    if (index > 0 && compareUtf8(previous, module) >= 0) {
      throw new Error(`${label} must be strictly sorted and unique by module`);
    }
    previous = module;
    return {
      module,
      constraint: validateSnapshotConstraint(dependency.constraint, `${label}[${index}].constraint`),
    };
  });
}

function observeSnapshotSourceRoot(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new Error(`${label} must be an absolute path without control characters`);
  }
  const resolved = path.resolve(candidate);
  const canonical = realpathSync.native(resolved);
  if (!sameNativePath(candidate, resolved) || !sameNativePath(canonical, resolved)) {
    throw new Error(`${label} must be a canonical directory path without symbolic links`);
  }
  const metadata = lstatSync(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must name a real directory`);
  }
  const previous = sourceRootObservations.get(resolved);
  if (previous !== undefined && !sameStat(previous, metadata)) {
    throw new Error(`${label} changed after its first project snapshot`);
  }
  sourceRootObservations.set(resolved, metadata);
  return resolved;
}

function validateEffectiveWorkspaceSnapshot(value) {
  exactKeys(
    value,
    ['schema_version', 'mode', 'authority', 'root', 'workspace', 'modules'],
    'effective project snapshot',
  );
  if (value.schema_version !== 2 || value.mode !== 'effective' || value.authority !== 'workspace') {
    throw new Error('VPAK provenance requires ProjectSnapshot v2 with effective workspace authority');
  }
  exactKeys(value.root, ['module', 'vo', 'dependencies'], 'project snapshot root');
  const rootModule = validateSnapshotModuleIdentity(value.root.module, 'project snapshot root module');
  const rootVo = validateSnapshotConstraint(value.root.vo, 'project snapshot root toolchain constraint');
  const rootDependencies = validateSnapshotDependencies(
    value.root.dependencies,
    'project snapshot root dependencies',
  );
  if (rootDependencies.length === 0) {
    throw new Error('VPAK provenance requires a non-empty workspace dependency graph');
  }
  exactKeys(value.workspace, ['file'], 'project snapshot workspace');
  const workspaceFile = path.join(root, 'vo.work');
  if (
    typeof value.workspace.file !== 'string'
    || !path.isAbsolute(value.workspace.file)
    || !sameNativePath(value.workspace.file, workspaceFile)
    || !sameNativePath(realpathSync.native(value.workspace.file), workspaceFile)
  ) {
    throw new Error('project snapshot workspace file must be the real BlockKart vo.work');
  }
  readStableRegularFile(root, 'vo.work', 'project snapshot workspace file', MAX_METADATA_BYTES);
  if (!Array.isArray(value.modules) || value.modules.length === 0 || value.modules.length > MAX_PACKAGES) {
    throw new Error(`project snapshot must contain 1..${MAX_PACKAGES} workspace modules`);
  }

  const rootDirectory = observeSnapshotSourceRoot(root, `${rootModule} source root`);
  const moduleRoots = [{ module: rootModule, root: rootDirectory }];
  const modulesByName = new Map();
  const sourceDirectories = new Set([process.platform === 'win32' ? rootDirectory.toUpperCase() : rootDirectory]);
  let previous = '';
  let edgeCount = rootDependencies.length;
  const canonicalModules = value.modules.map((module, index) => {
    exactKeys(module, ['module', 'vo', 'source', 'dependencies'], `project snapshot modules[${index}]`);
    const moduleName = validateSnapshotModuleIdentity(module.module, `project snapshot modules[${index}].module`);
    if (moduleName === rootModule || (index > 0 && compareUtf8(previous, moduleName) >= 0)) {
      throw new Error('project snapshot modules must exclude the root and be strictly sorted and unique');
    }
    previous = moduleName;
    exactKeys(module.source, ['kind', 'directory'], `${moduleName} snapshot source`);
    if (module.source.kind !== 'workspace') {
      throw new Error(`${moduleName} must use a workspace source under workspace authority`);
    }
    const sourceDirectory = observeSnapshotSourceRoot(module.source.directory, `${moduleName} source root`);
    const sourceKey = process.platform === 'win32' ? sourceDirectory.toUpperCase() : sourceDirectory;
    if (sourceDirectories.has(sourceKey)) {
      throw new Error(`project snapshot assigns more than one module to source directory ${sourceDirectory}`);
    }
    sourceDirectories.add(sourceKey);
    const dependencies = validateSnapshotDependencies(module.dependencies, `${moduleName} dependencies`);
    edgeCount += dependencies.length;
    if (!Number.isSafeInteger(edgeCount) || edgeCount > MAX_SNAPSHOT_EDGES) {
      throw new Error(`project snapshot exceeds the ${MAX_SNAPSHOT_EDGES}-edge limit`);
    }
    const canonical = {
      module: moduleName,
      vo: validateSnapshotConstraint(module.vo, `${moduleName} toolchain constraint`),
      source: { kind: 'workspace', directory: sourceDirectory },
      dependencies,
    };
    modulesByName.set(moduleName, canonical);
    moduleRoots.push({ module: moduleName, root: sourceDirectory });
    return canonical;
  });

  const validateEdges = (owner, dependencies) => {
    for (const dependency of dependencies) {
      if (dependency.module === owner || dependency.module === rootModule || !modulesByName.has(dependency.module)) {
        throw new Error(`project snapshot contains an invalid or open edge ${owner} -> ${dependency.module}`);
      }
    }
  };
  validateEdges(rootModule, rootDependencies);
  for (const module of canonicalModules) validateEdges(module.module, module.dependencies);
  const reachable = new Set();
  const pending = rootDependencies.map((dependency) => dependency.module);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const moduleName = pending[cursor];
    if (reachable.has(moduleName)) continue;
    reachable.add(moduleName);
    pending.push(...modulesByName.get(moduleName).dependencies.map((dependency) => dependency.module));
    if (pending.length > MAX_SNAPSHOT_EDGES) {
      throw new Error(`project snapshot traversal exceeds the ${MAX_SNAPSHOT_EDGES}-edge limit`);
    }
  }
  if (reachable.size !== canonicalModules.length) {
    throw new Error('project snapshot contains modules unreachable from the BlockKart root');
  }
  moduleRoots.sort((left, right) => (
    right.module.length - left.module.length || compareUtf8(left.module, right.module)
  ));
  return {
    canonical: {
      schema_version: 2,
      mode: 'effective',
      authority: 'workspace',
      root: { module: rootModule, vo: rootVo, dependencies: rootDependencies },
      workspace: { file: workspaceFile },
      modules: canonicalModules,
    },
    moduleRoots,
  };
}

function currentVoBinary() {
  const candidate = process.env.VO_BIN;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('VO_BIN must be an absolute path for every VPAK provenance mode');
  }
  const resolved = path.resolve(candidate);
  const canonical = realpathSync.native(resolved);
  const metadata = lstatSync(resolved, { bigint: true });
  if (
    !sameNativePath(candidate, resolved)
    || !sameNativePath(canonical, resolved)
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
  ) {
    throw new Error('VO_BIN must be a singly-linked real regular file without symbolic-link path components');
  }
  if (voBinaryObservation !== undefined && !sameStat(voBinaryObservation.metadata, metadata)) {
    throw new Error('VO_BIN changed after it was first observed');
  }
  voBinaryObservation = Object.freeze({ metadata, path: resolved });
  return resolved;
}

function projectSnapshotEnvironment() {
  const environment = inheritedGuestEnvironment(process.env);
  Object.assign(environment, {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    VOWORK: path.join(root, 'vo.work'),
  });
  return environment;
}

function captureEffectiveWorkspaceSnapshot() {
  const voBinary = currentVoBinary();
  let bytes;
  try {
    bytes = execFileSync(voBinary, ['mod', 'snapshot', root], {
      cwd: root,
      env: projectSnapshotEnvironment(),
      maxBuffer: MAX_METADATA_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (error) {
    const detail = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString('utf8').trim()
      : error?.message ?? String(error);
    throw new Error(`vo mod snapshot failed: ${detail.slice(-2000)}`);
  }
  const snapshot = parseStrictJson(bytes, 'vo mod snapshot output');
  const validated = validateEffectiveWorkspaceSnapshot(snapshot);
  const canonicalBytes = canonicalJsonBytes(validated.canonical);
  if (!bytes.equals(canonicalBytes)) {
    throw new Error('vo mod snapshot output does not use canonical ProjectSnapshot v2 JSON encoding');
  }
  currentVoBinary();
  return Object.freeze({
    bytes: canonicalBytes,
    moduleRoots: Object.freeze(validated.moduleRoots.map((entry) => Object.freeze({ ...entry }))),
    snapshot: Object.freeze(validated.canonical),
  });
}

function assertSameWorkspaceSnapshot(expected, current) {
  if (!expected.bytes.equals(current.bytes)) {
    throw new Error('effective ProjectSnapshot changed during VPAK provenance capture');
  }
}

function stripVoComments(source) {
  let state = 'normal';
  let output = '';
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'lineComment') {
      if (current === '\n' || current === '\r') {
        output += current;
        state = 'normal';
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'blockComment') {
      if (current === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'normal';
      } else {
        output += current === '\n' || current === '\r' ? current : ' ';
      }
      continue;
    }
    if (state === 'doubleQuote') {
      output += current;
      if (current === '\\') {
        if (next !== undefined) {
          output += next;
          index += 1;
        }
      } else if (current === '"') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'singleQuote') {
      output += current;
      if (current === '\\') {
        if (next !== undefined) {
          output += next;
          index += 1;
        }
      } else if (current === "'") {
        state = 'normal';
      }
      continue;
    }
    if (state === 'rawQuote') {
      output += current;
      if (current === '`') state = 'normal';
      continue;
    }
    if (current === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'lineComment';
    } else if (current === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'blockComment';
    } else {
      output += current;
      if (current === '"') state = 'doubleQuote';
      else if (current === "'") state = 'singleQuote';
      else if (current === '`') state = 'rawQuote';
    }
  }
  if (state === 'blockComment') throw new Error('Vo source contains an unterminated block comment');
  return output;
}

function voImports(source, label) {
  const sanitized = stripVoComments(source);
  const imports = new Set();
  const importEntryPattern = /^[\t ]*(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.)[\t ]+)?"([^"\r\n]+)"[\t ]*;?[\t ]*$/u;
  const singleImportPattern = /^[\t ]*import[\t ]+(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.)[\t ]+)?"([^"\r\n]+)"[\t ]*;?[\t ]*$/u;
  const add = (value) => {
    if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
      throw new Error(`${label} contains an overlong import path`);
    }
    imports.add(value);
    if (imports.size > MAX_IMPORTS) throw new Error(`${label} exceeds the ${MAX_IMPORTS}-import limit`);
  };
  const groupedRanges = [];
  for (const match of sanitized.matchAll(/^[\t ]*import[\t ]*\(([\s\S]*?)^[\t ]*\)[\t ]*;?[\t ]*$/gmu)) {
    groupedRanges.push([match.index, match.index + match[0].length]);
    for (const line of match[1].split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const entry = line.match(importEntryPattern);
      if (entry === null) throw new Error(`${label} contains an unsupported grouped import declaration`);
      add(entry[1]);
    }
  }
  const chunks = [];
  let cursor = 0;
  for (const [start, end] of groupedRanges) {
    chunks.push(sanitized.slice(cursor, start));
    chunks.push(sanitized.slice(start, end).replace(/[^\r\n]/gu, ' '));
    cursor = end;
  }
  chunks.push(sanitized.slice(cursor));
  for (const line of chunks.join('').split(/\r?\n/u)) {
    if (!/^[\t ]*import\b/u.test(line)) continue;
    const match = line.match(singleImportPattern);
    if (match === null) throw new Error(`${label} contains an unsupported import declaration`);
    add(match[1]);
  }
  return [...imports].sort(compareUtf8);
}

function resolveSnapshotPackage(importPath, moduleRoots) {
  const owner = moduleRoots.find((entry) => (
    importPath === entry.module || importPath.startsWith(`${entry.module}/`)
  ));
  if (!owner) {
    const first = importPath.split('/')[0];
    if (first.includes('.')) {
      throw new Error(`VPAK producer imports an undeclared external module: ${importPath}`);
    }
    return null;
  }
  const packagePath = importPath.slice(owner.module.length).replace(/^\//u, '');
  validatePortableRelative(packagePath, `workspace package ${importPath}`, { allowEmpty: true });
  return { ...owner, packagePath };
}

function voWorkspaceSourceClosure(projectSnapshot) {
  const entry = readStableRegularFile(
    root,
    'tools/pack_primitive_assets.vo',
    'VPAK producer entry source',
    MAX_METADATA_BYTES,
  );
  const pending = voImports(UTF8_DECODER.decode(entry.bytes), 'VPAK producer entry source');
  const visitedPackages = new Set();
  const facts = [];
  const usedModules = new Set();
  while (pending.length > 0) {
    if (pending.length > MAX_IMPORTS) {
      throw new Error(`VPAK producer workspace import graph exceeds the ${MAX_IMPORTS}-pending-import limit`);
    }
    const importPath = pending.pop();
    const resolved = resolveSnapshotPackage(importPath, projectSnapshot.moduleRoots);
    if (!resolved || visitedPackages.has(importPath)) continue;
    if (visitedPackages.size >= MAX_PACKAGES) {
      throw new Error(`VPAK producer workspace import graph exceeds the ${MAX_PACKAGES}-package limit`);
    }
    visitedPackages.add(importPath);
    usedModules.add(resolved.module);
    const entries = readStableDirectory(
      resolved.root,
      resolved.packagePath,
      `workspace package ${importPath}`,
      { allowEmpty: true },
    );
    const packageFiles = entries
      .filter((candidate) => candidate.kind === 'file' && candidate.name.endsWith('.vo'))
      .map((candidate) => (
        resolved.packagePath === '' ? candidate.name : `${resolved.packagePath}/${candidate.name}`
      ))
      .sort(compareUtf8);
    if (packageFiles.length === 0) throw new Error(`workspace package contains no Vo source: ${importPath}`);
    validatePortablePathSet(packageFiles, `workspace package ${importPath}`);
    for (const relative of packageFiles) {
      const observation = readStableRegularFile(
        resolved.root,
        relative,
        `workspace source ${resolved.module}/${relative}`,
        MAX_METADATA_BYTES,
      );
      facts.push({
        path: `workspace:${resolved.module}/${relative}`,
        sha256: observation.digest,
        size: observation.size,
      });
      pending.push(...voImports(
        UTF8_DECODER.decode(observation.bytes),
        `workspace source ${resolved.module}/${relative}`,
      ));
    }
  }
  const moduleRootsByName = new Map(projectSnapshot.moduleRoots.map((module) => [module.module, module]));
  for (const moduleName of [...usedModules].sort(compareUtf8)) {
    const module = moduleRootsByName.get(moduleName);
    if (module === undefined) throw new Error(`project snapshot lost source authority for ${moduleName}`);
    facts.push(workspaceFileFact(module.module, module.root, 'vo.mod'));
  }
  facts.sort((left, right) => compareUtf8(left.path, right.path));
  const paths = new Set();
  for (const fact of facts) {
    if (paths.has(fact.path)) throw new Error(`workspace source closure contains duplicate ${fact.path}`);
    paths.add(fact.path);
  }
  return facts;
}

function recursiveFiles(relative, depth = 0) {
  if (depth > MAX_WALK_DEPTH) {
    throw new Error(`producer traversal exceeds the ${MAX_WALK_DEPTH}-level depth limit`);
  }
  const entries = readStableDirectory(root, relative, `BlockKart source directory ${relative}`);
  const files = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.kind === 'directory') files.push(...recursiveFiles(child, depth + 1));
    else files.push(child);
  }
  files.sort(compareUtf8);
  return files;
}

function readUnsigned64(bytes, offset, label) {
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range`);
  return Number(value);
}

function assertZeroBytes(bytes, start, end, label) {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) throw new Error(`${label} contains non-zero reserved or padding bytes`);
  }
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function assertStrictJsonShape(source, label, limits) {
  const stack = [];
  let rootState = 'value';
  let index = 0;
  let tokens = 0;
  let totalCollectionEntries = 0;
  let totalObjectKeyBytes = 0;
  const chargeToken = () => {
    tokens += 1;
    if (tokens > limits.maxJsonTokens) {
      throw new Error(`${label} exceeds the ${limits.maxJsonTokens}-token JSON limit`);
    }
  };
  const chargeCollectionEntry = (context) => {
    context.entries += 1;
    totalCollectionEntries += 1;
    if (context.entries > limits.maxJsonCollectionEntries) {
      throw new Error(`${label} exceeds the per-collection JSON entry limit`);
    }
    if (totalCollectionEntries > limits.maxJsonTotalCollectionEntries) {
      throw new Error(`${label} exceeds the aggregate JSON entry limit`);
    }
  };
  const skipWhitespace = () => {
    while (index < source.length && /[\u0009\u000A\u000D\u0020]/u.test(source[index])) index += 1;
  };
  const decodeScalarString = (token) => {
    let value;
    try {
      value = JSON.parse(token);
    } catch (error) {
      throw new Error(`${label} contains an invalid JSON string: ${error.message}`);
    }
    for (let offset = 0; offset < value.length; offset += 1) {
      const unit = value.charCodeAt(offset);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(offset + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new Error(`${label} contains an isolated Unicode surrogate`);
        }
        offset += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new Error(`${label} contains an isolated Unicode surrogate`);
      }
    }
    return value;
  };
  const scanString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        return decodeScalarString(source.slice(start, index));
      }
      index += character === '\\' ? 2 : 1;
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const scanScalar = () => {
    const start = index;
    while (index < source.length && !/[\u0009\u000A\u000D\u0020,\]}]/u.test(source[index])) index += 1;
    if (index === start) throw new Error(`${label} contains a missing JSON value`);
    try {
      const value = JSON.parse(source.slice(start, index));
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('number is not finite');
      }
    } catch (error) {
      throw new Error(`${label} contains an invalid JSON scalar: ${error.message}`);
    }
  };
  const beginValue = () => {
    chargeToken();
    if (source[index] === '{' || source[index] === '[') {
      if (stack.length >= limits.maxJsonDepth) {
        throw new Error(`${label} exceeds the ${limits.maxJsonDepth}-level JSON depth limit`);
      }
      const kind = source[index] === '{' ? 'object' : 'array';
      index += 1;
      stack.push(kind === 'object'
        ? { entries: 0, keys: new Set(), kind, state: 'keyOrEnd' }
        : { entries: 0, kind, state: 'valueOrEnd' });
    } else if (source[index] === '"') {
      scanString();
    } else {
      scanScalar();
    }
  };
  while (true) {
    skipWhitespace();
    if (stack.length === 0) {
      if (rootState === 'done') {
        if (index !== source.length) throw new Error(`${label} has trailing JSON data`);
        return;
      }
      if (index === source.length) throw new Error(`${label} contains no JSON value`);
      rootState = 'done';
      beginValue();
      continue;
    }
    const context = stack.at(-1);
    if (context.kind === 'object') {
      if (context.state === 'keyOrEnd') {
        if (source[index] === '}') {
          chargeToken();
          index += 1;
          stack.pop();
          continue;
        }
        if (source[index] !== '"') throw new Error(`${label} contains a non-string object key`);
        chargeToken();
        const key = scanString();
        const keyBytes = Buffer.byteLength(key, 'utf8');
        if (keyBytes > limits.maxObjectKeyBytes) throw new Error(`${label} contains an overlong object key`);
        totalObjectKeyBytes += keyBytes;
        if (totalObjectKeyBytes > limits.maxJsonTotalObjectKeyBytes) {
          throw new Error(`${label} exceeds the aggregate object-key byte limit`);
        }
        if (context.keys.size >= limits.maxJsonObjectKeys) {
          throw new Error(`${label} exceeds the per-object key limit`);
        }
        if (context.keys.has(key)) {
          throw new Error(`${label} contains duplicate object key ${JSON.stringify(key)}`);
        }
        context.keys.add(key);
        chargeCollectionEntry(context);
        context.state = 'colon';
        continue;
      }
      if (context.state === 'colon') {
        if (source[index] !== ':') throw new Error(`${label} object key is missing a colon`);
        chargeToken();
        index += 1;
        context.state = 'value';
        continue;
      }
      if (context.state === 'value') {
        if (index === source.length) throw new Error(`${label} object is missing a value`);
        context.state = 'commaOrEnd';
        beginValue();
        continue;
      }
      if (source[index] === ',') {
        chargeToken();
        index += 1;
        context.state = 'keyOrEnd';
      } else if (source[index] === '}') {
        chargeToken();
        index += 1;
        stack.pop();
      } else {
        throw new Error(`${label} object is missing a comma or closing brace`);
      }
      continue;
    }
    if (context.state === 'valueOrEnd') {
      if (source[index] === ']') {
        chargeToken();
        index += 1;
        stack.pop();
      } else {
        if (index === source.length) throw new Error(`${label} array is missing a value`);
        chargeCollectionEntry(context);
        context.state = 'commaOrEnd';
        beginValue();
      }
      continue;
    }
    if (source[index] === ',') {
      chargeToken();
      index += 1;
      context.state = 'valueOrEnd';
    } else if (source[index] === ']') {
      chargeToken();
      index += 1;
      stack.pop();
    } else {
      throw new Error(`${label} array is missing a comma or closing bracket`);
    }
  }
}

function parseStrictJson(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > JSON_LIMITS.maxJsonBytes) {
    throw new Error(`${label} exceeds the ${JSON_LIMITS.maxJsonBytes}-byte JSON limit`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${label} must not contain a UTF-8 BOM`);
  }
  let source;
  try {
    source = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`${label} is invalid UTF-8: ${error.message}`);
  }
  assertStrictJsonShape(source, label, JSON_LIMITS);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function exactKeys(value, expected, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort(compareUtf8))
      !== JSON.stringify([...expected].sort(compareUtf8))
  ) {
    throw new Error(`${label} does not contain its exact canonical fields`);
  }
}

function validateInternalManifest(manifest, entries) {
  exactKeys(manifest, ['assets', 'formatVersion', 'packName', 'packVersion'], 'VPAK internal manifest');
  if (
    manifest.formatVersion !== 1
    || manifest.packName !== 'BlockKart'
    || manifest.packVersion !== 'primitive-track'
    || !Array.isArray(manifest.assets)
    || manifest.assets.length !== EXPECTED_PAYLOAD_COUNT
  ) {
    throw new Error('VPAK internal manifest identity or payload count is invalid');
  }
  const publicEntries = entries.filter((entry) => entry.path !== internalManifestPath);
  if (publicEntries.length !== EXPECTED_PAYLOAD_COUNT) {
    throw new Error(`BlockKart VPAK must contain exactly ${EXPECTED_PAYLOAD_COUNT} public payloads`);
  }
  const assetByPath = new Map();
  for (const [index, asset] of manifest.assets.entries()) {
    exactKeys(asset, ['contentHash', 'dependencies', 'path', 'sourcePath', 'type'], `VPAK asset ${index}`);
    validatePortableRelative(asset.path, `VPAK asset ${index} path`, {
      maxBytes: MAX_VPAK_PATH_BYTES,
      requireLowercase: true,
      reserveVopackNamespace: true,
    });
    validatePortableRelative(asset.sourcePath, `VPAK asset ${index} sourcePath`, {
      maxBytes: MAX_VPAK_PATH_BYTES,
      requireLowercase: true,
      reserveVopackNamespace: true,
    });
    if (asset.sourcePath !== asset.path) {
      throw new Error(`VPAK source path is not canonical: ${asset.path}`);
    }
    if (
      typeof asset.type !== 'string'
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(asset.type)
      || !/^crc32:[0-9a-f]{8}$/u.test(asset.contentHash)
      || assetByPath.has(portableCollisionKey(asset.path))
    ) {
      throw new Error(`VPAK asset has invalid or duplicate identity: ${asset.path}`);
    }
    const dependencies = asset.dependencies;
    if (!Array.isArray(dependencies) || dependencies.length > EXPECTED_PAYLOAD_COUNT) {
      throw new Error(`VPAK asset dependencies are invalid: ${asset.path}`);
    }
    const dependencyKeys = new Set();
    let previousDependency = '';
    for (const dependency of dependencies) {
      validatePortableRelative(dependency, `VPAK dependency of ${asset.path}`, {
        maxBytes: MAX_VPAK_PATH_BYTES,
        requireLowercase: true,
        reserveVopackNamespace: true,
      });
      const key = portableCollisionKey(dependency);
      if (
        key === portableCollisionKey(asset.path)
        || dependencyKeys.has(key)
        || (previousDependency !== '' && compareUtf8(previousDependency, dependency) >= 0)
      ) {
        throw new Error(
          `VPAK asset has a self, duplicate, or non-increasing dependency: ${asset.path} -> ${dependency}`,
        );
      }
      dependencyKeys.add(key);
      previousDependency = dependency;
    }
    assetByPath.set(portableCollisionKey(asset.path), asset);
    if (publicEntries[index]?.path !== asset.path) {
      throw new Error('VPAK entry order and internal manifest asset order differ');
    }
  }
  validatePortablePathSet(manifest.assets.map((asset) => asset.path), 'VPAK internal manifest', {
    maxBytes: MAX_VPAK_PATH_BYTES,
    requireLowercase: true,
    reserveVopackNamespace: true,
  });
  for (const asset of manifest.assets) {
    for (const dependency of asset.dependencies) {
      if (!assetByPath.has(portableCollisionKey(dependency))) {
        throw new Error(`VPAK dependency is not packed: ${asset.path} -> ${dependency}`);
      }
    }
  }
  return { assetByPath, publicEntries };
}

function readVpak() {
  const pack = readStableRegularFile(root, producerOutputs.pack, 'BlockKart VPAK', MAX_VPAK_BYTES);
  const bytes = pack.bytes;
  if (bytes.length < HEADER_SIZE + FOOTER_SIZE || bytes.subarray(0, 4).toString('ascii') !== 'VPAK') {
    throw new Error('invalid BlockKart VPAK header');
  }
  if (bytes[4] !== 1 || bytes[5] !== 0) throw new Error('unsupported BlockKart VPAK version or flags');
  assertZeroBytes(bytes, 6, 8, 'VPAK header');
  assertZeroBytes(bytes, 24, HEADER_SIZE, 'VPAK header');
  const dataOffset = readUnsigned64(bytes, 8, 'VPAK data offset');
  const dataSize = readUnsigned64(bytes, 16, 'VPAK data size');
  if (dataOffset !== HEADER_SIZE) throw new Error('VPAK data region must start after the canonical header');

  const footerOffset = bytes.length - FOOTER_SIZE;
  const footer = bytes.subarray(footerOffset);
  const footerChecksum = footer.readUInt32LE(28);
  if ((crc32(footer.subarray(0, 28)) >>> 0) !== footerChecksum) {
    throw new Error('VPAK footer checksum mismatch');
  }
  const pathPoolOffset = readUnsigned64(footer, 0, 'VPAK path-pool offset');
  const pathPoolSize = readUnsigned64(footer, 8, 'VPAK path-pool size');
  const entryTableOffset = readUnsigned64(footer, 16, 'VPAK entry-table offset');
  const entryCount = footer.readUInt32LE(24);
  if (entryCount === 0 || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`VPAK entry count must be within 1..${MAX_ARCHIVE_ENTRIES}`);
  }
  const tableSize = entryCount * ENTRY_SIZE;
  if (
    dataSize !== pathPoolOffset - dataOffset
    || pathPoolOffset < dataOffset
    || pathPoolOffset + pathPoolSize !== entryTableOffset
    || entryTableOffset + tableSize !== footerOffset
    || pathPoolSize > MAX_METADATA_BYTES
  ) {
    throw new Error('VPAK footer regions are non-canonical or out of bounds');
  }
  const pathPool = bytes.subarray(pathPoolOffset, entryTableOffset);
  const entries = [];
  const entryKeys = new Set();
  let expectedPathOffset = 0;
  let expectedDataOffset = dataOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = entryTableOffset + index * ENTRY_SIZE;
    const pathOffset = bytes.readUInt32LE(offset);
    const pathLength = bytes.readUInt16LE(offset + 4);
    const compression = bytes.readUInt8(offset + 6);
    const flags = bytes.readUInt8(offset + 7);
    const entryDataOffset = readUnsigned64(bytes, offset + 8, `VPAK entry ${index} data offset`);
    const rawSize = readUnsigned64(bytes, offset + 16, `VPAK entry ${index} raw size`);
    const storedSize = readUnsigned64(bytes, offset + 24, `VPAK entry ${index} stored size`);
    const checksum = bytes.readUInt32LE(offset + 32);
    assertZeroBytes(bytes, offset + 36, offset + ENTRY_SIZE, `VPAK entry ${index}`);
    if (
      pathLength === 0
      || pathLength > MAX_VPAK_PATH_BYTES
      || pathOffset !== expectedPathOffset
      || pathOffset + pathLength > pathPool.length
    ) {
      throw new Error(`VPAK entry ${index} has a non-canonical path slice`);
    }
    const pathBytes = pathPool.subarray(pathOffset, pathOffset + pathLength);
    let entryPath;
    try {
      entryPath = UTF8_DECODER.decode(pathBytes);
    } catch (error) {
      throw new Error(`VPAK entry ${index} path is invalid UTF-8: ${error.message}`);
    }
    validatePortableRelative(entryPath, `VPAK entry ${index} path`, {
      allowInternalManifest: true,
      maxBytes: MAX_VPAK_PATH_BYTES,
      requireLowercase: true,
      reserveVopackNamespace: true,
    });
    const entryKey = portableCollisionKey(entryPath);
    if (entryKeys.has(entryKey)) throw new Error(`VPAK contains a duplicate path: ${entryPath}`);
    entryKeys.add(entryKey);
    if (compression !== 0 || flags !== 0 || rawSize !== storedSize || storedSize > MAX_SOURCE_BYTES) {
      throw new Error(`BlockKart VPAK entry must be canonical and uncompressed: ${entryPath}`);
    }
    const aligned = alignUp(expectedDataOffset, DEFAULT_ALIGNMENT);
    if (
      entryDataOffset !== aligned
      || entryDataOffset + storedSize > pathPoolOffset
      || !Number.isSafeInteger(entryDataOffset + storedSize)
    ) {
      throw new Error(`VPAK entry data region is non-canonical: ${entryPath}`);
    }
    assertZeroBytes(bytes, expectedDataOffset, aligned, `VPAK entry padding before ${entryPath}`);
    const stored = bytes.subarray(entryDataOffset, entryDataOffset + storedSize);
    if ((crc32(stored) >>> 0) !== checksum) throw new Error(`VPAK checksum mismatch: ${entryPath}`);
    entries.push(Object.freeze({
      checksum,
      compression,
      path: entryPath,
      rawSize,
      stored,
      storedSize,
    }));
    expectedPathOffset += pathLength;
    expectedDataOffset = entryDataOffset + storedSize;
  }
  if (expectedPathOffset !== pathPool.length || expectedDataOffset !== pathPoolOffset) {
    throw new Error('VPAK path pool or data region contains unreferenced bytes');
  }
  validatePortablePathSet(
    entries.map((entry) => entry.path),
    'VPAK entry table',
    {
      allowInternalManifest: true,
      maxBytes: MAX_VPAK_PATH_BYTES,
      requireLowercase: true,
      reserveVopackNamespace: true,
    },
  );
  const manifestEntries = entries.filter((entry) => entry.path === internalManifestPath);
  if (manifestEntries.length !== 1 || entries.at(-1).path !== internalManifestPath) {
    throw new Error('VPAK must contain one final internal manifest entry');
  }
  const manifestEntry = manifestEntries[0];
  if (manifestEntry.storedSize > MAX_METADATA_BYTES) throw new Error('VPAK internal manifest is too large');
  const manifest = parseStrictJson(manifestEntry.stored, 'VPAK internal manifest');
  return { bytes, entries, manifest, manifestEntry, pack };
}

function canonicalProducer(projectSnapshot) {
  const { entries, manifest, manifestEntry, pack } = readVpak();
  const { assetByPath, publicEntries } = validateInternalManifest(manifest, entries);
  const sourceFacts = new Map();
  for (const entry of publicEntries) {
    const asset = assetByPath.get(portableCollisionKey(entry.path));
    const source = readStableRegularFile(
      root,
      asset.sourcePath,
      `VPAK payload source ${asset.sourcePath}`,
      MAX_SOURCE_BYTES,
    );
    if (
      source.size !== entry.rawSize
      || source.size !== entry.storedSize
      || !source.bytes.equals(entry.stored)
    ) {
      throw new Error(`VPAK payload bytes differ from their source: ${entry.path}`);
    }
    const sourceChecksum = crc32(source.bytes) >>> 0;
    const sourceCrc = `crc32:${sourceChecksum.toString(16).padStart(8, '0')}`;
    if (asset.contentHash !== sourceCrc || entry.checksum !== sourceChecksum) {
      throw new Error(`VPAK payload hash differs from its source: ${entry.path}`);
    }
    sourceFacts.set(asset.sourcePath, source);
  }

  const payloadInputs = [...sourceFacts.keys()].sort(compareUtf8);
  if (payloadInputs.length !== EXPECTED_PAYLOAD_COUNT) {
    throw new Error(`BlockKart VPAK must bind ${EXPECTED_PAYLOAD_COUNT} unique payload sources`);
  }
  const paintedSources = recursiveFiles('assets/source/terrain_painted');
  const lineageInputs = [
    ...producerScripts,
    'terrain/recipes/primitive_concept_v1.json',
    'docs/images/terrain-upgrade-concept-v1.png',
    ...paintedSources,
  ];
  const inputPaths = [...new Set([...payloadInputs, ...lineageInputs])].sort(compareUtf8);
  validatePortablePathSet(inputPaths, 'BlockKart producer inputs');
  const workspaceSourceInputs = voWorkspaceSourceClosure(projectSnapshot);
  const archiveEntries = publicEntries
    .map((entry) => {
      const asset = assetByPath.get(portableCollisionKey(entry.path));
      const source = sourceFacts.get(asset.sourcePath);
      return {
        path: entry.path,
        kind: asset.type,
        sourcePath: asset.sourcePath,
        sourceSha256: source.digest,
        sourceSize: source.size,
        contentHash: asset.contentHash,
        dependencies: [...asset.dependencies],
        compression: entry.compression,
        rawSize: entry.rawSize,
        storedSize: entry.storedSize,
        storedChecksum: entry.checksum,
      };
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  const producer = {
    schemaVersion: 1,
    kind: 'blockkart.vpakProducerManifest',
    owner: 'BlockKart',
    command: ['vo', 'run', 'tools/pack_primitive_assets.vo'],
    pack: { path: packRelative, sha256: pack.digest, size: pack.size },
    inputs: [
      ...inputPaths.map((relative) => fileFact(relative)),
      ...workspaceSourceInputs,
    ].sort((left, right) => compareUtf8(left.path, right.path)),
    workspaceSourceInputCount: workspaceSourceInputs.length,
    payloadInputCount: payloadInputs.length,
    archiveEntryCount: archiveEntries.length,
    archiveEntries,
    internalManifest: {
      pack: manifest.packName,
      version: manifest.packVersion,
      assetCount: manifest.assets.length,
      sha256: sha256(JSON.stringify(manifest)),
      storedSha256: sha256(manifestEntry.stored),
      storedSize: manifestEntry.storedSize,
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
          ...paintedSources.map((relative) => fileFact(relative)),
          fileFact('assets/effects/grass_card_atlas.png'),
        ],
        outputs: payloadInputs
          .filter((relative) => relative.startsWith('assets/maps/primitive_track/'))
          .map((relative) => fileFact(relative)),
      },
      {
        id: 'painted-terrain-textures',
        command: ['node', 'tools/paint_terrain_textures.mjs'],
        inputs: [
          fileFact('tools/paint_terrain_textures.mjs'),
          fileFact('docs/images/terrain-upgrade-concept-v1.png'),
          ...paintedSources.map((relative) => fileFact(relative)),
        ],
        outputs: [
          ...paintedSources.map((relative) => fileFact(relative)),
          fileFact('assets/effects/grass_card_atlas.png'),
        ],
      },
    ],
  };
  revalidateObservedInputs();
  assertSameWorkspaceSnapshot(projectSnapshot, captureEffectiveWorkspaceSnapshot());
  revalidateObservedInputs();
  return { ...producer, producerDigest: sha256(JSON.stringify(producer)) };
}

function inheritedGuestEnvironment(baseEnvironment) {
  const allowed = [
    'ComSpec',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATHEXT',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'TZ',
    'USERPROFILE',
    'VO_MOD_CACHE',
    'WINDIR',
    'XDG_CACHE_HOME',
  ];
  const environment = {};
  for (const canonicalKey of allowed) {
    const matches = Object.keys(baseEnvironment).filter((key) => (
      process.platform === 'win32'
        ? key.toUpperCase() === canonicalKey.toUpperCase()
        : key === canonicalKey
    ));
    if (matches.length > 1) throw new Error(`ambiguous guest environment key: ${canonicalKey}`);
    if (matches.length === 1 && typeof baseEnvironment[matches[0]] === 'string') {
      environment[canonicalKey] = baseEnvironment[matches[0]];
    }
  }
  return environment;
}

function buildPack() {
  const voBinary = currentVoBinary();
  const environment = projectSnapshotEnvironment();
  environment[packOutputEnvironment] = producerOutputs.pack;
  execFileSync(voBinary, ['run', 'tools/pack_primitive_assets.vo'], {
    cwd: root,
    stdio: 'inherit',
    timeout: 300_000,
    env: environment,
  });
  currentVoBinary();
}

function existingMetadata(candidate) {
  try {
    return lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeProvenanceAtomically(encoded) {
  const payload = Buffer.from(encoded, 'utf8');
  if (payload.byteLength > MAX_PROVENANCE_BYTES) {
    throw new Error(`VPAK provenance exceeds the ${MAX_PROVENANCE_BYTES}-byte limit`);
  }
  const destination = resolveContained(root, producerOutputs.provenance, 'VPAK provenance destination');
  const directory = path.dirname(destination);
  if (!sameNativePath(realpathSync.native(directory), directory)) {
    throw new Error('VPAK provenance parent must be a real directory without symbolic links');
  }
  const parent = lstatSync(directory, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('VPAK provenance parent must be a real directory');
  }
  const existing = existingMetadata(destination);
  if (
    existing !== null
    && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)
  ) {
    throw new Error('VPAK provenance destination must be a singly-linked regular file');
  }
  const temporary = path.join(directory, `.blockkart-vpak-provenance.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  let published = false;
  let temporaryMetadata;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o644,
    );
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o644);
    let offset = 0;
    while (offset < payload.byteLength) {
      const count = writeSync(descriptor, payload, offset, payload.byteLength - offset, offset);
      if (count <= 0) throw new Error('VPAK provenance atomic write made no progress');
      offset += count;
    }
    fsyncSync(descriptor);
    temporaryMetadata = fstatSync(descriptor, { bigint: true });
    if (
      !temporaryMetadata.isFile()
      || temporaryMetadata.isSymbolicLink()
      || temporaryMetadata.nlink !== 1n
      || temporaryMetadata.size !== BigInt(payload.byteLength)
    ) {
      throw new Error('VPAK provenance temporary file changed while it was written');
    }
    closeSync(descriptor);
    descriptor = undefined;
    revalidateObservedInputs();
    const destinationNow = existingMetadata(destination);
    if (
      destinationNow !== null
      && (!destinationNow.isFile() || destinationNow.isSymbolicLink() || destinationNow.nlink !== 1n)
    ) {
      throw new Error('VPAK provenance destination changed before publication');
    }
    const closedTemporary = lstatSync(temporary, { bigint: true });
    if (!sameStat(temporaryMetadata, closedTemporary) || closedTemporary.nlink !== 1n) {
      throw new Error('VPAK provenance temporary file changed before publication');
    }
    renameSync(temporary, destination);
    published = true;
    const publishedMetadata = lstatSync(destination, { bigint: true });
    if (!sameNodeIdentity(temporaryMetadata, publishedMetadata) || publishedMetadata.nlink !== 1n) {
      throw new Error('VPAK provenance destination changed during publication');
    }
    if (process.platform !== 'win32') {
      const directoryDescriptor = openSync(directory, fsConstants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
    const publishedFile = readStableRegularFile(
      root,
      producerOutputs.provenance,
      'published VPAK provenance',
      MAX_PROVENANCE_BYTES,
    );
    if (!publishedFile.bytes.equals(payload)) throw new Error('published VPAK provenance bytes differ');
    revalidateObservedInputs();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published) rmSync(temporary, { force: true });
  }
}

if (process.argv.length > 3) throw new Error('vpak_provenance accepts at most one mode argument');
const mode = process.argv[2] ?? '--check';
if (!['--build', '--write', '--check'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
if (mode !== '--check' && producerOutputs.transactionDirectory === null) {
  throw new Error(
    `${mode} requires ${transactionDirectoryEnvironment}; publish VPAK files through the transaction builder`,
  );
}
const projectSnapshot = captureEffectiveWorkspaceSnapshot();
if (mode === '--build') buildPack();
const producer = canonicalProducer(projectSnapshot);
const encoded = `${JSON.stringify(producer, null, 2)}\n`;
if (Buffer.byteLength(encoded, 'utf8') > MAX_PROVENANCE_BYTES) {
  throw new Error(`VPAK provenance exceeds the ${MAX_PROVENANCE_BYTES}-byte limit`);
}
if (mode === '--build' || mode === '--write') {
  writeProvenanceAtomically(encoded);
  console.log(`blockkart vpak provenance: wrote ${producer.archiveEntryCount} entries ${producerOutputs.provenance}`);
} else {
  const current = readStableRegularFile(
    root,
    producerOutputs.provenance,
    'current VPAK provenance',
    MAX_PROVENANCE_BYTES,
  );
  if (!current.bytes.equals(Buffer.from(encoded, 'utf8'))) {
    throw new Error(`${producerOutputs.provenance} is stale; rebuild the VPAK producer manifest`);
  }
  revalidateObservedInputs();
  console.log(
    `blockkart vpak provenance: ok entries=${producer.archiveEntryCount} payloadInputs=${producer.payloadInputCount}`,
  );
}
