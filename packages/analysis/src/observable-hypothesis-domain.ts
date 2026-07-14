import type { DetectedSignal } from '@tinysa/contracts';
import { BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL } from './bayesian-agile-association.js';
import type { ObservableFeatureObservation } from './observable-features.js';
import type { ObservableLeafClass } from './observable-classifier-model.js';

const MODEL_BANDS_MHZ = {
  gsm: [[380, 500], [698, 1_000], [1_710, 1_990]],
  wifiHrDsss: [[2_400, 2_500]],
  wifiOfdm: [[2_400, 2_500], [4_900, 5_925], [5_925, 7_125]],
  lteFdd: [[698, 960], [1_427, 1_518], [1_710, 2_200]],
  lteTdd: [[1_850, 1_920], [2_010, 2_025], [2_300, 2_400], [2_496, 2_690], [3_400, 3_800]],
  nrFdd: [[410, 960], [1_427, 1_518], [1_710, 2_200]],
  nrTdd: [[1_850, 1_920], [2_010, 2_025], [2_300, 2_690], [3_300, 5_000]],
} as const;

export type ObservableHypothesisDomainObservation = Partial<Pick<
  ObservableFeatureObservation,
  | 'occupiedStartHz'
  | 'occupiedStopHz'
  | 'centerHz'
  | 'bandwidthHz'
  | 'limitations'
  | 'values'
  | 'associationEvidenceQualification'
>>;

/**
 * Structural support of the pinned observable hypothesis family.
 *
 * This is deliberately independent of the generated likelihood asset so the
 * trainer, validator, and runtime can apply the same physical/model-domain
 * mask. A standards-compliant waveform outside these fitted boundaries is an
 * unknown observation; a large relative likelihood cannot override the mask.
 */
export function observableHypothesisHasRequiredEvidence(
  id: ObservableLeafClass,
  observation: ObservableHypothesisDomainObservation,
): boolean {
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

/**
 * Determines whether one production-pipeline representative may enter a
 * likelihood fit or its tail calibration. Runtime structural support is a
 * necessary condition; the analog and Bluetooth clauses add conservative
 * provenance constraints that prevent fragment/association selection bias.
 */
export function observableRepresentativeIsEligibleForModelFit(
  id: ObservableLeafClass,
  nominalOccupiedBandwidthHz: number,
  detection: Pick<DetectedSignal, 'associationMode' | 'associationBayesianEvidence'>,
  observation: ObservableHypothesisDomainObservation,
): boolean {
  if (!observableHypothesisHasRequiredEvidence(id, observation)) return false;
  if (id === 'bluetooth-like') {
    return detection.associationMode === 'frequency-agile-2g4-activity'
      && detection.associationBayesianEvidence?.qualification
        === 'synthetic-fixed-sweep-time-conditional-on-unambiguous-cfar-looks-not-emitter-identity';
  }
  if (id === 'am-dsb-full-carrier-like' || id === 'fm-angle-modulated-like') {
    // A resolved sideband by itself is an RBW-limited line, not an analog
    // modulation training observation. Require either a separately disclosed
    // regular-component association or one connected region spanning a
    // material fraction of the nominal occupied morphology.
    return detection.associationMode === 'regular-spectral-component-activity'
      || (observation.bandwidthHz !== undefined
        && observation.bandwidthHz >= nominalOccupiedBandwidthHz * 0.3);
  }
  return true;
}

function fittedObservedIntervalInAnyBand(
  observation: ObservableHypothesisDomainObservation,
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
