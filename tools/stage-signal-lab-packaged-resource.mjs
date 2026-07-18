#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SIGNAL_LAB_REPOSITORY_ROOT = resolve(repositoryRoot, '..', 'Atom-SignalLab');
export const DEFAULT_SIGNAL_LAB_PACKAGED_RESOURCE_ROOT = resolve(
  repositoryRoot,
  'apps',
  'desktop',
  'dist',
  'packaged-resources',
  'signal-lab',
);
export const SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS = Object.freeze([
  'atomizer-bridge.js',
  'canonical-timing.js',
  'catalog.js',
  'contracts.js',
  'measurement-bridge.js',
  'measurement-contract.js',
  'measurement-service.js',
  'source-provenance.js',
  'waveforms.js',
]);

const CONTRACT_FILE = 'signal-lab-measurement-bridge-v1.json';
const MANIFEST_FILE = 'packaged-resource-manifest-v1.json';
const ALLOWED_ZOD_RUNTIME_FILE = /(?:\.(?:cjs|js|json|mjs)|(?:^|\/)(?:LICENSE|README\.md))$/u;

/**
 * Materialize the complete resource root consumed by
 * `resolveSignalLabBridgeLocation({ packagedResourcesRoot })`.
 *
 * The emitted bridge is deliberately outside app.asar so Electron can launch
 * it as a child process. It therefore carries its own ESM package boundary and
 * its exact bare runtime dependency instead of relying on app.asar module
 * resolution.
 */
