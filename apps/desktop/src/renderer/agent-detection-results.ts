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
  if (!detection
    || !agentDetectionRowIsSafe(detection)
    || !isStaticClassificationAssociationMode(detection.associationMode)) return null;
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
  const detectionById = new Map(detections
    .filter(agentDetectionRowIsSafe)
    .map((detection) => [detection.id, detection] as const));
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
  const safeDetections = detections.filter(agentDetectionRowIsSafe);
  return {
    contract: 'separated-local-detections-and-activity-associations-v1' as const,
    localDetections: safeDetections
      .filter((detection) => detection.associationMode !== 'frequency-agile-2g4-activity')
      .map((detection) => ({
        evidenceKind: 'frequency-local-detection' as const,
        id: detection.id,
        state: detection.state,
        isPromotedActiveLocalEmission: detection.state === 'active'
          && detection.missedSweeps === 0,
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
    activityAssociations: safeDetections
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

function agentDetectionRowIsSafe(detection: DetectedSignal): boolean {
  if (typeof detection !== 'object' || detection === null) return false;
  return typeof detection.id === 'string'
    && detection.id.length > 0
    && (detection.state === 'candidate'
      || detection.state === 'active'
      || detection.state === 'released')
    && Number.isSafeInteger(detection.missedSweeps)
    && detection.missedSweeps >= 0
    && Number.isSafeInteger(detection.persistenceSweeps)
    && detection.persistenceSweeps >= 0
    && Number.isFinite(detection.startHz)
    && Number.isFinite(detection.stopHz)
    && Number.isFinite(detection.peakHz)
    && detection.startHz <= detection.peakHz
    && detection.peakHz <= detection.stopHz
    && Number.isFinite(detection.peakDbm)
    && Number.isFinite(detection.bandwidthHz)
    && detection.bandwidthHz >= 0
    && Number.isFinite(detection.prominenceDb)
    && Number.isFinite(detection.prominenceThresholdDb)
    && typeof detection.detectorId === 'string'
    && detection.detectorId.length > 0
    && Array.isArray(detection.sweepIds)
    && detection.sweepIds.every((sweepId) =>
      typeof sweepId === 'string' && sweepId.length > 0)
    && typeof detection.bayesianEvidence === 'object'
    && detection.bayesianEvidence !== null
    && (detection.associationObservations === undefined
      || Array.isArray(detection.associationObservations))
    && (detection.associationOpportunities === undefined
      || Array.isArray(detection.associationOpportunities))
    && (detection.multicomponentAssociationObservations === undefined
      || Array.isArray(detection.multicomponentAssociationObservations))
    && (detection.associationMemberTrackIds === undefined
      || (Array.isArray(detection.associationMemberTrackIds)
        && detection.associationMemberTrackIds.every((trackId) =>
          typeof trackId === 'string' && trackId.length > 0)));
}
