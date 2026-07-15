import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BayesianWaveformClassifier,
  BAYESIAN_WAVEFORM_MODEL,
  inferPosterior,
  knownModelSupportRank,
  selectObservableDecision,
} from '../packages/analysis/src/bayesian-waveform-classifier.js';
import { BAYESIAN_OBSERVABLE_MODEL } from '../packages/analysis/src/models/bayesian-observable-v5.generated.js';
import { BAYESIAN_OBSERVABLE_MODEL_SHA256 } from '../packages/analysis/src/models/bayesian-observable-v5.manifest.generated.js';
import { OBSERVABLE_LEAF_CLASSES, type ObservableLeafClass } from '../packages/analysis/src/observable-classifier-model.js';
import { extractObservableFeatures } from '../packages/analysis/src/observable-features.js';
import { observableRepresentativeIsEligibleForModelFit } from '../packages/analysis/src/observable-hypothesis-domain.js';
import { classificationRepresentatives, SignalDetector, SignalTracker } from '../packages/analysis/src/index.js';
import {
  CLASSIFICATION_CORPUS_VERSION,
  canonicalClassificationScenarios,
  synthesizeCanonicalObservation,
  type CanonicalClassificationScenario,
  type ObservableSignalClass,
} from '../../TinySA_SignalLab/src/classification-corpus.js';
import type {
  DetectedSignal,
  DeviceIdentity,
  SignalDetectionConfig,
  Sweep,
  ZeroSpanCapture,
} from '../packages/contracts/src/index.js';

// Independent of both model fitting/calibration and the transition-model
// design audit. Eight phase/noise shifts make the finite-acquisition coverage
// gate a genuine replicated test rather than a two-seed smoke check.
const NUISANCE_SHIFT_SEEDS = [
  13_001, 13_019, 13_037, 13_063, 13_081, 13_099, 13_127, 13_151,
] as const;
const SNR_DB = [6, 10, 16, 24, 32] as const;
const HIGH_SNR_MINIMUM_DB = 24;
// These partitions are validator-owned pins. They intentionally duplicate the
// trainer policy instead of accepting model metadata as ground truth: a model
// cannot redefine its own holdout set and thereby make validation pass.
const PINNED_FITTED_UNKNOWN_SCENARIO_IDS = [
  'unknown-narrow-fsk',
  'unknown-802154',
] as const;
const PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS = [
  'unknown-chirp',
  'unknown-impulsive',
] as const;
const PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS = [
  'unknown-regular-cw-comb-4',
  'unknown-regular-cw-comb-5',
  'unknown-irregular-cw-multitone-100-210-370k',
  'unknown-stationary-intermittent-2g4',
  'unknown-simultaneous-1mhz-raster-2g4',
  'unknown-interleaved-four-channel-2g4',
  'unknown-proprietary-off-raster-fhss-2g4',
] as const;
const PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS = [
  { nullScenarioId: 'unknown-instrument-spur-rbw-line', referenceScenarioId: 'cw-rbw-line' },
  { nullScenarioId: 'unknown-independent-am-equivalent-three-tone', referenceScenarioId: 'am-dsb-25k' },
  { nullScenarioId: 'unknown-independent-fm-equivalent-bessel-comb', referenceScenarioId: 'fm-beta-3' },
  { nullScenarioId: 'unknown-generic-ofdm-20m', referenceScenarioId: 'lte-band3-fdd-20m' },
  { nullScenarioId: 'unknown-generic-tdd-ofdm-10m', referenceScenarioId: 'lte-band38-tdd-10m' },
  { nullScenarioId: 'unknown-generic-ofdm-80m', referenceScenarioId: 'wifi-ofdm-80m' },
  { nullScenarioId: 'unknown-proprietary-dsss-22m', referenceScenarioId: 'wifi-hr-dsss-11m' },
] as const;
const PINNED_EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS = PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS
  .map((pair) => pair.nullScenarioId);
const PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS = [
  'gsm-900-tdma',
] as const;
const PINNED_SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS = [
  ...PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS,
  ...PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS,
  ...PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS,
  ...PINNED_EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS,
] as const;
// The chirp aliases between separated local tracks and one-timeslot GSM is
// deliberately acquisition-limited. Any change to this exception list is a
// validator policy change, not something model metadata may silently broaden.
const PINNED_EXPECTED_CLASSIFICATION_NON_ADMISSION_SCENARIO_IDS = [
  'unknown-chirp',
  'gsm-900-tdma',
] as const;
const EXACT_EQUIVALENCE_NUMERICAL_TOLERANCE = 1e-11;
// Held-out geometric interstitials between the fit/calibration divisors
// [12, 20, 35, 55, 80, 120]. None is a training or calibration grid point.
const RBW_DIVISORS = [15.5, 44, 98] as const;
const ADMISSION_SEED_COVERAGE_SNR_DB = [24, 32] as const;
const BLE_ADVERTISING_MINIMUM_SEED_COVERAGE = 0.5;
const CLASSIFICATION_ADMISSIONS = 8;
const STANDARD_OBSERVATION_OPPORTUNITIES = 24;
const FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES = 96;
const FULL_BAND_2G4_START_HZ = 2_402_000_000;
const FULL_BAND_2G4_STOP_HZ = 2_480_000_000;
const SELECTION_POLICY = 'online-first-ready-all-representatives-v3' as const;
const PINNED_TAIL_CALIBRATION_SCORE_UNIT = 'one-score-per-fit-eligible-acquisition-attempt-v1' as const;
const PINNED_TAIL_CALIBRATION_AGGREGATION_POLICY = 'minimum-support-across-fit-eligible-first-ready-representatives-v1' as const;
const PINNED_TAIL_CALIBRATION_RUNTIME_INTERPRETATION_POLICY = 'single-representative-rank-dominates-attempt-min-rank-v1' as const;
const PINNED_TAIL_CALIBRATION_STATISTICAL_INTERPRETATION = 'empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1' as const;
const SWEEP_POINTS = 450;
const SWEEP_TIME_SECONDS = 0.05;
const ZERO_SPAN_POINTS = 450;
const ZERO_SPAN_SAMPLE_PERIOD_SECONDS = 1 / 9_000;
const PINNED_SIGNAL_LAB_COMMIT = '03197cb5b4a03b85ef5efe6525f4f28ceedcaef3';
const diagnosticScenarioIds = (process.env.TINYSA_VALIDATION_SCENARIO_IDS ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const diagnosticScenarioIdSet = new Set(diagnosticScenarioIds);
const validationScenarios = diagnosticScenarioIdSet.size === 0
  ? canonicalClassificationScenarios
  : canonicalClassificationScenarios.filter((scenario) => diagnosticScenarioIdSet.has(scenario.id));
const invalidDiagnosticScenarioIds = diagnosticScenarioIds
  .filter((scenarioId) => !canonicalClassificationScenarios.some((scenario) => scenario.id === scenarioId));
if (invalidDiagnosticScenarioIds.length > 0) {
  throw new Error(`Unknown diagnostic validation scenario IDs: ${invalidDiagnosticScenarioIds.join(', ')}`);
}
const PRODUCTION_DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const classifier = new BayesianWaveformClassifier();
const checkedOutCorpusSha256 = createHash('sha256')
  .update(readFileSync(resolve('../TinySA_SignalLab/src/classification-corpus.ts')))
  .digest('hex');
const checkedInModelAssetSha256 = createHash('sha256')
  .update(readFileSync(resolve('packages/analysis/src/models/bayesian-observable-v5.generated.ts')))
  .digest('hex');
const identity: DeviceIdentity = {
  model: 'SignalLab production-pipeline synthetic validation corpus', hardwareVersion: 'offline', firmwareVersion: CLASSIFICATION_CORPUS_VERSION,
  firmwareQualification: 'protocol-test',
  port: { id: 'offline', path: 'offline://classification-validation', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
  simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
};

interface AdmissionAttempt {
  attemptId: string;
  scenario: string;
  corpusTruth: ObservableSignalClass;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  snrDb: number;
  rbwDivisor: number;
  actualRbwHz: number;
  binWidthHz: number;
  seed: number;
  observationHorizon: number;
  everReady: boolean;
  admitted: boolean;
  everReadyRepresentativeCount: number;
  finalReadyRepresentativeCount: number;
  finalActiveRepresentativeCount: number;
  selectedTrackAdmissions: number;
  maximumActiveAdmissions: number;
  maximumLocalTrackAdmissions: number;
  firstReadyOpportunity?: number;
  everAssociationModes: readonly string[];
  finalAssociationModes: readonly string[];
  regularAssociationsObserved: number;
  agileAssociationsObserved: number;
  regularAssociationExpirations: number;
}

interface ValidationCase {
  attemptId: string;
  representativeKey: string;
  scenario: string;
  corpusTruth: ObservableSignalClass;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  nominalBandwidthHz: number;
  snrDb: number;
  rbwDivisor: number;
  actualRbwHz: number;
  binWidthHz: number;
  seed: number;
  firstReadyOpportunity: number;
  componentFitEligible: boolean;
  result: string;
  confidence: number;
  unknownPosterior: number;
  truthPosterior: number;
  topLeaf: string;
  topLeafPosterior: number;
  acceptedHierarchy: boolean;
  posterior: Readonly<Record<string, number>>;
  bandwidthHz: number;
  selectedTrackAdmissions: number;
  localTrackAdmissions: number;
  associationMode: NonNullable<DetectedSignal['associationMode']>;
  associationId?: string;
  associationModelId?: string;
  associationMemberCount?: number;
  associationRegionBandwidthHz?: number;
  knownSupportRank: number;
  limitations: readonly string[];
  features: Readonly<Record<string, number>>;
}

interface EvidenceViewCase {
  attemptId: string;
  representativeKey: string;
  view: 'spectrum-only' | 'envelope-untimed';
  scenario: string;
  corpusTruth: ObservableSignalClass;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  componentFitEligible: boolean;
  nominalBandwidthHz: number;
  measuredBandwidthHz: number;
  result: string;
  topLeaf: string;
  topLeafPosterior: number;
  truthPosterior: number;
  posterior: Readonly<Record<string, number>>;
  acceptedHierarchy: boolean;
  supportRank: number;
  features: Readonly<Record<string, number>>;
}

interface ExactEquivalenceDiscrepancy {
  pair: string;
  nuisanceCell: string;
  representativeIndex?: number;
  view?: EvidenceViewCase['view'];
  field: string;
  reference: unknown;
  null: unknown;
}

interface ExactEquivalencePairAudit {
  pair: string;
  referenceScenarioId: string;
  nullScenarioId: string;
  nuisanceCells: number;
  matchedAdmissionCells: number;
  matchedRepresentativePairs: number;
  matchedEvidenceViewPairs: number;
  discrepancyCount: number;
  discrepancies: readonly ExactEquivalenceDiscrepancy[];
}

interface FirstReadyRepresentative {
  detection: DetectedSignal;
  representativeKey: string;
  classificationAdmissions: number;
  localTrackAdmissions: number;
  firstReadyOpportunity: number;
  evidenceSweeps: readonly Sweep[];
}

interface ProductionOnlineSelection {
  representatives: readonly FirstReadyRepresentative[];
  everReadyRepresentativeKeys: readonly string[];
  finalReadyRepresentativeCount: number;
  finalActiveRepresentativeCount: number;
  maximumActiveAdmissions: number;
  maximumLocalTrackAdmissions: number;
  firstReadyOpportunity?: number;
  everAssociationModes: readonly string[];
  finalAssociationModes: readonly string[];
  regularAssociationIds: readonly string[];
  agileAssociationIds: readonly string[];
  regularAssociationExpirations: number;
}

const cases: ValidationCase[] = [];
const evidenceViewCases: EvidenceViewCase[] = [];
const admissionAttempts: AdmissionAttempt[] = [];
for (const scenario of validationScenarios) {
  for (const snrDb of SNR_DB) {
    for (const rbwDivisor of RBW_DIVISORS) {
      for (const seed of NUISANCE_SHIFT_SEEDS) {
        const nominalBinWidthHz = scenario.recommendedSpanHz / 449;
        const actualRbwHz = Math.max(nominalBinWidthHz * 0.8, scenario.occupiedBandwidthHz / rbwDivisor, 1_000);
        const attemptId = validationAttemptId(scenario.id, snrDb, rbwDivisor, seed);
        const observationHorizon = observationOpportunityHorizon(scenario);
        const observations = Array.from({ length: observationHorizon }, (_, lookIndex) => synthesizeCanonicalObservation(scenario.id, {
          lookIndex,
          seed,
          snrDb,
          actualRbwHz,
          points: SWEEP_POINTS,
          sweepTimeSeconds: SWEEP_TIME_SECONDS,
          zeroSpanPoints: ZERO_SPAN_POINTS,
          zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
        }));
        const sweeps = observations.map((observation) => asSweep(scenario, observation));
        const selection = selectProductionFirstReady(sweeps);
        const mappedTruth = modelTruth(scenario.truthClass);
        const allowedModelTruths = [...new Set(scenario.allowedObservableClasses.map(modelTruth))];
        const selectedAdmissions = selection.representatives.map((item) => item.classificationAdmissions);
        admissionAttempts.push({
          attemptId,
          scenario: scenario.id,
          corpusTruth: scenario.truthClass,
          modelTruth: mappedTruth,
          allowedModelTruths,
          snrDb,
          rbwDivisor,
          actualRbwHz,
          binWidthHz: nominalBinWidthHz,
          seed,
          observationHorizon,
          everReady: selection.everReadyRepresentativeKeys.length > 0,
          admitted: selection.representatives.length > 0,
          everReadyRepresentativeCount: selection.everReadyRepresentativeKeys.length,
          finalReadyRepresentativeCount: selection.finalReadyRepresentativeCount,
          finalActiveRepresentativeCount: selection.finalActiveRepresentativeCount,
          selectedTrackAdmissions: selectedAdmissions.length ? Math.max(...selectedAdmissions) : 0,
          maximumActiveAdmissions: selection.maximumActiveAdmissions,
          maximumLocalTrackAdmissions: selection.maximumLocalTrackAdmissions,
          ...(selection.firstReadyOpportunity === undefined ? {} : { firstReadyOpportunity: selection.firstReadyOpportunity }),
          everAssociationModes: selection.everAssociationModes,
          finalAssociationModes: selection.finalAssociationModes,
          regularAssociationsObserved: selection.regularAssociationIds.length,
          agileAssociationsObserved: selection.agileAssociationIds.length,
          regularAssociationExpirations: selection.regularAssociationExpirations,
        });
        for (const representative of selection.representatives) {
          const detection = representative.detection;
          const evidenceSweeps = representative.evidenceSweeps;
          const expectedSweepIds = classificationSourceSweepIds(detection).slice(-CLASSIFICATION_ADMISSIONS);
          const classificationAdmissions = expectedSweepIds.length;
          if (classificationAdmissions !== CLASSIFICATION_ADMISSIONS) throw new Error(`${scenario.id} classifier admission window has ${classificationAdmissions} sweeps, expected exactly ${CLASSIFICATION_ADMISSIONS}`);

          // This is a fresh capture explicitly tuned when this production
          // representative first becomes ready. No later sweep is available
          // to either feature extraction or classification.
          const zeroSpanObservation = synthesizeCanonicalObservation(scenario.id, {
            lookIndex: representative.firstReadyOpportunity,
            seed,
            snrDb,
            actualRbwHz,
            points: SWEEP_POINTS,
            sweepTimeSeconds: SWEEP_TIME_SECONDS,
            zeroSpanPoints: ZERO_SPAN_POINTS,
            zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
            zeroSpanFrequencyHz: detection.peakHz,
          });
          const zeroSpan = asZeroSpan(zeroSpanObservation, detection);
          const featureObservation = extractObservableFeatures(detection, { sweeps: evidenceSweeps, zeroSpan });
          const componentFitEligible = observableRepresentativeIsEligibleForModelFit(
            mappedTruth,
            scenario.occupiedBandwidthHz,
            detection,
            featureObservation,
          );
          if (featureObservation.sweepIds.length !== CLASSIFICATION_ADMISSIONS) {
            throw new Error(`${scenario.id} extracted ${featureObservation.sweepIds.length} source sweeps, expected exactly ${CLASSIFICATION_ADMISSIONS}`);
          }
          if ([...featureObservation.sweepIds].sort().some((sweepId, index) => sweepId !== [...expectedSweepIds].sort()[index])) {
            throw new Error(`${scenario.id} classifier did not preserve its latest ${CLASSIFICATION_ADMISSIONS} positive source sweeps`);
          }
          const posterior = inferPosterior(featureObservation);
          const result = await classifier.classify(detection, { sweeps: evidenceSweeps, zeroSpan });
          const topLeaf = posterior[0]!;
          const posteriorRecord = Object.fromEntries(posterior.map((item) => [item.id, item.probability]));
          cases.push({
            attemptId,
            representativeKey: representative.representativeKey,
            scenario: scenario.id,
            corpusTruth: scenario.truthClass,
            modelTruth: mappedTruth,
            allowedModelTruths,
            nominalBandwidthHz: scenario.occupiedBandwidthHz,
            snrDb,
            rbwDivisor,
            actualRbwHz,
            binWidthHz: nominalBinWidthHz,
            seed,
            firstReadyOpportunity: representative.firstReadyOpportunity,
            componentFitEligible,
            result: result.label,
            confidence: result.confidence,
            unknownPosterior: posterior.find((item) => item.id === 'unknown-signal')?.probability ?? 0,
            truthPosterior: posterior.find((item) => item.id === mappedTruth)?.probability ?? 0,
            topLeaf: topLeaf.id,
            topLeafPosterior: topLeaf.probability,
            acceptedHierarchy: acceptsAnyTruth(result.label, allowedModelTruths, scenario.occupiedBandwidthHz, featureObservation.bandwidthHz),
            posterior: posteriorRecord,
            bandwidthHz: featureObservation.bandwidthHz,
            selectedTrackAdmissions: representative.classificationAdmissions,
            localTrackAdmissions: representative.localTrackAdmissions,
            associationMode: detection.associationMode ?? 'frequency-local',
            ...(detection.associationId === undefined ? {} : { associationId: detection.associationId }),
            ...(detection.associationModelId === undefined ? {} : { associationModelId: detection.associationModelId }),
            ...(detection.associationMemberTrackIds === undefined ? {} : { associationMemberCount: detection.associationMemberTrackIds.length }),
            ...(detection.associationRegionStartHz === undefined || detection.associationRegionStopHz === undefined
              ? {}
              : { associationRegionBandwidthHz: detection.associationRegionStopHz - detection.associationRegionStartHz }),
            knownSupportRank: knownModelSupportRank(featureObservation),
            limitations: result.evidence.limitations ?? [],
            features: featureObservation.values,
          });
          for (const [view, values] of [
            ['spectrum-only', spectrumOnly(featureObservation.values)],
            ['envelope-untimed', envelopeUntimed(featureObservation.values)],
          ] as const) {
            const viewObservation = { ...featureObservation, values };
            const viewPosterior = inferPosterior(viewObservation);
            const viewDecision = selectObservableDecision(viewPosterior, viewObservation);
            const viewResult = viewDecision.label === 'unknown' ? 'unknown' : `observable:${viewDecision.label}`;
            evidenceViewCases.push({
              attemptId,
              representativeKey: representative.representativeKey,
              view,
              scenario: scenario.id,
              corpusTruth: scenario.truthClass,
              modelTruth: mappedTruth,
              allowedModelTruths,
              componentFitEligible,
              nominalBandwidthHz: scenario.occupiedBandwidthHz,
              measuredBandwidthHz: featureObservation.bandwidthHz,
              result: viewResult,
              topLeaf: viewPosterior[0]!.id,
              topLeafPosterior: viewPosterior[0]!.probability,
              truthPosterior: viewPosterior.find((item) => item.id === mappedTruth)?.probability ?? 0,
              posterior: Object.fromEntries(viewPosterior.map((item) => [item.id, item.probability])),
              acceptedHierarchy: acceptsAnyTruth(viewResult, allowedModelTruths, scenario.occupiedBandwidthHz, featureObservation.bandwidthHz),
              supportRank: knownModelSupportRank(viewObservation),
              features: values,
            });
          }
        }
      }
    }
  }
}

const exactEquivalencePairAudit = auditExactEquivalencePairs(admissionAttempts, cases, evidenceViewCases);
const exactEquivalenceDiscrepancies = exactEquivalencePairAudit.flatMap((audit) => audit.discrepancies);
const exactEquivalenceDiscrepancyCount = exactEquivalencePairAudit.reduce((sum, audit) => sum + audit.discrepancyCount, 0);
const expectedAttempts = validationScenarios.length * SNR_DB.length * RBW_DIVISORS.length * NUISANCE_SHIFT_SEEDS.length;
const modelFittingSeeds = [...BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.seeds];
const modelCalibrationSeeds = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationSeeds ?? [])];
const modelFittingRbwDivisors = [...BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.rbwDivisors];
const modelCalibrationRbwDivisors = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRbwDivisors ?? [])];
const fittingCalibrationSeedOverlap = numericIntersection(modelFittingSeeds, modelCalibrationSeeds);
const validationFittingSeedOverlap = numericIntersection(NUISANCE_SHIFT_SEEDS, modelFittingSeeds);
const validationCalibrationSeedOverlap = numericIntersection(NUISANCE_SHIFT_SEEDS, modelCalibrationSeeds);
const validationFittingRbwOverlap = numericIntersection(RBW_DIVISORS, modelFittingRbwDivisors);
const validationCalibrationRbwOverlap = numericIntersection(RBW_DIVISORS, modelCalibrationRbwDivisors);
const modelTailCalibrationAttemptCounts = BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationAttemptCountsByScenario ?? {};
const expectedTailCalibrationScenarioIds = BAYESIAN_OBSERVABLE_MODEL.classModels
  .filter((model) => model.id !== 'unknown-signal')
  .flatMap((model) => model.components.map((component) => component.id))
  .sort();
