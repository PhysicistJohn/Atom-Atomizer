export const OBSERVABLE_TRAINING_SWEEP_POINTS = 450 as const;

export const SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ = 100_000 as const;

export const OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY = Object.freeze({
  id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
  divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
  signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
  signalLabProductionSynthesisFilterWidthHz:
    SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
  measurementActualRbwQualification: 'unavailable',
} as const);

export const SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY = Object.freeze({
  id: 'signal-lab-recommended-span-450-point-grid-v1',
  sourceKind: 'signal-lab',
  kind: 'recommended-span-inclusive-grid',
  sweepPoints: OBSERVABLE_TRAINING_SWEEP_POINTS,
  spanPolicy: 'canonical-recommended-span-v1',
  resolutionScalePolicy: 'recommended-span-divided-by-points-minus-one-v1',
} as const);

export const SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES = Object.freeze([
  // Standalone/filtered runs start a profile at source look zero.
  Object.freeze({
    id: 'contiguous-from-zero-v1',
    sourceLookIndexOffset: 0,
    skipAfterSpectrumOpportunities: null,
    skippedSourceOpportunities: 0,
  } as const),
  // The live gate takes its first detected-power capture after the eight
  // spectra required for classification. That capture consumes one shared
  // SignalLab sequence value before the next spectrum.
  Object.freeze({
    id: 'post-eight-spectrum-single-capture-skip-v1',
    sourceLookIndexOffset: 0,
    skipAfterSpectrumOpportunities: 8,
    skippedSourceOpportunities: 1,
  } as const),
  // In the owned full live matrix, Wi-Fi OFDM20 follows nine 24-spectrum
  // profiles that each consume one detected-power capture: 9 * 25 = 225.
  // Retain the same post-window capture skip so this is the exact implicated
  // production source-clock schedule, not an arbitrary large phase shift.
  Object.freeze({
    id: 'profile-sequence-offset-225-post-eight-spectrum-single-capture-skip-v1',
    sourceLookIndexOffset: 225,
    skipAfterSpectrumOpportunities: 8,
    skippedSourceOpportunities: 1,
  } as const),
] as const);

export const SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME_METADATA = Object.freeze({
  id: 'signal-lab-recommended-span-grid-with-session-sequence-nuisance-v1',
  geometry: SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
  temporalSchedules: SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES,
  componentFitIncluded: true,
  tailCalibrationIncluded: true,
} as const);

export interface ObservableTrainingTemporalSchedule {
  readonly id: string;
  readonly sourceLookIndexOffset: number;
  readonly skipAfterSpectrumOpportunities: number | null;
  readonly skippedSourceOpportunities: number;
}

export const OBSERVABLE_TRAINING_BASELINE_TEMPORAL_SCHEDULE =
  SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES[0];

export interface ObservableTrainingScenarioGeometry {
  readonly occupiedBandwidthHz: number;
  readonly recommendedSpanHz: number;
}

export type ObservableTrainingAcquisitionGeometry =
  | Readonly<{
    id: string;
    kind: 'occupied-bandwidth-rbw-divisor';
    rbwDivisor: number;
    sweepPoints: typeof OBSERVABLE_TRAINING_SWEEP_POINTS;
  }>
  | typeof SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY;

export interface ObservableTrainingAcquisitionRegime {
  readonly id: string;
  readonly geometry: ObservableTrainingAcquisitionGeometry;
  readonly temporalSchedule: ObservableTrainingTemporalSchedule;
}

export function occupiedBandwidthRbwDivisorGeometry(
  rbwDivisor: number,
): ObservableTrainingAcquisitionGeometry {
  if (!Number.isFinite(rbwDivisor) || rbwDivisor <= 0) {
    throw new Error('Observable-training RBW divisor must be finite and positive');
  }
  return Object.freeze({
    id: `occupied-bandwidth-rbw-divisor:${rbwDivisor}`,
    kind: 'occupied-bandwidth-rbw-divisor',
    rbwDivisor,
    sweepPoints: OBSERVABLE_TRAINING_SWEEP_POINTS,
  });
}

export function observableTrainingActualRbwHz(
  scenario: ObservableTrainingScenarioGeometry,
  geometry: ObservableTrainingAcquisitionGeometry,
): number {
  if (!Number.isFinite(scenario.occupiedBandwidthHz) || scenario.occupiedBandwidthHz <= 0
    || !Number.isFinite(scenario.recommendedSpanHz)
    || scenario.recommendedSpanHz < scenario.occupiedBandwidthHz) {
    throw new Error('Observable-training scenario geometry must have a finite positive occupied bandwidth contained by its recommended span');
  }
  const inclusiveGridSpacingHz = scenario.recommendedSpanHz / (geometry.sweepPoints - 1);
  if (geometry.kind === 'recommended-span-inclusive-grid') return inclusiveGridSpacingHz;
  return Math.max(
    inclusiveGridSpacingHz * 0.8,
    scenario.occupiedBandwidthHz / geometry.rbwDivisor,
    1_000,
  );
}

/**
 * Returns an explicit generator parameter, never observed measurement evidence.
 * Divisor regimes retain the broad v11 receiver-filter nuisance matrix, while
 * the named SignalLab production regime reproduces its owned 100 kHz replay.
 */
export function observableTrainingDetectedPowerSynthesisFilterWidthHz(
  scenario: ObservableTrainingScenarioGeometry,
  geometry: ObservableTrainingAcquisitionGeometry,
): number {
  const spectrumActualRbwHz = observableTrainingActualRbwHz(scenario, geometry);
  return geometry.kind === 'recommended-span-inclusive-grid'
    ? SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ
    : spectrumActualRbwHz;
}

export function observableTrainingSourceLookIndex(
  temporalSchedule: ObservableTrainingTemporalSchedule,
  zeroBasedSpectrumOpportunity: number,
): number {
  if (!Number.isInteger(zeroBasedSpectrumOpportunity) || zeroBasedSpectrumOpportunity < 0) {
    throw new Error('Observable-training spectrum opportunity must be a non-negative integer');
  }
  const skipped = temporalSchedule.skipAfterSpectrumOpportunities !== null
    && zeroBasedSpectrumOpportunity >= temporalSchedule.skipAfterSpectrumOpportunities
    ? temporalSchedule.skippedSourceOpportunities
    : 0;
  return temporalSchedule.sourceLookIndexOffset + zeroBasedSpectrumOpportunity + skipped;
}

export function observableTrainingInterleavedCaptureLookIndex(
  temporalSchedule: ObservableTrainingTemporalSchedule,
  zeroBasedSpectrumOpportunity: number,
): number {
  return observableTrainingSourceLookIndex(temporalSchedule, zeroBasedSpectrumOpportunity) + 1;
}
