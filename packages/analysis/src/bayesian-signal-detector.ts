import type {
  DetectedSignal,
  SignalDetectionConfig,
  Sweep,
} from '@tinysa/contracts';
import { logGamma, regularizedIncompleteBeta } from './bayesian-predictive.js';
import { MULTICOMPONENT_LOCAL_DETECTOR_MODEL_ID } from './multicomponent-swept-region.js';

export const BAYESIAN_DETECTOR_MODEL = {
  id: MULTICOMPONENT_LOCAL_DETECTOR_MODEL_ID,
  priorSignalProbability: 0.01,
  minimumPosteriorSignalProbability: 0.99,
  targetSweepFalseAlarmProbability: 0.001,
  uncalibratedNoiseShape: 1,
  referenceCellsPerSide: 12,
  signalGainPriorScaleDb: 18,
  maximumSignalGainDb: 60,
  signalGainGridStepDb: 1,
} as const;

interface SpectralGroup { start: number; end: number; }

/** Pure detector core shared by live tracking and provenance revalidation. */
export function analyzeBayesianSweep(
  sweep: Sweep,
  config: SignalDetectionConfig,
): readonly DetectedSignal[] {
  validateBayesianDetectorSweep(sweep);
  const noiseFloorDbm = robustNoiseFloor(sweep.powerDbm);
  const thresholdDbm = config.threshold.strategy === 'absolute'
    ? config.threshold.levelDbm
    : noiseFloorDbm + config.threshold.marginDb;
  const aboveThreshold = sweep.powerDbm.map((power) => power >= thresholdDbm);
  bridgeShortGaps(aboveThreshold, 2);
  const groups: SpectralGroup[] = [];
  let start: number | undefined;
  for (let index = 0; index < sweep.powerDbm.length; index++) {
    if (aboveThreshold[index] && start === undefined) start = index;
    if ((!aboveThreshold[index] || index === sweep.powerDbm.length - 1) && start !== undefined) {
      const end = aboveThreshold[index] ? index : index - 1;
      groups.push({ start, end });
      start = undefined;
    }
  }
  const testedWidths = bayesianRegionWidths(sweep);
  const multiplicityAdjustedTests = Math.max(1, sweep.powerDbm.length * testedWidths.length);
  let retainedSourceSweep: Sweep | undefined;
  const sourceSweep = (): Sweep => {
    retainedSourceSweep ??= compactBayesianEvidenceSweep(sweep);
    return retainedSourceSweep;
  };
  return groups.flatMap(({ start: first, end: last }, index) => {
    let peak = first;
    for (let cursor = first + 1; cursor <= last; cursor++) {
      if (sweep.powerDbm[cursor]! > sweep.powerDbm[peak]!) peak = cursor;
    }
    const shoulders = localShoulderStatistics(sweep.powerDbm, first, last, noiseFloorDbm);
    const prominenceDb = sweep.powerDbm[peak]! - shoulders.levelDbm;
    const prominenceThresholdDb = Math.max(config.minimumProminenceDb, shoulders.robustSigmaDb * 4);
    const startHz = sweep.frequencyHz[first]!;
    const stopHz = sweep.frequencyHz[last]!;
    const passingEvidence = testedWidths
      .map((width) => centeredRegion(sweep.powerDbm.length, peak, width))
      .map((region) => bayesianPresenceEvidence(sweep, region.first, region.last, multiplicityAdjustedTests))
      .filter((evidence) => evidence.posteriorSignalProbability >= BAYESIAN_DETECTOR_MODEL.minimumPosteriorSignalProbability
        && evidence.posteriorPredictiveNullProbability <= evidence.targetPosteriorPredictiveNullProbability)
      .sort((left, right) => left.posteriorPredictiveNullProbability - right.posteriorPredictiveNullProbability);
    const bayesianEvidence = passingEvidence[0];
    if (!bayesianEvidence) return [];
    const qualityFlags: DetectedSignal['qualityFlags'][number][] = [];
    if (first === 0) qualityFlags.push('touches-lower-boundary');
    if (last === sweep.frequencyHz.length - 1) qualityFlags.push('touches-upper-boundary');
    if (first === last) qualityFlags.push('single-bin');
    const classificationRegionStartHz = Math.min(startHz, bayesianEvidence.testedRegionStartHz);
    const classificationRegionStopHz = Math.max(stopHz, bayesianEvidence.testedRegionStopHz);
    return [{
      id: `${sweep.id}:candidate-${index}`,
      startHz,
      stopHz,
      peakHz: sweep.frequencyHz[peak]!,
      peakDbm: sweep.powerDbm[peak]!,
      prominenceDb,
      prominenceThresholdDb,
      bandwidthHz: Math.max(0, stopHz - startHz),
      thresholdDbm,
      noiseFloorDbm,
      firstSeenAt: sweep.capturedAt,
      lastSeenAt: sweep.capturedAt,
      sweepIds: [sweep.id],
      persistenceSweeps: 1,
      missedSweeps: 0,
      state: config.minimumConsecutiveSweeps <= 1 ? 'active' : 'candidate',
      detectorId: BAYESIAN_DETECTOR_MODEL.id,
      detectorConfig: structuredClone(config),
      bayesianEvidence,
      classificationRegionStartHz,
      classificationRegionStopHz,
      classificationRegionSweepIds: [sweep.id],
      classificationRegionObservation: freezeRetainedBayesianEvidence({
        sourceSweep: sourceSweep(),
        startHz,
        stopHz,
        peakHz: sweep.frequencyHz[peak]!,
        detectorId: BAYESIAN_DETECTOR_MODEL.id,
        localBayesianEvidence: structuredClone(bayesianEvidence),
      }),
      associationMode: 'frequency-local',
      qualityFlags,
    } satisfies DetectedSignal];
  }).filter((signal) => signal.bandwidthHz >= config.minimumBandwidthHz
    && signal.prominenceDb >= signal.prominenceThresholdDb);
}

