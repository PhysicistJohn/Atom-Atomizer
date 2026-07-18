import type { DetectedSignal, Sweep } from '@tinysa/contracts';

export const CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL = Object.freeze({
  id: 'current-source-sweep-integrated-excess-power-v1',
  supportPolicy: 'complete-frequency-cells-with-centers-in-raw-detected-interval-v1',
  baselinePolicy: 'median-of-lowest-twenty-percent-current-source-sweep-v1',
  integrationPolicy: 'sum-positive-linear-excess-times-cell-width-over-actual-rbw-v1',
  tieBreakPolicy: 'representative-key-then-raw-id-v1',
} as const);

export interface ClassificationCaptureTargetRankEvidence {
  readonly sourceSweepId: string;
  readonly supportStartHz: number;
  readonly supportStopHz: number;
  readonly supportCellCount: number;
  readonly robustFloorDbm: number;
  readonly actualRbwHz: number;
  /** Exact unrounded linear-power integral used for ordering. */
  readonly integratedExcessPowerMw: number;
}

/**
 * Integrate current source-sweep power above its robust floor over every full
 * physical frequency cell whose center belongs to the raw detected interval.
 * Cell widths come from midpoint boundaries and therefore support irregular
 * grids and one-bin detections. Division by actual RBW converts overlapping
 * frequency-cell coverage to the equivalent number of resolution cells.
 */
export function classificationCaptureTargetRankEvidence(
  detection: DetectedSignal,
): ClassificationCaptureTargetRankEvidence | undefined {
  const observation = detection.localClassificationObservations?.at(-1)
    ?? detection.classificationRegionObservation;
  const sourceSweep = observation?.sourceSweep;
  if (!observation
    || !sourceSweep
    || !currentObservationMatchesDetection(detection, observation, sourceSweep)
    || !sourceSweepIsIntegrable(sourceSweep)) return undefined;

  const robustFloorDbm = robustLowerTailFloorDbm(sourceSweep.powerDbm);
  if (!Number.isFinite(detection.noiseFloorDbm)
    || detection.noiseFloorDbm !== robustFloorDbm) return undefined;
  const supportIndices = sourceSweep.frequencyHz
    .map((frequencyHz, index) => ({ frequencyHz, index }))
    .filter(({ frequencyHz }) => frequencyHz >= detection.startHz
      && frequencyHz <= detection.stopHz)
    .map(({ index }) => index);
  if (supportIndices.length === 0) return undefined;
  const peakIndex = sourceSweep.frequencyHz.indexOf(detection.peakHz);
  if (peakIndex < 0
    || !supportIndices.includes(peakIndex)
    || sourceSweep.powerDbm[peakIndex] !== detection.peakDbm) return undefined;

  const floorMw = dbmToMw(robustFloorDbm);
  let integratedExcessPowerMw = 0;
  for (const index of supportIndices) {
    const cellWidthHz = physicalCellWidthHz(sourceSweep, index);
    if (!Number.isFinite(cellWidthHz) || cellWidthHz <= 0) return undefined;
    const excessMw = Math.max(0, dbmToMw(sourceSweep.powerDbm[index]!) - floorMw);
    integratedExcessPowerMw += excessMw * cellWidthHz / sourceSweep.actualRbwHz;
  }
  if (!Number.isFinite(integratedExcessPowerMw) || integratedExcessPowerMw <= 0) {
    return undefined;
  }
  return {
    sourceSweepId: sourceSweep.id,
    supportStartHz: sourceSweep.frequencyHz[supportIndices[0]!]!,
    supportStopHz: sourceSweep.frequencyHz[supportIndices.at(-1)!]!,
    supportCellCount: supportIndices.length,
    robustFloorDbm,
    actualRbwHz: sourceSweep.actualRbwHz,
    integratedExcessPowerMw,
  };
}

/** Array.sort comparator for the exact numeric v4 automatic target evidence. */
export function compareClassificationCaptureTargetRankEvidence(
  left: ClassificationCaptureTargetRankEvidence | undefined,
  right: ClassificationCaptureTargetRankEvidence | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  if (left.integratedExcessPowerMw === right.integratedExcessPowerMw) return 0;
  return left.integratedExcessPowerMw > right.integratedExcessPowerMw ? -1 : 1;
}

function currentObservationMatchesDetection(
  detection: DetectedSignal,
  observation: NonNullable<DetectedSignal['classificationRegionObservation']>,
  sourceSweep: Sweep,
): boolean {
  return Array.isArray(detection.sweepIds)
    && sourceSweep.id === detection.sweepIds.at(-1)
    && sourceSweep.capturedAt === detection.lastSeenAt
    && observation.startHz === detection.startHz
    && observation.stopHz === detection.stopHz
    && observation.peakHz === detection.peakHz
    && observation.detectorId === detection.detectorId;
}

function sourceSweepIsIntegrable(sweep: Sweep): boolean {
  return typeof sweep === 'object'
    && sweep !== null
    && sweep.complete === true
    && typeof sweep.id === 'string'
    && sweep.id.length > 0
    && Number.isFinite(sweep.actualStartHz)
    && Number.isFinite(sweep.actualStopHz)
    && sweep.actualStopHz > sweep.actualStartHz
    && Number.isFinite(sweep.actualRbwHz)
    && sweep.actualRbwHz > 0
    && Array.isArray(sweep.frequencyHz)
    && Array.isArray(sweep.powerDbm)
    && sweep.frequencyHz.length >= 2
    && sweep.frequencyHz.length === sweep.powerDbm.length
    && sweep.frequencyHz.every((frequencyHz, index) => Number.isFinite(frequencyHz)
      && frequencyHz >= sweep.actualStartHz
      && frequencyHz <= sweep.actualStopHz
      && (index === 0 || frequencyHz > sweep.frequencyHz[index - 1]!))
    && sweep.powerDbm.every(Number.isFinite);
}

function physicalCellWidthHz(sweep: Sweep, index: number): number {
  const centerHz = sweep.frequencyHz[index]!;
  const leftHz = index === 0
    ? sweep.actualStartHz
    : (sweep.frequencyHz[index - 1]! + centerHz) / 2;
  const rightHz = index === sweep.frequencyHz.length - 1
    ? sweep.actualStopHz
    : (centerHz + sweep.frequencyHz[index + 1]!) / 2;
  return rightHz - leftHz;
}

function robustLowerTailFloorDbm(powerDbm: readonly number[]): number {
  const sorted = [...powerDbm].sort((left, right) => left - right);
  const cutoff = Math.max(1, Math.floor(sorted.length * 0.2));
  return median(sorted.slice(0, cutoff));
}

function median(values: readonly number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1]! + values[middle]!) / 2
    : values[middle]!;
}

function dbmToMw(valueDbm: number): number {
  return 10 ** (valueDbm / 10);
}
