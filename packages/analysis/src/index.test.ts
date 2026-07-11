import { describe, expect, it } from 'vitest';
import {
  SignalDetector,
  SignalTracker,
  SpectralMorphologyClassifier,
  TraceAccumulator,
  UnknownClassifier,
  autoScaleSpectrum,
  calculateSweepMetrics,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  measureChannel,
  measureOccupiedBandwidth,
  readMarkers,
  searchMarker,
} from './index.js';
import { FIRMWARE_SOURCE_COMMIT } from '@tinysa/contracts';
import type {
  AnalyzerConfig,
  DeviceIdentity,
  MarkerConfiguration,
  SignalDetectionConfig,
  Sweep,
  TraceBankConfiguration,
  TraceFrame,
  ZeroSpanCapture,
} from '@tinysa/contracts';

const identity: DeviceIdentity = {
  model: 'tinySA Ultra+ ZS407',
  hardwareVersion: 'V0.5.4 + ZS407',
  firmwareVersion: 'sim-c979386',
  firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT,
  port: {
    id: 'simulator:zs407',
    path: 'simulator://zs407',
    vendorId: '0483',
    productId: '5740',
    usbMatch: 'exact-zs407-cdc',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

const analyzer: AnalyzerConfig = {
  startHz: 100,
  stopHz: 2_000,
  points: 20,
  acquisitionFormat: 'text',
  rbwKhz: 'auto',
  attenuationDb: 'auto',
  sweepTimeSeconds: 'auto',
  detector: 'sample',
  spurRejection: 'auto',
  lna: 'off',
  avoidSpurs: 'auto',
  trigger: { mode: 'auto' },
};

const detectionConfig: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 1,
};

function makeSweep(overrides: Partial<Sweep> = {}): Sweep {
  const frequencyHz = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
  const powerDbm = Array.from({ length: 20 }, () => -90);
  powerDbm.splice(8, 3, -55, -48, -54);
  return {
    kind: 'spectrum',
    id: 'sweep-1',
    sequence: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    elapsedMilliseconds: 42,
    frequencyHz,
    powerDbm,
    requested: analyzer,
    actualStartHz: 100,
    actualStopHz: 2_000,
    actualRbwHz: 10_000,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity,
    ...overrides,
  };
}

describe('signal analysis', () => {
  it('detects contiguous bins above a robust adaptive floor', () => {
    const results = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(makeSweep());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      peakHz: 1_000,
      peakDbm: -48,
      bandwidthHz: 200,
      thresholdDbm: -80,
      noiseFloorDbm: -90,
      detectorId: 'robust-contiguous-v2',
      state: 'active',
    });
  });

  it('promotes persistent detections and explicitly releases missed tracks', () => {
    const detector = new SignalDetector(detectionConfig);
    const tracker = new SignalTracker(detectionConfig);
    const first = makeSweep();
    const second = makeSweep({ id: 'sweep-2', sequence: 2, capturedAt: '2026-01-01T00:00:01.000Z' });
    const empty = makeSweep({ id: 'sweep-3', sequence: 3, capturedAt: '2026-01-01T00:00:02.000Z', powerDbm: Array(20).fill(-90) });
    const final = makeSweep({ id: 'sweep-4', sequence: 4, capturedAt: '2026-01-01T00:00:03.000Z', powerDbm: Array(20).fill(-90) });

    expect(tracker.update(first, detector.analyze(first))[0]).toMatchObject({ state: 'candidate', persistenceSweeps: 1 });
    expect(tracker.update(second, detector.analyze(second))[0]).toMatchObject({ state: 'active', persistenceSweeps: 2 });
    expect(tracker.update(empty, detector.analyze(empty))[0]).toMatchObject({ state: 'active', missedSweeps: 1 });
    expect(tracker.update(final, detector.analyze(final))[0]).toMatchObject({ state: 'released', missedSweeps: 2 });
    expect(tracker.update(final, [])).toHaveLength(0);
  });

  it('reports deterministic spectrum metrics', () => {
    const metrics = calculateSweepMetrics(makeSweep());
    expect(metrics.peakHz).toBe(1_000);
    expect(metrics.peakDbm).toBe(-48);
    expect(metrics.noiseFloorDbm).toBe(-90);
    expect(metrics.occupiedBandwidth99Hz).toBeGreaterThanOrEqual(100);
    expect(metrics.crestFactorDb).toBeGreaterThan(0);
  });

  it('integrates channel, adjacent-channel, and configurable occupied-bandwidth evidence from a complete scalar sweep', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => {
      if (Math.abs(frequency - 200_000) <= 20_000) return -50;
      if (Math.abs(frequency - 130_000) <= 20_000) return -80;
      if (Math.abs(frequency - 270_000) <= 20_000) return -70;
      return -120;
    });
    const channelSweep = makeSweep({
      id: 'channel-1', frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 400_000, actualRbwHz: 1_000,
    });
    const result = measureChannel(channelSweep, {
      centerHz: 200_000,
      mainBandwidthHz: 40_000,
      adjacentBandwidthHz: 40_000,
      channelSpacingHz: 70_000,
      adjacentChannelCount: 1,
      occupiedPowerPercent: 99,
      obwNoiseCorrection: 'robust-floor',
    });
    expect(result.carrier.powerDbm).toBeCloseTo(-33.98, 1);
    expect(result.adjacent.find((entry) => entry.side === 'lower')?.relativeToCarrierDbc).toBeCloseTo(-30, 1);
    expect(result.adjacent.find((entry) => entry.side === 'upper')?.relativeToCarrierDbc).toBeCloseTo(-20, 1);
    expect(result.occupiedBandwidth.bandwidthHz).toBeGreaterThan(80_000);
    expect(result.occupiedBandwidth.bandwidthHz).toBeLessThan(100_000);
    expect(result).toMatchObject({ evidence: 'host-derived-scalar-sweep', qualification: 'engineering-estimate' });
    const ninetyPercent = measureOccupiedBandwidth(channelSweep, 90, 'robust-floor').bandwidthHz;
    expect(ninetyPercent).toBeGreaterThan(35_000);
    expect(ninetyPercent).toBeLessThan(43_000);
  });

  it('computes a detected-envelope STFT without claiming I/Q evidence', () => {
    const samplePeriodSeconds = 0.001;
    const powerDbm = Array.from({ length: 256 }, (_, index) => 10 * Math.log10(1 + 0.6 * Math.sin(2 * Math.PI * 62.5 * index * samplePeriodSeconds)));
    const capture: ZeroSpanCapture = {
      kind: 'zero-span', id: 'stft-1', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 256,
      frequencyHz: 433_920_000, samplePeriodSeconds, powerDbm,
      requested: { frequencyHz: 433_920_000, points: 256, rbwKhz: 100, attenuationDb: 'auto', sweepTimeSeconds: 0.256, trigger: { mode: 'auto' } },
      actualRbwHz: 100_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
    };
    const result = computeEnvelopeStft(capture, { windowSize: 64, hopSize: 32, window: 'hann', removeDc: true, dynamicRangeDb: 80 });
    expect(result.frames).toHaveLength(7);
    expect(result.peakModulationFrequencyHz).toBeCloseTo(62.5, 5);
    expect(result).toMatchObject({ evidence: 'zero-span-detected-envelope', qualification: 'not-iq' });
  });

  it('classifies spectral morphology while retaining explicit unknown behavior', async () => {
    const sweep = makeSweep();
    const detection = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep)[0]!;
    const classified = await new SpectralMorphologyClassifier().classify(detection, sweep);
    expect(classified.modelId).toBe('spectral-morphology-v1');
    expect(classified.candidates).toHaveLength(4);
    expect(classified.evidence.features).toMatchObject({ bins: 3, bandwidthHz: 200 });

    const unknown = await new UnknownClassifier().classify(detection);
    expect(unknown).toMatchObject({ label: 'unknown', confidence: 0, unknownReason: 'model-unavailable' });
  });

  it('classifies pulsed zero-span envelope evidence', () => {
    const powerDbm = Array.from({ length: 80 }, (_, index) => index % 20 < 4 ? -45 : -90);
    const capture: ZeroSpanCapture = {
      kind: 'zero-span',
      id: 'zero-1',
      sequence: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      elapsedMilliseconds: 100,
      frequencyHz: 433_920_000,
      samplePeriodSeconds: 0.00125,
      powerDbm,
      requested: {
        frequencyHz: 433_920_000,
        points: 80,
        rbwKhz: 100,
        attenuationDb: 'auto',
        sweepTimeSeconds: 0.1,
        trigger: { mode: 'auto' },
      },
      actualRbwHz: 100_000,
      actualAttenuationDb: 0,
      source: 'scan-text',
      complete: true,
      identity,
    };
    expect(classifyZeroSpanEnvelope(capture)).toMatchObject({ label: 'pulsed-envelope', modelId: 'zero-span-envelope-v1' });
  });

  it('maintains four explicit host traces with hold, linear-power average, view, blank, and reset semantics', () => {
    const configuration: TraceBankConfiguration = [
      { id: 1, mode: 'clear-write', averageCount: 4 },
      { id: 2, mode: 'max-hold', averageCount: 4 },
      { id: 3, mode: 'average', averageCount: 2 },
      { id: 4, mode: 'blank', averageCount: 4 },
    ];
    const accumulator = new TraceAccumulator(configuration);
    const first = makeSweep({ id: 'trace-1', powerDbm: Array(20).fill(-90) });
    const second = makeSweep({ id: 'trace-2', powerDbm: Array.from({ length: 20 }, (_, index) => index === 5 ? -40 : -100) });
    accumulator.update(first);
    const frames = accumulator.update(second);
    expect(frames.map((frame) => frame.traceId)).toEqual([1, 2, 3]);
    expect(frames.find((frame) => frame.traceId === 1)?.powerDbm[0]).toBe(-100);
    expect(frames.find((frame) => frame.traceId === 2)?.powerDbm[0]).toBe(-90);
    expect(frames.find((frame) => frame.traceId === 2)?.powerDbm[5]).toBe(-40);
    expect(frames.find((frame) => frame.traceId === 3)?.powerDbm[0]).toBeGreaterThan(-97.1);

    accumulator.configure(configuration.map((trace) => trace.id === 2 ? { ...trace, mode: 'view' as const } : trace));
    accumulator.update(makeSweep({ id: 'trace-3', powerDbm: Array(20).fill(-20) }));
    expect(accumulator.frames().find((frame) => frame.traceId === 2)?.powerDbm[5]).toBe(-40);
    expect(accumulator.frames().find((frame) => frame.traceId === 2)?.mode).toBe('view');
    accumulator.configure(configuration);
    accumulator.update(makeSweep({ id: 'trace-4', powerDbm: Array.from({ length: 20 }, (_, index) => index === 8 ? -30 : -110) }));
    expect(accumulator.frames().find((frame) => frame.traceId === 2)).toMatchObject({ mode: 'max-hold', sweepCount: 3 });
    expect(accumulator.frames().find((frame) => frame.traceId === 2)?.powerDbm[5]).toBe(-40);
    accumulator.reset(2);
    expect(accumulator.frames().some((frame) => frame.traceId === 2)).toBe(false);
  });

  it('reads normal, delta, noise-density, peak-tracking markers and performs bounded peak searches', () => {
    const sweep = makeSweep();
    const frame: TraceFrame = { traceId: 1, mode: 'clear-write', frequencyHz: sweep.frequencyHz, powerDbm: sweep.powerDbm, sweepCount: 1, sourceSweepId: sweep.id, evidence: 'host-derived' };
    const markers: readonly MarkerConfiguration[] = [
      { id: 1, enabled: true, traceId: 1, mode: 'normal', frequencyHz: 900, tracking: 'peak' },
      { id: 2, enabled: true, traceId: 1, mode: 'delta', frequencyHz: 1_100, tracking: 'fixed', referenceMarkerId: 1 },
      { id: 3, enabled: true, traceId: 1, mode: 'noise-density', frequencyHz: 100, tracking: 'fixed' },
    ];
    const readings = readMarkers(markers, [frame], 10_000);
    expect(readings[0]).toMatchObject({ markerId: 1, frequencyHz: 1_000, powerDbm: -48, evidence: 'host-derived' });
    expect(readings[1]).toMatchObject({ deltaFrequencyHz: 100, deltaPowerDb: -6 });
    expect(readings[2]?.noiseDensityDbmHz).toBe(-130);
    expect(searchMarker(frame, 500, 'peak', { minimumLevelDbm: -80, minimumExcursionDb: 3 })).toBe(1_000);
    expect(searchMarker(frame, 500, 'next-right', { minimumLevelDbm: -80, minimumExcursionDb: 3 })).toBe(1_000);
    expect(() => searchMarker(frame, 1_500, 'next-right', { minimumLevelDbm: -80, minimumExcursionDb: 3 })).toThrow(/No qualifying peak/i);
    expect(autoScaleSpectrum(sweep)).toMatchObject({ referenceLevelDbm: -40, divisions: 10 });
  });

  it('fails loudly when sweep vectors are missing, mismatched, or non-finite', () => {
    const detector = new SignalDetector();
    expect(() => detector.analyze(makeSweep({ frequencyHz: [], powerDbm: [] }))).toThrow(/no measurement points/i);
    expect(() => detector.analyze(makeSweep({ powerDbm: [-90] }))).toThrow(/different lengths/i);
    expect(() => detector.analyze(makeSweep({ powerDbm: [-90, -89, Number.NaN, ...Array(17).fill(-91)] }))).toThrow(/finite/i);
  });
});
