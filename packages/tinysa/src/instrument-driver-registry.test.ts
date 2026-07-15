import { describe, expect, it } from 'vitest';
import type { InstrumentCandidate, InstrumentDriverId, InstrumentSourceKind } from '@tinysa/contracts';
import { InstrumentDriverContractError, type InstrumentDriver } from './instrument-driver.js';
import { InstrumentDriverRegistry } from './instrument-driver-registry.js';

describe('InstrumentDriverRegistry', () => {
  it('exposes only the immutable, trusted composition supplied at construction', () => {
    const signalLab = driver('signal-lab', ['signal-lab']);
    const tinySa = driver('tinysa-zs407', ['serial-port']);
    const registry = new InstrumentDriverRegistry([signalLab, tinySa]);

    expect(registry.list().map((value) => value.driverId)).toEqual(['signal-lab', 'tinysa-zs407']);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(registry.get('signal-lab'))).toBe(true);
    expect(Object.isFrozen(registry.get('signal-lab')?.sourceKinds)).toBe(true);
    expect(registry.get('signal-lab')).toMatchObject({ driverId: signalLab.driverId, sourceKinds: signalLab.sourceKinds });
    expect(registry.require('tinysa-zs407')).toMatchObject({ driverId: tinySa.driverId, sourceKinds: tinySa.sourceKinds });
    expect('register' in registry).toBe(false);
    expect(() => registry.require('missing')).toThrow(/not statically registered/);
  });

  it('rejects duplicate driver IDs before discovery can begin', () => {
    expect(() => new InstrumentDriverRegistry([
      driver('signal-lab', ['signal-lab']),
      driver('signal-lab', ['signal-lab']),
    ])).toThrow(/Duplicate instrument driver ID signal-lab/);
  });

  it('rejects malformed driver definitions and duplicate source claims', () => {
    expect(() => new InstrumentDriverRegistry([
      driver('Bad Driver ID' as InstrumentDriverId, ['serial-port']),
    ])).toThrow(InstrumentDriverContractError);
    expect(() => new InstrumentDriverRegistry([
      driver('tinysa-zs407', ['serial-port', 'serial-port']),
    ])).toThrow(/source kinds must be unique/i);
    expect(() => new InstrumentDriverRegistry([{
      driverId: 'missing-methods',
      sourceKinds: ['serial-port'],
    } as unknown as InstrumentDriver])).toThrow(/discover, connect, and pending-connection cleanup/);

    expect(() => new InstrumentDriverRegistry([{
      driverId: 'missing-cleanup',
      sourceKinds: ['serial-port'],
      discover: async () => ({ candidates: [], failures: [] }),
      connect: async () => { throw new Error('not used'); },
    } as unknown as InstrumentDriver])).toThrow(/pending-connection cleanup/);
  });
});

function driver(driverId: InstrumentDriverId, sourceKinds: readonly InstrumentSourceKind[]): InstrumentDriver {
  return {
    driverId,
    sourceKinds,
    discover: async () => ({ candidates: [], failures: [] }),
    connect: async (_candidate: InstrumentCandidate) => { throw new Error('not used'); },
    cleanupPendingConnection: async () => undefined,
  };
}
