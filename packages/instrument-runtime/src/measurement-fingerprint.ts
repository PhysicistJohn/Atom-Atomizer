import type { InstrumentMeasurement } from '@tinysa/contracts';
import { Sha256 } from './sha256.js';

const DOMAIN = 'tinysa-instrument-measurement-fingerprint-v1\0';

/**
 * Fixed-size identity used only after a measurement has crossed the runtime
 * schema boundary. It lets main-process lifecycle code reconcile duplicate
 * event/return delivery without retaining another potentially 64 MiB I/Q
 * payload for every completed acquisition.
 */
export function fingerprintInstrumentMeasurement(measurement: InstrumentMeasurement): string {
  const hash = new Sha256();
  hash.update(DOMAIN);
  if (measurement.kind === 'complex-iq') {
    const { samples, ...metadata } = measurement;
    hash.update(JSON.stringify(metadata));
    hash.update('\0');
    hash.update(samples);
  } else {
    hash.update(JSON.stringify(measurement));
  }
  return hash.digestHex();
}