const modelTailCalibrationScenarioIds = Object.keys(modelTailCalibrationAttemptCounts).sort();
const missingTailCalibrationScenarioIds = setDifference(expectedTailCalibrationScenarioIds, modelTailCalibrationScenarioIds);
const unexpectedTailCalibrationScenarioIds = setDifference(modelTailCalibrationScenarioIds, expectedTailCalibrationScenarioIds);
const invalidTailCalibrationAttemptCounts = Object.entries(modelTailCalibrationAttemptCounts)
  .filter(([, count]) => !Number.isInteger(count) || count < 40)
  .map(([scenarioId, count]) => ({ scenarioId, count }));
const tailCalibrationViewCountMismatches = BAYESIAN_OBSERVABLE_MODEL.classModels
  .filter((model) => model.id !== 'unknown-signal')
  .flatMap((model) => {
    const expected = model.components.reduce((sum, component) =>
      sum + (modelTailCalibrationAttemptCounts[component.id] ?? 0), 0);
    return (['spectrum-only', 'envelope-untimed', 'envelope-timed'] as const).flatMap((view) => {
      const observed = model.tailCalibrationScoresByView?.[view]?.length ?? 0;
      return observed === expected ? [] : [{ classId: model.id, view, expected, observed }];
    });
  });
const tailCalibrationPolicyValid = BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit
    === PINNED_TAIL_CALIBRATION_SCORE_UNIT
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy
    === PINNED_TAIL_CALIBRATION_AGGREGATION_POLICY
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy
    === PINNED_TAIL_CALIBRATION_RUNTIME_INTERPRETATION_POLICY
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation
    === PINNED_TAIL_CALIBRATION_STATISTICAL_INTERPRETATION
  && missingTailCalibrationScenarioIds.length === 0
  && unexpectedTailCalibrationScenarioIds.length === 0
  && invalidTailCalibrationAttemptCounts.length === 0
  && tailCalibrationViewCountMismatches.length === 0;
const samplingPartitionsDisjoint = modelCalibrationSeeds.length > 0
  && modelCalibrationRbwDivisors.length > 0
  && fittingCalibrationSeedOverlap.length === 0
  && validationFittingSeedOverlap.length === 0
  && validationCalibrationSeedOverlap.length === 0
  && validationFittingRbwOverlap.length === 0
  && validationCalibrationRbwOverlap.length === 0;
