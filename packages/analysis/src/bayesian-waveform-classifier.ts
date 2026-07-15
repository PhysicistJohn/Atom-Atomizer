import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';
import { mixtureLogLikelihood, logSumExp, studentTModelTailProbability, type PosteriorCandidate } from './bayesian-predictive.js';
import { extractObservableFeatures, type ObservableFeatureObservation, type WaveformEvidence } from './observable-features.js';
import {
  OBSERVABLE_LEAF_CLASSES,
  type ObservableDecisionClass,
  type ObservableLeafClass,
} from './observable-classifier-model.js';
import { BAYESIAN_OBSERVABLE_MODEL } from './models/bayesian-observable-v5.generated.js';
import { BAYESIAN_OBSERVABLE_MODEL_SHA256 } from './models/bayesian-observable-v5.manifest.generated.js';
import { observableHypothesisHasRequiredEvidence } from './observable-hypothesis-domain.js';

export const BAYESIAN_WAVEFORM_MODEL = {
  id: BAYESIAN_OBSERVABLE_MODEL.id,
  producer: 'tinysa-signal-lab',
  sourceCommit: BAYESIAN_OBSERVABLE_MODEL.sourceCommit,
  corpusSha256: BAYESIAN_OBSERVABLE_MODEL.corpusSha256,
  modelAssetSha256: BAYESIAN_OBSERVABLE_MODEL_SHA256,
  preprocessing: BAYESIAN_OBSERVABLE_MODEL.preprocessing,
  priorId: BAYESIAN_OBSERVABLE_MODEL.priorId,
  calibrationId: BAYESIAN_OBSERVABLE_MODEL.calibrationId,
  decisionPolicyId: 'observable-open-set-decision-v9',
  classCount: OBSERVABLE_LEAF_CLASSES.length,
  minimumSpectrumSweeps: 8,
  minimumKnownPosterior: 0.55,
  minimumLeafPosterior: 0.58,
  minimumAggregatePosterior: 0.68,
  minimumSiblingMargin: 0.12,
  maximumUnknownPosteriorForAcceptance: 0.4,
  // This is an engineering cutoff on a finite synthetic-reference lower-tail
  // rank. The fixed, stratified SNR/RBW/scenario grid is not an exchangeable
  // sample from an operational population, so 0.025 is neither a conformal
  // alpha nor a 2.5% false-rejection guarantee. Physical data remain wholly
  // uncalibrated.
  minimumKnownSyntheticSupportRank: 0.025,
} as const;

interface BayesianDecision {
  label: ObservableDecisionClass | 'unknown';
  probability: number;
  level: 'equivalence-class' | 'unknown';
  reason?: WaveformClassification['unknownReason'];
}

export class BayesianWaveformClassifier {
  readonly modelId = BAYESIAN_WAVEFORM_MODEL.id;

  constructor() { assertGeneratedModel(); }

