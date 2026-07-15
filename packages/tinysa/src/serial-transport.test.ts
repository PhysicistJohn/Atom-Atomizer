import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortCandidate } from '@tinysa/contracts';
import {
  NodeSerialTransport,
  type NodeSerialPortHandle,
  type NodeSerialPortInfo,
  type NodeSerialTransportRuntime,
} from './serial-transport.js';
import type { TransportEvent } from './transport.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('NodeSerialTransport bounded native operations', () => {
  it('settles a hung enumeration as a recoverable typed failure', async () => {
    vi.useFakeTimers();
    const transport = new NodeSerialTransport({
      discoveryTimeoutMs: 25,
      runtime: runtime(() => new Promise(() => undefined)),
    });

    const listing = transport.list();
    await vi.advanceTimersByTimeAsync(25);

    await expect(listing).resolves.toEqual({
      candidates: [],
      failures: [{
        sourceKind: 'serial-port', transport: 'usb-cdc-acm', code: 'enumeration-failed',
        message: 'Serial port enumeration timed out after 25 ms', recoverable: true,
      }],
    });
  });

  it('settles a hung open and closes the obsolete handle after a late success', async () => {
    vi.useFakeTimers();
    const port = new FakeSerialPort({ open: 'manual', close: 'manual' });
    const events: TransportEvent[] = [];
    const transport = new NodeSerialTransport({
      openTimeoutMs: 20,
      runtime: runtime(async () => [], port),
    });
    transport.onEvent((event) => events.push(event));

    const opening = transport.open(exactCandidate('/dev/tty.late-open'));
    const rejectedOpening = expect(opening).rejects.toThrow('Opening serial port /dev/tty.late-open timed out after 20 ms');
    await vi.advanceTimersByTimeAsync(20);
    await rejectedOpening;

    port.completeOpen();
    await Promise.resolve();
    expect(port.closeCalls).toBe(1);
    expect(events).toEqual([]);

    port.completeClose();
    expect(port.isOpen).toBe(false);
  });

  it('settles a hung close, retains fail-closed ownership, and accepts a late close callback exactly once', async () => {
    vi.useFakeTimers();
    const first = new FakeSerialPort({ open: 'immediate', close: 'manual' });
    const second = new FakeSerialPort({ open: 'immediate', close: 'immediate' });
    const events: TransportEvent[] = [];
    const transport = new NodeSerialTransport({
      closeTimeoutMs: 15,
      runtime: runtime(async () => [], first, second),
    });
    transport.onEvent((event) => events.push(event));
    await transport.open(exactCandidate('/dev/tty.first'));

    const closing = transport.close();
    const rejectedClosing = expect(closing).rejects.toThrow('Closing serial port timed out after 15 ms');
    await vi.advanceTimersByTimeAsync(15);
    await rejectedClosing;
    await expect(transport.open(exactCandidate('/dev/tty.second'))).rejects.toThrow('already open');
    await expect(transport.write(Uint8Array.of(0x0d))).rejects.toThrow('not open');

    first.completeClose();
    await Promise.resolve();
    expect(events.map((event) => event.type)).toEqual(['opened', 'closed']);

    await transport.open(exactCandidate('/dev/tty.second'));
    expect(events.map((event) => event.type)).toEqual(['opened', 'closed', 'opened']);
  });

  it('bounds a hung native write and blocks further traffic until the port is closed', async () => {
    vi.useFakeTimers();
    const port = new FakeSerialPort({ open: 'immediate', close: 'immediate', write: 'manual' });
    const events: TransportEvent[] = [];
    const transport = new NodeSerialTransport({
      writeTimeoutMs: 12,
      runtime: runtime(async () => [], port),
    });
    transport.onEvent((event) => events.push(event));
    await transport.open(exactCandidate('/dev/tty.hung-write'));

    const writing = transport.write(Uint8Array.of(0x0d));
    const rejectedWriting = expect(writing).rejects.toThrow('Writing serial data timed out after 12 ms');
    await vi.advanceTimersByTimeAsync(12);
    await rejectedWriting;
    port.completeWrite();
    await Promise.resolve();

    await expect(transport.write(Uint8Array.of(0x0d))).rejects.toThrow('Serial port is not open');
    expect(events.map((event) => event.type)).toEqual(['opened', 'error']);
    await transport.close();
    expect(events.map((event) => event.type)).toEqual(['opened', 'error', 'closed']);
  });

  it('bounds a hung native drain and treats the possibly transmitted write as terminally uncertain', async () => {
    vi.useFakeTimers();
    const port = new FakeSerialPort({ open: 'immediate', close: 'immediate', drain: 'manual' });
    const transport = new NodeSerialTransport({
      writeTimeoutMs: 9,
      runtime: runtime(async () => [], port),
    });
    await transport.open(exactCandidate('/dev/tty.hung-drain'));

    const writing = transport.write(Uint8Array.of(0x0d));
    const rejectedWriting = expect(writing).rejects.toThrow('Draining serial data exceeded the 9 ms serial write deadline');
    await vi.advanceTimersByTimeAsync(9);
    await rejectedWriting;
    port.completeDrain(new Error('late drain error'));
    await Promise.resolve();

    await expect(transport.write(Uint8Array.of(0x0d))).rejects.toThrow('Serial port is not open');
    await transport.close();
  });

  it('uses one write deadline across native write and drain phases', async () => {
    vi.useFakeTimers();
    const port = new FakeSerialPort({ open: 'immediate', close: 'immediate', write: 'manual', drain: 'manual' });
    const transport = new NodeSerialTransport({
      writeTimeoutMs: 10,
      runtime: runtime(async () => [], port),
    });
    await transport.open(exactCandidate('/dev/tty.shared-write-deadline'));

    const writing = transport.write(Uint8Array.of(0x0d));
    const rejectedWriting = expect(writing).rejects.toThrow('Draining serial data exceeded the 10 ms serial write deadline');
    await vi.advanceTimersByTimeAsync(8);
    port.completeWrite();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2);
    await rejectedWriting;
    await transport.close();
  });

  it('makes a native write callback error terminal for the admitted port', async () => {
    const port = new FakeSerialPort({ open: 'immediate', close: 'immediate', write: 'manual' });
    const events: TransportEvent[] = [];
    const transport = new NodeSerialTransport({ runtime: runtime(async () => [], port) });
    transport.onEvent((event) => events.push(event));
    await transport.open(exactCandidate('/dev/tty.write-error'));

    const writing = transport.write(Uint8Array.of(0x0d));
    port.completeWrite(new Error('native write rejected'));

    await expect(writing).rejects.toThrow('native write rejected');
    await expect(transport.write(Uint8Array.of(0x0d))).rejects.toThrow('Serial port is not open');
    expect(events.map((event) => event.type)).toEqual(['opened', 'error']);
    await transport.close();
  });

  it('rejects when the port closes between its native write and drain phases', async () => {
    const port = new FakeSerialPort({ open: 'immediate', close: 'immediate', write: 'manual' });
    const events: TransportEvent[] = [];
    const transport = new NodeSerialTransport({ runtime: runtime(async () => [], port) });
    transport.onEvent((event) => events.push(event));
    await transport.open(exactCandidate('/dev/tty.close-during-write'));

    const writing = transport.write(Uint8Array.of(0x0d));
    port.forceClose();
    port.completeWrite();

    await expect(writing).rejects.toThrow('Serial port closed while writing data');
    expect(port.drainCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual(['opened', 'closed']);
  });

  it('publishes only exact ZS407 endpoints while preserving partial enumeration failures', async () => {
    const transport = new NodeSerialTransport({
      runtime: runtime(async () => [
        { path: '/dev/tty.valid', vendorId: '0x483', productId: '5740', serialNumber: 'ZS407' },
        { path: '/dev/tty.unrelated', vendorId: '1234', productId: '5678' },
        { path: '/dev/tty.malformed', vendorId: 'not-hex', productId: '5740' },
      ]),
    });

    const result = await transport.list();

    expect(result.candidates).toEqual([expect.objectContaining({
      path: '/dev/tty.valid', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc',
    })]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain('malformed USB identifier');
  });

  it('rejects a caller-supplied unverified endpoint before creating a native port', async () => {
    let createCalls = 0;
    const transport = new NodeSerialTransport({
      runtime: {
        listPorts: async () => [],
        createPort: () => { createCalls += 1; return new FakeSerialPort({ open: 'immediate', close: 'immediate' }); },
      },
    });
    const unverified: PortCandidate = {
      id: 'unverified', path: '/dev/tty.unrelated', usbMatch: 'unverified-serial',
      transport: 'usb-cdc-acm', execution: 'physical',
    };

    await expect(transport.open(unverified)).rejects.toThrow('only exact physical TinySA ZS407');
    expect(createCalls).toBe(0);
  });
});

