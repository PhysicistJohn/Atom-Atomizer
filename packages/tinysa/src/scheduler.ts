import { appendBytes, extractFixedBinaryResponse, extractRawSweepResponse, extractTextResponse } from './parser.js';
import type { ByteTransport } from './transport.js';

type ResponseKind = 'text' | 'fixed-binary' | 'raw-sweep';
interface Pending {
  command: string;
  timeoutMs: number;
  kind: ResponseKind;
  payloadBytes?: number;
  points?: number;
  resolve(value: string | Uint8Array | readonly number[]): void;
  reject(reason: unknown): void;
}

export interface CommandSchedulerOptions {
  maximumBufferedBytes?: number;
  onFault?(error: Error): void;
}

export class CommandScheduler {
  #queue: Pending[] = [];
  #active?: Pending;
  #timer?: ReturnType<typeof setTimeout>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #failed?: Error;
  #unsubscribe: () => void;
  #maximumBufferedBytes: number;

  constructor(private readonly transport: ByteTransport, private readonly options: CommandSchedulerOptions = {}) {
    this.#maximumBufferedBytes = options.maximumBufferedBytes ?? 4 * 1024 * 1024;
    this.#unsubscribe = transport.onBytes((bytes) => this.#receive(bytes));
  }

  execute(command: string, timeoutMs = 5_000): Promise<string> {
    return this.#enqueue<string>({ command, timeoutMs, kind: 'text' });
  }

  executeBinary(command: string, payloadBytes: number, timeoutMs = 15_000): Promise<Uint8Array> {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) return Promise.reject(new RangeError('payloadBytes must be a non-negative safe integer'));
    return this.#enqueue<Uint8Array>({ command, timeoutMs, kind: 'fixed-binary', payloadBytes });
  }

  executeRawSweep(command: string, points: number, timeoutMs = 30_000): Promise<readonly number[]> {
    if (!Number.isInteger(points) || points < 1) return Promise.reject(new RangeError('points must be a positive integer'));
    return this.#enqueue<readonly number[]>({ command, timeoutMs, kind: 'raw-sweep', points });
  }

  cancelAll(reason: Error = new Error('Operations cancelled')): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active?.reject(reason);
    this.#active = undefined;
    for (const item of this.#queue.splice(0)) item.reject(reason);
    this.#buffer = new Uint8Array();
  }

  dispose(): void {
    this.cancelAll(new Error('Command scheduler disposed'));
    this.#unsubscribe();
  }

  get fault(): Error | undefined { return this.#failed; }

  #enqueue<T>(input: Omit<Pending, 'resolve' | 'reject'>): Promise<T> {
    try { validateCommand(input.command); }
    catch (error) { return Promise.reject(error); }
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return Promise.reject(new RangeError('timeoutMs must be positive'));
    if (this.#failed) return Promise.reject(this.#failed);
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        ...input,
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.#queue.push(pending);
      void this.#startNext();
    });
  }

  async #startNext(): Promise<void> {
    if (this.#active || this.#queue.length === 0 || this.#failed) return;
    const active = this.#queue.shift();
    if (!active) return;
    this.#active = active;
    this.#timer = setTimeout(() => {
      this.#fault(new Error(`Command timed out and the protocol session is no longer synchronized: ${active.command}`));
    }, active.timeoutMs);
    try {
      await this.transport.write(new TextEncoder().encode(`${active.command}\r`));
      this.#processActive();
    } catch (error) {
      this.#fault(asError(error, `Transport write failed for ${active.command}`));
    }
  }

  #receive(bytes: Uint8Array): void {
    if (this.#failed) return;
    try {
      this.#buffer = appendBytes(this.#buffer, bytes, this.#maximumBufferedBytes);
      this.#processActive();
    } catch (error) {
      this.#fault(asError(error, 'Protocol parser failed'));
    }
  }

  #processActive(): void {
    const active = this.#active;
    if (!active) {
      if (this.#buffer.length > 64 * 1024) this.#fault(new Error('Unsolicited device traffic exceeded 64 KiB before a command was active'));
      return;
    }
    const response = active.kind === 'text'
      ? extractTextResponse(this.#buffer, active.command)
      : active.kind === 'fixed-binary'
        ? extractFixedBinaryResponse(this.#buffer, active.command, required(active.payloadBytes, 'payloadBytes'))
        : extractRawSweepResponse(this.#buffer, active.command, required(active.points, 'points'));
    if (!response) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#buffer = this.#buffer.slice(response.consumedBytes);
    this.#active = undefined;
    active.resolve(response.value);
    void this.#startNext();
  }

  #fault(error: Error): void {
    if (this.#failed) return;
    this.#failed = error;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active?.reject(error);
    this.#active = undefined;
    for (const item of this.#queue.splice(0)) item.reject(error);
    this.#buffer = new Uint8Array();
    this.options.onFault?.(error);
  }
}

function validateCommand(command: string): void {
  const bytes = new TextEncoder().encode(command);
  if (!command || bytes.length > 47 || !/^[\x20-\x7e]+$/.test(command)) {
    throw new Error('Command must contain 1..47 printable ASCII characters on one line');
  }
}

function required(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`Scheduler ${name} is missing`);
  return value;
}

function asError(value: unknown, context: string): Error {
  return value instanceof Error ? new Error(`${context}: ${value.message}`, { cause: value }) : new Error(`${context}: ${String(value)}`);
}