export function bayesianDetectionEvidenceMatches(
  left: DetectedSignal['bayesianEvidence'],
  right: DetectedSignal['bayesianEvidence'],
): boolean {
  const keys = [
    'modelId', 'posteriorScope', 'priorSignalProbability', 'posteriorSignalProbability',
    'logBayesFactor', 'effectiveIndependentBins', 'effectiveReferenceCells', 'noiseShape',
    'posteriorPredictiveNullProbability', 'targetPosteriorPredictiveNullProbability',
    'targetSweepFalseAlarmProbability', 'multiplicityAdjustedTests', 'testedRegionStartHz',
    'testedRegionStopHz', 'qualification', 'noiseSigmaDb', 'observedMeanShiftDb', 'looks',
  ] as const;
  return keys.every((key) => left[key] === right[key]);
}

export function validateBayesianDetectorSweep(sweep: Sweep): void {
  if (sweep.complete !== true) throw new Error('Sweep is incomplete');
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('Sweep frequency and power arrays have different lengths');
  if (sweep.powerDbm.length < 3) throw new Error('Sweep requires at least three measurement points');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Sweep contains non-finite measurement values');
  }
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || sweep.actualStopHz <= sweep.actualStartHz) throw new Error('Sweep requires finite increasing actual frequency bounds');
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) {
    throw new Error('Sweep requires a finite positive analysis resolution scale');
  }
  for (let index = 1; index < sweep.frequencyHz.length; index++) {
    if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) throw new Error('Sweep frequencies are not strictly increasing');
  }
  const geometryToleranceHz = Math.max(sweep.actualRbwHz, (sweep.actualStopHz - sweep.actualStartHz) * 1e-9);
  if (sweep.frequencyHz[0]! < sweep.actualStartHz - geometryToleranceHz
    || sweep.frequencyHz.at(-1)! > sweep.actualStopHz + geometryToleranceHz) {
    throw new Error('Sweep frequency grid lies outside its actual bounds');
  }
}

/** Strip display-only trace payloads while retaining every detector input and source binding. */
export function compactBayesianEvidenceSweep(sweep: Sweep): Sweep {
  const clone = structuredClone(sweep);
  delete (clone as { firmwareTraces?: unknown }).firmwareTraces;
  return freezeRetainedBayesianEvidence(clone);
}

/** Deep-freeze authority-owned Bayesian provenance before it is structurally shared. */
export function freezeRetainedBayesianEvidence<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeRetainedBayesianEvidence(child);
  }
  return Object.freeze(value) as T;
}

function bridgeShortGaps(mask: boolean[], maximumGapBins: number): void {
  let index = 0;
  while (index < mask.length) {
    if (mask[index]) { index++; continue; }
    const start = index;
    while (index < mask.length && !mask[index]) index++;
    const bounded = start > 0 && index < mask.length;
    if (bounded && index - start <= maximumGapBins) {
      for (let cursor = start; cursor < index; cursor++) mask[cursor] = true;
    }
  }
}