  async classify(detection: DetectedSignal, evidence: WaveformEvidence, signal?: AbortSignal): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    if (!supportedDetectorConfiguration(detection)) return unavailableEvidence(detection, 'out-of-domain', 'detector-configuration-out-of-domain');
    let observation: ObservableFeatureObservation;
    try {
      observation = extractObservableFeatures(detection, evidence);
    } catch (error) {
      if (error instanceof Error && /at least one coherent|no active spectral/i.test(error.message)) return unavailableEvidence(detection, 'insufficient-evidence');
      throw error;
    }
    signal?.throwIfAborted();
    const candidates = inferPosterior(observation);
    const knownSupportRank = knownModelSupportRank(observation);
    const boundaryCensored = observation.limitations.includes('partial-span-boundary-censoring');
    const insufficientSweeps = observation.sweepIds.length < BAYESIAN_WAVEFORM_MODEL.minimumSpectrumSweeps;
    const decision = boundaryCensored
      ? unknownDecision(probability(candidates, 'unknown-signal'), 'out-of-domain')
      : insufficientSweeps
        ? unknownDecision(probability(candidates, 'unknown-signal'), 'insufficient-evidence')
        : selectDecision(candidates, observation, knownSupportRank);
    const supportRejected = decision.label === 'unknown'
      && decision.reason === 'out-of-domain'
      && knownSupportRank < BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportRank;
    const outputCandidates = candidates.map((candidate) => ({
      label: candidate.id === 'unknown-signal' ? 'unknown' : `observable:${candidate.id}`,
      confidence: candidate.probability,
      family: candidate.id === 'unknown-signal' ? 'unknown' : leafFamily(candidate.id),
    }));
    return {
      detectionId: detection.id,
      label: decision.label === 'unknown' ? 'unknown' : `observable:${decision.label}`,
      confidence: supportRejected ? 0 : decision.probability,
      candidates: outputCandidates,
      modelId: BAYESIAN_WAVEFORM_MODEL.id,
      qualification: 'bayesian-observable-equivalence',
      scoreKind: 'model-posterior',
      decisionLevel: decision.level,
      decisionSupport: supportRejected
        ? { kind: 'synthetic-support-rank', value: knownSupportRank, threshold: BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportRank }
        : { kind: 'model-posterior', value: decision.probability },
      modelProvenance: {
        producer: 'tinysa-signal-lab',
        sourceCommit: BAYESIAN_WAVEFORM_MODEL.sourceCommit,
        corpusSha256: BAYESIAN_WAVEFORM_MODEL.corpusSha256,
        preprocessing: BAYESIAN_WAVEFORM_MODEL.preprocessing,
        modelAssetSha256: BAYESIAN_WAVEFORM_MODEL.modelAssetSha256,
        priorId: BAYESIAN_WAVEFORM_MODEL.priorId,
        calibrationId: BAYESIAN_WAVEFORM_MODEL.calibrationId,
        decisionPolicyId: BAYESIAN_WAVEFORM_MODEL.decisionPolicyId,
      },
      classifiedAt: new Date().toISOString(),
      ...(decision.reason ? { unknownReason: decision.reason } : {}),
      evidence: {
        centerHz: observation.centerHz,
        bandwidthHz: observation.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: observation.sweepIds,
        ...(observation.zeroSpanCaptureId ? { zeroSpanCaptureId: observation.zeroSpanCaptureId } : {}),
        views: observation.views,
        features: { ...observation.values, 'model.maximumKnownSyntheticSupportRank': knownSupportRank },
        limitations: observation.limitations,
      },
    };
  }
}

export function inferPosterior(observation: ObservableFeatureObservation): readonly PosteriorCandidate[] {
  assertGeneratedModel();
  const values = BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => {
    const logLikelihood = mixtureLogLikelihood(observation.values, model.components);
    const context = observableHypothesisHasRequiredEvidence(model.id, observation)
      ? frequencyContextLogEvidence(model.id, observation)
      : Number.NEGATIVE_INFINITY;
    return { id: model.id, logLikelihood, logJoint: model.logPrior + context + logLikelihood };
  });
  const normalization = logSumExp(values.map((value) => value.logJoint));
  const candidates = values.map((value) => ({ ...value, probability: Math.exp(value.logJoint - normalization) }))
    .sort((left, right) => right.probability - left.probability);
  const total = candidates.reduce((sum, value) => sum + value.probability, 0);
  if (!Number.isFinite(total) || Math.abs(total - 1) > 1e-9 || candidates.some((value) => value.probability < 0 || value.probability > 1)) throw new Error('Observable posterior failed to normalize');
  return candidates;
}

type DecisionObservation = Pick<ObservableFeatureObservation, 'centerHz' | 'bandwidthHz' | 'values'>
  & Partial<Pick<ObservableFeatureObservation, 'occupiedStartHz' | 'occupiedStopHz'>>
  & Partial<Pick<ObservableFeatureObservation, 'limitations'>>;

export function selectObservableDecision(
  candidates: readonly PosteriorCandidate[],
  observation?: DecisionObservation,
  knownSupportRank?: number,
): { label: ObservableDecisionClass | 'unknown'; probability: number } {
  const decision = selectDecision(candidates, observation, knownSupportRank ?? (observation ? knownModelSupportRank(observation) : 1));
  return { label: decision.label, probability: decision.probability };
}

export function knownModelSupportRank(
  observation: Pick<ObservableFeatureObservation, 'values'>
    & Partial<Pick<ObservableFeatureObservation, 'occupiedStartHz' | 'occupiedStopHz' | 'centerHz' | 'bandwidthHz' | 'limitations'>>,
): number {
  assertGeneratedModel();
  const view = observation.values['envelope.logTransitionRateHz'] !== undefined
    ? 'envelope-timed'
    : Object.keys(observation.values).some((name) => name.startsWith('envelope.'))
      ? 'envelope-untimed'
      : 'spectrum-only';
  return Math.max(0, ...BAYESIAN_OBSERVABLE_MODEL.classModels
    // A tail score answers whether the measured shape is supported by an
    // eligible known hypothesis. Letting an ineligible, broad component win
    // this maximum defeats open-set rejection even though its posterior is
    // structurally zero (notably a stationary 2.4 GHz hard negative versus
    // the frequency-agile Bluetooth activity hypothesis).
    .filter((model) => model.id !== 'unknown-signal' && observableHypothesisHasRequiredEvidence(model.id, observation))
    .map((model) => {
      const rawTailScore = Math.max(...model.components.map((component) => studentTModelTailProbability(observation.values, component)));
      const calibration = model.tailCalibrationScoresByView?.[view];
      if (!calibration?.length) throw new Error(`Known class ${model.id} has no ${view} synthetic support calibration`);
      return empiricalSyntheticSupportRank(rawTailScore, calibration);
    }));
}

