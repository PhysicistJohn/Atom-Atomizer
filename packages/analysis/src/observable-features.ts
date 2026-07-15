import type {
  DetectedSignal,
  Sweep,
  SweptSpectrumConfiguration,
  WaveformClassificationEvidence,
  ZeroSpanCapture,
} from '@tinysa/contracts';
import { instrumentTimestampSchema } from '@tinysa/contracts';
import { isInstrumentMeasurementIdentity, sameMeasurementIdentity } from './measurement-provenance.js';
import {
  BAYESIAN_DETECTOR_MODEL,
  analyzeBayesianSweep,
  bayesianDetectionEvidenceMatches,
} from './bayesian-signal-detector.js';
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
  frequencyAgileSweepEligible,
  frequencyAgileSweepGeometryCompatible,
} from './frequency-agile-geometry.js';
import {
  MULTICOMPONENT_LOCAL_DETECTOR_MODEL_ID,
  MULTICOMPONENT_SWEPT_REGION_MODEL_ID,
  multicomponentAssociationRegionsOverlap,
  multicomponentSweepBinWidthHz,
  multicomponentSweepGeometryId,
  multicomponentSweptRegionAssociations,
  multicomponentSweptRegionAssociationsForGeometry,
} from './multicomponent-swept-region.js';
import { regularSpectralComponentAssociations } from './regular-spectral-component.js';

export interface WaveformEvidence extends WaveformClassificationEvidence {
  /** Exact newest-first eight-sweep scalar window observed when zero span was acquired. */
  zeroSpanSpectrumSweepIds?: readonly string[];
}

export const BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY = {
  points: 450,
  sweepTimeSeconds: 0.05,
} as const;

export type ObservableEvidenceLimitation =
  | 'sweep-time-frequency-skew'
  | 'synthetic-grid-equivalent-resolution'
  | 'partial-span-boundary-censoring'
  | 'insufficient-spectrum-history'
  | 'zero-span-missing'
  | 'zero-span-tune-mismatch'
  | 'zero-span-provenance-mismatch'
  | 'zero-span-spectrum-window-mismatch'
  | 'zero-span-timing-unqualified'
  | 'zero-span-rbw-unavailable'
  | 'zero-span-geometry-out-of-domain'
  | 'timing-rate-aliased'
  | 'timing-window-too-short'
  | 'frequency-agile-band-activity-association'
  | 'regular-spectral-component-activity-association'
  | 'multicomponent-swept-region-activity-association'
  | 'zero-span-local-member-of-nonidentity-regional-association';

export interface ObservableFeatureObservation {
  values: Readonly<Record<string, number>>;
  limitations: readonly ObservableEvidenceLimitation[];
  occupiedStartHz: number;
  occupiedStopHz: number;
  centerHz: number;
  bandwidthHz: number;
  binWidthHz: number;
  sweepIds: readonly string[];
  zeroSpanCaptureId?: string;
  views: readonly ('scalar-spectrum' | 'detected-power-envelope')[];
  /** Set only after the extractor recomputes the current agile promotion and binds every cited opportunity sweep. */
  associationEvidenceQualification?: 'provenance-bound-current-promotion';
}

interface SweepObservation {
  id: string;
  peakHz: number;
  occupiedStartHz: number;
  occupiedStopHz: number;
  centerHz: number;
  bandwidthHz: number;
  binWidthHz: number;
  rbwHz: number;
  prominenceDb: number;
  integratedPowerDb: number;
  flatness: number;
  entropy: number;
  symmetry: number;
  centerFraction: number;
  sidebandScore: number;
  peakDensity: number;
  centerNotch: number;
  clusterCount: number;
  bleAdvertisingMask: number;
}

export function extractObservableFeatures(detection: DetectedSignal, evidence: WaveformEvidence): ObservableFeatureObservation {
  // The fitted/calibrated model uses an exact eight-admission window. A fixed
  // window avoids treating look-count-dependent maxima, spans and variances as
  // exchangeable across arbitrary 3..64-look histories.
  const sweeps = coherentSweeps(detection, evidence.sweeps).slice(0, 8);
  if (!sweeps.length) throw new Error('Observable classification requires at least one coherent complete scalar sweep');
  const observations = sweeps.map((sweep) => observeSweep(detection, sweep));
  // A DetectedSignal's sweepIds are the detector/track admission record: the
  // runtime tracker appends only sweeps in which that event was independently
  // re-detected. Re-thresholding those selected sweeps here created a second,
  // uncalibrated narrowband gate and preferentially discarded wideband OFDM.
  // Treat every provenance-bound source sweep as observed event evidence.
  const centerHz = median(observations.map((item) => item.centerHz));
  const occupiedStartHz = median(observations.map((item) => item.occupiedStartHz));
  const occupiedStopHz = median(observations.map((item) => item.occupiedStopHz));
  const bandwidthHz = Math.max(median(observations.map((item) => item.bandwidthHz)), median(observations.map((item) => item.binWidthHz)));
  const binWidthHz = median(observations.map((item) => item.binWidthHz));
  const rbwHz = median(observations.map((item) => item.rbwHz));
  const peakSpanHz = range(observations.map((item) => item.peakHz));
  const spanHz = sweeps[0]!.actualStopHz - sweeps[0]!.actualStartHz;
  const peakFrequencies = observations.map((item) => item.peakHz);
  const values: Record<string, number> = {
    'association.logBayesFactor': detection.associationBayesianEvidence?.logBayesFactor ?? 0,
    'spectrum.logBandwidthHz': Math.log10(Math.max(1, bandwidthHz)),
    'spectrum.logBandwidthRbwRatio': Math.log10(Math.max(1, bandwidthHz / Math.max(1, rbwHz))),
    'spectrum.prominenceDb': Math.max(...observations.map((item) => item.prominenceDb)),
    'spectrum.flatness': mean(observations.map((item) => item.flatness)),
    'spectrum.entropy': mean(observations.map((item) => item.entropy)),
    'spectrum.symmetry': mean(observations.map((item) => item.symmetry)),
    'spectrum.centerFraction': mean(observations.map((item) => item.centerFraction)),
    'spectrum.sidebandScore': mean(observations.map((item) => item.sidebandScore)),
    'spectrum.peakDensity': mean(observations.map((item) => item.peakDensity)),
    'spectrum.centerNotch': mean(observations.map((item) => item.centerNotch)),
    'spectrum.logClusterCount': Math.log1p(mean(observations.map((item) => item.clusterCount))),
    'spectrum.peakDriftFraction': standardDeviation(observations.map((item) => item.peakHz)) / Math.max(bandwidthHz, binWidthHz),
    'spectrum.powerVariationDb': standardDeviation(observations.map((item) => item.integratedPowerDb)),
    'history.peakSpanFraction': peakSpanHz / Math.max(1, spanHz),
    'history.raster1MHzScore': rasterScore(peakFrequencies, 1_000_000),
    'history.raster2MHzScore': rasterScore(peakFrequencies, 2_000_000),
    'history.bleAdvertisingScore': advertisingTripletScore(observations.reduce((mask, item) => mask | item.bleAdvertisingMask, 0)),
  };

  const limitations = new Set<ObservableEvidenceLimitation>(['sweep-time-frequency-skew']);
  if (sweeps.some((sweep) => sweep.resolutionBandwidthQualification === 'synthetic-grid-equivalent')) {
    limitations.add('synthetic-grid-equivalent-resolution');
  }
  if (detection.associationMode === 'frequency-agile-2g4-activity') limitations.add('frequency-agile-band-activity-association');
  if (detection.associationMode === 'regular-spectral-component-activity') limitations.add('regular-spectral-component-activity-association');
  if (detection.associationMode === 'multicomponent-swept-region-activity') limitations.add('multicomponent-swept-region-activity-association');
  const associationBoundaryCensored = hasCompleteAssociationRegion(detection)
    && (detection.associationRegionStartHz <= sweeps[0]!.actualStartHz || detection.associationRegionStopHz >= sweeps[0]!.actualStopHz);
  if (associationBoundaryCensored || (!hasCompleteAssociationRegion(detection) && detection.qualityFlags.some((flag) => flag.startsWith('touches-')))) {
    limitations.add('partial-span-boundary-censoring');
  }
  if (sweeps.length < 3) limitations.add('insufficient-spectrum-history');
  const zeroSpanProvenanceMatched = !!evidence.zeroSpan
    && zeroSpanProvenanceMatches(detection, sweeps[0]!, evidence.zeroSpan);
  const zeroSpanSpectrumWindowMatched = zeroSpanWindowMatches(
    sweeps,
    evidence.zeroSpanSpectrumSweepIds,
    sweeps[0]!,
  );
  const provenanceMatchedZeroSpan = zeroSpanSpectrumWindowMatched
    ? matchingZeroSpan(detection, binWidthHz, sweeps[0]!, evidence.zeroSpan)
    : undefined;
  const zeroSpan = provenanceMatchedZeroSpan && supportedZeroSpanGeometry(provenanceMatchedZeroSpan) ? provenanceMatchedZeroSpan : undefined;
  if (evidence.zeroSpan && !provenanceMatchedZeroSpan) {
    limitations.add(!zeroSpanProvenanceMatched
      ? 'zero-span-provenance-mismatch'
      : !zeroSpanSpectrumWindowMatched
        ? 'zero-span-spectrum-window-mismatch'
        : 'zero-span-tune-mismatch');
  }
  if (provenanceMatchedZeroSpan && !zeroSpan) limitations.add('zero-span-geometry-out-of-domain');
  if (!zeroSpan) limitations.add('zero-span-missing');
  if (zeroSpan) {
    if (detection.associationMode === 'multicomponent-swept-region-activity') {
      limitations.add('zero-span-local-member-of-nonidentity-regional-association');
    }
    observeEnvelope(zeroSpan, detection, values, limitations);
  }

  return {
    values,
    limitations: [...limitations],
    occupiedStartHz,
    occupiedStopHz,
    centerHz,
    bandwidthHz,
    binWidthHz,
    sweepIds: observations.map((item) => item.id),
    ...(zeroSpan ? { zeroSpanCaptureId: zeroSpan.id } : {}),
    views: zeroSpan ? ['scalar-spectrum', 'detected-power-envelope'] : ['scalar-spectrum'],
    ...(detection.associationMode === 'frequency-agile-2g4-activity'
      ? { associationEvidenceQualification: 'provenance-bound-current-promotion' as const }
      : {}),
  };
}

