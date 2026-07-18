import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { requirePrivateEnvironmentFile } = require('./private-environment-file.cjs');
const {
  MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS,
  MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS,
  MAX_RENDERER_LOAD_URL_CHARACTERS,
  normalizeRendererConsoleMessage,
  normalizeRendererLoadFailure,
  rendererGoneDiagnostic,
  rendererProcessMetricSnapshot,
  routeRendererConsoleMessage,
} = require('./renderer-diagnostics.cjs');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('the installed Electron launcher contains every launcher-local runtime dependency', () => {
  const launcher = readFileSync(join(here, 'main.cjs'), 'utf8');
  const installer = readFileSync(join(here, 'install.mjs'), 'utf8');
  const localDependencies = [...launcher.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)]
    .map((match) => match[1]);

  assert(localDependencies.length > 0, 'launcher must expose at least one auditable local dependency');
  for (const dependency of localDependencies) {
    assert.equal(existsSync(join(here, dependency)), true, `launcher dependency must exist: ${dependency}`);
    assert.match(
      installer,
      new RegExp(`cpSync\\(join\\(here, ['"]${escapeRegExp(dependency)}['"]\\), join\\(runtime, ['"]${escapeRegExp(dependency)}['"]\\)\\)`),
      `installer must copy launcher dependency ${dependency}`,
    );
  }
});

test('the installer persists the canonical repository path instead of a symlink spelling', () => {
  const installer = readFileSync(join(here, 'install.mjs'), 'utf8');
  assert.match(
    installer,
    /const repoRoot = realpathSync\(resolve\(here, '\.\.', '\.\.'\)\);/,
    'launcher-config repoRoot must be canonicalized before it is persisted',
  );
});