export async function stageSignalLabPackagedResource(options = {}) {
  const sourceRoot = await requireCanonicalDirectory(
    resolve(options.sourceRepositoryRoot ?? DEFAULT_SIGNAL_LAB_REPOSITORY_ROOT),
    'SignalLab repository',
  );
  const destinationRoot = resolve(
    options.destinationRoot ?? DEFAULT_SIGNAL_LAB_PACKAGED_RESOURCE_ROOT,
  );
  if (destinationRoot === sourceRoot || destinationRoot === dirname(destinationRoot)) {
    throw new Error('SignalLab packaged-resource destination is unsafe');
  }

  const sourcePackage = await readJsonRegularFile(
    resolve(sourceRoot, 'package.json'),
    sourceRoot,
    'SignalLab package manifest',
  );
  if (sourcePackage.name !== 'tinysa-signal-lab' || sourcePackage.type !== 'module') {
    throw new Error('SignalLab package identity is not the admitted ESM producer');
  }
  const admittedZodVersion = sourcePackage.dependencies?.zod;
  if (typeof admittedZodVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(admittedZodVersion)) {
    throw new Error('SignalLab must pin one exact Zod runtime version');
  }

  const bridgeRoot = resolve(sourceRoot, 'dist', 'bridge');
  await requireCanonicalDirectory(bridgeRoot, 'built SignalLab bridge directory');
  const bridgeEntries = await readdir(bridgeRoot, { withFileTypes: true });
  for (const entry of bridgeEntries) {
    if (entry.isSymbolicLink()) throw new Error(`SignalLab bridge contains a symlink: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`SignalLab bridge contains an unsupported entry: ${entry.name}`);
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.js.map')) {
      throw new Error(`SignalLab bridge contains an unexpected artifact: ${entry.name}`);
    }
  }
  const javascriptNames = bridgeEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
  assertExactStrings(
    javascriptNames,
    [...SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS].sort(),
    'SignalLab packaged bridge JavaScript inventory',
  );

  const contractPath = resolve(sourceRoot, 'contracts', CONTRACT_FILE);
  const contract = await readJsonRegularFile(
    contractPath,
    sourceRoot,
    'SignalLab measurement contract',
  );
  if (contract.documentType !== 'contract-manifest'
    || contract.contractId !== 'tinysa-signal-lab-atomizer-measurement'
    || contract.contractVersion !== 1
    || contract.status !== 'active') {
    throw new Error('SignalLab measurement contract is not the admitted active v1 contract');
  }

  const zodRoot = await requireCanonicalDirectory(
    resolve(sourceRoot, 'node_modules', 'zod'),
    'SignalLab Zod runtime',
  );
  const zodPackage = await readJsonRegularFile(
    resolve(zodRoot, 'package.json'),
    zodRoot,
    'SignalLab Zod package manifest',
  );
  if (zodPackage.name !== 'zod' || zodPackage.version !== admittedZodVersion) {
    throw new Error('Installed SignalLab Zod runtime does not match its exact package pin');
  }

  const parent = dirname(destinationRoot);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  if (await realpath(parent) !== parent) {
    throw new Error('SignalLab packaged-resource parent path contains indirection');
  }
  const stagingRoot = await mkdtemp(join(parent, '.signal-lab-resource-'));
  const copiedFiles = [];
  try {
    await mkdir(resolve(stagingRoot, 'contracts'), { recursive: true, mode: 0o755 });
    await mkdir(resolve(stagingRoot, 'dist', 'bridge'), { recursive: true, mode: 0o755 });
    await mkdir(resolve(stagingRoot, 'node_modules', 'zod'), { recursive: true, mode: 0o755 });

    const packagedPackage = Object.freeze({
      name: 'tinysa-signal-lab-packaged-resource',
      version: sourcePackage.version,
      private: true,
      type: 'module',
      dependencies: Object.freeze({ zod: admittedZodVersion }),
    });
    await writeReadOnlyJson(resolve(stagingRoot, 'package.json'), packagedPackage);
    copiedFiles.push('package.json');

    await copyReadOnlyFile(contractPath, resolve(stagingRoot, 'contracts', CONTRACT_FILE));
    copiedFiles.push(`contracts/${CONTRACT_FILE}`);

    for (const name of SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS) {
      const source = resolve(bridgeRoot, name);
      await requireRegularFile(source, sourceRoot, `SignalLab generator artifact ${name}`);
      const destination = resolve(stagingRoot, 'dist', 'bridge', name);
      await copyFile(source, destination);
      await chmod(destination, name === 'atomizer-bridge.js' ? 0o555 : 0o444);
      copiedFiles.push(`dist/bridge/${name}`);
    }

    await copyZodRuntime(zodRoot, resolve(stagingRoot, 'node_modules', 'zod'), copiedFiles);
    const fileEvidence = [];
    for (const path of copiedFiles.sort()) {
      const bytes = await readFile(resolve(stagingRoot, path));
      fileEvidence.push(Object.freeze({
        path,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }));
    }
    await writeReadOnlyJson(resolve(stagingRoot, MANIFEST_FILE), {
      schemaVersion: 1,
      sourcePackage: Object.freeze({ name: sourcePackage.name, version: sourcePackage.version }),
      runtimeDependencies: Object.freeze({ zod: admittedZodVersion }),
      generatorArtifacts: SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS,
      files: fileEvidence,
    });

    await removeExistingDestination(destinationRoot);
    await rename(stagingRoot, destinationRoot);
    await verifySignalLabPackagedResource(destinationRoot);
    return Object.freeze({
      destinationRoot,
      manifestPath: resolve(destinationRoot, MANIFEST_FILE),
      files: Object.freeze([...copiedFiles, MANIFEST_FILE]),
    });
  } catch (cause) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw cause;
  }
}

/** Verifies the exact post-copy resource tree used by a packaged Electron app. */
export async function verifySignalLabPackagedResource(rootValue, options = {}) {
  const root = await requireCanonicalDirectory(resolve(rootValue), 'packaged SignalLab resource root');
  const manifest = await readJsonRegularFile(
    resolve(root, MANIFEST_FILE),
    root,
    'packaged SignalLab resource manifest',
  );
  if (manifest.schemaVersion !== 1
    || manifest.sourcePackage?.name !== 'tinysa-signal-lab'
    || typeof manifest.sourcePackage?.version !== 'string'
    || typeof manifest.runtimeDependencies?.zod !== 'string'
    || !Array.isArray(manifest.generatorArtifacts)
    || !Array.isArray(manifest.files)) {
    throw new Error('Packaged SignalLab resource manifest shape is invalid');
  }
  assertExactStrings(
    manifest.generatorArtifacts,
    SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS,
    'Packaged SignalLab generator artifact inventory',
  );

  const expectedPaths = new Set([MANIFEST_FILE]);
  for (const evidence of manifest.files) {
    if (!evidence || typeof evidence !== 'object'
      || typeof evidence.path !== 'string'
      || !isSafeRelativeResourcePath(evidence.path)
      || !Number.isSafeInteger(evidence.sizeBytes)
      || evidence.sizeBytes < 1
      || typeof evidence.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(evidence.sha256)
      || expectedPaths.has(evidence.path)) {
      throw new Error('Packaged SignalLab resource manifest contains invalid file evidence');
    }
    expectedPaths.add(evidence.path);
    const path = resolve(root, evidence.path);
    await requireRegularFile(path, root, `Packaged SignalLab resource ${evidence.path}`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== evidence.sizeBytes
      || createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) {
      throw new Error(`Packaged SignalLab resource changed after staging: ${evidence.path}`);
    }
  }

  const actualPaths = new Set(await collectRegularFiles(root));
  assertExactStrings(
    [...actualPaths].sort(),
    [...expectedPaths].sort(),
    'Packaged SignalLab resource filesystem inventory',
  );
  for (const required of [
    'package.json',
    `contracts/${CONTRACT_FILE}`,
    'dist/bridge/atomizer-bridge.js',
    'node_modules/zod/package.json',
    'node_modules/zod/index.js',
  ]) {
    if (!actualPaths.has(required)) throw new Error(`Packaged SignalLab resource is missing ${required}`);
  }
  const packageManifest = await readJsonRegularFile(
    resolve(root, 'package.json'),
    root,
    'packaged SignalLab package manifest',
  );
  if (packageManifest.type !== 'module'
    || packageManifest.dependencies?.zod !== manifest.runtimeDependencies.zod) {
    throw new Error('Packaged SignalLab ESM or Zod dependency boundary changed');
  }

  if (options.normalizeModes === true) {
    for (const path of actualPaths) {
      await chmod(resolve(root, path), path === 'dist/bridge/atomizer-bridge.js' ? 0o555 : 0o444);
    }
  }
  if (process.platform !== 'win32') {
    // Windows has no POSIX permission-bit executable flag, and fs.Stats.mode
    // there just mirrors the read-only attribute across owner/group/other,
    // so these bits carry no meaningful signal on it.
    const entryMode = (await lstat(resolve(root, 'dist', 'bridge', 'atomizer-bridge.js'))).mode;
    if ((entryMode & 0o111) === 0 || (entryMode & 0o022) !== 0) {
      throw new Error('Packaged SignalLab bridge must be executable and not group- or world-writable');
    }
  }
  return Object.freeze({ root, files: actualPaths.size });
}

async function copyZodRuntime(sourceRoot, destinationRoot, copiedFiles, relativeRoot = '') {
  const entries = await readdir(resolve(sourceRoot, relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`SignalLab Zod runtime contains a symlink: ${relativePath}`);
    if (entry.isDirectory()) {
      await mkdir(resolve(destinationRoot, relativePath), { recursive: true, mode: 0o755 });
      await copyZodRuntime(sourceRoot, destinationRoot, copiedFiles, relativePath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`SignalLab Zod runtime contains an unsupported entry: ${relativePath}`);
    if (!ALLOWED_ZOD_RUNTIME_FILE.test(relativePath)) continue;
    const source = resolve(sourceRoot, relativePath);
    await requireRegularFile(source, sourceRoot, `SignalLab Zod runtime ${relativePath}`);
    const destination = resolve(destinationRoot, relativePath);
    await copyFile(source, destination);
    await chmod(destination, 0o444);
    copiedFiles.push(`node_modules/zod/${relativePath}`);
  }
}

async function collectRegularFiles(root, relativeRoot = '') {
  const paths = [];
  const entries = await readdir(resolve(root, relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Packaged SignalLab resource contains a symlink: ${relativePath}`);
    if (entry.isDirectory()) {
      paths.push(...await collectRegularFiles(root, relativePath));
    } else if (entry.isFile()) {
      paths.push(relativePath);
    } else {
      throw new Error(`Packaged SignalLab resource contains an unsupported entry: ${relativePath}`);
    }
  }
  return paths;
}