/**
 * A non-local association can remain visible under tracker hysteresis after
 * its current evidence falls below the classifier's promotion gate. That is
 * useful operator state, but it is not a currently qualified observation for
 * fitting, calibration, validation, or runtime classification.
 */
export function observableAssociationEvidenceIsCurrentlyQualified(detection: DetectedSignal): boolean {
  if (detection.missedSweeps !== 0) return false;
  return detection.associationMode === undefined
    || detection.associationMode === 'frequency-local'
    || hasCompleteAssociationRegion(detection);
}

function coherentSweeps(detection: DetectedSignal, values: readonly Sweep[]): Sweep[] {
  const localAssociation = detection.associationMode === undefined
    || detection.associationMode === 'frequency-local';
  const associationRegionComplete = hasCompleteAssociationRegion(detection);
  if (detection.associationMode !== undefined && detection.associationMode !== 'frequency-local' && !associationRegionComplete) return [];
  if (new Set(values.map((sweep) => sweep.id)).size !== values.length) {
    throw new Error('Observable classification rejects duplicate evidence sweep IDs');
  }
  for (const sweep of values) validateSweep(sweep);
  if (detection.associationMode === 'frequency-agile-2g4-activity'
    && !validateAgileAssociationSweeps(detection, values)) return [];
  if (detection.associationMode === 'multicomponent-swept-region-activity'
    && !multicomponentAssociationProvenanceIsValid(detection, values)) return [];
  if (detection.associationMode === 'regular-spectral-component-activity'
    && !regularAssociationProvenanceIsValid(detection, values)) return [];
  const sourceSweepIdList = associationRegionComplete ? detection.associationRegionSweepIds : detection.sweepIds;
  if (new Set(sourceSweepIdList).size !== sourceSweepIdList.length) {
    throw new Error('Observable classification rejects duplicate source sweep IDs');
  }
  const requiredLocalSweepIds = localAssociation ? detection.sweepIds.slice(-8) : undefined;
  if (requiredLocalSweepIds?.length === 0) return [];
  const sourceSweepIds = new Set(requiredLocalSweepIds ?? sourceSweepIdList);
  const evidenceSweeps = detection.associationMode === 'regular-spectral-component-activity'
    ? detection.regularComponentAssociationObservations!.map((observation) => observation.sourceSweep)
    : values;
  const candidates = evidenceSweeps.filter((sweep) => {
    validateSweep(sweep);
    return sourceSweepIds.has(sweep.id)
      && detection.peakHz >= sweep.actualStartHz
      && detection.peakHz <= sweep.actualStopHz;
  });
  candidates.sort((left, right) => right.sequence - left.sequence);
  for (let index = 1; index < candidates.length; index++) {
    const newer = candidates[index - 1]!;
    const older = candidates[index]!;
    if (older.sequence >= newer.sequence
      || Date.parse(older.capturedAt) >= Date.parse(newer.capturedAt)) return [];
  }
  if (requiredLocalSweepIds) {
    const expectedNewestFirst = [...requiredLocalSweepIds].reverse();
    if (candidates.length !== expectedNewestFirst.length
      || candidates.some((sweep, index) => sweep.id !== expectedNewestFirst[index])) return [];
  }
  const reference = candidates[0];
  if (!reference) return [];
  const coherentCandidates = candidates.filter((sweep) => sweep.frequencyHz.length === reference.frequencyHz.length
    && sameFrequencyGrid(sweep.frequencyHz, reference.frequencyHz)
    && sweep.actualRbwHz === reference.actualRbwHz
    && sweep.actualAttenuationDb === reference.actualAttenuationDb
    && sweep.resolutionBandwidthQualification === reference.resolutionBandwidthQualification
    && sweep.attenuationQualification === reference.attenuationQualification
    && sameSweptSpectrumConfiguration(sweep.requested, reference.requested)
    && sameMeasurementIdentity(sweep.identity, reference.identity));
  if (localAssociation) {
    if (reference.capturedAt !== detection.lastSeenAt) return [];
    const originatingSweepId = detection.classificationRegionObservation?.sourceSweep.id;
    const originatingEvidenceSweep = originatingSweepId === undefined
      ? undefined
      : values.find((sweep) => sweep.id === originatingSweepId);
    if (!localClassificationRegionProvenanceIsValid(
      detection,
      reference,
      originatingEvidenceSweep,
    ) || !localHistorySweepsReplayUniquely(detection, coherentCandidates.slice(0, 8))) return [];
  }
  return coherentCandidates;
}

function sameSweptSpectrumConfiguration(
  left: SweptSpectrumConfiguration,
  right: SweptSpectrumConfiguration,
): boolean {
  if (left.kind !== right.kind
    || left.startHz !== right.startHz
    || left.stopHz !== right.stopHz
    || left.points !== right.points
    || left.sweepTimeSeconds !== right.sweepTimeSeconds
    || left.controls.model !== right.controls.model) return false;
  if (left.controls.model === 'synthetic-scalar') {
    return right.controls.model === 'synthetic-scalar'
      && left.controls.schemaVersion === right.controls.schemaVersion
      && left.controls.timingQualification === right.controls.timingQualification;
  }
  if (right.controls.model !== 'receiver') return false;
  return left.controls.schemaVersion === right.controls.schemaVersion
    && left.controls.acquisitionFormat === right.controls.acquisitionFormat
    && left.controls.resolutionBandwidthKhz === right.controls.resolutionBandwidthKhz
    && left.controls.attenuationDb === right.controls.attenuationDb
    && left.controls.detector === right.controls.detector
    && left.controls.spurRejection === right.controls.spurRejection
    && left.controls.lowNoiseAmplifier === right.controls.lowNoiseAmplifier
    && left.controls.avoidSpurs === right.controls.avoidSpurs
    && sameScalarTrigger(left.controls.trigger, right.controls.trigger);
}

function sameScalarTrigger(
  left: Extract<SweptSpectrumConfiguration['controls'], { model: 'receiver' }>['trigger'],
  right: Extract<SweptSpectrumConfiguration['controls'], { model: 'receiver' }>['trigger'],
): boolean {
  return left.mode === right.mode
    && (left.mode === 'auto' || (right.mode !== 'auto' && left.levelDbm === right.levelDbm));
}