/**
 * Smoothed empirical lower-tail rank against a sorted synthetic reference.
 *
 * If an acquisition attempt has representative supports S_1...S_k and its
 * stored reference score is M=min(S_1...S_k), monotonicity gives R(S_j)>=R(M)
 * for every member j. That makes the attempt-minimum reference conservative
 * for a single member's rank. It does not create an exchangeability or
 * coverage guarantee for the fixed synthetic nuisance grid.
 */
export function empiricalSyntheticSupportRank(rawSupport: number, sortedReference: readonly number[]): number {
  if (!Number.isFinite(rawSupport) || rawSupport < 0 || rawSupport > 1) {
    throw new Error('Synthetic support must be finite and within [0, 1]');
  }
  if (!sortedReference.length) throw new Error('Synthetic support reference must not be empty');
  let previous = Number.NEGATIVE_INFINITY;
  let lowerOrEqual = 0;
  for (const value of sortedReference) {
    if (!Number.isFinite(value) || value < 0 || value > 1 || value < previous) {
      throw new Error('Synthetic support reference must be sorted, finite, and within [0, 1]');
    }
    if (value <= rawSupport) lowerOrEqual += 1;
    previous = value;
  }
  return (lowerOrEqual + 1) / (sortedReference.length + 1);
}

function selectDecision(
  candidates: readonly PosteriorCandidate[],
  observation?: DecisionObservation,
  knownSupportRank = observation ? knownModelSupportRank(observation) : 1,
): BayesianDecision {
  const unknownPosterior = probability(candidates, 'unknown-signal');
  const knownPosterior = 1 - unknownPosterior;
  if (knownSupportRank < BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportRank) return unknownDecision(unknownPosterior, 'out-of-domain');
  if (unknownPosterior > BAYESIAN_WAVEFORM_MODEL.maximumUnknownPosteriorForAcceptance || knownPosterior < BAYESIAN_WAVEFORM_MODEL.minimumKnownPosterior) return unknownDecision(unknownPosterior, 'out-of-domain');

  const topKnown = candidates.find((candidate) => candidate.id !== 'unknown-signal');
  if (!topKnown) return unknownDecision(unknownPosterior, 'low-confidence');
  if (!observableHypothesisHasRequiredEvidence(topKnown.id as ObservableLeafClass, observation ?? {})) {
    return unknownDecision(unknownPosterior, 'insufficient-evidence');
  }
  const lte = aggregate(candidates, ['lte-fdd-like', 'lte-tdd-like']);
  const nr = aggregate(candidates, ['nr-fdd-like', 'nr-tdd-like']);
  const cellularOfdm = lte + nr;
  const wifi = aggregate(candidates, ['wifi-hr-dsss-like', 'wifi-ofdm-like']);
  const topKnownIsCellularOfdm = topKnown.id === 'lte-fdd-like'
    || topKnown.id === 'lte-tdd-like'
    || topKnown.id === 'nr-fdd-like'
    || topKnown.id === 'nr-tdd-like';
  const topKnownIsWifi = topKnown.id === 'wifi-hr-dsss-like' || topKnown.id === 'wifi-ofdm-like';
  // The pinned corpus starts with nominal 5 MHz LTE. Its detector-conditioned
  // occupied widths do not support claims below this conservative boundary.
  // This is a model-domain boundary, not a claim that narrower LTE cannot
  // exist in the standards.
  const cellularBandwidthInModelDomain = !observation || observation.bandwidthHz >= 3_500_000;
  const qualifiedDuplexTiming = observation?.values['envelope.logTransitionRateHz'] !== undefined;
  if (topKnownIsCellularOfdm && !cellularBandwidthInModelDomain) return unknownDecision(unknownPosterior, 'out-of-domain');
  // LTE and NR at 20 MHz and below can be deliberately spectrum-shared and
  // are not identifiable from scalar power without a separately qualified
  // distinguishing observation. Never let a synthetic texture artifact force
  // a technology leaf in that domain.
  // Allow 25 MHz measured width for a nominal 20 MHz channel because
  // threshold/RBW broadening is itself part of this scalar observation.
  if (observation
    && topKnownIsCellularOfdm
    && cellularBandwidthInModelDomain
    && observation.bandwidthHz <= 25_000_000
    && cellularOfdm >= BAYESIAN_WAVEFORM_MODEL.minimumKnownPosterior) {
    return { label: 'cellular-ofdm-ambiguous', probability: cellularOfdm, level: 'equivalence-class' };
  }
  // Scalar swept power and a fixed-tune detected envelope contain no decoded
  // preamble, DSSS/CCK correlation, cyclic-prefix, or cyclostationary evidence.
  // Keep both Wi-Fi template posteriors as diagnostics, but never promote
  // their within-family ranking to a primary PHY decision. Exact proprietary
  // DSSS/OFDM nulls demonstrate that the observable claim stops at compatible
  // 802.11 channel morphology.
  if (topKnownIsWifi) {
    return wifi >= BAYESIAN_WAVEFORM_MODEL.minimumAggregatePosterior
      ? { label: 'wifi-like', probability: wifi, level: 'equivalence-class' }
      : unknownDecision(unknownPosterior, 'low-confidence');
  }
  const siblings = siblingLeaves(topKnown.id as ObservableLeafClass);
  const secondSibling = Math.max(0, ...siblings.filter((id) => id !== topKnown.id).map((id) => probability(candidates, id)));
  const duplexLeafSupported = !topKnownIsCellularOfdm
    || ((topKnown.id === 'lte-tdd-like' || topKnown.id === 'nr-tdd-like') && qualifiedDuplexTiming);
  if (duplexLeafSupported
    && topKnown.probability >= BAYESIAN_WAVEFORM_MODEL.minimumLeafPosterior
    && topKnown.probability - secondSibling >= BAYESIAN_WAVEFORM_MODEL.minimumSiblingMargin) {
    return { label: topKnown.id as ObservableDecisionClass, probability: topKnown.probability, level: 'equivalence-class' };
  }

  if (topKnownIsCellularOfdm && cellularBandwidthInModelDomain && cellularOfdm >= BAYESIAN_WAVEFORM_MODEL.minimumAggregatePosterior) {
    if (lte >= BAYESIAN_WAVEFORM_MODEL.minimumAggregatePosterior) return { label: 'lte-like', probability: lte, level: 'equivalence-class' };
    if (nr >= BAYESIAN_WAVEFORM_MODEL.minimumAggregatePosterior) return { label: 'nr-like', probability: nr, level: 'equivalence-class' };
    return { label: 'cellular-ofdm-ambiguous', probability: cellularOfdm, level: 'equivalence-class' };
  }
  return unknownDecision(unknownPosterior, 'low-confidence');
}

