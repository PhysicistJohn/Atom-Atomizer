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