const admissionMisses = admissionAttempts.filter((item) => !item.admitted);
const known = cases.filter((item) => item.modelTruth !== 'unknown-signal');
const unknown = cases.filter((item) => item.modelTruth === 'unknown-signal');
const modelScenarioExcludedIdList = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.scenarioExcludedFromComponentFitIds ?? [])];
const modelExactEquivalenceIdList = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.exactObservableEquivalenceNullScenarioIds ?? [])];
const modelKnownAcquisitionValidationIdList = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.knownAcquisitionValidationOnlyScenarioIds ?? [])];
const scenarioExcludedIdList = [...PINNED_SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS];
const scenarioExcludedIds = new Set<string>(scenarioExcludedIdList);
const exactEquivalenceIdList = [...PINNED_EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS];
const exactEquivalenceIds = new Set<string>(exactEquivalenceIdList);
const knownAcquisitionValidationIdList = [...PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS];
const knownAcquisitionValidationIds = new Set<string>(knownAcquisitionValidationIdList);
const duplicateExcludedScenarioIds = duplicateStrings(modelScenarioExcludedIdList);
const duplicateExactEquivalenceScenarioIds = duplicateStrings(modelExactEquivalenceIdList);
const duplicateKnownAcquisitionValidationIds = duplicateStrings(modelKnownAcquisitionValidationIdList);
const modelExcludedMissingPinnedIds = setDifference(scenarioExcludedIdList, modelScenarioExcludedIdList);
const modelExcludedUnexpectedIds = setDifference(modelScenarioExcludedIdList, scenarioExcludedIdList);
const modelExactEquivalenceMissingPinnedIds = setDifference(exactEquivalenceIdList, modelExactEquivalenceIdList);
const modelExactEquivalenceUnexpectedIds = setDifference(modelExactEquivalenceIdList, exactEquivalenceIdList);
const modelKnownAcquisitionMissingPinnedIds = setDifference(knownAcquisitionValidationIdList, modelKnownAcquisitionValidationIdList);
const modelKnownAcquisitionUnexpectedIds = setDifference(modelKnownAcquisitionValidationIdList, knownAcquisitionValidationIdList);
const corpusScenarioById = new Map(canonicalClassificationScenarios.map((scenario) => [scenario.id, scenario]));
const invalidPinnedStrictUnknownHoldoutIds = PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS.filter((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  return scenario === undefined
    || modelTruth(scenario.truthClass) !== 'unknown-signal'
    || [...new Set(scenario.allowedObservableClasses.map(modelTruth))].join('|') !== 'unknown-signal';
});
const invalidPinnedAmbiguityStressIds = PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS.filter((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  const allowed = scenario ? [...new Set(scenario.allowedObservableClasses.map(modelTruth))] : [];
  return scenario === undefined
    || modelTruth(scenario.truthClass) !== 'unknown-signal'
    || !allowed.includes('unknown-signal')
    || !allowed.some((truth) => truth !== 'unknown-signal');
});
const invalidPinnedFittedUnknownIds = PINNED_FITTED_UNKNOWN_SCENARIO_IDS.filter((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  return scenario === undefined
    || modelTruth(scenario.truthClass) !== 'unknown-signal'
    || [...new Set(scenario.allowedObservableClasses.map(modelTruth))].join('|') !== 'unknown-signal';
});
const invalidPinnedExactEquivalencePairs = PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS.filter((pair) => {
  const nullScenario = corpusScenarioById.get(pair.nullScenarioId);
  const referenceScenario = corpusScenarioById.get(pair.referenceScenarioId);
  const allowedNullTruths = nullScenario ? [...new Set(nullScenario.allowedObservableClasses.map(modelTruth))] : [];
  return nullScenario === undefined
    || referenceScenario === undefined
    || modelTruth(nullScenario.truthClass) !== 'unknown-signal'
    || modelTruth(referenceScenario.truthClass) === 'unknown-signal'
    || !allowedNullTruths.includes('unknown-signal')
    || !allowedNullTruths.includes(modelTruth(referenceScenario.truthClass));
}).map((pair) => `${pair.referenceScenarioId}<=>${pair.nullScenarioId}`);
const excludedScenarioSplit = [...scenarioExcludedIds].sort().map((scenarioId) => ({
  scenarioId,
  existsInCorpus: corpusScenarioById.has(scenarioId),
  corpusTruth: corpusScenarioById.get(scenarioId)?.truthClass,
  modelTruth: corpusScenarioById.has(scenarioId) ? modelTruth(corpusScenarioById.get(scenarioId)!.truthClass) : undefined,
  category: knownAcquisitionValidationIds.has(scenarioId)
    ? 'known-acquisition-validation-only'
    : exactEquivalenceIds.has(scenarioId)
    ? 'exact-observable-equivalence-null'
    : (PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS as readonly string[]).includes(scenarioId)
      ? 'observable-ambiguity-stress'
      : 'strict-unknown-stress',
}));
const invalidExcludedScenarioIds = excludedScenarioSplit.filter((item) => !item.existsInCorpus).map((item) => item.scenarioId);
const nonUnknownExcludedScenarioIds = excludedScenarioSplit
  .filter((item) => item.existsInCorpus
    && item.modelTruth !== 'unknown-signal'
    && !knownAcquisitionValidationIds.has(item.scenarioId))
  .map((item) => item.scenarioId);
const excludedUnknownScenarioIds = excludedScenarioSplit.filter((item) => item.modelTruth === 'unknown-signal').map((item) => item.scenarioId);
const knownAcquisitionValidationSplit = [...knownAcquisitionValidationIds].sort().map((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  return {
    scenarioId,
    existsInCorpus: scenario !== undefined,
    modelTruth: scenario ? modelTruth(scenario.truthClass) : undefined,
    excludedFromComponentFit: scenarioExcludedIds.has(scenarioId),
  };
});
const invalidKnownAcquisitionValidationIds = knownAcquisitionValidationSplit
  .filter((item) => !item.existsInCorpus)
  .map((item) => item.scenarioId);
const unknownTruthKnownAcquisitionValidationIds = knownAcquisitionValidationSplit
  .filter((item) => item.modelTruth === 'unknown-signal')
  .map((item) => item.scenarioId);
const knownAcquisitionValidationNotExcludedIds = knownAcquisitionValidationSplit
  .filter((item) => !item.excludedFromComponentFit)
  .map((item) => item.scenarioId);
const exactEquivalenceSplit = [...exactEquivalenceIds].sort().map((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  const allowedModelTruths = scenario ? [...new Set(scenario.allowedObservableClasses.map(modelTruth))] : [];
  return {
    scenarioId,
    existsInCorpus: scenario !== undefined,
    corpusTruth: scenario?.truthClass,
    modelTruth: scenario ? modelTruth(scenario.truthClass) : undefined,
    allowedModelTruths,
    excludedFromComponentFit: scenarioExcludedIds.has(scenarioId),
  };
});
const invalidExactEquivalenceScenarioIds = exactEquivalenceSplit.filter((item) => !item.existsInCorpus).map((item) => item.scenarioId);
const nonUnknownExactEquivalenceScenarioIds = exactEquivalenceSplit
  .filter((item) => item.existsInCorpus && item.modelTruth !== 'unknown-signal')
  .map((item) => item.scenarioId);
const exactEquivalenceNotExcludedScenarioIds = exactEquivalenceSplit
  .filter((item) => !item.excludedFromComponentFit)
  .map((item) => item.scenarioId);
const exactEquivalenceWithoutDeclaredAlternativeIds = exactEquivalenceSplit
  .filter((item) => !item.allowedModelTruths.includes('unknown-signal')
    || !item.allowedModelTruths.some((truth) => truth !== 'unknown-signal'))
  .map((item) => item.scenarioId);
const fittedComponentIds = new Set(BAYESIAN_OBSERVABLE_MODEL.classModels.flatMap((model) => model.components.map((component) => component.id)));
const fittedUnknownModel = BAYESIAN_OBSERVABLE_MODEL.classModels.find((model) => model.id === 'unknown-signal');
const modelFittedUnknownScenarioIds = (fittedUnknownModel?.components.map((component) => component.id) ?? []).sort();
const fittedUnknownMissingPinnedIds = setDifference(PINNED_FITTED_UNKNOWN_SCENARIO_IDS, modelFittedUnknownScenarioIds);
const fittedUnknownUnexpectedIds = setDifference(modelFittedUnknownScenarioIds, PINNED_FITTED_UNKNOWN_SCENARIO_IDS);
const exactEquivalenceFittedComponentIds = [...exactEquivalenceIds].filter((scenarioId) => fittedComponentIds.has(scenarioId)).sort();
const knownAcquisitionValidationFittedComponentIds = [...knownAcquisitionValidationIds]
  .filter((scenarioId) => fittedComponentIds.has(scenarioId))
  .sort();
const expectedComponentAssignments = canonicalClassificationScenarios
  .filter((scenario) => !scenarioExcludedIds.has(scenario.id))
  .map((scenario) => ({ scenarioId: scenario.id, classId: modelTruth(scenario.truthClass) }))
  .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
const expectedComponentClassByScenario = new Map(expectedComponentAssignments
  .map((assignment) => [assignment.scenarioId, assignment.classId] as const));
const actualComponentAssignments = BAYESIAN_OBSERVABLE_MODEL.classModels
  .flatMap((model) => model.components.map((component) => ({ scenarioId: component.id, classId: model.id })))
  .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
const actualComponentScenarioIds = actualComponentAssignments.map((assignment) => assignment.scenarioId);
const expectedComponentScenarioIds = expectedComponentAssignments.map((assignment) => assignment.scenarioId);
const duplicateFittedComponentScenarioIds = duplicateStrings(actualComponentScenarioIds);
const missingFittedComponentScenarioIds = setDifference(expectedComponentScenarioIds, actualComponentScenarioIds);
const unexpectedFittedComponentScenarioIds = setDifference(actualComponentScenarioIds, expectedComponentScenarioIds);
const wrongClassFittedComponents = actualComponentAssignments
  .filter((assignment) => expectedComponentClassByScenario.has(assignment.scenarioId)
    && expectedComponentClassByScenario.get(assignment.scenarioId) !== assignment.classId)
  .map((assignment) => ({
    ...assignment,
    expectedClassId: expectedComponentClassByScenario.get(assignment.scenarioId)!,
  }));
const duplicateModelClassIds = duplicateStrings(BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id));
const missingModelClassIds = setDifference(OBSERVABLE_LEAF_CLASSES, BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id));
const unexpectedModelClassIds = setDifference(BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id), OBSERVABLE_LEAF_CLASSES);
const ambiguousUnknownIncludedInComponentFitIds = canonicalClassificationScenarios
  .filter((scenario) => modelTruth(scenario.truthClass) === 'unknown-signal'
    && scenario.allowedObservableClasses.some((truth) => modelTruth(truth) !== 'unknown-signal')
    && !scenarioExcludedIds.has(scenario.id))
  .map((scenario) => scenario.id)
  .sort();
const fittedUnknownScenarioIds = canonicalClassificationScenarios
  .filter((scenario) => modelTruth(scenario.truthClass) === 'unknown-signal' && !scenarioExcludedIds.has(scenario.id))
  .map((scenario) => scenario.id)
  .sort();
const corpusFittedUnknownMissingPinnedIds = setDifference(PINNED_FITTED_UNKNOWN_SCENARIO_IDS, fittedUnknownScenarioIds);
const corpusFittedUnknownUnexpectedIds = setDifference(fittedUnknownScenarioIds, PINNED_FITTED_UNKNOWN_SCENARIO_IDS);
const manifestSplitValid = invalidExcludedScenarioIds.length === 0
  && nonUnknownExcludedScenarioIds.length === 0
  && duplicateExcludedScenarioIds.length === 0
  && modelExcludedMissingPinnedIds.length === 0
  && modelExcludedUnexpectedIds.length === 0
  && invalidPinnedStrictUnknownHoldoutIds.length === 0
  && invalidPinnedAmbiguityStressIds.length === 0
  && invalidPinnedFittedUnknownIds.length === 0
  && invalidPinnedExactEquivalencePairs.length === 0
  && knownAcquisitionValidationIds.size > 0
  && duplicateKnownAcquisitionValidationIds.length === 0
  && modelKnownAcquisitionMissingPinnedIds.length === 0
  && modelKnownAcquisitionUnexpectedIds.length === 0
  && invalidKnownAcquisitionValidationIds.length === 0
  && unknownTruthKnownAcquisitionValidationIds.length === 0
  && knownAcquisitionValidationNotExcludedIds.length === 0
  && knownAcquisitionValidationFittedComponentIds.length === 0
  && duplicateFittedComponentScenarioIds.length === 0
  && missingFittedComponentScenarioIds.length === 0
  && unexpectedFittedComponentScenarioIds.length === 0
  && wrongClassFittedComponents.length === 0
  && duplicateModelClassIds.length === 0
  && missingModelClassIds.length === 0
  && unexpectedModelClassIds.length === 0
  && exactEquivalenceIds.size > 0
  && duplicateExactEquivalenceScenarioIds.length === 0
  && modelExactEquivalenceMissingPinnedIds.length === 0
  && modelExactEquivalenceUnexpectedIds.length === 0
  && invalidExactEquivalenceScenarioIds.length === 0
  && nonUnknownExactEquivalenceScenarioIds.length === 0
  && exactEquivalenceNotExcludedScenarioIds.length === 0
  && exactEquivalenceWithoutDeclaredAlternativeIds.length === 0
  && exactEquivalenceFittedComponentIds.length === 0
  && ambiguousUnknownIncludedInComponentFitIds.length === 0
  && excludedUnknownScenarioIds.length > 0
  && fittedUnknownScenarioIds.length > 0
  && fittedUnknownMissingPinnedIds.length === 0
  && fittedUnknownUnexpectedIds.length === 0
  && corpusFittedUnknownMissingPinnedIds.length === 0
  && corpusFittedUnknownUnexpectedIds.length === 0;
