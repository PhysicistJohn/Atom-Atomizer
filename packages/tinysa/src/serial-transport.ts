import { SerialPort } from 'serialport';
import type { PortCandidate } from '@tinysa/contracts';
import type { ByteTransport, TransportEvent } from './transport.js';

export class NodeSerialTransport implements ByteTransport {
  #port?: SerialPort; #bytes = new Set<(bytes: Uint8Array) => void>(); #events = new Set<(event: TransportEvent) => void>();
  async list(): Promise<PortCandidate[]> {
    return (await SerialPort.list()).map((p) => ({ id: [p.path, p.serialNumber, p.vendorId, p.productId].filter(Boolean).join(':'), path: p.path, ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}), ...(p.serialNumber ? { serialNumber: p.serialNumber } : {}), ...(p.vendorId ? { vendorId: p.vendorId } : {}), ...(p.productId ? { productId: p.productId } : {}) }));
  }
  async open(candidate: PortCandidate): Promise<void> {
    if (this.#port) throw new Error('Serial port is already open');
    const port = new SerialPort({ path: candidate.path, baudRate: 115_200, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    this.#port = port;
    port.on('data', (data: Buffer) => { const copy = Uint8Array.from(data); for (const listener of this.#bytes) listener(copy); });
    port.on('error', (error) => { for (const listener of this.#events) listener({ type: 'error', error }); });
    port.on('close', () => { this.#port = undefined; for (const listener of this.#events) listener({ type: 'closed' }); });
    for (const listener of this.#events) listener({ type: 'opened' });
  }
  async close(): Promise<void> {
    const port = this.#port; if (!port) return;
    await new Promise<void>((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
  }
  async write(bytes: Uint8Array): Promise<void> {
    const port = this.#port; if (!port?.isOpen) throw new Error('Serial port is not open');
    await new Promise<void>((resolve, reject) => port.write(bytes, (error) => error ? reject(error) : port.drain((drainError) => drainError ? reject(drainError) : resolve())));
  }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
}
