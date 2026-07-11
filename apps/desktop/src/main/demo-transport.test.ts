import { describe, expect, it } from 'vitest';
import type { PortCandidate } from '@tinysa/contracts';
import type { ByteTransport, TransportEvent } from '@tinysa/device';
import { AutoDemoTransport } from './demo-transport.js';

describe('automatic Signal Lab transport', () => {
  it('exposes and controls the synthesized ZS407 when no exact device is detected', async () => {
    const transport = new AutoDemoTransport(new StubTransport([]));
    const candidates = await transport.list();
    expect(candidates[0]).toMatchObject({ path: 'fake://atom-signal-lab', usbMatch: 'exact-zs407-cdc' });
    expect(transport.status()).toMatchObject({ available: true, active: false, playback: false, profile: 'cw' });
    await transport.open(candidates[0]!);
    expect(transport.setPlayback(true)).toMatchObject({ active: true, playback: true });
    expect(transport.select('lte-etm1.1')).toMatchObject({ active: true, profile: 'lte-etm1.1', waveform: { qualification: 'standards-derived' } });
    expect(transport.configureChannel({ model: 'rayleigh', noiseFloorDbm: -105, seed: 407, fadingRateHz: 3 })).toMatchObject({ channel: { model: 'rayleigh', noiseFloorDbm: -105 } });
    await transport.close();
    expect(transport.status().playback).toBe(false);
  });

  it('does not offer a demo fallback when an exact physical candidate exists', async () => {
    const exact: PortCandidate = { id: 'real', path: '/dev/real', usbMatch: 'exact-zs407-cdc' };
    const transport = new AutoDemoTransport(new StubTransport([exact]));
    expect(await transport.list()).toEqual([exact]);
    expect(transport.status().available).toBe(false);
    expect(() => transport.select('am')).toThrow(/unavailable/i);
  });

  it('surfaces physical discovery failure instead of substituting the demo', async () => {
    const physical = new StubTransport([]);
    physical.listFailure = new Error('USB discovery failed');
    await expect(new AutoDemoTransport(physical).list()).rejects.toThrow(/USB discovery failed/);
  });
});

class StubTransport implements ByteTransport {
  listFailure?: Error;
  constructor(private readonly ports: PortCandidate[]) {}
  async list(): Promise<PortCandidate[]> { if (this.listFailure) throw this.listFailure; return this.ports; }
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async write(): Promise<void> {}
  onBytes(): () => void { return () => undefined; }
  onEvent(_listener: (event: TransportEvent) => void): () => void { return () => undefined; }
}