const scenarioExcludedUnknown = unknown.filter((item) => scenarioExcludedIds.has(item.scenario));
const strictUnknownHoldoutIds = new Set<string>(PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS);
const ambiguityStressIds = new Set<string>(PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS);
const scenarioExcludedStrictUnknown = scenarioExcludedUnknown.filter((item) => strictUnknownHoldoutIds.has(item.scenario));
const scenarioExcludedExactEquivalence = scenarioExcludedUnknown.filter((item) => exactEquivalenceIds.has(item.scenario));
const scenarioExcludedNonExactAmbiguous = scenarioExcludedUnknown.filter((item) => ambiguityStressIds.has(item.scenario));
const fittedTemplateCases = cases.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
const identifiableFitEligibleKnown = known.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
const fittedUnknownTemplates = unknown.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
const knownCovered = identifiableFitEligibleKnown.filter((item) => item.result !== 'unknown');
const labels = [...OBSERVABLE_LEAF_CLASSES];
// A one-hot target is a proper score only where the corpus declares one
// allowed observable truth. Ambiguous/equivalent cases remain decision- and
// set-compatibility tests, never secretly scored against one privileged label.
const singletonAllowedTruthFittedTemplateCases = fittedTemplateCases.filter((item) => item.allowedModelTruths.length === 1);
const singletonAllowedTruthCases = cases.filter((item) => item.allowedModelTruths.length === 1);
const fittedTemplateBrier = mean(singletonAllowedTruthFittedTemplateCases.map((item) => labels.reduce((sum, label) => {
  const probability = item.posterior[label] ?? 0;
  const target = label === item.modelTruth ? 1 : 0;
  return sum + (probability - target) ** 2;
}, 0)));
const fittedTemplateLogLoss = -mean(singletonAllowedTruthFittedTemplateCases.map((item) => Math.log(Math.max(1e-15, item.truthPosterior))));
const fittedTemplateEce = expectedCalibrationError(singletonAllowedTruthFittedTemplateCases.map((item) => ({ confidence: item.topLeafPosterior, correct: item.topLeaf === item.modelTruth })), 10);
const allSingletonAllowedTruthLogLossDiagnostic = -mean(singletonAllowedTruthCases.map((item) => Math.log(Math.max(1e-15, item.truthPosterior))));
const fittedUnknownPosteriorAuroc = auroc([
  ...fittedUnknownTemplates.map((item) => ({ score: item.unknownPosterior, positive: true })),
  ...identifiableFitEligibleKnown.map((item) => ({ score: item.unknownPosterior, positive: false })),
]);
const scenarioExcludedStrictTypicalityAuroc = auroc([
  ...scenarioExcludedStrictUnknown.map((item) => ({ score: 1 - item.knownSupportRank, positive: true })),
  ...identifiableFitEligibleKnown.map((item) => ({ score: 1 - item.knownSupportRank, positive: false })),
]);
const exactEquivalenceCompatibleRate = fraction(scenarioExcludedExactEquivalence, (item) => item.acceptedHierarchy);
const strictHoldoutRejectionRate = fraction(scenarioExcludedStrictUnknown, (item) => item.result === 'unknown');
const confusion = Object.fromEntries(canonicalClassificationScenarios.map((scenario) => [
  scenario.id,
  counts(cases.filter((item) => item.scenario === scenario.id).map((item) => item.result)),
]));
const classwiseKnown = Object.fromEntries(OBSERVABLE_LEAF_CLASSES.filter((truth) => truth !== 'unknown-signal').map((truth) => {
  const selected = identifiableFitEligibleKnown.filter((item) => item.modelTruth === truth);
  return [truth, {
    samples: selected.length,
    topLeafAccuracy: fraction(selected, (item) => item.topLeaf === item.modelTruth),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    coverage: fraction(selected, (item) => item.result !== 'unknown'),
  }];
}));
const minimumKnownClassHierarchicalAccuracy = Math.min(...Object.values(classwiseKnown).map((value) => value.hierarchicalAccuracy));
// A per-class sensitivity floor is meaningful only in the SNR region where
// acquisition itself is required to be reliable. Lower-SNR rows remain in the
// all-SNR diagnostics and global proper scores, but an honest open-set model is
// allowed to abstain there instead of being forced to label an atypical trace.
const classwiseKnownHighSnr = Object.fromEntries(OBSERVABLE_LEAF_CLASSES.filter((truth) => truth !== 'unknown-signal').map((truth) => {
  const selected = identifiableFitEligibleKnown.filter((item) => item.modelTruth === truth && item.snrDb >= HIGH_SNR_MINIMUM_DB);
  return [truth, {
    samples: selected.length,
    topLeafAccuracy: fraction(selected, (item) => item.topLeaf === item.modelTruth),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    coverage: fraction(selected, (item) => item.result !== 'unknown'),
  }];
}));
const minimumHighSnrKnownClassHierarchicalAccuracy = Math.min(
  ...Object.values(classwiseKnownHighSnr).map((value) => value.hierarchicalAccuracy),
);
const admissionByScenario = Object.fromEntries(canonicalClassificationScenarios.map((scenario) => {
  const selected = admissionAttempts.filter((item) => item.scenario === scenario.id);
  return [scenario.id, {
    corpusTruth: scenario.truthClass,
    modelTruth: modelTruth(scenario.truthClass),
    allowedModelTruths: [...new Set(scenario.allowedObservableClasses.map(modelTruth))],
    allSnr: admissionSummary(selected),
    highSnr: admissionSummary(selected.filter((item) => item.snrDb >= HIGH_SNR_MINIMUM_DB)),
  }];
}));
const bySnr = Object.fromEntries(SNR_DB.map((snrDb) => {
  const selected = cases.filter((item) => item.snrDb === snrDb);
  return [snrDb, {
    attempts: admissionSummary(admissionAttempts.filter((item) => item.snrDb === snrDb)),
    firstReadyRepresentativeSamples: selected.length,
    topLeafAccuracy: fraction(selected, (item) => item.topLeaf === item.modelTruth),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    knownCoverage: fraction(selected.filter((item) => item.modelTruth !== 'unknown-signal'), (item) => item.result !== 'unknown'),
    unknownRejection: fraction(selected.filter((item) => item.modelTruth === 'unknown-signal'), (item) => item.result === 'unknown'),
  }];
}));
const byRbwDivisor = Object.fromEntries(RBW_DIVISORS.map((rbwDivisor) => {
  const selectedAttempts = admissionAttempts.filter((item) => item.rbwDivisor === rbwDivisor);
  const selectedCases = cases.filter((item) => item.rbwDivisor === rbwDivisor);
  return [rbwDivisor, {
    attempts: admissionSummary(selectedAttempts),
    firstReadyRepresentativeSamples: selectedCases.length,
    actualRbwHz: numericSummary(selectedAttempts.map((item) => item.actualRbwHz)),
    binWidthHz: numericSummary(selectedAttempts.map((item) => item.binWidthHz)),
    rbwToBinWidthRatio: numericSummary(selectedAttempts.map((item) => item.actualRbwHz / item.binWidthHz)),
    hierarchicalAccuracy: fraction(selectedCases, (item) => item.acceptedHierarchy),
    unknownRejection: fraction(selectedCases.filter((item) => item.modelTruth === 'unknown-signal'), (item) => item.result === 'unknown'),
  }];
}));
const evidenceViews = Object.fromEntries((['spectrum-only', 'envelope-untimed'] as const).map((view) => {
  const selected = evidenceViewCases.filter((item) => item.view === view);
  const selectedKnown = selected.filter((item) => item.modelTruth !== 'unknown-signal'
    && !scenarioExcludedIds.has(item.scenario)
    && item.componentFitEligible);
  const selectedFittedUnknown = selected.filter((item) => item.modelTruth === 'unknown-signal'
    && !scenarioExcludedIds.has(item.scenario)
    && item.componentFitEligible);
  const selectedScenarioExcluded = selected.filter((item) => scenarioExcludedIds.has(item.scenario));
  const selectedScenarioExcludedStrict = selectedScenarioExcluded.filter((item) => strictUnknownHoldoutIds.has(item.scenario));
  const selectedExactEquivalence = selectedScenarioExcluded.filter((item) => exactEquivalenceIds.has(item.scenario));
  const selectedFittedDomain = selected.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
  const selectedSingletonTruthFittedDomain = selectedFittedDomain.filter((item) => item.allowedModelTruths.length === 1);
  const falseAcceptedUnknown = selected.filter((item) => item.modelTruth === 'unknown-signal' && !item.acceptedHierarchy);
  const falseAcceptedAttemptIds = [...new Set(falseAcceptedUnknown.map((item) => item.attemptId))].sort();
  return [view, {
    admittedSamples: selected.length,
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    knownCoverage: fraction(selectedKnown, (item) => item.result !== 'unknown'),
    coveredKnownHierarchicalAccuracy: fraction(selectedKnown.filter((item) => item.result !== 'unknown'), (item) => item.acceptedHierarchy),
    fittedUnknownTemplateRejectionRate: fraction(selectedFittedUnknown, (item) => item.result === 'unknown'),
    validationOnlyUnknownDecisionRate: fraction(selectedScenarioExcluded, (item) => item.result === 'unknown'),
    exactEquivalenceSamples: selectedExactEquivalence.length,
    exactEquivalenceCompatibleRate: fraction(selectedExactEquivalence, (item) => item.acceptedHierarchy),
    strictHoldoutSamples: selectedScenarioExcludedStrict.length,
    strictHoldoutRejectionRate: fraction(selectedScenarioExcludedStrict, (item) => item.result === 'unknown'),
    falseAcceptedUnknownCount: falseAcceptedUnknown.length,
    anyFalseAcceptAttemptCount: falseAcceptedAttemptIds.length,
    anyFalseAcceptAttemptIds: falseAcceptedAttemptIds.slice(0, 50),
    falseAcceptedUnknownExamples: falseAcceptedUnknown.slice(0, 20),
    scenarioExcludedStrictSupportAuroc: auroc([
      ...selectedScenarioExcludedStrict.map((item) => ({ score: 1 - item.supportRank, positive: true })),
      ...selectedKnown.map((item) => ({ score: 1 - item.supportRank, positive: false })),
    ]),
    singletonAllowedTruthProperScoreSamples: selectedSingletonTruthFittedDomain.length,
    fittedTemplateLogLoss: -mean(selectedSingletonTruthFittedDomain.map((item) => Math.log(Math.max(1e-15, item.truthPosterior)))),
    fittedTemplateMulticlassBrier: mean(selectedSingletonTruthFittedDomain.map((item) => labels.reduce((sum, label) => {
      const probability = item.posterior[label] ?? 0;
      const target = label === item.modelTruth ? 1 : 0;
      return sum + (probability - target) ** 2;
    }, 0))),
    fittedTemplateExpectedCalibrationError: expectedCalibrationError(selectedSingletonTruthFittedDomain.map((item) => ({ confidence: item.topLeafPosterior, correct: item.topLeaf === item.modelTruth })), 10),
    knownSupport: numericSummary(selectedKnown.map((item) => item.supportRank)),
    scenarioExcludedStrictSupport: numericSummary(selectedScenarioExcludedStrict.map((item) => item.supportRank)),
  }];
}));
const falseAcceptedUnknown = unknown.filter((item) => !item.acceptedHierarchy);
const falseAcceptedUnknownAttemptIds = [...new Set(falseAcceptedUnknown.map((item) => item.attemptId))].sort();
const everReadyAttempts = admissionAttempts.filter((item) => item.everReady);
const firstReadyAttempts = admissionAttempts.filter((item) => item.admitted);
const expectedFirstReadyRepresentativeSamples = admissionAttempts.reduce((sum, item) => sum + item.everReadyRepresentativeCount, 0);
const uniqueFirstReadyRepresentativeSamples = new Set(cases.map((item) => `${item.attemptId}|${item.representativeKey}`)).size;
const associationModes = [
  'frequency-local',
  'frequency-agile-2g4-activity',
  'regular-spectral-component-activity',
] as const;
const associationByMode = Object.fromEntries(associationModes.map((associationMode) => {
  const selected = cases.filter((item) => item.associationMode === associationMode);
  const selectedUnknown = selected.filter((item) => item.modelTruth === 'unknown-signal');
  return [associationMode, {
    firstReadyRepresentativeSamples: selected.length,
    scenarios: [...new Set(selected.map((item) => item.scenario))].sort(),
    results: counts(selected.map((item) => item.result)),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    unknownRejection: fraction(selectedUnknown, (item) => item.result === 'unknown'),
    falseAcceptedUnknownCount: selectedUnknown.filter((item) => !item.acceptedHierarchy).length,
    effectiveAdmissions: numericSummary(selected.map((item) => item.selectedTrackAdmissions)),
    localTrackAdmissions: numericSummary(selected.map((item) => item.localTrackAdmissions)),
    memberCount: numericSummary(selected.flatMap((item) => item.associationMemberCount === undefined ? [] : [item.associationMemberCount])),
    regionBandwidthHz: numericSummary(selected.flatMap((item) => item.associationRegionBandwidthHz === undefined ? [] : [item.associationRegionBandwidthHz])),
  }];
}));
const associationByScenario = Object.fromEntries(canonicalClassificationScenarios.map((scenario) => {
  const selectedAttempts = admissionAttempts.filter((item) => item.scenario === scenario.id);
  const selectedCases = cases.filter((item) => item.scenario === scenario.id);
  return [scenario.id, {
    firstReadyRepresentativeSamples: selectedCases.length,
    firstReadyModes: counts(selectedCases.map((item) => item.associationMode)),
    results: counts(selectedCases.map((item) => item.result)),
    attemptsEverRegularAssociation: selectedAttempts.filter((item) => item.everAssociationModes.includes('regular-spectral-component-activity')).length,
    attemptsFinalRegularAssociation: selectedAttempts.filter((item) => item.finalAssociationModes.includes('regular-spectral-component-activity')).length,
    attemptsEverAgileAssociation: selectedAttempts.filter((item) => item.everAssociationModes.includes('frequency-agile-2g4-activity')).length,
    attemptsFinalAgileAssociation: selectedAttempts.filter((item) => item.finalAssociationModes.includes('frequency-agile-2g4-activity')).length,
    regularAssociationsObserved: selectedAttempts.reduce((sum, item) => sum + item.regularAssociationsObserved, 0),
    agileAssociationsObserved: selectedAttempts.reduce((sum, item) => sum + item.agileAssociationsObserved, 0),
    regularAssociationExpirations: selectedAttempts.reduce((sum, item) => sum + item.regularAssociationExpirations, 0),
  }];
}));
const limitationCounts = counts(cases.flatMap((item) => item.limitations));
const scenariosWithoutHighSnrAdmission = Object.entries(admissionByScenario)
  .filter(([, value]) => value.highSnr.admitted === 0)
  .map(([scenario]) => scenario);
