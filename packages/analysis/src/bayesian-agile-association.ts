import type { ActivityAssociationObservation, BayesianActivityAssociationEvidence } from '@tinysa/contracts';
import { logGamma } from './bayesian-predictive.js';

export const BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL = {
  id: 'bayesian-frequency-agile-transition-v3',
  priorAgileDynamicsProbability: 0.01,
  maximumOpportunityWindow: 96,
  modeledSweepTimeSeconds: 0.05,
  minimumPositiveObservations: 8,
  minimumResolutionCells: 3,
  promotionPosteriorProbability: 0.99,
  retentionPosteriorProbability: 0.90,
  // These Beta shapes are predeclared engineering transition families. Their
  // means match independent selection from 79 or three cells, respectively,
  // but a scalar center-change sequence is not a protocol likelihood: AFH,
  // channel maps, collisions, missed packets, and scheduling are unmodeled.
  fullBand79CellChangePrior: [78, 1] as const,
  threePrimaryChannelChangePrior: [2, 1] as const,
  // Predeclared design stationary-null rate. Hardware calibration must verify
  // that a stationary source's transition probability is no greater than this
  // value. This must remain a fixed
  // Bernoulli likelihood: integrating it under the formerly used Beta(1, 19)
  // prior puts substantial mass on highly agile null sequences and conflicts
  // with the exact fixed-5% sequential false-promotion calculation.
  stationaryChangeProbability: 0.05,
  primaryChannelCentersHz: [2_402_000_000, 2_426_000_000, 2_480_000_000] as const,
  minimumPrimaryChannelToleranceHz: 1_500_000,
} as const;

/**
 * Conditional activity evidence over independently CFAR-admitted, exactly-one
 * local looks. Occurrence/miss probability is common to both hypotheses and
 * deliberately cancels: this score does not invent an SNR- or duty-cycle model.
 */
export function bayesianFrequencyAgileActivityEvidence(
  observations: readonly ActivityAssociationObservation[],
  opportunityCount: number,
): BayesianActivityAssociationEvidence {
  if (!Number.isInteger(opportunityCount)
    || opportunityCount < observations.length
    || opportunityCount > BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.maximumOpportunityWindow) {
    throw new Error('Frequency-agile evidence has an invalid opportunity count');
  }
  if (!observations.length) throw new Error('Frequency-agile evidence requires at least one positive observation');
  for (const observation of observations) validateObservation(observation);

  const transitionCount = Math.max(0, observations.length - 1);
  let changedTransitionCount = 0;
  for (let index = 1; index < observations.length; index++) {
    if (resolvedCenterChanged(observations[index - 1]!, observations[index]!)) changedTransitionCount++;
  }
  const primaryChannelHits = observations.map(primaryChannelCenterHit);
  const primaryChannelCenterHitCount = primaryChannelHits.filter(Boolean).length;

  const fullBand79CellAgileLogMarginalLikelihood = transitionLogMarginal(
    changedTransitionCount,
    transitionCount,
    ...BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.fullBand79CellChangePrior,
  );
  const threePrimaryChannelAgileLogMarginalLikelihood = transitionLogMarginal(
    changedTransitionCount,
    transitionCount,
    ...BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.threePrimaryChannelChangePrior,
  );
  const stationaryLogMarginalLikelihood = fixedTransitionLogLikelihood(
    changedTransitionCount,
    transitionCount,
    BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.stationaryChangeProbability,
  );
  const activityLogMarginalLikelihood = logSumExp([
    Math.log(0.5) + fullBand79CellAgileLogMarginalLikelihood,
    Math.log(0.5) + threePrimaryChannelAgileLogMarginalLikelihood,
  ]);
  const logBayesFactor = activityLogMarginalLikelihood - stationaryLogMarginalLikelihood;
  const posteriorAgileDynamicsProbability = posteriorFromPriorAndLogBayesFactor(
    BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.priorAgileDynamicsProbability,
    logBayesFactor,
  );

  return {
    modelId: BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.id,
    priorAgileDynamicsProbability: BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.priorAgileDynamicsProbability,
    posteriorAgileDynamicsProbability,
    logBayesFactor,
    fullBand79CellAgileLogMarginalLikelihood,
    threePrimaryChannelAgileLogMarginalLikelihood,
    stationaryLogMarginalLikelihood,
    positiveObservationCount: observations.length,
    transitionCount,
    changedTransitionCount,
    uniqueResolutionCellCount: resolutionCellCount(observations),
    primaryChannelCenterHitCount,
    opportunityCount,
    maximumOpportunityWindow: BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.maximumOpportunityWindow,
    modeledSweepTimeSeconds: BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.modeledSweepTimeSeconds,
    promotionPosteriorProbability: BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.promotionPosteriorProbability,
    retentionPosteriorProbability: BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.retentionPosteriorProbability,
    qualification: 'engineering-transition-families-conditional-on-unambiguous-cfar-looks-not-protocol-or-emitter-identity',
  };
}

