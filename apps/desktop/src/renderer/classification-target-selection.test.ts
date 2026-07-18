import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_CAPTURE_TARGET_SELECTION_POLICY_ID,
  classificationCaptureTargetRankEvidence,
  SignalDetector,
  SignalTracker,
  type ClassificationCaptureTargetProjection,
} from '@tinysa/analysis';
import type { DetectedSignal, DeviceIdentity, SignalDetectionConfig, Sweep } from '@tinysa/contracts';
import {
  classificationSpectrumSelection,
  resolveVisibleClassificationTargetSelection,
  sanitizeClassificationEvidenceDetections,
  visibleClassificationTargetProjectionAdmission,
  visibleClassificationTargetProjections,
} from './classification-target-selection.js';

const visibleSweep = {
  id: 'visible-sweep',
  capturedAt: '2026-07-17T00:00:00.000Z',
  actualStartHz: 100,
  actualStopHz: 200,
} as Sweep;

function physicalDetection(
  id: string,
  peakDbm: number,
  peakHz: number,
  overrides: Partial<DetectedSignal> = {},
): DetectedSignal {
  const sourceSweep = {
    ...visibleSweep,
    complete: true,
    actualStartHz: peakHz - 2.5,
    actualStopHz: peakHz + 2.5,
    actualRbwHz: 1,
    frequencyHz: [peakHz - 2, peakHz - 1, peakHz, peakHz + 1, peakHz + 2],
    powerDbm: [-100, -100, peakDbm, -100, -100],
  } as Sweep;
  const observation = {
    sourceSweep,
    startHz: peakHz - 1,
    stopHz: peakHz + 1,
    peakHz,
    detectorId: 'fixture-detector',
    localBayesianEvidence: {} as DetectedSignal['bayesianEvidence'],
  };
  return {
    id,
    startHz: peakHz - 1,
    stopHz: peakHz + 1,
    peakHz,
    peakDbm,
    prominenceDb: 20,
    bandwidthHz: 2,
    noiseFloorDbm: -100,
    lastSeenAt: visibleSweep.capturedAt,
    sweepIds: [visibleSweep.id],
    state: 'active',
    missedSweeps: 0,
    associationMode: 'frequency-local',
    detectorId: 'fixture-detector',
    classificationRegionObservation: observation,
    localClassificationObservations: [observation],
    ...overrides,
  } as DetectedSignal;
}