type CompletionMode = 'immediate' | 'manual';

class FakeSerialPort extends EventEmitter implements NodeSerialPortHandle {
  isOpen = false;
  closeCalls = 0;
  drainCalls = 0;
  readonly #openMode: CompletionMode;
  readonly #closeMode: CompletionMode;
  readonly #writeMode: CompletionMode;
  readonly #drainMode: CompletionMode;
  #openCallback?: (error?: Error | null) => void;
  #closeCallback?: (error?: Error | null) => void;
  #writeCallback?: (error?: Error | null) => void;
  #drainCallback?: (error?: Error | null) => void;

  constructor(modes: Readonly<{
    open: CompletionMode;
    close: CompletionMode;
    write?: CompletionMode;
    drain?: CompletionMode;
  }>) {
    super();
    this.#openMode = modes.open;
    this.#closeMode = modes.close;
    this.#writeMode = modes.write ?? 'immediate';
    this.#drainMode = modes.drain ?? 'immediate';
  }

  open(callback: (error?: Error | null) => void): void {
    if (this.#openMode === 'immediate') {
      this.isOpen = true;
      callback();
      return;
    }
    this.#openCallback = callback;
  }

  completeOpen(error?: Error): void {
    const callback = this.#openCallback;
    this.#openCallback = undefined;
    if (!callback) throw new Error('No pending fake open callback');
    if (!error) this.isOpen = true;
    callback(error);
  }

