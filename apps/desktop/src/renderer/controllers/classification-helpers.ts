import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import {
  extractObservableFeatures,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
} from '@tinysa/analysis';
import { visibleClassificationTargetProjections } from '../classification-target-selection.js';

export function resolveRuntimeAdmittedCaptureTarget(
  signals: readonly DetectedSignal[],
  evidenceSweeps: readonly Sweep[],
  currentSweep: Sweep | undefined,
  preferredDetectionId: string | undefined,
): {
  readonly rawTarget: DetectedSignal;
  readonly detection: DetectedSignal;
  readonly spectrumSweepIds: readonly string[];
} | undefined {
  if (preferredDetectionId === undefined) return undefined;
  const projections = visibleClassificationTargetProjections(signals, currentSweep);
  for (const projection of projections.filter((candidate) =>
    candidate.rawTarget.id === preferredDetectionId)) {
    const detection = projection.projectedRepresentative;
    if (!observableAssociationEvidenceIsCurrentlyQualified(detection)) continue;
    try {
      const observation = extractObservableFeatures(detection, {
        sweeps: evidenceSweeps,
      });
      if (observation.sweepIds.length === 8) {
        return {
          rawTarget: projection.rawTarget,
          detection,
          spectrumSweepIds: observation.sweepIds,
        };
      }
    } catch (error) {
      if (error instanceof ObservableEvidenceUnavailableError) continue;
      throw error;
    }
  }
  return undefined;
}