function validateAgileAssociationSweeps(detection: DetectedSignal, values: readonly Sweep[]): boolean {
  const observations = detection.associationObservations;
  const opportunities = detection.associationOpportunities;
  if (!observations || !opportunities || !detection.associationGeometryId) return false;
  const sweepById = new Map(values.map((sweep) => [sweep.id, sweep] as const));
  const opportunitySweeps: Sweep[] = [];
  for (const opportunity of opportunities) {
    const sweep = sweepById.get(opportunity.sweepId);
    if (!sweep) return false;
    validateSweep(sweep);
    opportunitySweeps.push(sweep);
  }
  const reference = opportunitySweeps[0];
  if (!reference
    || !frequencyAgileSweepEligible(reference)
    || frequencyAgileGeometryId(reference) !== detection.associationGeometryId) return false;
  for (let index = 0; index < opportunitySweeps.length; index++) {
    const sweep = opportunitySweeps[index]!;
    if (!frequencyAgileSweepGeometryCompatible(reference, sweep)) return false;
    if (index > 0 && !frequencyAgileSequentialOpportunity(opportunitySweeps[index - 1]!, sweep)) return false;
  }
  const observationBySweepId = new Map(observations.map((observation) => [observation.sweepId, observation] as const));
  try {
    for (let index = 0; index < opportunities.length; index++) {
      const opportunity = opportunities[index]!;
      const sweep = opportunitySweeps[index]!;
      const detectorCandidates = analyzeBayesianSweep(sweep, detection.detectorConfig);
      const bandCandidates = detectorCandidates.filter((candidate) =>
        candidate.stopHz >= FREQUENCY_AGILE_BAND_START_HZ
        && candidate.startHz <= FREQUENCY_AGILE_BAND_STOP_HZ);
      const eligible = bandCandidates.filter((candidate) =>
        candidate.associationMode === 'frequency-local'
        && candidate.sweepIds.length === 1
        && candidate.sweepIds[0] === sweep.id
        && candidate.bandwidthHz <= FREQUENCY_AGILE_MAXIMUM_COMPONENT_BANDWIDTH_HZ);
      const expectedOutcome = bandCandidates.length === 0
        ? 'none'
        : bandCandidates.length === 1 && eligible.length === 1
          ? 'exactly-one'
          : 'ambiguous';
      if (opportunity.outcome !== expectedOutcome) return false;
      const observation = observationBySweepId.get(sweep.id);
      if (expectedOutcome !== 'exactly-one') {
        if (observation) return false;
        continue;
      }
      if (!observation || !agileObservationMatchesCandidate(observation, eligible[0]!, sweep, detection)) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return observations.length === opportunities.filter(
    (opportunity) => opportunity.outcome === 'exactly-one',
  ).length;
}

function agileObservationMatchesCandidate(
  observation: NonNullable<DetectedSignal['associationObservations']>[number],
  candidate: DetectedSignal,
  sweep: Sweep,
  detection: DetectedSignal,
): boolean {
  const binWidthHz = nominalBinWidth(sweep);
  const centerHz = Math.max(
    FREQUENCY_AGILE_BAND_START_HZ,
    Math.min(FREQUENCY_AGILE_BAND_STOP_HZ, (candidate.startHz + candidate.stopHz) / 2),
  );
  const startHz = Math.min(centerHz, Math.max(sweep.actualStartHz, candidate.startHz - binWidthHz / 2));
  const stopHz = Math.max(centerHz, Math.min(sweep.actualStopHz, candidate.stopHz + binWidthHz / 2));
  return !!observation.trackId
    && observation.sweepId === sweep.id
    && observation.detectorId === detection.detectorId
    && observation.detectorId === candidate.detectorId
    && observation.centerHz === centerHz
    && observation.startHz === startHz
    && observation.stopHz === stopHz
    && observation.rbwHz === sweep.actualRbwHz
    && observation.binWidthHz === binWidthHz
    && bayesianDetectionEvidenceMatches(observation.localBayesianEvidence, candidate.bayesianEvidence);
}

function observeSweep(detection: DetectedSignal, sweep: Sweep): SweepObservation {
  const binWidthHz = nominalBinWidth(sweep);
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  const useAssociationRegion = hasCompleteAssociationRegion(detection);
  const selectedStartHz = useAssociationRegion ? detection.associationRegionStartHz : detection.classificationRegionStartHz;
  const selectedStopHz = useAssociationRegion ? detection.associationRegionStopHz : detection.classificationRegionStopHz;
  const hasSelectedRegion = selectedStartHz !== undefined && selectedStopHz !== undefined && selectedStopHz >= selectedStartHz;
  const selectedRegionPaddingHz = Math.max(sweep.actualRbwHz * 2, binWidthHz * 2);
  const halfWidthHz = Math.min(spanHz / 2, Math.max(detection.bandwidthHz * 0.85, sweep.actualRbwHz * 4, binWidthHz * 5));
  const selected = sweep.frequencyHz.map((frequency, index) => ({ frequency, index }))
    .filter(({ frequency }) => hasSelectedRegion
      ? frequency >= selectedStartHz - selectedRegionPaddingHz && frequency <= selectedStopHz + selectedRegionPaddingHz
      : Math.abs(frequency - detection.peakHz) <= halfWidthHz);
  if (selected.length < 3) throw new Error('Observable classification requires at least three bins around a detection');
  const selectedIndices = selected.map((item) => item.index);
  const firstSelected = selectedIndices[0]!;
  const lastSelected = selectedIndices.at(-1)!;
  const rbwBins = Math.max(1, sweep.actualRbwHz / Math.max(Number.MIN_VALUE, binWidthHz));
  const guardBins = Math.max(1, Math.ceil(rbwBins));
  const referenceBinsPerSide = Math.max(6, Math.ceil(12 * rbwBins));
  const localReferencePower = [
    ...sweep.powerDbm.slice(Math.max(0, firstSelected - guardBins - referenceBinsPerSide), Math.max(0, firstSelected - guardBins)),
    ...sweep.powerDbm.slice(Math.min(sweep.powerDbm.length, lastSelected + 1 + guardBins), Math.min(sweep.powerDbm.length, lastSelected + 1 + guardBins + referenceBinsPerSide)),
  ];
  const selectedSet = new Set(selectedIndices);
  const referencePower = localReferencePower.length >= 6
    ? localReferencePower
    : sweep.powerDbm.filter((_value, index) => !selectedSet.has(index));
  const floorDbm = robustFloor(referencePower.length >= 6 ? referencePower : sweep.powerDbm);
  const referenceMeanMilliwatts = mean((referencePower.length >= 6 ? referencePower : sweep.powerDbm).map(dbmToMilliwatts));
  const powerDbm = selectedIndices.map((index) => sweep.powerDbm[index]!);
  const prominenceDb = Math.max(...powerDbm) - floorDbm;
  // Shape features require subtracting expected linear power. The median in
  // dB remains useful for robust prominence, but it is not a linear noise
  // mean and must not be used as one. Reference contamination can only raise
  // this untrimmed local mean and conservatively suppress apparent excess.
  const excess = powerDbm.map((power) => Math.max(1e-12, (dbmToMilliwatts(power) - referenceMeanMilliwatts) / Math.max(Number.MIN_VALUE, referenceMeanMilliwatts)));
  const total = sum(excess);
  const normalized = excess.map((value) => value / total);
  const frequencyHz = selected.map((item) => item.frequency);
  const centerHz = sum(normalized.map((weight, index) => weight * frequencyHz[index]!));
  const lowerHz = weightedQuantile(frequencyHz, normalized, 0.005);
  const upperHz = weightedQuantile(frequencyHz, normalized, 0.995);
  // A multicomponent association is itself the independently qualified
  // regional observation. Reapplying an energy quantile can silently discard
  // a weaker but Bayesian-admitted edge member and turn the public current
  // hull into a narrower, unsupported story. Keep energy quantiles for the
  // within-region shape statistics below, but publish and model the exact
  // latest validated regional extent. This still claims neither continuous
  // occupancy, simultaneity, a common process, nor emitter identity.
  const useCurrentMulticomponentRegion = detection.associationMode === 'multicomponent-swept-region-activity'
    && hasSelectedRegion;
  const occupiedStartHz = useCurrentMulticomponentRegion ? selectedStartHz! : lowerHz;
  const occupiedStopHz = useCurrentMulticomponentRegion ? selectedStopHz! : upperHz;
  const bandwidthHz = Math.max(binWidthHz, occupiedStopHz - occupiedStartHz);
  const activeStart = frequencyHz.findIndex((frequency) => frequency >= lowerHz);
  const activeStop = findLastIndex(frequencyHz, (frequency) => frequency <= upperHz);
  const inBandPower = powerDbm.slice(Math.max(0, activeStart), Math.max(activeStart + 1, activeStop + 1));
  const inBandExcess = excess.slice(Math.max(0, activeStart), Math.max(activeStart + 1, activeStop + 1));
  const arithmetic = mean(inBandExcess);
  const geometric = Math.exp(mean(inBandExcess.map((value) => Math.log(Math.max(1e-12, value)))));
  const entropy = -sum(normalized.map((weight) => weight * Math.log(Math.max(Number.MIN_VALUE, weight)))) / Math.log(normalized.length);
  const centerRadiusHz = Math.max(sweep.actualRbwHz * 1.5, binWidthHz * 2.5);
  const centerFraction = sum(normalized.filter((_weight, index) => Math.abs(frequencyHz[index]! - centerHz) <= centerRadiusHz));
  const peaks = localPeaks(powerDbm, floorDbm + 4);
  const peakIndex = maximumIndex(powerDbm);
  const centerIndex = nearestIndex(frequencyHz, centerHz);
  const shoulderPower = inBandPower.filter((_value, index) => Math.abs(index + Math.max(0, activeStart) - centerIndex) >= 2);
  const centerNotch = shoulderPower.length ? clamp((mean(shoulderPower) - localMean(powerDbm, centerIndex, 1)) / 15, -1, 1) : 0;
  const activePeakFrequencies = peaks.map((index) => frequencyHz[index]!);
  return {
    id: sweep.id,
    peakHz: frequencyHz[peakIndex]!,
    occupiedStartHz,
    occupiedStopHz,
    centerHz,
    bandwidthHz,
    binWidthHz,
    rbwHz: sweep.actualRbwHz,
    prominenceDb,
    integratedPowerDb: 10 * Math.log10(total),
    flatness: clamp(geometric / Math.max(Number.MIN_VALUE, arithmetic), 0, 1),
    entropy: clamp(entropy, 0, 1),
    symmetry: symmetryAroundCenter(frequencyHz, normalized, centerHz),
    centerFraction: clamp(centerFraction, 0, 1),
    sidebandScore: mirroredSidebandScore(peaks, frequencyHz, powerDbm, centerHz, binWidthHz),
    peakDensity: peaks.length / Math.max(1, powerDbm.length),
    centerNotch,
    clusterCount: occupiedClusterCount(inBandPower, floorDbm + 4),
    bleAdvertisingMask: bluetoothAdvertisingMask(activePeakFrequencies),
  };
}

function localClassificationRegionProvenanceIsValid(
  detection: DetectedSignal,
  referenceSweep?: Sweep,
  originatingEvidenceSweep?: Sweep,
): boolean {
  const observation = detection.classificationRegionObservation;
  const sourceSweepIds = detection.classificationRegionSweepIds;
  if (!observation
    || !sourceSweepIds
    || sourceSweepIds.length !== 1
    || sourceSweepIds[0] !== observation.sourceSweep.id
    || observation.sourceSweep.capturedAt !== detection.firstSeenAt
    || detection.classificationRegionStartHz === undefined
    || detection.classificationRegionStopHz === undefined
    || observation.detectorId !== detection.detectorId
    || observation.detectorId !== BAYESIAN_DETECTOR_MODEL.id) return false;
  try {
    validateSweep(observation.sourceSweep);
    const candidates = analyzeBayesianSweep(observation.sourceSweep, detection.detectorConfig);
    const matched = candidates.filter((candidate) =>
      candidate.startHz === observation.startHz
      && candidate.stopHz === observation.stopHz
      && candidate.peakHz === observation.peakHz
      && candidate.detectorId === observation.detectorId
      && bayesianDetectionEvidenceMatches(
        candidate.bayesianEvidence,
        observation.localBayesianEvidence,
      ));
    if (matched.length !== 1) return false;
    const candidate = matched[0]!;
    if (detection.classificationRegionStartHz
        !== Math.min(candidate.startHz, candidate.bayesianEvidence.testedRegionStartHz)
      || detection.classificationRegionStopHz
        !== Math.max(candidate.stopHz, candidate.bayesianEvidence.testedRegionStopHz)) return false;
    return (referenceSweep === undefined || observation.sourceSweep.sequence <= referenceSweep.sequence)
      && (originatingEvidenceSweep === undefined
        || detectorSweepInputsMatch(observation.sourceSweep, originatingEvidenceSweep))
      && (referenceSweep === undefined
        || sweepAcquisitionGeometryMatches(observation.sourceSweep, referenceSweep));
  } catch {
    return false;
  }
}

/**
 * A track's sweepIds are claims that the local detector independently admitted
 * that event on every cited look. Only the first admission has a compact frozen
 * observation, so replay every later scalar look before using it as classifier
 * evidence. The immutable classification ROI is the scope of the scalar
 * features; a detector result outside it cannot support those features even if
 * a live tracker could have followed gradual motion through omitted looks.
 */
function localHistorySweepsReplayUniquely(
  detection: DetectedSignal,
  sweeps: readonly Sweep[],
): boolean {
  const frozenStartHz = detection.classificationRegionStartHz;
  const frozenStopHz = detection.classificationRegionStopHz;
  const origin = detection.classificationRegionObservation;
  if (frozenStartHz === undefined
    || frozenStopHz === undefined
    || frozenStopHz < frozenStartHz
    || !origin) return false;
  try {
    return sweeps.every((sweep, index) => {
      const compatible = analyzeBayesianSweep(sweep, detection.detectorConfig).filter((candidate) =>
        candidate.detectorId === detection.detectorId
        && candidate.associationMode === 'frequency-local'
        && candidate.sweepIds.length === 1
        && candidate.sweepIds[0] === sweep.id
        && candidate.classificationRegionStartHz !== undefined
        && candidate.classificationRegionStopHz !== undefined
        && candidate.classificationRegionStartHz <= frozenStopHz
        && candidate.classificationRegionStopHz >= frozenStartHz
        && candidate.startHz <= frozenStopHz
        && candidate.stopHz >= frozenStartHz
        && candidate.peakHz >= frozenStartHz
        && candidate.peakHz <= frozenStopHz
        && localDetectorCandidateIsTrackCompatible(origin, candidate, sweep));
      return compatible.length === 1
        && (index !== 0 || latestLocalCandidateMatchesCurrentTrack(detection, compatible[0]!));
    });
  } catch {
    return false;
  }
}

function latestLocalCandidateMatchesCurrentTrack(
  track: DetectedSignal,
  candidate: DetectedSignal,
): boolean {
  return track.startHz === candidate.startHz
    && track.stopHz === candidate.stopHz
    && track.peakHz === candidate.peakHz
    && track.peakDbm === candidate.peakDbm
    && track.bandwidthHz === candidate.bandwidthHz
    && track.thresholdDbm === candidate.thresholdDbm
    && track.noiseFloorDbm === candidate.noiseFloorDbm
    && track.detectorId === candidate.detectorId
    && track.prominenceDb === candidate.prominenceDb
    && track.bayesianEvidence.priorSignalProbability === candidate.bayesianEvidence.priorSignalProbability
    && track.bayesianEvidence.effectiveIndependentBins === candidate.bayesianEvidence.effectiveIndependentBins
    && track.bayesianEvidence.posteriorPredictiveNullProbability === candidate.bayesianEvidence.posteriorPredictiveNullProbability
    && track.bayesianEvidence.targetPosteriorPredictiveNullProbability === candidate.bayesianEvidence.targetPosteriorPredictiveNullProbability
    && track.bayesianEvidence.targetSweepFalseAlarmProbability === candidate.bayesianEvidence.targetSweepFalseAlarmProbability
    && track.bayesianEvidence.multiplicityAdjustedTests === candidate.bayesianEvidence.multiplicityAdjustedTests
    && track.bayesianEvidence.testedRegionStartHz === candidate.bayesianEvidence.testedRegionStartHz
    && track.bayesianEvidence.testedRegionStopHz === candidate.bayesianEvidence.testedRegionStopHz
    && track.bayesianEvidence.qualification === candidate.bayesianEvidence.qualification;
}

function localDetectorCandidateIsTrackCompatible(
  origin: NonNullable<DetectedSignal['classificationRegionObservation']>,
  candidate: DetectedSignal,
  sweep: Sweep,
): boolean {
  const overlapHz = Math.max(0, Math.min(origin.stopHz, candidate.stopHz)
    - Math.max(origin.startHz, candidate.startHz));
  // Mirror the live tracker's local-match eligibility scale exactly while
  // anchoring it to the immutable first admission.
  const binWidthHz = Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!);
  const centerDistanceHz = Math.abs(origin.peakHz - candidate.peakHz);
  const toleranceHz = Math.max(
    binWidthHz * 3,
    origin.stopHz - origin.startHz,
    candidate.bandwidthHz,
    1,
  );
  return overlapHz > 0 || centerDistanceHz <= toleranceHz;
}

function regularAssociationProvenanceIsValid(
  detection: DetectedSignal,
  externalSweeps?: readonly Sweep[],
): boolean {
  const observations = detection.regularComponentAssociationObservations;
  const sweepIds = detection.associationRegionSweepIds;
  const currentMembers = detection.associationMemberTrackIds;
  if (!observations?.length
    || observations.length > 64
    || !sweepIds
    || sweepIds.length !== observations.length
    || !currentMembers
    || currentMembers.length < 3
    || !currentMembers.includes(detection.id)
    || new Set(sweepIds).size !== sweepIds.length
    || observations.some((observation, index) => observation.sourceSweep.id !== sweepIds[index])) return false;
  const first = observations[0]!;
  const latest = observations.at(-1)!;
  if (detection.associationRegionStartHz !== first.observedRegionStartHz
    || detection.associationRegionStopHz !== first.observedRegionStopHz
    || !detection.sweepIds.includes(latest.sourceSweep.id)
    || latest.sourceSweep.capturedAt !== detection.lastSeenAt) return false;
  const externalById = externalSweeps === undefined
    ? undefined
    : new Map(externalSweeps.map((sweep) => [sweep.id, sweep] as const));
  if (externalById && externalById.size !== externalSweeps!.length) return false;
  let previousSequence = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const sourceSweep = observation.sourceSweep;
    try {
      validateSweep(sourceSweep);
    } catch {
      return false;
    }
    if (sourceSweep.sequence <= previousSequence
      || !sweepAcquisitionGeometryMatches(first.sourceSweep, sourceSweep)) return false;
    previousSequence = sourceSweep.sequence;
    const external = externalById?.get(sourceSweep.id);
    if (external && !detectorSweepInputsMatch(sourceSweep, external)) return false;
    const memberIds = observation.members.map((member) => member.trackId);
    if (memberIds.length !== currentMembers.length
      || new Set(memberIds).size !== memberIds.length
      || memberIds.some((memberId, index) => memberId !== currentMembers[index])) return false;
    let candidates: readonly DetectedSignal[];
    try {
      candidates = analyzeBayesianSweep(sourceSweep, detection.detectorConfig);
    } catch {
      return false;
    }
    const matchedCandidateIndices = observation.members.map((member) => {
      const matches = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) =>
        member.detectorId === detection.detectorId
        && member.detectorId === candidate.detectorId
        && member.startHz === candidate.startHz
        && member.stopHz === candidate.stopHz
        && member.peakHz === candidate.peakHz
        && bayesianDetectionEvidenceMatches(member.localBayesianEvidence, candidate.bayesianEvidence));
      return matches.length === 1 ? matches[0]!.index : undefined;
    });
    if (matchedCandidateIndices.some((index) => index === undefined)
      || new Set(matchedCandidateIndices).size !== matchedCandidateIndices.length) return false;
    const expectedIndices = matchedCandidateIndices
      .filter((index): index is number => index !== undefined)
      .sort((left, right) => left - right);
    const associations = regularSpectralComponentAssociations(candidates, sourceSweep).filter((association) =>
      association.startHz === observation.observedRegionStartHz
      && association.stopHz === observation.observedRegionStopHz
      && association.candidateIndices.length === expectedIndices.length
      && association.candidateIndices.every((candidateIndex, index) => candidateIndex === expectedIndices[index]));
    if (associations.length !== 1) return false;
  }
  return true;
}

