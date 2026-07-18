import type {
  AdjacentChannelMeasurement,
  AnalysisModeDefinition,
  ActivityAssociationObservation,
  ChannelMeasurementConfiguration,
  ChannelMeasurementResult,
  DetectedPowerCaptureProjectionKind,
  DetectedPowerCaptureReceipt,
  DetectedSignal,
  EnvelopeStftConfiguration,
  EnvelopeStftResult,
  IntegratedBandPower,
  LocalClassificationRegionObservation,
  MarkerConfiguration,
  MarkerReading,
  MarkerSearchAction,
  MarkerSearchConfiguration,
  MulticomponentSweptRegionAssociationObservation,
  RegularSpectralComponentAssociationObservation,
  SignalDetectionConfig,
  SpectrumDisplayConfiguration,
  Sweep,
  TraceBankConfiguration,
  TraceConfiguration,
  TraceFrame,
  TraceId,
  WaveformClassification,
  ZeroSpanCapture,
} from '@tinysa/contracts';
import {
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  traceIdSchema,
} from '@tinysa/contracts';
import { measurementIdentityKey } from './measurement-provenance.js';
export { isInstrumentMeasurementIdentity, measurementIdentityKey, sameMeasurementIdentity } from './measurement-provenance.js';
import {
  BAYESIAN_DETECTOR_MODEL,
  analyzeBayesianSweep,
  bayesianDetectionEvidenceMatches,
  compactBayesianEvidenceSweep,
} from './bayesian-signal-detector.js';
export { BAYESIAN_DETECTOR_MODEL } from './bayesian-signal-detector.js';
import {
  BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL,
  bayesianFrequencyAgileActivityEvidence,
  bayesianFrequencyAgileActivityQualifies,
} from './bayesian-agile-association.js';
import {
  FREQUENCY_AGILE_BAND_START_HZ,
  FREQUENCY_AGILE_BAND_STOP_HZ,
  FREQUENCY_AGILE_MAXIMUM_COMPONENT_BANDWIDTH_HZ,
  frequencyAgileGeometryId,
  frequencyAgileSequentialOpportunity,
  frequencyAgileStrictlyOrderedOpportunity,
  frequencyAgileSweepEligible,
  frequencyAgileSweepGeometryCompatible,
} from './frequency-agile-geometry.js';
import {
  MULTICOMPONENT_SWEPT_REGION_MODEL_ID,
  multicomponentSweepBinWidthHz,
  multicomponentSweepGeometryId,
  multicomponentSweptRegionAssociations,
  multicomponentSweptRegionLineagesAreCompatible,
  type MulticomponentSweptRegionAssociation,
} from './multicomponent-swept-region.js';
import {
  REGULAR_SPECTRAL_COMPONENT_MODEL_ID,
  regularSpectralComponentLineageId,
  regularSpectralComponentLineagesAreCompatible,
  regularSpectralComponentAssociations,
  type RegularSpectralComponentAssociation,
} from './regular-spectral-component.js';
import {
  SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
} from './observable-training-acquisition-geometry.js';
import {
  detectedPowerCapturePayloadSha256,
  DETECTED_POWER_CAPTURE_RUNTIME_ADMISSION_POLICY_ID,
  issueDetectedPowerCaptureReceipt,
  trustedDetectedPowerCaptureSnapshot,
} from './detected-power-capture-receipt.js';
import {
  extractObservableFeatures,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
} from './observable-features.js';
import { measureThreeDecibelBandwidth } from './channel-bandwidth.js';
import { characterizeMarkerLocalTrace, selectMarkerCenterOnTrace } from './marker-characterization.js';
import {
  classificationCaptureTargetRankEvidence,
  compareClassificationCaptureTargetRankEvidence,
} from './classification-target-ranking.js';
export { measureThreeDecibelBandwidth, measureTraceThreeDecibelBandwidth } from './channel-bandwidth.js';
export { characterizeMarkerLocalTrace, selectMarkerCenterOnTrace } from './marker-characterization.js';
export {
  CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL,
  classificationCaptureTargetRankEvidence,
  compareClassificationCaptureTargetRankEvidence,
  type ClassificationCaptureTargetRankEvidence,
} from './classification-target-ranking.js';

export const analysisModes: readonly AnalysisModeDefinition[] = [
  { id: 'signal-detection', name: 'Signal Detection', description: 'Detect and persist emissions above an absolute threshold or a lower-tail adaptive candidate baseline.', status: 'available', requiredCapabilities: ['scan'] },
  { id: 'waveform-classification', name: 'Waveform Classification', description: 'Classify observable spectral morphology and zero-span envelope behavior with explicit unknown results.', status: 'experimental', requiredCapabilities: ['scan'] },
];

const DEFAULT_DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};

export const BAYESIAN_TRACK_MODEL = {
  id: 'bayesian-two-state-track-filter-v1',
  probabilitySignalPersists: 0.92,
  probabilitySignalAppears: 0.01,
} as const;

export class SignalDetector {
  static readonly id = BAYESIAN_DETECTOR_MODEL.id;
  constructor(private config: SignalDetectionConfig = DEFAULT_DETECTION_CONFIG) {}
  configure(config: SignalDetectionConfig): void { this.config = structuredClone(config); }
  get configuration(): SignalDetectionConfig { return structuredClone(this.config); }

  analyze(sweep: Sweep): readonly DetectedSignal[] {
    return analyzeBayesianSweep(sweep, this.config);
  }
}

interface Track { signal: DetectedSignal; released: boolean; consecutiveDetectionSweeps: number; }
interface FrequencyAgileActivityObservation extends ActivityAssociationObservation {
  signal: DetectedSignal;
  sweep: Sweep;
}
interface FrequencyAgileActivityOpportunity {
  sweep: Sweep;
  outcome: 'none' | 'exactly-one' | 'ambiguous';
  observation?: FrequencyAgileActivityObservation;
}
interface FrequencyAgileActivity {
  id: string;
  opportunities: readonly FrequencyAgileActivityOpportunity[];
  promoted: boolean;
}

export class SignalTracker {
  #tracks = new Map<string, Track>();
  #frequencyAgileActivity?: FrequencyAgileActivity;
  #nextId = 1;
  #nextAssociationId = 1;
  constructor(private config: SignalDetectionConfig = DEFAULT_DETECTION_CONFIG) {}

  configure(config: SignalDetectionConfig): void {
    this.config = structuredClone(config);
    this.reset();
  }

  // Keep the monotonically increasing ID counter across evidence resets so a
  // cached capture can never become valid again merely because "signal-0001"
  // was recycled for a different event.
  reset(): void {
    this.#tracks.clear();
    this.#frequencyAgileActivity = undefined;
  }

  update(sweep: Sweep, candidates: readonly DetectedSignal[]): readonly DetectedSignal[] {
    validateSweep(sweep);
    const previousAgileOpportunity = this.#frequencyAgileActivity?.opportunities.at(-1)?.sweep;
    if (previousAgileOpportunity
      && frequencyAgileSweepEligible(sweep)
      && !frequencyAgileStrictlyOrderedOpportunity(previousAgileOpportunity, sweep)) {
      throw new Error('Frequency-agile association requires strictly ordered unique sweep provenance');
    }
    const unmatchedTracks = new Set(this.#tracks.keys());
    const usedCandidates = new Set<number>();
    const candidateTrackIds = new Map<number, string>();
    const matches: Array<{ trackId: string; candidateIndex: number; score: number }> = [];
    for (const [trackId, track] of this.#tracks) {
      candidates.forEach((candidate, candidateIndex) => {
        const score = matchScore(track.signal, candidate, sweep);
        if (score >= 0) matches.push({ trackId, candidateIndex, score });
      });
    }
    matches.sort((left, right) => right.score - left.score);
    for (const match of matches) {
      if (!unmatchedTracks.has(match.trackId) || usedCandidates.has(match.candidateIndex)) continue;
      const track = this.#tracks.get(match.trackId)!;
      track.consecutiveDetectionSweeps += 1;
      track.signal = mergeSignal(
        track.signal,
        candidates[match.candidateIndex]!,
        sweep,
        this.config,
        track.consecutiveDetectionSweeps,
      );
      track.released = false;
      unmatchedTracks.delete(match.trackId);
      usedCandidates.add(match.candidateIndex);
      candidateTrackIds.set(match.candidateIndex, match.trackId);
    }

    candidates.forEach((candidate, index) => {
      if (usedCandidates.has(index)) return;
      const id = `signal-${String(this.#nextId++).padStart(4, '0')}`;
      const admissionObservation = localClassificationAdmissionObservation(candidate, sweep);
      this.#tracks.set(id, {
        released: false,
        consecutiveDetectionSweeps: 1,
        signal: {
          ...candidate,
          id,
          state: this.config.minimumConsecutiveSweeps <= 1 ? 'active' : 'candidate',
          detectorConfig: structuredClone(this.config),
          classificationRegionSweepIds: [sweep.id],
          classificationRegionObservation: admissionObservation,
          localClassificationObservations: [admissionObservation],
        },
      });
      candidateTrackIds.set(index, id);
    });

    for (const trackId of unmatchedTracks) {
      const track = this.#tracks.get(trackId)!;
      track.consecutiveDetectionSweeps = 0;
      const missedSweeps = track.signal.missedSweeps + 1;
      const posteriorSignalProbability = predictTrackPosterior(track.signal.bayesianEvidence.posteriorSignalProbability);
      const logBayesFactor = equivalentLogBayesFactor(posteriorSignalProbability);
      if (missedSweeps > this.config.releaseAfterMissedSweeps) {
        track.signal = { ...track.signal, missedSweeps, state: 'released', bayesianEvidence: { ...track.signal.bayesianEvidence, posteriorScope: 'track-predictive-state', posteriorSignalProbability, logBayesFactor } };
        track.released = true;
      } else {
        track.signal = { ...track.signal, missedSweeps, bayesianEvidence: { ...track.signal.bayesianEvidence, posteriorScope: 'track-predictive-state', posteriorSignalProbability, logBayesFactor } };
      }
    }

