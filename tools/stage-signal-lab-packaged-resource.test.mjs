import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import {
  SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS,
  stageSignalLabPackagedResource,
  verifySignalLabPackagedResource,
} from './stage-signal-lab-packaged-resource.mjs';
import afterPackSignalLabResource from './after-pack-signal-lab-resource.mjs';

const execFileAsync = promisify(execFile);
const temporaryRoots = [];
const posixTest = process.platform === 'win32' ? test.skip : test;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

posixTest('stages one executable, self-contained packaged SignalLab resource root', async () => {
  const fixture = await createFixture();
  const result = await stageSignalLabPackagedResource({
    sourceRepositoryRoot: fixture.sourceRoot,
    destinationRoot: fixture.destinationRoot,
  });
  assert.equal(result.destinationRoot, fixture.destinationRoot);

  const packageManifest = JSON.parse(await readFile(resolve(fixture.destinationRoot, 'package.json'), 'utf8'));
  assert.deepEqual(packageManifest, {
    name: 'tinysa-signal-lab-packaged-resource',
    version: '0.1.0',
    private: true,
    type: 'module',
    dependencies: { zod: '4.3.6' },
  });
  const entry = resolve(fixture.destinationRoot, 'dist', 'bridge', 'atomizer-bridge.js');
  assert.notEqual((await stat(entry)).mode & 0o111, 0);
  assert.equal((await stat(entry)).mode & 0o022, 0);
  assert.equal(await readFile(resolve(fixture.destinationRoot, 'contracts', fixture.contractFile), 'utf8'), fixture.contractBytes);

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.deepEqual(manifest.generatorArtifacts, SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS);
  assert.ok(manifest.files.some((item) => item.path === 'node_modules/zod/index.js'));
  assert.ok(manifest.files.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256) && item.sizeBytes > 0));
  await assert.doesNotReject(verifySignalLabPackagedResource(fixture.destinationRoot));

  const executed = await execFileAsync(process.execPath, ['--disable-proto=throw', entry], {
    cwd: fixture.destinationRoot,
    timeout: 2_000,
  });
  assert.equal(executed.stdout, 'packaged-zod-ok\n');

  const changedArtifact = resolve(fixture.destinationRoot, 'dist', 'bridge', 'catalog.js');
  await chmod(changedArtifact, 0o644);
  await writeFile(changedArtifact, 'export const changed = true;\n');
  await assert.rejects(
    verifySignalLabPackagedResource(fixture.destinationRoot),
    /changed after staging/u,
  );
});

posixTest('rejects a symlinked bridge artifact instead of packaging path indirection', async () => {
  const fixture = await createFixture();
  const artifact = resolve(fixture.sourceRoot, 'dist', 'bridge', 'waveforms.js');
  await rm(artifact);
  await symlink(resolve(fixture.sourceRoot, 'dist', 'bridge', 'catalog.js'), artifact);
  await assert.rejects(
    stageSignalLabPackagedResource({
      sourceRepositoryRoot: fixture.sourceRoot,
      destinationRoot: fixture.destinationRoot,
    }),
    /symlink/u,
  );
});

