import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPrivateEnvironmentFile,
  loadPrivateEnvironmentFromCandidates,
  selectPrivateEnvironmentCandidates,
} from './private-environment.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('private environment loading', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('parses through the validated descriptor and does not override parent values', async () => {
    const root = await temporaryRoot();
    const path = join(root, '.env');
    await writeFile(path, 'OPENAI_KEY="file-secret"\nNEW_PRIVATE_VALUE=loaded\n', { mode: 0o600 });
    const environment = { OPENAI_KEY: 'parent-secret' } as NodeJS.ProcessEnv;
    const result = await loadPrivateEnvironmentFile(path, { environment });
    expect(result).toEqual({ path, loadedKeys: ['NEW_PRIVATE_VALUE'] });
    expect(environment).toEqual({ OPENAI_KEY: 'parent-secret', NEW_PRIVATE_VALUE: 'loaded' });
  });

  posixIt('rejects a symlink at the exact path instead of following it', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'target.env');
    const link = join(root, '.env');
    await writeFile(target, 'OPENAI_KEY=secret\n', { mode: 0o600 });
    await symlink(target, link);
    await expect(loadPrivateEnvironmentFile(link, { environment: {} }))
      .rejects.toThrow(/regular non-symlink|opened securely/i);
  });

  posixIt('rejects group/other permissions and ownership mismatch', async () => {
    const root = await temporaryRoot();
    const path = join(root, '.env');
    await writeFile(path, 'OPENAI_KEY=secret\n', { mode: 0o600 });
    await chmod(path, 0o640);
    await expect(loadPrivateEnvironmentFile(path, { environment: {} }))
      .rejects.toThrow(/no permissions to group or other/i);
    await chmod(path, 0o600);
    await expect(loadPrivateEnvironmentFile(path, {
      currentUid: (typeof process.getuid === 'function' ? process.getuid() : 0) + 1,
      environment: {},
    })).rejects.toThrow(/owned by the current user/i);
  });

  posixIt('rejects an oversized private environment file before reading it', async () => {
    const root = await temporaryRoot();
    const path = join(root, '.env');
    await writeFile(path, `VALUE=${'x'.repeat(64 * 1024)}\n`, { mode: 0o600 });
    await expect(loadPrivateEnvironmentFile(path, { environment: {} }))
      .rejects.toThrow(/must not exceed 65536 bytes/i);
  });

  it('fails closed for a missing explicit path but permits absent implicit candidates', async () => {
    const root = await temporaryRoot();
    const missing = join(root, 'missing.env');
    await expect(loadPrivateEnvironmentFromCandidates([missing], {
      explicitFirstCandidate: true,
      environment: {},
    })).rejects.toThrow(process.platform === 'win32' ? /inherited process environment/i : /is missing/i);
    await expect(loadPrivateEnvironmentFromCandidates([missing], { environment: {} }))
      .resolves.toBeUndefined();
  });

  it('rejects an absent or blank explicit path before candidate filtering', async () => {
    await expect(loadPrivateEnvironmentFromCandidates([], {
      explicitFirstCandidate: true,
      environment: {},
    })).rejects.toThrow(/explicit environment file path must not be blank/i);
    await expect(loadPrivateEnvironmentFromCandidates(['   '], {
      explicitFirstCandidate: true,
      environment: {},
    })).rejects.toThrow(/explicit environment file path must not be blank/i);
  });

  it('never turns a whitespace TINYSA_ENV_FILE override into implicit fallback candidates', () => {
    expect(selectPrivateEnvironmentCandidates('   ', ['/implicit/project.env', '/implicit/repo.env']))
      .toEqual({ candidates: [''], explicitFirstCandidate: true });
    expect(selectPrivateEnvironmentCandidates(undefined, ['/implicit/project.env', '/implicit/repo.env']))
      .toEqual({
        candidates: ['/implicit/project.env', '/implicit/repo.env'],
        explicitFirstCandidate: false,
      });
  });

  posixIt('does not bypass an unsafe earlier candidate by falling back to a later file', async () => {
    const root = await temporaryRoot();
    const unsafe = join(root, 'unsafe.env');
    const safe = join(root, 'safe.env');
    await writeFile(unsafe, 'FIRST=value\n', { mode: 0o644 });
    await writeFile(safe, 'SECOND=value\n', { mode: 0o600 });
    await expect(loadPrivateEnvironmentFromCandidates([unsafe, safe], { environment: {} }))
      .rejects.toThrow(/no permissions to group or other/i);
  });

  it.runIf(process.platform === 'win32')('does not consume implicit files when secure no-follow opens are unavailable', async () => {
    const root = await temporaryRoot();
    const path = join(root, '.env');
    await writeFile(path, 'OPENAI_KEY=secret\n');
    await expect(loadPrivateEnvironmentFromCandidates([path], { environment: {} }))
      .rejects.toThrow(/inherited process environment/i);
  });

  it('refuses an existing implicit file when the platform cannot prove a no-follow open', async () => {
    const root = await temporaryRoot();
    const path = join(root, '.env');
    const missing = join(root, 'missing.env');
    await writeFile(path, 'OPENAI_KEY=secret\n', { mode: 0o600 });
    await expect(loadPrivateEnvironmentFromCandidates([path], {
      environment: {},
      secureNoFollowOpen: false,
    })).rejects.toThrow(/inherited process environment/i);
    await expect(loadPrivateEnvironmentFromCandidates([missing], {
      environment: {},
      secureNoFollowOpen: false,
    })).resolves.toBeUndefined();
    await expect(loadPrivateEnvironmentFromCandidates([missing], {
      environment: {},
      explicitFirstCandidate: true,
      secureNoFollowOpen: false,
    })).rejects.toThrow(/inherited process environment/i);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atomizer-private-env-'));
  roots.push(root);
  return root;
}
