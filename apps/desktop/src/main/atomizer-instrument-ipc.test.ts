import { describe, expect, it, vi } from 'vitest';
import type { AtomizerInstrumentEvent, InstrumentCandidate, InstrumentManagerEvent } from '@tinysa/contracts';
import type { AtomizerInstrumentHost } from './atomizer-instrument-host.js';
import {
  ATOMIZER_INSTRUMENT_IPC_CHANNELS,
  registerAtomizerInstrumentIpc,
  type IpcMainRegistrar,
} from './atomizer-instrument-ipc.js';
import { BoundedPrivilegedIpcAdmission } from './privileged-ipc-admission.js';

interface TestEvent { trusted: boolean }

describe('Atomizer instrument IPC v1', () => {
  it('registers exact-arity, runtime-validated operations and removes every handler', async () => {
    const ipc = new FakeIpc();
    const host = fakeHost();
    const unregister = registerAtomizerInstrumentIpc(ipc, host.value, vi.fn(), assertTrusted, new BoundedPrivilegedIpcAdmission());
    const channels = ATOMIZER_INSTRUMENT_IPC_CHANNELS;

    expect([...ipc.handlers.keys()].sort()).toEqual(Object.values(channels).filter((channel) => channel !== channels.event).sort());
    expect(() => ipc.invoke(channels.state, { unexpected: true })).toThrow(/exactly 0 arguments/);
    expect(() => ipc.invoke(channels.connect)).toThrow(/exactly 1 argument/);
    expect(() => ipc.invoke(channels.connect, { ...candidate(), serialPort: { path: '/dev/forged' } })).toThrow();

    await ipc.invoke(channels.connect, candidate());
    expect(host.connect).toHaveBeenCalledWith(candidate());
    expect(() => ipc.invoke(channels.writePreference, { driverId: 'signal-lab', candidateKind: 'usb' }))
      .toThrow();

    unregister();
    expect(ipc.handlers.size).toBe(0);
    expect(host.unsubscribe).toHaveBeenCalledOnce();
  });

  it('publishes only schema-admitted host events on the versioned channel', () => {
    const ipc = new FakeIpc();
    const host = fakeHost();
    const publish = vi.fn();
    registerAtomizerInstrumentIpc(ipc, host.value, publish, assertTrusted, new BoundedPrivilegedIpcAdmission());
    const discovery: InstrumentManagerEvent = {
      type: 'discovery',
      result: {
        discoveryRevision: 'discovery:1', discoveredAt: '2026-07-14T20:00:00.000Z',
        candidates: [candidate()], failures: [],
      },
    };

    host.listener?.(discovery);

    expect(publish).toHaveBeenCalledWith(ATOMIZER_INSTRUMENT_IPC_CHANNELS.event, discovery);
    expect(() => host.listener?.({ type: 'measurement', measurement: { forged: true } } as never)).toThrow();
  });

  it('rejects untrusted events before arity parsing across every instrument handler', () => {
    const ipc = new FakeIpc();
    const host = fakeHost();
    registerAtomizerInstrumentIpc(ipc, host.value, vi.fn(), assertTrusted, new BoundedPrivilegedIpcAdmission());

    for (const channel of Object.values(ATOMIZER_INSTRUMENT_IPC_CHANNELS)) {
      if (channel === ATOMIZER_INSTRUMENT_IPC_CHANNELS.event) continue;
      expect(() => ipc.invokeFrom(channel, { trusted: false })).toThrow(/untrusted renderer/i);
    }
    expect(host.connect).not.toHaveBeenCalled();
  });

  it('rejects a renderer flood before admitting more retained work', async () => {
    const ipc = new FakeIpc();
    const host = fakeHost();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    (host.value.discover as ReturnType<typeof vi.fn>).mockReturnValue(pending);
    const admission = new BoundedPrivilegedIpcAdmission(1);
    registerAtomizerInstrumentIpc(ipc, host.value, vi.fn(), assertTrusted, admission);

    const first = ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.discover) as Promise<void>;
    expect(admission.pending).toBe(1);
    expect(() => ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.state)).toThrow(/admission limit/i);
    expect(host.value.state).not.toHaveBeenCalled();

    release();
    await first;
    expect(admission.pending).toBe(0);
    expect(ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.state)).toMatchObject({ schemaVersion: 1 });
  });

  it('admits and coalesces RF-safe disconnect through a full normal cap after trust and arity checks', async () => {
    const ipc = new FakeIpc();
    const host = fakeHost();
    let releaseNormal!: () => void;
    let releaseDisconnect!: () => void;
    (host.value.discover as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((resolve) => { releaseNormal = resolve; }),
    );
    const disconnecting = new Promise<void>((resolve) => { releaseDisconnect = resolve; });
    (host.value.disconnect as ReturnType<typeof vi.fn>).mockReturnValue(disconnecting);
    const admission = new BoundedPrivilegedIpcAdmission(1);
    registerAtomizerInstrumentIpc(ipc, host.value, vi.fn(), assertTrusted, admission);

    const normal = ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.discover) as Promise<void>;
    expect(admission.pending).toBe(1);
    expect(() => ipc.invokeFrom(ATOMIZER_INSTRUMENT_IPC_CHANNELS.disconnect, { trusted: false }))
      .toThrow(/untrusted renderer/i);
    expect(() => ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.disconnect, 'extra'))
      .toThrow(/exactly 0 arguments/);
    expect(host.value.disconnect).not.toHaveBeenCalled();

    const first = ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.disconnect) as Promise<void>;
    const second = ipc.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.disconnect) as Promise<void>;
    expect(second).toBe(first);
    expect(host.value.disconnect).toHaveBeenCalledOnce();

    releaseDisconnect();
    await first;
    releaseNormal();
    await normal;
  });
});

class FakeIpc implements IpcMainRegistrar<TestEvent> {
  readonly handlers = new Map<string, (event: TestEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: TestEvent, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate ${channel}`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
  invoke(channel: string, ...args: unknown[]): unknown {
    return this.invokeFrom(channel, { trusted: true }, ...args);
  }
  invokeFrom(channel: string, event: TestEvent, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return handler(event, ...args);
  }
}

function assertTrusted(event: TestEvent): void {
  if (!event.trusted) throw new Error('Rejected IPC from an untrusted renderer frame or origin');
}

function fakeHost() {
  let listener: ((event: AtomizerInstrumentEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const connect = vi.fn(async () => undefined);
  const value = {
    state: vi.fn(() => ({
      schemaVersion: 1,
      startup: { status: 'not-started' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
    })),
    discover: vi.fn(async () => undefined),
    connect,
    disconnect: vi.fn(async () => undefined),
    configure: vi.fn(async () => undefined),
    acquire: vi.fn(async () => undefined),
    startStreaming: vi.fn(async () => undefined),
    stopStreaming: vi.fn(async () => undefined),
    executeFeature: vi.fn(async () => undefined),
    readPreference: vi.fn(async () => undefined),
    writePreference: vi.fn(async () => undefined),
    subscribe: vi.fn((next: (event: AtomizerInstrumentEvent) => void) => { listener = next; return unsubscribe; }),
  } as unknown as AtomizerInstrumentHost;
  return { value, connect, unsubscribe, get listener() { return listener; } };
}

function candidate(): InstrumentCandidate {
  return {
    schemaVersion: 1, driverId: 'signal-lab', candidateId: 'signal-lab:default',
    displayName: 'SignalLab', sourceKind: 'signal-lab', signalLab: { sourceId: 'default' },
    discoveryRevision: 'discovery:1',
  };
}