describe('visible classification target selection', () => {
  it('fails closed without a sweep or a qualifying physical target', () => {
    const current = physicalDetection('current', -40, 150);

    expect(visibleClassificationTargetProjections([current], undefined)).toEqual([]);
    expect(resolveVisibleClassificationTargetSelection([current], undefined)).toEqual({
      origin: 'automatic',
    });
    expect(resolveVisibleClassificationTargetSelection([], visibleSweep)).toEqual({
      origin: 'automatic',
    });
  });

  it('ranks the complete visible sweep by v4 evidence and breaks exact ties stably', () => {
    const left = physicalDetection('left', -55, 110);
    const right = physicalDetection('right', -35, 190);
    const staleButStronger = physicalDetection('stale', -5, 160, {
      sweepIds: ['older-sweep'],
      lastSeenAt: '2026-07-16T00:00:00.000Z',
    });
    const outsideButStronger = physicalDetection('outside', -4, 210);

    expect(resolveVisibleClassificationTargetSelection(
      [staleButStronger, left, outsideButStronger, right],
      visibleSweep,
    )).toEqual({ detectionId: right.id, origin: 'automatic' });
    expect(resolveVisibleClassificationTargetSelection(
      [right, outsideButStronger, left, staleButStronger],
      visibleSweep,
    )).toEqual({ detectionId: right.id, origin: 'automatic' });

    const tieB = physicalDetection('tie-b', -20, 140);
    const tieA = physicalDetection('tie-a', -20, 160);
    expect(resolveVisibleClassificationTargetSelection(
      [tieB, tieA],
      visibleSweep,
    )).toEqual({ detectionId: tieA.id, origin: 'automatic' });
  });

  it('commits the live-shaped prominent integrated signal even when a narrow signal has the higher peak', () => {
    const sweep = adversarialProminenceSweep();
    const config = {
      threshold: { strategy: 'absolute', levelDbm: -90 },
      minimumBandwidthHz: 0,
      minimumProminenceDb: 6,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    } satisfies SignalDetectionConfig;
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const tracks = tracker.update(sweep, detector.analyze(sweep));
    const narrow = tracks.find((track) => track.qualityFlags.includes('single-bin'))!;
    const wide = tracks.find((track) => track.id !== narrow.id)!;

    expect(CLASSIFICATION_CAPTURE_TARGET_SELECTION_POLICY_ID)
      .toBe('preferred-then-current-source-sweep-integrated-excess-power-physical-or-qualified-agile-member-target-v4');
    expect(narrow.peakDbm).toBeGreaterThan(wide.peakDbm);
    expect(classificationCaptureTargetRankEvidence(wide)!.integratedExcessPowerMw)
      .toBeGreaterThan(classificationCaptureTargetRankEvidence(narrow)!.integratedExcessPowerMw);
    expect(visibleClassificationTargetProjections(tracks, sweep)[0]?.rawTarget.id)
      .toBe(wide.id);

    expect(resolveVisibleClassificationTargetSelection(tracks, sweep)).toEqual({
      detectionId: wide.id,
      origin: 'automatic',
    });
    // Human selection remains an explicit override of automatic ranking.
    expect(resolveVisibleClassificationTargetSelection(tracks, sweep, narrow.id)).toEqual({
      detectionId: narrow.id,
      origin: 'explicit',
      explicitDetectionId: narrow.id,
    });
  });

  it('rejects same-ID same-time rank evidence whose embedded sweep payload is not visible', () => {
    const sweep = adversarialProminenceSweep();
    const config = {
      threshold: { strategy: 'absolute', levelDbm: -90 },
      minimumBandwidthHz: 0,
      minimumProminenceDb: 6,
      minimumConsecutiveSweeps: 1,
      releaseAfterMissedSweeps: 2,
    } satisfies SignalDetectionConfig;
    const detector = new SignalDetector(config);
    const tracker = new SignalTracker(config);
    const tracks = tracker.update(sweep, detector.analyze(sweep));
    const target = tracks[0]!;
    const currentObservation = target.localClassificationObservations!.at(-1)!;
    const substitutedObservation = {
      ...currentObservation,
      sourceSweep: {
        ...currentObservation.sourceSweep,
        powerDbm: currentObservation.sourceSweep.powerDbm.map((value, index) =>
          index === 0 ? value + 1 : value),
      },
    };
    const substitutedTarget: DetectedSignal = {
      ...target,
      classificationRegionObservation: substitutedObservation,
      localClassificationObservations: [substitutedObservation],
    };
    const substitutedTracks = tracks.map((track) =>
      track.id === target.id ? substitutedTarget : track);

    expect(visibleClassificationTargetProjectionAdmission(
      substitutedTracks,
      sweep,
    )).toMatchObject({
      status: 'ranking-admission-failed',
      projections: [],
      rejectedRawTargetIds: [target.id],
      reason: 'current-source-sweep-rank-evidence-unavailable',
    });
  });

  it('keeps an explicit current target but falls back when that row is stale', () => {
    const weak = physicalDetection('weak', -60, 120);
    const strong = physicalDetection('strong', -30, 180);
    expect(resolveVisibleClassificationTargetSelection(
      [weak, strong],
      visibleSweep,
      weak.id,
    )).toEqual({
      detectionId: weak.id,
      origin: 'explicit',
      explicitDetectionId: weak.id,
    });

    const staleWeak = { ...weak, sweepIds: ['older-sweep'] };
    expect(resolveVisibleClassificationTargetSelection(
      [staleWeak, strong],
      visibleSweep,
      staleWeak.id,
    )).toEqual({ detectionId: strong.id, origin: 'automatic' });
  });

  it('fails the complete visible rank closed when any eligible row lacks exact source evidence', () => {
    const valid = physicalDetection('valid-rank-row', -45, 130);
    const mismatched = physicalDetection('mismatched-rank-row', -20, 170);
    const sourceSweep = mismatched.localClassificationObservations!.at(-1)!.sourceSweep;
    const mismatchedObservation = {
      ...mismatched.localClassificationObservations!.at(-1)!,
      sourceSweep: { ...sourceSweep, id: 'substituted-source-sweep' },
    };
    const invalidEligibleRow: DetectedSignal = {
      ...mismatched,
      classificationRegionObservation: mismatchedObservation,
      localClassificationObservations: [mismatchedObservation],
    };

    expect(resolveVisibleClassificationTargetSelection(
      [valid, invalidEligibleRow],
      visibleSweep,
    )).toEqual({ origin: 'automatic' });
    expect(resolveVisibleClassificationTargetSelection(
      [valid, invalidEligibleRow],
      visibleSweep,
      valid.id,
    )).toEqual({ origin: 'automatic' });
    expect(visibleClassificationTargetProjectionAdmission(
      [valid, invalidEligibleRow],
      visibleSweep,
    )).toEqual({
      status: 'ranking-admission-failed',
      projections: [],
      eligibleRawTargetIds: ['valid-rank-row', 'mismatched-rank-row'],
      rejectedRawTargetIds: ['mismatched-rank-row'],
      reason: 'current-source-sweep-rank-evidence-unavailable',
    });
  });

  it('rejects a partial rank when duplicate eligible IDs are omitted beside a valid row', () => {
    const valid = physicalDetection('valid-visible-row', -50, 120);
    const duplicateLeft = physicalDetection('duplicate-row', -35, 160);
    const duplicateRight = physicalDetection('duplicate-row', -25, 180);

    expect(visibleClassificationTargetProjectionAdmission(
      [valid, duplicateLeft, duplicateRight],
      visibleSweep,
    )).toEqual({
      status: 'ranking-admission-failed',
      projections: [],
      eligibleRawTargetIds: [
        'valid-visible-row',
        'duplicate-row',
        'duplicate-row',
      ],
      rejectedRawTargetIds: ['duplicate-row'],
      reason: 'eligible-target-population-incomplete',
    });
    expect(visibleClassificationTargetProjections(
      [valid, duplicateLeft, duplicateRight],
      visibleSweep,
    )).toEqual([]);
  });

  it('highlights the raw current member while retaining an agile evidence representative', () => {
    const rawTarget = physicalDetection('agile-current-member', -25, 175, {
      state: 'candidate',
    });
    const representative = {
      ...rawTarget,
      id: 'agile-activity-summary',
      state: 'active',
      associationMode: 'frequency-agile-2g4-activity',
    } as DetectedSignal;
    const projection = {
      rawTarget,
      projectedRepresentative: representative,
      projectionKind: 'current-qualified-agile-latest-member',
    } satisfies ClassificationCaptureTargetProjection;

    expect(classificationSpectrumSelection(
      [],
      [projection],
      representative.id,
    )).toEqual({
      detections: [rawTarget],
      selectedDetectionId: rawTarget.id,
    });
  });

  it('accepts only the qualified agile representative ID and maps it to the raw tune owner', () => {
    const { tracks, rawTarget, representative, sweep } = qualifiedAgileFixture();

    expect(resolveVisibleClassificationTargetSelection(
      tracks,
      sweep,
      representative.id,
    )).toEqual({
      detectionId: representative.id,
      rawTargetId: rawTarget.id,
      origin: 'explicit',
      explicitDetectionId: representative.id,
    });
    expect(resolveVisibleClassificationTargetSelection(
      tracks,
      sweep,
      rawTarget.id,
    )).toEqual({
      detectionId: representative.id,
      rawTargetId: rawTarget.id,
      origin: 'automatic',
    });
  });

  it('reports malformed rank evidence on a qualified agile candidate raw owner', () => {
    const { tracks, rawTarget, sweep } = qualifiedAgileFixture();
    const malformedRawTarget: DetectedSignal = {
      ...rawTarget,
      noiseFloorDbm: rawTarget.noiseFloorDbm + 1,
    };
    const malformedTracks = tracks.map((track) =>
      track.id === rawTarget.id ? malformedRawTarget : track);

    expect(visibleClassificationTargetProjectionAdmission(
      malformedTracks,
      sweep,
    )).toEqual({
      status: 'ranking-admission-failed',
      projections: [],
      eligibleRawTargetIds: [rawTarget.id],
      rejectedRawTargetIds: [rawTarget.id],
      reason: 'current-source-sweep-rank-evidence-unavailable',
    });
    expect(resolveVisibleClassificationTargetSelection(
      malformedTracks,
      sweep,
    )).toEqual({ origin: 'automatic' });
  });

  it('quarantines malformed rows without suppressing a valid visible target', () => {
    const valid = physicalDetection('valid', -45, 150);
    const malformed = [
      { ...valid, id: 'nan-power', peakDbm: Number.NaN },
      { ...valid, id: 'missing-sweeps', sweepIds: undefined },
      { ...valid, id: 'reversed', startHz: 160, stopHz: 140 },
      { ...valid, id: 'malformed-agile', associationMode: 'frequency-agile-2g4-activity', associationObservations: {} },
    ] as unknown as DetectedSignal[];

    expect(() => resolveVisibleClassificationTargetSelection(
      [...malformed, valid],
      visibleSweep,
    )).not.toThrow();
    expect(resolveVisibleClassificationTargetSelection(
      [...malformed, valid],
      visibleSweep,
    )).toEqual({ detectionId: valid.id, origin: 'automatic' });
    expect(sanitizeClassificationEvidenceDetections(malformed)).toEqual([]);
  });
});