function siblingLeaves(id: ObservableLeafClass): readonly ObservableLeafClass[] {
  if (id === 'lte-fdd-like' || id === 'lte-tdd-like') return ['lte-fdd-like', 'lte-tdd-like'];
  if (id === 'nr-fdd-like' || id === 'nr-tdd-like') return ['nr-fdd-like', 'nr-tdd-like'];
  if (id === 'wifi-hr-dsss-like' || id === 'wifi-ofdm-like') return ['wifi-hr-dsss-like', 'wifi-ofdm-like'];
  return [id];
}

function frequencyContextLogEvidence(id: ObservableLeafClass, observation: ObservableFeatureObservation): number {
  // Frequency is a structural model-support condition below. Do not add
  // arbitrary unnormalized log constants and call the result Bayesian
  // evidence. A future survey-specific band prior must be explicit,
  // normalized, and versioned before it can enter the posterior.
  void id;
  void observation;
  return 0;
}

function leafFamily(id: string): string {
  if (id.startsWith('cw') || id.startsWith('am-') || id.startsWith('fm-')) return 'analog';
  if (id === 'gsm-like' || id.startsWith('lte-') || id.startsWith('nr-')) return 'cellular';
  if (id.startsWith('wifi-')) return 'wifi';
  if (id.startsWith('bluetooth-')) return 'bluetooth';
  return 'unknown';
}

function aggregate(candidates: readonly PosteriorCandidate[], ids: readonly ObservableLeafClass[]): number {
  return ids.reduce((sum, id) => sum + probability(candidates, id), 0);
}

function probability(candidates: readonly PosteriorCandidate[], id: string): number {
  return candidates.find((candidate) => candidate.id === id)?.probability ?? 0;
}

function unknownDecision(probabilityValue: number, reason: WaveformClassification['unknownReason']): BayesianDecision {
  return { label: 'unknown', probability: probabilityValue, level: 'unknown', reason };
}

