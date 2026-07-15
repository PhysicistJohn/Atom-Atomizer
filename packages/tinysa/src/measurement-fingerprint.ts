import { createHash } from 'node:crypto';
import type { InstrumentMeasurement } from '@tinysa/contracts';

const DOMAIN = 'tinysa-instrument-measurement-fingerprint-v1\0';

/**
 * Fixed-size identity used only after a measurement has crossed the runtime
 * schema boundary. It lets main-process lifecycle code reconcile duplicate
 * event/return delivery without retaining another potentially 64 MiB I/Q
 * payload for every completed acquisition.
 */
export function fingerprintInstrumentMeasurement(measurement: InstrumentMeasurement): string {
  const hash = createHash('sha256');
  hash.update(DOMAIN, 'utf8');
  if (measurement.kind === 'complex-iq') {
    const { samples, ...metadata } = measurement;
    hash.update(JSON.stringify(metadata), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(samples);
  } else {
    hash.update(JSON.stringify(measurement), 'utf8');
  }
  return hash.digest('hex');
}