const agileIdentity = {
  model: 'renderer agile fixture',
  hardwareVersion: 'offline',
  firmwareVersion: 'fixture',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'renderer-agile',
    path: 'offline://renderer-agile',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
} satisfies DeviceIdentity;

const agileConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
} satisfies SignalDetectionConfig;

function qualifiedAgileFixture(): {
  tracks: readonly DetectedSignal[];
  rawTarget: DetectedSignal;
  representative: DetectedSignal;
  sweep: Sweep;
} {
  const centersHz = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
    .map((value) => value * 1_000_000);
  const sweeps = centersHz.map((centerHz, index) => agileSweep(index + 1, centerHz));
  const detector = new SignalDetector(agileConfig);
  const tracker = new SignalTracker(agileConfig);
  let tracks: readonly DetectedSignal[] = [];
  for (const sweep of sweeps) tracks = tracker.update(sweep, detector.analyze(sweep));
  const representative = tracks.find((track) =>
    track.associationMode === 'frequency-agile-2g4-activity')!;
  const rawTarget = tracks.find((track) =>
    track.id === representative.associationObservations?.at(-1)?.trackId)!;
  return { tracks, rawTarget, representative, sweep: sweeps.at(-1)! };
}

function agileSweep(sequence: number, activeFrequencyHz: number): Sweep {
  const points = 401;
  const startHz = 2_399_000_000;
  const stopHz = 2_483_000_000;
  const frequencyHz = Array.from(
    { length: points },
    (_, index) => startHz + (stopHz - startHz) * index / (points - 1),
  );
  return {
    kind: 'spectrum',
    id: `renderer-agile-${sequence}`,
    sequence,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 50).toISOString(),
    elapsedMilliseconds: 50,
    frequencyHz,
    powerDbm: frequencyHz.map((frequency) =>
      Math.abs(frequency - activeFrequencyHz) <= 300_000 ? -45 : -110),
    requested: {
      kind: 'swept-spectrum',
      startHz,
      stopHz,
      points,
      sweepTimeSeconds: 0.05,
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormat: 'text',
        resolutionBandwidthKhz: 'auto',
        attenuationDb: 'auto',
        detector: 'sample',
        spurRejection: 'auto',
        lowNoiseAmplifier: 'off',
        avoidSpurs: 'auto',
        trigger: { mode: 'auto' },
      },
    },
    actualStartHz: startHz,
    actualStopHz: stopHz,
    actualRbwHz: (stopHz - startHz) / (points - 1),
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity: agileIdentity,
  };
}