    // This association is classification provenance only. Every member has
    // already passed the ordinary multiplicity-adjusted detector and retains
    // its own frequency-local track; the association cannot create detections,
    // increase persistence, or merge emitter identities. Repeated same-sweep
    // co-occurrence is recorded separately and the classifier still requires
    // its exact eight admitted association sweeps.
    const refreshedStaticRegionAssociationTrackIds = new Set<string>();
    const priorRegularLineages = new Map<string, DetectedSignal>();
    const priorMulticomponentLineages = new Map<string, DetectedSignal>();
    for (const { signal } of this.#tracks.values()) {
      if (!signal.associationId) continue;
      if (signal.associationMode === 'regular-spectral-component-activity'
        && signal.associationModelId === REGULAR_SPECTRAL_COMPONENT_MODEL_ID
        && (signal.associationMissedSweeps ?? 0)
          <= this.config.releaseAfterMissedSweeps) {
        const previous = priorRegularLineages.get(signal.associationId);
        if (!previous || (signal.regularComponentAssociationObservations?.length ?? 0)
          > (previous.regularComponentAssociationObservations?.length ?? 0)) {
          priorRegularLineages.set(signal.associationId, signal);
        }
      }
      if (signal.associationMode === 'multicomponent-swept-region-activity'
        && signal.associationModelId === MULTICOMPONENT_SWEPT_REGION_MODEL_ID
        && Number.isInteger(signal.associationMissedSweeps)
        && signal.associationMissedSweeps! >= 0
        && signal.associationMissedSweeps!
          <= this.config.releaseAfterMissedSweeps) {
        const previous = priorMulticomponentLineages.get(signal.associationId);
        if (!previous || (signal.multicomponentAssociationObservations?.length ?? 0)
          > (previous.multicomponentAssociationObservations?.length ?? 0)) {
          priorMulticomponentLineages.set(signal.associationId, signal);
        }
      }
    }
    const usedRegularLineageIds = new Set<string>();
    for (const association of regularSpectralComponentAssociations(candidates, sweep)) {
      const memberTrackIds = association.candidateIndices
        .map((candidateIndex) => candidateTrackIds.get(candidateIndex))
        .filter((trackId): trackId is string => trackId !== undefined)
        .sort();
      if (memberTrackIds.length !== association.candidateIndices.length) continue;
      const memberTracks = memberTrackIds.map((trackId) => this.#tracks.get(trackId));
      if (memberTracks.some((track) => !track)) continue;
      const associationObservation = regularComponentAssociationObservation(
        association,
        candidates,
        candidateTrackIds,
        sweep,
      );
      if (!associationObservation) continue;
      if (memberTracks.some((track) =>
        track!.signal.associationMode === 'multicomponent-swept-region-activity')) continue;
      const compatibleExisting = [...priorRegularLineages.values()]
        .filter((signal) => !usedRegularLineageIds.has(signal.associationId!)
          && regularAssociationLineageCompatible(
            signal,
            associationObservation,
            this.config.releaseAfterMissedSweeps,
          ))
        .sort((left, right) => (right.regularComponentAssociationObservations?.length ?? 0)
          - (left.regularComponentAssociationObservations?.length ?? 0)
          || left.associationId!.localeCompare(right.associationId!));
      const existing = compatibleExisting[0];
      const associationId = existing?.associationId
        ?? regularSpectralComponentLineageId(this.#nextAssociationId++);
      usedRegularLineageIds.add(associationId);
      const retainedAssociationObservations =
        (existing?.regularComponentAssociationObservations ?? []).filter((observation) =>
          multicomponentSweepGeometryId(observation.sourceSweep)
            === multicomponentSweepGeometryId(associationObservation.sourceSweep)
          && regularSpectralComponentLineagesAreCompatible(
            {
              startHz: observation.observedRegionStartHz,
              stopHz: observation.observedRegionStopHz,
              spacingHz: observation.spacingHz,
              latticeAnchorHz: observation.latticeAnchorHz,
              memberCentersHz: observation.members.map(
                (member) => (member.startHz + member.stopHz) / 2,
              ),
            },
            {
              startHz: associationObservation.observedRegionStartHz,
              stopHz: associationObservation.observedRegionStopHz,
              spacingHz: associationObservation.spacingHz,
              latticeAnchorHz: associationObservation.latticeAnchorHz,
              memberCentersHz: associationObservation.members.map(
                (member) => (member.startHz + member.stopHz) / 2,
              ),
            },
            sweep.actualRbwHz,
            multicomponentSweepBinWidthHz(sweep),
          ));
      const regularComponentAssociationObservations = [
        ...retainedAssociationObservations,
        associationObservation,
      // The production classifier consumes exactly eight association looks.
      // Retaining that complete replay window avoids quadratic revalidation
      // of older looks that can never enter a classification.
      ].slice(-8);
      const associationRegionSweepIds = regularComponentAssociationObservations.map(
        (observation) => observation.sourceSweep.id,
      );
      for (const track of memberTracks) {
        const signal = track!.signal;
        track!.signal = {
          ...signal,
          associationMode: 'regular-spectral-component-activity',
          associationRegionStartHz: association.startHz,
          associationRegionStopHz: association.stopHz,
          associationRegionSweepIds,
          associationId,
          associationModelId: REGULAR_SPECTRAL_COMPONENT_MODEL_ID,
          associationMemberTrackIds: memberTrackIds,
          regularComponentAssociationObservations,
          associationMissedSweeps: 0,
        };
        refreshedStaticRegionAssociationTrackIds.add(signal.id);
      }
    }

    // A swept receiver can turn periodic on/off activity into a run of narrow,
    // approximately equally spaced threshold components across frequency.
    // Preserve every local detection, but bind the current complete observed
    // region into a bounded-overlap lineage for one classifier hypothesis. The
    // public region always follows the latest admitted hull. This is neither an
    // emitter identity nor a claim that components are simultaneous/common.
    const usedMulticomponentLineageIds = new Set<string>();
    for (const association of multicomponentSweptRegionAssociations(candidates, sweep)) {
      const memberTrackIds = association.candidateIndices
        .map((candidateIndex) => candidateTrackIds.get(candidateIndex))
        .filter((trackId): trackId is string => trackId !== undefined)
        .sort();
      if (memberTrackIds.length !== association.candidateIndices.length) continue;
      const memberTracks = memberTrackIds.map((trackId) => this.#tracks.get(trackId));
      if (memberTracks.some((track) => !track)) continue;
      const associationObservation = multicomponentAssociationObservation(
        association,
        candidates,
        candidateTrackIds,
        sweep,
      );
      if (!associationObservation) continue;
      if (memberTracks.some((track) => track!.signal.associationMode === 'regular-spectral-component-activity')) continue;
      const compatibleExisting = [...priorMulticomponentLineages.values()]
        .filter((signal) => !usedMulticomponentLineageIds.has(signal.associationId!)
          && multicomponentAssociationLineageCompatible(
            signal,
            associationObservation,
            this.config.releaseAfterMissedSweeps,
          ))
        .sort((left, right) => (right.associationRegionSweepIds?.length ?? 0)
          - (left.associationRegionSweepIds?.length ?? 0)
          || left.associationId!.localeCompare(right.associationId!));
      const existing = compatibleExisting[0];
      const associationId = existing?.associationId
        ?? `multicomponent-swept-region-${String(this.#nextAssociationId++).padStart(4, '0')}`;
      usedMulticomponentLineageIds.add(associationId);
      const retainedAssociationObservations = (existing?.multicomponentAssociationObservations ?? [])
        .filter((observation) => multicomponentSweptRegionLineagesAreCompatible(
          multicomponentObservationLineageShape(observation),
          multicomponentObservationLineageShape(associationObservation),
        ));
      const multicomponentAssociationObservations = [
        ...retainedAssociationObservations,
        associationObservation,
      // The production classifier consumes exactly eight association looks.
      // Older morphology is not current evidence and must not be able to veto
      // the immutable latest exact replay window.
      ].slice(-8);
      const associationRegionSweepIds = multicomponentAssociationObservations.map(
        (observation) => observation.sweepId,
      );
      for (const track of memberTracks) {
        const signal = track!.signal;
        track!.signal = {
          ...signal,
          associationMode: 'multicomponent-swept-region-activity',
          associationRegionStartHz: association.startHz,
          associationRegionStopHz: association.stopHz,
          associationRegionSweepIds,
          associationId,
          associationModelId: MULTICOMPONENT_SWEPT_REGION_MODEL_ID,
          associationMemberTrackIds: memberTrackIds,
          multicomponentAssociationObservations,
          associationMissedSweeps: 0,
        };
        refreshedStaticRegionAssociationTrackIds.add(signal.id);
      }
    }

    // Association state has its own miss/release hysteresis. Expiry removes
    // only the classification provenance; the independently detected local
    // track and its ordinary persistence remain untouched.
    for (const [trackId, track] of this.#tracks) {
      if (!isStaticRegionAssociation(track.signal.associationMode)
        || refreshedStaticRegionAssociationTrackIds.has(trackId)) continue;
      const associationMissedSweeps = (track.signal.associationMissedSweeps ?? 0) + 1;
      track.signal = associationMissedSweeps > this.config.releaseAfterMissedSweeps
        ? clearStaticRegionAssociation(track.signal)
        : { ...track.signal, associationMissedSweeps };
    }

    this.#updateFrequencyAgileActivity(sweep, candidates, candidateTrackIds);
    const result = [...this.#tracks.values()].map((track) => structuredClone(track.signal));
    const frequencyAgileRepresentative = this.#frequencyAgileRepresentative();
    if (frequencyAgileRepresentative) result.push(frequencyAgileRepresentative);
    for (const [trackId, track] of this.#tracks) if (track.released) this.#tracks.delete(trackId);
    return result.sort((left, right) => right.peakDbm - left.peakDbm);
  }

  #updateFrequencyAgileActivity(
    sweep: Sweep,
    candidates: readonly DetectedSignal[],
    candidateTrackIds: ReadonlyMap<number, string>,
  ): void {
    if (!frequencyAgileSweepEligible(sweep)) {
      this.#frequencyAgileActivity = undefined;
      return;
    }
    const existing = this.#frequencyAgileActivity;
    if (existing && (!frequencyAgileSweepGeometryCompatible(existing.opportunities.at(-1)!.sweep, sweep)
      || !frequencyAgileSequentialOpportunity(existing.opportunities.at(-1)!.sweep, sweep))) {
      this.#frequencyAgileActivity = undefined;
    }
    const bandCandidates = candidates.filter((candidate) => candidate.stopHz >= FREQUENCY_AGILE_BAND_START_HZ
      && candidate.startHz <= FREQUENCY_AGILE_BAND_STOP_HZ);
    const eligible = candidates.flatMap((candidate, candidateIndex) => {
      const trackId = candidateTrackIds.get(candidateIndex);
      const track = trackId ? this.#tracks.get(trackId) : undefined;
      // Agile opportunity outcomes describe this sweep's immutable detector
      // population. A matched local track may still carry regular or
      // multicomponent provenance from an earlier look while that association
      // ages out. Letting that history censor the current detector candidate
      // makes the recorded outcome impossible to reproduce from the cited
      // sweep, so require only a live track binding here.
      if (!trackId || !track || !frequencyAgileObservationEligible(candidate, sweep)) return [];
      const binWidthHz = median(sweep.frequencyHz.slice(1).map((frequency, index) => frequency - sweep.frequencyHz[index]!));
      const centerHz = boundedFrequencyAgileCenter(candidate);
      const startHz = Math.min(centerHz, Math.max(sweep.actualStartHz, candidate.startHz - binWidthHz / 2));
      const stopHz = Math.max(centerHz, Math.min(sweep.actualStopHz, candidate.stopHz + binWidthHz / 2));
      return [{
        sweepId: sweep.id,
        trackId,
        centerHz,
        startHz,
        stopHz,
        rbwHz: sweep.actualRbwHz,
        binWidthHz,
        detectorId: candidate.detectorId,
        localBayesianEvidence: structuredClone(candidate.bayesianEvidence),
        signal: structuredClone(candidate),
        sweep,
      } satisfies FrequencyAgileActivityObservation];
    });
    // Exactly one means exactly one admitted detector component anywhere in
    // the modeled band, and that component must be a qualifying narrow local
    // look. Wideband Wi-Fi, regular combs, and any simultaneous/mixed activity
    // are explicitly censored so their energy cannot be attributed to an
    // invented agile emitter.
    const observation = bandCandidates.length === 1 && eligible.length === 1 ? eligible[0] : undefined;
    const opportunity: FrequencyAgileActivityOpportunity = {
      sweep,
      outcome: bandCandidates.length === 0 ? 'none' : observation ? 'exactly-one' : 'ambiguous',
      ...(observation ? { observation } : {}),
    };
    const activity = this.#frequencyAgileActivity;
    if (!activity && !observation) return;
    if (!activity) {
      this.#frequencyAgileActivity = {
        id: `agile-2g4-activity-${String(this.#nextAssociationId++).padStart(4, '0')}`,
        opportunities: [opportunity],
        promoted: false,
      };
      return;
    }
    const opportunities = [...activity.opportunities, opportunity]
      .slice(-BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.maximumOpportunityWindow);
    const observations = opportunities.flatMap((item) => item.observation ? [item.observation] : []);
    if (!observations.length) {
      this.#frequencyAgileActivity = undefined;
      return;
    }
    const evidence = bayesianFrequencyAgileActivityEvidence(observations, opportunities.length);
    this.#frequencyAgileActivity = {
      ...activity,
      opportunities,
      promoted: bayesianFrequencyAgileActivityQualifies(evidence, activity.promoted),
    };
  }

  #frequencyAgileRepresentative(): DetectedSignal | undefined {
    const activity = this.#frequencyAgileActivity;
    if (!activity?.promoted) return undefined;
    const observations = activity.opportunities.flatMap((item) => item.observation ? [item.observation] : []);
    const latest = observations.at(-1)!;
    const associationObservations: readonly ActivityAssociationObservation[] = observations.map(({
      sweepId, trackId, centerHz, startHz, stopHz, rbwHz, binWidthHz, detectorId, localBayesianEvidence,
    }) => ({
      sweepId,
      trackId,
      centerHz,
      startHz,
      stopHz,
      rbwHz,
      binWidthHz,
      detectorId,
      localBayesianEvidence: structuredClone(localBayesianEvidence),
    }));
    const associationOpportunities = activity.opportunities.map((item) => ({
      sweepId: item.sweep.id,
      outcome: item.outcome,
    }));
    const associationBayesianEvidence = bayesianFrequencyAgileActivityEvidence(
      associationObservations,
      associationOpportunities.length,
    );
    const latestPositiveOpportunityIndex = associationOpportunities.map((item) => item.outcome).lastIndexOf('exactly-one');
    const regionStartHz = Math.max(
      FREQUENCY_AGILE_BAND_START_HZ,
      ...activity.opportunities.map((item) => item.sweep.actualStartHz),
    );
    const regionStopHz = Math.min(
      FREQUENCY_AGILE_BAND_STOP_HZ,
      ...activity.opportunities.map((item) => item.sweep.actualStopHz),
    );
    if (regionStopHz <= regionStartHz) return undefined;
    return {
      ...structuredClone(latest.signal),
      id: activity.id,
      firstSeenAt: observations[0]!.signal.firstSeenAt,
      lastSeenAt: latest.signal.lastSeenAt,
      // This synthetic classification representative carries no combined
      // local-track persistence or posterior. Its multi-look evidence is
      // disclosed only through the association provenance below.
      sweepIds: [latest.sweepId],
      persistenceSweeps: 1,
      missedSweeps: 0,
      state: 'active',
      associationMode: 'frequency-agile-2g4-activity',
      associationRegionStartHz: regionStartHz,
      associationRegionStopHz: regionStopHz,
      associationRegionSweepIds: associationObservations.map((observation) => observation.sweepId),
      associationId: activity.id,
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationMemberTrackIds: [...new Set(associationObservations.map((observation) => observation.trackId))],
      associationObservations,
      associationOpportunities,
      associationBayesianEvidence,
      associationGeometryId: frequencyAgileGeometryId(activity.opportunities[0]!.sweep),
      associationMissedSweeps: associationOpportunities.length - latestPositiveOpportunityIndex - 1,
    };
  }
}

/**
 * Return every frequency-local track and exactly one representative for each
 * separately disclosed classification association. Agile activity is not an
 * emitter-identity claim, so its local members remain independent classifier
 * inputs rather than being silently suppressed.
 */