function sweepAcquisitionGeometryMatches(left: Sweep, right: Sweep): boolean {
  return left.frequencyHz.length === right.frequencyHz.length
    && sameFrequencyGrid(left.frequencyHz, right.frequencyHz)
    && left.actualStartHz === right.actualStartHz
    && left.actualStopHz === right.actualStopHz
    && left.actualRbwHz === right.actualRbwHz
    && left.actualAttenuationDb === right.actualAttenuationDb
    && left.resolutionBandwidthQualification === right.resolutionBandwidthQualification
    && left.attenuationQualification === right.attenuationQualification
    && left.source === right.source
    && sameSweptSpectrumConfiguration(left.requested, right.requested)
    && sameMeasurementIdentity(left.identity, right.identity);
}

function detectorSweepInputsMatch(left: Sweep, right: Sweep): boolean {
  return left.id === right.id
    && left.sequence === right.sequence
    && left.complete === right.complete
    && left.capturedAt === right.capturedAt
    && sweepAcquisitionGeometryMatches(left, right)
    && left.powerDbm.length === right.powerDbm.length
    && left.powerDbm.every((powerDbm, index) => powerDbm === right.powerDbm[index]);
}

function hasCompleteAssociationRegion(detection: DetectedSignal): detection is DetectedSignal & {
  associationRegionStartHz: number;
  associationRegionStopHz: number;
  associationRegionSweepIds: readonly string[];
} {
  const common = detection.associationMode !== undefined
    && detection.associationMode !== 'frequency-local'
    && detection.associationRegionStartHz !== undefined
    && detection.associationRegionStopHz !== undefined
    && Number.isFinite(detection.associationRegionStartHz)
    && Number.isFinite(detection.associationRegionStopHz)
    && detection.associationRegionStopHz > detection.associationRegionStartHz
    && detection.associationRegionSweepIds !== undefined
    && detection.associationRegionSweepIds.length > 0
    && new Set(detection.associationRegionSweepIds).size === detection.associationRegionSweepIds.length
    && detection.associationId !== undefined
    && detection.associationId.length > 0
    && Number.isInteger(detection.associationMissedSweeps)
    && detection.associationMissedSweeps! >= 0;
  if (!common) return false;
  const associationRegionStartHz = detection.associationRegionStartHz!;
  const associationRegionStopHz = detection.associationRegionStopHz!;
  const associationRegionSweepIds = detection.associationRegionSweepIds!;
  if (detection.associationMode === 'frequency-agile-2g4-activity') {
    const observations = detection.associationObservations;
    const opportunities = detection.associationOpportunities;
    const evidence = detection.associationBayesianEvidence;
    const members = detection.associationMemberTrackIds;
    if (detection.id !== detection.associationId
      || !/^agile-2g4-activity-\d{4,}$/.test(detection.associationId)
      || detection.associationModelId !== 'frequency-agile-2g4-activity-v3'
      || associationRegionStartHz !== 2_402_000_000
      || associationRegionStopHz !== 2_480_000_000
      || !detection.associationGeometryId
      || !observations || observations.length < BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.minimumPositiveObservations
      || !opportunities
      || opportunities.length < observations.length
      || opportunities.length > BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.maximumOpportunityWindow
      || !evidence
      || !members || members.length < 2
      || detection.regularComponentAssociationObservations !== undefined
      || detection.multicomponentAssociationObservations !== undefined) return false;
    if (observations.length !== associationRegionSweepIds.length
      || observations.some((observation, index) => observation.sweepId !== associationRegionSweepIds[index]
        || !observation.sweepId
        || !observation.trackId
        || !Number.isFinite(observation.centerHz)
        || !Number.isFinite(observation.startHz)
        || !Number.isFinite(observation.stopHz)
        || !Number.isFinite(observation.rbwHz)
        || !Number.isFinite(observation.binWidthHz)
        || observation.stopHz <= observation.startHz
        || observation.centerHz < observation.startHz
        || observation.centerHz > observation.stopHz
        || observation.rbwHz <= 0
        || observation.binWidthHz <= 0
        || observation.centerHz < associationRegionStartHz
        || observation.centerHz > associationRegionStopHz)
      || new Set(observations.map((observation) => observation.sweepId)).size !== observations.length) return false;
    if (new Set(opportunities.map((opportunity) => opportunity.sweepId)).size !== opportunities.length
      || opportunities.some((opportunity) => !opportunity.sweepId
        || !['none', 'exactly-one', 'ambiguous'].includes(opportunity.outcome))) return false;
    const exactlyOneSweepIds = opportunities
      .filter((opportunity) => opportunity.outcome === 'exactly-one')
      .map((opportunity) => opportunity.sweepId);
    if (exactlyOneSweepIds.length !== associationRegionSweepIds.length
      || exactlyOneSweepIds.some((sweepId, index) => sweepId !== associationRegionSweepIds[index])) return false;
    const latestPositiveOpportunityIndex = opportunities.map((opportunity) => opportunity.outcome).lastIndexOf('exactly-one');
    if (latestPositiveOpportunityIndex < 0
      || detection.associationMissedSweeps !== opportunities.length - latestPositiveOpportunityIndex - 1) return false;
    const observedMembers = [...new Set(observations.map((observation) => observation.trackId))];
    if (members.length !== observedMembers.length || members.some((member, index) => member !== observedMembers[index])) return false;
    try {
      const recomputed = bayesianFrequencyAgileActivityEvidence(observations, opportunities.length);
      return activityEvidenceMatches(evidence, recomputed)
        // Hysteresis keeps a recent association visible to an operator, but a
        // classifier input must independently satisfy the full promotion gate
        // in its current provenance window. A retained 0.90 score alone is not
        // evidence that 0.99 was ever reached.
        && bayesianFrequencyAgileActivityQualifies(recomputed, false);
    } catch {
      return false;
    }
  }
  const members = detection.associationMemberTrackIds;
  if (detection.associationObservations !== undefined
    || detection.associationOpportunities !== undefined
    || detection.associationBayesianEvidence !== undefined
    || detection.associationGeometryId !== undefined
    || detection.associationMissedSweeps !== 0
  ) return false;
  if (!members || new Set(members).size !== members.length || !members.includes(detection.id)) return false;
  const sortedMembers = [...members].sort();
  if (!members.every((member, index) => member === sortedMembers[index])) return false;
  if (detection.associationMode === 'regular-spectral-component-activity') {
    return members.length >= 3
      && detection.multicomponentAssociationObservations === undefined
      && detection.associationModelId === 'simultaneous-regular-components-v1'
      && detection.associationId === `regular-lines:${members.join(',')}`
      && regularAssociationProvenanceIsValid(detection);
  }
  return detection.associationMode === 'multicomponent-swept-region-activity'
    && detection.regularComponentAssociationObservations === undefined
    && detection.associationModelId === MULTICOMPONENT_SWEPT_REGION_MODEL_ID
    && /^multicomponent-swept-region-\d{4,}$/.test(detection.associationId!)
    && multicomponentAssociationProvenanceIsValid(detection);
}

