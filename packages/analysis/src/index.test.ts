import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  SignalDetector,
  SignalTracker,
  SpectralMorphologyClassifier,
  TraceAccumulator,
  UnknownClassifier,
  autoScaleSpectrum,
  calculateSweepMetrics,
  CLASSIFICATION_CAPTURE_TARGET_SELECTION_POLICY_ID,
  classificationCaptureTargetProjections,
  classificationCaptureTargetRepresentatives,
  classificationRepresentativeKey,
  classificationRepresentatives,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  createDetectedPowerCaptureReceipt,
  currentVisiblePhysicalClassificationRows,
  DETECTED_POWER_AUTOMATIC_SELECTION_CONDITION,
  extractObservableFeatures,
  measureChannel,
  measureOccupiedBandwidth,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
  readMarkers,
  searchMarker,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
} from './index.js';
import {
  SIGNAL_LAB_EMSO_MODEL,
  SignalLabBayesianClassifier,
} from '../../../../Atom-Classifier/src/signal-lab-classifier.js';
import {
  inferPosterior,
  knownModelSupportRank,
  selectObservableDecision,
} from '../../../../Atom-Classifier/src/bayesian-waveform-classifier.js';
import {
  assertDetectedPowerCaptureReceiptMatches,
  canonicalDetectedPowerCapturePayload,
} from './detected-power-capture-receipt.js';
import { FIRMWARE_SOURCE_COMMIT } from '@tinysa/contracts';
import type {
  AnalyzerConfig,
  DeviceIdentity,
  DetectedSignal,
  InstrumentMeasurementIdentity,
  MarkerConfiguration,
  SignalDetectionConfig,
  SweptSpectrumConfiguration,
  DetectedPowerTimeseriesConfiguration,
  Sweep,
  TraceBankConfiguration,
  TraceFrame,
  ZeroSpanCapture,
} from '@tinysa/contracts';
import {
  MULTICOMPONENT_SWEPT_REGION_MODEL_ID,
  multicomponentSweptRegionLineagesAreCompatible,
} from './multicomponent-swept-region.js';
import {
  REGULAR_SPECTRAL_COMPONENT_MODEL_ID,
  regularSpectralComponentLineageId,
  regularSpectralComponentLineagesAreCompatible,
  regularSpectralComponentAssociations,
} from './regular-spectral-component.js';
import { frequencyAgileSequentialOpportunity } from './frequency-agile-geometry.js';
import { synthesizeCanonicalObservation } from '../../../../Atom-SignalLab/src/classification-corpus.js';

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