export function classificationRepresentatives(
  signals: readonly DetectedSignal[],
  preferredDetectionId?: string,
): readonly DetectedSignal[] {
  const chosenByAssociation = new Map<string, DetectedSignal>();
  for (const signal of signals) {
    if (signal.associationMode === undefined || signal.associationMode === 'frequency-local' || !signal.associationId) continue;
    const existing = chosenByAssociation.get(signal.associationId);
    if (!existing || betterAssociationRepresentative(signal, existing, preferredDetectionId)) {
      chosenByAssociation.set(signal.associationId, signal);
    }
  }
  return signals.filter((signal) => {
    if (signal.associationMode === undefined || signal.associationMode === 'frequency-local' || !signal.associationId) return true;
    return chosenByAssociation.get(signal.associationId)?.id === signal.id;
  }).sort((left, right) => classificationRepresentativeKey(left).localeCompare(
    classificationRepresentativeKey(right),
  ));
}

export const CLASSIFICATION_CAPTURE_TARGET_SELECTION_POLICY_ID =
  SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID;

/**
 * The one shared population that may be drawn or selected as a physical
 * detected-power target. Tracker hysteresis rows, pre-promotion candidates,
 * released rows, and synthetic frequency-agile activity summaries remain
 * evidence, but they are not current physical emitters.
 */
export function currentVisiblePhysicalClassificationRows(
  detections: readonly DetectedSignal[],
): readonly DetectedSignal[] {
  return detections.filter((detection) => detection.state === 'active'
    && detection.missedSweeps === 0
    && detection.associationMode !== 'frequency-agile-2g4-activity');
}

export type ClassificationCaptureTargetProjectionKind =
  DetectedPowerCaptureProjectionKind;

/**
 * Two-object actuation/evidence projection used by detected-power capture.
 * `rawTarget` is always the physical frequency-local row that owns the tune and
 * capture. `projectedRepresentative` owns the classifier evidence. They are the
 * same object for an ordinary active physical row. They differ only when the
 * raw row is the exact latest member of a current, fully qualified agile view.
 */
export interface ClassificationCaptureTargetProjection {
  readonly rawTarget: DetectedSignal;
  readonly projectedRepresentative: DetectedSignal;
  readonly projectionKind: ClassificationCaptureTargetProjectionKind;
}

/**
 * Rank physical detected-power targets without collapsing away their tune
 * identity. Ordinary targets must be active with zero misses. A one-look
 * candidate is admitted only through the exact latest-member binding of a
 * promotion-qualified, zero-miss agile association; arbitrary candidates and
 * synthetic association summaries can never own a capture.
 */
export function classificationCaptureTargetProjections(
  signals: readonly DetectedSignal[],
  preferredDetectionId?: string,
): readonly ClassificationCaptureTargetProjection[] {
  const occurrenceCountById = new Map<string, number>();
  for (const signal of signals) {
    occurrenceCountById.set(signal.id, (occurrenceCountById.get(signal.id) ?? 0) + 1);
  }

  const projectionByRawTargetId = new Map<string, ClassificationCaptureTargetProjection>();
  for (const rawTarget of currentVisiblePhysicalClassificationRows(signals)) {
    if (occurrenceCountById.get(rawTarget.id) !== 1) continue;
    projectionByRawTargetId.set(rawTarget.id, {
      rawTarget,
      projectedRepresentative: rawTarget,
      projectionKind: 'current-active-physical-representative',
    });
  }

  const agileProjectionsByRawTargetId = new Map<
    string,
    ClassificationCaptureTargetProjection[]
  >();
  for (const projectedRepresentative of signals) {
    const projection = currentQualifiedAgileLatestMemberProjection(
      signals,
      occurrenceCountById,
      projectedRepresentative,
    );
    if (!projection) continue;
    const existing = agileProjectionsByRawTargetId.get(projection.rawTarget.id) ?? [];
    existing.push(projection);
    agileProjectionsByRawTargetId.set(projection.rawTarget.id, existing);
  }
  for (const [rawTargetId, projections] of agileProjectionsByRawTargetId) {
    // More than one association claiming the same current member is ambiguous.
    // Keep an independently active physical row local, but never project the
    // synthetic association under that contradiction.
    if (projections.length === 1) projectionByRawTargetId.set(rawTargetId, projections[0]!);
  }

  const rankPopulation = [...projectionByRawTargetId.values()].map((projection) => ({
    projection,
    rankEvidence: classificationCaptureTargetRankEvidence(projection.rawTarget),
  }));
  // Automatic selection is a ranking of the complete eligible population.
  // Silently deleting a row with stale/mismatched source evidence would make a
  // weaker row look like rank 0, which is the same forbidden fallback as
  // skipping an unready winner after ranking.
  if (rankPopulation.some(({ rankEvidence }) => rankEvidence === undefined)) return [];
  const ranked = rankPopulation
    .sort((left, right) =>
      compareClassificationCaptureTargetRankEvidence(
        left.rankEvidence,
        right.rankEvidence,
      )
      || classificationRepresentativeKey(left.projection.rawTarget).localeCompare(
        classificationRepresentativeKey(right.projection.rawTarget),
      )
      || left.projection.rawTarget.id.localeCompare(right.projection.rawTarget.id))
    .map(({ projection }) => projection);
  return preferredDetectionId === undefined
    ? ranked
    : ranked.filter((projection) => projection.rawTarget.id === preferredDetectionId);
}

/** Compatibility projection for callers that consume classifier rows only. */
export function classificationCaptureTargetRepresentatives(
  signals: readonly DetectedSignal[],
  preferredDetectionId?: string,
): readonly DetectedSignal[] {
  return classificationCaptureTargetProjections(signals, preferredDetectionId)
    .map((projection) => projection.projectedRepresentative);
}

function currentQualifiedAgileLatestMemberProjection(
  signals: readonly DetectedSignal[],
  occurrenceCountById: ReadonlyMap<string, number>,
  projectedRepresentative: DetectedSignal,
): ClassificationCaptureTargetProjection | undefined {
  if (projectedRepresentative.state !== 'active'
    || projectedRepresentative.missedSweeps !== 0
    || projectedRepresentative.associationMode !== 'frequency-agile-2g4-activity'
    || projectedRepresentative.associationMissedSweeps !== 0
    || !observableAssociationEvidenceIsCurrentlyQualified(projectedRepresentative)) {
    return undefined;
  }
  const latestOpportunity = projectedRepresentative.associationOpportunities?.at(-1);
  const latestObservation = projectedRepresentative.associationObservations?.at(-1);
  if (!latestOpportunity
    || latestOpportunity.outcome !== 'exactly-one'
    || !latestObservation
    || latestOpportunity.sweepId !== latestObservation.sweepId
    || projectedRepresentative.associationRegionSweepIds?.at(-1)
      !== latestObservation.sweepId
    || projectedRepresentative.sweepIds.length !== 1
    || projectedRepresentative.sweepIds[0] !== latestObservation.sweepId
    || occurrenceCountById.get(latestObservation.trackId) !== 1) {
    return undefined;
  }
  const rawTarget = signals.find((signal) => signal.id === latestObservation.trackId);
  if (!rawTarget
    || (rawTarget.state !== 'candidate' && rawTarget.state !== 'active')
    || rawTarget.missedSweeps !== 0
    || rawTarget.associationMode === 'frequency-agile-2g4-activity'
    || rawTarget.sweepIds.at(-1) !== latestObservation.sweepId
    || rawTarget.lastSeenAt !== projectedRepresentative.lastSeenAt
    || rawTarget.startHz !== projectedRepresentative.startHz
    || rawTarget.stopHz !== projectedRepresentative.stopHz
    || rawTarget.peakHz !== projectedRepresentative.peakHz
    || rawTarget.peakDbm !== projectedRepresentative.peakDbm
    || rawTarget.bandwidthHz !== projectedRepresentative.bandwidthHz
    || rawTarget.detectorId !== projectedRepresentative.detectorId) {
    return undefined;
  }
  const latestRawLocalObservation = rawTarget.localClassificationObservations?.at(-1);
  const latestRepresentativeLocalObservation =
    projectedRepresentative.localClassificationObservations?.at(-1)
      ?? projectedRepresentative.classificationRegionObservation;
  if (!latestRawLocalObservation
    || !latestRepresentativeLocalObservation
    || !sameCaptureProjectionLocalObservation(
      latestRawLocalObservation,
      latestRepresentativeLocalObservation,
    )) {
    return undefined;
  }
  const sourceSweep = latestRawLocalObservation.sourceSweep;
  let binWidthHz: number;
  try {
    validateSweep(sourceSweep);
    binWidthHz = nominalBinWidth(sourceSweep.frequencyHz);
  } catch {
    return undefined;
  }
  const expectedCenterHz = Math.max(
    FREQUENCY_AGILE_BAND_START_HZ,
    Math.min(
      FREQUENCY_AGILE_BAND_STOP_HZ,
      (latestRawLocalObservation.startHz + latestRawLocalObservation.stopHz) / 2,
    ),
  );
  const expectedStartHz = Math.min(
    expectedCenterHz,
    Math.max(sourceSweep.actualStartHz, latestRawLocalObservation.startHz - binWidthHz / 2),
  );
  const expectedStopHz = Math.max(
    expectedCenterHz,
    Math.min(sourceSweep.actualStopHz, latestRawLocalObservation.stopHz + binWidthHz / 2),
  );
  if (sourceSweep.id !== latestObservation.sweepId
    || sourceSweep.capturedAt !== rawTarget.lastSeenAt
    || latestRawLocalObservation.startHz !== rawTarget.startHz
    || latestRawLocalObservation.stopHz !== rawTarget.stopHz
    || latestRawLocalObservation.peakHz !== rawTarget.peakHz
    || latestRawLocalObservation.detectorId !== rawTarget.detectorId
    || latestObservation.detectorId !== latestRawLocalObservation.detectorId
    || latestObservation.centerHz !== expectedCenterHz
    || latestObservation.startHz !== expectedStartHz
    || latestObservation.stopHz !== expectedStopHz
    || latestObservation.rbwHz !== sourceSweep.actualRbwHz
    || latestObservation.binWidthHz !== binWidthHz
    || !bayesianDetectionEvidenceMatches(
      latestObservation.localBayesianEvidence,
      latestRawLocalObservation.localBayesianEvidence,
    )) {
    return undefined;
  }
  return {
    rawTarget,
    projectedRepresentative,
    projectionKind: 'current-qualified-agile-latest-member',
  };
}

function sameCaptureProjectionLocalObservation(
  left: LocalClassificationRegionObservation,
  right: LocalClassificationRegionObservation,
): boolean {
  return left.startHz === right.startHz
    && left.stopHz === right.stopHz
    && left.peakHz === right.peakHz
    && left.detectorId === right.detectorId
    && left.sourceSweep.id === right.sourceSweep.id
    && left.sourceSweep.sequence === right.sourceSweep.sequence
    && left.sourceSweep.capturedAt === right.sourceSweep.capturedAt
    && left.sourceSweep.actualStartHz === right.sourceSweep.actualStartHz
    && left.sourceSweep.actualStopHz === right.sourceSweep.actualStopHz
    && left.sourceSweep.actualRbwHz === right.sourceSweep.actualRbwHz
    && left.sourceSweep.frequencyHz.length === right.sourceSweep.frequencyHz.length
    && left.sourceSweep.frequencyHz.every(
      (frequencyHz, index) => frequencyHz === right.sourceSweep.frequencyHz[index],
    )
    && left.sourceSweep.powerDbm.length === right.sourceSweep.powerDbm.length
    && left.sourceSweep.powerDbm.every(
      (powerDbm, index) => powerDbm === right.sourceSweep.powerDbm[index],
    )
    && bayesianDetectionEvidenceMatches(
      left.localBayesianEvidence,
      right.localBayesianEvidence,
    );
}

export interface DetectedPowerCaptureReceiptRequest {
  /** Contemporaneous raw tracker rows, before physical-target admission and association collapse. */
  readonly activeSignals: readonly DetectedSignal[];
  /** Complete scalar history from which runtime admission is independently replayed. */
  readonly evidenceSweeps: readonly Sweep[];
  /** Present only when the operator explicitly selected a raw tracker target. */
  readonly preferredDetectionId?: string;
  readonly capture: ZeroSpanCapture;
  /** Exact controller-projected tune admitted for the selected raw target. */
  readonly admittedTargetTuneHz: number;
  /** Exact newest-first scalar classifier window frozen before capture. */
  readonly spectrumSweepIds: readonly string[];
}

/**
 * Mint an immutable, runtime-opaque receipt proving which contemporaneous raw
 * tracker row won the deployed capture-target policy and which classifier
 * representative that physical target projects to.
 */