const expectedClassificationNonAdmissionIds = new Set<string>(PINNED_EXPECTED_CLASSIFICATION_NON_ADMISSION_SCENARIO_IDS);
const expectedNonAdmissionScenariosWithAdmission = [...expectedClassificationNonAdmissionIds]
  .filter((scenario) => (admissionByScenario[scenario]?.allSnr.admitted ?? 0) > 0)
  .sort();
const knownAcquisitionWrongAdmissions = cases
  .filter((item) => knownAcquisitionValidationIds.has(item.scenario) && !item.acceptedHierarchy);
const ordinaryKnownScenarioIds = canonicalClassificationScenarios
  .filter((scenario) => modelTruth(scenario.truthClass) !== 'unknown-signal'
    && !knownAcquisitionValidationIds.has(scenario.id))
  .map((scenario) => scenario.id);
const admissionSeedCoverageByKnownScenario = Object.fromEntries(ordinaryKnownScenarioIds.map((scenarioId) => {
  const minimumCoverage = scenarioId === 'bluetooth-le-advertising' ? BLE_ADVERTISING_MINIMUM_SEED_COVERAGE : 1;
  const requiredSeeds = Math.ceil(NUISANCE_SHIFT_SEEDS.length * minimumCoverage);
  const bySnr = Object.fromEntries(ADMISSION_SEED_COVERAGE_SNR_DB.map((snrDb) => {
    const coveredSeeds = NUISANCE_SHIFT_SEEDS.filter((seed) => admissionAttempts.some((item) =>
      item.scenario === scenarioId && item.snrDb === snrDb && item.seed === seed && item.admitted));
    const uncoveredSeeds = NUISANCE_SHIFT_SEEDS.filter((seed) => !coveredSeeds.includes(seed));
    return [snrDb, {
      coveredSeeds,
      uncoveredSeeds,
      uniqueSeedsCovered: coveredSeeds.length,
      totalSeeds: NUISANCE_SHIFT_SEEDS.length,
      coverage: coveredSeeds.length / NUISANCE_SHIFT_SEEDS.length,
      requiredSeeds,
      passed: coveredSeeds.length >= requiredSeeds,
      admittingRbwDivisorsBySeed: Object.fromEntries(coveredSeeds.map((seed) => [seed, admissionAttempts
        .filter((item) => item.scenario === scenarioId && item.snrDb === snrDb && item.seed === seed && item.admitted)
        .map((item) => item.rbwDivisor)
        .sort((left, right) => left - right)])),
    }];
  }));
  return [scenarioId, { minimumCoverage, requiredSeeds, bySnr }];
}));
const knownAdmissionSeedCoverageFailures = Object.entries(admissionSeedCoverageByKnownScenario).flatMap(([scenarioId, audit]) =>
  Object.entries(audit.bySnr)
    .filter(([, cell]) => !cell.passed)
    .map(([snrDb, cell]) => ({ scenarioId, snrDb: Number(snrDb), ...cell })));

const report = {
  qualification: 'production-detector-conditioned-mixed-nuisance-shift-and-scenario-excluded-synthetic-only',
  interpretation: 'This is development-regression evidence from re-simulated SignalLab scalar formulas. It uses the production detector and tracker and classifies each production representative exactly once, at the first opportunity where that representative has eight admitted effective sweeps. Evidence is restricted to the prefix ending at that opportunity; no endpoint, future-look, or retrospective best-track selection is used. Acquisition runs for 24 opportunities under standard geometry and 96 only when the swept geometry covers the complete 2402-2480 MHz activity band. Each first-ready representative receives a separately synthesized zero-span capture tuned at its then-current peak. Local fragments that later participate in an activity association remain separate production-validation cases. The fitted formulas, SNR grid, and acquisition geometry overlap development, so this is not untouched validation, physical receiver calibration, waveform conformance, emitter identity, or protocol validation.',
  selectionPolicy: SELECTION_POLICY,
  model: BAYESIAN_WAVEFORM_MODEL,
  integrity: {
    checkedOutCorpusSha256,
    checkedInModelAssetSha256,
    modelAssetManifestSha256: BAYESIAN_OBSERVABLE_MODEL_SHA256,
  },
  corpus: {
    version: CLASSIFICATION_CORPUS_VERSION,
    scenarios: canonicalClassificationScenarios.length,
    scenarioExcludedFromComponentFit: scenarioExcludedIds.size,
    manifestSplit: {
      valid: manifestSplitValid,
      validatorOwnedPins: {
        fittedUnknown: PINNED_FITTED_UNKNOWN_SCENARIO_IDS,
        strictUnknownHoldout: PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS,
        observableAmbiguityStress: PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS,
        exactObservableEquivalencePairs: PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS,
        knownAcquisitionValidationOnly: PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS,
        excludedFromComponentFit: PINNED_SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS,
      },
      modelDeclared: {
        fittedUnknown: modelFittedUnknownScenarioIds,
        exactObservableEquivalenceNulls: modelExactEquivalenceIdList,
        knownAcquisitionValidationOnly: modelKnownAcquisitionValidationIdList,
        excludedFromComponentFit: modelScenarioExcludedIdList,
        componentAssignments: actualComponentAssignments,
      },
      expectedComponentAssignments,
      excludedScenarios: excludedScenarioSplit,
      exactObservableEquivalenceNulls: exactEquivalenceSplit,
      knownAcquisitionValidationOnly: knownAcquisitionValidationSplit,
      invalidExcludedScenarioIds,
      nonUnknownExcludedScenarioIds,
      duplicateExcludedScenarioIds,
      duplicateExactEquivalenceScenarioIds,
      duplicateKnownAcquisitionValidationIds,
      modelExcludedMissingPinnedIds,
      modelExcludedUnexpectedIds,
      modelExactEquivalenceMissingPinnedIds,
      modelExactEquivalenceUnexpectedIds,
      modelKnownAcquisitionMissingPinnedIds,
      modelKnownAcquisitionUnexpectedIds,
      invalidPinnedStrictUnknownHoldoutIds,
      invalidPinnedAmbiguityStressIds,
      invalidPinnedFittedUnknownIds,
      invalidPinnedExactEquivalencePairs,
      fittedUnknownMissingPinnedIds,
      fittedUnknownUnexpectedIds,
      corpusFittedUnknownMissingPinnedIds,
      corpusFittedUnknownUnexpectedIds,
      invalidKnownAcquisitionValidationIds,
      unknownTruthKnownAcquisitionValidationIds,
      knownAcquisitionValidationNotExcludedIds,
      knownAcquisitionValidationFittedComponentIds,
      duplicateFittedComponentScenarioIds,
      missingFittedComponentScenarioIds,
      unexpectedFittedComponentScenarioIds,
      wrongClassFittedComponents,
      duplicateModelClassIds,
      missingModelClassIds,
      unexpectedModelClassIds,
      invalidExactEquivalenceScenarioIds,
      nonUnknownExactEquivalenceScenarioIds,
      exactEquivalenceNotExcludedScenarioIds,
      exactEquivalenceWithoutDeclaredAlternativeIds,
      exactEquivalenceFittedComponentIds,
      ambiguousUnknownIncludedInComponentFitIds,
      excludedUnknownScenarioIds,
      fittedUnknownScenarioIds,
    },
    exactObservableEquivalencePairAudit: {
      numericalTolerance: EXACT_EQUIVALENCE_NUMERICAL_TOLERANCE,
      pairs: exactEquivalencePairAudit,
      discrepancyCount: exactEquivalenceDiscrepancyCount,
      discrepancies: exactEquivalenceDiscrepancies.slice(0, 100),
    },
  },
  matrix: {
    scenarioSelection: diagnosticScenarioIdSet.size === 0
      ? { mode: 'full-corpus', scenarioIds: validationScenarios.map((scenario) => scenario.id) }
      : { mode: 'diagnostic-subset', scenarioIds: validationScenarios.map((scenario) => scenario.id) },
    nuisanceShiftSeeds: NUISANCE_SHIFT_SEEDS,
    snrDb: SNR_DB,
    rbwDivisors: RBW_DIVISORS,
    observationOpportunityHorizons: {
      standard: STANDARD_OBSERVATION_OPPORTUNITIES,
      fullBand2g4: FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES,
    },
    attemptsByObservationHorizon: counts(admissionAttempts.map((item) => String(item.observationHorizon))),
    classificationAdmissions: CLASSIFICATION_ADMISSIONS,
    sweepPoints: SWEEP_POINTS,
    sweepTimeSeconds: SWEEP_TIME_SECONDS,
    zeroSpanPoints: ZERO_SPAN_POINTS,
    zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
    detectionConfig: PRODUCTION_DETECTION_CONFIG,
    selectionPolicy: SELECTION_POLICY,
    representativeEligibilityPolicy: 'runtime-domain-qualified-known-representatives-v3',
    samplingPartitionAudit: {
      valid: samplingPartitionsDisjoint,
      modelFittingSeeds,
      modelCalibrationSeeds,
      validationSeeds: NUISANCE_SHIFT_SEEDS,
      modelFittingRbwDivisors,
      modelCalibrationRbwDivisors,
      validationRbwDivisors: RBW_DIVISORS,
      fittingCalibrationSeedOverlap,
      validationFittingSeedOverlap,
      validationCalibrationSeedOverlap,
      validationFittingRbwOverlap,
      validationCalibrationRbwOverlap,
    },
    tailCalibrationAudit: {
      valid: tailCalibrationPolicyValid,
      pinnedScoreUnit: PINNED_TAIL_CALIBRATION_SCORE_UNIT,
      modelScoreUnit: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit,
      pinnedRepresentativeAggregationPolicy: PINNED_TAIL_CALIBRATION_AGGREGATION_POLICY,
      modelRepresentativeAggregationPolicy: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy,
      pinnedRuntimeInterpretationPolicy: PINNED_TAIL_CALIBRATION_RUNTIME_INTERPRETATION_POLICY,
      modelRuntimeInterpretationPolicy: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy,
      pinnedStatisticalInterpretation: PINNED_TAIL_CALIBRATION_STATISTICAL_INTERPRETATION,
      modelStatisticalInterpretation: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation,
      attemptCountsByScenario: modelTailCalibrationAttemptCounts,
      missingScenarioIds: missingTailCalibrationScenarioIds,
      unexpectedScenarioIds: unexpectedTailCalibrationScenarioIds,
      invalidAttemptCounts: invalidTailCalibrationAttemptCounts,
      viewCountMismatches: tailCalibrationViewCountMismatches,
    },
  },
  admission: {
    attempted: admissionAttempts.length,
    everReady: everReadyAttempts.length,
    firstReady: firstReadyAttempts.length,
    admitted: firstReadyAttempts.length,
    firstReadyRepresentativeSamples: cases.length,
    expectedFirstReadyRepresentativeSamples,
    uniqueFirstReadyRepresentativeSamples,
    misses: admissionMisses.length,
    everReadyRate: fraction(admissionAttempts, (item) => item.everReady),
    firstReadyRate: fraction(admissionAttempts, (item) => item.admitted),
    admissionRate: fraction(admissionAttempts, (item) => item.admitted),
    missExamples: admissionMisses.slice(0, 50),
    highSnrMinimumDb: HIGH_SNR_MINIMUM_DB,
    highSnr: admissionSummary(admissionAttempts.filter((item) => item.snrDb >= HIGH_SNR_MINIMUM_DB)),
    scenariosWithoutHighSnrAdmission,
    expectedClassificationNonAdmissionScenarios: [...expectedClassificationNonAdmissionIds].sort(),
    expectedNonAdmissionScenariosWithAdmission,
    knownAcquisitionWrongAdmissionCount: knownAcquisitionWrongAdmissions.length,
    knownAcquisitionWrongAdmissionExamples: knownAcquisitionWrongAdmissions.slice(0, 50)
      .map(({ posterior: _posterior, features: _features, ...item }) => item),
    highSnrUniqueSeedCoverage: {
      snrDb: ADMISSION_SEED_COVERAGE_SNR_DB,
      validationSeeds: NUISANCE_SHIFT_SEEDS,
      ordinaryKnownRequiredCoverage: 1,
      bluetoothLeAdvertisingRequiredCoverage: BLE_ADVERTISING_MINIMUM_SEED_COVERAGE,
      byKnownScenario: admissionSeedCoverageByKnownScenario,
      failures: knownAdmissionSeedCoverageFailures,
    },
    byScenario: admissionByScenario,
    byRbwDivisor,
  },
  classificationConditionalOnAdmission: {
    samples: cases.length,
    identifiableFitEligibleSamples: fittedTemplateCases.length,
    singletonAllowedTruthProperScoreSamples: singletonAllowedTruthFittedTemplateCases.length,
    properScoreQualification: 'one-hot log loss, multiclass Brier score, and ECE include only fit-domain cases with exactly one declared allowed observable truth',
    identifiableFitEligibleKnownSamples: identifiableFitEligibleKnown.length,
    validationOnlyExcludedSamples: scenarioExcludedUnknown.length,
    componentFitEligibleSamples: cases.filter((item) => item.componentFitEligible).length,
    componentFitIneligibleSamples: cases.filter((item) => !item.componentFitEligible).length,
    componentFitIneligibleByScenario: counts(cases.filter((item) => !item.componentFitEligible).map((item) => item.scenario)),
    componentFitIneligibleByAssociationMode: counts(cases.filter((item) => !item.componentFitEligible).map((item) => item.associationMode)),
    hierarchicalAccuracy: fraction(cases, (item) => item.acceptedHierarchy),
    fittedTemplateTopLeafAccuracy: fraction(fittedTemplateCases, (item) => item.topLeaf === item.modelTruth),
    knownTopLeafAccuracy: fraction(identifiableFitEligibleKnown, (item) => item.topLeaf === item.modelTruth),
    knownCoverage: fraction(identifiableFitEligibleKnown, (item) => item.result !== 'unknown'),
    coveredKnownHierarchicalAccuracy: fraction(knownCovered, (item) => item.acceptedHierarchy),
    minimumKnownClassHierarchicalAccuracy,
    classwiseKnown,
    highSnrMinimumDb: HIGH_SNR_MINIMUM_DB,
    minimumHighSnrKnownClassHierarchicalAccuracy,
    classwiseKnownHighSnr,
    fittedUnknownTemplateRejectionRate: fraction(fittedUnknownTemplates, (item) => item.result === 'unknown'),
    fittedUnknownPosteriorAuroc,
    scenarioExcludedFromComponentFitScenarios: [...scenarioExcludedIds],
    knownAcquisitionValidationOnlyScenarios: [...knownAcquisitionValidationIds],
    scenarioExcludedUnknownSamples: scenarioExcludedUnknown.length,
    validationOnlyUnknownDecisionRate: fraction(scenarioExcludedUnknown, (item) => item.result === 'unknown'),
    scenarioExcludedStrictUnknownSamples: scenarioExcludedStrictUnknown.length,
    scenarioExcludedStrictUnknownRejectionRate: strictHoldoutRejectionRate,
    scenarioExcludedNonExactAmbiguousSamples: scenarioExcludedNonExactAmbiguous.length,
    exactEquivalenceSamples: scenarioExcludedExactEquivalence.length,
    exactEquivalenceCompatibleRate,
    exactEquivalenceDecisionCounts: counts(scenarioExcludedExactEquivalence.map((item) => item.result)),
    validationOnlyAllowedDecisionRate: fraction(scenarioExcludedUnknown, (item) => item.acceptedHierarchy),
    scenarioExcludedStrictTypicalityAuroc,
    falseAcceptedUnknownCount: falseAcceptedUnknown.length,
    anyFalseAcceptAttemptCount: falseAcceptedUnknownAttemptIds.length,
    anyFalseAcceptAttemptIds: falseAcceptedUnknownAttemptIds,
    falseAcceptedUnknownExamples: falseAcceptedUnknown.slice(0, 50),
    modelSupportRank: {
      identifiableFitEligibleKnown: numericSummary(identifiableFitEligibleKnown.map((item) => item.knownSupportRank)),
      scenarioExcludedUnknown: numericSummary(scenarioExcludedUnknown.map((item) => item.knownSupportRank)),
    },
    fittedTemplateLogLoss,
    fittedTemplateMulticlassBrier: fittedTemplateBrier,
    fittedTemplateExpectedCalibrationError: fittedTemplateEce,
    allSingletonAllowedTruthLogLossDiagnostic: {
      value: allSingletonAllowedTruthLogLossDiagnostic,
      samples: singletonAllowedTruthCases.length,
      qualification: 'one-hot diagnostic restricted to cases declaring exactly one allowed observable truth',
    },
    evidenceViews,
    bySnr,
    byRbwDivisor,
    association: {
      firstReadySelectionModes: counts(cases.map((item) => item.associationMode)),
      everAttemptModes: counts(admissionAttempts.flatMap((item) => item.everAssociationModes)),
      finalAttemptModes: counts(admissionAttempts.flatMap((item) => item.finalAssociationModes)),
      byMode: associationByMode,
      byScenario: associationByScenario,
    },
    limitations: limitationCounts,
    confusion,
    failures: cases.filter((item) => !item.acceptedHierarchy).slice(0, 50).map(({ posterior: _posterior, features: _features, ...item }) => item),
  },
};
const reportPath = resolve('.artifacts/classifier-validation/report.json');
mkdirSync(resolve('.artifacts/classifier-validation'), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, ...report }, null, 2));

