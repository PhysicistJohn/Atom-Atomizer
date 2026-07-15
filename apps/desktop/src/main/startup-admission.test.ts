import { describe, expect, it } from 'vitest';
import {
  type InstrumentCandidate,
  type InstrumentDiscoveryResult,
} from '@tinysa/contracts';
import {
  PreferredInstrumentAdmissionError,
  selectPreferredInstrument,
} from './startup-admission.js';

describe('preferred driver admission', () => {
  const signalLab = driverCandidate('signal-lab', 'signal-lab', 'signal-lab:default');
  const tinySa = driverCandidate('tinysa-zs407', 'serial-port', '/dev/tty.usbmodem407');

  it('selects only the configured SignalLab driver', () => {
    expect(selectPreferredInstrument(driverDiscovery([signalLab, tinySa]), preference('signal-lab'))).toEqual(signalLab);
  });

  it('does not fall back when the preferred driver is unavailable', () => {
    expect(() => selectPreferredInstrument(driverDiscovery([tinySa]), preference('signal-lab')))
      .toThrow(PreferredInstrumentAdmissionError);
  });

  it('surfaces the preferred driver discovery failure', () => {
    expect(() => selectPreferredInstrument({
      ...driverDiscovery([tinySa]),
      failures: [{ driverId: 'signal-lab', code: 'source-unavailable', recoverable: true, message: 'bridge executable unavailable' }],
    }, preference('signal-lab'))).toThrow(/bridge executable unavailable/);
  });

  it('admits an explicitly preferred usable source when another source owned by the same driver failed', () => {
    const twin = driverCandidate('tinysa-zs407', 'tinysa-firmware-twin', 'twin:one');
    const discovery = {
      ...driverDiscovery([twin]),
      failures: [{
        driverId: 'tinysa-zs407' as const,
        sourceKind: 'serial-port' as const,
        code: 'source-unavailable' as const,
        recoverable: true,
        message: 'USB enumeration unavailable',
      }],
    };
    expect(selectPreferredInstrument(discovery, {
      ...preference('tinysa-zs407'), candidateKind: 'tinysa-firmware-twin',
    })).toEqual(twin);
    expect(() => selectPreferredInstrument(discovery, preference('tinysa-zs407')))
      .toThrow(/failed discovery/);
  });

  it('requires explicit choice when a driver preference is ambiguous', () => {
    expect(() => selectPreferredInstrument(
      driverDiscovery([signalLab, driverCandidate('signal-lab', 'signal-lab', 'signal-lab:second')]),
      preference('signal-lab'),
    )).toThrow(/matched 2 candidates/);
  });

  it('honors the optional source-kind discriminator', () => {
    expect(selectPreferredInstrument(driverDiscovery([signalLab, tinySa]), {
      ...preference('tinysa-zs407'),
      candidateKind: 'serial-port',
    })).toEqual(tinySa);
  });
});

function driverCandidate(driverId: string, sourceKind: string, candidateId: string): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId,
    candidateId,
    displayName: candidateId,
    sourceKind,
    discoveryRevision: 'discovery:1',
  } as InstrumentCandidate;
}

function driverDiscovery(candidates: readonly InstrumentCandidate[]): InstrumentDiscoveryResult {
  return {
    discoveryRevision: 'discovery:1',
    discoveredAt: '2026-07-14T12:00:00.000Z',
    candidates,
    failures: [],
  };
}

function preference(driverId: string) {
  return { schemaVersion: 1 as const, driverId, updatedAt: '2026-07-14T12:00:00.000Z' };
}