export function createDetectedPowerCaptureReceipt({
  activeSignals,
  evidenceSweeps,
  preferredDetectionId,
  capture: callerCapture,
  admittedTargetTuneHz,
  spectrumSweepIds,
}: DetectedPowerCaptureReceiptRequest): DetectedPowerCaptureReceipt {
  const capture = trustedDetectedPowerCaptureSnapshot(callerCapture);
  const rankedProjections = classificationCaptureTargetProjections(activeSignals);
  if (rankedProjections.length === 0) {
    throw new Error(
      'Detected-power capture receipt requires at least one current physical or qualified agile-member tracker row',
    );
  }
  const eligibleRawTargetIds = new Set(
    rankedProjections.map((projection) => projection.rawTarget.id),
  );
  const inputOrderedRawTargets = activeSignals.filter((signal) =>
    eligibleRawTargetIds.has(signal.id));
  if (new Set(inputOrderedRawTargets.map((signal) => signal.id)).size
    !== inputOrderedRawTargets.length) {
    throw new Error('Detected-power capture receipt rejects duplicate tracker row IDs');
  }
  const inputOrdinalById = new Map(
    inputOrderedRawTargets.map((signal, inputOrdinal) => [signal.id, inputOrdinal] as const),
  );
  const projectionByRawTargetId = new Map(
    rankedProjections.map((projection) => [projection.rawTarget.id, projection] as const),
  );
  const candidates = rankedProjections.map((projection, rank) => {
    const { rawTarget, projectedRepresentative, projectionKind } = projection;
    const targetRankEvidence = classificationCaptureTargetRankEvidence(rawTarget);
    if (targetRankEvidence === undefined) {
      throw new Error(
        `Detected-power capture target ${rawTarget.id} lacks exact current source-sweep integrated ranking evidence`,
      );
    }
    let runtimeAdmission:
      | {
        status: 'admitted';
        spectrumSweepIds: readonly string[];
      }
      | {
        status: 'unavailable';
        reason:
          | 'insufficient-spectrum-history'
          | 'association-not-currently-qualified'
          | 'local-history-not-uniquely-replayable'
          | 'insufficient-roi-bins';
      };
    if (!observableAssociationEvidenceIsCurrentlyQualified(
      projectedRepresentative,
    )) {
      runtimeAdmission = {
        status: 'unavailable',
        reason: 'association-not-currently-qualified',
      };
    } else {
      try {
        const observation = extractObservableFeatures(projectedRepresentative, {
          sweeps: evidenceSweeps,
        });
        runtimeAdmission = observation.sweepIds.length === 8
          ? {
            status: 'admitted',
            spectrumSweepIds: [...observation.sweepIds],
          }
          : {
            status: 'unavailable',
            reason: 'insufficient-spectrum-history',
          };
      } catch (error) {
        if (!(error instanceof ObservableEvidenceUnavailableError)) throw error;
        runtimeAdmission = {
          status: 'unavailable',
          reason: error.code,
        };
      }
    }
    return {
      rank,
      inputOrdinal: inputOrdinalById.get(rawTarget.id)!,
      rawTargetId: rawTarget.id,
      currentPeakDbm: rawTarget.peakDbm,
      currentSourceSweepId: targetRankEvidence.sourceSweepId,
      currentSupportStartHz: targetRankEvidence.supportStartHz,
      currentSupportStopHz: targetRankEvidence.supportStopHz,
      currentSupportCellCount: targetRankEvidence.supportCellCount,
      currentRobustFloorDbm: targetRankEvidence.robustFloorDbm,
      currentActualRbwHz: targetRankEvidence.actualRbwHz,
      currentIntegratedExcessPowerMw:
        targetRankEvidence.integratedExcessPowerMw,
      currentPeakHz: rawTarget.peakHz,
      currentStartHz: rawTarget.startHz,
      currentStopHz: rawTarget.stopHz,
      state: rawTarget.state as 'candidate' | 'active',
      missedSweeps: rawTarget.missedSweeps,
      lastSeenAt: rawTarget.lastSeenAt,
      ...(rawTarget.associationMode === undefined
        ? {}
        : { associationMode: rawTarget.associationMode }),
      ...(rawTarget.associationId === undefined
        ? {}
        : { associationId: rawTarget.associationId }),
      ...(rawTarget.associationMemberTrackIds === undefined
        ? {}
        : { associationMemberTrackIds: [...rawTarget.associationMemberTrackIds] }),
      ...(rawTarget.associationMissedSweeps === undefined
        ? {}
        : { associationMissedSweeps: rawTarget.associationMissedSweeps }),
      projectionKind,
      projectedRepresentativeId: projectedRepresentative.id,
      runtimeAdmission,
    };
  });
  const selectedCandidate = preferredDetectionId === undefined
    ? candidates[0]
    : candidates.find((candidate) => candidate.rawTargetId === preferredDetectionId);
  if (!selectedCandidate || selectedCandidate.runtimeAdmission.status !== 'admitted') {
    throw new Error(preferredDetectionId === undefined
      ? 'Detected-power capture receipt cannot runtime-admit the rank-0 automatic target; lower-ranked targets are never substituted'
      : `Detected-power capture receipt cannot runtime-admit preferred tracker target ${preferredDetectionId}`);
  }
  const projectedRepresentative = projectionByRawTargetId.get(
    selectedCandidate.rawTargetId,
  )!.projectedRepresentative;
  if (capture.targetDetectionId !== selectedCandidate.rawTargetId) {
    throw new Error(
      `Detected-power capture ${capture.id} targets ${String(capture.targetDetectionId)}, expected selected raw tracker row ${selectedCandidate.rawTargetId}`,
    );
  }
  if (!Number.isFinite(admittedTargetTuneHz)
    || admittedTargetTuneHz < 0
    || capture.frequencyHz !== admittedTargetTuneHz
    || capture.requested.centerHz !== admittedTargetTuneHz) {
    throw new Error(
      `Detected-power capture ${capture.id} does not match controller-admitted target tune ${String(admittedTargetTuneHz)}`,
    );
  }
  if (selectedCandidate.runtimeAdmission.status !== 'admitted'
    || selectedCandidate.runtimeAdmission.spectrumSweepIds.length
      !== spectrumSweepIds.length
    || selectedCandidate.runtimeAdmission.spectrumSweepIds.some(
      (sweepId, index) => sweepId !== spectrumSweepIds[index],
    )) {
    throw new Error(
      `Detected-power capture ${capture.id} is not bound to the selected target's exact pre-capture runtime admission window`,
    );
  }
  return issueDetectedPowerCaptureReceipt({
    schemaVersion: 4,
    capturePolicyId: SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
    targetSelectionPolicyId:
      SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
    runtimeAdmissionPolicyId:
      DETECTED_POWER_CAPTURE_RUNTIME_ADMISSION_POLICY_ID,
    selection: {
      mode: preferredDetectionId === undefined
        ? 'integrated-excess-current'
        : 'preferred-target',
      ...(preferredDetectionId === undefined
        ? {}
        : { preferredRawTargetId: preferredDetectionId }),
      rawTargetId: selectedCandidate.rawTargetId,
      projectedRepresentativeId: projectedRepresentative.id,
    },
    candidates,
    projectedRepresentative: {
      id: projectedRepresentative.id,
      startHz: projectedRepresentative.startHz,
      stopHz: projectedRepresentative.stopHz,
      peakHz: projectedRepresentative.peakHz,
      peakDbm: projectedRepresentative.peakDbm,
      bandwidthHz: projectedRepresentative.bandwidthHz,
      missedSweeps: projectedRepresentative.missedSweeps,
      lastSeenAt: projectedRepresentative.lastSeenAt,
      ...(projectedRepresentative.associationMode === undefined
        ? {}
        : { associationMode: projectedRepresentative.associationMode }),
      ...(projectedRepresentative.associationId === undefined
        ? {}
        : { associationId: projectedRepresentative.associationId }),
      ...(projectedRepresentative.associationMemberTrackIds === undefined
        ? {}
        : {
          associationMemberTrackIds: [
            ...projectedRepresentative.associationMemberTrackIds,
          ],
        }),
      ...(projectedRepresentative.associationMissedSweeps === undefined
        ? {}
        : {
          associationMissedSweeps:
            projectedRepresentative.associationMissedSweeps,
        }),
    },
    spectrumSweepIds: [...spectrumSweepIds],
    capture: {
      id: capture.id,
      sequence: capture.sequence,
      capturedAt: capture.capturedAt,
      measurementIdentityKey: measurementIdentityKey(capture.identity),
      targetDetectionId: capture.targetDetectionId,
      admittedTargetTuneHz,
      frequencyHz: capture.frequencyHz,
      requestedCenterHz: capture.requested.centerHz,
      payloadBinding: {
        algorithm: 'sha256',
        canonicalization: 'zero-span-capture-canonical-json-v1',
        sha256: detectedPowerCapturePayloadSha256(capture),
      },
    },
  }, capture);
}

/** Stable representative identity and exact-power tie-break; never primary capture priority. */
export function classificationRepresentativeKey(signal: DetectedSignal): string {
  const associationMode = signal.associationMode ?? 'frequency-local';
  return `${associationMode}:${associationMode === 'frequency-local'
    ? signal.id
    : signal.associationId ?? signal.id}`;
}

/** Exact numeric authority followed only by the receipt's stable tie keys. */
export function compareClassificationCaptureTargetSignals(
  left: DetectedSignal,
  right: DetectedSignal,
): number {
  return compareClassificationCaptureTargetRankEvidence(
    classificationCaptureTargetRankEvidence(left),
    classificationCaptureTargetRankEvidence(right),
  ) || classificationRepresentativeKey(left).localeCompare(
    classificationRepresentativeKey(right),
  ) || left.id.localeCompare(right.id);
}

function betterAssociationRepresentative(candidate: DetectedSignal, current: DetectedSignal, preferredDetectionId?: string): boolean {
  const candidateIsCurrentMember = currentStaticAssociationMember(candidate);
  const currentIsCurrentMember = currentStaticAssociationMember(current);
  // A selected zero-span target may leave a changing regional association while
  // tracker hysteresis keeps its old lineage visible. Selection is not evidence:
  // a departed member must never displace a member in the latest admitted hull.
  if (candidateIsCurrentMember !== currentIsCurrentMember) return candidateIsCurrentMember;
  if (candidate.id === preferredDetectionId) return true;
  if (current.id === preferredDetectionId) return false;
  if (candidate.missedSweeps !== current.missedSweeps) return candidate.missedSweeps < current.missedSweeps;
  if ((candidate.associationMissedSweeps ?? 0) !== (current.associationMissedSweeps ?? 0)) {
    return (candidate.associationMissedSweeps ?? 0) < (current.associationMissedSweeps ?? 0);
  }
  const regionCenterHz = ((candidate.associationRegionStartHz ?? candidate.startHz)
    + (candidate.associationRegionStopHz ?? candidate.stopHz)) / 2;
  const candidateDistanceHz = Math.abs((candidate.startHz + candidate.stopHz) / 2 - regionCenterHz);
  const currentDistanceHz = Math.abs((current.startHz + current.stopHz) / 2 - regionCenterHz);
  return candidateDistanceHz < currentDistanceHz
    || (candidateDistanceHz === currentDistanceHz && candidate.id < current.id);
}

function currentStaticAssociationMember(signal: DetectedSignal): boolean {
  if (!isStaticRegionAssociation(signal.associationMode)) return true;
  return signal.missedSweeps === 0
    && signal.associationMissedSweeps === 0
    && signal.associationMemberTrackIds?.includes(signal.id) === true;
}

export interface SweepMetrics {
  peakDbm: number;
  peakHz: number;
  minimumDbm: number;
  meanDbm: number;
  medianDbm: number;
  noiseFloorDbm: number;
  summedPowerDbm: number;
  occupiedBandwidth99Hz: number;
  crestFactorDb: number;
}

export function calculateSweepMetrics(sweep: Sweep): SweepMetrics {
  validateSweep(sweep);
  let peakIndex = 0;
  let minimumDbm = Number.POSITIVE_INFINITY;
  let linearSumMilliwatts = 0;
  for (let index = 0; index < sweep.powerDbm.length; index++) {
    const value = sweep.powerDbm[index]!;
    if (value > sweep.powerDbm[peakIndex]!) peakIndex = index;
    minimumDbm = Math.min(minimumDbm, value);
    linearSumMilliwatts += dbmToMilliwatts(value);
  }
  const meanMilliwatts = linearSumMilliwatts / sweep.powerDbm.length;
  const meanDbm = milliwattsToDbm(meanMilliwatts);
  return {
    peakDbm: sweep.powerDbm[peakIndex]!,
    peakHz: sweep.frequencyHz[peakIndex]!,
    minimumDbm,
    meanDbm,
    medianDbm: median(sweep.powerDbm),
    noiseFloorDbm: robustNoiseFloor(sweep.powerDbm),
    summedPowerDbm: milliwattsToDbm(linearSumMilliwatts),
    occupiedBandwidth99Hz: legacyOccupiedBandwidth(sweep, 0.99),
    crestFactorDb: sweep.powerDbm[peakIndex]! - meanDbm,
  };
}

/** Integrate scalar sweep samples as power density using the measured RBW and each bin's frequency cell. */
export function integrateSweepBandPower(sweep: Sweep, startHz: number, stopHz: number): IntegratedBandPower {
  validateSweep(sweep);
  validateFrequencyWindow(sweep, startHz, stopHz, 'Integrated power');
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) throw new Error('Integrated power requires a positive analysis resolution scale');
  const cells = sweepCells(sweep);
  let integratedMilliwatts = 0;
  let binsUsed = 0;
  for (const cell of cells) {
    const overlapHz = Math.max(0, Math.min(stopHz, cell.stopHz) - Math.max(startHz, cell.startHz));
    if (overlapHz <= 0) continue;
    integratedMilliwatts += dbmToMilliwatts(cell.powerDbm) * overlapHz / sweep.actualRbwHz;
    binsUsed++;
  }
  if (binsUsed === 0 || integratedMilliwatts <= 0) throw new Error('Integrated power window contains no sweep evidence');
  const bandwidthHz = stopHz - startHz;
  const powerDbm = milliwattsToDbm(integratedMilliwatts);
  return {
    startHz,
    stopHz,
    bandwidthHz,
    powerDbm,
    powerSpectralDensityDbmHz: powerDbm - 10 * Math.log10(bandwidthHz),
    binsUsed,
  };
}

