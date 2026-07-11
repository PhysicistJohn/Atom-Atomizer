import { cleanTextResponse, PromptParser } from './parser.js';
import type { ByteTransport } from './transport.js';

interface Pending { command: string; timeoutMs: number; resolve(value: string): void; reject(reason: unknown): void; }

export class CommandScheduler {
  #queue: Pending[] = [];
  #active?: Pending;
  #timer?: ReturnType<typeof setTimeout>;
  #parser = new PromptParser();
  #unsubscribe: () => void;

  constructor(private readonly transport: ByteTransport) {
    this.#unsubscribe = transport.onBytes((bytes) => this.#receive(bytes));
  }
  execute(command: string, timeoutMs = 5_000): Promise<string> {
    if (!command || /[\r\n]/.test(command)) return Promise.reject(new Error('Command must be one non-empty line'));
    return new Promise((resolve, reject) => { this.#queue.push({ command, timeoutMs, resolve, reject }); void this.#startNext(); });
  }
  cancelAll(reason = new Error('Operations cancelled')): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#active?.reject(reason); this.#active = undefined;
    for (const item of this.#queue.splice(0)) item.reject(reason);
    this.#parser.reset();
  }
  dispose(): void { this.cancelAll(); this.#unsubscribe(); }

  async #startNext(): Promise<void> {
    if (this.#active || this.#queue.length === 0) return;
    const next = this.#queue.shift();
    if (next) this.#active = next;
    const active = next;
    if (!active) return;
    this.#timer = setTimeout(() => {
      active.reject(new Error(`Command timed out: ${active.command}`)); this.#active = undefined; this.#parser.reset(); void this.#startNext();
    }, active.timeoutMs);
    try { await this.transport.write(new TextEncoder().encode(`${active.command}\r`)); }
    catch (error) { if (this.#timer) clearTimeout(this.#timer); active.reject(error); this.#active = undefined; void this.#startNext(); }
  }
  #receive(bytes: Uint8Array): void {
    const frames = this.#parser.push(bytes);
    for (const frame of frames) {
      const active = this.#active;
      if (!active) continue;
      if (this.#timer) clearTimeout(this.#timer);
      this.#active = undefined;
      active.resolve(cleanTextResponse(frame, active.command));
      void this.#startNext();
    }
  }
}