describe('bounded renderer diagnostics', () => {
  test('retains Electron 43 legacy console text instead of logging only its numeric level', () => {
    assert.deepEqual(
      normalizeRendererConsoleMessage({}, 3, 'marker search failed with trace context', 2045, 'http://localhost:5173/src/App.tsx?t=secret'),
      {
        level: 'error',
        message: 'marker search failed with trace context',
        line: 2045,
        sourceId: 'http://localhost:5173/src/App.tsx',
      },
    );
  });

  test('accepts modern console details while bounding text and omitting image payloads', () => {
    assert.deepEqual(
      normalizeRendererConsoleMessage({
        level: 'warning', message: `prefix data:image/jpeg;base64,${'a'.repeat(100_000)}`,
        lineNumber: 12, sourceId: 'vite://renderer/source.ts#fragment',
      }),
      {
        level: 'warning',
        message: '[renderer console message omitted because it contains image data; characters=100030]',
        line: 12,
        sourceId: 'vite://renderer/source.ts',
      },
    );
    const bounded = normalizeRendererConsoleMessage({}, 1, 'x'.repeat(MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS + 50), 1, 'source');
    assert.ok(bounded.message.length < MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS + 100);
    assert.match(bounded.message, /50 characters truncated/);
  });

  test('promotes only a fixed-shape SignalLab admitted-session record', () => {
    const hash = 'a'.repeat(64);
    const message = `[ATOMIZER-SIGNAL-LAB-SESSION] ${JSON.stringify({
      schemaVersion: 1,
      event: 'admitted',
      sessionId: '12345678-1234-4abc-8def-123456789abc',
      driverId: 'signal-lab',
      candidate: { serialNumber: 'must-not-be-logged' },
      provenance: {
        sourceKind: 'signal-lab',
        sourceId: 'local',
        execution: 'signal-lab-simulation',
        transport: 'signal-lab-measurement-bridge',
        qualification: 'synthetic-visual-projection',
        contractId: 'tinysa-signal-lab-atomizer-measurement',
        contractVersion: 1,
        contractSha256: hash,
        catalogSha256: hash,
        generatorSha256: hash,
        claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
        serialPort: { path: '/dev/private' },
      },
    })}`;
    const routed = routeRendererConsoleMessage({
      level: 'info', message, lineNumber: 1, sourceId: 'vite://renderer/App.tsx',
    });

    assert.equal(routed.level, 'ATOMIZER-SIGNAL-LAB-SESSION');
    assert.deepEqual(JSON.parse(routed.value), {
      schemaVersion: 1,
      event: 'admitted',
      sessionId: '12345678-1234-4abc-8def-123456789abc',
      driverId: 'signal-lab',
      provenance: {
        sourceKind: 'signal-lab',
        sourceId: 'local',
        execution: 'signal-lab-simulation',
        transport: 'signal-lab-measurement-bridge',
        qualification: 'synthetic-visual-projection',
        contractId: 'tinysa-signal-lab-atomizer-measurement',
        contractVersion: 1,
        contractSha256: hash,
        catalogSha256: hash,
        generatorSha256: hash,
        claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
      },
    });
    assert.doesNotMatch(routed.value, /serial|private|candidate/i);
  });

  test('keeps malformed or physically claiming admission messages in bounded renderer diagnostics', () => {
    const routed = routeRendererConsoleMessage({
      level: 'info',
      message: '[ATOMIZER-SIGNAL-LAB-SESSION] {"schemaVersion":1,"claims":{"rfEmitted":true}}',
      lineNumber: 1,
      sourceId: 'vite://renderer/App.tsx',
    });

    assert.equal(routed.level, 'RENDERER');
    assert.match(routed.value.message, /^\[ATOMIZER-SIGNAL-LAB-SESSION\]/);
  });

  test('bounds renderer load failures and strips URL credentials, query, and fragment data', () => {
    const normalized = normalizeRendererLoadFailure(
      -105,
      'x'.repeat(MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS + 50),
      `http://operator:private-token@localhost:5173/${'p'.repeat(MAX_RENDERER_LOAD_URL_CHARACTERS + 100)}?api_key=secret#session-secret`,
      true,
    );

    assert.equal(normalized.code, -105);
    assert.equal(normalized.isMainFrame, true);
    assert.ok(normalized.description.length < MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS + 60);
    assert.match(normalized.description, /…$/);
    assert.ok(normalized.url.length <= MAX_RENDERER_LOAD_URL_CHARACTERS + 1);
    assert.match(normalized.url, /^http:\/\/<credentials>@localhost:5173\//);
    assert.doesNotMatch(normalized.url, /operator|private-token|api_key|secret/);
    assert.deepEqual(normalizeRendererLoadFailure('bad', null, null, 'true'), {
      code: undefined,
      description: '',
      url: '',
      isMainFrame: false,
    });
  });

  test('retains only one fixed-shape renderer metric and crash snapshot', () => {
    const metric = rendererProcessMetricSnapshot([{ pid: 42, type: 'Tab', creationTime: 1_000, cpu: { percentCPUUsage: 5, idleWakeupsPerSecond: 2 }, memory: { workingSetSize: 120_000, peakWorkingSetSize: 140_000 }, ignored: 'not retained' }], 42);
    assert.deepEqual(metric, {
      type: 'Tab', name: undefined, creationTime: 1_000, cpuPercent: 5, idleWakeupsPerSecond: 2,
      workingSetKb: 120_000, peakWorkingSetKb: 140_000, privateBytesKb: undefined,
    });
    assert.deepEqual(rendererGoneDiagnostic({ reason: 'crashed', exitCode: 5, ignored: 'not retained' }, {
      webContentsId: 7, osProcessId: 42, currentMetric: metric, lastMemorySample: { privateKb: 99 }, crashDumpsPath: '/bounded/dumps',
    }), {
      webContentsId: 7, osProcessId: 42, reason: 'crashed', exitCode: 5,
      currentMetric: metric, lastMemorySample: { privateKb: 99 }, crashDumpsPath: '/bounded/dumps',
    });
  });
});

describe('private development environment file', () => {
  const posixTest = process.platform === 'win32' ? test.skip : test;

  posixTest('admits a regular current-user-owned file with owner-only permissions', () => {
    for (const mode of [0o600, 0o400]) {
      const file = temporaryEnvironmentFile(mode);
      const metadata = requirePrivateEnvironmentFile(file);

      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.mode & 0o777, mode);
    }
  });

  test('rejects a missing file with a corrective command', () => {
    const root = temporaryRoot();
    const file = join(root, '.env');

    assert.throws(
      () => requirePrivateEnvironmentFile(file),
      (error) => error.message.includes('is missing')
        && error.message.includes(`chmod 600 '${file}'`),
    );
  });

  test('rejects metadata inspection failures instead of assuming the file is safe', () => {
    const root = temporaryRoot();
    const file = join(root, '.env');
    const inspectionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    assert.throws(
      () => requirePrivateEnvironmentFile(file, {
        lstatSync: () => { throw inspectionError; },
      }),
      (error) => error.message.includes('metadata could not be inspected')
        && error.message.includes(`chmod 600 '${file}'`)
        && error.cause === inspectionError,
    );
  });

  posixTest('rejects symlinks without following their private target', () => {
    const root = temporaryRoot();
    const target = join(root, 'private-target');
    const file = join(root, '.env');
    writeFileSync(target, 'not-a-real-secret\n', { mode: 0o600 });
    chmodSync(target, 0o600);
    symlinkSync(target, file);

    assert.throws(
      () => requirePrivateEnvironmentFile(file),
      /must be a regular non-symlink file/,
    );
    assert.equal(lstatSync(file).isSymbolicLink(), true);
  });

  test('rejects directories and other non-regular entries', () => {
    const root = temporaryRoot();

    assert.throws(
      () => requirePrivateEnvironmentFile(root),
      /must be a regular non-symlink file/,
    );
  });

  posixTest('rejects a file not owned by the expected current user', () => {
    const file = temporaryEnvironmentFile(0o600);
    const actualUid = lstatSync(file).uid;

    assert.throws(
      () => requirePrivateEnvironmentFile(file, { currentUid: actualUid + 1 }),
      (error) => error.message.includes(`expected UID ${actualUid + 1}`)
        && error.message.includes(`found UID ${actualUid}`)
        && error.message.includes(`sudo chown "$(id -un)" '${file}'`)
        && error.message.includes(`chmod 600 '${file}'`),
    );
  });

  posixTest('rejects every group or other permission bit with the observed mode', () => {
    for (const mode of [0o640, 0o620, 0o610, 0o604, 0o602, 0o601]) {
      const file = temporaryEnvironmentFile(mode);

      assert.throws(
        () => requirePrivateEnvironmentFile(file),
        (error) => error.message.includes(`found mode 0${mode.toString(8)}`)
          && error.message.includes(`chmod 600 '${file}'`),
      );
    }
  });

  posixTest('rejects owner-only modes that cannot be read by the launcher', () => {
    const file = temporaryEnvironmentFile(0o200);

    assert.throws(
      () => requirePrivateEnvironmentFile(file),
      /must be readable by its owner \(found mode 0200\)/,
    );
  });

  posixTest('rejects an oversized private environment file before launch', () => {
    const file = join(temporaryRoot(), '.env');
    writeFileSync(file, `VALUE=${'x'.repeat(64 * 1024)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);

    assert.throws(
      () => requirePrivateEnvironmentFile(file),
      /must not exceed 65536 bytes/,
    );
  });

  test('fails closed when the current user identity cannot be established', () => {
    const file = temporaryEnvironmentFile(0o600);

    assert.throws(
      () => requirePrivateEnvironmentFile(file, { currentUid: Number.NaN }),
      /cannot verify ownership.*fails closed/s,
    );
  });
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'atomizer-private-env-'));
  roots.push(root);
  return root;
}

function temporaryEnvironmentFile(mode) {
  const file = join(temporaryRoot(), '.env');
  writeFileSync(file, 'not-a-real-secret\n', { mode });
  chmodSync(file, mode);
  return file;
}