/** Percent-of-total-power OBW over the displayed sweep span, with explicit optional robust-floor subtraction. */
export function measureOccupiedBandwidth(
  sweep: Sweep,
  percent: number,
  noiseCorrection: ChannelMeasurementConfiguration['obwNoiseCorrection'],
): ChannelMeasurementResult['occupiedBandwidth'] {
  validateSweep(sweep);
  if (!Number.isFinite(percent) || percent < 10 || percent > 99.9) throw new Error('Occupied-bandwidth percentage must be between 10 and 99.9');
  if (noiseCorrection !== 'none' && noiseCorrection !== 'robust-floor') throw new Error(`Unsupported OBW noise correction: ${String(noiseCorrection)}`);
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) throw new Error('Occupied bandwidth requires a positive analysis resolution scale');
  const floorMilliwatts = noiseCorrection === 'robust-floor' ? dbmToMilliwatts(robustNoiseFloor(sweep.powerDbm)) : 0;
  const weighted = sweepCells(sweep).map((cell) => ({
    ...cell,
    milliwatts: Math.max(0, dbmToMilliwatts(cell.powerDbm) - floorMilliwatts) * (cell.stopHz - cell.startHz) / sweep.actualRbwHz,
  }));
  const totalMilliwatts = weighted.reduce((sum, cell) => sum + cell.milliwatts, 0);
  if (totalMilliwatts <= 0) throw new Error('Occupied bandwidth has no power remaining after the selected noise correction');
  const fraction = percent / 100;
  const lowerTarget = totalMilliwatts * (1 - fraction) / 2;
  const upperTarget = totalMilliwatts - lowerTarget;
  const startHz = cumulativeBoundary(weighted, lowerTarget);
  const stopHz = cumulativeBoundary(weighted, upperTarget);
  return {
    percent,
    startHz,
    stopHz,
    bandwidthHz: Math.max(0, stopHz - startHz),
    occupiedPowerDbm: milliwattsToDbm(totalMilliwatts * fraction),
    noiseCorrection,
  };
}

/** Main, adjacent, alternate-channel, and OBW results from one complete scalar sweep. */
export function measureChannel(sweep: Sweep, input: ChannelMeasurementConfiguration): ChannelMeasurementResult {
  const configuration = channelMeasurementConfigurationSchema.parse(input);
  validateSweep(sweep);
  const mainStartHz = configuration.centerHz - configuration.mainBandwidthHz / 2;
  const mainStopHz = configuration.centerHz + configuration.mainBandwidthHz / 2;
  const carrier = integrateSweepBandPower(sweep, mainStartHz, mainStopHz);
  const adjacent: AdjacentChannelMeasurement[] = [];
  for (let order = 1; order <= configuration.adjacentChannelCount; order++) {
    for (const side of ['lower', 'upper'] as const) {
      const channelCenterHz = configuration.centerHz + (side === 'lower' ? -1 : 1) * configuration.channelSpacingHz * order;
      const band = integrateSweepBandPower(sweep, channelCenterHz - configuration.adjacentBandwidthHz / 2, channelCenterHz + configuration.adjacentBandwidthHz / 2);
      adjacent.push({
        ...band,
        side,
        order: order as 1 | 2 | 3,
        relativeToCarrierDbc: band.powerDbm - carrier.powerDbm,
      });
    }
  }
  return {
    carrier,
    adjacent,
    threeDecibelBandwidth: measureThreeDecibelBandwidth(sweep, mainStartHz, mainStopHz),
    occupiedBandwidth: measureOccupiedBandwidth(sweep, configuration.occupiedPowerPercent, configuration.obwNoiseCorrection),
    sourceSweepId: sweep.id,
    actualRbwHz: sweep.actualRbwHz,
    nominalBinWidthHz: nominalBinWidth(sweep.frequencyHz),
    evidence: 'host-derived-scalar-sweep',
    qualification: 'engineering-estimate',
  };
}

/** STFT of detected power versus time. This is an envelope analysis and deliberately cannot return RF/IQ phase. */
export function computeEnvelopeStft(capture: ZeroSpanCapture, input: EnvelopeStftConfiguration): EnvelopeStftResult {
  const configuration = envelopeStftConfigurationSchema.parse(input);
  validateZeroSpanCapture(capture);
  if (capture.powerDbm.length < configuration.windowSize) {
    throw new Error(`Envelope STFT requires at least ${configuration.windowSize} samples; capture contains ${capture.powerDbm.length}`);
  }
  const sampleRateHz = 1 / capture.samplePeriodSeconds;
  const frequencyBins = Math.floor(configuration.windowSize / 2) + 1;
  const modulationFrequencyHz = Array.from({ length: frequencyBins }, (_, index) => index * sampleRateHz / configuration.windowSize);
  const window = Array.from({ length: configuration.windowSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (configuration.windowSize - 1)));
  const rawFrames: Array<{ startSeconds: number; centerSeconds: number; magnitude: number[] }> = [];
  for (let start = 0; start + configuration.windowSize <= capture.powerDbm.length; start += configuration.hopSize) {
    const samples = capture.powerDbm.slice(start, start + configuration.windowSize).map(dbmToMilliwatts);
    const mean = configuration.removeDc ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
    const magnitude = modulationFrequencyHz.map((_frequency, bin) => {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < configuration.windowSize; index++) {
        const sample = (samples[index]! - mean) * window[index]!;
        const phase = 2 * Math.PI * bin * index / configuration.windowSize;
        real += sample * Math.cos(phase);
        imaginary -= sample * Math.sin(phase);
      }
      return Math.hypot(real, imaginary);
    });
    if (configuration.removeDc) magnitude[0] = 0;
    rawFrames.push({
      startSeconds: start * capture.samplePeriodSeconds,
      centerSeconds: (start + configuration.windowSize / 2) * capture.samplePeriodSeconds,
      magnitude,
    });
  }
  const maximumMagnitude = Math.max(...rawFrames.flatMap((frame) => frame.magnitude));
  if (!Number.isFinite(maximumMagnitude) || maximumMagnitude <= 0) throw new Error('Envelope STFT contains no measurable time variation');
  const integratedByBin = modulationFrequencyHz.map((_frequency, bin) => rawFrames.reduce((sum, frame) => sum + frame.magnitude[bin]! ** 2, 0));
  const firstSearchBin = configuration.removeDc ? 1 : 0;
  let peakBin = firstSearchBin;
  for (let index = firstSearchBin + 1; index < integratedByBin.length; index++) if (integratedByBin[index]! > integratedByBin[peakBin]!) peakBin = index;
  return {
    sourceCaptureId: capture.id,
    sampleRateHz,
    modulationFrequencyHz,
    frames: rawFrames.map((frame) => ({
      startSeconds: frame.startSeconds,
      centerSeconds: frame.centerSeconds,
      magnitudeDbRelative: frame.magnitude.map((magnitude) => Math.max(-configuration.dynamicRangeDb, 20 * Math.log10(Math.max(Number.MIN_VALUE, magnitude) / maximumMagnitude))),
    })),
    peakModulationFrequencyHz: modulationFrequencyHz[peakBin]!,
    evidence: 'zero-span-detected-envelope',
    qualification: 'not-iq',
  };
}

interface TraceState {
  configuration: TraceConfiguration;
  frame?: TraceFrame;
  averageWindow: readonly number[][];
  accumulationMode?: Exclude<TraceConfiguration['mode'], 'view' | 'blank'>;
}

/** Four simultaneous display traces derived from complete host sweeps. No firmware-state claim is implied. */
export class TraceAccumulator {
  #configuration: TraceBankConfiguration;
  #states = new Map<TraceId, TraceState>();

  constructor(configuration: TraceBankConfiguration) {
    this.#configuration = traceBankConfigurationSchema.parse(configuration);
    for (const trace of this.#configuration) {
      this.#states.set(trace.id, {
        configuration: structuredClone(trace),
        averageWindow: [],
        accumulationMode: isPassiveTraceMode(trace.mode) ? undefined : trace.mode,
      });
    }
  }

  get configuration(): TraceBankConfiguration { return structuredClone(this.#configuration); }

  configure(input: TraceBankConfiguration): void {
    const configuration = traceBankConfigurationSchema.parse(input);
    for (const trace of configuration) {
      const previous = this.#states.get(trace.id);
      if (!previous) {
        this.#states.set(trace.id, {
          configuration: structuredClone(trace),
          averageWindow: [],
          accumulationMode: isPassiveTraceMode(trace.mode) ? undefined : trace.mode,
        });
        continue;
      }
      const previousMode = previous.configuration.mode;
      const modeChanged = previousMode !== trace.mode;
      const averagingChanged = previous.configuration.averageCount !== trace.averageCount;
      const nextIsPassive = isPassiveTraceMode(trace.mode);
      const resumesRetainedMode = isPassiveTraceMode(previousMode) && previous.accumulationMode === trace.mode;
      previous.configuration = structuredClone(trace);
      if (modeChanged && nextIsPassive) {
        if (previous.frame) previous.frame = { ...previous.frame, mode: trace.mode };
      } else if ((modeChanged && !resumesRetainedMode) || (trace.mode === 'average' && averagingChanged)) {
        previous.frame = undefined;
        previous.averageWindow = [];
      } else if (modeChanged && previous.frame) {
        previous.frame = { ...previous.frame, mode: trace.mode };
      }
      if (!isPassiveTraceMode(trace.mode)) previous.accumulationMode = trace.mode;
    }
    this.#configuration = structuredClone(configuration);
  }

  reset(traceId?: TraceId): void {
    if (traceId !== undefined) {
      const id = traceIdSchema.parse(traceId);
      const state = this.#states.get(id);
      if (!state) throw new Error(`Trace ${id} is not configured`);
      state.frame = undefined;
      state.averageWindow = [];
      return;
    }
    for (const state of this.#states.values()) {
      state.frame = undefined;
      state.averageWindow = [];
    }
  }

  update(sweep: Sweep): readonly TraceFrame[] {
    validateSweep(sweep);
    for (const trace of this.#configuration) {
      const state = this.#states.get(trace.id)!;
      if (trace.mode === 'blank' || trace.mode === 'view') continue;
      if (state.frame && (!sameFrequencyGrid(state.frame.frequencyHz, sweep.frequencyHz)
        || !sameTraceResolutionProvenance(state.frame, sweep))) {
        state.frame = undefined;
        state.averageWindow = [];
      }
      let powerDbm: readonly number[];
      let sweepCount: number;
      if (trace.mode === 'clear-write' || !state.frame) {
        powerDbm = [...sweep.powerDbm];
        sweepCount = 1;
        state.averageWindow = trace.mode === 'average' ? [[...sweep.powerDbm]] : [];
      } else if (trace.mode === 'max-hold') {
        powerDbm = sweep.powerDbm.map((value, index) => Math.max(value, state.frame!.powerDbm[index]!));
        sweepCount = state.frame.sweepCount + 1;
      } else if (trace.mode === 'min-hold') {
        powerDbm = sweep.powerDbm.map((value, index) => Math.min(value, state.frame!.powerDbm[index]!));
        sweepCount = state.frame.sweepCount + 1;
      } else if (trace.mode === 'average') {
        state.averageWindow = [...state.averageWindow, [...sweep.powerDbm]].slice(-trace.averageCount);
        powerDbm = averagePowerFrames(state.averageWindow);
        sweepCount = state.averageWindow.length;
      } else {
        throw new Error(`Trace ${trace.id} entered unsupported mode ${trace.mode}`);
      }
      state.frame = {
        traceId: trace.id,
        mode: trace.mode,
        frequencyHz: [...sweep.frequencyHz],
        powerDbm,
        actualRbwHz: sweep.actualRbwHz,
        ...(sweep.resolutionBandwidthQualification === undefined
          ? {}
          : { resolutionBandwidthQualification: sweep.resolutionBandwidthQualification }),
        sweepCount,
        sourceSweepId: sweep.id,
        evidence: 'host-derived',
      };
    }
    return this.frames();
  }

  frames(): readonly TraceFrame[] {
    return this.#configuration
      .filter((trace) => trace.mode !== 'blank')
      .map((trace) => this.#states.get(trace.id)?.frame)
      .filter((frame): frame is TraceFrame => frame !== undefined)
      .map((frame) => structuredClone(frame));
  }
}

