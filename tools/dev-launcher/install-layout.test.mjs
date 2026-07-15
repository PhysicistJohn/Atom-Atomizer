import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
