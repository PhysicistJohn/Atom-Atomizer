import {
  classificationCaptureTargetProjections,
  currentVisiblePhysicalClassificationRows,
  type ClassificationCaptureTargetProjection,
} from '@tinysa/analysis';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';

export {
  compareClassificationCaptureTargetSignals,
  currentVisiblePhysicalClassificationRows,
} from '@tinysa/analysis';

export interface ClassificationTargetSelection {
  /** Evidence representative selected for classification and display. */
  readonly detectionId?: string;
  /** Physical row that owns a detected-power tune when it differs from the representative. */
  readonly rawTargetId?: string;
  readonly origin: 'automatic' | 'explicit';
  readonly explicitDetectionId?: string;
}

const CLASSIFICATION_ASSOCIATION_MODES = new Set<NonNullable<DetectedSignal['associationMode']>>([
  'frequency-local',
  'frequency-agile-2g4-activity',
  'regular-spectral-component-activity',
  'multicomponent-swept-region-activity',
]);

/**
 * Remove rows that cannot safely enter target ranking. The renderer normally
 * receives analysis-owned objects, but this boundary must still quarantine a
 * malformed row instead of letting NaN ordering or malformed agile provenance
 * crash every otherwise valid target.
 */
export function sanitizeClassificationTargetDetections(
  detections: readonly DetectedSignal[],
): readonly DetectedSignal[] {
  return detections.filter((detection) => {
    if (typeof detection !== 'object' || detection === null) return false;
    const associationMode = detection.associationMode;
    return typeof detection.id === 'string'
      && /^[A-Za-z0-9-]{1,128}$/.test(detection.id)
      && Number.isFinite(detection.peakDbm)
      && Number.isSafeInteger(detection.missedSweeps)
      && detection.missedSweeps >= 0
      && (detection.state === 'candidate'
        || detection.state === 'active'
        || detection.state === 'released')
      && (associationMode === undefined
        || CLASSIFICATION_ASSOCIATION_MODES.has(associationMode))
      && optionalArray(detection.associationObservations)
      && optionalArray(detection.associationOpportunities)
      && optionalArray(detection.localClassificationObservations)
      && optionalStringArray(detection.associationRegionSweepIds)
      && optionalStringArray(detection.associationMemberTrackIds);
  });
}

/** Quarantine rows before the merged Detect workspace formats their fields. */
export function sanitizeClassificationEvidenceDetections(
  detections: readonly DetectedSignal[],
): readonly DetectedSignal[] {
  return sanitizeClassificationTargetDetections(detections).filter((detection) =>
    visibleGeometryIsFinite(detection)
    && typeof detection.lastSeenAt === 'string'
    && detection.lastSeenAt.length > 0
    && Array.isArray(detection.sweepIds)
    && detection.sweepIds.length > 0
    && detection.sweepIds.every(nonEmptyString)
    && Number.isFinite(detection.bandwidthHz)
    && detection.bandwidthHz >= 0
    && Number.isFinite(detection.thresholdDbm)
    && Number.isFinite(detection.prominenceDb)
    && Number.isFinite(detection.prominenceThresholdDb)
    && Number.isSafeInteger(detection.persistenceSweeps)
    && detection.persistenceSweeps >= 0
    && typeof detection.detectorId === 'string'
    && detection.detectorId.length > 0
    && bayesianEvidenceIsRenderable(detection)
    && (detection.state !== 'candidate'
      || (Number.isSafeInteger(detection.detectorConfig?.minimumConsecutiveSweeps)
        && detection.detectorConfig.minimumConsecutiveSweeps > 0)));
}

/** Return only render-safe evidence owned by the exact sweep on screen. */
export function sanitizeVisibleClassificationEvidenceDetections(
  detections: readonly DetectedSignal[],
  sweep: Sweep | undefined,
): readonly DetectedSignal[] {
  if (!sweep) return [];
  return sanitizeClassificationEvidenceDetections(detections).filter((detection) =>
    detectionIsFromVisibleSweep(detection, sweep));
}

/**
 * Bind selectable targets to the exact sweep currently drawn in the Detect
 * workspace. The tracker normally guarantees this relationship through its
 * zero-miss state, but this renderer boundary fails closed if state from an
 * older sweep is ever paired with a newer (or absent) plot.
 */
export function visibleClassificationTargetProjections(
  detections: readonly DetectedSignal[],
  sweep: Sweep | undefined,
): readonly ClassificationCaptureTargetProjection[] {
  if (!sweep) return [];
  const currentVisibleDetections = detections.filter((detection) =>
    detectionIsFromVisibleSweep(detection, sweep));
  return safeClassificationCaptureTargetProjections(currentVisibleDetections).filter((projection) =>
    detectionIsFromVisibleSweep(projection.rawTarget, sweep)
    && detectionIsFromVisibleSweep(projection.projectedRepresentative, sweep));
}