export function readMarkers(
  markerInputs: readonly MarkerConfiguration[],
  frames: readonly TraceFrame[],
  detections: readonly DetectedSignal[] = [],
): readonly MarkerReading[] {
  const markers = markerInputs.map((marker) => markerConfigurationSchema.parse(marker));
  const frameByTrace = new Map(frames.map((frame) => [frame.traceId, frame]));
  const readings = new Map<number, MarkerReading>();
  for (const marker of markers) {
    if (!marker.enabled) continue;
    const frame = frameByTrace.get(marker.traceId);
    if (!frame) continue;
    // Trace math remains strict when called directly. This projection boundary
    // quarantines malformed acquired/firmware evidence so one bad frame omits
    // its marker readings instead of taking down every renderer and Agent read.
    if (!markerReadableTraceFrame(frame)) continue;
    const centerSelection = marker.tracking === 'peak'
      ? selectMarkerCenterOnTrace(frame, frame.actualRbwHz, detections)
      : {
        markerCenterMethod: 'fixed-frequency' as const,
        binIndex: nearestFrequencyIndex(frame.frequencyHz, marker.frequencyHz),
      };
    const binIndex = centerSelection.binIndex;
    const powerDbm = frame.powerDbm[binIndex]!;
    readings.set(marker.id, {
      markerId: marker.id,
      traceId: marker.traceId,
      mode: marker.mode,
      binIndex,
      frequencyHz: frame.frequencyHz[binIndex]!,
      powerDbm,
      ...(marker.mode === 'noise-density' ? { noiseDensityDbmHz: powerDbm - 10 * Math.log10(frame.actualRbwHz) } : {}),
      localCharacterization: characterizeMarkerLocalTrace(
        frame,
        binIndex,
        frame.actualRbwHz,
        detections,
        centerSelection.markerCenterMethod === 'resolved-component-linear-power-centroid'
          ? {
            markerCenterMethod: centerSelection.markerCenterMethod,
            powerCentroidHz: centerSelection.powerCentroidHz,
          }
          : { markerCenterMethod: centerSelection.markerCenterMethod },
      ),
      sourceSweepId: frame.sourceSweepId,
      evidence: 'host-derived',
    });
  }
  for (const marker of markers) {
    if (marker.mode !== 'delta' || marker.referenceMarkerId === undefined) continue;
    const reading = readings.get(marker.id);
    const reference = readings.get(marker.referenceMarkerId);
    if (!reading || !reference) continue;
    readings.set(marker.id, {
      ...reading,
      deltaFrequencyHz: reading.frequencyHz - reference.frequencyHz,
      deltaPowerDb: reading.powerDbm - reference.powerDbm,
    });
  }
  return markers.map((marker) => readings.get(marker.id)).filter((reading): reading is MarkerReading => reading !== undefined);
}

function markerReadableTraceFrame(frame: TraceFrame): boolean {
  if (!Number.isFinite(frame.actualRbwHz) || frame.actualRbwHz <= 0) return false;
  if (frame.frequencyHz.length !== frame.powerDbm.length || frame.frequencyHz.length < 3) return false;
  if (frame.frequencyHz.some((value) => !Number.isFinite(value))
    || frame.powerDbm.some((value) => !Number.isFinite(value))) return false;
  for (let index = 1; index < frame.frequencyHz.length; index++) {
    if (frame.frequencyHz[index]! <= frame.frequencyHz[index - 1]!) return false;
  }
  return true;
}

export function searchMarker(
  frame: TraceFrame,
  currentFrequencyHz: number,
  action: MarkerSearchAction,
  searchInput: MarkerSearchConfiguration,
  detections: readonly DetectedSignal[] = [],
): number {
  const search = markerSearchConfigurationSchema.parse(searchInput);
  if (!frame.frequencyHz.length || frame.frequencyHz.length !== frame.powerDbm.length) throw new Error('Marker search requires a complete trace frame');
  if (action === 'peak') return selectMarkerCenterOnTrace(frame, frame.actualRbwHz, detections).frequencyHz;
  if (action === 'minimum') return frame.frequencyHz[minimumIndex(frame.powerDbm)]!;
  const peaks = localPeakIndices(frame.powerDbm, search);
  const currentIndex = nearestFrequencyIndex(frame.frequencyHz, currentFrequencyHz);
  const candidates = action === 'next-left'
    ? peaks.filter((index) => index < currentIndex).sort((left, right) => right - left)
    : peaks.filter((index) => index > currentIndex).sort((left, right) => left - right);
  const match = candidates[0];
  if (match === undefined) throw new Error(`No qualifying peak exists ${action === 'next-left' ? 'left' : 'right'} of the active marker`);
  return frame.frequencyHz[match]!;
}

export function autoScaleSpectrum(sweep: Sweep): SpectrumDisplayConfiguration {
  validateSweep(sweep);
  const peak = Math.max(...sweep.powerDbm);
  const floor = robustNoiseFloor(sweep.powerDbm);
  const referenceLevelDbm = Math.min(30, Math.max(-150, Math.ceil((peak + 5) / 5) * 5));
  const requiredRange = Math.max(10, referenceLevelDbm - (floor - 8));
  const decibelsPerDivision = ([1, 2, 5, 10, 20] as const).find((scale) => scale * 10 >= requiredRange) ?? 20;
  return spectrumDisplayConfigurationSchema.parse({ referenceLevelDbm, decibelsPerDivision, divisions: 10 });
}

export interface AnalysisModePlugin<Config, Input, Result> {
  readonly definition: AnalysisModeDefinition;
  readonly configSchemaVersion: number;
  readonly resultSchemaVersion: number;
  validateConfig(input: unknown): Config;
  analyze(input: Input, config: Config, signal: AbortSignal): Promise<Result>;
}

export interface WaveformClassifier {
  readonly modelId: string;
  classify(detection: DetectedSignal, sweep: Sweep, signal?: AbortSignal): Promise<WaveformClassification>;
}

export class SpectralMorphologyClassifier implements WaveformClassifier {
  readonly modelId = 'spectral-morphology-v1';

  async classify(detection: DetectedSignal, sweep: Sweep, signal?: AbortSignal): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    validateSweep(sweep);
    if (!detection.sweepIds.includes(sweep.id)) return unknownClassification(detection, this.modelId, 'insufficient-evidence');
    const indices = sweep.frequencyHz.map((frequency, index) => ({ frequency, index }))
      .filter(({ frequency }) => frequency >= detection.startHz && frequency <= detection.stopHz)
      .map(({ index }) => index);
    if (!indices.length) return unknownClassification(detection, this.modelId, 'insufficient-evidence');
    const values = indices.map((index) => sweep.powerDbm[index]!);
    const binWidthHz = sweep.frequencyHz.length > 1 ? Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!) : 0;
    const features = {
      bins: values.length,
      binWidthHz,
      bandwidthHz: detection.bandwidthHz,
      prominenceDb: detection.peakDbm - detection.noiseFloorDbm,
      flatness: spectralFlatness(values),
      localPeaks: countLocalPeaks(values, detection.noiseFloorDbm + 6),
      occupiedFraction: detection.bandwidthHz / Math.max(1, sweep.actualStopHz - sweep.actualStartHz),
    };
    const scores = [
      { label: 'narrowband-carrier', score: clamp01((4 - features.bins) / 3) * 0.55 + clamp01(features.prominenceDb / 30) * 0.45 },
      { label: 'multi-carrier', score: clamp01((features.localPeaks - 1) / 3) * 0.75 + clamp01(features.prominenceDb / 25) * 0.25 },
      { label: 'wideband-noise-like', score: clamp01((features.bins - 5) / 12) * 0.45 + features.flatness * 0.55 },
      { label: 'band-limited-emission', score: clamp01((features.bins - 2) / 8) * 0.55 + (1 - features.flatness) * 0.2 + clamp01(features.prominenceDb / 25) * 0.25 },
    ];
    const total = scores.reduce((sum, item) => sum + Math.max(0.0001, item.score), 0);
    const candidates = scores.map((item) => ({ label: item.label, confidence: Math.max(0.0001, item.score) / total }))
      .sort((left, right) => right.confidence - left.confidence);
    const top = candidates[0]!;
    const common = {
      detectionId: detection.id,
      candidates,
      modelId: this.modelId,
      qualification: 'spectral-morphology' as const,
      scoreKind: 'relative-score' as const,
      decisionLevel: 'morphology' as const,
      classifiedAt: new Date().toISOString(),
      evidence: {
        centerHz: (detection.startHz + detection.stopHz) / 2,
        bandwidthHz: detection.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: detection.sweepIds,
        features,
      },
    };
    if (top.confidence < 0.42 || features.prominenceDb < 6) {
      return { ...common, label: 'unknown', confidence: top.confidence, unknownReason: 'low-confidence' };
    }
    return { ...common, label: top.label, confidence: top.confidence };
  }
}

export class UnknownClassifier implements WaveformClassifier {
  readonly modelId = 'unconfigured';
  async classify(detection: DetectedSignal): Promise<WaveformClassification> {
    return unknownClassification(detection, this.modelId, 'model-unavailable');
  }
}

export interface EnvelopeClassification {
  label: 'steady-envelope' | 'amplitude-modulated' | 'pulsed-envelope' | 'unknown';
  confidence: number;
  modelId: 'zero-span-envelope-v1';
  features: {
    peakToPeakDb: number;
    standardDeviationDb: number;
    dutyCycle: number;
    transitionCount: number;
    dominantLagSamples: number;
  };
}

export function classifyZeroSpanEnvelope(capture: ZeroSpanCapture): EnvelopeClassification {
  if (capture.powerDbm.length < 20 || capture.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Zero-span classification requires at least 20 finite power samples');
  }
  const minimum = Math.min(...capture.powerDbm);
  const maximum = Math.max(...capture.powerDbm);
  const mean = capture.powerDbm.reduce((sum, value) => sum + value, 0) / capture.powerDbm.length;
  const variance = capture.powerDbm.reduce((sum, value) => sum + (value - mean) ** 2, 0) / capture.powerDbm.length;
  const threshold = minimum + (maximum - minimum) * 0.6;
  const high = capture.powerDbm.map((value) => value >= threshold);
  const dutyCycle = high.filter(Boolean).length / high.length;
  let transitionCount = 0;
  for (let index = 1; index < high.length; index++) if (high[index] !== high[index - 1]) transitionCount++;
  const features = {
    peakToPeakDb: maximum - minimum,
    standardDeviationDb: Math.sqrt(variance),
    dutyCycle,
    transitionCount,
    dominantLagSamples: dominantAutocorrelationLag(capture.powerDbm),
  };
  if (features.peakToPeakDb < 2 && features.standardDeviationDb < 0.8) return { label: 'steady-envelope', confidence: 0.92, modelId: 'zero-span-envelope-v1', features };
  if (features.peakToPeakDb >= 8 && dutyCycle > 0.05 && dutyCycle < 0.45 && transitionCount >= 2) return { label: 'pulsed-envelope', confidence: clamp01(0.55 + features.peakToPeakDb / 50), modelId: 'zero-span-envelope-v1', features };
  if (features.peakToPeakDb >= 3 && features.dominantLagSamples > 0) return { label: 'amplitude-modulated', confidence: clamp01(0.5 + features.standardDeviationDb / 15), modelId: 'zero-span-envelope-v1', features };
  return { label: 'unknown', confidence: 0.35, modelId: 'zero-span-envelope-v1', features };
}