type MulticomponentAssociationObservation = NonNullable<
  DetectedSignal['multicomponentAssociationObservations']
>[number];
type MulticomponentMemberObservation = MulticomponentAssociationObservation['members'][number];

function multicomponentAssociationProvenanceIsValid(
  detection: DetectedSignal,
  sweeps?: readonly Sweep[],
): boolean {
  const observations = detection.multicomponentAssociationObservations;
  const sweepIds = detection.associationRegionSweepIds;
  const currentMembers = detection.associationMemberTrackIds;
  const currentStartHz = detection.associationRegionStartHz;
  const currentStopHz = detection.associationRegionStopHz;
  if (!observations?.length || observations.length > 64
    || !sweepIds || sweepIds.length !== observations.length
    || !currentMembers || currentMembers.length < 4
    || currentStartHz === undefined || currentStopHz === undefined
    || observations.some((observation, index) => observation.sweepId !== sweepIds[index])
    || new Set(sweepIds).size !== sweepIds.length) return false;
  const latest = observations.at(-1)!;
  if (currentStartHz !== latest.observedRegionStartHz
    || currentStopHz !== latest.observedRegionStopHz
    || !detection.sweepIds.includes(latest.sweepId)) return false;
  const sweepById = sweeps === undefined ? undefined : new Map(sweeps.map((sweep) => [sweep.id, sweep]));
  if (sweepById && sweepById.size !== sweeps!.length) return false;
  let previousSequence = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    if (!multicomponentObservationIsValid(observation, detection)) return false;
    if (observation.sweepSequence <= previousSequence) return false;
    previousSequence = observation.sweepSequence;
    if (observation.geometryId !== latest.geometryId
      || observation.sweepStartHz !== latest.sweepStartHz
      || observation.sweepStopHz !== latest.sweepStopHz
      || observation.rbwHz !== latest.rbwHz
      || observation.binWidthHz !== latest.binWidthHz
      || !multicomponentAssociationRegionsOverlap(
        observation.observedRegionStartHz,
        observation.observedRegionStopHz,
        latest.observedRegionStartHz,
        latest.observedRegionStopHz,
        latest.rbwHz,
        latest.binWidthHz,
      )) return false;
    if (sweepById) {
      const sweep = sweepById.get(observation.sweepId);
      if (!sweep || !multicomponentObservationMatchesSweep(observation, sweep, detection)) return false;
    }
  }
  if (sweepById) {
    const latestSweep = sweepById.get(latest.sweepId);
    if (!latestSweep
      || latestSweep.capturedAt !== detection.lastSeenAt
      || latest.sweepSequence > Math.max(...[...sweepById.values()].map((sweep) => sweep.sequence))) return false;
  }
  const latestMemberIds = latest.members.map((member) => member.trackId);
  return currentMembers.length === latestMemberIds.length
    && currentMembers.every((member, index) => member === latestMemberIds[index]);
}

