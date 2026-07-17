import { describe, expect, it } from 'vitest';
import { SignalDetector, SignalTracker, type ClassificationCaptureTargetProjection } from '@tinysa/analysis';
import type { DetectedSignal, DeviceIdentity, SignalDetectionConfig, Sweep } from '@tinysa/contracts';
import {
  classificationSpectrumSelection,
  resolveVisibleClassificationTargetSelection,
  sanitizeClassificationEvidenceDetections,
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
  return {
    id,
    startHz: peakHz - 1,
    stopHz: peakHz + 1,
    peakHz,
    peakDbm,
    lastSeenAt: visibleSweep.capturedAt,
    sweepIds: [visibleSweep.id],
    state: 'active',
    missedSweeps: 0,
    associationMode: 'frequency-local',
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

  it('ranks the complete visible sweep by physical peak power and breaks exact ties stably', () => {
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