function unavailableEvidence(detection: DetectedSignal, reason: WaveformClassification['unknownReason'], limitation = 'insufficient-spectrum-evidence'): WaveformClassification {
  return {
    detectionId: detection.id,
    label: 'unknown',
    confidence: 0,
    candidates: [{ label: 'unknown', confidence: 0, family: 'unknown' }],
    modelId: BAYESIAN_WAVEFORM_MODEL.id,
    qualification: 'bayesian-observable-equivalence',
    scoreKind: 'none',
    decisionLevel: 'unknown',
    classifiedAt: new Date().toISOString(),
    unknownReason: reason,
    evidence: { centerHz: detection.peakHz, bandwidthHz: detection.bandwidthHz, peakDbm: detection.peakDbm, sweepIds: detection.sweepIds, limitations: [limitation] },
  };
}

function supportedDetectorConfiguration(detection: DetectedSignal): boolean {
  const config = detection.detectorConfig;
  return detection.detectorId === 'bayesian-exponential-multiscale-cfar-v3'
    && config.threshold.strategy === 'noise-relative'
    && config.threshold.marginDb === 10
    && config.minimumBandwidthHz === 0
    && config.minimumProminenceDb === 6
    && config.minimumConsecutiveSweeps === 2
    && config.releaseAfterMissedSweeps === 2;
}

export type { WaveformEvidence } from './observable-features.js';
export { observableClassDefinitions } from './observable-classifier-model.js';

function assertGeneratedModel(): void {
  if (BAYESIAN_OBSERVABLE_MODEL.id !== 'bayesian-observable-equivalence-v5'
    || BAYESIAN_OBSERVABLE_MODEL.preprocessing !== 'scalar-observable-features-v5'
    || BAYESIAN_OBSERVABLE_MODEL.calibrationId !== 'synthetic-view-matched-stratified-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v7'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.classificationSweeps !== 8
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.observationOpportunityHorizons?.standard !== 24
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.observationOpportunityHorizons.fullBand2g4 !== 96
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.selectionPolicy !== 'online-first-ready-all-representatives-v3'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.representativeWeightingPolicy !== 'equal-weight-per-first-ready-production-representative-v2'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.representativeEligibilityPolicy !== 'runtime-domain-qualified-known-representatives-v3'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit !== 'one-score-per-fit-eligible-acquisition-attempt-v1'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy !== 'minimum-support-across-fit-eligible-first-ready-representatives-v1'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy !== 'single-representative-rank-dominates-attempt-min-rank-v1'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation !== 'empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1') {
    throw new Error('Observable model asset does not match the v5 production admission contract');
  }
  const ids = BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id);
  if (ids.length !== OBSERVABLE_LEAF_CLASSES.length || new Set(ids).size !== ids.length || OBSERVABLE_LEAF_CLASSES.some((id) => !ids.includes(id))) {
    throw new Error('Observable model taxonomy does not match the runtime contract');
  }
  const priorTotal = BAYESIAN_OBSERVABLE_MODEL.classModels.reduce((sum, model) => sum + Math.exp(model.logPrior), 0);
  if (!Number.isFinite(priorTotal) || Math.abs(priorTotal - 1) > 1e-9) throw new Error('Observable model class priors are not normalized');
  for (const model of BAYESIAN_OBSERVABLE_MODEL.classModels) {
    const weightTotal = model.components.reduce((sum, component) => sum + Math.exp(component.logWeight), 0);
    if (!model.components.length || !Number.isFinite(weightTotal) || Math.abs(weightTotal - 1) > 1e-9) throw new Error(`Observable model mixture ${model.id} is not normalized`);
    if (model.components.some((component) => component.dimensions.length !== BAYESIAN_OBSERVABLE_MODEL.dimensions.length
      || component.dimensions.some((dimension, index) => dimension !== BAYESIAN_OBSERVABLE_MODEL.dimensions[index]))) {
      throw new Error(`Observable model mixture ${model.id} does not use the pinned feature order`);
    }
    if (model.id !== 'unknown-signal') {
      const calibration = model.tailCalibrationScoresByView;
      for (const view of ['spectrum-only', 'envelope-untimed', 'envelope-timed'] as const) {
        const scores = calibration?.[view];
        if (!scores?.length || scores.some((value, index) => !Number.isFinite(value) || value < 0 || value > 1 || (index > 0 && value < scores[index - 1]!))) {
          throw new Error(`Observable model ${view} support calibration ${model.id} is invalid`);
        }
      }
    }
  }
}