const conditional = report.classificationConditionalOnAdmission;
const acceptanceFailures = [
  diagnosticScenarioIdSet.size > 0 ? 'diagnostic scenario subset is never an acceptance run' : undefined,
  BAYESIAN_OBSERVABLE_MODEL.classModels.length !== 12 ? `expected 12 v5 model classes, observed ${BAYESIAN_OBSERVABLE_MODEL.classModels.length}` : undefined,
  BAYESIAN_OBSERVABLE_MODEL.sourceCommit !== PINNED_SIGNAL_LAB_COMMIT ? `model source commit ${BAYESIAN_OBSERVABLE_MODEL.sourceCommit} does not match pinned ${PINNED_SIGNAL_LAB_COMMIT}` : undefined,
  BAYESIAN_OBSERVABLE_MODEL.corpusVersion !== CLASSIFICATION_CORPUS_VERSION ? `model corpus version ${BAYESIAN_OBSERVABLE_MODEL.corpusVersion} does not match checked-out ${CLASSIFICATION_CORPUS_VERSION}` : undefined,
  BAYESIAN_OBSERVABLE_MODEL.corpusSha256 !== checkedOutCorpusSha256 ? `model corpus SHA-256 ${BAYESIAN_OBSERVABLE_MODEL.corpusSha256} does not match checked-out ${checkedOutCorpusSha256}` : undefined,
  checkedInModelAssetSha256 !== BAYESIAN_OBSERVABLE_MODEL_SHA256 ? `model asset SHA-256 ${checkedInModelAssetSha256} does not match manifest ${BAYESIAN_OBSERVABLE_MODEL_SHA256}` : undefined,
  admissionAttempts.length !== expectedAttempts ? `expected ${expectedAttempts} production-pipeline attempts, observed ${admissionAttempts.length}` : undefined,
  cases.length !== expectedFirstReadyRepresentativeSamples ? `classified ${cases.length} first-ready representatives, expected ${expectedFirstReadyRepresentativeSamples}` : undefined,
  uniqueFirstReadyRepresentativeSamples !== cases.length ? `first-ready classification contains ${cases.length - uniqueFirstReadyRepresentativeSamples} duplicate attempt/representative samples` : undefined,
  cases.length === 0 ? 'production detector/tracker admitted no validation cases' : undefined,
  !samplingPartitionsDisjoint
    ? `sampling partitions overlap or lack metadata (fit/cal seeds=${fittingCalibrationSeedOverlap.join(',') || 'none'}; validation/fit seeds=${validationFittingSeedOverlap.join(',') || 'none'}; validation/cal seeds=${validationCalibrationSeedOverlap.join(',') || 'none'}; validation/fit RBWs=${validationFittingRbwOverlap.join(',') || 'none'}; validation/cal RBWs=${validationCalibrationRbwOverlap.join(',') || 'none'}; calibration-seed-count=${modelCalibrationSeeds.length}; calibration-RBW-count=${modelCalibrationRbwDivisors.length})`
    : undefined,
  !tailCalibrationPolicyValid
    ? `tail-calibration policy/manifest is invalid (score-unit=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit ?? 'missing'}; aggregation=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy ?? 'missing'}; runtime-interpretation=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy ?? 'missing'}; statistical-interpretation=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation ?? 'missing'}; missing-scenarios=${missingTailCalibrationScenarioIds.join(',') || 'none'}; unexpected-scenarios=${unexpectedTailCalibrationScenarioIds.join(',') || 'none'}; invalid-counts=${invalidTailCalibrationAttemptCounts.map((item) => `${item.scenarioId}:${item.count}`).join(',') || 'none'}; view-count-mismatches=${tailCalibrationViewCountMismatches.map((item) => `${item.classId}/${item.view}:${item.observed}/${item.expected}`).join(',') || 'none'})`
    : undefined,
  !manifestSplitValid ? `model manifest split is invalid (missing-pinned-exclusions=${modelExcludedMissingPinnedIds.join(',') || 'none'}; unexpected-model-exclusions=${modelExcludedUnexpectedIds.join(',') || 'none'}; missing-pinned-exact=${modelExactEquivalenceMissingPinnedIds.join(',') || 'none'}; unexpected-model-exact=${modelExactEquivalenceUnexpectedIds.join(',') || 'none'}; missing-pinned-known-acquisition=${modelKnownAcquisitionMissingPinnedIds.join(',') || 'none'}; unexpected-model-known-acquisition=${modelKnownAcquisitionUnexpectedIds.join(',') || 'none'}; missing-fitted-unknown=${fittedUnknownMissingPinnedIds.join(',') || 'none'}; unexpected-fitted-unknown=${fittedUnknownUnexpectedIds.join(',') || 'none'}; missing-exclusions=${invalidExcludedScenarioIds.join(',') || 'none'}; unexpected-non-unknown-exclusions=${nonUnknownExcludedScenarioIds.join(',') || 'none'}; duplicate-exclusions=${duplicateExcludedScenarioIds.join(',') || 'none'}; invalid-known-acquisition=${invalidKnownAcquisitionValidationIds.join(',') || 'none'}; unknown-truth-known-acquisition=${unknownTruthKnownAcquisitionValidationIds.join(',') || 'none'}; known-acquisition-not-excluded=${knownAcquisitionValidationNotExcludedIds.join(',') || 'none'}; fitted-known-acquisition=${knownAcquisitionValidationFittedComponentIds.join(',') || 'none'}; missing-exact=${invalidExactEquivalenceScenarioIds.join(',') || 'none'}; non-unknown-exact=${nonUnknownExactEquivalenceScenarioIds.join(',') || 'none'}; exact-not-excluded=${exactEquivalenceNotExcludedScenarioIds.join(',') || 'none'}; exact-without-alternative=${exactEquivalenceWithoutDeclaredAlternativeIds.join(',') || 'none'}; fitted-exact-components=${exactEquivalenceFittedComponentIds.join(',') || 'none'}; fitted-ambiguous-unknown=${ambiguousUnknownIncludedInComponentFitIds.join(',') || 'none'}; fitted-unknown=${fittedUnknownScenarioIds.length}; excluded-unknown=${excludedUnknownScenarioIds.length})` : undefined,
  !manifestSplitValid ? `component assignment audit (duplicate=${duplicateFittedComponentScenarioIds.join(',') || 'none'}; missing=${missingFittedComponentScenarioIds.join(',') || 'none'}; unexpected=${unexpectedFittedComponentScenarioIds.join(',') || 'none'}; wrong-class=${wrongClassFittedComponents.map((item) => `${item.scenarioId}:${item.classId}->${item.expectedClassId}`).join(',') || 'none'}; duplicate-classes=${duplicateModelClassIds.join(',') || 'none'}; missing-classes=${missingModelClassIds.join(',') || 'none'}; unexpected-classes=${unexpectedModelClassIds.join(',') || 'none'})` : undefined,
  exactEquivalenceDiscrepancyCount !== 0 ? `${exactEquivalenceDiscrepancyCount} exact-equivalence paired nuisance checks differ` : undefined,
  knownAdmissionSeedCoverageFailures.length ? `${knownAdmissionSeedCoverageFailures.length} per-scenario/per-SNR known admission seed-coverage cells failed` : undefined,
  expectedNonAdmissionScenariosWithAdmission.length
    ? `expected-non-admission policy is stale: admissions observed for ${expectedNonAdmissionScenariosWithAdmission.join(', ')}` : undefined,
  knownAcquisitionWrongAdmissions.length ? `${knownAcquisitionWrongAdmissions.length} admitted known-acquisition-validation cases had incompatible decisions` : undefined,
  singletonAllowedTruthFittedTemplateCases.length === 0 ? 'no singleton-allowed-truth fitted cases available for proper-score diagnostics' : undefined,
  fittedUnknownTemplates.length === 0 ? 'no fitted unknown-template cases reached classification admission' : undefined,
  scenarioExcludedUnknown.length === 0 ? 'no scenario-excluded unknown cases reached classification admission' : undefined,
  scenarioExcludedStrictUnknown.length === 0 ? 'no strict unknown holdout cases reached classification admission' : undefined,
  strictHoldoutRejectionRate < 1 ? `strict unknown holdout rejection rate ${strictHoldoutRejectionRate} < 1` : undefined,
  scenarioExcludedExactEquivalence.length === 0 ? 'no exact observable-equivalence null cases reached classification admission' : undefined,
  exactEquivalenceCompatibleRate < 1 ? `exact observable-equivalence compatibility ${exactEquivalenceCompatibleRate} < 1` : undefined,
  falseAcceptedUnknown.length !== 0 ? `false-accepted ${falseAcceptedUnknown.length} admitted unknown scenarios` : undefined,
  falseAcceptedUnknownAttemptIds.length !== 0 ? `${falseAcceptedUnknownAttemptIds.length} attempts had at least one false-accepted unknown first-ready representative` : undefined,
  conditional.hierarchicalAccuracy < 0.95 ? `admission-conditional hierarchical accuracy ${conditional.hierarchicalAccuracy} < 0.95` : undefined,
  conditional.knownTopLeafAccuracy < 0.85 ? `admission-conditional known top-leaf accuracy ${conditional.knownTopLeafAccuracy} < 0.85` : undefined,
  conditional.knownCoverage < 0.95 ? `admission-conditional known coverage ${conditional.knownCoverage} < 0.95` : undefined,
  conditional.minimumHighSnrKnownClassHierarchicalAccuracy < 0.9
    ? `minimum >=${HIGH_SNR_MINIMUM_DB} dB known-class hierarchical accuracy ${conditional.minimumHighSnrKnownClassHierarchicalAccuracy} < 0.9` : undefined,
  conditional.fittedTemplateLogLoss > 0.5 ? `fitted-template log loss ${conditional.fittedTemplateLogLoss} > 0.5` : undefined,
  conditional.fittedTemplateMulticlassBrier > 0.2 ? `fitted-template Brier score ${conditional.fittedTemplateMulticlassBrier} > 0.2` : undefined,
  conditional.fittedTemplateExpectedCalibrationError > 0.1 ? `fitted-template ECE ${conditional.fittedTemplateExpectedCalibrationError} > 0.1` : undefined,
  !Number.isFinite(conditional.fittedUnknownPosteriorAuroc) || conditional.fittedUnknownPosteriorAuroc < 0.9
    ? `fitted-unknown posterior AUROC ${conditional.fittedUnknownPosteriorAuroc} < 0.9 or non-finite` : undefined,
  !Number.isFinite(conditional.scenarioExcludedStrictTypicalityAuroc) || conditional.scenarioExcludedStrictTypicalityAuroc < 0.9
    ? `strict scenario-excluded support AUROC ${conditional.scenarioExcludedStrictTypicalityAuroc} < 0.9 or non-finite` : undefined,
  ...Object.entries(conditional.evidenceViews).flatMap(([view, metrics]) => [
    metrics.admittedSamples !== cases.length ? `${view} expected ${cases.length} admission-conditional cases, observed ${metrics.admittedSamples}` : undefined,
    metrics.falseAcceptedUnknownCount !== 0 ? `${view} false-accepted ${metrics.falseAcceptedUnknownCount} admitted unknown scenarios` : undefined,
    metrics.anyFalseAcceptAttemptCount !== 0 ? `${view} has ${metrics.anyFalseAcceptAttemptCount} attempts with at least one false-accepted unknown first-ready representative` : undefined,
    metrics.exactEquivalenceSamples === 0 ? `${view} has no admitted exact observable-equivalence null cases` : undefined,
    metrics.exactEquivalenceCompatibleRate < 1 ? `${view} exact observable-equivalence compatibility ${metrics.exactEquivalenceCompatibleRate} < 1` : undefined,
    metrics.strictHoldoutSamples === 0 ? `${view} has no admitted strict unknown holdout cases` : undefined,
    metrics.strictHoldoutRejectionRate < 1 ? `${view} strict unknown holdout rejection rate ${metrics.strictHoldoutRejectionRate} < 1` : undefined,
    metrics.knownCoverage < 0.8 ? `${view} known coverage ${metrics.knownCoverage} < 0.8` : undefined,
    metrics.coveredKnownHierarchicalAccuracy < 0.9 ? `${view} covered-known hierarchical accuracy ${metrics.coveredKnownHierarchicalAccuracy} < 0.9` : undefined,
    !Number.isFinite(metrics.scenarioExcludedStrictSupportAuroc) || metrics.scenarioExcludedStrictSupportAuroc < 0.9
      ? `${view} strict scenario-excluded support AUROC ${metrics.scenarioExcludedStrictSupportAuroc} < 0.9 or non-finite` : undefined,
  ]),
].filter((value): value is string => value !== undefined);
if (acceptanceFailures.length) {
  console.error(`Synthetic observable-class development regression failed:\n- ${acceptanceFailures.join('\n- ')}`);
  process.exitCode = 1;
}