function multicomponentObservationIsValid(
  observation: MulticomponentAssociationObservation,
  detection: DetectedSignal,
): boolean {
  if (!observation.sweepId || !Number.isInteger(observation.sweepSequence) || observation.sweepSequence < 0
    || !observation.geometryId
    || !finitePositive(observation.rbwHz)
    || !finitePositive(observation.binWidthHz)
    || !finitePositive(observation.containmentToleranceHz)
    || !Number.isFinite(observation.sweepStartHz)
    || !Number.isFinite(observation.sweepStopHz)
    || observation.sweepStopHz <= observation.sweepStartHz
    || !Number.isFinite(observation.observedRegionStartHz)
    || !Number.isFinite(observation.observedRegionStopHz)
    || observation.observedRegionStopHz <= observation.observedRegionStartHz
    || observation.observedRegionStartHz < observation.sweepStartHz
    || observation.observedRegionStopHz > observation.sweepStopHz
    || observation.members.length < 4) return false;
  const expectedContainmentToleranceHz = Math.max(observation.binWidthHz * 1.1, observation.rbwHz * 1.1);
  if (observation.containmentToleranceHz !== expectedContainmentToleranceHz) return false;
  const memberIds = observation.members.map((member) => member.trackId);
  const sortedMemberIds = [...memberIds].sort();
  if (new Set(memberIds).size !== memberIds.length
    || memberIds.some((memberId, index) => !memberId || memberId !== sortedMemberIds[index])) return false;
  if (observation.members.some((member) => !multicomponentMemberIsValid(member, observation, detection))) return false;
  const observedStartHz = Math.min(...observation.members.map((member) => member.startHz));
  const observedStopHz = Math.max(...observation.members.map((member) => member.stopHz));
  if (observation.observedRegionStartHz !== observedStartHz || observation.observedRegionStopHz !== observedStopHz) return false;
  const recomputed = multicomponentSweptRegionAssociationsForGeometry(
    observation.members.map((member) => ({
      startHz: member.startHz,
      stopHz: member.stopHz,
      peakHz: member.peakHz,
      bandwidthHz: member.stopHz - member.startHz,
      detectorId: member.detectorId,
      bayesianEvidence: member.localBayesianEvidence,
      classificationRegionStartHz: Math.min(
        member.startHz,
        member.localBayesianEvidence.testedRegionStartHz,
      ),
      classificationRegionStopHz: Math.max(
        member.stopHz,
        member.localBayesianEvidence.testedRegionStopHz,
      ),
    })),
    {
      actualStartHz: observation.sweepStartHz,
      actualStopHz: observation.sweepStopHz,
      actualRbwHz: observation.rbwHz,
      binWidthHz: observation.binWidthHz,
    },
  );
  if (recomputed.length !== 1) return false;
  const association = recomputed[0]!;
  const recomputedAnchorTrackId = association.anchorCandidateIndex === undefined
    ? undefined
    : observation.members[association.anchorCandidateIndex]?.trackId;
  return association.candidateIndices.length === observation.members.length
    && association.startHz === observation.observedRegionStartHz
    && association.stopHz === observation.observedRegionStopHz
    && association.containmentToleranceHz === observation.containmentToleranceHz
    && association.qualification === observation.qualification
    && recomputedAnchorTrackId === observation.anchorTrackId;
}

function multicomponentMemberIsValid(
  member: MulticomponentMemberObservation,
  observation: MulticomponentAssociationObservation,
  detection: DetectedSignal,
): boolean {
  const evidence = member.localBayesianEvidence;
  const numericEvidenceKeys = [
    'priorSignalProbability',
    'posteriorSignalProbability',
    'logBayesFactor',
    'effectiveIndependentBins',
    'effectiveReferenceCells',
    'noiseShape',
    'posteriorPredictiveNullProbability',
    'targetPosteriorPredictiveNullProbability',
    'targetSweepFalseAlarmProbability',
    'multiplicityAdjustedTests',
    'testedRegionStartHz',
    'testedRegionStopHz',
    'noiseSigmaDb',
    'observedMeanShiftDb',
    'looks',
  ] as const;
  return !!member.trackId
    && member.detectorId === detection.detectorId
    && member.detectorId === MULTICOMPONENT_LOCAL_DETECTOR_MODEL_ID
    && Number.isFinite(member.startHz)
    && Number.isFinite(member.stopHz)
    && Number.isFinite(member.peakHz)
    && member.stopHz >= member.startHz
    && member.peakHz >= member.startHz
    && member.peakHz <= member.stopHz
    && member.startHz >= observation.sweepStartHz
    && member.stopHz <= observation.sweepStopHz
    && evidence.modelId === MULTICOMPONENT_LOCAL_DETECTOR_MODEL_ID
    && evidence.posteriorScope === 'selected-local-region'
    && evidence.looks === 1
    && evidence.posteriorSignalProbability >= 0.99
    && evidence.posteriorPredictiveNullProbability <= evidence.targetPosteriorPredictiveNullProbability
    && evidence.testedRegionStopHz >= evidence.testedRegionStartHz
    && evidence.testedRegionStartHz >= observation.sweepStartHz
    && evidence.testedRegionStopHz <= observation.sweepStopHz
    && member.peakHz >= evidence.testedRegionStartHz
    && member.peakHz <= evidence.testedRegionStopHz
    && numericEvidenceKeys.every((key) => Number.isFinite(evidence[key]));
}

