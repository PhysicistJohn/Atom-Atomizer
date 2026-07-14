import { describe, expect, it } from 'vitest';
import {
  SignalDetector,
  SIGNAL_LAB_EMSO_MODEL,
  SignalLabBayesianClassifier,
  SignalTracker,
  SpectralMorphologyClassifier,
  TraceAccumulator,
  UnknownClassifier,
  autoScaleSpectrum,
  calculateSweepMetrics,
  classificationRepresentatives,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  extractObservableFeatures,
  measureChannel,
  measureOccupiedBandwidth,
  readMarkers,
  searchMarker,
  signalLabWaveformHypotheses,
} from './index.js';
import { FIRMWARE_SOURCE_COMMIT } from '@tinysa/contracts';
import type {
  AnalyzerConfig,
  DeviceIdentity,
  DetectedSignal,
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
  firmwareQualification: 'protocol-test',
  port: {
    id: 'simulator:zs407',
    path: 'simulator://zs407',
    vendorId: '0483',
    productId: '5740',
    usbMatch: 'protocol-test-double',
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
  minimumProminenceDb: 6,
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
    actualRbwHz: 100,
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
      detectorId: 'bayesian-exponential-multiscale-cfar-v3',
      prominenceDb: 42,
      state: 'active',
    });
    expect(results[0]!.bayesianEvidence).toMatchObject({
      modelId: 'bayesian-exponential-multiscale-cfar-v3',
      priorSignalProbability: 0.01,
      noiseShape: 1,
      targetSweepFalseAlarmProbability: 0.001,
      qualification: 'ideal-exponential-not-physically-calibrated',
      looks: 1,
    });
    expect(results[0]!.bayesianEvidence.targetPosteriorPredictiveNullProbability).toBeLessThan(0.001);
    expect(results[0]!.bayesianEvidence.multiplicityAdjustedTests).toBeGreaterThan(1);
    expect(results[0]!.bayesianEvidence.posteriorSignalProbability).toBeGreaterThan(0.999);
    expect(results[0]!.bayesianEvidence.logBayesFactor).toBeGreaterThan(0);
  });

  it('freezes a classification window containing both emission support and the admitted Bayesian test region', () => {
    const sweep = makeSweep();
    const detection = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep)[0]!;

    expect(detection.classificationRegionStartHz).toBeLessThanOrEqual(detection.startHz);
    expect(detection.classificationRegionStartHz).toBeLessThanOrEqual(detection.bayesianEvidence.testedRegionStartHz);
    expect(detection.classificationRegionStopHz).toBeGreaterThanOrEqual(detection.stopHz);
    expect(detection.classificationRegionStopHz).toBeGreaterThanOrEqual(detection.bayesianEvidence.testedRegionStopHz);
    expect(detection.classificationRegionSweepIds).toEqual([sweep.id]);
  });

  it('does not call an interior emission censored when only its wider Bayesian test region reaches a boundary', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 10_000);
    const powerDbm = frequencyHz.map((_frequency, index) => index >= 1 && index <= 24 ? -40 : -110);
    const sweep = makeSweep({
      id: 'bayesian-boundary-region', frequencyHz, powerDbm,
      actualStartHz: frequencyHz[0]!, actualStopHz: frequencyHz.at(-1)!, actualRbwHz: 10_000,
    });
    const detection = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep)[0]!;

    expect(detection.startHz).toBeGreaterThan(sweep.actualStartHz);
    expect(detection.bayesianEvidence.testedRegionStartHz).toBe(sweep.actualStartHz);
    expect(detection.qualityFlags).not.toContain('touches-lower-boundary');
  });

  it('marks censoring when threshold-connected emission support reaches a sweep boundary', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 10_000);
    const powerDbm = frequencyHz.map((_frequency, index) => index <= 24 ? -40 : -110);
    const sweep = makeSweep({
      id: 'physically-censored-region', frequencyHz, powerDbm,
      actualStartHz: frequencyHz[0]!, actualStopHz: frequencyHz.at(-1)!, actualRbwHz: 10_000,
    });
    const detection = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep)[0]!;

    expect(detection.startHz).toBe(sweep.actualStartHz);
    expect(detection.qualityFlags).toContain('touches-lower-boundary');
  });

  it('retains a noise estimate when a wideband emission occupies most of the displayed span', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 100_000);
    const powerDbm = frequencyHz.map((_frequency, index) => index >= 9 && index <= 91 ? -62 + 0.4 * Math.sin(index) : -108 + 0.5 * Math.cos(index));
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 10_000_000 });
    const result = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startHz: 900_000, stopHz: 9_100_000, detectorId: 'bayesian-exponential-multiscale-cfar-v3' });
    expect(result[0]!.noiseFloorDbm).toBeLessThan(-105);
  });

  it('rejects threshold crossings without the configured local prominence', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 10_000);
    const powerDbm = frequencyHz.map((_frequency, index) => index < 25 ? -100 : index >= 40 && index % 5 === 0 ? -88 : -93);
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 1_000_000 });

    const result = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep);

    expect(result).toHaveLength(0);
  });

  it('rejects a weak threshold crossing when Bayesian evidence does not overcome the sparse-signal prior', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 10_000);
    const background = [-104, -101, -99, -102, -100, -98.5, -103];
    const powerDbm = frequencyHz.map((_frequency, index) => background[index % background.length]!);
    powerDbm[50] = -94;
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 1_000_000, actualRbwHz: 10_000 });
    const detector = new SignalDetector({
      ...detectionConfig,
      threshold: { strategy: 'absolute', levelDbm: -95 },
      minimumProminenceDb: 3,
      minimumConsecutiveSweeps: 1,
    });

    expect(detector.analyze(sweep)).toHaveLength(0);

    powerDbm[50] = -84;
    const strong = detector.analyze(makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 1_000_000, actualRbwHz: 10_000 }));
    expect(strong).toHaveLength(1);
    expect(strong[0]!.bayesianEvidence.posteriorSignalProbability).toBeGreaterThanOrEqual(0.99);
  });

  it('bridges two-bin ripple gaps into one prominent emission', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 10_000);
    const powerDbm = frequencyHz.map((_frequency, index) => index >= 30 && index <= 70 ? -70 : -105);
    powerDbm[45] = -105;
    powerDbm[46] = -105;
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 1_000_000 });

    const result = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startHz: 300_000, stopHz: 700_000, prominenceDb: 35 });
  });

  it('keeps regular components as local tracks while recording repeated simultaneous classification provenance', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const componentCentersHz = [200_000, 225_000, 250_000, 275_000, 300_000];
    const powerDbm = frequencyHz.map((frequency) => componentCentersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweeps = Array.from({ length: 8 }, (_, index) => makeSweep({
      id: `regular-components-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000,
    }));
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of sweeps) tracks = tracker.update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(5);
    expect(tracks.every((track) => track.bandwidthHz === 2_000)).toBe(true);
    expect(tracks.every((track) => track.associationMode === 'regular-spectral-component-activity')).toBe(true);
    expect(tracks.every((track) => track.associationRegionStartHz === 199_000 && track.associationRegionStopHz === 301_000)).toBe(true);
    expect(tracks.every((track) => track.associationRegionSweepIds?.length === 8)).toBe(true);
    expect(tracks.every((track) => track.associationMemberTrackIds?.length === 5)).toBe(true);
    const observation = extractObservableFeatures(tracks[0]!, { sweeps });
    expect(observation.sweepIds).toHaveLength(8);
    expect(observation.limitations).toContain('regular-spectral-component-activity-association');
  });

  it('updates regular-component association provenance atomically when membership changes', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeSweep({
      id: 'regular-membership-first',
      frequencyHz,
      powerDbm: powerFor([200_000, 225_000, 250_000, 275_000, 300_000]),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    });
    const initial = tracker.update(first, detector.analyze(first));
    const initialAssociation = new Map(initial.map((track) => [track.id, track.associationMemberTrackIds]));

    const second = makeSweep({
      id: 'regular-membership-second',
      sequence: 2,
      capturedAt: '2026-01-01T00:00:01.000Z',
      frequencyHz,
      powerDbm: powerFor([200_000, 225_000, 250_000, 275_000, 325_000]),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    });
    const updated = tracker.update(second, detector.analyze(second));
    const replacement = updated.find((track) => track.startHz === 324_000)!;

    expect(replacement.associationMode).toBe('frequency-local');
    expect(updated.every((track) => !track.associationRegionSweepIds?.includes(second.id))).toBe(true);
    for (const track of updated.filter((item) => initialAssociation.has(item.id))) {
      expect(track.associationMode).toBe('regular-spectral-component-activity');
      expect(track.associationRegionSweepIds).toEqual([first.id]);
      expect(track.associationMemberTrackIds).toEqual(initialAssociation.get(track.id));
    }
  });

  it('does not merge a two-tone observation into the regular multi-component association', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => [225_000, 275_000].some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });

    const result = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 }).analyze(sweep);

    expect(result).toHaveLength(2);
    expect(result.every((detection) => detection.bandwidthHz === 2_000)).toBe(true);
  });

  it('does not form a regular association from three unrelated independently detected carriers', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => [100_000, 210_000, 370_000].some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracks = new SignalTracker(config).update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(3);
    expect(tracks.every((track) => track.associationMode === 'frequency-local')).toBe(true);
  });

  it('records three symmetric regular components as a non-identifying morphology association', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const centersHz = [225_000, 250_000, 275_000];
    const powerDbm = frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweep = makeSweep({
      id: 'three-regular-components',
      frequencyHz,
      powerDbm,
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracks = new SignalTracker(config).update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(3);
    expect(tracks.every((track) => track.associationMode === 'regular-spectral-component-activity')).toBe(true);
    expect(tracks.every((track) => track.associationMemberTrackIds?.length === 3)).toBe(true);
    expect(tracks.every((track) => track.associationRegionStartHz === 224_000
      && track.associationRegionStopHz === 276_000)).toBe(true);
  });

  it('abstains when two maximal regular-component hypotheses overlap', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const centersHz = [100_000, 125_000, 150_000, 175_000, 210_000, 245_000, 280_000];
    const powerDbm = frequencyHz.map((frequency) => centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracks = new SignalTracker(config).update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(7);
    expect(tracks.every((track) => track.associationMode === 'frequency-local')).toBe(true);
  });

  it('keeps two disjoint regular-component associations separate', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const centersHz = [50_000, 75_000, 100_000, 125_000, 300_000, 325_000, 350_000, 375_000];
    const powerDbm = frequencyHz.map((frequency) => centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracks = new SignalTracker(config).update(sweep, detector.analyze(sweep));
    const associationIds = new Set(tracks.map((track) => track.associationId));

    expect(tracks).toHaveLength(8);
    expect(tracks.every((track) => track.associationMode === 'regular-spectral-component-activity')).toBe(true);
    expect(associationIds.size).toBe(2);
    for (const associationId of associationIds) {
      expect(tracks.filter((track) => track.associationId === associationId)).toHaveLength(4);
    }
  });

  it('does not refresh a multi-component association from later single-line sweeps', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const multiPower = frequencyHz.map((frequency) => [200_000, 225_000, 250_000, 275_000, 300_000].some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const singlePower = frequencyHz.map((frequency) => Math.abs(frequency - 250_000) <= 1_000 ? -42 : -110);
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeSweep({ id: 'multi-first', frequencyHz, powerDbm: multiPower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });
    let tracks = tracker.update(first, detector.analyze(first));
    const retainedId = tracks.find((track) => track.startHz === 249_000)!.id;
    for (let index = 2; index <= 3; index++) {
      const sweep = makeSweep({
        id: `single-${index}`, sequence: index,
        frequencyHz, powerDbm: singlePower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000,
      });
      tracks = tracker.update(sweep, detector.analyze(sweep));
    }
    const retained = tracks.find((track) => track.id === retainedId)!;

    expect(retained.associationMode).toBe('regular-spectral-component-activity');
    expect(retained.associationRegionSweepIds).toEqual([first.id]);
    expect(retained.associationMissedSweeps).toBe(2);
  });

  it('expires stale regular association provenance without releasing a surviving local track', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const multiPower = frequencyHz.map((frequency) => [200_000, 225_000, 250_000, 275_000, 300_000].some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const singlePower = frequencyHz.map((frequency) => Math.abs(frequency - 250_000) <= 1_000 ? -42 : -110);
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeSweep({ id: 'stale-multi-first', frequencyHz, powerDbm: multiPower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });
    let tracks = tracker.update(first, detector.analyze(first));
    const retainedId = tracks.find((track) => track.startHz === 249_000)!.id;
    for (let index = 2; index <= 4; index++) {
      const sweep = makeSweep({
        id: `stale-single-${index}`, sequence: index,
        frequencyHz, powerDbm: singlePower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000,
      });
      tracks = tracker.update(sweep, detector.analyze(sweep));
    }
    const retained = tracks.find((track) => track.id === retainedId)!;

    expect(retained.state).toBe('active');
    expect(retained.associationMode).toBe('frequency-local');
    expect(retained.associationRegionSweepIds).toBeUndefined();
    expect(retained.associationMemberTrackIds).toBeUndefined();
    expect(retained.associationMissedSweeps).toBeUndefined();
  });

  it('rejects malformed regular-component association provenance', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const centersHz = [200_000, 225_000, 250_000, 275_000, 300_000];
    const powerDbm = frequencyHz.map((frequency) => centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const sweep = makeSweep({ frequencyHz, powerDbm, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000 });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const associated = new SignalTracker(config).update(sweep, detector.analyze(sweep))[0]!;
    const malformed: DetectedSignal = { ...associated, associationModelId: 'unreviewed-grid-model' };

    expect(() => extractObservableFeatures(malformed, { sweeps: [sweep] }))
      .toThrow(/at least one coherent complete scalar sweep/i);
  });

  it('promotes persistent detections and explicitly releases missed tracks', () => {
    const detector = new SignalDetector(detectionConfig);
    const tracker = new SignalTracker(detectionConfig);
    const first = makeSweep();
    const second = makeSweep({ id: 'sweep-2', sequence: 2, capturedAt: '2026-01-01T00:00:01.000Z' });
    const empty = makeSweep({ id: 'sweep-3', sequence: 3, capturedAt: '2026-01-01T00:00:02.000Z', powerDbm: Array(20).fill(-90) });
    const final = makeSweep({ id: 'sweep-4', sequence: 4, capturedAt: '2026-01-01T00:00:03.000Z', powerDbm: Array(20).fill(-90) });

    expect(tracker.update(first, detector.analyze(first))[0]).toMatchObject({ state: 'candidate', persistenceSweeps: 1 });
    const admitted = tracker.update(second, detector.analyze(second))[0]!;
    expect(admitted).toMatchObject({ state: 'active', persistenceSweeps: 2 });
    const missed = tracker.update(empty, detector.analyze(empty))[0]!;
    expect(missed).toMatchObject({ state: 'active', missedSweeps: 1 });
    expect(missed.bayesianEvidence.posteriorScope).toBe('track-predictive-state');
    expect(missed.bayesianEvidence.posteriorSignalProbability)
      .toBeLessThan(admitted.bayesianEvidence.posteriorSignalProbability);
    expect(tracker.update(final, detector.analyze(final))[0]).toMatchObject({
      state: 'released', missedSweeps: 2,
      bayesianEvidence: { posteriorScope: 'track-predictive-state' },
    });
    expect(tracker.update(final, [])).toHaveLength(0);
  });

  it('requires an uninterrupted run of detections before promoting a candidate', () => {
    const config: SignalDetectionConfig = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 3,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const hit = (sequence: number) => makeSweep({
      id: `consecutive-hit-${sequence}`,
      sequence,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    });
    const miss = makeSweep({
      id: 'consecutive-miss-2',
      sequence: 2,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString(),
      powerDbm: Array(20).fill(-90),
    });

    expect(tracker.update(hit(1), detector.analyze(hit(1)))[0]).toMatchObject({ state: 'candidate', persistenceSweeps: 1 });
    expect(tracker.update(miss, detector.analyze(miss))[0]).toMatchObject({ state: 'candidate', missedSweeps: 1 });
    expect(tracker.update(hit(3), detector.analyze(hit(3)))[0]).toMatchObject({ state: 'candidate', persistenceSweeps: 2, missedSweeps: 0 });
    // Three cumulative detections are insufficient because the first was
    // separated from the latter two by a miss.
    expect(tracker.update(hit(4), detector.analyze(hit(4)))[0]).toMatchObject({ state: 'candidate', persistenceSweeps: 3 });
    expect(tracker.update(hit(5), detector.analyze(hit(5)))[0]).toMatchObject({ state: 'active', persistenceSweeps: 4 });
  });

  it('preserves the frozen classification region when a matched candidate moves', () => {
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const firstSweep = makeSweep();
    const firstCandidate = detector.analyze(firstSweep)[0]!;
    const firstTrack = tracker.update(firstSweep, [firstCandidate])[0]!;
    const secondSweep = makeSweep({ id: 'sweep-2', sequence: 2, capturedAt: '2026-01-01T00:00:01.000Z' });
    const shiftHz = 100;
    const movedCandidate: DetectedSignal = {
      ...firstCandidate,
      id: 'moved-candidate',
      startHz: firstCandidate.startHz + shiftHz,
      stopHz: firstCandidate.stopHz + shiftHz,
      peakHz: firstCandidate.peakHz + shiftHz,
      firstSeenAt: secondSweep.capturedAt,
      lastSeenAt: secondSweep.capturedAt,
      sweepIds: [secondSweep.id],
      classificationRegionStartHz: firstCandidate.classificationRegionStartHz! + shiftHz,
      classificationRegionStopHz: firstCandidate.classificationRegionStopHz! + shiftHz,
      classificationRegionSweepIds: [secondSweep.id],
      bayesianEvidence: {
        ...firstCandidate.bayesianEvidence,
        testedRegionStartHz: firstCandidate.bayesianEvidence.testedRegionStartHz + shiftHz,
        testedRegionStopHz: firstCandidate.bayesianEvidence.testedRegionStopHz + shiftHz,
      },
    };

    const updated = tracker.update(secondSweep, [movedCandidate])[0]!;

    expect(updated.id).toBe(firstTrack.id);
    expect(updated.peakHz).toBe(movedCandidate.peakHz);
    expect(updated.bayesianEvidence.testedRegionStartHz).toBe(movedCandidate.bayesianEvidence.testedRegionStartHz);
    expect(updated.bayesianEvidence.testedRegionStopHz).toBe(movedCandidate.bayesianEvidence.testedRegionStopHz);
    expect(updated.classificationRegionStartHz).toBe(firstTrack.classificationRegionStartHz);
    expect(updated.classificationRegionStopHz).toBe(firstTrack.classificationRegionStopHz);
    expect(updated.classificationRegionSweepIds).toEqual(firstTrack.classificationRegionSweepIds);
  });

  it('promotes only Bayesian multi-look 2.4 GHz activity without inflating local detector evidence', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const centersHz = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480].map((value) => value * 1_000_000);
    const sweeps = centersHz.map((centerHz, index) => agileSweep(index + 1, centerHz, 84_000_000));
    const localIds: string[] = [];
    let tracks: readonly DetectedSignal[] = [];
    for (const [index, sweep] of sweeps.entries()) {
      tracks = tracker.update(sweep, detector.analyze(sweep));
      const currentLocal = tracks.find((track) => track.associationMode === 'frequency-local' && track.missedSweeps === 0)!;
      localIds.push(currentLocal.id);
      if (index < 7) expect(tracks.some((track) => track.associationMode === 'frequency-agile-2g4-activity')).toBe(false);
    }
    const localTracks = tracks.filter((track) => track.associationMode === 'frequency-local');
    const activity = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!;

    expect(new Set(localIds).size).toBe(8);
    expect(localTracks.every((track) => track.persistenceSweeps === 1 && track.bayesianEvidence.looks === 1)).toBe(true);
    expect(localIds).not.toContain(activity.id);
    expect(activity.id).toMatch(/^agile-2g4-activity-\d{4}$/);
    expect(activity.associationId).toBe(activity.id);
    expect(activity).toMatchObject({
      associationMode: 'frequency-agile-2g4-activity',
      associationRegionStartHz: 2_402_000_000,
      associationRegionStopHz: 2_480_000_000,
      associationRegionSweepIds: sweeps.map((sweep) => sweep.id),
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationMemberTrackIds: localIds,
      associationMissedSweeps: 0,
      persistenceSweeps: 1,
    });
    expect(activity.associationObservations).toHaveLength(8);
    expect(activity.associationOpportunities).toEqual(sweeps.map((sweep) => ({ sweepId: sweep.id, outcome: 'exactly-one' })));
    expect(activity.associationBayesianEvidence).toMatchObject({
      modelId: 'bayesian-frequency-agile-transition-v2',
      positiveObservationCount: 8,
      transitionCount: 7,
      changedTransitionCount: 7,
      uniqueResolutionCellCount: 8,
      posteriorAgileDynamicsProbability: expect.any(Number),
    });
    expect(activity.associationBayesianEvidence!.posteriorAgileDynamicsProbability).toBeGreaterThanOrEqual(0.99);
    expect(activity.bayesianEvidence.looks).toBe(1);
    expect(activity.bayesianEvidence.posteriorScope).toBe('selected-local-region');
    const activeInputIds = tracks.filter((track) => track.state === 'active').map((track) => track.id);
    expect(classificationRepresentatives(tracks.filter((track) => track.state === 'active')).map((track) => track.id))
      .toEqual(activeInputIds);
    expect(extractObservableFeatures(activity, { sweeps })).toMatchObject({
      associationEvidenceQualification: 'provenance-bound-current-promotion',
      limitations: expect.arrayContaining(['frequency-agile-band-activity-association']),
    });
  });

  it('does not leak regular-component provenance into later agile activity', () => {
    const centersHz = [2_419_000_000, 2_419_500_000, 2_420_000_000, 2_420_500_000, 2_421_000_000];
    const first = emsoSweep(2_420_000_000, 10_000_000, 1, (frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 50_000) ? -45 : -110);
    const agile = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 2, value * 1_000_000, 84_000_000));
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = tracker.update(first, detector.analyze(first));
    const initialIds = new Set(initial.map((track) => track.id));

    expect(initial).toHaveLength(5);
    expect(initial.every((track) => track.associationMode === 'regular-spectral-component-activity')).toBe(true);
    let updated: readonly DetectedSignal[] = [];
    for (const [index, sweep] of agile.entries()) {
      updated = tracker.update(sweep, detector.analyze(sweep));
      if (index < 7) expect(updated.some((track) => track.associationMode === 'frequency-agile-2g4-activity')).toBe(false);
    }
    const activity = updated.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!;

    expect(activity).toBeDefined();
    expect(activity.associationRegionSweepIds).toEqual(agile.map((sweep) => sweep.id));
    expect(activity.associationObservations?.every((observation) => !initialIds.has(observation.trackId))).toBe(true);
    expect(activity.associationMemberTrackIds?.every((trackId) => !initialIds.has(trackId))).toBe(true);
    expect(updated.filter((track) => initialIds.has(track.id)).every((track) =>
      track.associationMode === 'regular-spectral-component-activity')).toBe(true);
  });

  it('uses repeated stationary looks as negative association evidence and demotes independently', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 1, value * 1_000_000, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of initial) tracks = tracker.update(sweep, detector.analyze(sweep));
    const activityId = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!.id;
    const initialPosterior = tracks.find((track) => track.id === activityId)!.associationBayesianEvidence!.posteriorAgileDynamicsProbability;
    let finalObservedPosterior = initialPosterior;
    for (let sequence = 9; sequence <= 68; sequence++) {
      const stationary = agileSweep(sequence, 2_440_000_000, 84_000_000);
      tracks = tracker.update(stationary, detector.analyze(stationary));
      const activity = tracks.find((track) => track.id === activityId);
      if (!activity) break;
      finalObservedPosterior = activity.associationBayesianEvidence!.posteriorAgileDynamicsProbability;
    }

    expect(finalObservedPosterior).toBeLessThan(initialPosterior);
    expect(tracks.some((track) => track.id === activityId)).toBe(false);
    const stationaryLocal = tracks.find((track) => track.associationMode === 'frequency-local' && track.missedSweeps === 0)!;
    expect(stationaryLocal.persistenceSweeps).toBeGreaterThan(1);
  });

  it('expires Bayesian agile activity only when positive evidence leaves its 96-look window', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 1, value * 1_000_000, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of initial) tracks = tracker.update(sweep, detector.analyze(sweep));
    const activityId = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!.id;
    for (let missed = 1; missed <= 88; missed++) {
      tracks = tracker.update(agileSweep(8 + missed, 2_440_000_000, 84_000_000), []);
    }
    expect(tracks.find((track) => track.id === activityId)).toMatchObject({
      associationMissedSweeps: 88,
      associationBayesianEvidence: { opportunityCount: 96, positiveObservationCount: 8 },
    });
    tracks = tracker.update(agileSweep(97, 2_440_000_000, 84_000_000), []);
    expect(tracks.some((track) => track.id === activityId)).toBe(false);
  });

  it('does not infer agile activity from two simultaneous unrelated emitters', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const unrelated = (sequence: number) => emsoSweep(2_441_000_000, 84_000_000, sequence, (frequency) =>
      [2_402_000_000, 2_470_000_000].some((center) => Math.abs(frequency - center) <= 300_000) ? -45 : -110);
    let tracks: readonly DetectedSignal[] = [];
    for (let sequence = 1; sequence <= 3; sequence++) {
      const sweep = unrelated(sequence);
      tracks = tracker.update(sweep, detector.analyze(sweep));
    }

    expect(tracks).toHaveLength(2);
    expect(tracks.every((track) => track.associationMode === 'frequency-local')).toBe(true);
    expect(tracks.every((track) => track.persistenceSweeps === 3)).toBe(true);
    expect(classificationRepresentatives(tracks)).toHaveLength(2);
  });

  it('censors an ambiguous wide look without fabricating another positive association observation', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 1, value * 1_000_000, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of initial) tracks = tracker.update(sweep, detector.analyze(sweep));
    const before = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!;
    const ambiguous = emsoSweep(2_441_000_000, 84_000_000, 9, (frequency) =>
      [2_410_000_000, 2_470_000_000].some((center) => Math.abs(frequency - center) <= 300_000) ? -45 : -110);
    tracks = tracker.update(ambiguous, detector.analyze(ambiguous));
    const after = tracks.find((track) => track.id === before.id)!;

    expect(after.associationRegionSweepIds).toEqual(before.associationRegionSweepIds);
    expect(after.associationOpportunities?.at(-1)).toEqual({ sweepId: ambiguous.id, outcome: 'ambiguous' });
    expect(after.associationBayesianEvidence).toMatchObject({ positiveObservationCount: 8, opportunityCount: 9 });
    expect(after.associationBayesianEvidence?.logBayesFactor).toBeCloseTo(before.associationBayesianEvidence!.logBayesFactor, 12);
    expect(after.associationMissedSweeps).toBe(1);
  });

  it('censors a single wideband component instead of attributing its full-band energy to agile activity', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 1, value * 1_000_000, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of initial) tracks = tracker.update(sweep, detector.analyze(sweep));
    const before = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!;
    const wideband = emsoSweep(2_441_000_000, 84_000_000, 9, (frequency) =>
      Math.abs(frequency - 2_441_000_000) <= 10_000_000 ? -45 : -110);
    const widebandCandidates = detector.analyze(wideband);

    expect(widebandCandidates).toHaveLength(1);
    expect(widebandCandidates[0]!.bandwidthHz).toBeGreaterThan(4_000_000);
    tracks = tracker.update(wideband, widebandCandidates);
    const after = tracks.find((track) => track.id === before.id)!;
    expect(after.associationOpportunities?.at(-1)).toEqual({ sweepId: wideband.id, outcome: 'ambiguous' });
    expect(after.associationBayesianEvidence).toMatchObject({ positiveObservationCount: 8, opportunityCount: 9 });
  });

  it('rejects reordered or duplicated provenance and resets an off-cadence agile window', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = agileSweep(1, 2_402_000_000, 84_000_000);
    tracker.update(first, detector.analyze(first));
    const delayed = { ...agileSweep(2, 2_410_000_000, 84_000_000), capturedAt: new Date(Date.parse(first.capturedAt) + 150).toISOString() };
    expect(() => tracker.update(delayed, detector.analyze(delayed))).not.toThrow();
    const duplicate = { ...delayed, id: `${delayed.id}-duplicate` };
    expect(() => tracker.update(duplicate, detector.analyze(duplicate))).toThrow(/ordered unique sweep provenance/i);

    const supportedTracker = new SignalTracker(config);
    const supported = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 1, value * 1_000_000, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of supported) tracks = supportedTracker.update(sweep, detector.analyze(sweep));
    const activity = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!;
    const reversed: DetectedSignal = {
      ...activity,
      associationRegionSweepIds: [...activity.associationRegionSweepIds!].reverse(),
      associationMemberTrackIds: [...activity.associationMemberTrackIds!].reverse(),
      associationObservations: [...activity.associationObservations!].reverse(),
      associationOpportunities: [...activity.associationOpportunities!].reverse(),
    };
    expect(() => extractObservableFeatures(reversed, { sweeps: supported })).toThrow(/coherent complete scalar sweep/i);
    expect(() => extractObservableFeatures(activity, { sweeps: [...supported, supported[0]!] })).toThrow(/duplicate evidence sweep IDs/i);
    expect(() => extractObservableFeatures(activity, { sweeps: supported.slice(1) })).toThrow(/coherent complete scalar sweep/i);

    const tamperedGeometry: DetectedSignal = { ...activity, associationGeometryId: `${activity.associationGeometryId}:tampered` };
    expect(() => extractObservableFeatures(tamperedGeometry, { sweeps: supported })).toThrow(/coherent complete scalar sweep/i);
  });

  it('does not open the agile model for unsupported sweep timing', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    let tracks: readonly DetectedSignal[] = [];
    for (let index = 0; index < 12; index++) {
      const base = agileSweep(index + 1, (2_402 + index * 6) * 1_000_000, 84_000_000);
      const unsupported: Sweep = {
        ...base,
        elapsedMilliseconds: 100,
        capturedAt: new Date(Date.UTC(2026, 0, 1) + (index + 1) * 100).toISOString(),
        requested: { ...base.requested, sweepTimeSeconds: 0.1 },
      };
      tracks = tracker.update(unsupported, detector.analyze(unsupported));
    }
    expect(tracks.some((track) => track.associationMode === 'frequency-agile-2g4-activity')).toBe(false);
  });

  it('does not merge separated 2.4 GHz emitters without a wide observation span', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = agileSweep(1, 2_402_000_000, 50_000_000);
    const second = agileSweep(2, 2_426_000_000, 50_000_000);
    tracker.update(first, detector.analyze(first));
    const tracks = tracker.update(second, detector.analyze(second));

    expect(tracks).toHaveLength(2);
    expect(tracks.every((track) => track.associationMode !== 'frequency-agile-2g4-activity')).toBe(true);
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

  it('keeps model provenance while rejecting a hand-built narrow line outside calibrated synthetic support', async () => {
    expect(signalLabWaveformHypotheses).toHaveLength(79);
    expect(new Set(signalLabWaveformHypotheses.map((item) => item.id)).size).toBe(79);
    expect(SIGNAL_LAB_EMSO_MODEL).toMatchObject({
      id: 'bayesian-observable-equivalence-v5', producer: 'tinysa-signal-lab', observableClassCount: 12,
      legacyProfileTaxonomySize: 79, preprocessing: 'scalar-observable-features-v5', priorId: 'engineering-design-class-weights-v1',
    });
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => {
      const offset = frequency - 98_000_000;
      return Math.max(-110 + 0.35 * Math.sin(frequency / 71_000 + index), -48 - 4.3429 * (offset / 3_000) ** 2);
    }));
    const detection = emsoDetection('cw-observed', 98_000_000, 20_000, sweeps);
    const result = await new SignalLabBayesianClassifier().classify(detection, { sweeps });
    expect(result).toMatchObject({
      label: 'unknown', decisionLevel: 'unknown', qualification: 'bayesian-observable-equivalence', scoreKind: 'model-posterior',
      modelId: 'bayesian-observable-equivalence-v5',
      unknownReason: 'out-of-domain', decisionSupport: { kind: 'synthetic-support-p-value' },
    });
    expect(result.decisionSupport!.threshold).toBeDefined();
    expect(result.decisionSupport!.value).toBeLessThan(result.decisionSupport!.threshold!);
    expect(result.candidates[0]).toMatchObject({ label: 'observable:cw-like' });
    expect(result.modelProvenance).toMatchObject({ producer: 'tinysa-signal-lab', sourceCommit: SIGNAL_LAB_EMSO_MODEL.sourceCommit });
    expect(result.candidates.some((candidate) => candidate.label === 'unknown')).toBe(true);
    expect(result.candidates).toHaveLength(12);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.confidence, 0)).toBeCloseTo(1, 12);
    expect(result.evidence.views).toEqual(['scalar-spectrum']);
    expect(result.evidence.limitations).toContain('zero-span-missing');
  });

  it('retains LTE/NR candidates while rejecting a hand-built OFDM trace outside calibrated synthetic support', async () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(1_840_000_000, 30_000_000, index + 1, (frequency) => {
      const offset = Math.abs(frequency - 1_840_000_000);
      return offset <= 9_000_000 ? -64 + 0.8 * Math.sin(frequency / 390_000 + index * 0.4) : -110 + 0.25 * Math.cos(frequency / 510_000);
    }));
    const detection = emsoDetection('cellular-observed', 1_840_000_000, 18_000_000, sweeps);
    const result = await new SignalLabBayesianClassifier().classify(detection, { sweeps });
    expect(result).toMatchObject({
      label: 'unknown', decisionLevel: 'unknown', unknownReason: 'out-of-domain',
      decisionSupport: { kind: 'synthetic-support-p-value' },
    });
    expect(result.decisionSupport!.threshold).toBeDefined();
    expect(result.decisionSupport!.value).toBeLessThan(result.decisionSupport!.threshold!);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.some((candidate) => candidate.label === 'observable:lte-fdd-like')).toBe(true);
    expect(result.candidates.some((candidate) => candidate.label === 'observable:nr-fdd-like')).toBe(true);

    const unknownSweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(433_920_000, 2_000_000, index + 1, (frequency) => Math.max(-108, -52 - Math.abs(frequency - 433_920_000) / 5_000)));
    const rejected = await new SignalLabBayesianClassifier().classify(emsoDetection('unknown-observed', 433_920_000, 25_000, unknownSweeps), { sweeps: unknownSweeps });
    expect(rejected).toMatchObject({ label: 'unknown', decisionLevel: 'unknown' });
  });

  it('requires repeated spectral evidence before making a SignalLab profile decision', async () => {
    const sweep = emsoSweep(98_000_000, 2_000_000, 1, (frequency) => Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 1_000));
    const classifier = new SignalLabBayesianClassifier();
    const detection = emsoDetection('one-look', 98_000_000, 20_000, [sweep]);
    const result = await classifier.classify(detection, { sweeps: [sweep] });
    expect(result).toMatchObject({ label: 'unknown', unknownReason: 'insufficient-evidence', decisionLevel: 'unknown' });
    expect(result.candidates.length).toBeGreaterThan(0);

    const unavailable = await classifier.classify(detection, { sweeps: [] });
    expect(unavailable).toMatchObject({ label: 'unknown', confidence: 0, scoreKind: 'none', unknownReason: 'insufficient-evidence' });
  });

  it('uses the exact latest eight admitted sweeps and rejects an uncalibrated detector configuration', async () => {
    const sweeps = Array.from({ length: 10 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => {
      return Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000);
    }));
    const detection = emsoDetection('exact-eight', 98_000_000, 20_000, sweeps);
    const classifier = new SignalLabBayesianClassifier();
    const result = await classifier.classify(detection, { sweeps });

    expect(result.evidence.sweepIds).toHaveLength(8);
    expect(result.evidence.sweepIds).not.toContain(sweeps[0]!.id);
    expect(result.evidence.sweepIds).not.toContain(sweeps[1]!.id);

    const outOfDomain = await classifier.classify({
      ...detection,
      detectorConfig: { ...detection.detectorConfig, releaseAfterMissedSweeps: 1 },
    }, { sweeps });
    expect(outOfDomain).toMatchObject({
      label: 'unknown', confidence: 0, scoreKind: 'none', unknownReason: 'out-of-domain',
      evidence: { limitations: ['detector-configuration-out-of-domain'] },
    });
  });

  it('rejects duplicated sweep objects as independent classifier admissions', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('duplicate-evidence', 98_000_000, 20_000, sweeps);
    expect(() => extractObservableFeatures(detection, { sweeps: [...sweeps, sweeps[0]!] }))
      .toThrow(/duplicate evidence sweep IDs/i);
  });

  it('uses only sweep IDs bound to the selected detection', () => {
    const boundSweeps = Array.from({ length: 3 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 10, (frequency) => {
      return Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000);
    }));
    const detection = emsoDetection('bound-history', 98_000_000, 20_000, boundSweeps);
    const baseline = extractObservableFeatures(detection, { sweeps: boundSweeps });
    const unrelated = emsoSweep(98_000_000, 2_000_000, 99, (frequency) => {
      return Math.max(-110, -20 - Math.abs(frequency - 98_000_000) / 50_000);
    });

    const withUnrelated = extractObservableFeatures(detection, { sweeps: [...boundSweeps, unrelated] });

    expect(withUnrelated.sweepIds).toEqual(baseline.sweepIds);
    expect(withUnrelated.sweepIds).not.toContain(unrelated.id);
    expect(withUnrelated.values).toEqual(baseline.values);
    expect(withUnrelated.centerHz).toBe(baseline.centerHz);
    expect(withUnrelated.bandwidthHz).toBe(baseline.bandwidthHz);
  });

  it('uses an explicit frozen region independently of the current detection peak and extent', () => {
    const centerHz = 98_000_000;
    const sweeps = Array.from({ length: 3 }, (_, index) => emsoSweep(centerHz, 2_000_000, index + 20, (frequency) => {
      const offset = frequency - centerHz;
      return Math.max(-110 + 0.2 * Math.sin(frequency / 31_000 + index), -52 - Math.abs(offset) / 4_000);
    }));
    const base = emsoDetection('frozen-region', centerHz, 80_000, sweeps);
    const frozenStartHz = centerHz - 60_000;
    const frozenStopHz = centerHz + 60_000;
    const frozen: DetectedSignal = {
      ...base,
      classificationRegionStartHz: frozenStartHz,
      classificationRegionStopHz: frozenStopHz,
      classificationRegionSweepIds: [sweeps[0]!.id],
    };
    const moved: DetectedSignal = {
      ...frozen,
      startHz: centerHz + 500_000,
      stopHz: centerHz + 700_000,
      peakHz: centerHz + 600_000,
      bandwidthHz: 200_000,
      bayesianEvidence: {
        ...frozen.bayesianEvidence,
        testedRegionStartHz: centerHz + 500_000,
        testedRegionStopHz: centerHz + 700_000,
      },
    };

    const baseline = extractObservableFeatures(frozen, { sweeps });
    const recentered = extractObservableFeatures(moved, { sweeps });

    expect(recentered.values).toEqual(baseline.values);
    expect(recentered.centerHz).toBe(baseline.centerHz);
    expect(recentered.bandwidthHz).toBe(baseline.bandwidthHz);
    expect(recentered.binWidthHz).toBe(baseline.binWidthHz);
    expect(recentered.sweepIds).toEqual(baseline.sweepIds);
  });

  it('rejects zero-span evidence bound to another detection or device provenance', () => {
    const sweeps = Array.from({ length: 3 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => {
      return Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000);
    }));
    const detection = emsoDetection('zero-span-owner', 98_000_000, 20_000, sweeps);
    const matchingCapture: ZeroSpanCapture = {
      kind: 'zero-span', id: 'bound-zero-span', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 10,
      frequencyHz: 98_000_000, samplePeriodSeconds: 0.0001,
      targetDetectionId: detection.id,
      powerDbm: Array.from({ length: 100 }, (_, index) => index % 10 < 4 ? -45 : -90),
      requested: { frequencyHz: 98_000_000, points: 100, rbwKhz: 20, attenuationDb: 'auto', sweepTimeSeconds: 0.01, trigger: { mode: 'auto' } },
      actualRbwHz: 20_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
      timingQualification: 'wall-clock-derived',
    };
    const mismatchedCaptures: readonly ZeroSpanCapture[] = [
      { ...matchingCapture, id: 'wrong-detection-zero-span', targetDetectionId: 'another-detection' },
      {
        ...matchingCapture,
        id: 'wrong-device-zero-span',
        identity: { ...identity, port: { ...identity.port, id: 'simulator:other-device' } },
      },
    ];

    for (const zeroSpan of mismatchedCaptures) {
      const observation = extractObservableFeatures(detection, { sweeps, zeroSpan });
      expect(observation.zeroSpanCaptureId).toBeUndefined();
      expect(observation.views).toEqual(['scalar-spectrum']);
      expect(observation.limitations).toContain('zero-span-provenance-mismatch');
      expect(observation.limitations).toContain('zero-span-missing');
      expect(observation.limitations).not.toContain('zero-span-tune-mismatch');
      expect(Object.keys(observation.values).some((key) => key.startsWith('envelope.'))).toBe(false);
    }
  });

  it('filters cited sweeps with mismatched frequency grids or analyzer configuration', () => {
    const coherent = Array.from({ length: 3 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 10, (frequency) => {
      return Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000);
    }));
    const baselineDetection = emsoDetection('coherent-grid', 98_000_000, 20_000, coherent);
    const baseline = extractObservableFeatures(baselineDetection, { sweeps: coherent });
    const gridMismatch: Sweep = {
      ...coherent[0]!,
      id: 'grid-mismatch',
      sequence: 2,
      frequencyHz: coherent[0]!.frequencyHz.map((frequency, index) => index === 200 ? frequency + 1 : frequency),
    };
    const configMismatch: Sweep = {
      ...coherent[1]!,
      id: 'config-mismatch',
      sequence: 1,
      requested: { ...coherent[1]!.requested, detector: 'average' },
    };
    const detection: DetectedSignal = {
      ...baselineDetection,
      sweepIds: [...baselineDetection.sweepIds, gridMismatch.id, configMismatch.id],
    };

    const observation = extractObservableFeatures(detection, { sweeps: [...coherent, gridMismatch, configMismatch] });

    expect(observation.sweepIds).toEqual(baseline.sweepIds);
    expect(observation.sweepIds).not.toContain(gridMismatch.id);
    expect(observation.sweepIds).not.toContain(configMismatch.id);
    expect(observation.values).toEqual(baseline.values);
  });

  it('marginalizes every cadence-rate feature when physical zero-span timing is unqualified', () => {
    const sweeps = Array.from({ length: 3 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('unqualified-time', 98_000_000, 20_000, sweeps);
    const powerDbm = Array.from({ length: 450 }, (_, index) => index % 10 < 4 ? -45 : -90);
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'unqualified-time-zs', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 50,
      frequencyHz: 98_000_000, samplePeriodSeconds: 1 / 9_000, powerDbm,
      targetDetectionId: detection.id,
      requested: { frequencyHz: 98_000_000, points: 450, rbwKhz: 20, attenuationDb: 'auto', sweepTimeSeconds: 0.05, trigger: { mode: 'auto' } },
      actualRbwHz: 20_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
      timingQualification: 'wall-clock-derived',
    };

    const observation = extractObservableFeatures(detection, { sweeps, zeroSpan });

    expect(observation.views).toContain('detected-power-envelope');
    expect(observation.limitations).toContain('zero-span-timing-unqualified');
    expect(observation.values).toHaveProperty('envelope.rangeDb');
    expect(observation.values).not.toHaveProperty('envelope.logTransitionRateHz');
    expect(Object.keys(observation.values).some((key) => key.startsWith('envelope.periodicEnergy'))).toBe(false);
  });

  it('rejects otherwise matching zero-span evidence outside the calibrated acquisition geometry', () => {
    const sweeps = Array.from({ length: 3 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('geometry-owner', 98_000_000, 20_000, sweeps);
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'unsupported-geometry', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 10,
      frequencyHz: detection.peakHz, samplePeriodSeconds: 0.0001, targetDetectionId: detection.id,
      powerDbm: Array.from({ length: 100 }, (_, index) => index % 10 < 4 ? -45 : -90),
      requested: { frequencyHz: detection.peakHz, points: 100, rbwKhz: 20, attenuationDb: 'auto', sweepTimeSeconds: 0.01, trigger: { mode: 'auto' } },
      actualRbwHz: 20_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
      timingQualification: 'simulation-exact',
    };

    const observation = extractObservableFeatures(detection, { sweeps, zeroSpan });

    expect(observation.zeroSpanCaptureId).toBeUndefined();
    expect(observation.limitations).toContain('zero-span-geometry-out-of-domain');
    expect(observation.limitations).toContain('zero-span-missing');
    expect(Object.keys(observation.values).some((key) => key.startsWith('envelope.'))).toBe(false);
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

  it('fails loudly when sweep vectors or acquisition geometry are invalid', () => {
    const detector = new SignalDetector();
    expect(() => detector.analyze(makeSweep({ complete: false as true }))).toThrow(/incomplete/i);
    expect(() => detector.analyze(makeSweep({ frequencyHz: [], powerDbm: [] }))).toThrow(/at least three measurement points/i);
    expect(() => detector.analyze(makeSweep({ powerDbm: [-90] }))).toThrow(/different lengths/i);
    expect(() => detector.analyze(makeSweep({ powerDbm: [-90, -89, Number.NaN, ...Array(17).fill(-91)] }))).toThrow(/finite/i);
    expect(() => detector.analyze(makeSweep({ actualRbwHz: 0 }))).toThrow(/positive measured RBW/i);
    expect(() => detector.analyze(makeSweep({ actualStartHz: 2_000, actualStopHz: 100 }))).toThrow(/frequency bounds/i);
    const repeatedFrequencyHz = [...makeSweep().frequencyHz];
    repeatedFrequencyHz[10] = repeatedFrequencyHz[9]!;
    expect(() => detector.analyze(makeSweep({ frequencyHz: repeatedFrequencyHz }))).toThrow(/strictly increasing/i);
    expect(() => detector.analyze(makeSweep({ actualStartHz: 500 }))).toThrow(/outside its actual bounds/i);
  });
});

function emsoSweep(centerHz: number, spanHz: number, sequence: number, power: (frequencyHz: number) => number): Sweep {
  const points = 401;
  const startHz = centerHz - spanHz / 2;
  const stopHz = centerHz + spanHz / 2;
  const frequencyHz = Array.from({ length: points }, (_, index) => startHz + spanHz * index / (points - 1));
  return makeSweep({
    id: `emso-${centerHz}-${sequence}`, sequence,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 50).toISOString(), elapsedMilliseconds: 50,
    frequencyHz, powerDbm: frequencyHz.map(power), actualStartHz: startHz, actualStopHz: stopHz,
    actualRbwHz: spanHz / (points - 1), requested: { ...analyzer, startHz, stopHz, points, sweepTimeSeconds: 0.05 },
  });
}

function agileSweep(sequence: number, activeFrequencyHz: number, spanHz: number): Sweep {
  const centerHz = spanHz >= 84_000_000 ? 2_441_000_000 : 2_426_000_000;
  return emsoSweep(centerHz, spanHz, sequence, (frequency) => Math.abs(frequency - activeFrequencyHz) <= 300_000 ? -45 : -110);
}

function emsoDetection(id: string, peakHz: number, bandwidthHz: number, sweeps: readonly Sweep[]): DetectedSignal {
  const latest = sweeps.at(-1)!;
  const peakIndex = latest.frequencyHz.reduce((best, frequency, index) => Math.abs(frequency - peakHz) < Math.abs(latest.frequencyHz[best]! - peakHz) ? index : best, 0);
  return {
    id, startHz: peakHz - bandwidthHz / 2, stopHz: peakHz + bandwidthHz / 2, peakHz,
    peakDbm: latest.powerDbm[peakIndex]!, prominenceDb: 30, prominenceThresholdDb: 6, bandwidthHz, thresholdDbm: -98, noiseFloorDbm: -110,
    firstSeenAt: sweeps[0]!.capturedAt, lastSeenAt: latest.capturedAt, sweepIds: sweeps.map((sweep) => sweep.id),
    persistenceSweeps: sweeps.length, missedSweeps: 0, state: 'active', detectorId: 'bayesian-exponential-multiscale-cfar-v3',
    detectorConfig: {
      threshold: { strategy: 'noise-relative', marginDb: 10 },
      minimumBandwidthHz: 0,
      minimumProminenceDb: 6,
      minimumConsecutiveSweeps: 2,
      releaseAfterMissedSweeps: 2,
    },
    bayesianEvidence: { modelId: 'fixture', posteriorScope: 'track-state', priorSignalProbability: 0.01, posteriorSignalProbability: 1, logBayesFactor: 100, effectiveIndependentBins: 1, effectiveReferenceCells: 8, noiseShape: 1, posteriorPredictiveNullProbability: 1e-9, targetPosteriorPredictiveNullProbability: 0.001, targetSweepFalseAlarmProbability: 0.001, multiplicityAdjustedTests: 1, testedRegionStartHz: peakHz - bandwidthHz / 2, testedRegionStopHz: peakHz + bandwidthHz / 2, qualification: 'ideal-exponential-not-physically-calibrated', noiseSigmaDb: 1.5, observedMeanShiftDb: 30, looks: sweeps.length },
    classificationRegionStartHz: peakHz - bandwidthHz / 2,
    classificationRegionStopHz: peakHz + bandwidthHz / 2,
    classificationRegionSweepIds: [sweeps[0]!.id],
    associationMode: 'frequency-local',
    qualityFlags: [],
  };
}
