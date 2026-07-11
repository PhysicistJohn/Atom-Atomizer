import { describe, expect, it } from 'vitest';
import type { InstrumentTransportKind, PortCandidate } from '@tinysa/contracts';
import { PhysicalOrTwinTransport, RenodeDigitalTwinTransport } from './digital-twin-transport.js';
import type { ByteTransport, TransportAcquisitionMetadata, TransportEvent } from './transport.js';

describe('physical-first executable twin admission', () => {
  it('offers the declared Renode twin only when no exact ZS407 exists', async () => {
    const physical = new StubTransport([]);
    const twin = new RenodeDigitalTwinTransport('/firmware/repository/not-opened-in-this-test');
    const candidates = await new PhysicalOrTwinTransport(physical, twin).list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ execution: 'firmware-digital-twin', transport: 'renode-monitor-bridge', usbMatch: 'firmware-digital-twin' });
    expect(candidates[0]?.digitalTwin).toMatchObject({ usbTransactionsModeled: false });
  });

  it('suppresses the twin when exact physical USB identity is present', async () => {
    const exact = physicalCandidate('exact', 'exact-zs407-cdc');
    const transport = new PhysicalOrTwinTransport(new StubTransport([exact]), new RenodeDigitalTwinTransport('/unused'));
    expect(await transport.list()).toEqual([exact]);
  });

  it('does not turn a discovery failure into twin admission', async () => {
    const transport = new PhysicalOrTwinTransport(new StubTransport(new Error('USB discovery failed')), new RenodeDigitalTwinTransport('/unused'));
    await expect(transport.list()).rejects.toThrow('USB discovery failed');
  });
});

class StubTransport implements ByteTransport {
  readonly kind: InstrumentTransportKind = 'usb-cdc-acm';
  constructor(private readonly result: PortCandidate[] | Error) {}
  list(): Promise<PortCandidate[]> { return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result); }
  open(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  write(): Promise<void> { return Promise.resolve(); }
  onBytes(): () => void { return () => undefined; }
  onEvent(_listener: (event: TransportEvent) => void): () => void { return () => undefined; }
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined { return undefined; }
}

function physicalCandidate(id: string, usbMatch: 'exact-zs407-cdc' | 'unverified-serial'): PortCandidate {
  return { id, path: `/dev/${id}`, usbMatch, transport: 'usb-cdc-acm', execution: 'physical' };
}