export function bayesianFrequencyAgileActivityQualifies(
  evidence: BayesianActivityAssociationEvidence,
  previouslyPromoted: boolean,
): boolean {
  return evidence.positiveObservationCount >= BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.minimumPositiveObservations
    && evidence.uniqueResolutionCellCount >= BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.minimumResolutionCells
    && evidence.posteriorAgileDynamicsProbability >= (previouslyPromoted
      ? BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.retentionPosteriorProbability
      : BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.promotionPosteriorProbability);
}

function validateObservation(observation: ActivityAssociationObservation): void {
  const local = observation.localBayesianEvidence;
  if (!observation.sweepId || !observation.trackId
    || ![observation.centerHz, observation.startHz, observation.stopHz, observation.rbwHz, observation.binWidthHz].every(Number.isFinite)
    || observation.stopHz <= observation.startHz
    || observation.centerHz < observation.startHz
    || observation.centerHz > observation.stopHz
    || observation.rbwHz <= 0
    || observation.binWidthHz <= 0
    || !observation.detectorId
    || !local
    || local.modelId !== observation.detectorId
    || local.posteriorScope !== 'selected-local-region'
    || local.looks !== 1
    || ![local.posteriorSignalProbability, local.logBayesFactor, local.posteriorPredictiveNullProbability,
      local.testedRegionStartHz, local.testedRegionStopHz].every(Number.isFinite)
    // A one-bin Bayesian test has identical center coordinates at its start
    // and stop; the observation support above still carries positive bin width.
    || local.testedRegionStopHz < local.testedRegionStartHz) {
    throw new Error('Frequency-agile association contains invalid local-look provenance');
  }
}

function resolvedCenterChanged(left: ActivityAssociationObservation, right: ActivityAssociationObservation): boolean {
  const resolutionHz = Math.max(
    500_000,
    left.rbwHz,
    right.rbwHz,
    0.5 * ((left.stopHz - left.startHz) + (right.stopHz - right.startHz)),
  );
  return Math.abs(left.centerHz - right.centerHz) > resolutionHz;
}

function resolutionCellCount(observations: readonly ActivityAssociationObservation[]): number {
  const cells: ActivityAssociationObservation[] = [];
  for (const observation of [...observations].sort((left, right) => left.centerHz - right.centerHz)) {
    if (cells.every((cell) => resolvedCenterChanged(cell, observation))) cells.push(observation);
  }
  return cells.length;
}

function primaryChannelCenterHit(observation: ActivityAssociationObservation): boolean {
  const toleranceHz = Math.max(
    BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.minimumPrimaryChannelToleranceHz,
    observation.rbwHz,
  );
  return BAYESIAN_FREQUENCY_AGILE_ACTIVITY_MODEL.primaryChannelCentersHz
    .some((centerHz) => Math.abs(observation.centerHz - centerHz) <= toleranceHz);
}

function transitionLogMarginal(changed: number, total: number, alpha: number, beta: number): number {
  return logBeta(changed + alpha, total - changed + beta) - logBeta(alpha, beta);
}

function fixedTransitionLogLikelihood(changed: number, total: number, changeProbability: number): number {
  return changed * Math.log(changeProbability) + (total - changed) * Math.log1p(-changeProbability);
}

function logBeta(alpha: number, beta: number): number {
  return logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
}

function logSumExp(values: readonly number[]): number {
  const maximum = Math.max(...values);
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

function posteriorFromPriorAndLogBayesFactor(prior: number, logBayesFactor: number): number {
  const logPosteriorOdds = logBayesFactor + Math.log(prior / (1 - prior));
  if (logPosteriorOdds >= 0) return 1 / (1 + Math.exp(-logPosteriorOdds));
  const odds = Math.exp(logPosteriorOdds);
  return odds / (1 + odds);
}