async function removeExistingDestination(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('SignalLab packaged-resource destination must be a real directory when it exists');
    }
    if (await realpath(path) !== path) {
      throw new Error('SignalLab packaged-resource destination path contains indirection');
    }
    await rm(path, { recursive: true });
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return;
    throw cause;
  }
}

async function requireCanonicalDirectory(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} path contains indirection`);
  return canonical;
}

async function requireRegularFile(path, root, label) {
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`${label} escapes its admitted root`);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (await realpath(path) !== path) throw new Error(`${label} path contains indirection`);
  // See the comment on the bridge-entry check above: meaningless on win32.
  if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable`);
  }
}

async function readJsonRegularFile(path, root, label) {
  await requireRegularFile(path, root, label);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new Error(`${label} must contain valid JSON`, { cause });
  }
}

async function copyReadOnlyFile(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o444);
}

async function writeReadOnlyJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o444);
}

function assertExactStrings(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} differs (expected ${expected.join(', ')}, received ${actual.join(', ')})`);
  }
}

function isSafeRelativeResourcePath(value) {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stageSignalLabPackagedResource().then(
    (result) => process.stdout.write(`${JSON.stringify({
      destinationRoot: result.destinationRoot,
      manifestPath: result.manifestPath,
      fileCount: result.files.length,
    })}\n`),
    (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    },
  );
}
