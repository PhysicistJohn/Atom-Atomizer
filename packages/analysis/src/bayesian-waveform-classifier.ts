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
import { BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL } from './bayesian-agile-association.js';

const MODEL_BANDS_MHZ = {
  gsm: [[380, 500], [698, 1_000], [1_710, 1_990]],
  wifiHrDsss: [[2_400, 2_500]],
  wifiOfdm: [[2_400, 2_500], [4_900, 5_925], [5_925, 7_125]],
  lteFdd: [[698, 960], [1_427, 1_518], [1_710, 2_200]],
  lteTdd: [[1_850, 1_920], [2_010, 2_025], [2_300, 2_400], [2_496, 2_690], [3_400, 3_800]],
  nrFdd: [[410, 960], [1_427, 1_518], [1_710, 2_200]],
  nrTdd: [[1_850, 1_920], [2_010, 2_025], [2_300, 2_690], [3_300, 5_000]],
} as const;

export const BAYESIAN_WAVEFORM_MODEL = {
  id: BAYESIAN_OBSERVABLE_MODEL.id,
  producer: 'tinysa-signal-lab',
  sourceCommit: BAYESIAN_OBSERVABLE_MODEL.sourceCommit,
  corpusSha256: BAYESIAN_OBSERVABLE_MODEL.corpusSha256,
  modelAssetSha256: BAYESIAN_OBSERVABLE_MODEL_SHA256,
  preprocessing: BAYESIAN_OBSERVABLE_MODEL.preprocessing,
  priorId: BAYESIAN_OBSERVABLE_MODEL.priorId,
  calibrationId: BAYESIAN_OBSERVABLE_MODEL.calibrationId,
  decisionPolicyId: 'observable-open-set-decision-v8',
  classCount: OBSERVABLE_LEAF_CLASSES.length,
  minimumSpectrumSweeps: 8,
  minimumKnownPosterior: 0.55,
  minimumLeafPosterior: 0.58,
  minimumAggregatePosterior: 0.68,
  minimumSiblingMargin: 0.12,
  maximumUnknownPosteriorForAcceptance: 0.4,
  // Inductive rank calibration turns each class's fixed-model radial score
  // into a finite-sample synthetic support p-value. The 2.5% rule has its
  // coverage meaning only under exchangeability with the pinned SignalLab
  // calibration generator. Maximizing across eligible known classes protects
  // known-class retention but is anti-conservative for open-set rejection;
  // this remains a synthetic development gate, not a physical false-accept p-value.
  // It remains explicitly uncalibrated for physical receiver data.
  minimumKnownSyntheticSupportPValue: 0.025,
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
    const knownSupportPValue = knownModelSupportPValue(observation);
    const boundaryCensored = observation.limitations.includes('partial-span-boundary-censoring');
    const insufficientSweeps = observation.sweepIds.length < BAYESIAN_WAVEFORM_MODEL.minimumSpectrumSweeps;
    const decision = boundaryCensored
      ? unknownDecision(probability(candidates, 'unknown-signal'), 'out-of-domain')
      : insufficientSweeps
        ? unknownDecision(probability(candidates, 'unknown-signal'), 'insufficient-evidence')
        : selectDecision(candidates, observation, knownSupportPValue);
    const supportRejected = decision.label === 'unknown'
      && decision.reason === 'out-of-domain'
      && knownSupportPValue < BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportPValue;
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
        ? { kind: 'synthetic-support-p-value', value: knownSupportPValue, threshold: BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportPValue }
        : { kind: 'model-posterior', value: decision.probability },
      modelProvenance: {
        producer: 'tinysa-signal-lab',
        sourceCommit: BAYESIAN_WAVEFORM_MODEL.sourceCommit,
        catalogSha256: BAYESIAN_WAVEFORM_MODEL.corpusSha256,
        generatorSha256: BAYESIAN_WAVEFORM_MODEL.corpusSha256,
        preprocessing: BAYESIAN_WAVEFORM_MODEL.preprocessing,
        modelAssetSha256: BAYESIAN_WAVEFORM_MODEL.modelAssetSha256,
        datasetSha256: BAYESIAN_WAVEFORM_MODEL.corpusSha256,
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
        features: { ...observation.values, 'model.maximumKnownSyntheticSupportPValue': knownSupportPValue },
        limitations: observation.limitations,
      },
    };
  }
}

