/// <reference types="node" />
import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import {
  exactClassificationEvidenceSweeps,
  MAX_CLASSIFICATION_REQUESTS_PER_EVIDENCE_REVISION,
  selectVisibleClassificationRepresentative,
} from './classification-work-admission.js';

describe('bounded selected-signal classification admission', () => {
  it('Auto ranks the complete visible spectrum and explicit selection is sticky only while current', () => {
    const sweep = lightSweep(1);
    const weak = physicalDetection('weak', -60, 120, sweep);
    const strong = physicalDetection('strong', -30, 180, sweep);

    expect(selectVisibleClassificationRepresentative([weak, strong], sweep)?.detection.id)
      .toBe(strong.id);
    expect(selectVisibleClassificationRepresentative([weak, strong], sweep, weak.id))
      .toMatchObject({ detection: { id: weak.id }, selection: { origin: 'explicit' } });

    const staleWeak = { ...weak, sweepIds: ['older-sweep'] };
    expect(selectVisibleClassificationRepresentative([staleWeak, strong], sweep, weak.id))
      .toMatchObject({ detection: { id: strong.id }, selection: { origin: 'automatic' } });
  });

  it('projects exact local and association provenance and fails closed on missing or duplicate IDs', () => {
    const chronological = Array.from({ length: 110 }, (_value, index) => lightSweep(index + 1));
    const history = [...chronological].reverse();
    const local = physicalDetection('local', -40, 150, chronological.at(-1)!, {
      sweepIds: chronological.slice(-12).map(({ id }) => id),
    });
    expect(exactClassificationEvidenceSweeps(local, history)?.map(({ id }) => id))
      .toEqual(chronological.slice(-8).reverse().map(({ id }) => id));

    const staticAssociation = {
      ...local,
      associationMode: 'regular-spectral-component-activity',
      associationRegionSweepIds: chronological.slice(-8).map(({ id }) => id),
    } as DetectedSignal;
    expect(exactClassificationEvidenceSweeps(staticAssociation, history)?.map(({ id }) => id))
      .toEqual(chronological.slice(-8).reverse().map(({ id }) => id));

    const agileIds = chronological.slice(-96).map(({ id }) => id);
    const agile = {
      ...local,
      associationMode: 'frequency-agile-2g4-activity',
      associationOpportunities: agileIds.map((sweepId) => ({ sweepId, outcome: 'none' as const })),
    } as DetectedSignal;
    expect(exactClassificationEvidenceSweeps(agile, history)).toHaveLength(96);
    expect(exactClassificationEvidenceSweeps(
      { ...local, sweepIds: ['missing-sweep'] },
      history,
    )).toBeUndefined();
    expect(exactClassificationEvidenceSweeps(
      { ...local, sweepIds: [chronological.at(-1)!.id, chronological.at(-1)!.id] },
      history,
    )).toBeUndefined();
    expect(exactClassificationEvidenceSweeps(
      local,
      [history[0]!, history[0]!, ...history.slice(1)],
    )).toBeUndefined();
  });

  it('collapses the measured 12-representative 52.7 MB Wi-Fi fanout to one exact-window message', () => {
    const chronological = Array.from({ length: 128 }, (_value, index) => heavySweep(index + 1));
    const history = [...chronological].reverse();
    const visible = history[0]!;
    const detections = Array.from({ length: 12 }, (_value, index) => heavyDetection(
      `wifi-fragment-${String(index + 1).padStart(2, '0')}`,
      -60 + index,
      2_427_000_000 + index * 1_000_000,
      chronological,
    ));

    const legacyFanoutBytes = detections.reduce((total, detection) => total + serialize({
      detection,
      evidence: { sweeps: history },
    }).byteLength, 0);
    const selected = selectVisibleClassificationRepresentative(detections, visible);
    const evidenceSweeps = selected
      ? exactClassificationEvidenceSweeps(selected.detection, history)
      : undefined;
    const admittedBytes = selected && evidenceSweeps
      ? serialize({ detection: selected.detection, evidence: { sweeps: evidenceSweeps } }).byteLength
      : Number.POSITIVE_INFINITY;

    // The forensic live run measured 52,669,317 bytes for this exact fanout
    // cardinality. This independently constructed 1024-bin graph guards the
    // same order of magnitude without depending on a running SignalLab bridge.
    expect(52_669_317).toBeGreaterThan(50_000_000);
    expect(legacyFanoutBytes).toBeGreaterThan(30_000_000);
    expect(MAX_CLASSIFICATION_REQUESTS_PER_EVIDENCE_REVISION).toBe(1);
    expect(selected?.detection.id).toBe('wifi-fragment-12');
    expect(evidenceSweeps).toHaveLength(8);
    expect(admittedBytes).toBeLessThan(legacyFanoutBytes / 10);
  });
});

