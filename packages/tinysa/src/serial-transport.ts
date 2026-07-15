import { SerialPort } from 'serialport';
import { TINYSA_USB_PRODUCT_ID, TINYSA_USB_VENDOR_ID, portCandidateSchema, type PortCandidate } from '@tinysa/contracts';
import type { ByteTransport, TransportDiscoveryResult, TransportEvent } from './transport.js';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
const MAX_OPERATION_TIMEOUT_MS = 60_000;

export interface NodeSerialPortInfo {
  readonly path: string;
  readonly manufacturer?: string;
  readonly serialNumber?: string;
  readonly vendorId?: string;
  readonly productId?: string;
}

/** The deliberately small serial-port surface owned by this transport. */
export interface NodeSerialPortHandle {
  readonly isOpen: boolean;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  removeListener(event: 'data', listener: (data: Buffer) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'close', listener: () => void): this;
  open(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  write(bytes: Uint8Array, callback: (error?: Error | null) => void): void;
  drain(callback: (error?: Error | null) => void): void;
}

/** Injectable at the native-module boundary so timeout and race behavior can be tested deterministically. */
export interface NodeSerialTransportRuntime {
  listPorts(): Promise<readonly NodeSerialPortInfo[]>;
  createPort(options: Readonly<{ path: string; baudRate: number; autoOpen: false; lock: true }>): NodeSerialPortHandle;
}

export interface NodeSerialTransportOptions {
  readonly discoveryTimeoutMs?: number;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly runtime?: NodeSerialTransportRuntime;
}

interface PortListeners {
  readonly data: (data: Buffer) => void;
  readonly error: (error: Error) => void;
  readonly close: () => void;
}

const NODE_SERIAL_RUNTIME: NodeSerialTransportRuntime = {
  listPorts: () => SerialPort.list(),
  createPort: (options) => new SerialPort(options),
};

export class NodeSerialTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly #runtime: NodeSerialTransportRuntime;
  readonly #discoveryTimeoutMs: number;
  readonly #openTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #writeTimeoutMs: number;
  readonly #bytes = new Set<(bytes: Uint8Array) => void>();
  readonly #events = new Set<(event: TransportEvent) => void>();
  readonly #orphanCloseStarted = new WeakSet<NodeSerialPortHandle>();
  readonly #orphanCleanup = new WeakMap<NodeSerialPortHandle, () => void>();
  #port?: NodeSerialPortHandle;
  #portListeners?: PortListeners;
  #portState?: 'opening' | 'open' | 'faulted' | 'closing';

  constructor(options: NodeSerialTransportOptions = {}) {
    this.#runtime = options.runtime ?? NODE_SERIAL_RUNTIME;
    this.#discoveryTimeoutMs = operationTimeout(options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS, 'Serial discovery timeout');
    this.#openTimeoutMs = operationTimeout(options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS, 'Serial open timeout');
    this.#closeTimeoutMs = operationTimeout(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS, 'Serial close timeout');
    this.#writeTimeoutMs = operationTimeout(options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS, 'Serial write timeout');
  }

