import { describe, expect, it, vi } from 'vitest';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { CommandScheduler, CommandSchedulerAdmissionError } from './scheduler.js';
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

  it('hard-rejects a command flood once its bounded active-plus-queued admission is full', async () => {
    const transport = new BlockedWriteTransport();
    const scheduler = new CommandScheduler(transport, { maximumPendingCommands: 3 });
    const admitted = [
      scheduler.execute('version', 60_000),
      scheduler.execute('info', 60_000),
      scheduler.execute('status', 60_000),
    ];

    await expect(scheduler.execute('help', 60_000)).rejects.toBeInstanceOf(CommandSchedulerAdmissionError);
    expect(transport.writes).toBe(1);

    scheduler.cancelAll(new Error('test cleanup'));
    expect((await Promise.allSettled(admitted)).every((result) => result.status === 'rejected')).toBe(true);
    transport.releaseWrite();
    scheduler.dispose();
  });

  it('rejects an invalid pending-command ceiling at construction', () => {
    expect(() => new CommandScheduler(new SilentTransport(), { maximumPendingCommands: 0 })).toThrow(/positive safe integer/);
  });

  it('settles the command exactly once even when a fault observer throws', async () => {
    const transport = new RejectingWriteTransport();
    const observer = vi.fn(() => { throw new Error('observer bug'); });
    const scheduler = new CommandScheduler(transport, { onFault: observer });

    await expect(scheduler.execute('version')).rejects.toThrow(/transport write failed/i);
    expect(observer).toHaveBeenCalledOnce();
    expect(scheduler.fault?.message).toMatch(/transport write failed/i);
    scheduler.dispose();
  });
});

class SilentTransport implements ByteTransport {
  readonly kind = 'protocol-test-double' as const;
  writes = 0;
  list() { return Promise.resolve({ candidates: [], failures: [] }); }
  open() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  write() { this.writes++; return Promise.resolve(); }
  onBytes() { return () => {}; }
  onEvent(_listener: (event: TransportEvent) => void) { return () => {}; }
  consumeAcquisitionMetadata(): undefined { return undefined; }
}

class BlockedWriteTransport extends SilentTransport {
  #releaseWrite: (() => void) | undefined;
  override write(): Promise<void> {
    this.writes++;
    return new Promise((resolve) => { this.#releaseWrite = resolve; });
  }
  releaseWrite(): void { this.#releaseWrite?.(); }
}

class RejectingWriteTransport extends SilentTransport {
  override write(): Promise<void> {
    this.writes++;
    return Promise.reject(new Error('write fixture failed'));
  }
}