/** Resolve explicit/automatic selection only inside the exact visible sweep. */
export function resolveVisibleClassificationTargetSelection(
  detections: readonly DetectedSignal[],
  sweep: Sweep | undefined,
  explicitDetectionId?: string,
): ClassificationTargetSelection {
  return resolveTargetSelection(
    visibleClassificationTargetProjections(detections, sweep),
    explicitDetectionId,
  );
}

/**
 * Project a classifier representative back onto the physical row that must be
 * highlighted in the spectrum. This differs only for qualified agile
 * activity, whose representative is evidence rather than an emitter.
 */
export function classificationSpectrumSelection(
  physicalRows: readonly DetectedSignal[],
  projections: readonly ClassificationCaptureTargetProjection[],
  selectedRepresentativeId: string | undefined,
): {
  readonly detections: readonly DetectedSignal[];
  readonly selectedDetectionId?: string;
} {
  const projection = projections.find((candidate) =>
    candidate.projectedRepresentative.id === selectedRepresentativeId);
  if (!projection) {
    return {
      detections: physicalRows,
      ...(selectedRepresentativeId === undefined
        ? {}
        : { selectedDetectionId: selectedRepresentativeId }),
    };
  }
  const rawTarget = projection.rawTarget;
  return {
    detections: physicalRows.some((row) => row.id === rawTarget.id)
      ? physicalRows
      : [...physicalRows, rawTarget],
    selectedDetectionId: rawTarget.id,
  };
}

export function resolveClassificationTargetSelection(
  detections: readonly DetectedSignal[],
  explicitDetectionId?: string,
): ClassificationTargetSelection {
  return resolveTargetSelection(
    safeClassificationCaptureTargetProjections(detections),
    explicitDetectionId,
  );
}

function resolveTargetSelection(
  projections: readonly ClassificationCaptureTargetProjection[],
  explicitDetectionId?: string,
): ClassificationTargetSelection {
  if (explicitDetectionId !== undefined) {
    const explicit = projections.find((projection) =>
      projection.projectedRepresentative.id === explicitDetectionId);
    if (explicit) {
      return {
        detectionId: explicit.projectedRepresentative.id,
        ...(explicit.rawTarget.id === explicit.projectedRepresentative.id
          ? {}
          : { rawTargetId: explicit.rawTarget.id }),
        origin: 'explicit',
        explicitDetectionId: explicit.projectedRepresentative.id,
      };
    }
  }
  const automatic = projections[0];
  return {
    ...(automatic === undefined
      ? {}
      : {
        detectionId: automatic.projectedRepresentative.id,
        ...(automatic.rawTarget.id === automatic.projectedRepresentative.id
          ? {}
          : { rawTargetId: automatic.rawTarget.id }),
      }),
    origin: 'automatic',
  };
}

function detectionIsFromVisibleSweep(
  detection: DetectedSignal,
  sweep: Sweep,
): boolean {
  return Array.isArray(detection.sweepIds)
    && visibleGeometryIsFinite(detection)
    && detection.sweepIds.at(-1) === sweep.id
    && detection.lastSeenAt === sweep.capturedAt
    && detection.startHz >= sweep.actualStartHz
    && detection.stopHz <= sweep.actualStopHz
    && detection.peakHz >= detection.startHz
    && detection.peakHz <= detection.stopHz;
}

function safeClassificationCaptureTargetProjections(
  detections: readonly DetectedSignal[],
): readonly ClassificationCaptureTargetProjection[] {
  const safe = sanitizeClassificationTargetDetections(detections);
  try {
    return classificationCaptureTargetProjections(safe);
  } catch {
    // A malformed synthetic agile row must not suppress unrelated valid
    // physical targets. Drop all agile summaries and replay the ordinary rows;
    // if anything else is malformed, fail the target population closed.
    try {
      return classificationCaptureTargetProjections(safe.filter((detection) =>
        detection.associationMode !== 'frequency-agile-2g4-activity'));
    } catch {
      return [];
    }
  }
}

function visibleGeometryIsFinite(detection: DetectedSignal): boolean {
  return Number.isFinite(detection.startHz)
    && Number.isFinite(detection.stopHz)
    && Number.isFinite(detection.peakHz)
    && detection.startHz <= detection.peakHz
    && detection.peakHz <= detection.stopHz;
}

function optionalArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(nonEmptyString));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function bayesianEvidenceIsRenderable(detection: DetectedSignal): boolean {
  const evidence = detection.bayesianEvidence;
  return typeof evidence === 'object'
    && evidence !== null
    && Number.isFinite(evidence.posteriorSignalProbability)
    && (evidence.posteriorScope === 'selected-local-region'
      || evidence.posteriorScope === 'track-state'
      || evidence.posteriorScope === 'track-predictive-state');
}