test('desktop packaging performs one clean root build before staging and declares the complete packaged runtime', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const desktopPackage = JSON.parse(await readFile(
    resolve(repositoryRoot, 'apps', 'desktop', 'package.json'),
    'utf8',
  ));
  const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const command = desktopPackage.scripts?.['package:mac'] ?? '';
  const rootBuild = 'npm --prefix ../.. run build';
  assert.equal(rootPackage.scripts?.['package:mac'], 'npm run package:mac -w @tinysa/desktop');
  assert.equal((rootPackage.scripts?.['package:mac'] ?? '').split('run build').length - 1, 0);
  assert.equal(command.split(rootBuild).length - 1, 1, 'package:mac must perform exactly one root workspace build');
  assert.ok(command.indexOf('run build:bridge') < command.indexOf(rootBuild));
  assert.ok(command.indexOf(rootBuild) < command.indexOf('stage:signal-lab-resource'));
  assert.ok(command.indexOf('stage:signal-lab-resource') < command.indexOf('electron-builder'));
  assert.doesNotMatch(command, /(?:^|&&\s*)npm run build(?:\s|&&|$)/u, 'the desktop-only build can ship stale workspace outputs');
  assert.equal(desktopPackage.devDependencies?.['electron-builder'], '26.15.3');
  assert.equal(desktopPackage.build?.asar, true);
  assert.deepEqual(desktopPackage.build?.asarUnpack, [
    'node_modules/@serialport/**',
    'node_modules/serialport/**',
  ]);
  assert.deepEqual(desktopPackage.build?.files, [
    'dist/main/**',
    'dist/renderer/**',
    'package.json',
  ]);
  assert.deepEqual(desktopPackage.build?.extraResources, [{
    from: 'dist/packaged-resources/signal-lab',
    to: 'signal-lab',
    filter: ['**/*'],
  }]);
  assert.equal(desktopPackage.build?.afterPack, '../../tools/after-pack-signal-lab-resource.mjs');

  const workspacePackages = await readWorkspacePackages(repositoryRoot);
  const runtimeWorkspaceNames = collectWorkspaceDependencyClosure(desktopPackage, workspacePackages);
  const rootBuildCommand = rootPackage.scripts?.build ?? '';
  const workspaceBuildIndexes = new Map();
  for (const name of runtimeWorkspaceNames) {
    const invocation = `npm run build -w ${name}`;
    assert.equal(rootBuildCommand.split(invocation).length - 1, 1, `root build must build ${name} exactly once`);
    const buildIndex = rootBuildCommand.indexOf(invocation);
    workspaceBuildIndexes.set(name, buildIndex);
    const manifest = workspacePackages.get(name);
    assert.equal(manifest?.exports?.['.'], './dist/index.js', `${name} must expose the artifact produced by the root build`);
  }
  for (const name of runtimeWorkspaceNames) {
    const manifest = workspacePackages.get(name);
    for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
      if (!workspaceBuildIndexes.has(dependency)) continue;
      assert.ok(
        workspaceBuildIndexes.get(dependency) < workspaceBuildIndexes.get(name),
        `root build must place ${dependency} before dependent workspace ${name}`,
      );
    }
  }
  const desktopBuild = 'npm run build -w @tinysa/desktop';
  assert.equal(rootBuildCommand.split(desktopBuild).length - 1, 1);
  assert.ok(
    [...workspaceBuildIndexes.values()].every((buildIndex) => rootBuildCommand.indexOf(desktopBuild) > buildIndex),
    'desktop must build after every external workspace package',
  );

  const lock = JSON.parse(await readFile(resolve(repositoryRoot, 'package-lock.json'), 'utf8'));
  const runtimePackages = collectExternalDependencyClosure(desktopPackage, workspacePackages, lock.packages ?? {});
  for (const name of ['dotenv', 'ws', 'zod', 'serialport', '@serialport/bindings-cpp']) {
    assert.ok(runtimePackages.has(name), `packaged production dependency closure must contain ${name}`);
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    assert.ok(lockEntry && lockEntry.dev !== true, `${name} must be installed as a production dependency`);
  }
});

test('the Electron after-pack hook fails closed outside the declared macOS target', async () => {
  for (const electronPlatformName of ['win32', 'linux']) {
    await assert.rejects(
      afterPackSignalLabResource({ electronPlatformName }),
      /only the declared macOS package target/u,
    );
  }
});

posixTest('the Electron after-pack hook verifies the copied tree and restores executable mode before signing', async () => {
  const fixture = await createFixture();
  const appOutDir = resolve(fixture.root, 'mac-arm64');
  const packagedRoot = resolve(
    appOutDir,
    'TinySA Atomizer.app',
    'Contents',
    'Resources',
    'signal-lab',
  );
  await stageSignalLabPackagedResource({
    sourceRepositoryRoot: fixture.sourceRoot,
    destinationRoot: packagedRoot,
  });
  const entry = resolve(packagedRoot, 'dist', 'bridge', 'atomizer-bridge.js');
  await chmod(entry, 0o444);

  await afterPackSignalLabResource({
    electronPlatformName: 'darwin',
    appOutDir,
    packager: { appInfo: { productFilename: 'TinySA Atomizer' } },
  });

  expectExecutable(await stat(entry));
});