function adversarialProminenceSweep(): Sweep {
  const points = 401;
  const startHz = 80_000_000;
  const stopHz = 120_000_000;
  const frequencyHz = Array.from(
    { length: points },
    (_, index) => startHz + (stopHz - startHz) * index / (points - 1),
  );
  return {
    kind: 'spectrum',
    id: 'visible-prominence-adversary',
    sequence: 1,
    capturedAt: '2026-07-17T01:00:00.000Z',
    elapsedMilliseconds: 50,
    frequencyHz,
    powerDbm: frequencyHz.map((_frequency, index) => {
      if (index === 60) return -25;
      if (index >= 180 && index <= 379) {
        return index === 280 ? -45 : -46;
      }
      return -110;
    }),
    requested: {
      kind: 'swept-spectrum',
      startHz,
      stopHz,
      points,
      sweepTimeSeconds: 0.05,
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormat: 'text',
        resolutionBandwidthKhz: 'auto',
        attenuationDb: 'auto',
        detector: 'sample',
        spurRejection: 'auto',
        lowNoiseAmplifier: 'off',
        avoidSpurs: 'auto',
        trigger: { mode: 'auto' },
      },
    },
    actualStartHz: startHz,
    actualStopHz: stopHz,
    actualRbwHz: (stopHz - startHz) / (points - 1),
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity: agileIdentity,
  };
}