function auditExactEquivalencePairs(
  attempts: readonly AdmissionAttempt[],
  validationCases: readonly ValidationCase[],
  viewCases: readonly EvidenceViewCase[],
): ExactEquivalencePairAudit[] {
  return PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS.map(({ referenceScenarioId, nullScenarioId }) => {
    const pair = `${referenceScenarioId}<=>${nullScenarioId}`;
    const discrepancies: ExactEquivalenceDiscrepancy[] = [];
    let nuisanceCells = 0;
    let matchedAdmissionCells = 0;
    let matchedRepresentativePairs = 0;
    let matchedEvidenceViewPairs = 0;
    const add = (
      nuisanceCell: string,
      field: string,
      reference: unknown,
      nullValue: unknown,
      representativeIndex?: number,
      view?: EvidenceViewCase['view'],
    ) => discrepancies.push({
      pair,
      nuisanceCell,
      ...(representativeIndex === undefined ? {} : { representativeIndex }),
      ...(view === undefined ? {} : { view }),
      field,
      reference,
      null: nullValue,
    });

    for (const snrDb of SNR_DB) for (const rbwDivisor of RBW_DIVISORS) for (const seed of NUISANCE_SHIFT_SEEDS) {
      nuisanceCells += 1;
      const nuisanceCell = `snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`;
      const referenceAttempt = attempts.find((item) => item.scenario === referenceScenarioId
        && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed);
      const nullAttempt = attempts.find((item) => item.scenario === nullScenarioId
        && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed);
      if (!referenceAttempt || !nullAttempt) {
        add(nuisanceCell, 'admission-attempt-present', referenceAttempt !== undefined, nullAttempt !== undefined);
        continue;
      }
      const admissionFields: readonly (keyof AdmissionAttempt)[] = [
        'observationHorizon',
        'everReady',
        'admitted',
        'everReadyRepresentativeCount',
        'finalReadyRepresentativeCount',
        'finalActiveRepresentativeCount',
        'selectedTrackAdmissions',
        'maximumActiveAdmissions',
        'maximumLocalTrackAdmissions',
        'firstReadyOpportunity',
        'regularAssociationsObserved',
        'agileAssociationsObserved',
        'regularAssociationExpirations',
      ];
      let admissionMatches = true;
      for (const field of admissionFields) {
        if (!equivalentValue(referenceAttempt[field], nullAttempt[field])) {
          admissionMatches = false;
          add(nuisanceCell, `admission.${field}`, referenceAttempt[field], nullAttempt[field]);
        }
      }
      for (const field of ['everAssociationModes', 'finalAssociationModes'] as const) {
        const referenceValue = [...referenceAttempt[field]].sort().join('|');
        const nullValue = [...nullAttempt[field]].sort().join('|');
        if (referenceValue !== nullValue) {
          admissionMatches = false;
          add(nuisanceCell, `admission.${field}`, referenceValue, nullValue);
        }
      }
      if (admissionMatches) matchedAdmissionCells += 1;

      const referenceCases = validationCases
        .filter((item) => item.scenario === referenceScenarioId && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed)
        .sort(compareValidationCasesForPairing);
      const nullCases = validationCases
        .filter((item) => item.scenario === nullScenarioId && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed)
        .sort(compareValidationCasesForPairing);
      if (referenceCases.length !== nullCases.length) add(nuisanceCell, 'representative-count', referenceCases.length, nullCases.length);
      for (let index = 0; index < Math.min(referenceCases.length, nullCases.length); index++) {
        const referenceCase = referenceCases[index]!;
        const nullCase = nullCases[index]!;
        matchedRepresentativePairs += 1;
        compareExactCase(referenceCase, nullCase, nuisanceCell, index, add);
      }

      for (const view of ['spectrum-only', 'envelope-untimed'] as const) {
        const referenceViews = viewCases
          .filter((item) => item.scenario === referenceScenarioId && item.view === view
            && item.attemptId === validationAttemptId(referenceScenarioId, snrDb, rbwDivisor, seed))
          .sort(compareEvidenceViewCasesForPairing);
        const nullViews = viewCases
          .filter((item) => item.scenario === nullScenarioId && item.view === view
            && item.attemptId === validationAttemptId(nullScenarioId, snrDb, rbwDivisor, seed))
          .sort(compareEvidenceViewCasesForPairing);
        if (referenceViews.length !== nullViews.length) add(nuisanceCell, 'evidence-view-count', referenceViews.length, nullViews.length, undefined, view);
        for (let index = 0; index < Math.min(referenceViews.length, nullViews.length); index++) {
          matchedEvidenceViewPairs += 1;
          compareExactEvidenceView(referenceViews[index]!, nullViews[index]!, nuisanceCell, index, view, add);
        }
      }
    }
    if (matchedRepresentativePairs === 0) add('all', 'matched-representative-pairs', '>0', matchedRepresentativePairs);
    if (matchedEvidenceViewPairs === 0) add('all', 'matched-evidence-view-pairs', '>0', matchedEvidenceViewPairs);
    return {
      pair,
      referenceScenarioId,
      nullScenarioId,
      nuisanceCells,
      matchedAdmissionCells,
      matchedRepresentativePairs,
      matchedEvidenceViewPairs,
      discrepancyCount: discrepancies.length,
      discrepancies: discrepancies.slice(0, 50),
    };
  });
}

function compareExactCase(
  referenceCase: ValidationCase,
  nullCase: ValidationCase,
  nuisanceCell: string,
  representativeIndex: number,
  add: (nuisanceCell: string, field: string, reference: unknown, nullValue: unknown, representativeIndex?: number) => void,
): void {
  for (const field of [
    'firstReadyOpportunity',
    'result',
    'confidence',
    'topLeaf',
    'topLeafPosterior',
    'bandwidthHz',
    'selectedTrackAdmissions',
    'localTrackAdmissions',
    'associationMode',
    'associationMemberCount',
    'associationRegionBandwidthHz',
    'knownSupportRank',
  ] as const) {
    if (!equivalentValue(referenceCase[field], nullCase[field])) {
      add(nuisanceCell, `case.${field}`, referenceCase[field], nullCase[field], representativeIndex);
    }
  }
  compareNumericRecords(referenceCase.features, nullCase.features, 'features', nuisanceCell, representativeIndex, add);
  compareNumericRecords(referenceCase.posterior, nullCase.posterior, 'posterior', nuisanceCell, representativeIndex, add);
}

function compareExactEvidenceView(
  referenceCase: EvidenceViewCase,
  nullCase: EvidenceViewCase,
  nuisanceCell: string,
  representativeIndex: number,
  view: EvidenceViewCase['view'],
  add: (
    nuisanceCell: string,
    field: string,
    reference: unknown,
    nullValue: unknown,
    representativeIndex?: number,
    view?: EvidenceViewCase['view'],
  ) => void,
): void {
  for (const field of [
    'measuredBandwidthHz',
    'result',
    'topLeaf',
    'topLeafPosterior',
    'supportRank',
  ] as const) {
    if (!equivalentValue(referenceCase[field], nullCase[field])) {
      add(nuisanceCell, `evidence.${field}`, referenceCase[field], nullCase[field], representativeIndex, view);
    }
  }
  compareNumericRecords(referenceCase.posterior, nullCase.posterior, 'evidence.posterior', nuisanceCell, representativeIndex,
    (cell, field, reference, nullValue, index) => add(cell, field, reference, nullValue, index, view));
}

function compareNumericRecords(
  reference: Readonly<Record<string, number>>,
  nullValue: Readonly<Record<string, number>>,
  prefix: string,
  nuisanceCell: string,
  representativeIndex: number,
  add: (nuisanceCell: string, field: string, reference: unknown, nullValue: unknown, representativeIndex?: number) => void,
): void {
  const keys = [...new Set([...Object.keys(reference), ...Object.keys(nullValue)])].sort();
  for (const key of keys) {
    if (!(key in reference) || !(key in nullValue) || !equivalentValue(reference[key], nullValue[key])) {
      add(nuisanceCell, `${prefix}.${key}`, reference[key], nullValue[key], representativeIndex);
    }
  }
}

function equivalentValue(reference: unknown, nullValue: unknown): boolean {
  if (typeof reference === 'number' && typeof nullValue === 'number') {
    if (Object.is(reference, nullValue)) return true;
    if (!Number.isFinite(reference) || !Number.isFinite(nullValue)) return false;
    return Math.abs(reference - nullValue) <= EXACT_EQUIVALENCE_NUMERICAL_TOLERANCE
      * Math.max(1, Math.abs(reference), Math.abs(nullValue));
  }
  return Object.is(reference, nullValue);
}

function compareValidationCasesForPairing(left: ValidationCase, right: ValidationCase): number {
  return left.firstReadyOpportunity - right.firstReadyOpportunity
    || left.associationMode.localeCompare(right.associationMode)
    || left.bandwidthHz - right.bandwidthHz
    || left.representativeKey.localeCompare(right.representativeKey);
}

function compareEvidenceViewCasesForPairing(left: EvidenceViewCase, right: EvidenceViewCase): number {
  return left.measuredBandwidthHz - right.measuredBandwidthHz
    || left.representativeKey.localeCompare(right.representativeKey);
}