/** Compatibility name: median of the lowest 20%, a candidate baseline rather than a calibrated receiver noise floor. */
export function robustNoiseFloor(values: readonly number[]): number {
  if (!values.length) throw new Error('Candidate-baseline estimation requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  const cutoff = Math.max(1, Math.floor(sorted.length * 0.2));
  return median(sorted.slice(0, cutoff));
}

function mergeSignal(
  previous: DetectedSignal,
  candidate: DetectedSignal,
  sweep: Sweep,
  config: SignalDetectionConfig,
  consecutiveDetectionSweeps: number,
): DetectedSignal {
  const persistenceSweeps = previous.persistenceSweeps + 1;
  const predictedPosterior = predictTrackPosterior(previous.bayesianEvidence.posteriorSignalProbability);
  const posteriorSignalProbability = posteriorFromPriorAndLogBayesFactor(predictedPosterior, candidate.bayesianEvidence.logBayesFactor);
  const logBayesFactor = equivalentLogBayesFactor(posteriorSignalProbability);
  const staticRegionAssociation = isStaticRegionAssociation(previous.associationMode)
    ? previous.associationMode
    : undefined;
  const classificationRegionStartHz = previous.classificationRegionStartHz ?? previous.bayesianEvidence.testedRegionStartHz;
  const classificationRegionStopHz = previous.classificationRegionStopHz ?? previous.bayesianEvidence.testedRegionStopHz;
  const admissionObservation = localClassificationAdmissionObservation(candidate, sweep);
  const frozenObservation = previous.classificationRegionObservation;
  const compatibleLegacyAdmissionObservations: readonly LocalClassificationRegionObservation[] =
    previous.sweepIds.length === 1
      && frozenObservation !== undefined
      && frozenObservation.sourceSweep.id === previous.sweepIds[0]
      ? [frozenObservation]
      : [];
  const previousAdmissionObservations = previous.localClassificationObservations
    ?? compatibleLegacyAdmissionObservations;
  return {
    ...candidate,
    id: previous.id,
    firstSeenAt: previous.firstSeenAt,
    lastSeenAt: sweep.capturedAt,
    sweepIds: [...previous.sweepIds, sweep.id].slice(-64),
    persistenceSweeps,
    missedSweeps: 0,
    // Promotion is a run-length rule, not a cumulative-hit rule. Once active,
    // misses are handled by the tracker's Bayesian state prediction and
    // release hysteresis; they do not demote an admitted track back to candidate.
    state: previous.state === 'active' || consecutiveDetectionSweeps >= config.minimumConsecutiveSweeps ? 'active' : 'candidate',
    detectorConfig: structuredClone(config),
    classificationRegionStartHz,
    classificationRegionStopHz,
    classificationRegionSweepIds: previous.classificationRegionSweepIds ?? [previous.sweepIds[0]!],
    classificationRegionObservation: previous.classificationRegionObservation
      ?? candidate.classificationRegionObservation,
    localClassificationObservations: [
      ...previousAdmissionObservations,
      admissionObservation,
    ].slice(-64),
    qualityFlags: previous.qualityFlags,
    associationMode: staticRegionAssociation ?? 'frequency-local',
    ...(staticRegionAssociation ? {
      associationRegionStartHz: previous.associationRegionStartHz,
      associationRegionStopHz: previous.associationRegionStopHz,
      associationRegionSweepIds: previous.associationRegionSweepIds,
      associationId: previous.associationId,
      associationModelId: previous.associationModelId,
      associationMemberTrackIds: previous.associationMemberTrackIds,
      multicomponentAssociationObservations: previous.multicomponentAssociationObservations,
      regularComponentAssociationObservations: previous.regularComponentAssociationObservations,
      associationMissedSweeps: previous.associationMissedSweeps,
    } : {}),
    bayesianEvidence: {
      ...candidate.bayesianEvidence,
      modelId: `${BAYESIAN_DETECTOR_MODEL.id}+${BAYESIAN_TRACK_MODEL.id}`,
      posteriorScope: 'track-state',
      posteriorSignalProbability,
      logBayesFactor,
      // Region cells and posterior-predictive tails describe the current look;
      // correlated sweeps are handled by the state filter, not added as if
      // they were independent CFAR cells.
      effectiveIndependentBins: candidate.bayesianEvidence.effectiveIndependentBins,
      effectiveReferenceCells: (previous.bayesianEvidence.effectiveReferenceCells * previous.bayesianEvidence.looks + candidate.bayesianEvidence.effectiveReferenceCells) / (previous.bayesianEvidence.looks + 1),
      noiseShape: (previous.bayesianEvidence.noiseShape * previous.bayesianEvidence.looks + candidate.bayesianEvidence.noiseShape) / (previous.bayesianEvidence.looks + 1),
      posteriorPredictiveNullProbability: candidate.bayesianEvidence.posteriorPredictiveNullProbability,
      noiseSigmaDb: (previous.bayesianEvidence.noiseSigmaDb * previous.bayesianEvidence.looks + candidate.bayesianEvidence.noiseSigmaDb) / (previous.bayesianEvidence.looks + 1),
      observedMeanShiftDb: (previous.bayesianEvidence.observedMeanShiftDb * previous.bayesianEvidence.looks + candidate.bayesianEvidence.observedMeanShiftDb) / (previous.bayesianEvidence.looks + 1),
      looks: previous.bayesianEvidence.looks + 1,
    },
  };
}

function localClassificationAdmissionObservation(
  candidate: DetectedSignal,
  sweep: Sweep,
): LocalClassificationRegionObservation {
  return {
    // Bind the ledger to the actual tracker input, never to a caller-supplied
    // embedded sweep. Extraction independently replays the claimed candidate
    // and therefore fails closed if candidate fields or evidence were forged.
    sourceSweep: compactBayesianEvidenceSweep(sweep),
    startHz: candidate.startHz,
    stopHz: candidate.stopHz,
    peakHz: candidate.peakHz,
    detectorId: candidate.detectorId,
    localBayesianEvidence: structuredClone(candidate.bayesianEvidence),
  };
}

function regularComponentAssociationObservation(
  association: RegularSpectralComponentAssociation,
  candidates: readonly DetectedSignal[],
  candidateTrackIds: ReadonlyMap<number, string>,
  sweep: Sweep,
): RegularSpectralComponentAssociationObservation | undefined {
  const members = association.candidateIndices.map((candidateIndex) => {
    const candidate = candidates[candidateIndex];
    const trackId = candidateTrackIds.get(candidateIndex);
    if (!candidate || !trackId) return undefined;
    return {
      trackId,
      startHz: candidate.startHz,
      stopHz: candidate.stopHz,
      peakHz: candidate.peakHz,
      detectorId: candidate.detectorId,
      localBayesianEvidence: structuredClone(candidate.bayesianEvidence),
    };
  });
  if (members.some((member) => member === undefined)) return undefined;
  return {
    sourceSweep: compactBayesianEvidenceSweep(sweep),
    observedRegionStartHz: association.startHz,
    observedRegionStopHz: association.stopHz,
    spacingHz: association.spacingHz,
    latticeAnchorHz: association.latticeAnchorHz,
    members: members
      .filter((member): member is NonNullable<typeof member> => member !== undefined)
      .sort((left, right) => left.trackId.localeCompare(right.trackId)),
  };
}

function multicomponentAssociationObservation(
  association: MulticomponentSweptRegionAssociation,
  candidates: readonly DetectedSignal[],
  candidateTrackIds: ReadonlyMap<number, string>,
  sweep: Sweep,
): MulticomponentSweptRegionAssociationObservation | undefined {
  const members = association.candidateIndices.map((candidateIndex) => {
    const candidate = candidates[candidateIndex];
    const trackId = candidateTrackIds.get(candidateIndex);
    if (!candidate || !trackId) return undefined;
    return {
      trackId,
      startHz: candidate.startHz,
      stopHz: candidate.stopHz,
      peakHz: candidate.peakHz,
      detectorId: candidate.detectorId,
      localBayesianEvidence: structuredClone(candidate.bayesianEvidence),
    };
  });
  if (members.some((member) => member === undefined)) return undefined;
  const sortedMembers = members
    .filter((member): member is NonNullable<typeof member> => member !== undefined)
    .sort((left, right) => left.trackId.localeCompare(right.trackId));
  const anchorTrackId = association.anchorCandidateIndex === undefined
    ? undefined
    : candidateTrackIds.get(association.anchorCandidateIndex);
  if (association.anchorCandidateIndex !== undefined && !anchorTrackId) return undefined;
  return {
    sweepId: sweep.id,
    sweepSequence: sweep.sequence,
    geometryId: multicomponentSweepGeometryId(sweep),
    sweepStartHz: sweep.actualStartHz,
    sweepStopHz: sweep.actualStopHz,
    rbwHz: sweep.actualRbwHz,
    binWidthHz: multicomponentSweepBinWidthHz(sweep),
    observedRegionStartHz: association.startHz,
    observedRegionStopHz: association.stopHz,
    containmentToleranceHz: association.containmentToleranceHz,
    qualification: association.qualification,
    ...(anchorTrackId === undefined ? {} : { anchorTrackId }),
    members: sortedMembers,
  };
}

function multicomponentObservationLineageShape(
  observation: MulticomponentSweptRegionAssociationObservation,
) {
  return {
    geometryId: observation.geometryId,
    startHz: observation.observedRegionStartHz,
    stopHz: observation.observedRegionStopHz,
    rbwHz: observation.rbwHz,
    binWidthHz: observation.binWidthHz,
    memberCentersHz: observation.members.map(
      (member) => (member.startHz + member.stopHz) / 2,
    ),
  };
}

function multicomponentAssociationLineageCompatible(
  signal: DetectedSignal,
  current: MulticomponentSweptRegionAssociationObservation,
  maximumMissedSweeps: number,
): boolean {
  if (signal.associationMode !== 'multicomponent-swept-region-activity'
    || signal.associationModelId !== MULTICOMPONENT_SWEPT_REGION_MODEL_ID
    || signal.associationRegionStartHz === undefined
    || signal.associationRegionStopHz === undefined
    || !signal.associationId
    || !signal.associationRegionSweepIds?.length
    || !Number.isInteger(signal.associationMissedSweeps)
    || signal.associationMissedSweeps! < 0
    || signal.associationMissedSweeps! > maximumMissedSweeps) return false;
  const latest = signal.multicomponentAssociationObservations?.at(-1);
  if (!latest
    || signal.associationRegionStartHz !== latest.observedRegionStartHz
    || signal.associationRegionStopHz !== latest.observedRegionStopHz) return false;
  return multicomponentSweptRegionLineagesAreCompatible(
    multicomponentObservationLineageShape(latest),
    multicomponentObservationLineageShape(current),
  );
}

function regularAssociationLineageCompatible(
  signal: DetectedSignal,
  current: RegularSpectralComponentAssociationObservation,
  maximumMissedSweeps: number,
): boolean {
  if (signal.associationMode !== 'regular-spectral-component-activity'
    || signal.associationModelId !== REGULAR_SPECTRAL_COMPONENT_MODEL_ID
    || signal.associationRegionStartHz === undefined
    || signal.associationRegionStopHz === undefined
    || !signal.associationId
    || !signal.associationRegionSweepIds?.length
    || !Number.isInteger(signal.associationMissedSweeps)
    || signal.associationMissedSweeps! < 0
    || signal.associationMissedSweeps! > maximumMissedSweeps) return false;
  const latest = signal.regularComponentAssociationObservations?.at(-1);
  if (!latest
    || signal.associationRegionStartHz !== latest.observedRegionStartHz
    || signal.associationRegionStopHz !== latest.observedRegionStopHz
    || multicomponentSweepGeometryId(latest.sourceSweep)
      !== multicomponentSweepGeometryId(current.sourceSweep)) return false;
  return regularSpectralComponentLineagesAreCompatible(
    {
      startHz: latest.observedRegionStartHz,
      stopHz: latest.observedRegionStopHz,
      spacingHz: latest.spacingHz,
      latticeAnchorHz: latest.latticeAnchorHz,
      memberCentersHz: latest.members.map(
        (member) => (member.startHz + member.stopHz) / 2,
      ),
    },
    {
      startHz: current.observedRegionStartHz,
      stopHz: current.observedRegionStopHz,
      spacingHz: current.spacingHz,
      latticeAnchorHz: current.latticeAnchorHz,
      memberCentersHz: current.members.map(
        (member) => (member.startHz + member.stopHz) / 2,
      ),
    },
    current.sourceSweep.actualRbwHz,
    multicomponentSweepBinWidthHz(current.sourceSweep),
  );
}

function isStaticRegionAssociation(
  mode: DetectedSignal['associationMode'],
): mode is 'regular-spectral-component-activity' | 'multicomponent-swept-region-activity' {
  return mode === 'regular-spectral-component-activity' || mode === 'multicomponent-swept-region-activity';
}

function clearStaticRegionAssociation(signal: DetectedSignal): DetectedSignal {
  const next: DetectedSignal = { ...signal, associationMode: 'frequency-local' };
  delete next.associationRegionStartHz;
  delete next.associationRegionStopHz;
  delete next.associationRegionSweepIds;
  delete next.associationId;
  delete next.associationModelId;
  delete next.associationMemberTrackIds;
  delete next.associationObservations;
  delete next.multicomponentAssociationObservations;
  delete next.regularComponentAssociationObservations;
  delete next.associationOpportunities;
  delete next.associationBayesianEvidence;
  delete next.associationGeometryId;
  delete next.associationMissedSweeps;
  return next;
}

function matchScore(previous: DetectedSignal, candidate: DetectedSignal, sweep: Sweep): number {
  const overlap = Math.max(0, Math.min(previous.stopHz, candidate.stopHz) - Math.max(previous.startHz, candidate.startHz));
  const union = Math.max(previous.stopHz, candidate.stopHz) - Math.min(previous.startHz, candidate.startHz);
  const intersectionOverUnion = union > 0 ? overlap / union : previous.peakHz === candidate.peakHz ? 1 : 0;
  const binWidth = sweep.frequencyHz.length > 1 ? Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!) : 1;
  const centerDistance = Math.abs(previous.peakHz - candidate.peakHz);
  const tolerance = Math.max(binWidth * 3, previous.bandwidthHz, candidate.bandwidthHz, 1);
  // Local track identity is frequency-local by construction. Cross-frequency
  // compatibility is classification association evidence and must never add
  // persistence or posterior evidence to an ordinary detector track.
  if (intersectionOverUnion === 0 && centerDistance > tolerance) return -1;
  return intersectionOverUnion * 0.7 + (1 - Math.min(1, centerDistance / tolerance)) * 0.3;
}

function frequencyAgileObservationEligible(candidate: DetectedSignal, sweep: Sweep): boolean {
  return frequencyAgileSweepEligible(sweep)
    && candidate.sweepIds.length === 1
    && candidate.sweepIds[0] === sweep.id
    && candidate.bayesianEvidence.posteriorScope === 'selected-local-region'
    && candidate.stopHz >= FREQUENCY_AGILE_BAND_START_HZ
    && candidate.startHz <= FREQUENCY_AGILE_BAND_STOP_HZ
    && candidate.bandwidthHz <= FREQUENCY_AGILE_MAXIMUM_COMPONENT_BANDWIDTH_HZ;
}

function boundedFrequencyAgileCenter(candidate: DetectedSignal): number {
  // The midpoint of threshold-connected support is stable for a flat packet
  // channel; resolution can still straddle the 2402 MHz lower channel center,
  // so band overlap is tested and the representative center is bounded.
  return Math.max(
    FREQUENCY_AGILE_BAND_START_HZ,
    Math.min(FREQUENCY_AGILE_BAND_STOP_HZ, (candidate.startHz + candidate.stopHz) / 2),
  );
}

