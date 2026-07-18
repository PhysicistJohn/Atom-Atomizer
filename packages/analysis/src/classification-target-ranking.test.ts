import { describe, expect, it } from 'vitest';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import {
  classificationCaptureTargetRankEvidence,
  compareClassificationCaptureTargetRankEvidence,
} from './classification-target-ranking.js';

const capturedAt = '2026-07-18T02:00:00.000Z';

describe('current source-sweep capture-target ranking', () => {
  it('integrates exact excess power so a wide lower peak can beat a narrow higher peak', () => {
    const source = sourceSweep(
      [100, 101, 102, 103, 104, 105, 106],
      [-20, -100, -100, -25, -25, -25, -25],
      99.5,
      106.5,
      1,
    );
    const narrow = detection('narrow', source, 100, 100, 100, -20);
    const wide = detection('wide', source, 103, 106, 103, -25);

    expect(narrow.peakDbm).toBeGreaterThan(wide.peakDbm);
    expect(rank(wide).integratedExcessPowerMw)
      .toBeGreaterThan(rank(narrow).integratedExcessPowerMw);
    expect(compareClassificationCaptureTargetRankEvidence(rank(wide), rank(narrow)))
      .toBeLessThan(0);
  });

  it('keeps a narrow higher peak first when the wide integral is genuinely lower', () => {
    const source = sourceSweep(
      [100, 101, 102, 103, 104, 105, 106],
      [-20, -100, -100, -27, -27, -27, -27],
      99.5,
      106.5,
      1,
    );
    const narrow = detection('narrow', source, 100, 100, 100, -20);
    const wide = detection('wide', source, 103, 106, 103, -27);

    expect(rank(narrow).integratedExcessPowerMw)
      .toBeGreaterThan(rank(wide).integratedExcessPowerMw);
    expect(compareClassificationCaptureTargetRankEvidence(rank(narrow), rank(wide)))
      .toBeLessThan(0);
  });

  it('returns an exact numeric tie and leaves stable identity ordering to the caller', () => {
    const source = sourceSweep(
      [100, 101, 102, 103, 104],
      [-100, -30, -100, -30, -100],
      99.5,
      104.5,
      1,
    );
    const left = rank(detection('left', source, 101, 101, 101, -30));
    const right = rank(detection('right', source, 103, 103, 103, -30));

    expect(left.integratedExcessPowerMw).toBe(right.integratedExcessPowerMw);
    expect(compareClassificationCaptureTargetRankEvidence(left, right)).toBe(0);
  });

  it('integrates a single-bin support cell with its complete physical width', () => {
    const source = sourceSweep(
      [100, 101, 102],
      [-100, -20, -100],
      99.5,
      102.5,
      1,
    );
    const evidence = rank(detection('single', source, 101, 101, 101, -20));

    expect(evidence).toMatchObject({
      supportStartHz: 101,
      supportStopHz: 101,
      supportCellCount: 1,
      robustFloorDbm: -100,
      actualRbwHz: 1,
    });
    expect(evidence.integratedExcessPowerMw).toBeCloseTo(10 ** (-2) - 10 ** (-10), 15);
  });

  it('uses midpoint physical cells on irregular grids and includes both boundary centers', () => {
    const source = sourceSweep(
      [100, 101, 103, 106],
      [-100, -20, -20, -100],
      99.5,
      108,
      2,
    );
    const evidence = rank(detection('irregular', source, 101, 103, 101, -20));
    const excessMw = 10 ** (-2) - 10 ** (-10);

    expect(evidence).toMatchObject({
      supportStartHz: 101,
      supportStopHz: 103,
      supportCellCount: 2,
    });
    // Widths are 1.5 Hz and 2.5 Hz; actual RBW is 2 Hz.
    expect(evidence.integratedExcessPowerMw).toBeCloseTo(excessMw * 2, 15);
  });

  it.each([
    ['missing current observation', (value: DetectedSignal) => ({
      ...value,
      classificationRegionObservation: undefined,
      localClassificationObservations: undefined,
    })],
    ['mismatched source ID', (value: DetectedSignal) => ({
      ...value,
      sweepIds: ['another-sweep'],
    })],
    ['stale source time', (value: DetectedSignal) => ({
      ...value,
      lastSeenAt: '2026-07-18T01:59:59.000Z',
    })],
    ['mismatched support', (value: DetectedSignal) => ({
      ...value,
      startHz: value.startHz - 1,
    })],
    ['mismatched peak sample', (value: DetectedSignal) => ({
      ...value,
      peakDbm: value.peakDbm + 1,
    })],
    ['mismatched robust floor', (value: DetectedSignal) => ({
      ...value,
      noiseFloorDbm: value.noiseFloorDbm + 1,
    })],
    ['NaN source sample', (value: DetectedSignal) => mutateSource(value, {
      powerDbm: [-100, Number.NaN, -100],
    })],
    ['null actual RBW', (value: DetectedSignal) => mutateSource(value, {
      actualRbwHz: null as unknown as number,
    })],
  ] as const)('fails ranking closed for %s', (_label, mutate) => {
    const source = sourceSweep(
      [100, 101, 102],
      [-100, -20, -100],
      99.5,
      102.5,
      1,
    );
    const valid = detection('valid', source, 101, 101, 101, -20);
    expect(classificationCaptureTargetRankEvidence(mutate(valid))).toBeUndefined();
  });
});

function rank(detected: DetectedSignal) {
  const evidence = classificationCaptureTargetRankEvidence(detected);
  if (!evidence) throw new Error(`Fixture ${detected.id} did not rank`);
  return evidence;
}

function detection(
  id: string,
  source: Sweep,
  startHz: number,
  stopHz: number,
  peakHz: number,
  peakDbm: number,
): DetectedSignal {
  const observation = {
    sourceSweep: source,
    startHz,
    stopHz,
    peakHz,
    detectorId: 'ranking-fixture',
    localBayesianEvidence: {} as DetectedSignal['bayesianEvidence'],
  };
  return {
    id,
    startHz,
    stopHz,
    peakHz,
    peakDbm,
    noiseFloorDbm: -100,
    lastSeenAt: source.capturedAt,
    sweepIds: [source.id],
    detectorId: 'ranking-fixture',
    classificationRegionObservation: observation,
    localClassificationObservations: [observation],
  } as unknown as DetectedSignal;
}

function sourceSweep(
  frequencyHz: readonly number[],
  powerDbm: readonly number[],
  actualStartHz: number,
  actualStopHz: number,
  actualRbwHz: number,
): Sweep {
  return {
    id: 'ranking-source',
    capturedAt,
    complete: true,
    frequencyHz,
    powerDbm,
    actualStartHz,
    actualStopHz,
    actualRbwHz,
  } as Sweep;
}

function mutateSource(
  value: DetectedSignal,
  patch: Partial<Sweep>,
): DetectedSignal {
  const latest = value.localClassificationObservations!.at(-1)!;
  const sourceSweep = { ...latest.sourceSweep, ...patch };
  const observation = { ...latest, sourceSweep };
  return {
    ...value,
    classificationRegionObservation: observation,
    localClassificationObservations: [observation],
  };
}