function selectProductionFirstReady(sweeps: readonly Sweep[]): ProductionOnlineSelection {
  const detector = new SignalDetector(PRODUCTION_DETECTION_CONFIG);
  const tracker = new SignalTracker(PRODUCTION_DETECTION_CONFIG);
  const everReadyRepresentativeKeys = new Set<string>();
  const representatives: FirstReadyRepresentative[] = [];
  const everAssociationModes = new Set<string>();
  const regularAssociationIds = new Set<string>();
  const agileAssociationIds = new Set<string>();
  const expiredRegularAssociationIds = new Set<string>();
  let previousRegularAssociationByTrack = new Map<string, string>();
  let finalTracks: readonly DetectedSignal[] = [];
  let maximumActiveAdmissions = 0;
  let maximumLocalTrackAdmissions = 0;
  let firstReadyOpportunity: number | undefined;
  for (const [lookIndex, sweep] of sweeps.entries()) {
    const tracks = tracker.update(sweep, detector.analyze(sweep));
    finalTracks = tracks;
    const activeRepresentatives = classificationRepresentatives(tracks.filter((track) => track.state === 'active'));
    const readyRepresentatives = activeRepresentatives
      .filter((track) => classificationSourceSweepIds(track).length >= CLASSIFICATION_ADMISSIONS)
      .map((detection) => ({ detection, representativeKey: classificationRepresentativeKey(detection) }))
      .sort((left, right) => left.representativeKey.localeCompare(right.representativeKey));
    if (readyRepresentatives.length > 0 && firstReadyOpportunity === undefined) firstReadyOpportunity = lookIndex + 1;
    for (const { detection, representativeKey } of readyRepresentatives) {
      if (everReadyRepresentativeKeys.has(representativeKey)) continue;
      everReadyRepresentativeKeys.add(representativeKey);
      representatives.push({
        detection: structuredClone(detection),
        representativeKey,
        classificationAdmissions: classificationSourceSweepIds(detection).length,
        localTrackAdmissions: detection.sweepIds.length,
        firstReadyOpportunity: lookIndex + 1,
        evidenceSweeps: sweeps.slice(0, lookIndex + 1),
      });
    }
    for (const representative of activeRepresentatives) {
      const associationMode = representative.associationMode ?? 'frequency-local';
      everAssociationModes.add(associationMode);
      maximumActiveAdmissions = Math.max(maximumActiveAdmissions, classificationSourceSweepIds(representative).length);
      maximumLocalTrackAdmissions = Math.max(maximumLocalTrackAdmissions, representative.sweepIds.length);
      if (associationMode === 'regular-spectral-component-activity' && representative.associationId) regularAssociationIds.add(representative.associationId);
      if (associationMode === 'frequency-agile-2g4-activity' && representative.associationId) agileAssociationIds.add(representative.associationId);
    }
    const currentRegularAssociationByTrack = new Map(tracks.flatMap((track) =>
      track.associationMode === 'regular-spectral-component-activity' && track.associationId
        ? [[track.id, track.associationId] as const]
        : []));
    for (const [trackId, associationId] of previousRegularAssociationByTrack) {
      if (currentRegularAssociationByTrack.get(trackId) !== associationId) expiredRegularAssociationIds.add(associationId);
    }
    previousRegularAssociationByTrack = currentRegularAssociationByTrack;
  }
  const finalActiveRepresentatives = classificationRepresentatives(finalTracks.filter((track) => track.state === 'active'));
  const finalReadyRepresentatives = finalActiveRepresentatives
    .filter((track) => classificationSourceSweepIds(track).length >= CLASSIFICATION_ADMISSIONS);
  return {
    representatives: representatives.sort((left, right) => left.firstReadyOpportunity - right.firstReadyOpportunity
      || left.representativeKey.localeCompare(right.representativeKey)),
    everReadyRepresentativeKeys: [...everReadyRepresentativeKeys].sort(),
    finalReadyRepresentativeCount: finalReadyRepresentatives.length,
    finalActiveRepresentativeCount: finalActiveRepresentatives.length,
    maximumActiveAdmissions,
    maximumLocalTrackAdmissions,
    ...(firstReadyOpportunity === undefined ? {} : { firstReadyOpportunity }),
    everAssociationModes: [...everAssociationModes].sort(),
    finalAssociationModes: [...new Set(finalReadyRepresentatives.map((detection) => detection.associationMode ?? 'frequency-local'))].sort(),
    regularAssociationIds: [...regularAssociationIds].sort(),
    agileAssociationIds: [...agileAssociationIds].sort(),
    regularAssociationExpirations: expiredRegularAssociationIds.size,
  };
}

function observationOpportunityHorizon(scenario: CanonicalClassificationScenario): number {
  const startHz = scenario.centerHz - scenario.recommendedSpanHz / 2;
  const stopHz = scenario.centerHz + scenario.recommendedSpanHz / 2;
  return startHz <= FULL_BAND_2G4_START_HZ && stopHz >= FULL_BAND_2G4_STOP_HZ
    ? FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES
    : STANDARD_OBSERVATION_OPPORTUNITIES;
}

function validationAttemptId(scenarioId: string, snrDb: number, rbwDivisor: number, seed: number): string {
  return `${scenarioId}:snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`;
}

function classificationRepresentativeKey(track: DetectedSignal): string {
  const associationMode = track.associationMode ?? 'frequency-local';
  return `${associationMode}:${associationMode === 'frequency-local' ? track.id : track.associationId ?? track.id}`;
}

function classificationSourceSweepIds(track: DetectedSignal): readonly string[] {
  return track.associationMode !== undefined && track.associationMode !== 'frequency-local'
    ? track.associationRegionSweepIds ?? []
    : track.sweepIds;
}

function asSweep(scenario: CanonicalClassificationScenario, observation: ReturnType<typeof synthesizeCanonicalObservation>): Sweep {
  const startHz = observation.frequencyHz[0]!;
  const stopHz = observation.frequencyHz.at(-1)!;
  return {
    kind: 'spectrum', id: `${scenario.id}-${observation.seed}-${observation.lookIndex}`, sequence: observation.lookIndex + 1,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + observation.lookIndex * observation.sweepTimeSeconds * 1_000).toISOString(), elapsedMilliseconds: observation.sweepTimeSeconds * 1_000,
    frequencyHz: observation.frequencyHz, powerDbm: observation.powerDbm,
    requested: { startHz, stopHz, points: observation.frequencyHz.length, acquisitionFormat: 'text', rbwKhz: observation.actualRbwHz / 1_000, attenuationDb: 'auto', sweepTimeSeconds: observation.sweepTimeSeconds, detector: 'sample', spurRejection: 'off', lna: 'off', avoidSpurs: 'off', trigger: { mode: 'auto' } },
    actualStartHz: startHz, actualStopHz: stopHz, actualRbwHz: observation.actualRbwHz, actualAttenuationDb: 0,
    source: 'scan-text', complete: true, identity,
  };
}

function asZeroSpan(observation: ReturnType<typeof synthesizeCanonicalObservation>, detection: DetectedSignal): ZeroSpanCapture {
  const sweepTimeSeconds = observation.zeroSpanPowerDbm.length * observation.zeroSpanSamplePeriodSeconds;
  return {
    kind: 'zero-span', id: `zero-${observation.scenarioId}-${observation.seed}-${observation.lookIndex}`, sequence: 1,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + observation.lookIndex * observation.sweepTimeSeconds * 1_000).toISOString(), elapsedMilliseconds: sweepTimeSeconds * 1_000,
    frequencyHz: observation.zeroSpanFrequencyHz, samplePeriodSeconds: observation.zeroSpanSamplePeriodSeconds, timingQualification: 'simulation-exact',
    targetDetectionId: detection.id,
    powerDbm: observation.zeroSpanPowerDbm,
    requested: { frequencyHz: observation.zeroSpanFrequencyHz, points: observation.zeroSpanPowerDbm.length, rbwKhz: observation.actualRbwHz / 1_000, attenuationDb: 'auto', sweepTimeSeconds, trigger: { mode: 'auto' } },
    actualRbwHz: observation.actualRbwHz, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
  };
}

function modelTruth(truth: ObservableSignalClass): ObservableLeafClass {
  if (truth === 'bluetooth-classic-like' || truth === 'bluetooth-le-like') return 'bluetooth-like';
  if (OBSERVABLE_LEAF_CLASSES.includes(truth as ObservableLeafClass)) return truth as ObservableLeafClass;
  throw new Error(`Corpus truth ${truth} has no v4 observable-model mapping`);
}

function acceptsTruth(
  result: string,
  truth: ObservableLeafClass,
  nominalBandwidthHz: number,
  measuredBandwidthHz: number,
): boolean {
  if (truth === 'unknown-signal') return result === 'unknown';
  if (result === `observable:${truth}`) return true;
  if ((truth === 'lte-fdd-like' || truth === 'lte-tdd-like') && result === 'observable:lte-like') return true;
  if ((truth === 'nr-fdd-like' || truth === 'nr-tdd-like') && result === 'observable:nr-like') return true;
  if ((truth === 'lte-fdd-like' || truth === 'lte-tdd-like' || truth === 'nr-fdd-like' || truth === 'nr-tdd-like')
    && result === 'observable:cellular-ofdm-ambiguous') {
    return nominalBandwidthHz <= 25_000_000 && measuredBandwidthHz <= 25_000_000;
  }
  if ((truth === 'wifi-hr-dsss-like' || truth === 'wifi-ofdm-like') && result === 'observable:wifi-like') return true;
  return false;
}

function acceptsAnyTruth(
  result: string,
  allowedTruths: readonly ObservableLeafClass[],
  nominalBandwidthHz: number,
  measuredBandwidthHz: number,
): boolean {
  return allowedTruths.some((truth) => acceptsTruth(result, truth, nominalBandwidthHz, measuredBandwidthHz));
}

function admissionSummary(values: readonly AdmissionAttempt[]) {
  const everReady = values.filter((item) => item.everReady);
  const admitted = values.filter((item) => item.admitted);
  return {
    attempted: values.length,
    everReady: everReady.length,
    everReadyRate: fraction(values, (item) => item.everReady),
    firstReady: admitted.length,
    firstReadyRate: fraction(values, (item) => item.admitted),
    admitted: admitted.length,
    misses: values.length - admitted.length,
    admissionRate: fraction(values, (item) => item.admitted),
    observationHorizons: counts(values.map((item) => String(item.observationHorizon))),
    everReadyRepresentativeCount: numericSummary(values.map((item) => item.everReadyRepresentativeCount)),
    finalReadyRepresentativeCount: numericSummary(values.map((item) => item.finalReadyRepresentativeCount)),
    finalActiveRepresentativeCount: numericSummary(values.map((item) => item.finalActiveRepresentativeCount)),
    selectedTrackAdmissions: numericSummary(admitted.map((item) => item.selectedTrackAdmissions)),
    maximumActiveAdmissions: numericSummary(values.map((item) => item.maximumActiveAdmissions)),
    maximumLocalTrackAdmissions: numericSummary(values.map((item) => item.maximumLocalTrackAdmissions)),
    firstReadyOpportunity: numericSummary(values.flatMap((item) => item.firstReadyOpportunity === undefined ? [] : [item.firstReadyOpportunity])),
    everAssociationModes: counts(values.flatMap((item) => item.everAssociationModes)),
    finalAssociationModes: counts(values.flatMap((item) => item.finalAssociationModes)),
    regularAssociationsObserved: values.reduce((sum, item) => sum + item.regularAssociationsObserved, 0),
    agileAssociationsObserved: values.reduce((sum, item) => sum + item.agileAssociationsObserved, 0),
    regularAssociationExpirations: values.reduce((sum, item) => sum + item.regularAssociationExpirations, 0),
  };
}

function expectedCalibrationError(values: readonly { confidence: number; correct: boolean }[], bins: number): number {
  if (!values.length) return Number.NaN;
  let result = 0;
  for (let bin = 0; bin < bins; bin++) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const selected = values.filter((item) => item.confidence >= lower && (bin === bins - 1 ? item.confidence <= upper : item.confidence < upper));
    if (!selected.length) continue;
    result += selected.length / values.length * Math.abs(mean(selected.map((item) => item.confidence)) - fraction(selected, (item) => item.correct));
  }
  return result;
}

function auroc(values: readonly { score: number; positive: boolean }[]): number {
  const positive = values.filter((item) => item.positive);
  const negative = values.filter((item) => !item.positive);
  if (!positive.length || !negative.length) return Number.NaN;
  let wins = 0;
  for (const left of positive) for (const right of negative) wins += left.score > right.score ? 1 : left.score === right.score ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

function counts(values: readonly string[]): Record<string, number> { return values.reduce<Record<string, number>>((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {}); }
function duplicateStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}
function setDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => !rightSet.has(value)))].sort();
}
function numericIntersection(left: readonly number[], right: readonly number[]): number[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort((a, b) => a - b);
}
function numericSummary(values: readonly number[]): { minimum: number; median: number; maximum: number } | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return { minimum: ordered[0]!, median: ordered[Math.floor(ordered.length / 2)]!, maximum: ordered.at(-1)! };
}
function fraction<T>(values: readonly T[], predicate: (value: T) => boolean): number { return values.length ? values.filter(predicate).length / values.length : 0; }
function mean(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN; }
function spectrumOnly(values: Readonly<Record<string, number>>): Readonly<Record<string, number>> { return Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith('envelope.'))); }
function envelopeUntimed(values: Readonly<Record<string, number>>): Readonly<Record<string, number>> { return Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith('envelope.periodicEnergy') && name !== 'envelope.logTransitionRateHz')); }