function multicomponentObservationMatchesSweep(
  observation: MulticomponentAssociationObservation,
  sweep: Sweep,
  detection: DetectedSignal,
): boolean {
  if (observation.sweepId !== sweep.id
    || observation.sweepSequence !== sweep.sequence
    || observation.geometryId !== multicomponentSweepGeometryId(sweep)
    || observation.sweepStartHz !== sweep.actualStartHz
    || observation.sweepStopHz !== sweep.actualStopHz
    || observation.rbwHz !== sweep.actualRbwHz
    || observation.binWidthHz !== multicomponentSweepBinWidthHz(sweep)
    || observation.containmentToleranceHz
      !== Math.max(multicomponentSweepBinWidthHz(sweep) * 1.1, sweep.actualRbwHz * 1.1)) return false;
  let candidates: readonly DetectedSignal[];
  try {
    candidates = analyzeBayesianSweep(sweep, detection.detectorConfig);
  } catch {
    return false;
  }
  const matchedCandidateIndices = observation.members.map((member) => {
    const matches = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) =>
      member.detectorId === detection.detectorId
      && member.detectorId === candidate.detectorId
      && member.startHz === candidate.startHz
      && member.stopHz === candidate.stopHz
      && member.peakHz === candidate.peakHz
      && bayesianDetectionEvidenceMatches(member.localBayesianEvidence, candidate.bayesianEvidence));
    return matches.length === 1 ? matches[0]!.index : undefined;
  });
  if (matchedCandidateIndices.some((index) => index === undefined)
    || new Set(matchedCandidateIndices).size !== matchedCandidateIndices.length) return false;
  const memberByCandidateIndex = new Map(matchedCandidateIndices.map((candidateIndex, index) => [
    candidateIndex!,
    observation.members[index]!,
  ] as const));
  const expectedIndices = matchedCandidateIndices
    .filter((index): index is number => index !== undefined)
    .sort((left, right) => left - right);
  const associations = multicomponentSweptRegionAssociations(candidates, sweep).filter((association) => {
    const candidateIndices = [...association.candidateIndices].sort((left, right) => left - right);
    const anchorTrackId = association.anchorCandidateIndex === undefined
      ? undefined
      : memberByCandidateIndex.get(association.anchorCandidateIndex)?.trackId;
    return association.startHz === observation.observedRegionStartHz
      && association.stopHz === observation.observedRegionStopHz
      && association.containmentToleranceHz === observation.containmentToleranceHz
      && association.qualification === observation.qualification
      && anchorTrackId === observation.anchorTrackId
      && candidateIndices.length === expectedIndices.length
      && candidateIndices.every((candidateIndex, index) => candidateIndex === expectedIndices[index]);
  });
  return associations.length === 1;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function activityEvidenceMatches(
  observed: NonNullable<DetectedSignal['associationBayesianEvidence']>,
  expected: NonNullable<DetectedSignal['associationBayesianEvidence']>,
): boolean {
  const exactKeys = [
    'modelId',
    'positiveObservationCount',
    'transitionCount',
    'changedTransitionCount',
    'uniqueResolutionCellCount',
    'primaryChannelCenterHitCount',
    'opportunityCount',
    'maximumOpportunityWindow',
    'qualification',
  ] as const;
  if (exactKeys.some((key) => observed[key] !== expected[key])) return false;
  const numericKeys = [
    'priorAgileDynamicsProbability',
    'posteriorAgileDynamicsProbability',
    'logBayesFactor',
    'fullBand79CellAgileLogMarginalLikelihood',
    'threePrimaryChannelAgileLogMarginalLikelihood',
    'stationaryLogMarginalLikelihood',
    'modeledSweepTimeSeconds',
    'promotionPosteriorProbability',
    'retentionPosteriorProbability',
  ] as const;
  return numericKeys.every((key) => Number.isFinite(observed[key])
    && Math.abs(observed[key] - expected[key]) <= 1e-12 * Math.max(1, Math.abs(expected[key])));
}

function observeEnvelope(
  capture: ZeroSpanCapture,
  detection: DetectedSignal,
  values: Record<string, number>,
  limitations: Set<ObservableEvidenceLimitation>,
): void {
  validateZeroSpan(capture);
  const ordered = [...capture.powerDbm].sort((left, right) => left - right);
  const low = quantile(ordered, 0.05);
  const high = quantile(ordered, 0.95);
  const thresholdDbm = low + (high - low) * 0.35;
  const active = capture.powerDbm.map((value) => value >= thresholdDbm);
  let transitions = 0;
  for (let index = 1; index < active.length; index++) if (active[index] !== active[index - 1]) transitions++;
  const durationSeconds = capture.samplePeriodSeconds * Math.max(1, capture.powerDbm.length - 1);
  values['envelope.rangeDb'] = high - low;
  values['envelope.standardDeviationDb'] = standardDeviation(capture.powerDbm);
  values['envelope.duty'] = high - low < 1 ? 1 : active.filter(Boolean).length / active.length;
  values['envelope.tuneOffsetFraction'] = Math.abs(capture.frequencyHz - detection.peakHz)
    / Math.max(capture.actualRbwHz ?? 0, detection.bandwidthHz / 2, 1);
  if (capture.actualRbwHz === null) limitations.add('zero-span-rbw-unavailable');
  const timingQualified = capture.timingQualification === 'measured-calibrated' || capture.timingQualification === 'simulation-exact';
  if (!timingQualified) {
    limitations.add('zero-span-timing-unqualified');
    return;
  }
  const timingTargets = [
    ['envelope.periodicEnergy100Hz', 100],
    ['envelope.periodicEnergy200Hz', 200],
    ['envelope.periodicEnergy1600Hz', 1_600],
    ['envelope.periodicEnergy1733Hz', 26_000 / 15],
    ['envelope.periodicEnergy2000Hz', 2_000],
  ] as const;
  const sampleRateHz = 1 / capture.samplePeriodSeconds;
  const highestTimingTargetHz = Math.max(...timingTargets.map(([, frequencyHz]) => frequencyHz));
  const lowestTimingTargetHz = Math.min(...timingTargets.map(([, frequencyHz]) => frequencyHz));
  // The empirical support calibration has three exact feature views. Avoid a
  // partially timed fourth mask: cadence evidence is admitted only when every
  // declared target is both unaliased and observed for at least four cycles.
  if (sampleRateHz < highestTimingTargetHz * 2.5) {
    limitations.add('timing-rate-aliased');
    return;
  }
  if (durationSeconds < 4 / lowestTimingTargetHz) {
    limitations.add('timing-window-too-short');
    return;
  }
  values['envelope.logTransitionRateHz'] = Math.log10(1 + transitions / Math.max(Number.EPSILON, durationSeconds));
  const linearPower = capture.powerDbm.map((value) => 10 ** (value / 10));
  for (const [name, frequencyHz] of timingTargets) {
    values[name] = periodicEnvelopeEnergy(linearPower, capture.samplePeriodSeconds, frequencyHz);
  }
}

function matchingZeroSpan(detection: DetectedSignal, binWidthHz: number, referenceSweep: Sweep, capture?: ZeroSpanCapture): ZeroSpanCapture | undefined {
  if (!capture) return undefined;
  if (!zeroSpanProvenanceMatches(detection, referenceSweep, capture)) return undefined;
  const toleranceHz = Math.max(detection.bandwidthHz / 2, binWidthHz * 3, (capture.actualRbwHz ?? 0) * 2);
  return Math.abs(capture.frequencyHz - detection.peakHz) <= toleranceHz ? capture : undefined;
}

function zeroSpanProvenanceMatches(detection: DetectedSignal, referenceSweep: Sweep, capture: ZeroSpanCapture): boolean {
  return capture.targetDetectionId === detection.id
    && sameMeasurementIdentity(capture.identity, referenceSweep.identity);
}

function zeroSpanWindowMatches(
  sweeps: readonly Sweep[],
  boundSweepIds: readonly string[] | undefined,
  referenceSweep: Sweep,
): boolean {
  // Historical offline fixtures used legacy device identities before this
  // binding existed. Live instrument-session evidence must always carry the
  // exact eight-look classification window captured with zero span.
  if (boundSweepIds === undefined) return !isInstrumentMeasurementIdentity(referenceSweep.identity);
  return boundSweepIds.length === 8
    && sweeps.length === 8
    && new Set(boundSweepIds).size === boundSweepIds.length
    && boundSweepIds.every((sweepId, index) => sweepId === sweeps[index]!.id);
}

function supportedZeroSpanGeometry(capture: ZeroSpanCapture): boolean {
  const durationSeconds = capture.samplePeriodSeconds * Math.max(1, capture.powerDbm.length - 1);
  const requestedGeometryMatches = capture.powerDbm.length === BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points
    && capture.requested.sampleCount === BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points
    && Math.abs(capture.requested.sweepTimeSeconds - BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds) <= 1e-9;
  if (!requestedGeometryMatches) return false;
  // Host wall time includes command/transport overhead and is not an honest
  // sample clock. It may support untimed envelope statistics under the pinned
  // requested geometry, but observeEnvelope removes every cadence feature.
  if (capture.timingQualification !== 'measured-calibrated' && capture.timingQualification !== 'simulation-exact') return true;
  return durationSeconds >= 0.045 && durationSeconds <= 0.055;
}

/** Normalized single-bin detected-power periodogram; this is not cyclic autocorrelation or spectral correlation. */
function periodicEnvelopeEnergy(values: readonly number[], samplePeriodSeconds: number, frequencyHz: number): number {
  const average = mean(values);
  const centered = values.map((value) => value - average);
  const energy = sum(centered.map((value) => value * value));
  if (energy <= Number.MIN_VALUE) return 0;
  let cosine = 0;
  let sine = 0;
  for (let index = 0; index < centered.length; index++) {
    const phase = 2 * Math.PI * frequencyHz * index * samplePeriodSeconds;
    cosine += centered[index]! * Math.cos(phase);
    sine += centered[index]! * Math.sin(phase);
  }
  return clamp((cosine * cosine + sine * sine) / (energy * values.length), 0, 1);
}

function mirroredSidebandScore(peaks: readonly number[], frequencyHz: readonly number[], powerDbm: readonly number[], centerHz: number, binWidthHz: number): number {
  const left = peaks.filter((index) => frequencyHz[index]! < centerHz - binWidthHz).sort((a, b) => powerDbm[b]! - powerDbm[a]!)[0];
  const right = peaks.filter((index) => frequencyHz[index]! > centerHz + binWidthHz).sort((a, b) => powerDbm[b]! - powerDbm[a]!)[0];
  if (left === undefined || right === undefined) return 0;
  const separationMismatch = Math.abs((centerHz - frequencyHz[left]!) - (frequencyHz[right]! - centerHz));
  const powerMismatchDb = Math.abs(powerDbm[left]! - powerDbm[right]!);
  return Math.exp(-separationMismatch / Math.max(binWidthHz * 2, Math.abs(frequencyHz[right]! - frequencyHz[left]!) * 0.08)) * Math.exp(-powerMismatchDb / 6);
}