function localShoulderStatistics(
  powerDbm: readonly number[],
  first: number,
  last: number,
  noiseFloorDbm: number,
): { levelDbm: number; robustSigmaDb: number } {
  const width = last - first + 1;
  const shoulderBins = Math.min(12, Math.max(3, width));
  const shoulders = [
    ...powerDbm.slice(Math.max(0, first - shoulderBins), first),
    ...powerDbm.slice(last + 1, Math.min(powerDbm.length, last + 1 + shoulderBins)),
  ];
  if (!shoulders.length) return { levelDbm: noiseFloorDbm, robustSigmaDb: 0 };
  const ordered = shoulders.slice().sort((left, right) => left - right);
  const center = median(ordered);
  const medianAbsoluteDeviation = median(ordered.map((value) => Math.abs(value - center)));
  return {
    levelDbm: Math.max(noiseFloorDbm, center),
    robustSigmaDb: medianAbsoluteDeviation * 1.4826,
  };
}

function bayesianPresenceEvidence(
  sweep: Sweep,
  first: number,
  last: number,
  multiplicityAdjustedTests: number,
): DetectedSignal['bayesianEvidence'] {
  const binWidthHz = median(sweep.frequencyHz.slice(1).map((frequency, index) => frequency - sweep.frequencyHz[index]!));
  const rbwBins = Math.max(1, sweep.actualRbwHz / Math.max(Number.MIN_VALUE, binWidthHz));
  const measuredWidthHz = Math.max(binWidthHz, sweep.frequencyHz[last]! - sweep.frequencyHz[first]! + binWidthHz);
  const effectiveIndependentBins = Math.max(1, Math.min(last - first + 1, measuredWidthHz / Math.max(binWidthHz, sweep.actualRbwHz)));
  const availableOutsideBins = sweep.powerDbm.length - (last - first + 1);
  const guardBins = Math.min(
    Math.max(0, Math.ceil(rbwBins)),
    Math.max(0, Math.floor((availableOutsideBins - 2) / 2)),
  );
  const referenceBinsPerSide = Math.max(1, Math.ceil(BAYESIAN_DETECTOR_MODEL.referenceCellsPerSide * rbwBins));
  const leftStop = Math.max(0, first - guardBins);
  const rightStart = Math.min(sweep.powerDbm.length, last + 1 + guardBins);
  const referencePowerDbm = [
    ...sweep.powerDbm.slice(Math.max(0, leftStop - referenceBinsPerSide), leftStop),
    ...sweep.powerDbm.slice(rightStart, Math.min(sweep.powerDbm.length, rightStart + referenceBinsPerSide)),
  ];
  if (referencePowerDbm.length < 2) throw new Error('Bayesian multiscale CFAR region has too few reference bins');
  const referenceMilliwatts = referencePowerDbm.map(dbmToMilliwatts);
  const referenceMeanMilliwatts = sum(referenceMilliwatts) / referenceMilliwatts.length;
  const noiseShape = BAYESIAN_DETECTOR_MODEL.uncalibratedNoiseShape;
  const effectiveReferenceCells = Math.max(1, Math.min(referencePowerDbm.length, referencePowerDbm.length / rbwBins));
  const groupMilliwatts = sweep.powerDbm.slice(first, last + 1).map(dbmToMilliwatts);
  const normalizedTargetMean = (sum(groupMilliwatts) / groupMilliwatts.length) / referenceMeanMilliwatts;
  const observedMeanShiftDb = 10 * Math.log10(Math.max(Number.MIN_VALUE, normalizedTargetMean));
  const referenceShape = effectiveReferenceCells * noiseShape;
  const referenceSum = effectiveReferenceCells;
  const targetShape = effectiveIndependentBins * noiseShape;
  const targetSum = Math.max(Number.MIN_VALUE, effectiveIndependentBins * normalizedTargetMean);
  const posteriorPredictiveNullProbability = clampFinite(
    regularizedIncompleteBeta(referenceSum / (referenceSum + targetSum), referenceShape, targetShape),
    0,
    1,
  );
  const targetPosteriorPredictiveNullProbability = BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability / multiplicityAdjustedTests;
  let logBayesFactor = -700;
  if (posteriorPredictiveNullProbability <= targetPosteriorPredictiveNullProbability) {
    const noiseLogLikelihood = betaPrimeLogDensity(targetSum, targetShape, referenceShape, referenceSum);
    const signalComponents: number[] = [];
    const signalPriorComponents: number[] = [];
    for (let gainDb = BAYESIAN_DETECTOR_MODEL.signalGainGridStepDb / 2;
      gainDb <= BAYESIAN_DETECTOR_MODEL.maximumSignalGainDb;
      gainDb += BAYESIAN_DETECTOR_MODEL.signalGainGridStepDb) {
      const gain = 10 ** (gainDb / 10);
      const prior = -0.5 * (gainDb / BAYESIAN_DETECTOR_MODEL.signalGainPriorScaleDb) ** 2;
      signalPriorComponents.push(prior);
      signalComponents.push(prior + betaPrimeLogDensity(targetSum / gain, targetShape, referenceShape, referenceSum) - Math.log(gain));
    }
    const signalLogLikelihood = logSumExp(signalComponents) - logSumExp(signalPriorComponents);
    logBayesFactor = clampFinite(signalLogLikelihood - noiseLogLikelihood, -700, 700);
  }
  const referenceMedian = median(referencePowerDbm);
  const referenceDeviations = referencePowerDbm.map((value) => Math.abs(value - referenceMedian));
  return {
    modelId: BAYESIAN_DETECTOR_MODEL.id,
    posteriorScope: 'selected-local-region',
    priorSignalProbability: BAYESIAN_DETECTOR_MODEL.priorSignalProbability,
    posteriorSignalProbability: posteriorFromLogBayesFactor(logBayesFactor),
    logBayesFactor,
    effectiveIndependentBins,
    effectiveReferenceCells,
    noiseShape,
    posteriorPredictiveNullProbability,
    targetPosteriorPredictiveNullProbability,
    targetSweepFalseAlarmProbability: BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability,
    multiplicityAdjustedTests,
    testedRegionStartHz: sweep.frequencyHz[first]!,
    testedRegionStopHz: sweep.frequencyHz[last]!,
    qualification: 'ideal-exponential-not-physically-calibrated',
    noiseSigmaDb: median(referenceDeviations) * 1.4826,
    observedMeanShiftDb,
    looks: 1,
  };
}

