import type { PortCandidate } from '@tinysa/contracts';

type ByteListener = (bytes: Uint8Array) => void;
type EventListener = (event: { type: 'opened' } | { type: 'closed'; reason?: string } | { type: 'error'; error: Error }) => void;
export interface FakeOptions { chunkSize?: number; latencyMs?: number; }

export class FakeTinySaTransport {
  readonly port: PortCandidate = { id: 'fake-zs407', path: 'fake://zs407', manufacturer: 'tinySA simulator', serialNumber: 'SIM-407' };
  readonly writes: string[] = [];
  #bytes = new Set<ByteListener>(); #events = new Set<EventListener>(); #open = false;
  constructor(private readonly options: FakeOptions = {}) {}
  async list(): Promise<PortCandidate[]> { return [this.port]; }
  async open(candidate: PortCandidate): Promise<void> { if (candidate.id !== this.port.id) throw new Error('Unknown fake port'); this.#open = true; this.#emitEvent({ type: 'opened' }); }
  async close(): Promise<void> { if (!this.#open) return; this.#open = false; this.#emitEvent({ type: 'closed' }); }
  onBytes(listener: ByteListener): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: EventListener): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  async write(bytes: Uint8Array): Promise<void> {
    if (!this.#open) throw new Error('Fake port is closed');
    const command = new TextDecoder().decode(bytes).replace(/[\r\n]+$/, ''); this.writes.push(command);
    const response = `${command}\r\n${this.#response(command)}\r\nch>`;
    const encoded = new TextEncoder().encode(response); const chunkSize = this.options.chunkSize ?? encoded.length;
    if (this.options.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    for (let i = 0; i < encoded.length; i += chunkSize) for (const listener of this.#bytes) listener(encoded.slice(i, i + chunkSize));
  }
  unplug(): void { this.#open = false; this.#emitEvent({ type: 'closed', reason: 'unplugged' }); }
  #emitEvent(event: Parameters<EventListener>[0]): void { for (const listener of this.#events) listener(event); }
  #response(command: string): string {
    if (command === 'version') return 'tinySA4_v1.5-simulator';
    if (command === 'info') return 'tinySA ULTRA+ ZS407\r\nHW Version: V0.5.3';
    if (command === 'help') return 'version info help status sweep scan rbw attenuate mode freq level output capture touch release';
    if (command.startsWith('scan ')) {
      const [, startText, stopText, pointsText] = command.split(/\s+/); const start = Number(startText); const stop = Number(stopText); const points = Number(pointsText);
      return Array.from({ length: points }, (_, i) => `${Math.round(start + (stop - start) * i / (points - 1))} ${(-90 + 30 * Math.exp(-Math.pow((i - points / 2) / 8, 2))).toFixed(3)}`).join('\r\n');
    }
    return 'ok';
  }
}
