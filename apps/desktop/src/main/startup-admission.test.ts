import { describe, expect, it } from 'vitest';
import {
  DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  type PortCandidate,
} from '@tinysa/contracts';
import { selectStartupInstrument } from './startup-admission.js';

const exact = physical('exact', 'exact-zs407-cdc');
const unverified = physical('unverified', 'unverified-serial');
const twin: PortCandidate = {
  id: 'twin', path: 'renode://zs407', usbMatch: 'firmware-digital-twin', transport: 'renode-monitor-bridge', execution: 'firmware-digital-twin',
  digitalTwin: { contractVersion: 1, bridge: 'renode-monitor-v1', firmwareRelease: 'lab-v0.2.0-protocol', repositoryCommit: DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT, firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7', usbTransactionsModeled: false },
};

describe('startup instrument admission', () => {
  it('selects one exact physical ZS407 ahead of every other candidate', () => expect(selectStartupInstrument([unverified, twin, exact])).toEqual(exact));
  it('requires operator choice when multiple exact physical devices exist', () => expect(selectStartupInstrument([exact, physical('second', 'exact-zs407-cdc')])).toBeUndefined());
  it('selects the executable twin only when no exact physical device exists', () => expect(selectStartupInstrument([unverified, twin])).toEqual(twin));
  it('does not select an unverified serial device', () => expect(selectStartupInstrument([unverified])).toBeUndefined());
  it('fails loudly if discovery violates the single-twin invariant', () => expect(() => selectStartupInstrument([twin, { ...twin, id: 'twin-2' }])).toThrow(/2 executable twins/));
});

function physical(id: string, usbMatch: 'exact-zs407-cdc' | 'unverified-serial'): PortCandidate {
  return {
    id,
    path: `/dev/${id}`,
    ...(usbMatch === 'exact-zs407-cdc' ? { vendorId: TINYSA_USB_VENDOR_ID, productId: TINYSA_USB_PRODUCT_ID } : {}),
    usbMatch,
    transport: 'usb-cdc-acm',
    execution: 'physical',
  };
}