  close(callback: (error?: Error | null) => void): void {
    this.closeCalls += 1;
    if (this.#closeMode === 'immediate') {
      this.isOpen = false;
      callback();
      return;
    }
    this.#closeCallback = callback;
  }

  completeClose(error?: Error): void {
    const callback = this.#closeCallback;
    this.#closeCallback = undefined;
    if (!callback) throw new Error('No pending fake close callback');
    if (!error) this.isOpen = false;
    callback(error);
  }

  forceClose(): void {
    this.isOpen = false;
    this.emit('close');
  }

  write(_bytes: Uint8Array, callback: (error?: Error | null) => void): void {
    if (this.#writeMode === 'immediate') callback();
    else this.#writeCallback = callback;
  }
  completeWrite(error?: Error): void {
    const callback = this.#writeCallback;
    this.#writeCallback = undefined;
    if (!callback) throw new Error('No pending fake write callback');
    callback(error);
  }
  drain(callback: (error?: Error | null) => void): void {
    this.drainCalls += 1;
    if (this.#drainMode === 'immediate') callback();
    else this.#drainCallback = callback;
  }
  completeDrain(error?: Error): void {
    const callback = this.#drainCallback;
    this.#drainCallback = undefined;
    if (!callback) throw new Error('No pending fake drain callback');
    callback(error);
  }
}

function runtime(
  listPorts: () => Promise<readonly NodeSerialPortInfo[]>,
  ...ports: NodeSerialPortHandle[]
): NodeSerialTransportRuntime {
  return {
    listPorts,
    createPort: () => {
      const port = ports.shift();
      if (!port) throw new Error('No fake serial port remains');
      return port;
    },
  };
}

function exactCandidate(path: string): PortCandidate {
  return {
    id: path, path, vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc',
    transport: 'usb-cdc-acm', execution: 'physical',
  };
}
