import { SerialPort } from 'serialport';
import { TINYSA_USB_PRODUCT_ID, TINYSA_USB_VENDOR_ID, portCandidateSchema, type PortCandidate } from '@tinysa/contracts';
import type { ByteTransport, TransportEvent } from './transport.js';

export class NodeSerialTransport implements ByteTransport {
  #port?: SerialPort; #bytes = new Set<(bytes: Uint8Array) => void>(); #events = new Set<(event: TransportEvent) => void>();
  async list(): Promise<PortCandidate[]> {
    const candidates = (await SerialPort.list()).map((port) => {
      const vendorId = normalizeUsbId(port.vendorId);
      const productId = normalizeUsbId(port.productId);
      const exact = vendorId === TINYSA_USB_VENDOR_ID && productId === TINYSA_USB_PRODUCT_ID;
      return portCandidateSchema.parse({
        id: [port.path, port.serialNumber, vendorId, productId].filter(Boolean).join(':'),
        path: port.path,
        ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
        ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
        ...(vendorId ? { vendorId } : {}),
        ...(productId ? { productId } : {}),
        usbMatch: exact ? 'exact-zs407-cdc' : 'unverified-serial',
      });
    });
    return candidates.sort((left, right) => Number(right.usbMatch === 'exact-zs407-cdc') - Number(left.usbMatch === 'exact-zs407-cdc') || left.path.localeCompare(right.path));
  }
  async open(candidate: PortCandidate): Promise<void> {
    if (this.#port) throw new Error('Serial port is already open');
    const validated = portCandidateSchema.parse(candidate);
    const port = new SerialPort({ path: validated.path, baudRate: 115_200, autoOpen: false, lock: true });
    this.#port = port;
    port.on('data', (data: Buffer) => { const copy = Uint8Array.from(data); for (const listener of this.#bytes) listener(copy); });
    port.on('error', (error) => { for (const listener of this.#events) listener({ type: 'error', error }); });
    port.on('close', () => { this.#port = undefined; for (const listener of this.#events) listener({ type: 'closed' }); });
    try {
      await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    } catch (error) {
      this.#port = undefined;
      port.removeAllListeners();
      throw error;
    }
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

function normalizeUsbId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^0x/i, '').padStart(4, '0').toLowerCase();
  if (!/^[a-f0-9]{4}$/.test(normalized)) throw new Error(`Serial transport returned malformed USB identifier: ${value}`);
  return normalized;
}