const signalLabIdentity: InstrumentMeasurementIdentity = {
  kind: 'instrument-session',
  driverId: 'signal-lab',
  candidateId: 'signal-lab:local',
  sessionId: 'signal-lab-session',
  provenance: {
    sourceKind: 'signal-lab',
    sourceId: 'signal-lab-source',
    execution: 'signal-lab-simulation',
    transport: 'signal-lab-measurement-bridge',
    qualification: 'synthetic-visual-projection',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    producerConfigurationEpoch: 'producer-epoch:1',
    contractId: 'tinysa-signal-lab-atomizer-measurement',
    contractVersion: 1,
    contractSha256: 'a'.repeat(64),
    catalogSha256: 'b'.repeat(64),
    generatorSha256: 'c'.repeat(64),
    claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
  },
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

function admittedSpectrum(config: AnalyzerConfig): SweptSpectrumConfiguration {
  return {
    kind: 'swept-spectrum', startHz: config.startHz, stopHz: config.stopHz, points: config.points,
    sweepTimeSeconds: config.sweepTimeSeconds,
    controls: {
      schemaVersion: 1, model: 'receiver', acquisitionFormat: config.acquisitionFormat,
      resolutionBandwidthKhz: config.rbwKhz, attenuationDb: config.attenuationDb,
      detector: config.detector, spurRejection: config.spurRejection,
      lowNoiseAmplifier: config.lna, avoidSpurs: config.avoidSpurs, trigger: config.trigger,
    },
  };
}

function admittedDetectedPower(
  centerHz: number,
  sampleCount: number,
  sweepTimeSeconds: number,
  resolutionBandwidthKhz: number | 'auto',
): DetectedPowerTimeseriesConfiguration {
  return {
    kind: 'detected-power-timeseries', centerHz, sampleCount, sweepTimeSeconds,
    controls: { schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz, attenuationDb: 'auto', trigger: { mode: 'auto' } },
  };
}

function admittedSyntheticDetectedPower(
  centerHz: number,
  sampleCount: number,
  sweepTimeSeconds: number,
): DetectedPowerTimeseriesConfiguration {
  return {
    kind: 'detected-power-timeseries', centerHz, sampleCount, sweepTimeSeconds,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

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
    requested: admittedSpectrum(analyzer),
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

function makeSeparatedSignalSweep(sequence: number): Sweep {
  const points = 101;
  const startHz = 100;
  const stopHz = 10_100;
  const frequencyHz = Array.from({ length: points }, (_, index) => startHz + index * 100);
  const powerDbm = frequencyHz.map((_frequency, index) =>
    (index >= 20 && index <= 22) || (index >= 70 && index <= 72) ? -45 : -110);
  return makeSweep({
    id: `separated-signals-${sequence}`,
    sequence,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 50).toISOString(),
    frequencyHz,
    powerDbm,
    requested: admittedSpectrum({ ...analyzer, startHz, stopHz, points }),
    actualStartHz: startHz,
    actualStopHz: stopHz,
    actualRbwHz: 100,
  });
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

  it('shares one immutable compact detector sweep across every candidate in the same look', () => {
    const sweep = makeSeparatedSignalSweep(1);
    const candidates = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 })
      .analyze(sweep);

    expect(candidates).toHaveLength(2);
    const sourceSweeps = candidates.map((candidate) =>
      candidate.classificationRegionObservation!.sourceSweep);
    expect(sourceSweeps[0]).toBe(sourceSweeps[1]);
    expect(sourceSweeps[0]).not.toBe(sweep);
    expect(Object.isFrozen(candidates[0]!.classificationRegionObservation)).toBe(true);
    expect(Object.isFrozen(sourceSweeps[0])).toBe(true);
    expect(Object.isFrozen(sourceSweeps[0]!.frequencyHz)).toBe(true);
    expect(Object.isFrozen(sourceSweeps[0]!.powerDbm)).toBe(true);
    const retainedPower = sourceSweeps[0]!.powerDbm[20];
    (sweep.powerDbm as number[])[20] = -1;
    expect(sourceSweeps[0]!.powerDbm[20]).toBe(retainedPower);
    expect(Reflect.set(sourceSweeps[0]!.powerDbm, '20', -1)).toBe(false);
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
    expect(tracks.every((track) =>
      track.associationModelId === REGULAR_SPECTRAL_COMPONENT_MODEL_ID)).toBe(true);
    expect(tracks.every((track) => track.associationRegionStartHz === 199_000 && track.associationRegionStopHz === 301_000)).toBe(true);
    expect(tracks.every((track) => track.associationRegionSweepIds?.length === 8)).toBe(true);
    expect(tracks.every((track) => track.associationMemberTrackIds?.length === 5)).toBe(true);
    const observation = extractObservableFeatures(tracks[0]!, { sweeps });
    expect(observation.sweepIds).toHaveLength(8);
    expect(observation.limitations).toContain('regular-spectral-component-activity-association');
    expect(() => extractObservableFeatures({
      ...tracks[0]!,
      lastSeenAt: sweeps[0]!.capturedAt,
    }, { sweeps })).toThrow(/coherent complete scalar sweep/);
  });

  it('retains eight exact regular-line looks across outer-member track replacement', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const centerSets = [
      [175_000, 200_000, 225_000, 250_000, 275_000, 300_000, 325_000],
      [200_000, 225_000, 250_000, 275_000, 300_000, 325_000],
      [200_000, 225_000, 250_000, 275_000, 300_000, 325_000],
      [200_000, 225_000, 250_000, 275_000, 300_000, 325_000],
      [175_000, 200_000, 225_000, 250_000, 275_000, 300_000, 325_000],
      [175_000, 200_000, 225_000, 250_000, 275_000, 300_000],
      [175_000, 200_000, 225_000, 250_000, 275_000, 300_000],
      [175_000, 200_000, 225_000, 250_000, 275_000, 300_000, 325_000],
    ] as const;
    const sweeps = centerSets.map((centersHz, index) => makeSweep({
      id: `regular-churn-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, index + 1)).toISOString(),
      frequencyHz,
      powerDbm: powerFor(centersHz),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    }));
    const config = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    let tracks: readonly DetectedSignal[] = [];
    let initialLeftTrackId: string | undefined;
    for (const [index, sweep] of sweeps.entries()) {
      tracks = tracker.update(sweep, detector.analyze(sweep));
      if (index === 0) {
        initialLeftTrackId = tracks.find((track) => track.startHz === 174_000)!.id;
      }
    }
    const current = tracks.filter((track) => track.missedSweeps === 0);
    const representative = classificationRepresentatives(current)[0]!;
    const latestMembers = representative.regularComponentAssociationObservations?.at(-1)?.members
      .map((member) => member.trackId);

    expect(current).toHaveLength(7);
    expect(representative.associationId).toBe(regularSpectralComponentLineageId(1));
    expect(representative.associationModelId).toBe(REGULAR_SPECTRAL_COMPONENT_MODEL_ID);
    expect(representative.associationRegionSweepIds).toEqual(sweeps.map((sweep) => sweep.id));
    expect(representative.regularComponentAssociationObservations).toHaveLength(8);
    expect(representative.associationMemberTrackIds).toEqual(latestMembers);
    expect(latestMembers).not.toContain(initialLeftTrackId);
    expect(latestMembers).toContain(current.find((track) => track.startHz === 174_000)!.id);
    const observation = extractObservableFeatures(representative, { sweeps });
    expect(observation.sweepIds).toEqual(sweeps.map((sweep) => sweep.id).reverse());
    expect(observation.values['spectrum.sidebandScore']).toBeGreaterThanOrEqual(0.2);

    const tampered: DetectedSignal = {
      ...representative,
      regularComponentAssociationObservations:
        representative.regularComponentAssociationObservations?.map((item, index) =>
          index === 2 ? { ...item, spacingHz: item.spacingHz * 1.1 } : item),
    };
    expect(() => extractObservableFeatures(tampered, { sweeps }))
      .toThrow(/coherent complete scalar sweep/i);
  });

  it('retains a regular lineage across two morphology-missed looks within hysteresis', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const centerSets = [
      [200_000, 225_000, 250_000, 275_000, 300_000],
      [200_000, 300_000],
      [200_000, 300_000],
      [200_000, 225_000, 250_000, 275_000, 300_000],
    ] as const;
    const sweeps = centerSets.map((centersHz, index) => makeSweep({
      id: `regular-hysteresis-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 2, index + 1)).toISOString(),
      frequencyHz,
      powerDbm: powerFor(centersHz),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    }));
    const config = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = tracker.update(sweeps[0]!, detector.analyze(sweeps[0]!));
    const associationId = initial[0]!.associationId;

    const firstMiss = tracker.update(sweeps[1]!, detector.analyze(sweeps[1]!));
    expect(firstMiss.filter((track) => track.missedSweeps === 0)
      .every((track) => track.associationMissedSweeps === 1)).toBe(true);
    const secondMiss = tracker.update(sweeps[2]!, detector.analyze(sweeps[2]!));
    expect(secondMiss.filter((track) => track.missedSweeps === 0)
      .every((track) => track.associationMissedSweeps === 2)).toBe(true);

    const reappeared = tracker.update(sweeps[3]!, detector.analyze(sweeps[3]!))
      .filter((track) => track.missedSweeps === 0);
    expect(associationId).toBe(regularSpectralComponentLineageId(1));
    expect(reappeared).toHaveLength(5);
    expect(reappeared.every((track) =>
      track.associationId === associationId
      && track.associationMissedSweeps === 0)).toBe(true);
    expect(reappeared[0]!.associationRegionSweepIds)
      .toEqual([sweeps[0]!.id, sweeps[3]!.id]);
  });

  it('extracts each regular-line look through its own exact historical hull', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const fullComponents = new Map([
      [100_000, -50],
      [150_000, -42],
      [200_000, -32],
      [250_000, -42],
      [300_000, -50],
    ]);
    const truncatedComponents = new Map([
      [200_000, -32],
      [250_000, -42],
      [300_000, -50],
    ]);
    const powerFor = (components: ReadonlyMap<number, number>) =>
      frequencyHz.map((frequency) => {
        for (const [centerHz, peakDbm] of components) {
          if (Math.abs(frequency - centerHz) <= 1_000) return peakDbm;
        }
        return -110;
      });
    const sweeps = Array.from({ length: 8 }, (_, index) => makeSweep({
      id: `regular-exact-hull-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 3, index + 1)).toISOString(),
      frequencyHz,
      powerDbm: powerFor(index === 7 ? truncatedComponents : fullComponents),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    }));
    const config = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of sweeps) tracks = tracker.update(sweep, detector.analyze(sweep));
    const current = tracks.filter((track) => track.missedSweeps === 0);
    const representative = classificationRepresentatives(current)[0]!;

    expect(representative.associationRegionStartHz).toBe(199_000);
    expect(representative.associationRegionStopHz).toBe(301_000);
    expect(representative.regularComponentAssociationObservations?.slice(0, 7)
      .every((observation) =>
        observation.observedRegionStartHz === 99_000
        && observation.observedRegionStopHz === 301_000)).toBe(true);
    const observation = extractObservableFeatures(representative, { sweeps });
    expect(observation.sweepIds).toEqual(sweeps.map((sweep) => sweep.id).reverse());
    expect(observation.values['spectrum.sidebandScore']).toBeGreaterThan(0.6);
  });

  it('retains a regular-component lineage while publishing the exact latest member set', () => {
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
    const initialAssociationId = initial[0]!.associationId;
    const initialMemberTrackIds = initial[0]!.associationMemberTrackIds;

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
    const current = updated.filter((track) => track.missedSweeps === 0);

    expect(initialAssociationId).toBe(regularSpectralComponentLineageId(1));
    expect(replacement.associationMode).toBe('regular-spectral-component-activity');
    expect(current).toHaveLength(5);
    expect(current.every((track) =>
      track.associationModelId === REGULAR_SPECTRAL_COMPONENT_MODEL_ID
      && track.associationId === initialAssociationId)).toBe(true);
    expect(current.every((track) =>
      track.associationRegionSweepIds?.join(',') === [first.id, second.id].join(','))).toBe(true);
    expect(current.every((track) =>
      track.associationMemberTrackIds?.join(',') === current[0]!.associationMemberTrackIds?.join(','))).toBe(true);
    expect(current[0]!.associationMemberTrackIds).not.toEqual(initialMemberTrackIds);
    expect(current[0]!.regularComponentAssociationObservations?.map(
      (observation) => observation.members.map((member) => member.trackId),
    )).toEqual([
      initialMemberTrackIds,
      current[0]!.associationMemberTrackIds,
    ]);
    expect(() => extractObservableFeatures(current[0]!, { sweeps: [first, second] })).not.toThrow();
  });

  it('allocates a new lineage when overlapping hulls share no resolved component', () => {
    const frequencyHz = Array.from({ length: 251 }, (_, index) => index * 1_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const config = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeSweep({
      id: 'regular-no-shared-member-first',
      frequencyHz,
      powerDbm: powerFor([50_000, 75_000, 100_000, 150_000]),
      actualStartHz: 0,
      actualStopHz: 250_000,
      actualRbwHz: 2_000,
    });
    const initial = tracker.update(first, detector.analyze(first));
    const initialRepresentative = classificationRepresentatives(initial)[0]!;
    const initialAssociationId = initialRepresentative.associationId;
    const initialObservation =
      initialRepresentative.regularComponentAssociationObservations![0]!;
    const second = makeSweep({
      id: 'regular-no-shared-member-second',
      sequence: 2,
      capturedAt: '2026-01-01T00:00:01.000Z',
      frequencyHz,
      powerDbm: powerFor([125_000, 175_000, 200_000]),
      actualStartHz: 0,
      actualStopHz: 250_000,
      actualRbwHz: 2_000,
    });
    const updated = tracker.update(second, detector.analyze(second));
    const current = updated.filter((track) => track.missedSweeps === 0);
    const currentRepresentative = classificationRepresentatives(current)[0]!;
    const currentObservation =
      currentRepresentative.regularComponentAssociationObservations![0]!;

    expect(initialAssociationId).toBe(regularSpectralComponentLineageId(1));
    expect(currentRepresentative.associationId)
      .toBe(regularSpectralComponentLineageId(2));
    expect(currentRepresentative.associationRegionSweepIds).toEqual([second.id]);
    expect(() => extractObservableFeatures(
      currentRepresentative,
      { sweeps: [first, second] },
    )).not.toThrow();

    const forgedCarryover: DetectedSignal = {
      ...currentRepresentative,
      associationId: initialAssociationId,
      associationRegionSweepIds: [first.id, second.id],
      regularComponentAssociationObservations: [
        initialObservation,
        currentObservation,
      ],
    };
    expect(() => extractObservableFeatures(
      forgedCarryover,
      { sweeps: [first, second] },
    )).toThrow(/coherent complete scalar sweep/i);
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

  it('does not merge nearby independent same-spacing comb lineages during member churn', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeSweep({
      id: 'two-combs-first',
      frequencyHz,
      powerDbm: powerFor([
        50_000, 75_000, 100_000, 125_000,
        250_000, 275_000, 300_000, 325_000,
      ]),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    });
    const firstCandidates = detector.analyze(first);
    const firstAssociations =
      regularSpectralComponentAssociations(firstCandidates, first);
    expect(firstAssociations).toHaveLength(2);
    expect(firstAssociations.map((association) => association.spacingHz))
      .toEqual([25_000, 25_000]);
    const initial = tracker.update(first, firstCandidates);
    const initialLeftId = initial.find((track) => track.startHz === 49_000)!.associationId;
    const initialRightId = initial.find((track) => track.startHz === 249_000)!.associationId;
    const second = makeSweep({
      id: 'two-combs-second',
      sequence: 2,
      capturedAt: '2026-01-01T00:00:01.000Z',
      frequencyHz,
      powerDbm: powerFor([
        75_000, 100_000, 125_000, 150_000,
        225_000, 250_000, 275_000, 300_000,
      ]),
      actualStartHz: 0,
      actualStopHz: 500_000,
      actualRbwHz: 2_000,
    });
    const secondCandidates = detector.analyze(second);
    const secondAssociations =
      regularSpectralComponentAssociations(secondCandidates, second);
    expect(secondAssociations).toHaveLength(2);
    expect(secondAssociations.map((association) => association.spacingHz))
      .toEqual([25_000, 25_000]);
    const tracks = tracker.update(second, secondCandidates)
      .filter((track) => track.missedSweeps === 0);
    const associationIds = new Set(tracks.map((track) => track.associationId));

    expect(tracks).toHaveLength(8);
    expect(
      tracks.every((track) => track.associationMode === 'regular-spectral-component-activity'),
      JSON.stringify(tracks.map((track) => ({
        startHz: track.startHz,
        associationMode: track.associationMode,
        associationId: track.associationId,
      }))),
    ).toBe(true);
    expect(associationIds.size).toBe(2);
    expect(tracks.find((track) => track.startHz === 74_000)!.associationId).toBe(initialLeftId);
    expect(tracks.find((track) => track.startHz === 224_000)!.associationId).toBe(initialRightId);
    for (const associationId of associationIds) {
      expect(tracks.filter((track) => track.associationId === associationId)).toHaveLength(4);
    }
    expect(regularSpectralComponentLineagesAreCompatible(
      {
        startHz: 49_000,
        stopHz: 126_000,
        spacingHz: 25_000,
        latticeAnchorHz: 50_000,
        memberCentersHz: [50_000, 75_000, 100_000, 125_000],
      },
      {
        startHz: 74_000,
        stopHz: 151_000,
        spacingHz: 25_000,
        latticeAnchorHz: 75_000,
        memberCentersHz: [75_000, 100_000, 125_000, 150_000],
      },
      2_000,
      1_000,
    )).toBe(true);
    expect(regularSpectralComponentLineagesAreCompatible(
      {
        startHz: 74_000,
        stopHz: 151_000,
        spacingHz: 25_000,
        latticeAnchorHz: 75_000,
        memberCentersHz: [75_000, 100_000, 125_000, 150_000],
      },
      {
        startHz: 224_000,
        stopHz: 301_000,
        spacingHz: 25_000,
        latticeAnchorHz: 225_000,
        memberCentersHz: [225_000, 250_000, 275_000, 300_000],
      },
      2_000,
      1_000,
    )).toBe(false);
    expect(regularSpectralComponentLineagesAreCompatible(
      {
        startHz: 49_000,
        stopHz: 151_000,
        spacingHz: 25_000,
        latticeAnchorHz: 50_000,
        memberCentersHz: [50_000, 75_000, 100_000, 150_000],
      },
      {
        startHz: 124_000,
        stopHz: 201_000,
        spacingHz: 25_000,
        latticeAnchorHz: 125_000,
        memberCentersHz: [125_000, 175_000, 200_000],
      },
      2_000,
      1_000,
    )).toBe(false);
  });

  it('keeps separately allocated regular lineages distinct regardless of member spelling', () => {
    const base = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 })
      .analyze(makeSweep())[0]!;
    const firstMembers = ['a,b', 'c'] as const;
    const secondMembers = ['a', 'b,c'] as const;
    const representatives: readonly DetectedSignal[] = [
      {
        ...base,
        id: firstMembers[0],
        associationMode: 'regular-spectral-component-activity',
        associationId: regularSpectralComponentLineageId(1),
        associationMemberTrackIds: firstMembers,
        associationMissedSweeps: 0,
      },
      {
        ...base,
        id: secondMembers[0],
        associationMode: 'regular-spectral-component-activity',
        associationId: regularSpectralComponentLineageId(2),
        associationMemberTrackIds: secondMembers,
        associationMissedSweeps: 0,
      },
    ];

    expect(representatives.map((signal) => signal.associationId)).toEqual([
      'regular-spectral-component-lineage-0001',
      'regular-spectral-component-lineage-0002',
    ]);
    expect(classificationRepresentatives(representatives)).toEqual([
      representatives[0],
      representatives[1],
    ]);
    expect(classificationRepresentatives([...representatives].reverse())).toEqual([
      representatives[0],
      representatives[1],
    ]);
  });

  it('selects a capture target from current source-sweep integrated excess power instead of lexical or association-center order', () => {
    const base = new SignalDetector({ ...detectionConfig, minimumConsecutiveSweeps: 1 })
      .analyze(makeSweep())[0]!;
    const associationMembers = ['signal-0002', 'signal-0010', 'signal-0018'] as const;
    const exactCurrentLook = (
      id: string,
      peakHz: number,
      peakDbm: number,
    ): DetectedSignal => {
      const sourceSweep = makeSweep({
        id: `rank-source-${id}`,
        capturedAt: base.lastSeenAt,
        frequencyHz: [peakHz - 100, peakHz, peakHz + 100],
        powerDbm: [-90, peakDbm, -90],
        actualStartHz: peakHz - 150,
        actualStopHz: peakHz + 150,
        actualRbwHz: 100,
      });
      const observation = {
        sourceSweep,
        startHz: peakHz,
        stopHz: peakHz,
        peakHz,
        detectorId: base.detectorId,
        localBayesianEvidence: base.classificationRegionObservation!.localBayesianEvidence,
      };
      return {
        ...base,
        id,
        startHz: peakHz,
        stopHz: peakHz,
        peakHz,
        peakDbm,
        bandwidthHz: 0,
        noiseFloorDbm: -90,
        sweepIds: [sourceSweep.id],
        classificationRegionStartHz: peakHz,
        classificationRegionStopHz: peakHz,
        classificationRegionSweepIds: [sourceSweep.id],
        classificationRegionObservation: observation,
        localClassificationObservations: [observation],
      };
    };
    const associated = (
      id: typeof associationMembers[number],
      startHz: number,
      peakDbm: number,
    ): DetectedSignal => ({
      ...exactCurrentLook(id, startHz, peakDbm),
      missedSweeps: 0,
      associationMode: 'regular-spectral-component-activity',
      associationId: regularSpectralComponentLineageId(7),
      associationRegionStartHz: 100,
      associationRegionStopHz: 300,
      associationMemberTrackIds: associationMembers,
      associationMissedSweeps: 0,
    });
    const left = associated('signal-0002', 100, -72);
    const center = associated('signal-0010', 200, -61);
    const strongestRight = associated('signal-0018', 300, -40);
    const local: DetectedSignal = {
      ...exactCurrentLook('signal-0001', base.peakHz, -50),
      associationMode: 'frequency-local',
    };
    const signals = [left, center, strongestRight, local];

    expect(CLASSIFICATION_CAPTURE_TARGET_SELECTION_POLICY_ID)
      .toBe('preferred-then-current-source-sweep-integrated-excess-power-physical-or-qualified-agile-member-target-v4');
    expect(classificationRepresentatives(signals).map((signal) => signal.id))
      .toEqual(['signal-0001', 'signal-0010']);
    expect(classificationCaptureTargetRepresentatives(signals)[0]?.id)
      .toBe('signal-0018');
    expect(classificationCaptureTargetRepresentatives(signals, left.id).map(
      (signal) => signal.id,
    )).toEqual([left.id]);

    const tiedLocal: DetectedSignal = exactCurrentLook(
      'signal-tied-local',
      local.peakHz,
      -35,
    );
    const strongerAgile: DetectedSignal = {
      ...tiedLocal,
      id: 'frequency-agile-2g4-activity-0001',
      peakDbm: -20,
      associationMode: 'frequency-agile-2g4-activity',
      associationId: 'frequency-agile-2g4-activity-0001',
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationRegionStartHz: 2_402_000_000,
      associationRegionStopHz: 2_480_000_000,
      associationRegionSweepIds: tiedLocal.sweepIds,
      associationMemberTrackIds: [tiedLocal.id],
      associationMissedSweeps: 0,
    };
    expect(currentVisiblePhysicalClassificationRows([
      tiedLocal,
      strongerAgile,
    ]).map((signal) => signal.id)).toEqual([tiedLocal.id]);
    expect(classificationCaptureTargetRepresentatives(
      [tiedLocal, strongerAgile],
    )[0]?.id).toBe(tiedLocal.id);
    expect(classificationCaptureTargetRepresentatives(
      [tiedLocal, strongerAgile],
      strongerAgile.id,
    )).toEqual([]);
  });

  it('projects only the exact current agile member to its qualified multi-look evidence', () => {
    const config: SignalDetectionConfig = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 2,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const centersHz = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value) => value * 1_000_000);
    const sweeps = centersHz.map((centerHz, index) =>
      agileSweep(index + 1, centerHz, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of sweeps) {
      tracks = tracker.update(sweep, detector.analyze(sweep));
    }
    const activity = tracks.find((track) =>
      track.associationMode === 'frequency-agile-2g4-activity')!;
    const rawTarget = tracks.find((track) =>
      track.id === activity.associationObservations?.at(-1)?.trackId)!;
    const projections = classificationCaptureTargetProjections(tracks);

    expect(rawTarget).toMatchObject({ state: 'candidate', missedSweeps: 0 });
    expect(currentVisiblePhysicalClassificationRows(tracks)).toEqual([]);
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      rawTarget: { id: rawTarget.id, state: 'candidate' },
      projectedRepresentative: { id: activity.id },
      projectionKind: 'current-qualified-agile-latest-member',
    });
    expect(classificationCaptureTargetRepresentatives(tracks)).toEqual([activity]);
    expect(classificationCaptureTargetProjections(tracks, rawTarget.id)).toEqual(projections);
    expect(classificationCaptureTargetProjections(tracks, activity.id)).toEqual([]);
    expect(classificationCaptureTargetProjections([rawTarget])).toEqual([]);

    const staleActivity = { ...activity, associationMissedSweeps: 1 };
    expect(classificationCaptureTargetProjections([
      ...tracks.filter((track) => track.id !== activity.id),
      staleActivity,
    ])).toEqual([]);
    const mutatedRawTarget = structuredClone(rawTarget);
    mutatedRawTarget.localClassificationObservations =
      mutatedRawTarget.localClassificationObservations?.map((observation, index, values) =>
        index === values.length - 1
          ? { ...observation, peakHz: observation.peakHz + 1 }
          : observation);
    expect(classificationCaptureTargetProjections([
      ...tracks.filter((track) => track.id !== rawTarget.id),
      mutatedRawTarget,
    ])).toEqual([]);

    const spectrumObservation = extractObservableFeatures(activity, { sweeps });
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span',
      id: 'qualified-agile-member-zero-span',
      sequence: 9,
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 9 * 50).toISOString(),
      elapsedMilliseconds: 50,
      frequencyHz: rawTarget.peakHz,
      samplePeriodSeconds: 1 / 9_000,
      targetDetectionId: rawTarget.id,
      powerDbm: Array.from(
        { length: 450 },
        (_, index) => index % 10 < 4 ? -45 : -90,
      ),
      requested: admittedDetectedPower(rawTarget.peakHz, 450, 0.05, 20),
      actualRbwHz: 20_000,
      actualAttenuationDb: 0,
      source: 'scan-text',
      complete: true,
      identity,
      timingQualification: 'wall-clock-derived',
    };
    const receipt = createDetectedPowerCaptureReceipt({
      activeSignals: tracks,
      evidenceSweeps: sweeps,
      capture: zeroSpan,
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    });

    expect(receipt).toMatchObject({
      schemaVersion: 4,
      selection: {
        rawTargetId: rawTarget.id,
        projectedRepresentativeId: activity.id,
      },
      candidates: [{
        rawTargetId: rawTarget.id,
        state: 'candidate',
        projectionKind: 'current-qualified-agile-latest-member',
        projectedRepresentativeId: activity.id,
        runtimeAdmission: { status: 'admitted' },
      }],
    });
    const censoredObservation = extractObservableFeatures(activity, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    });
    expect(censoredObservation).toMatchObject({
      associationEvidenceQualification: 'provenance-bound-current-promotion',
      views: ['scalar-spectrum'],
      limitations: expect.arrayContaining([
        'frequency-agile-band-activity-association',
        'frequency-agile-fixed-tune-envelope-censored',
      ]),
    });
    expect(censoredObservation.values).toEqual(spectrumObservation.values);
    expect(censoredObservation.zeroSpanCaptureId).toBeUndefined();
    expect(censoredObservation.detectedPowerAcquisitionQualification).toBeUndefined();
    expect(Object.keys(censoredObservation.values).some((name) => name.startsWith('envelope.')))
      .toBe(false);

    const unissuedReceipt = structuredClone(receipt);
    expect(() => extractObservableFeatures(activity, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: unissuedReceipt,
    })).toThrow(/receipt not issued/i);
    expect(() => extractObservableFeatures(activity, {
      sweeps,
      zeroSpan: {
        ...zeroSpan,
        powerDbm: zeroSpan.powerDbm.map((value, index) => index === 0 ? Number.NaN : value),
      },
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/finite samples/i);

    expect(inferPosterior(censoredObservation)).toEqual(inferPosterior(spectrumObservation));
    expect(knownModelSupportRank(censoredObservation))
      .toBe(knownModelSupportRank(spectrumObservation));
    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: tracks,
      evidenceSweeps: sweeps,
      preferredDetectionId: activity.id,
      capture: { ...zeroSpan, targetDetectionId: activity.id },
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/cannot runtime-admit preferred tracker target/i);
  });

  it('retains periodic swept components locally while classifying their complete observed region once', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 50_000);
    const componentCentersHz = [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000];
    const powerDbm = frequencyHz.map((frequency) =>
      componentCentersHz.some((center) => Math.abs(frequency - center) <= 350_000) ? -42 : -110);
    const requested = admittedSpectrum({
      ...analyzer,
      startHz: 0,
      stopHz: 20_000_000,
      points: frequencyHz.length,
      sweepTimeSeconds: 0.05,
    });
    const sweeps = Array.from({ length: 8 }, (_, index) => makeSweep({
      id: `periodic-swept-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      frequencyHz,
      powerDbm,
      requested,
      actualStartHz: 0,
      actualStopHz: 20_000_000,
      actualRbwHz: 50_000,
    }));
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of sweeps) tracks = tracker.update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(5);
    expect(tracks.every((track) => track.associationMode === 'multicomponent-swept-region-activity')).toBe(true);
    expect(tracks.every((track) =>
      track.associationModelId === MULTICOMPONENT_SWEPT_REGION_MODEL_ID)).toBe(true);
    expect(tracks.every((track) => track.associationMemberTrackIds?.length === 5)).toBe(true);
    expect(tracks.every((track) => track.associationRegionStartHz === 5_650_000
      && track.associationRegionStopHz === 14_350_000)).toBe(true);
    expect(tracks.every((track) => track.associationRegionSweepIds?.length === 8)).toBe(true);
    expect(tracks.every((track) => track.multicomponentAssociationObservations?.length === 8)).toBe(true);
    expect(tracks.every((track) => track.multicomponentAssociationObservations?.every((item) =>
      item.members.length === 5
      && item.qualification.endsWith('-not-emitter-identity')))).toBe(true);
    const representatives = classificationRepresentatives(tracks);
    expect(representatives).toHaveLength(1);
    expect((representatives[0]!.startHz + representatives[0]!.stopHz) / 2).toBe(10_000_000);
    const observation = extractObservableFeatures(representatives[0]!, { sweeps });
    expect(observation.occupiedStartHz).toBe(5_650_000);
    expect(observation.occupiedStopHz).toBe(14_350_000);
    expect(observation.bandwidthHz).toBe(8_700_000);
    expect(observation.limitations).toContain('multicomponent-swept-region-activity-association');
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'regional-member-envelope', sequence: 9,
      capturedAt: '2026-01-01T00:00:09.000Z', elapsedMilliseconds: 50,
      frequencyHz: representatives[0]!.peakHz, samplePeriodSeconds: 1 / 9_000,
      targetDetectionId: representatives[0]!.id,
      powerDbm: Array.from({ length: 450 }, (_, index) => index % 10 < 7 ? -45 : -90),
      requested: admittedDetectedPower(representatives[0]!.peakHz, 450, 0.05, 50),
      actualRbwHz: 50_000, actualAttenuationDb: 0,
      source: 'scan-text', complete: true, identity, timingQualification: 'simulation-exact',
    };
    const envelopeObservation = extractObservableFeatures(representatives[0]!, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: observation.sweepIds,
      detectedPowerCaptureReceipt: createDetectedPowerCaptureReceipt({
        activeSignals: tracks.filter((track) => track.state === 'active'),
        evidenceSweeps: sweeps,
        preferredDetectionId: representatives[0]!.id,
        capture: zeroSpan,
        admittedTargetTuneHz: zeroSpan.frequencyHz,
        spectrumSweepIds: observation.sweepIds,
      }),
    });
    expect(envelopeObservation.limitations)
      .toContain('zero-span-local-member-of-nonidentity-regional-association');
    expect(envelopeObservation.detectedPowerAcquisitionQualification)
      .toBe('receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5');
    expect(envelopeObservation.detectedPowerSelectionCondition)
      .toBe('operator-preferred-current-target');
    expect(envelopeObservation.limitations)
      .toContain('zero-span-operator-preferred-target-selection');
    const malformed = { ...representatives[0]!, associationModelId: 'unreviewed-periodic-model' };
    const staleV1 = {
      ...representatives[0]!,
      associationModelId: 'multicomponent-swept-region-v1',
    };
    expect(observableAssociationEvidenceIsCurrentlyQualified(malformed)).toBe(false);
    expect(observableAssociationEvidenceIsCurrentlyQualified(staleV1)).toBe(false);
    expect(() => extractObservableFeatures(malformed, { sweeps }))
      .toThrow(/coherent complete scalar sweep/);
    expect(() => extractObservableFeatures(staleV1, { sweeps }))
      .toThrow(/coherent complete scalar sweep/);

    const provenance = representatives[0]!.multicomponentAssociationObservations!;
    const latestIndex = provenance.length - 1;
    expect(provenance.every((item) => item.anchorTrackId !== undefined
      && item.qualification === 'selected-multiscale-region-containment-not-emitter-identity')).toBe(true);
    const withoutDetectedMembers: Sweep = {
      ...sweeps[0]!,
      powerDbm: sweeps[0]!.powerDbm.map(() => -110),
    };
    expect(detector.analyze(withoutDetectedMembers)).toEqual([]);
    expect(() => extractObservableFeatures(representatives[0]!, {
      sweeps: [withoutDetectedMembers, ...sweeps.slice(1)],
    })).toThrow(/coherent complete scalar sweep/);

    const latestSweep = sweeps.at(-1)!;
    const withUnrecordedComponent: Sweep = {
      ...latestSweep,
      powerDbm: latestSweep.powerDbm.map((power, index) =>
        Math.abs(latestSweep.frequencyHz[index]! - 16_000_000) <= 350_000 ? -42 : power),
    };
    expect(detector.analyze(withUnrecordedComponent)).toHaveLength(6);
    expect(() => extractObservableFeatures(representatives[0]!, {
      sweeps: [...sweeps.slice(0, -1), withUnrecordedComponent],
    })).toThrow(/coherent complete scalar sweep/);

    const replayMismatchedEvidence: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: provenance.map((item, index) => index === latestIndex
        ? {
          ...item,
          members: item.members.map((member, memberIndex) => memberIndex === 0
            ? {
              ...member,
              localBayesianEvidence: {
                ...member.localBayesianEvidence,
                observedMeanShiftDb: member.localBayesianEvidence.observedMeanShiftDb + 1e-6,
              },
            }
            : member),
        }
        : item),
    };
    expect(() => extractObservableFeatures(replayMismatchedEvidence, { sweeps }))
      .toThrow(/coherent complete scalar sweep/);

    const tamperedMember: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: provenance.map((item, index) => index === latestIndex
        ? {
          ...item,
          members: item.members.map((member, memberIndex) => memberIndex === 0
            ? { ...member, startHz: member.startHz + 50_000 }
            : member),
        }
        : item),
    };
    const reorderedSweeps: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: [...provenance].reverse(),
    };
    const wrongOneLookScope: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: provenance.map((item, index) => index === latestIndex
        ? {
          ...item,
          members: item.members.map((member, memberIndex) => memberIndex === 0
            ? {
              ...member,
              localBayesianEvidence: { ...member.localBayesianEvidence, posteriorScope: 'track-state', looks: 2 },
            }
            : member),
        }
        : item),
    };
    const wrongAnchor: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: provenance.map((item, index) => index === latestIndex
        ? { ...item, anchorTrackId: 'track-not-in-this-sweep' }
        : item),
    };
    const observationsMissingAnchor = structuredClone(provenance);
    delete observationsMissingAnchor[latestIndex]!.anchorTrackId;
    const missingAnchor: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: observationsMissingAnchor,
    };
    const wrongGeometry: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: provenance.map((item, index) => index === latestIndex
        ? { ...item, geometryId: `${item.geometryId}-tampered` }
        : item),
    };
    const wrongTolerance: DetectedSignal = {
      ...representatives[0]!,
      multicomponentAssociationObservations: provenance.map((item, index) => index === latestIndex
        ? { ...item, containmentToleranceHz: item.containmentToleranceHz + 1 }
        : item),
    };
    const wrongCurrentRegion: DetectedSignal = {
      ...representatives[0]!,
      associationRegionStartHz: representatives[0]!.associationRegionStartHz! + 50_000,
    };
    const contradictoryCurrentTime: DetectedSignal = {
      ...representatives[0]!,
      lastSeenAt: sweeps[0]!.capturedAt,
    };
    for (const tampered of [
      tamperedMember,
      reorderedSweeps,
      wrongOneLookScope,
      wrongAnchor,
      missingAnchor,
      wrongGeometry,
      wrongTolerance,
      wrongCurrentRegion,
    ]) {
      expect(observableAssociationEvidenceIsCurrentlyQualified(tampered)).toBe(false);
      expect(() => extractObservableFeatures(tampered, { sweeps }))
        .toThrow(/coherent complete scalar sweep/);
    }
    // The compact multicomponent observation does not duplicate wall-clock
    // time; the extractor binds it to the externally supplied exact sweep.
    expect(() => extractObservableFeatures(contradictoryCurrentTime, { sweeps }))
      .toThrow(/coherent complete scalar sweep/);
  });

  it('updates a multicomponent lineage to its current hull across interior churn and outer loss', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 50_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 350_000) ? -42 : -110);
    const requested = admittedSpectrum({
      ...analyzer,
      startHz: 0,
      stopHz: 20_000_000,
      points: frequencyHz.length,
      sweepTimeSeconds: 0.05,
    });
    const makeRegionalSweep = (id: string, sequence: number, centersHz: readonly number[]) => makeSweep({
      id,
      sequence,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
      frequencyHz,
      powerDbm: powerFor(centersHz),
      requested,
      actualStartHz: 0,
      actualStopHz: 20_000_000,
      actualRbwHz: 50_000,
    });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeRegionalSweep('stable-hull-first', 1, [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000]);
    let tracks = tracker.update(first, detector.analyze(first));
    const firstRepresentative = classificationRepresentatives(tracks)[0]!;
    const firstAssociationId = firstRepresentative.associationId;

    const interiorMissing = makeRegionalSweep('stable-hull-interior-missing', 2, [6_000_000, 8_000_000, 12_000_000, 14_000_000]);
    tracks = tracker.update(interiorMissing, detector.analyze(interiorMissing));
    const currentAfterInteriorChurn = tracks.filter((track) => track.missedSweeps === 0);
    expect(currentAfterInteriorChurn).toHaveLength(4);
    expect(currentAfterInteriorChurn.every((track) => track.associationId === firstAssociationId)).toBe(true);
    expect(currentAfterInteriorChurn.every((track) => track.associationRegionStartHz === 5_650_000
      && track.associationRegionStopHz === 14_350_000)).toBe(true);
    expect(currentAfterInteriorChurn.every((track) =>
      track.associationRegionSweepIds?.join(',') === `${first.id},${interiorMissing.id}`)).toBe(true);
    expect(currentAfterInteriorChurn.every((track) =>
      track.multicomponentAssociationObservations?.at(-1)?.members.length === 4)).toBe(true);
    expect(classificationRepresentatives(tracks.filter((track) => track.state === 'active'))).toHaveLength(1);

    const edgeMissing = makeRegionalSweep('stable-hull-edge-missing', 3, [8_000_000, 10_000_000, 12_000_000, 14_000_000]);
    tracks = tracker.update(edgeMissing, detector.analyze(edgeMissing));
    const currentAfterEdgeLoss = tracks.filter((track) => track.missedSweeps === 0);
    const currentRepresentative = classificationRepresentatives(currentAfterEdgeLoss)[0]!;
    expect(currentRepresentative.associationId).toBe(firstAssociationId);
    expect(currentRepresentative.associationRegionStartHz).toBe(7_650_000);
    expect(currentRepresentative.associationRegionStopHz).toBe(14_350_000);
    expect(currentRepresentative.associationRegionSweepIds)
      .toEqual([first.id, interiorMissing.id, edgeMissing.id]);
    expect(currentRepresentative.multicomponentAssociationObservations).toHaveLength(3);
    expect(currentRepresentative.multicomponentAssociationObservations?.at(-1)).toMatchObject({
      sweepId: edgeMissing.id,
      observedRegionStartHz: 7_650_000,
      observedRegionStopHz: 14_350_000,
    });
    const currentObservation = extractObservableFeatures(currentRepresentative, {
      sweeps: [first, interiorMissing, edgeMissing],
    });
    expect(currentObservation.occupiedStartHz).toBe(7_650_000);
    expect(currentObservation.occupiedStopHz).toBe(14_350_000);
    expect(currentObservation.bandwidthHz).toBe(6_700_000);
    const stalePublicHull: DetectedSignal = {
      ...currentRepresentative,
      associationRegionStartHz: 5_650_000,
    };
    expect(observableAssociationEvidenceIsCurrentlyQualified(stalePublicHull)).toBe(false);
    expect(() => extractObservableFeatures(stalePublicHull, {
      sweeps: [first, interiorMissing, edgeMissing],
    })).toThrow(/coherent complete scalar sweep/);
    const staleEdge = tracks.find((track) => track.startHz === 5_650_000)!;
    expect(staleEdge.associationId).toBe(firstAssociationId);
    expect(staleEdge.associationMissedSweeps).toBe(1);
    expect(observableAssociationEvidenceIsCurrentlyQualified(staleEdge)).toBe(false);
    const preferredDepartedMember = classificationRepresentatives(
      tracks.filter((track) => track.state === 'active'),
      staleEdge.id,
    );
    expect(preferredDepartedMember).toHaveLength(1);
    expect(preferredDepartedMember[0]!.id).toBe(currentRepresentative.id);
    expect(preferredDepartedMember[0]!.associationMemberTrackIds).not.toContain(staleEdge.id);
    expect(preferredDepartedMember[0]!.associationMissedSweeps).toBe(0);

    const oppositeEdgeAdded = makeRegionalSweep(
      'stable-hull-opposite-edge-added',
      4,
      [8_000_000, 10_000_000, 12_000_000, 14_000_000, 16_000_000],
    );
    tracks = tracker.update(oppositeEdgeAdded, detector.analyze(oppositeEdgeAdded));
    const shiftedRepresentative = classificationRepresentatives(
      tracks.filter((track) => track.missedSweeps === 0),
    )[0]!;
    expect(shiftedRepresentative.associationId).toBe(firstAssociationId);
    expect(shiftedRepresentative.associationRegionStartHz).toBe(7_650_000);
    expect(shiftedRepresentative.associationRegionStopHz).toBe(16_350_000);
    expect(shiftedRepresentative.associationRegionSweepIds)
      .toEqual([edgeMissing.id, oppositeEdgeAdded.id]);
    expect(shiftedRepresentative.multicomponentAssociationObservations?.map((item) => item.sweepId))
      .toEqual([edgeMissing.id, oppositeEdgeAdded.id]);

    const firstBlank = makeRegionalSweep('stable-hull-unqualified-gap-1', 5, []);
    const firstMiss = tracker.update(firstBlank, detector.analyze(firstBlank));
    const retainedDuringFirstMiss = firstMiss.find((track) =>
      track.associationId === firstAssociationId)!;
    expect(retainedDuringFirstMiss.associationMissedSweeps).toBe(1);
    expect(observableAssociationEvidenceIsCurrentlyQualified(retainedDuringFirstMiss))
      .toBe(false);
    const secondBlank = makeRegionalSweep('stable-hull-unqualified-gap-2', 6, []);
    const secondMiss = tracker.update(secondBlank, detector.analyze(secondBlank));
    const retainedDuringSecondMiss = secondMiss.find((track) =>
      track.associationId === firstAssociationId)!;
    expect(retainedDuringSecondMiss.associationMissedSweeps).toBe(2);
    expect(observableAssociationEvidenceIsCurrentlyQualified(retainedDuringSecondMiss))
      .toBe(false);
    const reappeared = makeRegionalSweep(
      'stable-hull-after-unqualified-gap',
      7,
      [8_000_000, 10_000_000, 12_000_000, 14_000_000, 16_000_000],
    );
    tracks = tracker.update(reappeared, detector.analyze(reappeared));
    const restartedRepresentative = classificationRepresentatives(
      tracks.filter((track) => track.missedSweeps === 0),
    )[0]!;
    expect(restartedRepresentative.associationId).toBe(firstAssociationId);
    expect(restartedRepresentative.associationRegionSweepIds)
      .toEqual([edgeMissing.id, oppositeEdgeAdded.id, reappeared.id]);
    expect(restartedRepresentative.multicomponentAssociationObservations)
      .toHaveLength(3);
    expect(observableAssociationEvidenceIsCurrentlyQualified(restartedRepresentative))
      .toBe(true);
  });

  it('requires geometry, padded hull overlap, and a shared resolved center for multicomponent lineage continuity', () => {
    const baseline = {
      geometryId: 'geometry-a',
      startHz: 5_500_000,
      stopHz: 14_500_000,
      rbwHz: 50_000,
      binWidthHz: 50_000,
      memberCentersHz: [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000],
    };

    expect(multicomponentSweptRegionLineagesAreCompatible(baseline, {
      ...baseline,
      startHz: 5_700_000,
      stopHz: 14_700_000,
      memberCentersHz: [6_200_000, 8_200_000, 10_200_000, 12_200_000, 14_200_000],
    })).toBe(true);
    expect(multicomponentSweptRegionLineagesAreCompatible(baseline, {
      ...baseline,
      geometryId: 'geometry-b',
    })).toBe(false);
    expect(multicomponentSweptRegionLineagesAreCompatible(baseline, {
      ...baseline,
      startHz: 12_000_000,
      stopHz: 19_000_000,
      memberCentersHz: [12_000_000, 14_000_000, 16_000_000, 18_000_000],
    })).toBe(false);
    // Broadly overlapping hulls are still ambiguous unrelated morphology
    // unless at least one independently resolved component persists.
    expect(multicomponentSweptRegionLineagesAreCompatible(baseline, {
      ...baseline,
      memberCentersHz: [6_500_000, 8_500_000, 10_500_000, 12_500_000, 14_500_000],
    })).toBe(false);
  });

  it('retains only the immutable latest eight multicomponent observations', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 50_000);
    const centersHz = [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000];
    const powerDbm = frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 350_000) ? -42 : -110);
    const requested = admittedSpectrum({
      ...analyzer,
      startHz: 0,
      stopHz: 20_000_000,
      points: frequencyHz.length,
      sweepTimeSeconds: 0.05,
    });
    const sweeps = Array.from({ length: 10 }, (_, index) => makeSweep({
      id: `multicomponent-exact-eight-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, index + 1)).toISOString(),
      frequencyHz,
      powerDbm,
      requested,
      actualStartHz: 0,
      actualStopHz: 20_000_000,
      actualRbwHz: 50_000,
    }));
    const config = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of sweeps) {
      tracks = tracker.update(sweep, detector.analyze(sweep));
    }
    const representative = classificationRepresentatives(
      tracks.filter((track) => track.missedSweeps === 0),
    )[0]!;
    const expectedSweepIds = sweeps.slice(-8).map((sweep) => sweep.id);

    expect(representative.associationModelId)
      .toBe(MULTICOMPONENT_SWEPT_REGION_MODEL_ID);
    expect(representative.associationRegionSweepIds).toEqual(expectedSweepIds);
    expect(representative.multicomponentAssociationObservations?.map(
      (observation) => observation.sweepId,
    )).toEqual(expectedSweepIds);
    expect(extractObservableFeatures(representative, { sweeps }).sweepIds)
      .toEqual([...expectedSweepIds].reverse());
  });

  it('expires multicomponent provenance and rejects a disjoint reappearance', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 50_000);
    const powerFor = (centersHz: readonly number[]) => frequencyHz.map((frequency) =>
      centersHz.some((center) => Math.abs(frequency - center) <= 350_000) ? -42 : -110);
    const requested = admittedSpectrum({
      ...analyzer,
      startHz: 0,
      stopHz: 20_000_000,
      points: frequencyHz.length,
      sweepTimeSeconds: 0.05,
    });
    const regionalSweep = (
      id: string,
      sequence: number,
      centersHz: readonly number[],
    ) => makeSweep({
      id,
      sequence,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 2, sequence)).toISOString(),
      frequencyHz,
      powerDbm: powerFor(centersHz),
      requested,
      actualStartHz: 0,
      actualStopHz: 20_000_000,
      actualRbwHz: 50_000,
    });
    const config = {
      ...detectionConfig,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    };
    const detector = new SignalDetector(config);

    const expiryTracker = new SignalTracker(config);
    const initial = regionalSweep(
      'multicomponent-expiry-initial',
      1,
      [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000],
    );
    let expiryTracks = expiryTracker.update(initial, detector.analyze(initial));
    const expiredAssociationId = expiryTracks[0]!.associationId;
    for (let sequence = 2; sequence <= 4; sequence += 1) {
      const single = regionalSweep(
        `multicomponent-expiry-single-${sequence}`,
        sequence,
        [10_000_000],
      );
      expiryTracks = expiryTracker.update(single, detector.analyze(single));
    }
    const survivingLocal = expiryTracks.find((track) =>
      track.missedSweeps === 0)!;
    expect(survivingLocal.associationMode).toBe('frequency-local');
    expect(survivingLocal.associationId).toBeUndefined();
    const afterExpiry = regionalSweep(
      'multicomponent-expiry-reappeared',
      5,
      [6_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000],
    );
    expiryTracks = expiryTracker.update(afterExpiry, detector.analyze(afterExpiry));
    expect(classificationRepresentatives(
      expiryTracks.filter((track) => track.missedSweeps === 0),
    )[0]!.associationId).not.toBe(expiredAssociationId);

    const disjointTracker = new SignalTracker(config);
    const left = regionalSweep(
      'multicomponent-disjoint-left',
      1,
      [2_000_000, 4_000_000, 6_000_000, 8_000_000],
    );
    let disjointTracks = disjointTracker.update(left, detector.analyze(left));
    const leftAssociationId = disjointTracks[0]!.associationId;
    const blank = regionalSweep('multicomponent-disjoint-blank', 2, []);
    disjointTracker.update(blank, detector.analyze(blank));
    const right = regionalSweep(
      'multicomponent-disjoint-right',
      3,
      [12_000_000, 14_000_000, 16_000_000, 18_000_000],
    );
    disjointTracks = disjointTracker.update(right, detector.analyze(right));
    const rightRepresentative = classificationRepresentatives(
      disjointTracks.filter((track) => track.missedSweeps === 0),
    )[0]!;
    expect(rightRepresentative.associationId).not.toBe(leftAssociationId);
    expect(rightRepresentative.associationRegionSweepIds).toEqual([right.id]);
  });

  it('does not associate a wide-spaced irregular carrier set as periodic swept activity', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 50_000);
    const componentCentersHz = [5_000_000, 7_000_000, 9_600_000, 13_000_000];
    const powerDbm = frequencyHz.map((frequency) =>
      componentCentersHz.some((center) => Math.abs(frequency - center) <= 250_000) ? -42 : -110);
    const sweep = makeSweep({
      frequencyHz,
      powerDbm,
      requested: admittedSpectrum({ ...analyzer, startHz: 0, stopHz: 20_000_000, points: frequencyHz.length, sweepTimeSeconds: 0.05 }),
      actualStartHz: 0,
      actualStopHz: 20_000_000,
      actualRbwHz: 50_000,
    });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracks = new SignalTracker(config).update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(4);
    expect(tracks.every((track) => track.associationMode === 'frequency-local')).toBe(true);
  });

  it('does not suppress a wide local emission inside a periodic-looking regional set', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 50_000);
    const powerDbm = frequencyHz.map((frequency) => {
      if (Math.abs(frequency - 10_000_000) <= 800_000) return -42;
      return [6_000_000, 8_000_000, 12_000_000, 14_000_000]
        .some((center) => Math.abs(frequency - center) <= 250_000) ? -42 : -110;
    });
    const sweep = makeSweep({
      frequencyHz,
      powerDbm,
      requested: admittedSpectrum({ ...analyzer, startHz: 0, stopHz: 20_000_000, points: frequencyHz.length, sweepTimeSeconds: 0.05 }),
      actualStartHz: 0,
      actualStopHz: 20_000_000,
      actualRbwHz: 50_000,
    });
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const tracks = new SignalTracker(config).update(sweep, detector.analyze(sweep));

    expect(tracks).toHaveLength(5);
    expect(tracks.every((track) => track.associationMode === 'frequency-local')).toBe(true);
  });

  it('does not refresh a multi-component association from later single-line sweeps', () => {
    const frequencyHz = Array.from({ length: 501 }, (_, index) => index * 1_000);
    const multiPower = frequencyHz.map((frequency) => [200_000, 225_000, 250_000, 275_000, 300_000].some((center) => Math.abs(frequency - center) <= 1_000) ? -42 : -110);
    const singlePower = frequencyHz.map((frequency) => Math.abs(frequency - 250_000) <= 1_000 ? -42 : -110);
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const first = makeSweep({
      id: 'multi-first', sequence: 1, capturedAt: '2026-01-01T00:00:00.001Z',
      frequencyHz, powerDbm: multiPower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000,
    });
    let tracks = tracker.update(first, detector.analyze(first));
    const retainedId = tracks.find((track) => track.startHz === 249_000)!.id;
    expect(observableAssociationEvidenceIsCurrentlyQualified(tracks.find((track) => track.id === retainedId)!)).toBe(true);
    const evidenceSweeps = [first];
    for (let index = 2; index <= 3; index++) {
      const sweep = makeSweep({
        id: `single-${index}`, sequence: index,
        capturedAt: `2026-01-01T00:00:00.00${index}Z`,
        frequencyHz, powerDbm: singlePower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000,
      });
      evidenceSweeps.push(sweep);
      tracks = tracker.update(sweep, detector.analyze(sweep));
      const stale = tracks.find((track) => track.id === retainedId)!;
      expect(stale.associationMissedSweeps).toBe(index - 1);
      expect(observableAssociationEvidenceIsCurrentlyQualified(stale)).toBe(false);
      expect(() => extractObservableFeatures(stale, { sweeps: evidenceSweeps }))
        .toThrow(/coherent complete scalar sweep/);
    }
    const retained = tracks.find((track) => track.id === retainedId)!;

    expect(retained.associationMode).toBe('regular-spectral-component-activity');
    expect(retained.associationRegionSweepIds).toEqual([first.id]);
    expect(retained.associationMissedSweeps).toBe(2);

    const refreshedSweep = makeSweep({
      id: 'multi-refreshed', sequence: 4,
      capturedAt: '2026-01-01T00:00:00.004Z',
      frequencyHz, powerDbm: multiPower, actualStartHz: 0, actualStopHz: 500_000, actualRbwHz: 2_000,
    });
    evidenceSweeps.push(refreshedSweep);
    tracks = tracker.update(refreshedSweep, detector.analyze(refreshedSweep));
    const refreshed = tracks.find((track) => track.id === retainedId)!;
    expect(refreshed.associationMissedSweeps).toBe(0);
    expect(observableAssociationEvidenceIsCurrentlyQualified(refreshed)).toBe(true);
    expect(() => extractObservableFeatures(refreshed, { sweeps: evidenceSweeps })).not.toThrow();
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
    const staleV1: DetectedSignal = {
      ...associated,
      associationModelId: 'simultaneous-regular-components-v1',
    };

    expect(() => extractObservableFeatures(malformed, { sweeps: [sweep] }))
      .toThrow(/at least one coherent complete scalar sweep/i);
    expect(() => extractObservableFeatures(staleV1, { sweeps: [sweep] }))
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
    expect(observableAssociationEvidenceIsCurrentlyQualified(missed)).toBe(false);
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
    expect(updated.localClassificationObservations?.map((observation) => observation.sourceSweep.id))
      .toEqual([firstSweep.id, secondSweep.id]);
    expect(updated.localClassificationObservations?.at(-1)?.sourceSweep.powerDbm)
      .toEqual(secondSweep.powerDbm);
  });

  it('shares only immutable retained provenance while isolating mutable tracker output state', () => {
    const config = { ...detectionConfig, minimumConsecutiveSweeps: 1 };
    const detector = new SignalDetector(config);
    const leftTracker = new SignalTracker(config);
    const rightTracker = new SignalTracker(config);
    const leftFirstSweep = makeSeparatedSignalSweep(1);
    const rightFirstSweep = structuredClone(leftFirstSweep);
    const leftCandidates = detector.analyze(leftFirstSweep);
    const rightCandidates = detector.analyze(rightFirstSweep);
    const leftFirst = leftTracker.update(leftFirstSweep, leftCandidates);
    const rightFirst = rightTracker.update(rightFirstSweep, rightCandidates);

    expect(JSON.stringify(leftFirst)).toBe(JSON.stringify(rightFirst));
    expect(leftFirst).toHaveLength(2);
    const firstSourceSweeps = leftFirst.map((track) =>
      track.localClassificationObservations![0]!.sourceSweep);
    expect(new Set(firstSourceSweeps).size).toBe(1);
    expect(firstSourceSweeps[0]).not.toBe(
      leftCandidates[0]!.classificationRegionObservation!.sourceSweep,
    );
    expect(Object.isFrozen(leftFirst[0]!.localClassificationObservations)).toBe(true);
    expect(Object.isFrozen(leftFirst[0]!.localClassificationObservations![0])).toBe(true);
    expect(Object.isFrozen(
      leftFirst[0]!.localClassificationObservations![0]!.localBayesianEvidence,
    )).toBe(true);
    expect(Object.isFrozen(firstSourceSweeps[0])).toBe(true);

    const retainedPower = firstSourceSweeps[0]!.powerDbm[20];
    (leftFirstSweep.powerDbm as number[])[20] = -1;
    expect(firstSourceSweeps[0]!.powerDbm[20]).toBe(retainedPower);
    expect(Reflect.set(firstSourceSweeps[0]!.powerDbm, '20', -1)).toBe(false);

    // Ordinary output state remains a caller-owned copy and cannot alter the
    // next update's internal posterior, configuration, or quality flags.
    leftFirst[0]!.bayesianEvidence.posteriorSignalProbability = 0;
    leftFirst[0]!.detectorConfig.threshold = { strategy: 'absolute', levelDbm: -1 };
    (leftFirst[0]!.qualityFlags as DetectedSignal['qualityFlags'][number][]).push('single-bin');
    leftFirst[0]!.localClassificationObservations = [];

    const leftSecondSweep = makeSeparatedSignalSweep(2);
    const rightSecondSweep = structuredClone(leftSecondSweep);
    const leftSecond = leftTracker.update(leftSecondSweep, detector.analyze(leftSecondSweep));
    const rightSecond = rightTracker.update(rightSecondSweep, detector.analyze(rightSecondSweep));
    expect(JSON.stringify(leftSecond)).toBe(JSON.stringify(rightSecond));

    const retainedSources = leftSecond.flatMap((track) =>
      track.localClassificationObservations!.map((observation) => observation.sourceSweep));
    expect(retainedSources).toHaveLength(4);
    expect(new Set(retainedSources).size).toBe(2);
    expect(retainedSources.filter((sourceSweep) => sourceSweep.id === leftFirstSweep.id)[0])
      .toBe(firstSourceSweeps[0]);
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
      modelId: 'bayesian-frequency-agile-transition-v3',
      positiveObservationCount: 8,
      transitionCount: 7,
      changedTransitionCount: 7,
      uniqueResolutionCellCount: 8,
      posteriorAgileDynamicsProbability: expect.any(Number),
    });
    expect(activity.associationBayesianEvidence!.posteriorAgileDynamicsProbability).toBeGreaterThanOrEqual(0.99);
    expect(activity.bayesianEvidence.looks).toBe(1);
    expect(activity.bayesianEvidence.posteriorScope).toBe('selected-local-region');
    const activeInputIds = tracks
      .filter((track) => track.state === 'active')
      .sort((left, right) => classificationRepresentativeKey(left).localeCompare(
        classificationRepresentativeKey(right),
      ))
      .map((track) => track.id);
    expect(classificationRepresentatives(tracks.filter((track) => track.state === 'active')).map((track) => track.id))
      .toEqual(activeInputIds);
    expect(extractObservableFeatures(activity, { sweeps })).toMatchObject({
      associationEvidenceQualification: 'provenance-bound-current-promotion',
      limitations: expect.arrayContaining(['frequency-agile-band-activity-association']),
    });
  });

  it('admits sub-25 ms cadence only for the exact SignalLab simulation provenance contract', () => {
    const signalLabPrevious = signalLabCadenceContractSweep(1);
    const signalLabCandidate = signalLabCadenceContractSweep(2);
    expect(frequencyAgileSequentialOpportunity(signalLabPrevious, signalLabCandidate)).toBe(true);

    const fastPhysicalPrevious = {
      ...agileSweep(1, 2_402_000_000, 84_000_000),
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 1).toISOString(),
    };
    const fastPhysicalCandidate = {
      ...agileSweep(2, 2_410_000_000, 84_000_000),
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 2).toISOString(),
    };
    expect(frequencyAgileSequentialOpportunity(fastPhysicalPrevious, fastPhysicalCandidate)).toBe(false);
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
    expect(observableAssociationEvidenceIsCurrentlyQualified(tracks.find((track) => track.id === activityId)!)).toBe(true);
    let finalObservedPosterior = initialPosterior;
    let retainedBelowClassifierGate = false;
    for (let sequence = 9; sequence <= 68; sequence++) {
      const stationary = agileSweep(sequence, 2_440_000_000, 84_000_000);
      tracks = tracker.update(stationary, detector.analyze(stationary));
      const activity = tracks.find((track) => track.id === activityId);
      if (!activity) break;
      finalObservedPosterior = activity.associationBayesianEvidence!.posteriorAgileDynamicsProbability;
      if (!observableAssociationEvidenceIsCurrentlyQualified(activity)) retainedBelowClassifierGate = true;
    }

    expect(finalObservedPosterior).toBeLessThan(initialPosterior);
    expect(retainedBelowClassifierGate).toBe(true);
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

  it('keeps agile opportunity replay independent of stale regional track provenance', () => {
    const config: SignalDetectionConfig = { ...detectionConfig, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 };
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const initial = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((value, index) => agileSweep(index + 1, value * 1_000_000, 84_000_000));
    let tracks: readonly DetectedSignal[] = [];
    for (const sweep of initial) tracks = tracker.update(sweep, detector.analyze(sweep));

    const regionCentersHz = [2_410_000_000, 2_420_000_000, 2_430_000_000, 2_440_000_000];
    const regional = emsoSweep(2_441_000_000, 84_000_000, 9, (frequency) =>
      regionCentersHz.some((center) => Math.abs(frequency - center) <= 300_000) ? -45 : -110);
    const regionalCandidates = detector.analyze(regional);
    expect(regionalCandidates).toHaveLength(4);
    tracks = tracker.update(regional, regionalCandidates);
    expect(tracks.filter((track) => track.associationMode === 'multicomponent-swept-region-activity'))
      .toHaveLength(4);

    const exact = agileSweep(10, regionCentersHz[1]!, 84_000_000);
    expect(detector.analyze(exact)).toHaveLength(1);
    tracks = tracker.update(exact, detector.analyze(exact));
    const retainedRegionalTrack = tracks.find((track) =>
      track.associationMode === 'multicomponent-swept-region-activity'
      && track.missedSweeps === 0)!;
    expect(retainedRegionalTrack.associationMissedSweeps).toBe(1);

    const activity = tracks.find((track) => track.associationMode === 'frequency-agile-2g4-activity')!;
    expect(activity.associationOpportunities?.at(-1)).toEqual({
      sweepId: exact.id,
      outcome: 'exactly-one',
    });
    expect(activity.associationObservations?.at(-1)?.sweepId).toBe(exact.id);
    expect(() => extractObservableFeatures(activity, {
      sweeps: [...initial, regional, exact],
    })).not.toThrow();
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
      requested: admittedDetectedPower(433_920_000, 256, 0.256, 100),
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
    expect(SIGNAL_LAB_EMSO_MODEL).toMatchObject({
      id: 'bayesian-observable-equivalence-v9', producer: 'tinysa-signal-lab', observableClassCount: 12,
      preprocessing: 'scalar-observable-features-v7', priorId: 'engineering-design-class-weights-v1',
    });
    expect(SIGNAL_LAB_EMSO_MODEL).not.toHaveProperty('taxonomySize');
    expect(SIGNAL_LAB_EMSO_MODEL).not.toHaveProperty('legacyProfileTaxonomySize');
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => {
      const offset = frequency - 98_000_000;
      return Math.max(-110 + 0.35 * Math.sin(frequency / 71_000 + index), -48 - 4.3429 * (offset / 3_000) ** 2);
    }));
    const detection = emsoDetection('cw-observed', 98_000_000, 20_000, sweeps);
    const result = await new SignalLabBayesianClassifier().classify(detection, { sweeps });
    expect(result).toMatchObject({
      label: 'unknown', decisionLevel: 'unknown', qualification: 'bayesian-observable-equivalence', scoreKind: 'model-posterior',
      modelId: 'bayesian-observable-equivalence-v9',
      unknownReason: 'out-of-domain', decisionSupport: { kind: 'synthetic-support-rank' },
    });
    expect(result.decisionSupport!.threshold).toBeDefined();
    expect(result.decisionSupport!.value).toBeLessThan(result.decisionSupport!.threshold!);
    expect(result.candidates[0]).toMatchObject({ label: 'observable:cw-like' });
    expect(result.modelProvenance).toMatchObject({ producer: 'tinysa-signal-lab', sourceCommit: SIGNAL_LAB_EMSO_MODEL.sourceCommit });
    expect(result.modelProvenance?.corpusSha256).toBe(SIGNAL_LAB_EMSO_MODEL.corpusSha256);
    expect(result.modelProvenance).not.toHaveProperty('catalogSha256');
    expect(result.modelProvenance).not.toHaveProperty('generatorSha256');
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
      decisionSupport: { kind: 'synthetic-support-rank' },
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
    expect(() => extractObservableFeatures(detection, {
      sweeps: [...sweeps.slice(0, 7), sweeps[9]!],
    })).toThrow(/coherent complete scalar sweep/);
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

  it('retains an exact oldest-to-newest admission ledger aligned with the bounded track history', () => {
    const sweeps = Array.from({ length: 70 }, (_, index) => emsoSweep(
      98_000_000,
      2_000_000,
      index + 1,
      (frequency) => Math.abs(frequency - 98_000_000) <= 10_000 ? -45 : -110,
    ));
    const detection = emsoDetection('bounded-exact-ledger', 98_000_000, 20_000, sweeps);
    const retainedSweeps = sweeps.slice(-64);

    expect(detection.sweepIds).toEqual(retainedSweeps.map((sweep) => sweep.id));
    expect(detection.localClassificationObservations).toHaveLength(64);
    expect(detection.localClassificationObservations?.map((observation) => observation.sourceSweep.id))
      .toEqual(detection.sweepIds);
    expect(detection.localClassificationObservations?.map((observation) => observation.sourceSweep.sequence))
      .toEqual(retainedSweeps.map((sweep) => sweep.sequence));
    expect(detection.classificationRegionObservation?.sourceSweep.id).toBe(sweeps[0]!.id);
    expect(detection.sweepIds).not.toContain(sweeps[0]!.id);
    expect(() => extractObservableFeatures(detection, { sweeps: retainedSweeps.slice(-8) })).not.toThrow();
  });

  it('treats a causally valid gradual track drift beyond the frozen ROI as typed insufficient evidence', () => {
    const centerHz = 98_000_000;
    const sweeps = Array.from({ length: 8 }, (_, index) => {
      const activeCenterHz = centerHz + index * 10_000;
      return emsoSweep(centerHz, 2_000_000, index + 1, (frequency) =>
        Math.abs(frequency - activeCenterHz) <= 10_000 ? -45 : -110);
    });
    const detection = emsoDetection('gradual-roi-drift', centerHz + 70_000, 20_000, sweeps);

    expect(detection.localClassificationObservations).toHaveLength(8);
    expect(detection.localClassificationObservations?.map((observation) => observation.peakHz))
      .toEqual(sweeps.map((_sweep, index) => centerHz - 10_000 + index * 10_000));
    expect(detection.peakHz).toBeGreaterThan(detection.classificationRegionStopHz!);
    expect(() => extractObservableFeatures(detection, { sweeps }))
      .toThrow(ObservableEvidenceUnavailableError);
    try {
      extractObservableFeatures(detection, { sweeps });
      throw new Error('Expected gradual drift to be typed unavailable');
    } catch (error) {
      expect(error).toMatchObject({ code: 'local-history-not-uniquely-replayable' });
    }
  });

  it('rejects an exact but unrelated detector candidate substituted into the admission ledger', () => {
    const centerHz = 98_000_000;
    const leftHz = centerHz - 400_000;
    const rightHz = centerHz + 400_000;
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(centerHz, 2_000_000, index + 1, (frequency) =>
      Math.abs(frequency - leftHz) <= 10_000 || Math.abs(frequency - rightHz) <= 10_000 ? -45 : -110));
    const detection = emsoDetection('unrelated-ledger-substitution', leftHz, 20_000, sweeps);
    const substitutionIndex = 4;
    const unrelated = new SignalDetector(detection.detectorConfig).analyze(sweeps[substitutionIndex]!)
      .find((candidate) => candidate.peakHz > centerHz)!;
    expect(unrelated.classificationRegionObservation).toBeDefined();
    const tampered: DetectedSignal = {
      ...detection,
      localClassificationObservations: detection.localClassificationObservations?.map((observation, index) =>
        index === substitutionIndex ? unrelated.classificationRegionObservation! : observation),
    };

    expect(() => extractObservableFeatures(tampered, { sweeps }))
      .toThrow(/unrelated local-history admission/);
  });

  it('rejects mutated Bayesian evidence in an otherwise aligned exact admission ledger', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.abs(frequency - 98_000_000) <= 10_000 ? -45 : -110));
    const detection = emsoDetection('mutated-ledger-evidence', 98_000_000, 20_000, sweeps);
    const mutationIndex = 3;
    const tampered: DetectedSignal = {
      ...detection,
      localClassificationObservations: detection.localClassificationObservations?.map((observation, index) =>
        index === mutationIndex
          ? {
              ...observation,
              localBayesianEvidence: {
                ...observation.localBayesianEvidence,
                posteriorPredictiveNullProbability:
                  observation.localBayesianEvidence.posteriorPredictiveNullProbability / 2,
              },
            }
          : observation),
    };

    expect(() => extractObservableFeatures(tampered, { sweeps }))
      .toThrow(/without its exact claimed detector admission/);
  });

  it('rejects duplicated sweep objects as independent classifier admissions', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('duplicate-evidence', 98_000_000, 20_000, sweeps);
    expect(() => extractObservableFeatures(detection, { sweeps: [...sweeps, sweeps[0]!] }))
      .toThrow(/duplicate evidence sweep IDs/i);
  });

  it('rejects raw-power substitution for the local detector sweep that froze the classification region', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('substituted-origin', 98_000_000, 20_000, sweeps);
    expect(() => extractObservableFeatures(detection, { sweeps })).not.toThrow();
    const substitutedOrigin: Sweep = {
      ...sweeps[0]!,
      powerDbm: sweeps[0]!.powerDbm.map(() => -110),
    };
    expect(new SignalDetector(detection.detectorConfig).analyze(substitutedOrigin)).toEqual([]);
    expect(() => extractObservableFeatures(detection, {
      sweeps: [substitutedOrigin, ...sweeps.slice(1)],
    })).toThrow(/coherent complete scalar sweep/);
  });

  it('rejects a fabricated all-floor look appended to local classifier history at the runtime boundary', async () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('fabricated-later-look', 98_000_000, 20_000, sweeps);
    const fabricated: Sweep = {
      ...sweeps.at(-1)!,
      id: 'fabricated-all-floor-look',
      sequence: sweeps.at(-1)!.sequence + 1,
      capturedAt: new Date(Date.parse(sweeps.at(-1)!.capturedAt) + 50).toISOString(),
      powerDbm: sweeps.at(-1)!.powerDbm.map(() => -110),
    };
    const tampered: DetectedSignal = {
      ...detection,
      lastSeenAt: fabricated.capturedAt,
      sweepIds: [...detection.sweepIds, fabricated.id],
      persistenceSweeps: detection.persistenceSweeps + 1,
    };

    expect(new SignalDetector(detection.detectorConfig).analyze(fabricated)).toEqual([]);
    expect(() => extractObservableFeatures(tampered, { sweeps: [...sweeps, fabricated] }))
      .toThrow(/local-admission ledger/);
    await expect(new SignalLabBayesianClassifier().classify(tampered, {
      sweeps: [...sweeps, fabricated],
    })).rejects.toThrow();
  });

  it('rejects substituting an ambiguous detector input for a cited exact local admission', async () => {
    const centerHz = 98_000_000;
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(centerHz, 2_000_000, index + 1, (frequency) =>
      Math.abs(frequency - centerHz) <= 100_000 ? -48 : -110));
    const detection = emsoDetection('ambiguous-later-look', centerHz, 200_000, sweeps);
    const ambiguous: Sweep = {
      ...sweeps.at(-1)!,
      powerDbm: sweeps.at(-1)!.frequencyHz.map((frequency) =>
        Math.abs(frequency - (centerHz - 50_000)) <= 15_000
          || Math.abs(frequency - (centerHz + 50_000)) <= 15_000
          ? -48
          : -110),
    };
    const replayed = new SignalDetector(detection.detectorConfig).analyze(ambiguous).filter((candidate) =>
      candidate.peakHz >= detection.classificationRegionStartHz!
      && candidate.peakHz <= detection.classificationRegionStopHz!);

    expect(replayed).toHaveLength(2);
    const evidenceSweeps = [...sweeps.slice(0, -1), ambiguous];
    expect(() => extractObservableFeatures(detection, { sweeps: evidenceSweeps }))
      .toThrow(/substituted detector inputs/);
    await expect(new SignalLabBayesianClassifier().classify(detection, { sweeps: evidenceSweeps }))
      .rejects.toThrow();
  });

  it('rejects replacing the frozen local origin with a valid later detector sweep', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('later-origin-substitution', 98_000_000, 20_000, sweeps);
    const later = new SignalDetector(detection.detectorConfig).analyze(sweeps[1]!)[0]!;
    expect(later.classificationRegionObservation).toBeDefined();
    const substituted: DetectedSignal = {
      ...detection,
      classificationRegionStartHz: later.classificationRegionStartHz,
      classificationRegionStopHz: later.classificationRegionStopHz,
      classificationRegionSweepIds: [sweeps[1]!.id],
      classificationRegionObservation: later.classificationRegionObservation,
    };
    expect(() => extractObservableFeatures(substituted, { sweeps }))
      .toThrow(/coherent complete scalar sweep/);
  });

  it('uses the exact frozen-origin binding without imposing later-look loose uniqueness on that origin', () => {
    const centerHz = 98_000_000;
    const origin = emsoSweep(centerHz, 2_000_000, 1, (frequency) => {
      if (frequency >= centerHz - 300_000 && frequency <= centerHz) {
        return -48 - Math.abs(frequency - (centerHz - 150_000)) / 100_000;
      }
      return Math.abs(frequency - (centerHz + 50_000)) <= 25_000 ? -47 : -110;
    });
    const later = Array.from({ length: 7 }, (_, index) => emsoSweep(
      centerHz,
      2_000_000,
      index + 2,
      (frequency) => frequency >= centerHz - 300_000 && frequency <= centerHz
        ? -48 - Math.abs(frequency - (centerHz - 150_000)) / 100_000
        : -110,
    ));
    const detector = new SignalDetector({
      threshold: { strategy: 'noise-relative', marginDb: 10 },
      minimumBandwidthHz: 0,
      minimumProminenceDb: 6,
      minimumConsecutiveSweeps: 2,
      releaseAfterMissedSweeps: 2,
    });
    const originCandidates = detector.analyze(origin);
    expect(originCandidates).toHaveLength(2);
    const intendedOrigin = [...originCandidates].sort((left, right) => right.bandwidthHz - left.bandwidthHz)[0]!;
    const sweeps = [origin, ...later];
    const detection = emsoDetection('exactly-bound-ambiguous-origin', intendedOrigin.peakHz, intendedOrigin.bandwidthHz, sweeps);
    const frozen = detection.classificationRegionObservation!;
    const looselyCompatibleOriginCandidates = originCandidates.filter((candidate) => {
      const overlapHz = Math.max(0, Math.min(frozen.stopHz, candidate.stopHz)
        - Math.max(frozen.startHz, candidate.startHz));
      const centerDistanceHz = Math.abs(frozen.peakHz - candidate.peakHz);
      return overlapHz > 0 || centerDistanceHz <= Math.max(
        origin.actualRbwHz * 3,
        frozen.stopHz - frozen.startHz,
        candidate.bandwidthHz,
        1,
      );
    });

    expect(detection.sweepIds).toHaveLength(8);
    expect(looselyCompatibleOriginCandidates).toHaveLength(2);
    expect(() => extractObservableFeatures(detection, { sweeps })).not.toThrow();
  });

  it('still binds a one-look frozen origin to the public current-track fields', () => {
    const sweep = emsoSweep(98_000_000, 2_000_000, 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000));
    const detection = emsoDetection('one-look-current-origin', 98_000_000, 20_000, [sweep]);
    expect(() => extractObservableFeatures(detection, { sweeps: [sweep] })).not.toThrow();
    expect(() => extractObservableFeatures({
      ...detection,
      missedSweeps: detection.missedSweeps + 1,
    }, { sweeps: [sweep] })).toThrow(/contradicts the current track state/);
  });

  it('binds the newest admitted local evidence sweep to the track last-seen timestamp', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('last-seen-binding', 98_000_000, 20_000, sweeps);
    expect(() => extractObservableFeatures(detection, { sweeps })).not.toThrow();
    for (const lastSeenAt of [sweeps[0]!.capturedAt, '2099-01-01T00:00:00.000Z']) {
      expect(() => extractObservableFeatures({ ...detection, lastSeenAt }, { sweeps }))
        .toThrow(/coherent complete scalar sweep/);
    }
  });

  it('rejects cloned local admissions with a new ID but duplicate sequence or capture time', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
      Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('duplicate-causal-admission', 98_000_000, 20_000, sweeps);
    const duplicateSequence: Sweep = { ...sweeps[0]!, id: 'cloned-sequence' };
    expect(() => extractObservableFeatures({
      ...detection,
      sweepIds: [...detection.sweepIds, duplicateSequence.id],
    }, { sweeps: [...sweeps, duplicateSequence] })).toThrow(/coherent complete scalar sweep/);

    const duplicateTime: Sweep = {
      ...sweeps.at(-1)!,
      id: 'cloned-capture-time',
      sequence: sweeps.at(-1)!.sequence + 1,
    };
    expect(() => extractObservableFeatures({
      ...detection,
      sweepIds: [...detection.sweepIds, duplicateTime.id],
    }, { sweeps: [...sweeps, duplicateTime] })).toThrow(/coherent complete scalar sweep/);

    for (const malformed of [
      { ...sweeps[2]!, capturedAt: 'not-an-instant' },
      { ...sweeps[2]!, sequence: Number.NaN },
      { ...sweeps[2]!, sequence: 2.5 },
    ]) {
      expect(() => extractObservableFeatures(detection, {
        sweeps: sweeps.map((sweep) => sweep.id === malformed.id ? malformed : sweep),
      })).toThrow(/timestamp|sequence/i);
    }
    expect(() => extractObservableFeatures({
      ...detection,
      sweepIds: [...detection.sweepIds].reverse(),
    }, { sweeps })).toThrow(/coherent complete scalar sweep/);
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

  it('keeps the feature ROI frozen but rejects current geometry detached from the newest detector look', () => {
    const centerHz = 98_000_000;
    const sweeps = Array.from({ length: 3 }, (_, index) => emsoSweep(centerHz, 2_000_000, index + 20, (frequency) => {
      const offset = frequency - centerHz;
      return Math.max(-110 + 0.2 * Math.sin(frequency / 31_000 + index), -52 - Math.abs(offset) / 4_000);
    }));
    const base = emsoDetection('frozen-region', centerHz, 80_000, sweeps);
    const frozen: DetectedSignal = base;
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

    expect(() => extractObservableFeatures(frozen, { sweeps })).not.toThrow();
    expect(() => extractObservableFeatures(moved, { sweeps }))
      .toThrow(/contradicts the current track state/);
    expect(() => extractObservableFeatures({
      ...frozen,
      bayesianEvidence: {
        ...frozen.bayesianEvidence,
        testedRegionStartHz: frozen.bayesianEvidence.testedRegionStartHz + 1,
      },
    }, { sweeps })).toThrow(/contradicts the current track state/);
  });

  it('rejects zero-span evidence bound to another detection or device provenance', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => {
      return Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000);
    }));
    const detection = emsoDetection('zero-span-owner', 98_000_000, 20_000, sweeps);
    const spectrumObservation = extractObservableFeatures(detection, { sweeps });
    const matchingCapture: ZeroSpanCapture = {
      kind: 'zero-span', id: 'bound-zero-span', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 10,
      frequencyHz: 98_000_000, samplePeriodSeconds: 0.0001,
      targetDetectionId: detection.id,
      powerDbm: Array.from({ length: 100 }, (_, index) => index % 10 < 4 ? -45 : -90),
      requested: admittedDetectedPower(98_000_000, 100, 0.01, 20),
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
    const receipt = createDetectedPowerCaptureReceipt({
      activeSignals: [detection],
      evidenceSweeps: sweeps,
      capture: matchingCapture,
      admittedTargetTuneHz: matchingCapture.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    });

    for (const zeroSpan of mismatchedCaptures) {
      expect(() => extractObservableFeatures(detection, {
        sweeps,
        zeroSpan,
        zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
        detectedPowerCaptureReceipt: receipt,
      })).toThrow(/different or mutated capture/i);
    }
  });

  it('binds live zero-span evidence to the exact newest-first eight-sweep window', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) =>
      emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
        Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('live-window-owner', 98_000_000, 20_000, sweeps);
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'live-window-zs', sequence: 9,
      capturedAt: '2026-01-01T00:00:01.000Z', elapsedMilliseconds: 50,
      frequencyHz: detection.peakHz, samplePeriodSeconds: 0.05 / 449,
      targetDetectionId: detection.id,
      powerDbm: Array.from({ length: 450 }, (_, index) => index % 10 < 4 ? -45 : -90),
      requested: admittedDetectedPower(detection.peakHz, 450, 0.05, 20),
      actualRbwHz: 20_000, actualAttenuationDb: 0, source: 'scan-text', complete: true,
      identity, timingQualification: 'wall-clock-derived',
    };
    const exactIds = [...sweeps].sort((left, right) => right.sequence - left.sequence).map((sweep) => sweep.id);
    const admitted = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: exactIds,
      detectedPowerCaptureReceipt: createDetectedPowerCaptureReceipt({
        activeSignals: [detection],
        evidenceSweeps: sweeps,
        capture: zeroSpan,
        admittedTargetTuneHz: zeroSpan.frequencyHz,
        spectrumSweepIds: exactIds,
      }),
    });
    expect(admitted.zeroSpanCaptureId).toBe(zeroSpan.id);
    expect(admitted.detectedPowerAcquisitionQualification)
      .toBe('receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5');
    expect(admitted.detectedPowerSelectionCondition)
      .toBe('automatic-current-source-sweep-integrated-excess-rank-0');

    const spectrumOnly = extractObservableFeatures(detection, { sweeps });
    const unqualified = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: exactIds,
    });
    expect(unqualified.values).toEqual(spectrumOnly.values);
    expect(unqualified.views).toEqual(spectrumOnly.views);
    expect(unqualified.zeroSpanCaptureId).toBeUndefined();
    expect(unqualified.detectedPowerAcquisitionQualification).toBeUndefined();
    expect(unqualified.detectedPowerSelectionCondition).toBeUndefined();
    expect(unqualified.limitations).toContain('zero-span-capture-receipt-missing');
    expect(unqualified.limitations).toContain('zero-span-acquisition-policy-unqualified');
    const spectrumCandidates = inferPosterior(spectrumOnly);
    const unqualifiedCandidates = inferPosterior(unqualified);
    expect(unqualifiedCandidates).toEqual(spectrumCandidates);
    const spectrumSupport = knownModelSupportRank(spectrumOnly);
    const unqualifiedSupport = knownModelSupportRank(unqualified);
    expect(unqualifiedSupport).toBe(spectrumSupport);
    expect(selectObservableDecision(unqualifiedCandidates, unqualified, unqualifiedSupport))
      .toEqual(selectObservableDecision(spectrumCandidates, spectrumOnly, spectrumSupport));
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: exactIds,
      detectedPowerAcquisitionPolicyId: 'unreviewed-capture-policy' as typeof SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
    })).toThrow(/unknown detected-power acquisition policy/i);
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: exactIds,
      detectedPowerAcquisitionPolicyId:
        SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
    })).toThrow(/self-attested detected-power acquisition policy/i);

    const exactReceipt = createDetectedPowerCaptureReceipt({
      activeSignals: [detection],
      evidenceSweeps: sweeps,
      capture: zeroSpan,
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: exactIds,
    });
    const rejectedBindings = [
      exactIds.slice(0, 7),
      [exactIds[1]!, exactIds[0]!, ...exactIds.slice(2)],
      [...exactIds.slice(0, 7), 'foreign-sweep'],
      ['stale-sweep', ...exactIds.slice(0, 7)],
    ];
    for (const zeroSpanSpectrumSweepIds of rejectedBindings) {
      expect(() => extractObservableFeatures(detection, {
        sweeps,
        zeroSpan,
        zeroSpanSpectrumSweepIds,
        detectedPowerCaptureReceipt: exactReceipt,
      })).toThrow(/different scalar evidence window/i);
    }
  });

  it('admits only an opaque rank-0 source-integrated snapshot receipt and never substitutes a weaker ready target', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) =>
      emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) =>
        Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('receipt-owner', 98_000_000, 20_000, sweeps);
    const unreadySweeps = Array.from({ length: 2 }, (_, index) =>
      emsoSweep(99_500_000, 500_000, index + 20, (frequency) =>
        Math.max(-110, -25 - Math.abs(frequency - 99_500_000) / 2_000)));
    const unreadyStrongest = emsoDetection(
      'receipt-unready',
      99_500_000,
      20_000,
      unreadySweeps,
    );
    const excludedRetainedMiss: DetectedSignal = {
      ...unreadyStrongest,
      id: 'receipt-retained-miss',
      peakDbm: -5,
      missedSweeps: 1,
    };
    const excludedAgileSummary: DetectedSignal = {
      ...unreadyStrongest,
      id: 'receipt-agile-summary',
      peakDbm: -1,
      associationMode: 'frequency-agile-2g4-activity',
      associationId: 'receipt-agile-association',
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationRegionStartHz: 2_402_000_000,
      associationRegionStopHz: 2_480_000_000,
      associationRegionSweepIds: unreadyStrongest.sweepIds,
      associationMemberTrackIds: [unreadyStrongest.id],
      associationMissedSweeps: 0,
    };
    const receiptInputSignals = [
      detection,
      unreadyStrongest,
      excludedRetainedMiss,
      excludedAgileSummary,
    ];
    const receiptEligibleSignals = [
      detection,
      excludedRetainedMiss,
      excludedAgileSummary,
    ];
    const spectrumObservation = extractObservableFeatures(detection, { sweeps });
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span',
      id: 'receipt-bound-capture',
      sequence: 9,
      capturedAt: '2026-01-01T00:00:09.000Z',
      elapsedMilliseconds: 50,
      frequencyHz: detection.peakHz,
      samplePeriodSeconds: 0.05 / 449,
      targetDetectionId: detection.id,
      powerDbm: Array.from(
        { length: 450 },
        (_, index) => index % 10 < 4 ? -45 : -90,
      ),
      requested: admittedDetectedPower(detection.peakHz, 450, 0.05, 20),
      actualRbwHz: 20_000,
      actualAttenuationDb: 0,
      source: 'scan-text',
      complete: true,
      identity,
      timingQualification: 'simulation-exact',
    };
    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: receiptInputSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      capture: zeroSpan,
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/rank-0 automatic target; lower-ranked targets are never substituted/i);
    const receipt = createDetectedPowerCaptureReceipt({
      activeSignals: receiptEligibleSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      capture: zeroSpan,
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    });

    expect(receipt.schemaVersion).toBe(4);
    expect(receipt.selection).toEqual({
      mode: 'integrated-excess-current',
      rawTargetId: detection.id,
      projectedRepresentativeId: detection.id,
    });
    expect(receipt.candidates.map((candidate) => candidate.rawTargetId))
      .toEqual([detection.id]);
    expect(receipt.candidates.map((candidate) => candidate.inputOrdinal))
      .toEqual([0]);
    expect(receipt.candidates.map((candidate) => candidate.projectionKind))
      .toEqual(['current-active-physical-representative']);
    expect(receipt.candidates[0]!.runtimeAdmission).toEqual({
      status: 'admitted',
      spectrumSweepIds: spectrumObservation.sweepIds,
    });
    expect(receipt.candidates[0]).toMatchObject({
      currentSourceSweepId: detection.sweepIds.at(-1),
      currentSupportStartHz: detection.startHz,
      currentSupportStopHz: detection.stopHz,
    });
    expect(receipt.candidates[0]!.currentSupportCellCount).toBeGreaterThanOrEqual(1);
    expect(receipt.candidates[0]!.currentActualRbwHz).toBeGreaterThan(0);
    expect(receipt.candidates[0]!.currentIntegratedExcessPowerMw).toBeGreaterThan(0);
    expect(receipt.capture).toMatchObject({
      id: zeroSpan.id,
      targetDetectionId: detection.id,
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      frequencyHz: zeroSpan.frequencyHz,
      requestedCenterHz: zeroSpan.requested.centerHz,
      payloadBinding: {
        algorithm: 'sha256',
        canonicalization: 'zero-span-capture-canonical-json-v1',
        sha256: createHash('sha256')
          .update(`tinysa-detected-power-capture-payload-v1\0${canonicalDetectedPowerCapturePayload(zeroSpan)}`)
          .digest('hex'),
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.candidates)).toBe(true);
    expect(Object.isFrozen(receipt.candidates[0])).toBe(true);
    expect(Object.isFrozen(receipt.candidates[0]!.runtimeAdmission)).toBe(true);

    const callerOwnedEqualCapture = structuredClone(zeroSpan);
    const authorityOwnedSnapshot = assertDetectedPowerCaptureReceiptMatches({
      receipt,
      detection,
      capture: callerOwnedEqualCapture,
      spectrumSweepIds: spectrumObservation.sweepIds,
    });
    expect(authorityOwnedSnapshot).not.toBe(zeroSpan);
    expect(authorityOwnedSnapshot).not.toBe(callerOwnedEqualCapture);
    expect(authorityOwnedSnapshot).toEqual(zeroSpan);
    expect(Object.isFrozen(authorityOwnedSnapshot)).toBe(true);
    expect(Object.isFrozen(authorityOwnedSnapshot.powerDbm)).toBe(true);
    expect(Object.isFrozen(authorityOwnedSnapshot.requested)).toBe(true);

    const admitted = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    });
    expect(admitted.zeroSpanCaptureId).toBe(zeroSpan.id);
    expect(admitted.detectedPowerAcquisitionQualification)
      .toBe('receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5');
    expect(admitted.detectedPowerSelectionCondition)
      .toBe('automatic-current-source-sweep-integrated-excess-rank-0');

    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: receiptEligibleSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      capture: zeroSpan,
      admittedTargetTuneHz: zeroSpan.frequencyHz + 1,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/does not match controller-admitted target tune/i);

    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: receiptInputSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      preferredDetectionId: unreadyStrongest.id,
      capture: { ...zeroSpan, targetDetectionId: unreadyStrongest.id },
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/cannot runtime-admit preferred tracker target/i);

    const tamperedReceipt = structuredClone(receipt);
    (tamperedReceipt.candidates[0] as { currentPeakDbm: number }).currentPeakDbm -= 1;
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: tamperedReceipt,
    })).toThrow(/not issued by the analysis selection boundary/i);

    expect(() => extractObservableFeatures({
      ...detection,
      id: 'member-substituted-detection',
    }, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/different or mutated representative|member substitution/i);

    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan: {
        ...zeroSpan,
        frequencyHz: zeroSpan.frequencyHz + 1,
        requested: {
          ...zeroSpan.requested,
          centerHz: zeroSpan.requested.centerHz + 1,
        },
      },
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/different or mutated capture/i);

    const finiteSampleSubstitution: ZeroSpanCapture = {
      ...zeroSpan,
      powerDbm: zeroSpan.powerDbm.map((value, index) =>
        index === 17 ? value + 0.125 : value),
    };
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan: finiteSampleSubstitution,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/canonical payload digest.*samples/i);

    for (const classificationRelevantPayloadSubstitution of [
      {
        ...zeroSpan,
        samplePeriodSeconds: zeroSpan.samplePeriodSeconds + 1e-9,
      },
      {
        ...zeroSpan,
        timingQualification: 'measured-calibrated' as const,
      },
      {
        ...zeroSpan,
        requested: {
          ...zeroSpan.requested,
          sweepTimeSeconds: zeroSpan.requested.sweepTimeSeconds + 1e-6,
        },
      },
      {
        ...zeroSpan,
        requested: {
          ...zeroSpan.requested,
          sampleCount: zeroSpan.requested.sampleCount + 1,
        },
      },
      {
        ...zeroSpan,
        requested: {
          ...zeroSpan.requested,
          controls: zeroSpan.requested.controls.model === 'receiver'
            ? {
              ...zeroSpan.requested.controls,
              resolutionBandwidthKhz: 21 as const,
            }
            : zeroSpan.requested.controls,
        },
      },
      {
        ...zeroSpan,
        actualRbwHz: zeroSpan.actualRbwHz! + 1,
      },
      {
        ...zeroSpan,
        actualAttenuationDb: zeroSpan.actualAttenuationDb! + 1,
      },
      {
        ...zeroSpan,
        resolutionBandwidthQualification: 'device-observed' as const,
      },
      {
        ...zeroSpan,
        elapsedMilliseconds: zeroSpan.elapsedMilliseconds + 1,
      },
      {
        ...zeroSpan,
        source: 'renode-executable-state' as const,
      },
      {
        ...zeroSpan,
        identity: {
          ...identity,
          port: { ...identity.port, path: 'simulator://same-key-different-provenance' },
        },
      },
    ] satisfies readonly ZeroSpanCapture[]) {
      expect(() => extractObservableFeatures(detection, {
        sweeps,
        zeroSpan: classificationRelevantPayloadSubstitution,
        zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
        detectedPowerCaptureReceipt: receipt,
      })).toThrow(/canonical payload digest.*cadence.*geometry|requested sample count/i);
    }

    const proxySamples = new Proxy([...zeroSpan.powerDbm], {
      get(target, property, receiver) {
        if (property === '17') return target[17]! + 6;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const proxyCaptures: readonly ZeroSpanCapture[] = [
      new Proxy(zeroSpan, {
        get(target, property, receiver) {
          return Reflect.get(target, property, receiver);
        },
      }),
      { ...zeroSpan, powerDbm: proxySamples },
      {
        ...zeroSpan,
        requested: new Proxy(zeroSpan.requested, {
          get(target, property, receiver) {
            return Reflect.get(target, property, receiver);
          },
        }),
      },
    ];
    for (const proxyCapture of proxyCaptures) {
      expect(() => extractObservableFeatures(detection, {
        sweeps,
        zeroSpan: proxyCapture,
        zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
        detectedPowerCaptureReceipt: receipt,
      })).toThrow(/plain cloneable capture snapshot.*Proxy/i);
    }
    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: receiptInputSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      capture: new Proxy(zeroSpan, {}),
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/plain cloneable capture snapshot.*Proxy/i);

    class AdversarialPowerArray extends Array<number> {}
    const arraySubclassCapture: ZeroSpanCapture = {
      ...zeroSpan,
      powerDbm: AdversarialPowerArray.from(zeroSpan.powerDbm),
    };
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan: arraySubclassCapture,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/Array subclass/i);
    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: receiptInputSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      capture: arraySubclassCapture,
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/Array subclass/i);

    const nonEnumerableRequiredField = { ...zeroSpan };
    Object.defineProperty(nonEnumerableRequiredField, 'samplePeriodSeconds', {
      value: zeroSpan.samplePeriodSeconds,
      enumerable: false,
      configurable: true,
    });
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan: nonEnumerableRequiredField,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/enumerable own data property/i);

    const { powerDbm: _omittedPowerDbm, ...missingRequiredField } = zeroSpan;
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan: missingRequiredField as ZeroSpanCapture,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/exact enumerable own typed fields.*powerDbm/i);

    const nestedNonEnumerableRequested = { ...zeroSpan.requested };
    Object.defineProperty(nestedNonEnumerableRequested, 'centerHz', {
      value: zeroSpan.requested.centerHz,
      enumerable: false,
      configurable: true,
    });
    expect(() => extractObservableFeatures(detection, {
      sweeps,
      zeroSpan: { ...zeroSpan, requested: nestedNonEnumerableRequested },
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: receipt,
    })).toThrow(/enumerable own data property/i);

    expect(() => createDetectedPowerCaptureReceipt({
      activeSignals: receiptInputSignals,
      evidenceSweeps: [...sweeps, ...unreadySweeps],
      capture: {
        ...zeroSpan,
        powerDbm: zeroSpan.powerDbm.map((value, index) =>
          index === 0 ? Number.NaN : value),
      },
      admittedTargetTuneHz: zeroSpan.frequencyHz,
      spectrumSweepIds: spectrumObservation.sweepIds,
    })).toThrow(/finite samples.*powerDbm\[0\]/i);
  });

  it('rejects forged or internally inconsistent detected-power model observations', () => {
    const scalarObservation = {
      values: {},
      limitations: ['sweep-time-frequency-skew'] as const,
      occupiedStartHz: 97_990_000,
      occupiedStopHz: 98_010_000,
      centerHz: 98_000_000,
      bandwidthHz: 20_000,
      binWidthHz: 5_000,
      sweepIds: Array.from({ length: 8 }, (_, index) => `policy-invariant-${index}`),
      views: ['scalar-spectrum'] as const,
    };
    expect(() => inferPosterior({
      ...scalarObservation,
      values: { 'envelope.rangeDb': 20 },
    })).toThrow(/not acquisition-policy qualified/i);
    expect(() => knownModelSupportRank({
      ...scalarObservation,
      views: ['scalar-spectrum', 'detected-power-envelope'],
    })).toThrow(/not acquisition-policy qualified/i);
    expect(() => selectObservableDecision([], {
      ...scalarObservation,
      zeroSpanCaptureId: 'forged-capture',
    }, 1)).toThrow(/not acquisition-policy qualified/i);
    expect(() => knownModelSupportRank({
      ...scalarObservation,
      detectedPowerAcquisitionQualification:
        'receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5',
    })).toThrow(/qualification and target-selection condition must be paired/i);
    expect(() => knownModelSupportRank({
      ...scalarObservation,
      detectedPowerAcquisitionQualification:
        'unreviewed-envelope-qualification' as 'receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5',
    })).toThrow(/unknown acquisition qualification/i);
    expect(() => knownModelSupportRank({
      ...scalarObservation,
      values: { 'envelope.logTransitionRateHz': Number.NaN },
      views: ['scalar-spectrum', 'detected-power-envelope'],
      zeroSpanCaptureId: 'non-finite-envelope',
      detectedPowerAcquisitionQualification:
        'receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5',
      detectedPowerSelectionCondition: DETECTED_POWER_AUTOMATIC_SELECTION_CONDITION,
    })).toThrow(/contradicts its envelope evidence/i);
  });

  it('rejects admitted sweeps with mismatched frequency grids or analyzer configuration', () => {
    const coherent = Array.from({ length: 3 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 10, (frequency) => {
      return Math.max(-110, -48 - Math.abs(frequency - 98_000_000) / 2_000);
    }));
    const baselineDetection = emsoDetection('coherent-grid', 98_000_000, 20_000, coherent);
    const baseline = extractObservableFeatures(baselineDetection, { sweeps: coherent });
    const gridMismatch: Sweep = {
      ...coherent[0]!,
      id: 'grid-mismatch',
      sequence: 2,
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 2 * 50).toISOString(),
      frequencyHz: coherent[0]!.frequencyHz.map((frequency, index) => index === 200 ? frequency + 1 : frequency),
    };
    const configMismatch: Sweep = {
      ...coherent[1]!,
      id: 'config-mismatch',
      sequence: 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 1 * 50).toISOString(),
      requested: {
        ...coherent[1]!.requested,
        controls: coherent[1]!.requested.controls.model === 'receiver'
          ? { ...coherent[1]!.requested.controls, detector: 'average' }
          : coherent[1]!.requested.controls,
      },
    };
    const sweepTimeMismatch: Sweep = {
      ...coherent[2]!,
      id: 'sweep-time-mismatch',
      sequence: 3,
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 3 * 50).toISOString(),
      requested: { ...coherent[2]!.requested, sweepTimeSeconds: 1 },
    };
    const detection: DetectedSignal = {
      ...baselineDetection,
      sweepIds: [...baselineDetection.sweepIds, gridMismatch.id, configMismatch.id, sweepTimeMismatch.id],
    };

    expect(baseline.sweepIds).toHaveLength(3);
    expect(() => extractObservableFeatures(detection, {
      sweeps: [...coherent, gridMismatch, configMismatch, sweepTimeMismatch],
    })).toThrow(/coherent complete scalar sweep/);
  });

  it('admits truthful half-open raw grids but rejects incomplete or out-of-range observable geometry', () => {
    const centerHz = 98_000_000;
    const spanHz = 2_000_000;
    const power = (frequency: number) => Math.max(-110, -48 - Math.abs(frequency - centerHz) / 2_000);
    const closed = emsoSweep(centerHz, spanHz, 30, power);
    const halfOpenFrequencyHz = Array.from(
      { length: closed.frequencyHz.length },
      (_, index) => closed.actualStartHz + spanHz * index / closed.frequencyHz.length,
    );
    const halfOpen: Sweep = {
      ...closed,
      id: 'truthful-half-open-grid',
      frequencyHz: halfOpenFrequencyHz,
      powerDbm: halfOpenFrequencyHz.map(power),
    };
    const detection = emsoDetection('truthful-half-open-grid', centerHz, 20_000, [halfOpen]);
    expect(() => extractObservableFeatures(detection, { sweeps: [halfOpen] })).not.toThrow();

    const invalidGrids: readonly Sweep[] = [
      {
        ...closed,
        id: 'materially-incomplete-grid',
        frequencyHz: closed.frequencyHz.map((_frequency, index) => closed.actualStartHz + spanHz * index / (2 * (closed.frequencyHz.length - 1))),
      },
      {
        ...closed,
        id: 'out-of-range-grid',
        frequencyHz: closed.frequencyHz.map((frequency) => frequency - 10_000),
      },
    ];
    for (const sweep of invalidGrids) {
      expect(() => {
        const invalidDetection = emsoDetection(sweep.id, centerHz, 20_000, [sweep]);
        extractObservableFeatures(invalidDetection, { sweeps: [sweep] });
      }).toThrow(/materially incomplete or out-of-range sweep geometry|outside its actual bounds/);
    }
  });

  it('marginalizes every cadence-rate feature when physical zero-span timing is unqualified', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('unqualified-time', 98_000_000, 20_000, sweeps);
    const spectrumObservation = extractObservableFeatures(detection, { sweeps });
    const powerDbm = Array.from({ length: 450 }, (_, index) => index % 10 < 4 ? -45 : -90);
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'unqualified-time-zs', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 50,
      frequencyHz: 98_000_000, samplePeriodSeconds: 1 / 9_000, powerDbm,
      targetDetectionId: detection.id,
      requested: admittedDetectedPower(98_000_000, 450, 0.05, 20),
      actualRbwHz: 20_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
      timingQualification: 'wall-clock-derived',
    };

    const legacyWithoutExplicitWindow = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
    });
    expect(legacyWithoutExplicitWindow.zeroSpanCaptureId).toBeUndefined();
    expect(legacyWithoutExplicitWindow.limitations)
      .toContain('zero-span-capture-receipt-missing');
    expect(legacyWithoutExplicitWindow.limitations)
      .toContain('zero-span-acquisition-policy-unqualified');

    const observation = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: createDetectedPowerCaptureReceipt({
        activeSignals: [detection],
        evidenceSweeps: sweeps,
        capture: zeroSpan,
        admittedTargetTuneHz: zeroSpan.frequencyHz,
        spectrumSweepIds: spectrumObservation.sweepIds,
      }),
    });

    expect(observation.views).toContain('detected-power-envelope');
    expect(observation.limitations).toContain('zero-span-timing-unqualified');
    expect(observation.values).toHaveProperty('envelope.rangeDb');
    expect(observation.values).not.toHaveProperty('envelope.logTransitionRateHz');
    expect(Object.keys(observation.values).some((key) => key.startsWith('envelope.periodicEnergy'))).toBe(false);
  });

  it('discloses synthetic spectrum resolution and unavailable SignalLab RF RBW without inventing values', () => {
    const canonicalObservations = Array.from({ length: 9 }, (_, index) =>
      synthesizeCanonicalObservation('cw-rbw-line', {
        lookIndex: index,
        actualRbwHz: 500_000 / (450 - 1),
        noiseFloorDbm: -130,
        snrDb: 55,
        seed: 119,
      }));
    const sweeps: Sweep[] = canonicalObservations.slice(0, 8).map((observation, index) => ({
      kind: 'spectrum',
      id: `signal-lab-cw-${index + 1}`,
      sequence: index + 1,
      capturedAt: new Date(Date.UTC(2026, 0, 1) + (index + 1) * 50).toISOString(),
      elapsedMilliseconds: observation.sweepTimeSeconds * 1_000,
      frequencyHz: observation.frequencyHz,
      powerDbm: observation.powerDbm,
      requested: {
        kind: 'swept-spectrum',
        startHz: observation.frequencyHz[0]!,
        stopHz: observation.frequencyHz.at(-1)!,
        points: observation.frequencyHz.length,
        sweepTimeSeconds: observation.sweepTimeSeconds,
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
      },
      actualStartHz: observation.frequencyHz[0]!,
      actualStopHz: observation.frequencyHz.at(-1)!,
      actualRbwHz: observation.actualRbwHz,
      actualAttenuationDb: null,
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      attenuationQualification: 'not-applicable',
      source: 'signal-lab-synthetic',
      complete: true,
      identity: signalLabIdentity,
    }));
    const detection = emsoDetection('signal-lab-unavailable-rbw', 98_000_000, 20_000, sweeps);
    const spectrumObservation = extractObservableFeatures(detection, { sweeps });
    const tunedFrequencyHz = Math.round(
      detection.peakHz + sweeps[0]!.actualRbwHz / 10,
    );
    const canonicalZeroSpan = synthesizeCanonicalObservation('cw-rbw-line', {
      lookIndex: 8,
      zeroSpanFrequencyHz: tunedFrequencyHz,
      actualRbwHz: 500_000 / (450 - 1),
      noiseFloorDbm: -130,
      snrDb: 55,
      seed: 119,
    });
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'signal-lab-unavailable-rbw-zs', sequence: 9,
      capturedAt: new Date(Date.UTC(2026, 0, 1) + 9 * 50).toISOString(),
      elapsedMilliseconds: 50,
      frequencyHz: tunedFrequencyHz,
      samplePeriodSeconds: canonicalZeroSpan.zeroSpanSamplePeriodSeconds,
      targetDetectionId: detection.id,
      powerDbm: canonicalZeroSpan.zeroSpanPowerDbm,
      requested: admittedSyntheticDetectedPower(
        tunedFrequencyHz,
        canonicalZeroSpan.zeroSpanPowerDbm.length,
        canonicalZeroSpan.zeroSpanPowerDbm.length
          * canonicalZeroSpan.zeroSpanSamplePeriodSeconds,
      ),
      actualRbwHz: null,
      actualAttenuationDb: null,
      resolutionBandwidthQualification: 'unavailable',
      attenuationQualification: 'not-applicable',
      source: 'signal-lab-synthetic',
      complete: true,
      identity: signalLabIdentity,
      timingQualification: 'simulation-exact',
    };

    const observation = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: createDetectedPowerCaptureReceipt({
        activeSignals: [detection],
        evidenceSweeps: sweeps,
        capture: zeroSpan,
        admittedTargetTuneHz: zeroSpan.frequencyHz,
        spectrumSweepIds: spectrumObservation.sweepIds,
      }),
    });

    expect(observation.views).toContain('detected-power-envelope');
    expect(observation.limitations).toContain('synthetic-grid-equivalent-resolution');
    expect(observation.limitations).toContain('zero-span-rbw-unavailable');
    expect(observation.values['envelope.tuneOffsetFraction']).toBeCloseTo(
      Math.abs(tunedFrequencyHz - detection.peakHz) / Math.max(detection.bandwidthHz / 2, 1),
      12,
    );
    expect(Object.values(observation.values).every(Number.isFinite)).toBe(true);
  });

  it('rejects otherwise matching zero-span evidence outside the calibrated acquisition geometry', () => {
    const sweeps = Array.from({ length: 8 }, (_, index) => emsoSweep(98_000_000, 2_000_000, index + 1, (frequency) => Math.max(-110, -45 - Math.abs(frequency - 98_000_000) / 2_000)));
    const detection = emsoDetection('geometry-owner', 98_000_000, 20_000, sweeps);
    const spectrumObservation = extractObservableFeatures(detection, { sweeps });
    const zeroSpan: ZeroSpanCapture = {
      kind: 'zero-span', id: 'unsupported-geometry', sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 10,
      frequencyHz: detection.peakHz, samplePeriodSeconds: 0.0001, targetDetectionId: detection.id,
      powerDbm: Array.from({ length: 100 }, (_, index) => index % 10 < 4 ? -45 : -90),
      requested: admittedDetectedPower(detection.peakHz, 100, 0.01, 20),
      actualRbwHz: 20_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
      timingQualification: 'simulation-exact',
    };

    const observation = extractObservableFeatures(detection, {
      sweeps,
      zeroSpan,
      zeroSpanSpectrumSweepIds: spectrumObservation.sweepIds,
      detectedPowerCaptureReceipt: createDetectedPowerCaptureReceipt({
        activeSignals: [detection],
        evidenceSweeps: sweeps,
        capture: zeroSpan,
        admittedTargetTuneHz: zeroSpan.frequencyHz,
        spectrumSweepIds: spectrumObservation.sweepIds,
      }),
    });

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
      requested: admittedDetectedPower(433_920_000, 80, 0.1, 100),
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

  it('resets every accumulating trace when RBW value or qualification changes on the same frequency grid', () => {
    const configuration: TraceBankConfiguration = [
      { id: 1, mode: 'clear-write', averageCount: 4 },
      { id: 2, mode: 'max-hold', averageCount: 4 },
      { id: 3, mode: 'min-hold', averageCount: 4 },
      { id: 4, mode: 'average', averageCount: 4 },
    ];
    const accumulator = new TraceAccumulator(configuration);
    const first = makeSweep({
      id: 'rbw-first',
      actualRbwHz: 10_000,
      resolutionBandwidthQualification: 'device-observed',
      powerDbm: Array(20).fill(-40),
    });
    accumulator.update(first);
    const changedValue = makeSweep({
      id: 'rbw-value-changed',
      actualRbwHz: 20_000,
      resolutionBandwidthQualification: 'device-observed',
      powerDbm: Array(20).fill(-90),
    });
    const afterValueChange = accumulator.update(changedValue);
    for (const frame of afterValueChange) {
      expect(frame).toMatchObject({
        actualRbwHz: 20_000,
        resolutionBandwidthQualification: 'device-observed',
        sourceSweepId: 'rbw-value-changed',
        sweepCount: 1,
      });
      expect(frame.powerDbm).toEqual(Array(20).fill(-90));
    }

    const changedQualification = makeSweep({
      id: 'rbw-qualification-changed',
      actualRbwHz: 20_000,
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      powerDbm: Array(20).fill(-70),
    });
    const afterQualificationChange = accumulator.update(changedQualification);
    for (const frame of afterQualificationChange) {
      expect(frame).toMatchObject({
        actualRbwHz: 20_000,
        resolutionBandwidthQualification: 'synthetic-grid-equivalent',
        sourceSweepId: 'rbw-qualification-changed',
        sweepCount: 1,
      });
      expect(frame.powerDbm).toEqual(Array(20).fill(-70));
    }
  });

  it('preserves a frozen VIEW frame with its own RBW provenance and resets before resuming accumulation', () => {
    const configuration: TraceBankConfiguration = [
      { id: 1, mode: 'clear-write', averageCount: 4 },
      { id: 2, mode: 'max-hold', averageCount: 4 },
      { id: 3, mode: 'blank', averageCount: 4 },
      { id: 4, mode: 'blank', averageCount: 4 },
    ];
    const accumulator = new TraceAccumulator(configuration);
    const first = makeSweep({
      id: 'view-rbw-first',
      actualRbwHz: 10_000,
      resolutionBandwidthQualification: 'device-observed',
      powerDbm: Array.from({ length: 20 }, (_, index) => index === 10 ? -40 : -90),
    });
    accumulator.update(first);
    accumulator.configure(configuration.map((trace) => trace.id === 2
      ? { ...trace, mode: 'view' as const }
      : trace));
    const second = makeSweep({
      id: 'view-rbw-second',
      actualRbwHz: 100_000,
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      powerDbm: Array(20).fill(-20),
    });
    accumulator.update(second);
    const frozen = accumulator.frames().find((frame) => frame.traceId === 2);
    expect(frozen).toMatchObject({
      mode: 'view',
      actualRbwHz: 10_000,
      resolutionBandwidthQualification: 'device-observed',
      sourceSweepId: 'view-rbw-first',
      sweepCount: 1,
    });
    const density = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 2,
      mode: 'noise-density',
      frequencyHz: first.frequencyHz[10]!,
      tracking: 'fixed',
    }], accumulator.frames())[0];
    expect(density?.noiseDensityDbmHz).toBe(-80);

    accumulator.configure(configuration);
    const resumed = accumulator.update(makeSweep({
      id: 'view-rbw-resumed',
      actualRbwHz: 100_000,
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      powerDbm: Array(20).fill(-75),
    })).find((frame) => frame.traceId === 2);
    expect(resumed).toMatchObject({
      mode: 'max-hold',
      actualRbwHz: 100_000,
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      sourceSweepId: 'view-rbw-resumed',
      sweepCount: 1,
    });
    expect(resumed?.powerDbm).toEqual(Array(20).fill(-75));
  });

  it('reads normal, delta, noise-density, peak-tracking markers and performs bounded peak searches', () => {
    const sweep = makeSweep();
    const frame: TraceFrame = { traceId: 1, mode: 'clear-write', frequencyHz: sweep.frequencyHz, powerDbm: sweep.powerDbm, actualRbwHz: sweep.actualRbwHz, sweepCount: 1, sourceSweepId: sweep.id, evidence: 'host-derived' };
    const markers: readonly MarkerConfiguration[] = [
      { id: 1, enabled: true, traceId: 1, mode: 'normal', frequencyHz: 900, tracking: 'peak' },
      { id: 2, enabled: true, traceId: 1, mode: 'delta', frequencyHz: 1_100, tracking: 'fixed', referenceMarkerId: 1 },
      { id: 3, enabled: true, traceId: 1, mode: 'noise-density', frequencyHz: 100, tracking: 'fixed' },
    ];
    const readings = readMarkers(markers, [frame]);
    expect(readings[0]).toMatchObject({ markerId: 1, frequencyHz: 1_000, powerDbm: -48, evidence: 'host-derived' });
    expect(readings[1]).toMatchObject({ deltaFrequencyHz: 100, deltaPowerDb: -6 });
    expect(readings[2]?.noiseDensityDbmHz).toBe(-110);
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
    expect(() => detector.analyze(makeSweep({ actualRbwHz: 0 }))).toThrow(/positive analysis resolution scale/i);
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
    actualRbwHz: spanHz / (points - 1), requested: admittedSpectrum({ ...analyzer, startHz, stopHz, points, sweepTimeSeconds: 0.05 }),
  });
}

function agileSweep(sequence: number, activeFrequencyHz: number, spanHz: number): Sweep {
  const centerHz = spanHz >= 84_000_000 ? 2_441_000_000 : 2_426_000_000;
  return emsoSweep(centerHz, spanHz, sequence, (frequency) => Math.abs(frequency - activeFrequencyHz) <= 300_000 ? -45 : -110);
}

function signalLabCadenceContractSweep(sequence: number): Sweep {
  const sweep = agileSweep(sequence, 2_402_000_000, 84_000_000);
  return {
    ...sweep,
    id: `signal-lab-cadence-contract-${sequence}`,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence).toISOString(),
    elapsedMilliseconds: 1,
    powerDbm: sweep.powerDbm.map(() => -110),
    requested: {
      ...sweep.requested,
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
    },
    actualAttenuationDb: null,
    resolutionBandwidthQualification: 'synthetic-grid-equivalent',
    attenuationQualification: 'not-applicable',
    source: 'signal-lab-synthetic',
    identity: signalLabIdentity,
  };
}

function emsoDetection(id: string, peakHz: number, _expectedBandwidthHz: number, sweeps: readonly Sweep[]): DetectedSignal {
  const detectorConfig: SignalDetectionConfig = {
    threshold: { strategy: 'noise-relative', marginDb: 10 },
    minimumBandwidthHz: 0,
    minimumProminenceDb: 6,
    minimumConsecutiveSweeps: 2,
    releaseAfterMissedSweeps: 2,
  };
  const detector = new SignalDetector(detectorConfig);
  const tracker = new SignalTracker(detectorConfig);
  let tracks: readonly DetectedSignal[] = [];
  for (const sweep of sweeps) tracks = tracker.update(sweep, detector.analyze(sweep));
  const admitted = [...tracks]
    .sort((left, right) => Math.abs(left.peakHz - peakHz) - Math.abs(right.peakHz - peakHz))[0];
  if (!admitted?.classificationRegionObservation
    || admitted.classificationRegionStartHz === undefined
    || admitted.classificationRegionStopHz === undefined) {
    throw new Error(`Fixture ${id} did not produce a locally admitted detector ROI`);
  }
  return { ...admitted, id };
}