async function createFixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'atomizer-packaged-signal-lab-')));
  temporaryRoots.push(root);
  const sourceRoot = resolve(root, 'TinySA_SignalLab');
  const destinationRoot = resolve(root, 'Atomizer', 'dist', 'packaged-resources', 'signal-lab');
  const contractFile = 'signal-lab-measurement-bridge-v1.json';
  const contract = {
    documentType: 'contract-manifest',
    contractId: 'tinysa-signal-lab-atomizer-measurement',
    contractVersion: 1,
    status: 'active',
  };
  const contractBytes = `${JSON.stringify(contract)}\n`;
  await Promise.all([
    mkdir(resolve(sourceRoot, 'dist', 'bridge'), { recursive: true }),
    mkdir(resolve(sourceRoot, 'contracts'), { recursive: true }),
    mkdir(resolve(sourceRoot, 'node_modules', 'zod'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(sourceRoot, 'package.json'), JSON.stringify({
      name: 'tinysa-signal-lab',
      version: '0.1.0',
      type: 'module',
      dependencies: { zod: '4.3.6' },
    })),
    writeFile(resolve(sourceRoot, 'contracts', contractFile), contractBytes),
    writeFile(resolve(sourceRoot, 'node_modules', 'zod', 'package.json'), JSON.stringify({
      name: 'zod',
      version: '4.3.6',
      type: 'module',
      exports: './index.js',
    })),
    writeFile(resolve(sourceRoot, 'node_modules', 'zod', 'index.js'), 'export const z = { packaged: true };\n'),
    writeFile(resolve(sourceRoot, 'node_modules', 'zod', 'LICENSE'), 'MIT fixture\n'),
  ]);
  for (const name of SIGNAL_LAB_PACKAGED_GENERATOR_ARTIFACTS) {
    const contents = name === 'atomizer-bridge.js'
      ? "#!/usr/bin/env node\nimport { z } from 'zod';\nif (!z.packaged) process.exit(2);\nprocess.stdout.write('packaged-zod-ok\\n');\n"
      : `export const artifact = ${JSON.stringify(name)};\n`;
    await writeFile(resolve(sourceRoot, 'dist', 'bridge', name), contents, { mode: name === 'atomizer-bridge.js' ? 0o755 : 0o644 });
    await writeFile(resolve(sourceRoot, 'dist', 'bridge', `${name}.map`), '{}\n');
  }
  return { root, sourceRoot, destinationRoot, contractFile, contractBytes };
}

function expectExecutable(metadata) {
  assert.notEqual(metadata.mode & 0o111, 0);
  assert.equal(metadata.mode & 0o022, 0);
}

async function readWorkspacePackages(repositoryRoot) {
  const packages = new Map();
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(resolve(repositoryRoot, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(repositoryRoot, parent, entry.name, 'package.json');
      let manifest;
      try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
      catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') continue;
        throw cause;
      }
      if (typeof manifest.name === 'string') packages.set(manifest.name, manifest);
    }
  }
  return packages;
}

function collectWorkspaceDependencyClosure(rootManifest, workspacePackages) {
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Workspace dependency cycle at ${name}`);
    const manifest = workspacePackages.get(name);
    if (!manifest) return;
    visiting.add(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    if (name !== rootManifest.name) ordered.push(name);
  };
  for (const name of Object.keys(rootManifest.dependencies ?? {})) visit(name);
  return ordered;
}

function collectExternalDependencyClosure(rootManifest, workspacePackages, lockPackages) {
  const external = new Set();
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const workspace = workspacePackages.get(name);
    const manifest = workspace ?? lockPackages[`node_modules/${name}`];
    if (!manifest) throw new Error(`Runtime dependency ${name} is absent from workspaces and package-lock.json`);
    if (!workspace) external.add(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency);
  };
  for (const name of Object.keys(rootManifest.dependencies ?? {})) visit(name);
  return external;
}
