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

  it('routes a manual address through driver-owned standard hooks without exposing a driver-specific failure', async () => {
    const first = {
      ...driver('signal-lab', ['signal-lab']),
      addManualEndpoint: async () => ({ ok: false, message: 'native protocol detail' } as const),
    } satisfies InstrumentDriver;
    const second = {
      ...driver('tinysa-zs407', ['serial-port']),
      addManualEndpoint: async (endpoint: string) => endpoint === 'ip:10.0.0.250'
        ? ({ ok: true } as const)
        : ({ ok: false, message: 'another native protocol detail' } as const),
    } satisfies InstrumentDriver;
    const registry = new InstrumentDriverRegistry([first, second]);

    await expect(registry.addManualEndpoint('ip:10.0.0.250')).resolves.toEqual({ ok: true });
    await expect(registry.addManualEndpoint('ip:10.0.0.251')).resolves.toEqual({
      ok: false,
      message: 'The address could not be verified by an installed instrument driver.',
    });
  });

  it('preserves a class driver receiver when dispatching its manual-address hook', async () => {
    const driver = new MethodManualEndpointDriver();
    const registry = new InstrumentDriverRegistry([driver]);

    await expect(registry.addManualEndpoint('ip:10.0.0.250')).resolves.toEqual({ ok: true });
    expect(driver.probed).toEqual(['ip:10.0.0.250']);
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

class MethodManualEndpointDriver implements InstrumentDriver {
  readonly driverId = 'tinysa-zs407' as const;
  readonly sourceKinds = ['serial-port'] as const;
  readonly probed: string[] = [];

  async discover() { return { candidates: [], failures: [] }; }
  async addManualEndpoint(endpoint: string) {
    this.probed.push(endpoint);
    return { ok: true } as const;
  }
  async connect(_candidate: InstrumentCandidate): Promise<never> { throw new Error('not used'); }
  async cleanupPendingConnection() {}
}