function bayesianRegionWidths(sweep: Sweep): readonly number[] {
  const length = sweep.powerDbm.length;
  if (length <= 2) return [1];
  const binWidthHz = median(sweep.frequencyHz.slice(1).map((frequency, index) => frequency - sweep.frequencyHz[index]!));
  const rbwBins = Math.max(1, sweep.actualRbwHz / Math.max(Number.MIN_VALUE, binWidthHz));
  const maximumWidth = Math.max(1, length - 2);
  const widths = new Set<number>([1]);
  for (let scale = 1; scale * rbwBins <= maximumWidth; scale *= 2) {
    widths.add(Math.max(1, Math.min(maximumWidth, Math.round(scale * rbwBins))));
  }
  for (const fraction of [0.25, 0.5, 0.75, 0.9]) {
    widths.add(Math.max(1, Math.min(maximumWidth, Math.round(length * fraction))));
  }
  return [...widths].sort((left, right) => left - right);
}

function centeredRegion(length: number, center: number, width: number): { first: number; last: number } {
  const boundedWidth = Math.max(1, Math.min(length, width));
  let first = center - Math.floor((boundedWidth - 1) / 2);
  let last = first + boundedWidth - 1;
  if (first < 0) { last -= first; first = 0; }
  if (last >= length) { first -= last - length + 1; last = length - 1; }
  return { first: Math.max(0, first), last };
}

function betaPrimeLogDensity(value: number, targetShape: number, referenceShape: number, referenceSum: number): number {
  if (![value, targetShape, referenceShape, referenceSum].every(Number.isFinite)
    || value <= 0 || targetShape <= 0 || referenceShape <= 0 || referenceSum <= 0) {
    throw new Error('Bayesian predictive density requires finite positive inputs');
  }
  return logGamma(referenceShape + targetShape)
    - logGamma(referenceShape)
    - logGamma(targetShape)
    + referenceShape * Math.log(referenceSum)
    + (targetShape - 1) * Math.log(value)
    - (referenceShape + targetShape) * Math.log(referenceSum + value);
}

function posteriorFromLogBayesFactor(logBayesFactor: number): number {
  const prior = BAYESIAN_DETECTOR_MODEL.priorSignalProbability;
  const logPosteriorOdds = logBayesFactor + Math.log(prior / (1 - prior));
  if (logPosteriorOdds >= 0) return 1 / (1 + Math.exp(-logPosteriorOdds));
  const odds = Math.exp(logPosteriorOdds);
  return odds / (1 + odds);
}

function robustNoiseFloor(values: readonly number[]): number {
  if (!values.length) throw new Error('Candidate-baseline estimation requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  const cutoff = Math.max(1, Math.floor(sorted.length * 0.2));
  return median(sorted.slice(0, cutoff));
}

function logSumExp(values: readonly number[]): number {
  const maximum = Math.max(...values);
  return maximum + Math.log(values.reduce((total, value) => total + Math.exp(value - maximum), 0));
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (Number.isNaN(value)) throw new Error('Bayesian evidence calculation produced NaN');
  return Math.max(minimum, Math.min(maximum, value));
}

function dbmToMilliwatts(value: number): number { return 10 ** (value / 10); }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
