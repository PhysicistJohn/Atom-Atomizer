import { describe, expect, it } from 'vitest';
import {
  OBSERVABLE_TRAINING_SWEEP_POINTS,
  OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
  SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
  observableTrainingActualRbwHz,
  observableTrainingDetectedPowerSynthesisFilterWidthHz,
  observableTrainingInterleavedCaptureLookIndex,
  observableTrainingSourceLookIndex,
  occupiedBandwidthRbwDivisorGeometry,
  type ObservableTrainingTemporalSchedule,
} from './observable-training-acquisition-geometry.js';

describe('observable-training acquisition geometry', () => {
  it('reproduces the production SignalLab recommended-span inclusive grid exactly', () => {
    const wifiOfdm20 = { occupiedBandwidthHz: 16_600_000, recommendedSpanHz: 30_000_000 };

    expect(SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY).toMatchObject({
      id: 'signal-lab-recommended-span-450-point-grid-v1',
      sourceKind: 'signal-lab',
      kind: 'recommended-span-inclusive-grid',
      sweepPoints: 450,
    });
    expect(observableTrainingActualRbwHz(
      wifiOfdm20,
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    )).toBe(wifiOfdm20.recommendedSpanHz / (OBSERVABLE_TRAINING_SWEEP_POINTS - 1));
  });

  it('does not disguise scenario-dependent production geometry as a global RBW divisor', () => {
    const wifiOfdm20 = { occupiedBandwidthHz: 16_600_000, recommendedSpanHz: 30_000_000 };
    const wifiOfdm80 = { occupiedBandwidthHz: 79_000_000, recommendedSpanHz: 84_000_000 };
    const effectiveDivisor = (scenario: typeof wifiOfdm20) => scenario.occupiedBandwidthHz
      / observableTrainingActualRbwHz(scenario, SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY);

    expect(effectiveDivisor(wifiOfdm20)).toBeCloseTo(248.446_666_666_7, 10);
    expect(effectiveDivisor(wifiOfdm80)).toBeCloseTo(422.273_809_523_8, 10);
    expect(effectiveDivisor(wifiOfdm20)).not.toBe(effectiveDivisor(wifiOfdm80));
  });

  it('preserves the pre-existing occupied-bandwidth nuisance-grid policy separately', () => {
    const scenario = { occupiedBandwidthHz: 16_600_000, recommendedSpanHz: 30_000_000 };
    const divisorGeometry = occupiedBandwidthRbwDivisorGeometry(120);

    expect(divisorGeometry.id).toBe('occupied-bandwidth-rbw-divisor:120');
    expect(observableTrainingActualRbwHz(scenario, divisorGeometry)).toBe(16_600_000 / 120);
    expect(observableTrainingActualRbwHz(scenario, divisorGeometry)).not.toBe(
      observableTrainingActualRbwHz(scenario, SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY),
    );
    expect(observableTrainingDetectedPowerSynthesisFilterWidthHz(scenario, divisorGeometry))
      .toBe(observableTrainingActualRbwHz(scenario, divisorGeometry));
  });

  it('pins the generator-internal production filter without claiming a measured RBW', () => {
    const am = { occupiedBandwidthHz: 52_000, recommendedSpanHz: 500_000 };
    const spectrumActualRbwHz = observableTrainingActualRbwHz(
      am,
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    );

    expect(spectrumActualRbwHz).toBe(500_000 / 449);
    expect(observableTrainingDetectedPowerSynthesisFilterWidthHz(
      am,
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    )).toBe(SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ);
    expect(OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY).toEqual({
      id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
      divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
      signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
      signalLabProductionSynthesisFilterWidthHz: 100_000,
      measurementActualRbwQualification: 'unavailable',
    });
    expect(spectrumActualRbwHz).not.toBe(
      SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
    );
  });

  it('pins the production contiguous, interleaved-capture, and large-offset source clocks', () => {
    const [contiguous, interleaved, largeOffset] = SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES;
    const firstTen = (schedule: typeof contiguous | typeof interleaved | typeof largeOffset) =>
      Array.from({ length: 10 }, (_, opportunity) => observableTrainingSourceLookIndex(schedule, opportunity));

    expect(firstTen(contiguous)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(firstTen(interleaved)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10]);
    expect(firstTen(largeOffset)).toEqual([225, 226, 227, 228, 229, 230, 231, 232, 234, 235]);
    expect(observableTrainingInterleavedCaptureLookIndex(interleaved, 7)).toBe(8);
    expect(observableTrainingInterleavedCaptureLookIndex(largeOffset, 7)).toBe(233);
  });

  it('keeps the independent validator source clock held out from every fitted production clock', () => {
    const heldOutValidationSchedule: ObservableTrainingTemporalSchedule = {
      id: 'held-out-offset-347-post-eleven-single-skip-v1',
      sourceLookIndexOffset: 347,
      skipAfterSpectrumOpportunities: 11,
      skippedSourceOpportunities: 1,
    };
    const fitIndices = new Set(SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES.flatMap((schedule) =>
      Array.from({ length: 96 }, (_, opportunity) => observableTrainingSourceLookIndex(schedule, opportunity))));
    const validationIndices = Array.from(
      { length: 96 },
      (_, opportunity) => observableTrainingSourceLookIndex(heldOutValidationSchedule, opportunity),
    );

    expect(SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES.map((schedule) => schedule.id))
      .not.toContain(heldOutValidationSchedule.id);
    expect(validationIndices.filter((lookIndex) => fitIndices.has(lookIndex))).toEqual([]);
    expect(validationIndices.slice(9, 14)).toEqual([356, 357, 359, 360, 361]);
  });

  it('rejects invalid geometry inputs', () => {
    expect(() => occupiedBandwidthRbwDivisorGeometry(0)).toThrow(/finite and positive/);
    expect(() => observableTrainingActualRbwHz(
      { occupiedBandwidthHz: 20, recommendedSpanHz: 10 },
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    )).toThrow(/contained by its recommended span/);
    expect(() => observableTrainingSourceLookIndex(
      SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES[0],
      -1,
    )).toThrow(/non-negative integer/);
  });
});
