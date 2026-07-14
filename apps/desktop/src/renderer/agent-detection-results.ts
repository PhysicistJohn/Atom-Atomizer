import type { DetectedSignal } from '@tinysa/contracts';

/**
 * Projects detector state across the Atom boundary without allowing a rolling
 * frequency-agility association to masquerade as one physical emission.
 */
export function agentDetectionResults(detections: readonly DetectedSignal[]) {
  return {
    contract: 'separated-local-detections-and-activity-associations-v1' as const,
    localDetections: detections
      .filter((detection) => detection.associationMode !== 'frequency-agile-2g4-activity')
      .map((detection) => ({
        evidenceKind: 'frequency-local-detection' as const,
        id: detection.id,
        state: detection.state,
        isPromotedActiveLocalEmission: detection.state === 'active',
        startHz: detection.startHz,
        stopHz: detection.stopHz,
        peakHz: detection.peakHz,
        peakDbm: detection.peakDbm,
        bandwidthHz: detection.bandwidthHz,
        prominenceDb: detection.prominenceDb,
        prominenceThresholdDb: detection.prominenceThresholdDb,
        persistenceSweeps: detection.persistenceSweeps,
        missedSweeps: detection.missedSweeps,
        detectorId: detection.detectorId,
        sweepIds: detection.sweepIds,
        // Scope is explicit: this may be a local look, a track update, or a
        // prediction-only state after a miss.
        bayesianDetectionEvidence: detection.bayesianEvidence,
        classificationAssociation: detection.associationMode === 'regular-spectral-component-activity'
          ? {
              mode: detection.associationMode,
              associationId: detection.associationId,
              associationModelId: detection.associationModelId,
              regionHz: [detection.associationRegionStartHz, detection.associationRegionStopHz],
              sweepIds: detection.associationRegionSweepIds,
              memberLocalTrackIds: detection.associationMemberTrackIds,
              missedSweeps: detection.associationMissedSweeps,
              representsEmitterIdentity: false as const,
            }
          : null,
      })),
    activityAssociations: detections
      .filter((detection) => detection.associationMode === 'frequency-agile-2g4-activity')
      .map((detection) => {
        const latestObservation = detection.associationObservations?.at(-1);
        return {
          evidenceKind: 'frequency-agile-2g4-activity-association' as const,
          associationId: detection.associationId ?? detection.id,
          associationModelId: detection.associationModelId,
          state: 'recent-evidence' as const,
          representsPhysicalEmission: false as const,
          representsEmitterIdentity: false as const,
          representsProtocolIdentity: false as const,
          regionHz: [detection.associationRegionStartHz, detection.associationRegionStopHz],
          geometryId: detection.associationGeometryId,
          regionSweepIds: detection.associationRegionSweepIds,
          memberLocalTrackIds: detection.associationMemberTrackIds,
          opportunitiesSinceLatestPositive: detection.associationMissedSweeps,
          observations: detection.associationObservations,
          opportunities: detection.associationOpportunities,
          bayesianAgileDynamicsEvidence: detection.associationBayesianEvidence,
          latestLocalLook: latestObservation
            ? {
                ...latestObservation,
                peakDbm: detection.peakDbm,
                bayesianEvidence: detection.bayesianEvidence,
              }
            : null,
        };
      }),
  };
}