function validateSweep(sweep: Sweep): void {
  if (sweep.complete !== true) throw new Error('Sweep is incomplete');
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('Sweep frequency and power arrays have different lengths');
  if (sweep.powerDbm.length < 3) throw new Error('Sweep requires at least three measurement points');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Sweep contains non-finite measurement values');
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || sweep.actualStopHz <= sweep.actualStartHz) throw new Error('Sweep requires finite increasing actual frequency bounds');
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) throw new Error('Sweep requires a finite positive analysis resolution scale');
  for (let index = 1; index < sweep.frequencyHz.length; index++) {
    if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) throw new Error('Sweep frequencies are not strictly increasing');
  }
  const geometryToleranceHz = Math.max(sweep.actualRbwHz, (sweep.actualStopHz - sweep.actualStartHz) * 1e-9);
  if (sweep.frequencyHz[0]! < sweep.actualStartHz - geometryToleranceHz
    || sweep.frequencyHz.at(-1)! > sweep.actualStopHz + geometryToleranceHz) throw new Error('Sweep frequency grid lies outside its actual bounds');
}

function posteriorFromPriorAndLogBayesFactor(prior: number, logBayesFactor: number): number {
  const logPosteriorOdds = logBayesFactor + Math.log(prior / (1 - prior));
  if (logPosteriorOdds >= 0) return 1 / (1 + Math.exp(-logPosteriorOdds));
  const odds = Math.exp(logPosteriorOdds);
  return odds / (1 + odds);
}

function predictTrackPosterior(previous: number): number {
  return BAYESIAN_TRACK_MODEL.probabilitySignalPersists * previous
    + BAYESIAN_TRACK_MODEL.probabilitySignalAppears * (1 - previous);
}

function equivalentLogBayesFactor(posterior: number): number {
  const bounded = Math.min(1 - 1e-15, Math.max(1e-15, posterior));
  const prior = BAYESIAN_DETECTOR_MODEL.priorSignalProbability;
  return clampFinite(Math.log(bounded / (1 - bounded)) - Math.log(prior / (1 - prior)), -700, 700);
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (Number.isNaN(value)) throw new Error('Bayesian evidence calculation produced NaN');
  return Math.max(minimum, Math.min(maximum, value));
}

function validateZeroSpanCapture(capture: ZeroSpanCapture): void {
  if (!capture.complete) throw new Error('Envelope STFT requires a complete zero-span capture');
  if (!capture.powerDbm.length) throw new Error('Zero-span capture contains no power samples');
  if (capture.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Zero-span capture contains non-finite power samples');
  if (!Number.isFinite(capture.samplePeriodSeconds) || capture.samplePeriodSeconds <= 0) throw new Error('Envelope STFT requires a positive sample period');
}

interface SweepCell { startHz: number; stopHz: number; powerDbm: number; }
interface WeightedSweepCell extends SweepCell { milliwatts: number; }

function nominalBinWidth(frequencies: readonly number[]): number {
  if (frequencies.length < 2) throw new Error('Frequency-domain integration requires at least two sweep points');
  const differences = frequencies.slice(1).map((frequency, index) => frequency - frequencies[index]!);
  if (differences.some((difference) => !Number.isFinite(difference) || difference <= 0)) throw new Error('Frequency-domain integration requires strictly increasing sweep frequencies');
  return median(differences);
}

function sweepCells(sweep: Sweep): readonly SweepCell[] {
  const width = nominalBinWidth(sweep.frequencyHz);
  return sweep.frequencyHz.map((frequency, index) => {
    const startHz = index === 0 ? sweep.actualStartHz : (sweep.frequencyHz[index - 1]! + frequency) / 2;
    const stopHz = index === sweep.frequencyHz.length - 1 ? sweep.actualStopHz : (frequency + sweep.frequencyHz[index + 1]!) / 2;
    if (stopHz <= startHz) throw new Error(`Sweep bin ${index} has no positive frequency cell`);
    return { startHz, stopHz, powerDbm: sweep.powerDbm[index]! };
  }).map((cell, index, cells) => {
    if (index > 0 && Math.abs(cell.startHz - cells[index - 1]!.stopHz) > Math.max(1e-6, width * 1e-9)) throw new Error('Sweep frequency cells are discontinuous');
    return cell;
  });
}

function validateFrequencyWindow(sweep: Sweep, startHz: number, stopHz: number, name: string): void {
  if (!Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz <= startHz) throw new Error(`${name} requires a positive finite frequency window`);
  if (startHz < sweep.actualStartHz || stopHz > sweep.actualStopHz) {
    throw new Error(`${name} window ${startHz}–${stopHz} Hz is outside the acquired span ${sweep.actualStartHz}–${sweep.actualStopHz} Hz`);
  }
}

function cumulativeBoundary(cells: readonly WeightedSweepCell[], targetMilliwatts: number): number {
  if (!cells.length) throw new Error('Power percentile requires populated sweep cells');
  let cumulative = 0;
  for (const cell of cells) {
    const next = cumulative + cell.milliwatts;
    if (next >= targetMilliwatts) {
      const fraction = cell.milliwatts > 0 ? (targetMilliwatts - cumulative) / cell.milliwatts : 0;
      return cell.startHz + Math.min(1, Math.max(0, fraction)) * (cell.stopHz - cell.startHz);
    }
    cumulative = next;
  }
  return cells.at(-1)!.stopHz;
}

function unknownClassification(detection: DetectedSignal, modelId: string, unknownReason: WaveformClassification['unknownReason']): WaveformClassification {
  return {
    detectionId: detection.id,
    label: 'unknown',
    confidence: 0,
    candidates: [],
    modelId,
    qualification: modelId === 'unconfigured' ? 'unavailable' : 'spectral-morphology',
    scoreKind: 'none',
    decisionLevel: 'unknown',
    unknownReason,
    classifiedAt: new Date().toISOString(),
    evidence: {
      centerHz: (detection.startHz + detection.stopHz) / 2,
      bandwidthHz: detection.bandwidthHz,
      peakDbm: detection.peakDbm,
      sweepIds: detection.sweepIds,
    },
  };
}

function legacyOccupiedBandwidth(sweep: Sweep, fraction: number): number {
  const floorMilliwatts = dbmToMilliwatts(robustNoiseFloor(sweep.powerDbm));
  const corrected = sweep.powerDbm.map((value) => Math.max(0, dbmToMilliwatts(value) - floorMilliwatts));
  const total = corrected.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const tail = (1 - fraction) / 2;
  let cumulative = 0;
  let lower = 0;
  let upper = corrected.length - 1;
  for (let index = 0; index < corrected.length; index++) {
    cumulative += corrected[index]!;
    if (cumulative / total >= tail) { lower = index; break; }
  }
  cumulative = 0;
  for (let index = corrected.length - 1; index >= 0; index--) {
    cumulative += corrected[index]!;
    if (cumulative / total >= tail) { upper = index; break; }
  }
  return Math.max(0, sweep.frequencyHz[upper]! - sweep.frequencyHz[lower]!);
}

function spectralFlatness(valuesDbm: readonly number[]): number {
  const linear = valuesDbm.map((value) => Math.max(Number.MIN_VALUE, dbmToMilliwatts(value)));
  const geometric = Math.exp(linear.reduce((sum, value) => sum + Math.log(value), 0) / linear.length);
  const arithmetic = linear.reduce((sum, value) => sum + value, 0) / linear.length;
  return arithmetic > 0 ? clamp01(geometric / arithmetic) : 0;
}

function countLocalPeaks(values: readonly number[], threshold: number): number {
  if (values.length < 3) return values.some((value) => value >= threshold) ? 1 : 0;
  let count = 0;
  for (let index = 1; index < values.length - 1; index++) {
    if (values[index]! >= threshold && values[index]! > values[index - 1]! && values[index]! >= values[index + 1]!) count++;
  }
  return count;
}

function dominantAutocorrelationLag(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  let bestLag = 0;
  let best = 0;
  const maximumLag = Math.min(Math.floor(values.length / 2), 100);
  for (let lag = 2; lag <= maximumLag; lag++) {
    let numerator = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let index = lag; index < centered.length; index++) {
      const left = centered[index]!;
      const right = centered[index - lag]!;
      numerator += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const correlation = leftPower > 0 && rightPower > 0 ? numerator / Math.sqrt(leftPower * rightPower) : 0;
    if (correlation > best) { best = correlation; bestLag = lag; }
  }
  return best >= 0.45 ? bestLag : 0;
}

function sameFrequencyGrid(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((frequency, index) => frequency === right[index]);
}

function sameTraceResolutionProvenance(frame: TraceFrame, sweep: Sweep): boolean {
  return frame.actualRbwHz === sweep.actualRbwHz
    && frame.resolutionBandwidthQualification === sweep.resolutionBandwidthQualification;
}

function isPassiveTraceMode(mode: TraceConfiguration['mode']): mode is 'view' | 'blank' {
  return mode === 'view' || mode === 'blank';
}

function averagePowerFrames(frames: readonly (readonly number[])[]): number[] {
  if (!frames.length) throw new Error('Trace averaging requires at least one frame');
  const points = frames[0]!.length;
  if (frames.some((frame) => frame.length !== points)) throw new Error('Trace averaging requires identical point counts');
  return Array.from({ length: points }, (_, index) => {
    const averageMilliwatts = frames.reduce((total, frame) => total + dbmToMilliwatts(frame[index]!), 0) / frames.length;
    return milliwattsToDbm(averageMilliwatts);
  });
}

function maximumIndex(values: readonly number[]): number {
  if (!values.length) throw new Error('Maximum search requires samples');
  return values.reduce((best, value, index) => value > values[best]! ? index : best, 0);
}

function minimumIndex(values: readonly number[]): number {
  if (!values.length) throw new Error('Minimum search requires samples');
  return values.reduce((best, value, index) => value < values[best]! ? index : best, 0);
}

function nearestFrequencyIndex(frequencies: readonly number[], frequencyHz: number): number {
  if (!frequencies.length || !Number.isFinite(frequencyHz)) throw new Error('Marker placement requires a finite frequency and a populated trace');
  return frequencies.reduce((best, frequency, index) => Math.abs(frequency - frequencyHz) < Math.abs(frequencies[best]! - frequencyHz) ? index : best, 0);
}

function localPeakIndices(values: readonly number[], search: MarkerSearchConfiguration): number[] {
  const peaks: number[] = [];
  for (let index = 1; index < values.length - 1; index++) {
    const value = values[index]!;
    if (value < search.minimumLevelDbm || value <= values[index - 1]! || value < values[index + 1]!) continue;
    const leftMinimum = Math.min(...values.slice(Math.max(0, index - 4), index));
    const rightMinimum = Math.min(...values.slice(index + 1, Math.min(values.length, index + 5)));
    if (value - Math.max(leftMinimum, rightMinimum) >= search.minimumExcursionDb) peaks.push(index);
  }
  return peaks;
}

function dbmToMilliwatts(value: number): number { return 10 ** (value / 10); }
function milliwattsToDbm(value: number): number { return value > 0 ? 10 * Math.log10(value) : Number.NEGATIVE_INFINITY; }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export {
  BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY,
  DETECTED_POWER_ACQUISITION_QUALIFICATION,
  DETECTED_POWER_AUTOMATIC_SELECTION_CONDITION,
  DETECTED_POWER_OPERATOR_SELECTION_CONDITION,
  extractObservableFeatures,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
} from './observable-features.js';
export type { WaveformEvidence } from './observable-features.js';
export {
  DETECTED_POWER_CAPTURE_RUNTIME_ADMISSION_POLICY_ID,
} from './detected-power-capture-receipt.js';
export { logGamma, logSumExp, mixtureLogLikelihood, posteriorCandidates, regularizedIncompleteBeta, studentTLogDensity, studentTModelTailProbability } from './bayesian-predictive.js';
export {
  OBSERVABLE_TRAINING_BASELINE_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULE,
  OBSERVABLE_TRAINING_BASELINE_SPECTRUM_TEMPORAL_SCHEDULE,
  OBSERVABLE_TRAINING_BASELINE_TEMPORAL_SCHEDULE,
  OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY,
  OBSERVABLE_TRAINING_SWEEP_POINTS,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_BRANCH_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME_METADATA,
  SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES,
  SIGNAL_LAB_PRODUCTION_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_DETECTED_POWER_CAPTURE_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES,
  SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS,
  SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES,
  createObservableTrainingSourceClock,
  createSignalLabProductionProfileCapturePolicy,
  observableTrainingActualRbwHz,
  observableTrainingDetectedPowerSynthesisFilterWidthHz,
  occupiedBandwidthRbwDivisorGeometry,
} from './observable-training-acquisition-geometry.js';
export type {
  ObservableTrainingAcquisitionGeometry,
  ObservableTrainingAcquisitionRegime,
  ObservableTrainingDetectedPowerClockContext,
  ObservableTrainingDetectedPowerClockEvent,
  ObservableTrainingProductionTemporalSchedulePair,
  ObservableTrainingScenarioGeometry,
  ObservableTrainingSourceClock,
  ObservableTrainingSourceClockEvent,
  ObservableTrainingSpectrumClockContext,
  ObservableTrainingSpectrumClockEvent,
  ObservableTrainingTemporalSchedule,
  SignalLabProductionProfileCapturePolicy,
  SignalLabProductionQualifiedEnvelopeReleaseGateProfileSourcePlan,
  SignalLabProductionSpectrumReleaseGateProfileSourcePlan,
} from './observable-training-acquisition-geometry.js';
