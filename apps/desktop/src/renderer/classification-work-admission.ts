import {
  classificationRepresentatives,
  observableAssociationEvidenceIsCurrentlyQualified,
} from '@tinysa/analysis';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import {
  resolveVisibleClassificationTargetSelection,
  type ClassificationTargetSelection,
} from './classification-target-selection.js';

/** The merged Detect workspace has one explicit-or-Auto selected classifier target. */
export const MAX_CLASSIFICATION_REQUESTS_PER_EVIDENCE_REVISION = 1;
export const MAX_LOCAL_CLASSIFICATION_SWEEPS = 8;
export const MAX_LOCAL_CLASSIFICATION_PROVENANCE_SWEEPS = 64;
export const MAX_ASSOCIATION_CLASSIFICATION_SWEEPS = 96;

export interface VisibleClassificationRepresentative {
  readonly detection: DetectedSignal;
  readonly selection: ClassificationTargetSelection;
}

/**
 * Keep every detection visible, but admit inference only for the one target the
 * operator sees as selected. Auto ranks the complete visible spectrum; an
 * explicit target remains sticky only while it is still current and qualified.
 */
export function selectVisibleClassificationRepresentative(
  signals: readonly DetectedSignal[],
  sweep: Sweep,
  explicitDetectionId?: string,
): VisibleClassificationRepresentative | undefined {
  const selection = resolveVisibleClassificationTargetSelection(
    signals,
    sweep,
    explicitDetectionId,
  );
  if (!selection.detectionId) return undefined;
  const representatives = classificationRepresentatives(
    signals.filter((signal) => signal.state === 'active'
      && observableAssociationEvidenceIsCurrentlyQualified(signal)),
    selection.detectionId,
  );
  const detection = representatives.find((candidate) =>
    candidate.id === selection.detectionId);
  return detection ? { detection, selection } : undefined;
}

/**
 * Project only external sweeps whose IDs the selected representative claims.
 * The detector object retains its own bounded immutable provenance ledger; the
 * worker does not also need every unrelated sweep in renderer history.
 */
export function exactClassificationEvidenceSweeps(
  detection: DetectedSignal,
  history: readonly Sweep[],
): readonly Sweep[] | undefined {
  const claimedIds = claimedClassificationSweepIds(detection);
  if (!claimedIds || claimedIds.length === 0) return undefined;
  const local = detection.associationMode === undefined
    || detection.associationMode === 'frequency-local';
  const limit = detection.associationMode === 'frequency-agile-2g4-activity'
    ? MAX_ASSOCIATION_CLASSIFICATION_SWEEPS
    : local
      ? MAX_LOCAL_CLASSIFICATION_PROVENANCE_SWEEPS
      : MAX_LOCAL_CLASSIFICATION_SWEEPS;
  if (claimedIds.length > limit || new Set(claimedIds).size !== claimedIds.length) {
    return undefined;
  }

  const requiredIds = local
    ? claimedIds.slice(-MAX_LOCAL_CLASSIFICATION_SWEEPS)
    : claimedIds;
  const required = new Set(requiredIds);
  const occurrenceCount = new Map<string, number>();
  for (const sweep of history) {
    if (required.has(sweep.id)) {
      occurrenceCount.set(sweep.id, (occurrenceCount.get(sweep.id) ?? 0) + 1);
    }
  }
  if (requiredIds.some((id) => occurrenceCount.get(id) !== 1)) return undefined;
  const projected = history.filter((sweep) => required.has(sweep.id));
  return projected.length === requiredIds.length ? projected : undefined;
}

function claimedClassificationSweepIds(
  detection: DetectedSignal,
): readonly string[] | undefined {
  if (detection.associationMode === 'frequency-agile-2g4-activity') {
    const opportunities = detection.associationOpportunities;
    return opportunities?.map((opportunity) => opportunity.sweepId);
  }
  if (detection.associationMode !== undefined
    && detection.associationMode !== 'frequency-local') {
    return detection.associationRegionSweepIds;
  }
  return detection.sweepIds;
}