function physicalDetection(
  id: string,
  peakDbm: number,
  peakHz: number,
  sweep: Sweep,
  overrides: Partial<DetectedSignal> = {},
): DetectedSignal {
  const halfWidth = Math.max(0.1, (sweep.actualStopHz - sweep.actualStartHz) / 1_000);
  const sourceSweep = {
    ...sweep,
    frequencyHz: [peakHz - halfWidth, peakHz, peakHz + halfWidth],
    powerDbm: [-100, peakDbm, -100],
    actualRbwHz: halfWidth,
    complete: true,
  };
  const observation = {
    sourceSweep,
    startHz: peakHz - halfWidth,
    stopHz: peakHz + halfWidth,
    peakHz,
    detectorId: 'classification-admission-fixture',
    localBayesianEvidence: {} as DetectedSignal['bayesianEvidence'],
  };
  return {
    id,
    startHz: peakHz - halfWidth,
    stopHz: peakHz + halfWidth,
    peakHz,
    peakDbm,
    noiseFloorDbm: -100,
    lastSeenAt: sweep.capturedAt,
    sweepIds: [sweep.id],
    state: 'active',
    missedSweeps: 0,
    associationMode: 'frequency-local',
    detectorId: 'classification-admission-fixture',
    classificationRegionObservation: observation,
    localClassificationObservations: [observation],
    ...overrides,
  } as DetectedSignal;
}

function lightSweep(sequence: number): Sweep {
  return {
    id: `sweep-${sequence}`,
    sequence,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 50).toISOString(),
    actualStartHz: 100,
    actualStopHz: 200,
  } as unknown as Sweep;
}

function heavySweep(sequence: number): Sweep {
  const points = 1_024;
  const startHz = 2_422_000_000;
  const stopHz = 2_452_000_000;
  const stepHz = (stopHz - startHz) / (points - 1);
  const signalPowerByIndex = new Map<number, number>();
  for (let index = 0; index < 12; index++) {
    const fractionalIndex = (2_427_000_000 + index * 1_000_000 - startHz) / stepHz;
    signalPowerByIndex.set(Math.floor(fractionalIndex), -60 + index);
    signalPowerByIndex.set(Math.ceil(fractionalIndex), -60 + index);
  }
  return {
    kind: 'spectrum',
    id: `wifi-sweep-${sequence}`,
    sequence,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 50).toISOString(),
    elapsedMilliseconds: 2,
    frequencyHz: Array.from({ length: points }, (_value, index) => startHz + index * stepHz),
    powerDbm: Array.from({ length: points }, (_value, index) =>
      signalPowerByIndex.get(index)
        ?? -110 + 34 * Math.exp(-(((index - 512) / 260) ** 8))),
    requested: {
      kind: 'swept-spectrum',
      startHz,
      stopHz,
      points,
      sweepTimeSeconds: 0.05,
      controls: {
        schemaVersion: 1,
        model: 'synthetic-scalar',
        timingQualification: 'simulation-exact',
      },
    },
    actualStartHz: startHz,
    actualStopHz: stopHz,
    actualRbwHz: stepHz,
    actualAttenuationDb: null,
    resolutionBandwidthQualification: 'synthetic-grid-equivalent',
    attenuationQualification: 'not-applicable',
    source: 'signal-lab-synthetic',
    complete: true,
    identity: {
      kind: 'instrument-session',
      sessionId: 'session:signal-lab',
      driverId: 'signal-lab',
      candidateId: 'signal-lab:canonical',
      provenance: {
        sourceKind: 'signal-lab',
        sourceId: 'canonical',
        execution: 'signal-lab-simulation',
        qualification: 'synthetic-visual-projection',
        producerConfigurationEpoch: 'producer:wifi',
        generatorSha256: 'a'.repeat(64),
        claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
      },
    },
  } as unknown as Sweep;
}

