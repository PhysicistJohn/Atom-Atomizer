import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';

type StaticClassificationAssociationMode = Extract<
  NonNullable<DetectedSignal['associationMode']>,
  'regular-spectral-component-activity' | 'multicomponent-swept-region-activity'
>;

function isStaticClassificationAssociationMode(
  mode: DetectedSignal['associationMode'],
): mode is StaticClassificationAssociationMode {
  return mode === 'regular-spectral-component-activity'
    || mode === 'multicomponent-swept-region-activity';
}

/**
 * Preserve a static classifier association as evidence lineage, never as a
 * merged emission, common process, simultaneous event, protocol, or emitter.
 */
export function agentClassificationAssociation(detection: DetectedSignal | undefined) {
  if (!detection || !isStaticClassificationAssociationMode(detection.associationMode)) return null;
  const observations = detection.multicomponentAssociationObservations;
  return {
    evidenceKind: 'nonidentifying-static-classification-association' as const,
    mode: detection.associationMode,
    associationId: detection.associationId,
    associationModelId: detection.associationModelId,
    regionHz: [detection.associationRegionStartHz, detection.associationRegionStopHz] as const,
    sweepIds: detection.associationRegionSweepIds,
    memberLocalTrackIds: detection.associationMemberTrackIds,
    missedSweeps: detection.associationMissedSweeps,
    currentLocalMember: detection.missedSweeps === 0
      && detection.associationMissedSweeps === 0
      && detection.associationMemberTrackIds?.includes(detection.id) === true,
    multicomponentLineage: detection.associationMode === 'multicomponent-swept-region-activity'
      ? {
        observations,
        latestObservation: observations?.at(-1),
      }
      : null,
    representsPhysicalEmission: false as const,
    representsEmitterIdentity: false as const,
    representsCommonProcess: false as const,
    representsSimultaneity: false as const,
    representsProtocolIdentity: false as const,
  };
}

/** Attach the exact association lineage to the representative result itself. */
export function agentClassificationResults(
  detections: readonly DetectedSignal[],
  classifications: readonly WaveformClassification[],
) {
  const detectionById = new Map(detections.map((detection) => [detection.id, detection] as const));
  return classifications.map((classification) => ({
    ...classification,
    classificationAssociation: agentClassificationAssociation(detectionById.get(classification.detectionId)),
  }));
}

/**
 * Projects detector state across the Atom boundary without allowing a rolling
 * or static classification association to masquerade as one physical emission.
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
        classificationAssociation: agentClassificationAssociation(detection),
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
