import { describe, expect, it } from 'vitest';
import type { DetectedSignal } from '@tinysa/contracts';
import { agentDetectionResults } from './agent-detection-results.js';

describe('Atom detection-result projection', () => {
  it('separates rolling activity associations from frequency-local detections', () => {
    const local = {
      id: 'signal-local-7',
      state: 'active',
      startHz: 2_441_500_000,
      stopHz: 2_442_500_000,
      peakHz: 2_442_000_000,
      peakDbm: -48,
      bandwidthHz: 1_000_000,
      prominenceDb: 22,
      prominenceThresholdDb: 6,
      persistenceSweeps: 4,
      missedSweeps: 0,
      detectorId: 'bayesian-exponential-multiscale-cfar-v3',
      sweepIds: ['sweep-12'],
      associationMode: 'frequency-local',
      bayesianEvidence: { modelId: 'bayesian-exponential-multiscale-cfar-v3', posteriorSignalProbability: 0.9975 },
    } as unknown as DetectedSignal;
    const activity = {
      ...local,
      id: 'agile-2g4-activity-0001',
      startHz: 2_402_000_000,
      stopHz: 2_480_000_000,
      bandwidthHz: 78_000_000,
      associationMode: 'frequency-agile-2g4-activity',
      associationId: 'agile-2g4-activity-0001',
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationRegionStartHz: 2_402_000_000,
      associationRegionStopHz: 2_480_000_000,
      associationRegionSweepIds: ['sweep-1', 'sweep-12'],
      associationMemberTrackIds: ['signal-local-3', 'signal-local-7'],
      associationGeometryId: '2g4-wide:test',
      associationMissedSweeps: 2,
      associationObservations: [{
        sweepId: 'sweep-12',
        trackId: 'signal-local-7',
        centerHz: 2_442_000_000,
        startHz: 2_441_500_000,
        stopHz: 2_442_500_000,
        rbwHz: 200_000,
        binWidthHz: 200_000,
        detectorId: 'bayesian-exponential-multiscale-cfar-v3',
        localBayesianEvidence: local.bayesianEvidence,
      }],
      associationOpportunities: [
        { sweepId: 'sweep-1', outcome: 'none' },
        { sweepId: 'sweep-12', outcome: 'exactly-one' },
      ],
      associationBayesianEvidence: {
        modelId: 'bayesian-frequency-agile-transition-v3',
        posteriorAgileDynamicsProbability: 0.9942,
        positiveObservationCount: 8,
        opportunityCount: 12,
      },
    } as unknown as DetectedSignal;

    const projected = agentDetectionResults([local, activity]);

    expect(projected.contract).toBe('separated-local-detections-and-activity-associations-v1');
    expect(projected.localDetections).toHaveLength(1);
    expect(projected.localDetections[0]).toMatchObject({
      evidenceKind: 'frequency-local-detection',
      id: 'signal-local-7',
      isPromotedActiveLocalEmission: true,
    });
    expect(projected.activityAssociations).toHaveLength(1);
    expect(projected.activityAssociations[0]).toMatchObject({
      evidenceKind: 'frequency-agile-2g4-activity-association',
      associationId: 'agile-2g4-activity-0001',
      state: 'recent-evidence',
      representsPhysicalEmission: false,
      representsEmitterIdentity: false,
      representsProtocolIdentity: false,
      associationModelId: 'frequency-agile-2g4-activity-v3',
      bayesianAgileDynamicsEvidence: {
        modelId: 'bayesian-frequency-agile-transition-v3',
        posteriorAgileDynamicsProbability: 0.9942,
        positiveObservationCount: 8,
        opportunityCount: 12,
      },
      latestLocalLook: {
        trackId: 'signal-local-7',
        bayesianEvidence: { posteriorSignalProbability: 0.9975 },
      },
    });
    expect(JSON.stringify(projected.activityAssociations[0])).not.toContain('"state":"active"');
  });

  it('retains regular-component association provenance on each physical local line', () => {
    const regular = {
      id: 'line-2',
      state: 'active',
      startHz: 99_000_000,
      stopHz: 99_002_000,
      peakHz: 99_001_000,
      peakDbm: -51,
      bandwidthHz: 2_000,
      prominenceDb: 18,
      prominenceThresholdDb: 6,
      persistenceSweeps: 8,
      missedSweeps: 0,
      detectorId: 'bayesian-exponential-multiscale-cfar-v3',
      sweepIds: ['sweep-8'],
      bayesianEvidence: { modelId: 'bayesian-exponential-multiscale-cfar-v3' },
      associationMode: 'regular-spectral-component-activity',
      associationId: 'regular-lines:line-1,line-2,line-3',
      associationModelId: 'simultaneous-regular-components-v1',
      associationRegionStartHz: 98_000_000,
      associationRegionStopHz: 100_000_000,
      associationRegionSweepIds: ['sweep-8'],
      associationMemberTrackIds: ['line-1', 'line-2', 'line-3'],
      associationMissedSweeps: 0,
    } as unknown as DetectedSignal;

    const projected = agentDetectionResults([regular]);

    expect(projected.activityAssociations).toHaveLength(0);
    expect(projected.localDetections[0]?.classificationAssociation).toMatchObject({
      associationModelId: 'simultaneous-regular-components-v1',
      memberLocalTrackIds: ['line-1', 'line-2', 'line-3'],
      representsEmitterIdentity: false,
    });
  });
});