export function inferPosterior(observation: ObservableFeatureObservation): readonly PosteriorCandidate[] {
  assertGeneratedModel();
  const values = BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => {
    const logLikelihood = mixtureLogLikelihood(observation.values, model.components);
    const context = hypothesisHasRequiredEvidence(model.id, observation)
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
  knownSupportPValue?: number,
): { label: ObservableDecisionClass | 'unknown'; probability: number } {
  const decision = selectDecision(candidates, observation, knownSupportPValue ?? (observation ? knownModelSupportPValue(observation) : 1));
  return { label: decision.label, probability: decision.probability };
}

export function knownModelSupportPValue(
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
    .filter((model) => model.id !== 'unknown-signal' && hypothesisHasRequiredEvidence(model.id, observation))
    .map((model) => {
      const rawTailScore = Math.max(...model.components.map((component) => studentTModelTailProbability(observation.values, component)));
      const calibration = model.tailCalibrationScoresByView?.[view];
      if (!calibration?.length) throw new Error(`Known class ${model.id} has no ${view} synthetic support calibration`);
      const rank = calibration.filter((value) => value <= rawTailScore).length;
      return (rank + 1) / (calibration.length + 1);
    }));
}

function selectDecision(
  candidates: readonly PosteriorCandidate[],
  observation?: DecisionObservation,
  knownSupportPValue = observation ? knownModelSupportPValue(observation) : 1,
): BayesianDecision {
  const unknownPosterior = probability(candidates, 'unknown-signal');
  const knownPosterior = 1 - unknownPosterior;
  if (knownSupportPValue < BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportPValue) return unknownDecision(unknownPosterior, 'out-of-domain');
  if (unknownPosterior > BAYESIAN_WAVEFORM_MODEL.maximumUnknownPosteriorForAcceptance || knownPosterior < BAYESIAN_WAVEFORM_MODEL.minimumKnownPosterior) return unknownDecision(unknownPosterior, 'out-of-domain');

  const topKnown = candidates.find((candidate) => candidate.id !== 'unknown-signal');
  if (!topKnown) return unknownDecision(unknownPosterior, 'low-confidence');
  if (!hypothesisHasRequiredEvidence(topKnown.id as ObservableLeafClass, observation ?? {})) {
    return unknownDecision(unknownPosterior, 'insufficient-evidence');
  }
  const lte = aggregate(candidates, ['lte-fdd-like', 'lte-tdd-like']);
  const nr = aggregate(candidates, ['nr-fdd-like', 'nr-tdd-like']);
  const cellularOfdm = lte + nr;
  const topKnownIsCellularOfdm = topKnown.id === 'lte-fdd-like'
    || topKnown.id === 'lte-tdd-like'
    || topKnown.id === 'nr-fdd-like'
    || topKnown.id === 'nr-tdd-like';
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
  const wifi = aggregate(candidates, ['wifi-hr-dsss-like', 'wifi-ofdm-like']);
  if (wifi >= BAYESIAN_WAVEFORM_MODEL.minimumAggregatePosterior) return { label: 'wifi-like', probability: wifi, level: 'equivalence-class' };
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

function hypothesisHasRequiredEvidence(
  id: ObservableLeafClass,
  observation: Partial<Pick<ObservableFeatureObservation, 'occupiedStartHz' | 'occupiedStopHz' | 'centerHz' | 'bandwidthHz' | 'limitations' | 'values' | 'associationEvidenceQualification'>>,
): boolean {
  // Eligibility masks encode the pinned model's support, so an overwhelming
  // relative texture likelihood cannot defeat a physical/model-domain
  // impossibility. They are deliberately more conservative than the standards:
  // standards-compliant modes outside this fitted corpus remain unknown.
  if (id === 'wifi-hr-dsss-like') {
    const inFittedBand = fittedObservedIntervalInAnyBand(observation, MODEL_BANDS_MHZ.wifiHrDsss);
    // The fitted 11 Mcps HR-DSSS projection is about 22 MHz wide. Ten MHz is
    // a conservative lower observation boundary, not a universal 802.11 rule.
    const inFittedWidth = observation.bandwidthHz === undefined
      || (observation.bandwidthHz >= 10_000_000 && observation.bandwidthHz <= 30_000_000);
    return inFittedBand && inFittedWidth;
  }
  if (id === 'wifi-ofdm-like') {
    const inFittedBand = fittedObservedIntervalInAnyBand(observation, MODEL_BANDS_MHZ.wifiOfdm);
    const inFittedWidth = observation.bandwidthHz === undefined
      || (observation.bandwidthHz >= 8_000_000 && observation.bandwidthHz <= 110_000_000);
    return inFittedBand && inFittedWidth;
  }
  if (id === 'gsm-like') {
    const inFittedBand = fittedObservedIntervalInAnyBand(observation, MODEL_BANDS_MHZ.gsm);
    const inFittedWidth = observation.bandwidthHz === undefined
      || (observation.bandwidthHz >= 80_000 && observation.bandwidthHz <= 500_000);
    return inFittedBand && inFittedWidth;
  }
  if (id === 'lte-fdd-like' || id === 'lte-tdd-like') {
    // The narrowest detector-conditioned fitted cellular example is nominal
    // 5 MHz LTE. LTE itself also defines 1.4/3 MHz channels; those are simply
    // outside this asset and must not rescue an open-set support score.
    const inFittedBand = fittedObservedIntervalInAnyBand(
      observation,
      id === 'lte-fdd-like' ? MODEL_BANDS_MHZ.lteFdd : MODEL_BANDS_MHZ.lteTdd,
    );
    const inFittedWidth = observation.bandwidthHz === undefined
      || (observation.bandwidthHz >= 3_500_000 && observation.bandwidthHz <= 25_000_000);
    return inFittedBand && inFittedWidth;
  }
  if (id === 'nr-fdd-like' || id === 'nr-tdd-like') {
    const inFittedBand = fittedObservedIntervalInAnyBand(
      observation,
      id === 'nr-fdd-like' ? MODEL_BANDS_MHZ.nrFdd : MODEL_BANDS_MHZ.nrTdd,
    );
    const inFittedWidth = observation.bandwidthHz === undefined
      || (observation.bandwidthHz >= 10_000_000 && observation.bandwidthHz <= 110_000_000);
    return inFittedBand && inFittedWidth;
  }
  if (id === 'am-dsb-full-carrier-like') {
    const carrierFraction = observation.values?.['spectrum.centerFraction'];
    if (carrierFraction === undefined || carrierFraction < 0.5) return false;
    const resolvedSidebands = (observation.values?.['spectrum.sidebandScore'] ?? 0) >= 0.2;
    const envelopeRangeDb = observation.values?.['envelope.rangeDb'];
    const envelopeStandardDeviationDb = observation.values?.['envelope.standardDeviationDb'];
    const amplitudeEnvelopeObserved = envelopeRangeDb !== undefined
      && envelopeStandardDeviationDb !== undefined
      && envelopeRangeDb >= 2
      && envelopeStandardDeviationDb >= 0.5;
    return resolvedSidebands || amplitudeEnvelopeObserved;
  }
  if (id !== 'bluetooth-like') return true;
  // With only scalar swept spectra and a fixed-tune power envelope, a local
  // stationary 2.4 GHz signal is not Bluetooth evidence. The supported leaf
  // is deliberately a band-activity equivalence class and therefore requires
  // the separately provenance-bound multi-frequency association observation.
  if (!observation.limitations?.includes('frequency-agile-band-activity-association')) return false;
  if (observation.associationEvidenceQualification !== 'provenance-bound-current-promotion') return false;
  const associationLogBayesFactor = observation.values?.['association.logBayesFactor'];
  const priorOdds = BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.priorAgileDynamicsProbability
    / (1 - BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.priorAgileDynamicsProbability);
  const promotionOdds = BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.promotionPosteriorProbability
    / (1 - BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.promotionPosteriorProbability);
  return associationLogBayesFactor !== undefined
    && associationLogBayesFactor >= Math.log(promotionOdds / priorOdds)
    && fittedObservedIntervalInAnyBand(observation, [[2_402, 2_480]]);
}

function fittedObservedIntervalInAnyBand(
  observation: Partial<Pick<ObservableFeatureObservation, 'occupiedStartHz' | 'occupiedStopHz' | 'centerHz' | 'bandwidthHz' | 'values'>>,
  rangesMhz: readonly (readonly [number, number])[],
): boolean {
  if (observation.centerHz === undefined) return true;
  if (observation.bandwidthHz === undefined) return inAnyRange(observation.centerHz / 1_000_000, rangesMhz);
  const halfBandwidthHz = observation.bandwidthHz / 2;
  const logBandwidthRbwRatio = observation.values?.['spectrum.logBandwidthRbwRatio'];
  const estimatedRbwHz = logBandwidthRbwRatio === undefined
    ? 0
    : observation.bandwidthHz / 10 ** logBandwidthRbwRatio;
  // The weighted occupied interval can move by roughly an RBW at either edge.
  // Cap that allowance at 5% of measured width so a coarse/invalid resolution
  // estimate cannot turn a center-only context check back into a soft mask.
  const edgeToleranceHz = Math.min(
    observation.bandwidthHz * 0.05,
    Number.isFinite(estimatedRbwHz) ? estimatedRbwHz * 2 : 0,
  );
  const observedStartHz = observation.occupiedStartHz ?? observation.centerHz - halfBandwidthHz;
  const observedStopHz = observation.occupiedStopHz ?? observation.centerHz + halfBandwidthHz;
  return rangesMhz.some(([startMhz, stopMhz]) => observedStartHz >= startMhz * 1_000_000 - edgeToleranceHz
    && observedStopHz <= stopMhz * 1_000_000 + edgeToleranceHz);
}

function inAnyRange(value: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, stop]) => value >= start && value <= stop);
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
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.classificationSweeps !== 8
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.observationOpportunityHorizons?.standard !== 24
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.observationOpportunityHorizons.fullBand2g4 !== 96
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.selectionPolicy !== 'online-first-ready-all-representatives-v3'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.representativeWeightingPolicy !== 'equal-weight-per-first-ready-production-representative-v2'
    || BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.representativeEligibilityPolicy !== 'bluetooth-components-require-qualified-agile-association-v1') {
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