  async list(): Promise<TransportDiscoveryResult> {
    let ports: readonly NodeSerialPortInfo[];
    try {
      ports = await promiseWithin(
        Promise.resolve().then(() => this.#runtime.listPorts()),
        this.#discoveryTimeoutMs,
        `Serial port enumeration timed out after ${this.#discoveryTimeoutMs} ms`,
      );
    } catch (value) {
      return { candidates: [], failures: [enumerationFailure(this.kind, value)] };
    }
    const candidates: PortCandidate[] = [];
    const failures: TransportDiscoveryResult['failures'][number][] = [];
    for (const port of ports) {
      try {
        const vendorId = normalizeUsbId(port.vendorId);
        const productId = normalizeUsbId(port.productId);
        const exact = vendorId === TINYSA_USB_VENDOR_ID && productId === TINYSA_USB_PRODUCT_ID;
        if (!exact) continue;
        candidates.push(portCandidateSchema.parse({
          id: [port.path, port.serialNumber, vendorId, productId].filter(Boolean).join(':'),
          path: port.path,
          ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
          ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
          ...(vendorId ? { vendorId } : {}),
          ...(productId ? { productId } : {}),
          usbMatch: 'exact-zs407-cdc',
          transport: 'usb-cdc-acm',
          execution: 'physical',
        }));
      } catch (value) {
        failures.push(enumerationFailure(this.kind, new Error(`Serial endpoint ${port.path || '<unknown>'} was rejected: ${discoveryMessage(value)}`)));
      }
    }
    candidates.sort((left, right) => left.path.localeCompare(right.path));
    return { candidates, failures };
  }

  async open(candidate: PortCandidate): Promise<void> {
    if (this.#port) throw new Error('Serial port is already open');
    const validated = portCandidateSchema.parse(candidate);
    if (validated.execution !== 'physical' || validated.transport !== this.kind || validated.usbMatch !== 'exact-zs407-cdc') {
      throw new Error('Serial transport opens only exact physical TinySA ZS407 0483:5740 endpoints');
    }
    const port = this.#runtime.createPort({ path: validated.path, baudRate: 115_200, autoOpen: false, lock: true });
    const listeners: PortListeners = {
      data: (data) => {
        if (this.#port !== port) return;
        this.#emitBytes(Uint8Array.from(data));
      },
      error: (error) => {
        if (this.#port !== port) return;
        this.#emitEvent({ type: 'error', error });
      },
      close: () => this.#finalizeClosedPort(port, listeners),
    };
    this.#port = port;
    this.#portListeners = listeners;
    this.#portState = 'opening';
    this.#attachPortListeners(port, listeners);
    try {
      await callbackWithin(
        (callback) => port.open(callback),
        this.#openTimeoutMs,
        `Opening serial port ${validated.path} timed out after ${this.#openTimeoutMs} ms`,
        () => this.#abandonOpeningPort(port, listeners),
        (error) => {
          if (!error) this.#requestOrphanClose(port);
        },
      );
      if (this.#port !== port) throw new Error(`Serial port ${validated.path} closed while opening`);
      this.#portState = 'open';
    } catch (error) {
      this.#abandonOpeningPort(port, listeners);
      throw error;
    }
    this.#emitEvent({ type: 'opened' });
  }

  async close(): Promise<void> {
    const port = this.#port;
    const listeners = this.#portListeners;
    if (!port || !listeners) return;
    this.#portState = 'closing';
    await callbackWithin(
      (callback) => port.close(callback),
      this.#closeTimeoutMs,
      `Closing serial port timed out after ${this.#closeTimeoutMs} ms`,
      undefined,
      (error) => {
        if (error) {
          if (this.#port === port) this.#emitEvent({ type: 'error', error });
          return;
        }
        this.#finalizeClosedPort(port, listeners);
      },
    );
    this.#finalizeClosedPort(port, listeners);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const port = this.#port;
    if (!port?.isOpen || this.#portState !== 'open') throw new Error('Serial port is not open');
    const deadline = Date.now() + this.#writeTimeoutMs;
    try {
      await callbackWithin(
        (callback) => port.write(bytes, callback),
        remainingBefore(deadline, `Writing serial data timed out after ${this.#writeTimeoutMs} ms`),
        `Writing serial data timed out after ${this.#writeTimeoutMs} ms`,
      );
      if (this.#port !== port || this.#portState !== 'open' || !port.isOpen) {
        throw new Error('Serial port closed while writing data');
      }
      await callbackWithin(
        (callback) => port.drain(callback),
        remainingBefore(deadline, `Draining serial data exceeded the ${this.#writeTimeoutMs} ms serial write deadline`),
        `Draining serial data exceeded the ${this.#writeTimeoutMs} ms serial write deadline`,
      );
      if (this.#port !== port || this.#portState !== 'open' || !port.isOpen) {
        throw new Error('Serial port closed while draining data');
      }
    } catch (value) {
      if (this.#port === port && this.#portState === 'open') {
        this.#portState = 'faulted';
        const error = value instanceof Error ? value : new Error(String(value));
        this.#emitEvent({ type: 'error', error });
      }
      throw value;
    }
  }

  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  consumeAcquisitionMetadata(): undefined { return undefined; }

  #attachPortListeners(port: NodeSerialPortHandle, listeners: PortListeners): void {
    port.on('data', listeners.data);
    port.on('error', listeners.error);
    port.on('close', listeners.close);
  }

  #detachPortListeners(port: NodeSerialPortHandle, listeners: PortListeners): void {
    port.removeListener('data', listeners.data);
    port.removeListener('error', listeners.error);
    port.removeListener('close', listeners.close);
  }

  #abandonOpeningPort(port: NodeSerialPortHandle, listeners: PortListeners): void {
    if (this.#port === port) {
      this.#port = undefined;
      this.#portListeners = undefined;
      this.#portState = undefined;
    }
    this.#detachPortListeners(port, listeners);
    this.#guardOrphanPort(port);
    if (port.isOpen) this.#requestOrphanClose(port);
  }

  #guardOrphanPort(port: NodeSerialPortHandle): void {
    if (this.#orphanCleanup.has(port)) return;
    const ignoreError = () => undefined;
    const cleanup = () => {
      port.removeListener('error', ignoreError);
      port.removeListener('close', cleanup);
      this.#orphanCleanup.delete(port);
    };
    this.#orphanCleanup.set(port, cleanup);
    port.on('error', ignoreError);
    port.on('close', cleanup);
  }

  #requestOrphanClose(port: NodeSerialPortHandle): void {
    this.#guardOrphanPort(port);
    if (this.#orphanCloseStarted.has(port)) return;
    this.#orphanCloseStarted.add(port);
    try {
      port.close((error) => {
        if (!error) this.#orphanCleanup.get(port)?.();
      });
    } catch {
      // The obsolete handle remains guarded against a later native error event.
    }
  }

  #finalizeClosedPort(port: NodeSerialPortHandle, listeners: PortListeners): void {
    if (this.#port !== port) return;
    this.#port = undefined;
    this.#portListeners = undefined;
    this.#portState = undefined;
    this.#detachPortListeners(port, listeners);
    this.#emitEvent({ type: 'closed' });
  }

  #emitBytes(bytes: Uint8Array): void {
    for (const listener of [...this.#bytes]) {
      try { listener(Uint8Array.from(bytes)); }
      catch { /* Transport byte observers cannot corrupt native-port lifecycle. */ }
    }
  }

  #emitEvent(event: TransportEvent): void {
    for (const listener of [...this.#events]) {
      try { listener(structuredClone(event)); }
      catch { /* Transport event observers cannot corrupt native-port lifecycle. */ }
    }
  }
}

function enumerationFailure(transport: 'usb-cdc-acm', value: unknown): TransportDiscoveryResult['failures'][number] {
  return {
    sourceKind: 'serial-port',
    transport,
    code: 'enumeration-failed',
    message: discoveryMessage(value),
    recoverable: true,
  };
}

function discoveryMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4_096) || 'Serial port enumeration failed';
}

function normalizeUsbId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^0x/i, '').padStart(4, '0').toLowerCase();
  if (!/^[a-f0-9]{4}$/.test(normalized)) throw new Error(`Serial transport returned malformed USB identifier: ${value}`);
  return normalized;
}

function operationTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OPERATION_TIMEOUT_MS) {
    throw new RangeError(`${label} must be an integer from 1 to ${MAX_OPERATION_TIMEOUT_MS} ms`);
  }
  return value;
}

function remainingBefore(deadline: number, message: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SerialOperationTimeoutError(message);
  return remaining;
}

function promiseWithin<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SerialOperationTimeoutError(message));
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function callbackWithin(
  begin: (callback: (error?: Error | null) => void) => void,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
  onLateResult?: (error?: Error | null) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let state: 'pending' | 'settled' | 'timed-out' = 'pending';
    const timer = setTimeout(() => {
      if (state !== 'pending') return;
      state = 'timed-out';
      onTimeout?.();
      reject(new SerialOperationTimeoutError(message));
    }, timeoutMs);
    const callback = (error?: Error | null) => {
      if (state === 'timed-out') {
        onLateResult?.(error);
        return;
      }
      if (state !== 'pending') return;
      state = 'settled';
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    try {
      begin(callback);
    } catch (error) {
      if (state !== 'pending') return;
      state = 'settled';
      clearTimeout(timer);
      reject(error);
    }
  });
}

class SerialOperationTimeoutError extends Error {
  override readonly name = 'SerialOperationTimeoutError';
}