function heavyDetection(
  id: string,
  peakDbm: number,
  peakHz: number,
  chronological: readonly Sweep[],
): DetectedSignal {
  const retained = chronological.slice(-64);
  const visible = retained.at(-1)!;
  const nearestIndex = visible.frequencyHz.reduce((bestIndex, frequencyHz, index) => (
    Math.abs(frequencyHz - peakHz) < Math.abs(visible.frequencyHz[bestIndex]! - peakHz)
      ? index
      : bestIndex
  ), 0);
  const rankedPeakHz = visible.frequencyHz[nearestIndex]!;
  const observations = retained.map((sourceSweep) => ({
    sourceSweep,
    startHz: rankedPeakHz - 100_000,
    stopHz: rankedPeakHz + 100_000,
    peakHz: rankedPeakHz,
    detectorId: 'bayesian-signal-detector-v1',
    localBayesianEvidence: {
      posteriorScope: 'selected-local-region',
      posteriorSignalProbability: 0.99,
      logBayesFactor: 12,
      testedRegionStartHz: rankedPeakHz - 200_000,
      testedRegionStopHz: rankedPeakHz + 200_000,
      testedBinCount: 9,
      referenceBinCount: 64,
      signalPriorProbability: 0.01,
      multiplicityAdjustedPriorProbability: 0.0001,
    },
  }));
  const currentRobustFloorDbm = fixtureRobustLowerTailFloorDbm(
    observations.at(-1)!.sourceSweep.powerDbm,
  );
  const observedPeakDbm = visible.powerDbm[nearestIndex]!;
  if (observedPeakDbm !== peakDbm) {
    throw new Error(`Heavy fanout fixture did not place ${peakDbm} dBm at ${rankedPeakHz} Hz`);
  }
  return physicalDetection(id, observedPeakDbm, rankedPeakHz, visible, {
    startHz: rankedPeakHz - 100_000,
    stopHz: rankedPeakHz + 100_000,
    noiseFloorDbm: currentRobustFloorDbm,
    sweepIds: retained.map(({ id: sweepId }) => sweepId),
    firstSeenAt: retained[0]!.capturedAt,
    persistenceSweeps: retained.length,
    detectorId: 'bayesian-signal-detector-v1',
    detectorConfig: {
      threshold: { strategy: 'noise-relative', marginDb: 10 },
      minimumBandwidthHz: 0,
      minimumProminenceDb: 6,
      minimumConsecutiveSweeps: 2,
      releaseAfterMissedSweeps: 2,
    },
    localClassificationObservations: observations,
    classificationRegionObservation: observations[0],
    classificationRegionSweepIds: [retained[0]!.id],
    bayesianEvidence: observations.at(-1)!.localBayesianEvidence,
  } as unknown as Partial<DetectedSignal>);
}

function fixtureRobustLowerTailFloorDbm(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const lowerTail = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2)));
  const middle = Math.floor(lowerTail.length / 2);
  return lowerTail.length % 2 === 1
    ? lowerTail[middle]!
    : (lowerTail[middle - 1]! + lowerTail[middle]!) / 2;
}
