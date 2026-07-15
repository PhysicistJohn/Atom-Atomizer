import { chmod, link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INSTRUMENT_PREFERENCE_FILENAME,
  InstrumentPreferenceError,
  InstrumentPreferenceStore,
  SIGNAL_LAB_DRIVER_ID,
} from './instrument-preference.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'atomizer-instrument-preference-'));
  roots.push(root);
  const directory = join(root, 'preferences');
  return { root, directory, store: new InstrumentPreferenceStore(directory, {
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    randomUuid: () => 'deterministic-id',
  }) };
}

describe('InstrumentPreferenceStore', () => {
  it('uses SignalLab as the explicit factory default only when no file exists', async () => {
    const fixture = await store();
    await expect(fixture.store.load()).resolves.toEqual({
      source: 'factory-default',
      preference: {
        schemaVersion: 1,
        driverId: SIGNAL_LAB_DRIVER_ID,
        candidateKind: 'signal-lab',
        candidateId: 'signal-lab:default',
        updatedAt: '1970-01-01T00:00:00.000Z',
      },
    });
  });

  it('durably round-trips the exact operator-selected candidate without adding transport fields', async () => {
    const fixture = await store();
    await expect(fixture.store.save('tinysa-zs407', 'serial-port', 'serial:/dev/tty.fixture')).resolves.toEqual({
      schemaVersion: 1,
      driverId: 'tinysa-zs407',
      candidateKind: 'serial-port',
      candidateId: 'serial:/dev/tty.fixture',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });
    await expect(fixture.store.load()).resolves.toEqual({
      source: 'persisted',
      preference: {
        schemaVersion: 1,
        driverId: 'tinysa-zs407',
        candidateKind: 'serial-port',
        candidateId: 'serial:/dev/tty.fixture',
        updatedAt: '2026-07-14T12:00:00.000Z',
      },
    });
    expect(JSON.parse(await readFile(join(fixture.directory, INSTRUMENT_PREFERENCE_FILENAME), 'utf8'))).not.toHaveProperty('path');
  });

  it('loads a legacy v1 preference without silently manufacturing a candidate ID', async () => {
    const fixture = await store();
    await mkdir(fixture.directory);
    const legacy = {
      schemaVersion: 1,
      driverId: 'tinysa-zs407',
      candidateKind: 'serial-port',
      updatedAt: '2026-07-14T12:00:00.000Z',
    };
    await writeFile(join(fixture.directory, INSTRUMENT_PREFERENCE_FILENAME), JSON.stringify(legacy), { mode: 0o600 });
    await expect(fixture.store.load()).resolves.toEqual({ source: 'persisted', preference: legacy });
  });

  it.each([
    ['invalid JSON', '{'],
    ['unknown fields', JSON.stringify({ schemaVersion: 1, driverId: 'signal-lab', updatedAt: new Date().toISOString(), path: '/dev/tty' })],
    ['unsupported schema', JSON.stringify({ schemaVersion: 2, driverId: 'signal-lab', updatedAt: new Date().toISOString() })],
  ])('reports %s instead of silently choosing another instrument', async (_label, content) => {
    const fixture = await store();
    await mkdir(fixture.directory);
    await writeFile(join(fixture.directory, INSTRUMENT_PREFERENCE_FILENAME), content, { mode: 0o600 });
    await expect(fixture.store.load()).rejects.toBeInstanceOf(InstrumentPreferenceError);
  });

  it('rejects a symbolic-link preference', async () => {
    const fixture = await store();
    await mkdir(fixture.directory);
    const target = join(fixture.root, 'target.json');
    await writeFile(target, JSON.stringify({ schemaVersion: 1, driverId: 'tinysa-zs407', updatedAt: new Date().toISOString() }));
    await symlink(target, join(fixture.directory, INSTRUMENT_PREFERENCE_FILENAME));
    await expect(fixture.store.load()).rejects.toThrow(/regular, non-symbolic-link/);
  });

  it('replaces the preference with owner-only permissions', async () => {
    const fixture = await store();
    await fixture.store.save('signal-lab', 'signal-lab', 'signal-lab:default');
    const path = join(fixture.directory, INSTRUMENT_PREFERENCE_FILENAME);
    await chmod(path, 0o600);
    await fixture.store.save('tinysa-zs407', 'serial-port', 'serial:/dev/tty.fixture');
    await expect(fixture.store.load()).resolves.toMatchObject({ preference: { driverId: 'tinysa-zs407' } });
  });

  it('rejects group-readable files and multiply-linked preference inodes', async () => {
    const permissions = await store();
    await permissions.store.save('signal-lab', 'signal-lab', 'signal-lab:default');
    await chmod(permissions.store.path, 0o640);
    await expect(permissions.store.load()).rejects.toThrow(/owner-only/);

    const linked = await store();
    await linked.store.save('signal-lab', 'signal-lab', 'signal-lab:default');
    await link(linked.store.path, join(linked.root, 'second-link.json'));
    await expect(linked.store.load()).rejects.toThrow(/exactly one filesystem link/);
  });
});
