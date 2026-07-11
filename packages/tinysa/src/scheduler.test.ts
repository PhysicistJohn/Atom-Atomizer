import { describe, expect, it } from 'vitest';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { CommandScheduler } from './scheduler.js';
import type { ByteTransport, TransportEvent } from './transport.js';

describe('CommandScheduler', () => {
  it('serializes text, raw sweep, and fixed binary responses over fragmented transport', async () => {
    const transport = new FakeTinySaTransport({ chunkSize: 2 });
    await transport.open(transport.port);
    const scheduler = new CommandScheduler(transport);
    await expect(scheduler.execute('version')).resolves.toContain('tinySA4_');
    const raw = await scheduler.executeRawSweep('scanraw 100 200 20 0', 20);
    expect(raw).toHaveLength(20);
    const frame = await scheduler.executeBinary('capture', 480 * 320 * 2);
    expect(frame).toHaveLength(307_200);
    scheduler.dispose();
    await transport.close();
  });

  it('faults permanently on timeout instead of continuing desynchronized traffic', async () => {
    const transport = new SilentTransport();
    const scheduler = new CommandScheduler(transport);
    await expect(scheduler.execute('version', 10)).rejects.toThrow(/no longer synchronized/);
    await expect(scheduler.execute('info')).rejects.toThrow(/no longer synchronized/);
    expect(scheduler.fault).toBeInstanceOf(Error);
  });

  it('rejects firmware-overlong commands before writing', async () => {
    const transport = new SilentTransport();
    const scheduler = new CommandScheduler(transport);
    await expect(scheduler.execute('x'.repeat(48))).rejects.toThrow(/1\.\.47/);
    expect(transport.writes).toBe(0);
  });
});

class SilentTransport implements ByteTransport {
  writes = 0;
  list() { return Promise.resolve([]); }
  open() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  write() { this.writes++; return Promise.resolve(); }
  onBytes() { return () => {}; }
  onEvent(_listener: (event: TransportEvent) => void) { return () => {}; }
}
