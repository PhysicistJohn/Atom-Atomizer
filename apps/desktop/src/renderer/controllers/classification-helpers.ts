import type { DetectedPowerCaptureReceipt, DetectedSignal, Sweep } from '@tinysa/contracts';
import {
  extractObservableFeatures,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
  type WaveformEvidence,
} from '@tinysa/analysis';
import { visibleClassificationTargetProjections, type ClassificationTargetSelection } from '../classification-target-selection.js';
import { sameOptionalStringArray } from './kernel.js';

export function classificationWindowSweepIds(
  detection: DetectedSignal,
  history: readonly Sweep[],
): readonly string[] {
  const sourceIds = detection.associationMode !== undefined
      && detection.associationMode !== 'frequency-local'
      && detection.associationRegionSweepIds?.length
    ? detection.associationRegionSweepIds
    : detection.sweepIds;
  const admitted = new Set(sourceIds);
  return history
    .filter((candidate) => admitted.has(candidate.id))
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, 8)
    .map((candidate) => candidate.id);
}

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

export function captureReceiptRepresentativeMatches(
  receipt: DetectedPowerCaptureReceipt,
  detection: DetectedSignal,
): boolean {
  const expected = receipt.projectedRepresentative;
  return expected.id === detection.id
    && expected.startHz === detection.startHz
    && expected.stopHz === detection.stopHz
    && expected.peakHz === detection.peakHz
    && expected.peakDbm === detection.peakDbm
    && expected.bandwidthHz === detection.bandwidthHz
    && expected.missedSweeps === detection.missedSweeps
    && expected.lastSeenAt === detection.lastSeenAt
    && expected.associationMode === detection.associationMode
    && expected.associationId === detection.associationId
    && expected.associationMissedSweeps === detection.associationMissedSweeps
    && sameOptionalStringArray(
      expected.associationMemberTrackIds,
      detection.associationMemberTrackIds,
    );
}

export function classificationWorkRevision(
  sequence: number,
  visibleSweep: Sweep,
  selection: ClassificationTargetSelection,
  evidence: WaveformEvidence,
): string {
  return JSON.stringify({
    contract: 'classification-evidence-revision-v1',
    sequence,
    visibleSweepId: visibleSweep.id,
    visibleSweepSequence: visibleSweep.sequence,
    selectionOrigin: selection.origin,
    projectedRepresentativeId: selection.detectionId ?? null,
    rawTargetId: selection.rawTargetId ?? selection.detectionId ?? null,
    spectrumSweepIds: evidence.sweeps.map((item) => item.id),
    zeroSpanCaptureId: evidence.zeroSpan?.id ?? null,
    zeroSpanSpectrumSweepIds: evidence.zeroSpanSpectrumSweepIds ?? [],
  });
}
