import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECENT_P210_DEVICE_STORE_FILENAME, RecentP210DeviceStore } from './recent-devices-store.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'neptune-recent-devices-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixedRuntime(nowIso: string) {
  return { now: () => new Date(nowIso), randomId: () => 'fixed' };
}

describe('RecentP210DeviceStore', () => {
  it('lists nothing when no file has ever been written', async () => {
    const store = new RecentP210DeviceStore(directory);
    expect(await store.list()).toEqual([]);
  });

  it('records a device and lists it back within the retention window', async () => {
    const store = new RecentP210DeviceStore(directory, fixedRuntime('2026-07-31T12:00:00.000Z'));
    await store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250', contextDescription: 'PlutoSDR Rev.B' });
    const listed = await store.list();
    expect(listed).toEqual([{
      sourceKind: 'neptune-p210',
      endpoint: 'ip:10.0.0.250',
      contextDescription: 'PlutoSDR Rev.B',
      connectedAt: '2026-07-31T12:00:00.000Z',
    }]);
  });

  it('persists to disk under the documented filename, readable by a fresh store instance', async () => {
    const store = new RecentP210DeviceStore(directory, fixedRuntime('2026-07-31T12:00:00.000Z'));
    await store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' });
    const reopened = new RecentP210DeviceStore(directory, fixedRuntime('2026-07-31T12:00:01.000Z'));
    expect(await reopened.list()).toHaveLength(1);
    const bytes = await readFile(join(directory, RECENT_P210_DEVICE_STORE_FILENAME), 'utf8');
    expect(JSON.parse(bytes)).toHaveLength(1);
  });

  it('upserts by (sourceKind, endpoint): a repeat connection refreshes connectedAt instead of duplicating', async () => {
    const store = new RecentP210DeviceStore(directory, {
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      randomId: () => 'a',
    });
    await store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' });
    const store2 = new RecentP210DeviceStore(directory, {
      now: () => new Date('2026-07-31T18:00:00.000Z'),
      randomId: () => 'b',
    });
    await store2.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' });
    const listed = await store2.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.connectedAt).toBe('2026-07-31T18:00:00.000Z');
  });

  it('keeps distinct records for the same endpoint under different source kinds (physical vs twin)', async () => {
    const store = new RecentP210DeviceStore(directory, fixedRuntime('2026-07-31T12:00:00.000Z'));
    await store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:127.0.0.1' });
    await store.record({ sourceKind: 'neptune-p210-twin', endpoint: 'ip:127.0.0.1' });
    expect(await store.list()).toHaveLength(2);
  });

  it('excludes (and prunes on disk) a record older than the retention window', async () => {
    const writeStore = new RecentP210DeviceStore(directory, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      randomId: () => 'old',
    });
    await writeStore.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' });

    const readStore = new RecentP210DeviceStore(directory, {
      now: () => new Date('2026-07-31T12:00:00.000Z'), // 30 days later
      randomId: () => 'read',
    });
    expect(await readStore.list()).toEqual([]);

    const bytes = await readFile(join(directory, RECENT_P210_DEVICE_STORE_FILENAME), 'utf8');
    expect(JSON.parse(bytes)).toEqual([]);
  });

  it('honors a custom maxAgeMs override', async () => {
    const store = new RecentP210DeviceStore(directory, {
      now: () => new Date('2026-07-31T00:00:00.000Z'),
      randomId: () => 'x',
    });
    await store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' });
    const later = new RecentP210DeviceStore(directory, {
      now: () => new Date('2026-07-31T02:00:00.000Z'), // 2 hours later
      randomId: () => 'y',
    });
    // Order matters: list() prunes expired entries from disk as a side
    // effect, so the wider (still-fresh) window is checked first -- a
    // narrower-window check afterward legitimately finds the same record
    // already pruned away, which is exercised as its own outcome below
    // rather than mixed into this assertion.
    expect(await later.list(3 * 60 * 60 * 1000)).toHaveLength(1); // 3-hour window: still fresh
    expect(await later.list(60 * 60 * 1000)).toEqual([]); // 1-hour window: expired (and now pruned)
  });

  it('treats a corrupt file as empty rather than throwing', async () => {
    await writeFile(join(directory, RECENT_P210_DEVICE_STORE_FILENAME), 'not valid json{{{', { mode: 0o600 });
    const store = new RecentP210DeviceStore(directory);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('drops structurally invalid entries while keeping valid ones from the same file', async () => {
    const mixed = [
      { sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250', connectedAt: '2026-07-31T12:00:00.000Z' },
      { sourceKind: 'not-a-real-kind', endpoint: 'ip:10.0.0.251', connectedAt: '2026-07-31T12:00:00.000Z' },
      { endpoint: 'ip:10.0.0.252', connectedAt: '2026-07-31T12:00:00.000Z' },
    ];
    await writeFile(join(directory, RECENT_P210_DEVICE_STORE_FILENAME), JSON.stringify(mixed), { mode: 0o600 });
    const store = new RecentP210DeviceStore(directory, fixedRuntime('2026-07-31T12:00:01.000Z'));
    const listed = await store.list();
    expect(listed).toEqual([{ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250', connectedAt: '2026-07-31T12:00:00.000Z' }]);
  });

  it('never throws out of record() even when the target directory cannot be created', async () => {
    // A file (not a directory) at the parent path makes mkdir fail.
    const blockedParent = join(directory, 'blocked');
    await writeFile(blockedParent, 'not a directory', { mode: 0o600 });
    const store = new RecentP210DeviceStore(join(blockedParent, 'nested'));
    await expect(store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' })).resolves.toBeUndefined();
  });

  it('creates the storage directory on first write when it does not yet exist', async () => {
    const nested = join(directory, 'nested', 'instrument');
    const store = new RecentP210DeviceStore(nested, fixedRuntime('2026-07-31T12:00:00.000Z'));
    await store.record({ sourceKind: 'neptune-p210', endpoint: 'ip:10.0.0.250' });
    expect(await store.list()).toHaveLength(1);
  });
});
