import { describe, expect, it } from 'vitest';
import type { MarkerConfiguration, Sweep, TraceBankConfiguration } from '@tinysa/contracts';
import { SignalDetector, TraceAccumulator, readMarkers, searchMarker } from './index.js';

const sweep = {
  kind: 'spectrum', id: 'neptune-relative', sequence: 1, capturedAt: '2026-07-31T12:00:00.000Z', elapsedMilliseconds: 4,
  frequencyHz: [0, 25, 50, 75, 100], powerDbm: [-100, -90, -40, -90, -100],
  powerReference: 'uncalibrated-dbfs-relative',
  requested: {
    kind: 'swept-spectrum', startHz: 0, stopHz: 100, points: 5, sweepTimeSeconds: 0.004,
    controls: { schemaVersion: 1, model: 'host-derived-iq-projection', fftSize: 5, window: 'hann-periodic' },
  },
  actualStartHz: 0, actualStopHz: 100, actualRbwHz: 25, actualAttenuationDb: null,
  resolutionBandwidthQualification: 'host-derived-fft-bin', attenuationQualification: 'not-applicable',
  source: 'host-derived-from-complex-iq', complete: true,
  identity: {
    kind: 'instrument-session', sessionId: 'session-neptune', driverId: 'neptune-p210', candidateId: 'neptune-p210:ip:10.0.0.250',
    provenance: { sourceKind: 'neptune-p210', execution: 'physical', transport: 'libiio-network', qualification: 'device-observed', verifiedAt: '2026-07-31T12:00:00.000Z', endpoint: 'ip:10.0.0.250' },
  },
} satisfies Sweep;

describe('uncalibrated sweep power-reference invariants', () => {
  it('retains the reference through trace accumulation and marker readings', () => {
    const configuration: TraceBankConfiguration = [
      { id: 1, mode: 'clear-write', averageCount: 4 },
      { id: 2, mode: 'blank', averageCount: 4 },
      { id: 3, mode: 'blank', averageCount: 4 },
      { id: 4, mode: 'blank', averageCount: 4 },
    ];
    const accumulator = new TraceAccumulator(configuration);
    const frame = accumulator.update(sweep)[0]!;
    expect(frame.powerReference).toBe('uncalibrated-dbfs-relative');

    const markers: readonly MarkerConfiguration[] = [{ id: 1, enabled: true, traceId: 1, mode: 'normal', frequencyHz: 50, tracking: 'fixed' }];
    expect(readMarkers(markers, [frame])[0]).toMatchObject({
      powerDbm: -40,
      powerReference: 'uncalibrated-dbfs-relative',
    });
  });

  it('rejects absolute-dBm detection and thresholded directional search while preserving relative searches', () => {
    const absolute = new SignalDetector({
      threshold: { strategy: 'absolute', levelDbm: -80 },
      minimumBandwidthHz: 0, minimumProminenceDb: 6, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 1,
    });
    expect(() => absolute.analyze(sweep)).toThrow(/Absolute dBm detection is unavailable/i);

    const frame = {
      traceId: 1 as const, mode: 'clear-write' as const, frequencyHz: sweep.frequencyHz, powerDbm: sweep.powerDbm,
      powerReference: sweep.powerReference, actualRbwHz: sweep.actualRbwHz,
      resolutionBandwidthQualification: sweep.resolutionBandwidthQualification,
      sweepCount: 1, sourceSweepId: sweep.id, evidence: 'host-derived' as const,
    };
    const search = { minimumLevelDbm: -80, minimumExcursionDb: 3 };
    expect(searchMarker(frame, 0, 'peak', search)).toBe(50);
    expect(searchMarker(frame, 0, 'minimum', search)).toBe(0);
    expect(() => searchMarker(frame, 0, 'next-right', search)).toThrow(/absolute dBm minimum level/i);
  });

  it('does not calculate a delta between calibrated and uncalibrated trace references', () => {
    const relativeFrame = {
      traceId: 1 as const, mode: 'clear-write' as const, frequencyHz: sweep.frequencyHz, powerDbm: sweep.powerDbm,
      powerReference: sweep.powerReference, actualRbwHz: sweep.actualRbwHz, sweepCount: 1,
      sourceSweepId: sweep.id, evidence: 'host-derived' as const,
    };
    const calibratedFrame = { ...relativeFrame, traceId: 2 as const, powerReference: undefined };
    const markers: readonly MarkerConfiguration[] = [
      { id: 1, enabled: true, traceId: 1, mode: 'delta', frequencyHz: 50, tracking: 'fixed', referenceMarkerId: 2 },
      { id: 2, enabled: true, traceId: 2, mode: 'normal', frequencyHz: 50, tracking: 'fixed' },
    ];
    expect(readMarkers(markers, [relativeFrame, calibratedFrame]).map((reading) => reading.markerId)).toEqual([2]);
  });
});