function symmetryAroundCenter(frequencyHz: readonly number[], weights: readonly number[], centerHz: number): number {
  let difference = 0;
  let mass = 0;
  for (let index = 0; index < frequencyHz.length; index++) {
    const mirror = nearestIndex(frequencyHz, 2 * centerHz - frequencyHz[index]!);
    if (mirror === index && Math.abs(frequencyHz[index]! - centerHz) > nominalBinWidth(frequencyHz) * 0.75) continue;
    difference += Math.abs(weights[index]! - weights[mirror]!);
    mass += weights[index]! + weights[mirror]!;
  }
  return clamp(1 - difference / Math.max(Number.MIN_VALUE, mass), 0, 1);
}

function rasterScore(frequenciesHz: readonly number[], rasterHz: number): number {
  if (frequenciesHz.length < 3) return 0;
  const anchor = frequenciesHz[0]!;
  return mean(frequenciesHz.slice(1).map((frequency) => {
    const steps = Math.round((frequency - anchor) / rasterHz);
    const residual = Math.abs(frequency - anchor - steps * rasterHz);
    return Math.exp(-0.5 * (residual / (rasterHz * 0.18)) ** 2);
  }));
}

function bluetoothAdvertisingMask(frequenciesHz: readonly number[]): number {
  const centers = [2_402_000_000, 2_426_000_000, 2_480_000_000];
  return centers.reduce((mask, center, index) => frequenciesHz.some((frequency) => Math.abs(frequency - center) <= 1_500_000) ? mask | (1 << index) : mask, 0);
}

function advertisingTripletScore(mask: number): number {
  return [0, 1, 2].filter((index) => (mask & (1 << index)) !== 0).length / 3;
}

function occupiedClusterCount(values: readonly number[], thresholdDbm: number): number {
  let clusters = 0;
  let active = false;
  for (const value of values) {
    if (value >= thresholdDbm && !active) { clusters++; active = true; }
    if (value < thresholdDbm) active = false;
  }
  return clusters;
}

function localPeaks(values: readonly number[], threshold: number): number[] {
  const result: number[] = [];
  for (let index = 1; index < values.length - 1; index++) if (values[index]! >= threshold && values[index]! > values[index - 1]! && values[index]! >= values[index + 1]!) result.push(index);
  return result;
}

function validateSweep(sweep: Sweep): void {
  if (!Number.isSafeInteger(sweep.sequence) || sweep.sequence <= 0) {
    throw new Error('Observable classification requires a positive safe-integer sweep sequence');
  }
  if (!instrumentTimestampSchema.safeParse(sweep.capturedAt).success
    || !Number.isFinite(Date.parse(sweep.capturedAt))) {
    throw new Error('Observable classification requires a canonical finite sweep timestamp');
  }
  if (!sweep.complete || sweep.frequencyHz.length < 3 || sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('Observable classification requires a complete aligned scalar sweep');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Observable classification rejects non-finite sweep evidence');
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) throw new Error('Observable classification requires a positive analysis resolution scale');
  if (sweep.resolutionBandwidthQualification === 'unavailable') {
    throw new Error('Observable scalar sweep cannot mark a populated analysis resolution scale unavailable');
  }
  if (sweep.actualAttenuationDb === null) {
    if (sweep.attenuationQualification !== 'not-applicable') {
      throw new Error('Observable scalar sweep requires explicit not-applicable qualification for absent attenuation');
    }
  } else {
    if (!Number.isFinite(sweep.actualAttenuationDb)) throw new Error('Observable classification rejects non-finite attenuation');
    if (sweep.attenuationQualification === 'not-applicable') {
      throw new Error('Observable scalar sweep cannot report attenuation when it is not applicable');
    }
  }
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || sweep.actualStopHz <= sweep.actualStartHz) {
    throw new Error('Observable classification requires finite increasing actual frequency bounds');
  }
  for (let index = 1; index < sweep.frequencyHz.length; index++) if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) throw new Error('Observable classification requires strictly increasing frequencies');
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  const closedStepHz = spanHz / (sweep.frequencyHz.length - 1);
  const halfOpenStepHz = spanHz / sweep.frequencyHz.length;
  if (!matchesObservableGrid(sweep.frequencyHz, sweep.actualStartHz, closedStepHz)
    && !matchesObservableGrid(sweep.frequencyHz, sweep.actualStartHz, halfOpenStepHz)) {
    throw new Error('Observable classification rejects materially incomplete or out-of-range sweep geometry');
  }
  if (sweep.resolutionBandwidthQualification === 'synthetic-grid-equivalent') {
    const gridSpacingHz = nominalBinWidth(sweep);
    const toleranceHz = Math.max(1e-9, gridSpacingHz * 1e-9);
    if (Math.abs(sweep.actualRbwHz - gridSpacingHz) > toleranceHz) {
      throw new Error('Observable synthetic resolution scale must equal the frequency-grid spacing');
    }
  }
}

function matchesObservableGrid(
  frequencyHz: readonly number[],
  startHz: number,
  stepHz: number,
): boolean {
  const toleranceHz = Math.max(1, Math.abs(stepHz) * 1e-9);
  return Number.isFinite(stepHz)
    && stepHz > 0
    && frequencyHz.every((frequency, index) => Math.abs(frequency - (startHz + stepHz * index)) <= toleranceHz);
}

function validateZeroSpan(capture: ZeroSpanCapture): void {
  if (!capture.complete || capture.powerDbm.length < 20 || capture.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Observable envelope evidence requires at least 20 finite samples');
  if (!Number.isFinite(capture.samplePeriodSeconds) || capture.samplePeriodSeconds <= 0) throw new Error('Observable envelope evidence requires a positive sample period');
  if (capture.actualRbwHz === null) {
    if (capture.resolutionBandwidthQualification !== 'unavailable') {
      throw new Error('Observable envelope evidence requires explicit unavailable qualification for absent RF RBW');
    }
  } else {
    if (!Number.isFinite(capture.actualRbwHz) || capture.actualRbwHz <= 0) {
      throw new Error('Observable envelope evidence requires a positive RF RBW when one is reported');
    }
    if (capture.resolutionBandwidthQualification === 'unavailable') {
      throw new Error('Observable envelope evidence cannot mark a reported RF RBW unavailable');
    }
  }
  if (capture.actualAttenuationDb === null) {
    if (capture.attenuationQualification !== 'not-applicable') {
      throw new Error('Observable envelope evidence requires explicit not-applicable qualification for absent attenuation');
    }
  } else {
    if (!Number.isFinite(capture.actualAttenuationDb)) throw new Error('Observable envelope evidence rejects non-finite attenuation');
    if (capture.attenuationQualification === 'not-applicable') {
      throw new Error('Observable envelope evidence cannot report attenuation when it is not applicable');
    }
  }
}

function robustFloor(values: readonly number[]): number {
  if (!values.length) throw new Error('Robust floor requires samples');
  // The prior lower-quartile-of-noise estimator was systematically below the
  // reference distribution and inflated every positive-excess shape feature.
  // The full reference median has a 50% contamination breakdown point and is
  // used only as a robust baseline, not claimed as calibrated mean noise power.
  return median(values);
}

function nominalBinWidth(value: Sweep | readonly number[]): number {
  const frequencies: readonly number[] = 'frequencyHz' in value ? value.frequencyHz : value;
  return median(frequencies.slice(1).map((frequency, index) => frequency - frequencies[index]!));
}

function weightedQuantile(values: readonly number[], weights: readonly number[], probability: number): number {
  let cumulative = 0;
  for (let index = 0; index < values.length; index++) {
    cumulative += weights[index]!;
    if (cumulative >= probability) return values[index]!;
  }
  return values.at(-1)!;
}

function nearestIndex(values: readonly number[], target: number): number {
  return values.reduce((best, value, index) => Math.abs(value - target) < Math.abs(values[best]! - target) ? index : best, 0);
}

function sameFrequencyGrid(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((frequency, index) => frequency === right[index]);
}

function maximumIndex(values: readonly number[]): number {
  return values.reduce((best, value, index) => value > values[best]! ? index : best, 0);
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index]!)) return index;
  return -1;
}

function localMean(values: readonly number[], index: number, radius: number): number {
  return mean(values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1)));
}

function quantile(ordered: readonly number[], probability: number): number {
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower);
}

function mean(values: readonly number[]): number { if (!values.length) throw new Error('Mean requires values'); return sum(values) / values.length; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function median(values: readonly number[]): number { if (!values.length) throw new Error('Median requires values'); const ordered = [...values].sort((left, right) => left - right); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2; }
function standardDeviation(values: readonly number[]): number { if (!values.length) return 0; const average = mean(values); return Math.sqrt(mean(values.map((value) => (value - average) ** 2))); }
function range(values: readonly number[]): number { return Math.max(...values) - Math.min(...values); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function dbmToMilliwatts(value: number): number { return 10 ** (value / 10); }
