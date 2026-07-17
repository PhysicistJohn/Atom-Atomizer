import { BAYESIAN_DETECTOR_MODEL, SignalDetector, SignalTracker } from '../packages/analysis/src/index.js';
import type {
  AnalyzerConfig,
  DetectedSignal,
  DeviceIdentity,
  SignalDetectionConfig,
  Sweep,
  SweptSpectrumConfiguration,
} from '../packages/contracts/src/index.js';

const POINTS = 450;
const BIN_WIDTH_HZ = 10_000;
const CENTER_INDEX = Math.floor(POINTS / 2);
const MEAN_NOISE_DBM = -110;
const MEAN_NOISE_MILLIWATTS = 10 ** (MEAN_NOISE_DBM / 10);
const SHAPES = [1, 2, 6, 12] as const;
const CORRELATION_WIDTHS = [1, 3] as const;
const SIGNAL_SNR_DB = [0, 5, 10, 15, 20, 25, 30] as const;
const SIGNAL_WIDTHS_RBW = [1, 8] as const;
const DETECTOR_ALTERNATIVE_DEFINITION = Object.freeze({
  id: 'centered-flat-linear-power-mean-shift-v1',
  qualification: 'analytic-observation-domain-detector-alternative',
  domain: 'scalar-spectrum-linear-power',
  supportAnchor: 'symmetric-about-frequency-grid-midpoint-upper-cell-tie-v1',
  disclosure: 'Constant additive linear power relative to mean null power in each frequency-grid bin of a centered support spanning the declared one or eight RBWs; support bin count is round(widthRbw * binsPerRbw). This is an abstract detector alternative, not a synthesized RF waveform, protocol, receiver calibration, sensitivity, or field-strength claim.',
} as const);
const NULL_FAMILY_SIZE = SHAPES.length * CORRELATION_WIDTHS.length;
// Bonferroni simultaneous 95% family: Phi^-1(1 - 0.05 / (2 * 8)).
// With zero observed false-alarm sweeps, 8,000 trials give a Wilson upper
// bound of about 9.34e-4 for every configuration, below the actual 1e-3 goal.
const SIMULTANEOUS_WILSON_Z = 2.7343687865;
const POINTWISE_WILSON_Z = 1.96;
const MINIMUM_NULL_TRIALS_FOR_ZERO_EVENT_BOUND = Math.ceil(
  SIMULTANEOUS_WILSON_Z ** 2
    * (1 - BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability)
    / BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability,
);
const NULL_SWEEPS_PER_CONFIGURATION = positiveIntegerEnvironment('DETECTOR_NULL_SWEEPS', 8_000);
const SIGNAL_SWEEPS_PER_POINT = positiveIntegerEnvironment('DETECTOR_SIGNAL_SWEEPS', 500);
const STRESS_SWEEPS_PER_CASE = positiveIntegerEnvironment('DETECTOR_STRESS_SWEEPS', 1_000);
const GAIN_INVARIANCE_SWEEPS_PER_CONFIGURATION = positiveIntegerEnvironment('DETECTOR_GAIN_SWEEPS', 500);
const MINIMUM_PD_LOWER_95_AT_15_DB = 0.15;
const MINIMUM_PD_LOWER_95_AT_20_DB = 0.60;
const MINIMUM_PD_LOWER_95_AT_25_DB = 0.75;
const MINIMUM_PD_LOWER_95_AT_30_DB = 0.90;
// The runtime requires two consecutive admitted local looks. Under this
// validator's explicitly independent-look alternative, the corresponding
// engineering promotion gates are the squares of the one-look Pd gates.
const MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_15_DB = MINIMUM_PD_LOWER_95_AT_15_DB ** 2;
const MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_20_DB = MINIMUM_PD_LOWER_95_AT_20_DB ** 2;
const MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_25_DB = MINIMUM_PD_LOWER_95_AT_25_DB ** 2;
const MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_30_DB = MINIMUM_PD_LOWER_95_AT_30_DB ** 2;
const SCALE_INVARIANCE_TOLERANCE = 1e-9;
const FREQUENCIES = Array.from({ length: POINTS }, (_, index) => 100_000_000 + index * BIN_WIDTH_HZ);

const identity: DeviceIdentity = {
  model: 'Bayesian detector Monte Carlo', hardwareVersion: 'offline', firmwareVersion: 'analytic-noise-stress-v2', firmwareQualification: 'protocol-test',
  port: { id: 'offline', path: 'offline://detector-validation', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
  simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
};
const analyzer: AnalyzerConfig = {
  startHz: FREQUENCIES[0]!, stopHz: FREQUENCIES.at(-1)!, points: POINTS, acquisitionFormat: 'text', rbwKhz: 10, attenuationDb: 'auto', sweepTimeSeconds: 0.05,
  detector: 'sample', spurRejection: 'off', lna: 'off', avoidSpurs: 'off', trigger: { mode: 'auto' },
};
const permissiveCfarConfig: SignalDetectionConfig = {
  // This deliberately weak prefilter exercises a distinct high-candidate-load
  // segmentation path. A lower threshold can merge connected components, so
  // this is not claimed to be a mathematical superset of production candidates.
  threshold: { strategy: 'noise-relative', marginDb: 3 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 0,
  minimumConsecutiveSweeps: 1,
  releaseAfterMissedSweeps: 0,
};
const productionDetectionConfig: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const permissiveDetector = new SignalDetector(permissiveCfarConfig);
const productionDetector = new SignalDetector(productionDetectionConfig);

interface StationaryConfiguration {
  shape: number;
  correlationWidth: number;
  modelRole: 'exact-iid-exponential' | 'exponential-marginal-block-correlation' | 'gamma-average-analytic-stress';
}

interface ProbabilityPoint {
  trials: number;
  detected: number;
  probability: number;
  interval95Percent: { lower: number; upper: number };
}

const configurations: readonly StationaryConfiguration[] = SHAPES.flatMap((shape) => CORRELATION_WIDTHS.map((correlationWidth) => ({
  shape,
  correlationWidth,
  modelRole: shape === 1
    ? correlationWidth === 1
      ? 'exact-iid-exponential' as const
      : 'exponential-marginal-block-correlation' as const
    : 'gamma-average-analytic-stress' as const,
})));

const nullResults = configurations.map((configuration) => {
  let detections = 0;
  let sweepsWithDetection = 0;
  for (let sequence = 0; sequence < NULL_SWEEPS_PER_CONFIGURATION; sequence++) {
    const values = permissiveDetector.analyze(makeStationarySweep(sequence, configuration, Number.NEGATIVE_INFINITY, 1));
    detections += values.length;
    if (values.length) sweepsWithDetection++;
  }
  return {
    ...configuration,
    sweeps: NULL_SWEEPS_PER_CONFIGURATION,
    effectiveCells: NULL_SWEEPS_PER_CONFIGURATION * POINTS / configuration.correlationWidth,
    detections,
    sweepsWithDetection,
    falseEventsPerSweep: detections / NULL_SWEEPS_PER_CONFIGURATION,
    sweepFalseAlarmRate: sweepsWithDetection / NULL_SWEEPS_PER_CONFIGURATION,
    simultaneousFamily95PercentWilsonInterval: wilsonInterval(sweepsWithDetection, NULL_SWEEPS_PER_CONFIGURATION, SIMULTANEOUS_WILSON_Z),
  };
});

const detectionAudits = configurations.flatMap((configuration) => SIGNAL_WIDTHS_RBW.map((signalWidthRbw) => {
  const sweepLocalDetectedBySnr = new Map<number, number>(SIGNAL_SNR_DB.map((snrDb) => [snrDb, 0]));
  const twoLookPromotedBySnr = new Map<number, number>(SIGNAL_SNR_DB.map((snrDb) => [snrDb, 0]));
  let sweepLocalPairedMonotonicityViolations = 0;
  let twoLookPairedMonotonicityViolations = 0;
  const sweepLocalPairedMonotonicityExamples: Array<{ trial: number; lowerSnrDb: number; higherSnrDb: number }> = [];
  const twoLookPairedMonotonicityExamples: Array<{ trial: number; lowerSnrDb: number; higherSnrDb: number }> = [];
  for (let trial = 0; trial < SIGNAL_SWEEPS_PER_POINT; trial++) {
    let previousSweepLocalDetected = false;
    let previousTwoLookPromoted = false;
    for (const [snrIndex, snrDb] of SIGNAL_SNR_DB.entries()) {
      // Both modeled looks are independent. Reusing their exact two noise
      // realizations across SNR provides pointwise common-random-number
      // monotonicity tests without treating different SNR cells as independent.
      const firstSweep = makeStationarySweep(1_000_000 + 2 * trial, configuration, snrDb, signalWidthRbw);
      const secondSweep = makeStationarySweep(1_000_000 + 2 * trial + 1, configuration, snrDb, signalWidthRbw);
      const targetHz = firstSweep.frequencyHz[CENTER_INDEX]!;
      const firstCandidates = productionDetector.analyze(firstSweep);
      const sweepLocalDetected = detectsTarget(firstCandidates, targetHz);
      const tracker = new SignalTracker(productionDetectionConfig);
      tracker.update(firstSweep, firstCandidates);
      const secondCandidates = productionDetector.analyze(secondSweep);
      const twoLookPromoted = detectsActiveTarget(tracker.update(secondSweep, secondCandidates), targetHz);

      if (sweepLocalDetected) {
        sweepLocalDetectedBySnr.set(snrDb, sweepLocalDetectedBySnr.get(snrDb)! + 1);
      }
      if (twoLookPromoted) twoLookPromotedBySnr.set(snrDb, twoLookPromotedBySnr.get(snrDb)! + 1);
      if (snrIndex > 0 && previousSweepLocalDetected && !sweepLocalDetected) {
        sweepLocalPairedMonotonicityViolations++;
        if (sweepLocalPairedMonotonicityExamples.length < 20) sweepLocalPairedMonotonicityExamples.push({
          trial,
          lowerSnrDb: SIGNAL_SNR_DB[snrIndex - 1]!,
          higherSnrDb: snrDb,
        });
      }
      if (snrIndex > 0 && previousTwoLookPromoted && !twoLookPromoted) {
        twoLookPairedMonotonicityViolations++;
        if (twoLookPairedMonotonicityExamples.length < 20) twoLookPairedMonotonicityExamples.push({
          trial,
          lowerSnrDb: SIGNAL_SNR_DB[snrIndex - 1]!,
          higherSnrDb: snrDb,
        });
      }
      previousSweepLocalDetected = sweepLocalDetected;
      previousTwoLookPromoted = twoLookPromoted;
    }
  }
  return {
    sweepLocal: {
      ...configuration,
      signalWidthRbw,
      alternativeDefinition: DETECTOR_ALTERNATIVE_DEFINITION,
      successCriterion: 'one-sweep-local-candidate-threshold-component-contains-declared-center-before-tracker-promotion',
      confidenceScope: 'pointwise-per-shape-correlation-width-signal-width-and-snr-not-simultaneous',
      probabilityOfDetection: probabilityPoints(sweepLocalDetectedBySnr),
      pairedMonotonicityViolations: sweepLocalPairedMonotonicityViolations,
      pairedMonotonicityExamples: sweepLocalPairedMonotonicityExamples,
    },
    twoLookTrackPromotion: {
      ...configuration,
      signalWidthRbw,
      alternativeDefinition: DETECTOR_ALTERNATIVE_DEFINITION,
      lookModel: 'two-ordered-independent-analytic-looks-with-common-random-numbers-across-snr',
      successCriterion: 'active-runtime-track-threshold-component-contains-declared-center-after-exactly-two-looks',
      confidenceScope: 'pointwise-per-shape-correlation-width-signal-width-and-snr-not-simultaneous',
      probabilityOfDetection: probabilityPoints(twoLookPromotedBySnr),
      pairedMonotonicityViolations: twoLookPairedMonotonicityViolations,
      pairedMonotonicityExamples: twoLookPairedMonotonicityExamples,
    },
  };
}));

const sweepLocalDetectionResults = detectionAudits.map((audit) => audit.sweepLocal);
const twoLookTrackPromotionResults = detectionAudits.map((audit) => audit.twoLookTrackPromotion);

interface StressObservation {
  sweep: Sweep;
  declaredDiscreteAnomalyIndices: readonly number[];
}

interface StressCase {
  id: string;
  modelStatus: 'outside-stationary-common-scale-null-model';
  interpretation: string;
  generate(sequence: number): StressObservation;
}

const stressCases: readonly StressCase[] = [
  {
    id: 'linear-noise-slope-6db',
    modelStatus: 'outside-stationary-common-scale-null-model',
    interpretation: 'A deterministic 6 dB in-span receiver/noise slope. Any alarms quantify nonstationarity susceptibility.',
    generate: (sequence) => {
      const power = stationaryPowerMilliwatts(2_000_000 + sequence, 1, 3, 101)
        .map((value, index) => value * 10 ** ((-3 + 6 * index / (POINTS - 1)) / 10));
      return { sweep: sweepFromMilliwatts(`stress-slope-${sequence}`, sequence, power, 3), declaredDiscreteAnomalyIndices: [] };
    },
  },
  {
    id: 'within-sweep-gain-step-6db',
    modelStatus: 'outside-stationary-common-scale-null-model',
    interpretation: 'A 6 dB gain discontinuity at mid-span. It is not a common-scale null and is reported without a nominal false-alarm claim.',
    generate: (sequence) => {
      const power = stationaryPowerMilliwatts(3_000_000 + sequence, 1, 3, 103)
        .map((value, index) => index < CENTER_INDEX ? value : value * 10 ** 0.6);
      return { sweep: sweepFromMilliwatts(`stress-step-${sequence}`, sequence, power, 3), declaredDiscreteAnomalyIndices: [] };
    },
  },
  {
    id: 'two-declared-narrow-internal-spurs',
    modelStatus: 'outside-stationary-common-scale-null-model',
    interpretation: 'Two 18 dB narrow spurs are declared anomalies. Detections at them are expected; only detections away from them are counted as unexpected propagation.',
    generate: (sequence) => {
      const correlationWidth = 3;
      const power = stationaryPowerMilliwatts(4_000_000 + sequence, 6, correlationWidth, 107);
      const declaredDiscreteAnomalyIndices: number[] = [];
      for (const center of [120, 330]) for (let index = center - correlationWidth; index <= center + correlationWidth; index++) {
        power[index] = power[index]! + MEAN_NOISE_MILLIWATTS * 10 ** 1.8;
        declaredDiscreteAnomalyIndices.push(index);
      }
      return { sweep: sweepFromMilliwatts(`stress-spurs-${sequence}`, sequence, power, correlationWidth), declaredDiscreteAnomalyIndices };
    },
  },
  {
    id: 'rare-20db-impulsive-cells',
    modelStatus: 'outside-stationary-common-scale-null-model',
    interpretation: 'Rare high-power cells are observationally indistinguishable from narrow transient emissions in one sweep; response at declared impulses is diagnostic, not a false alarm.',
    generate: (sequence) => {
      const correlationWidth = 3;
      const power = stationaryPowerMilliwatts(5_000_000 + sequence, 6, correlationWidth, 109);
      const declaredDiscreteAnomalyIndices: number[] = [];
      for (let group = 0; group < Math.ceil(POINTS / correlationWidth); group++) {
        if (uniform(sequence, group, 0, 0x51f15e) >= 0.005) continue;
        for (let offset = 0; offset < correlationWidth; offset++) {
          const index = group * correlationWidth + offset;
          if (index >= POINTS) continue;
          power[index] = power[index]! + MEAN_NOISE_MILLIWATTS * 100;
          declaredDiscreteAnomalyIndices.push(index);
        }
      }
      return { sweep: sweepFromMilliwatts(`stress-impulsive-${sequence}`, sequence, power, correlationWidth), declaredDiscreteAnomalyIndices };
    },
  },
  {
    id: 'lognormal-textured-heavy-tail',
    modelStatus: 'outside-stationary-common-scale-null-model',
    interpretation: 'Exponential speckle under an 8 dB lognormal block texture approximates a heavy-tailed compound clutter field.',
    generate: (sequence) => {
      const correlationWidth = 3;
      const groups = Math.ceil(POINTS / correlationWidth);
      const groupPower = Array.from({ length: groups }, (_value, group) => {
        const textureDb = 8 * standardNormal(sequence, Math.floor(group / 4), 0x2c9277);
        return MEAN_NOISE_MILLIWATTS * gammaMeanOne(1, sequence, group, 113) * 10 ** (textureDb / 10);
      });
      const power = Array.from({ length: POINTS }, (_value, index) => groupPower[Math.floor(index / correlationWidth)]!);
      return { sweep: sweepFromMilliwatts(`stress-heavy-${sequence}`, sequence, power, correlationWidth), declaredDiscreteAnomalyIndices: [] };
    },
  },
];

const stressResults = stressCases.map((stressCase) => {
  let detections = 0;
  let sweepsWithDetection = 0;
  let detectionsAtDeclaredAnomalies = 0;
  let unexpectedDetections = 0;
  let sweepsWithoutDeclaredDiscreteAnomaly = 0;
  let anomalyFreeSweepsWithDetection = 0;
  for (let sequence = 0; sequence < STRESS_SWEEPS_PER_CASE; sequence++) {
    const observation = stressCase.generate(sequence);
    const values = permissiveDetector.analyze(observation.sweep);
    detections += values.length;
    if (values.length) sweepsWithDetection++;
    if (!observation.declaredDiscreteAnomalyIndices.length) {
      sweepsWithoutDeclaredDiscreteAnomaly++;
      if (values.length) anomalyFreeSweepsWithDetection++;
    }
    for (const value of values) {
      if (detectionTouchesDeclaredAnomaly(value, observation.sweep, observation.declaredDiscreteAnomalyIndices)) detectionsAtDeclaredAnomalies++;
      else unexpectedDetections++;
    }
  }
  return {
    id: stressCase.id,
    modelStatus: stressCase.modelStatus,
    interpretation: stressCase.interpretation,
    acceptanceRole: 'diagnostic-only-no-nominal-false-alarm-guarantee',
    sweeps: STRESS_SWEEPS_PER_CASE,
    detections,
    sweepsWithDetection,
    sweepDetectionRate: sweepsWithDetection / STRESS_SWEEPS_PER_CASE,
    pointwise95PercentWilsonInterval: wilsonInterval(sweepsWithDetection, STRESS_SWEEPS_PER_CASE, POINTWISE_WILSON_Z),
    detectionsAtDeclaredAnomalies,
    unexpectedDetections,
    sweepsWithoutDeclaredDiscreteAnomaly,
    anomalyFreeSweepsWithDetection,
  };
});

const gainInvarianceResults = configurations
  .filter((configuration) => configuration.shape === 1)
  .map((configuration) => {
    let comparisons = 0;
    let comparisonsWithDetections = 0;
    let topologyMismatches = 0;
    let maximumTailProbabilityDifference = 0;
    let maximumPosteriorDifference = 0;
    const examples: Array<{ trial: number; shiftDb: number; baseCount: number; shiftedCount: number }> = [];
    for (let trial = 0; trial < GAIN_INVARIANCE_SWEEPS_PER_CONFIGURATION; trial++) {
      const snrDb = trial % 2 === 0 ? Number.NEGATIVE_INFINITY : 20;
      const base = makeStationarySweep(6_000_000 + trial, configuration, snrDb, 8);
      const baseDetections = permissiveDetector.analyze(base);
      if (baseDetections.length) comparisonsWithDetections += 2;
      for (const shiftDb of [-30, 25]) {
        comparisons++;
        const shiftedDetections = permissiveDetector.analyze({
          ...base,
          id: `${base.id}-gain-${shiftDb}`,
          powerDbm: base.powerDbm.map((value) => value + shiftDb),
        });
        if (!sameDetectionTopology(baseDetections, shiftedDetections)) {
          topologyMismatches++;
          if (examples.length < 20) examples.push({ trial, shiftDb, baseCount: baseDetections.length, shiftedCount: shiftedDetections.length });
          continue;
        }
        for (let index = 0; index < baseDetections.length; index++) {
          maximumTailProbabilityDifference = Math.max(maximumTailProbabilityDifference, Math.abs(
            baseDetections[index]!.bayesianEvidence.posteriorPredictiveNullProbability
              - shiftedDetections[index]!.bayesianEvidence.posteriorPredictiveNullProbability,
          ));
          maximumPosteriorDifference = Math.max(maximumPosteriorDifference, Math.abs(
            baseDetections[index]!.bayesianEvidence.posteriorSignalProbability
              - shiftedDetections[index]!.bayesianEvidence.posteriorSignalProbability,
          ));
        }
      }
    }
    return {
      ...configuration,
      comparisons,
      comparisonsWithDetections,
      shiftsDb: [-30, 25],
      topologyMismatches,
      maximumTailProbabilityDifference,
      maximumPosteriorDifference,
      tolerance: SCALE_INVARIANCE_TOLERANCE,
      examples,
    };
  });

const nullDesignSufficient = NULL_SWEEPS_PER_CONFIGURATION >= MINIMUM_NULL_TRIALS_FOR_ZERO_EVENT_BOUND;
const nominalNullRateViolations = nullResults.filter((item) =>
  item.simultaneousFamily95PercentWilsonInterval.upper > BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability);
const sweepLocalPairedMonotonicityViolations = sweepLocalDetectionResults
  .reduce((sum, item) => sum + item.pairedMonotonicityViolations, 0);
const twoLookPairedMonotonicityViolations = twoLookTrackPromotionResults
  .reduce((sum, item) => sum + item.pairedMonotonicityViolations, 0);
const sweepLocalHighSnrDetectionViolations = sweepLocalDetectionResults.flatMap((item) => {
  const at15 = item.probabilityOfDetection['15']!;
  const at20 = item.probabilityOfDetection['20']!;
  const at25 = item.probabilityOfDetection['25']!;
  const at30 = item.probabilityOfDetection['30']!;
  return [
    at15.interval95Percent.lower < MINIMUM_PD_LOWER_95_AT_15_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 15, lower95: at15.interval95Percent.lower, required: MINIMUM_PD_LOWER_95_AT_15_DB }
      : undefined,
    at20.interval95Percent.lower < MINIMUM_PD_LOWER_95_AT_20_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 20, lower95: at20.interval95Percent.lower, required: MINIMUM_PD_LOWER_95_AT_20_DB }
      : undefined,
    at25.interval95Percent.lower < MINIMUM_PD_LOWER_95_AT_25_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 25, lower95: at25.interval95Percent.lower, required: MINIMUM_PD_LOWER_95_AT_25_DB }
      : undefined,
    at30.interval95Percent.lower < MINIMUM_PD_LOWER_95_AT_30_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 30, lower95: at30.interval95Percent.lower, required: MINIMUM_PD_LOWER_95_AT_30_DB }
      : undefined,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
});
const twoLookHighSnrPromotionViolations = twoLookTrackPromotionResults.flatMap((item) => {
  const at15 = item.probabilityOfDetection['15']!;
  const at20 = item.probabilityOfDetection['20']!;
  const at25 = item.probabilityOfDetection['25']!;
  const at30 = item.probabilityOfDetection['30']!;
  return [
    at15.interval95Percent.lower < MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_15_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 15, lower95: at15.interval95Percent.lower, required: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_15_DB }
      : undefined,
    at20.interval95Percent.lower < MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_20_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 20, lower95: at20.interval95Percent.lower, required: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_20_DB }
      : undefined,
    at25.interval95Percent.lower < MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_25_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 25, lower95: at25.interval95Percent.lower, required: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_25_DB }
      : undefined,
    at30.interval95Percent.lower < MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_30_DB
      ? { shape: item.shape, correlationWidth: item.correlationWidth, signalWidthRbw: item.signalWidthRbw, snrDb: 30, lower95: at30.interval95Percent.lower, required: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_30_DB }
      : undefined,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
});
const gainInvarianceViolations = gainInvarianceResults.filter((item) => item.topologyMismatches > 0
  || item.maximumTailProbabilityDifference > SCALE_INVARIANCE_TOLERANCE
  || item.maximumPosteriorDifference > SCALE_INVARIANCE_TOLERANCE);
const acceptanceFailures = [
  !nullDesignSufficient
    ? `null design has ${NULL_SWEEPS_PER_CONFIGURATION} trials/configuration; at least ${MINIMUM_NULL_TRIALS_FOR_ZERO_EVENT_BOUND} are required for a zero-event simultaneous-family Wilson upper bound <= ${BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability}`
    : undefined,
  nominalNullRateViolations.length
    ? `${nominalNullRateViolations.length} stationary Gamma configurations exceed the declared ideal-model ${BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability} simultaneous-family Wilson upper bound`
    : undefined,
  sweepLocalPairedMonotonicityViolations
    ? `${sweepLocalPairedMonotonicityViolations} sweep-local paired trials detected at a lower SNR but not the next higher SNR`
    : undefined,
  twoLookPairedMonotonicityViolations
    ? `${twoLookPairedMonotonicityViolations} two-look track-promotion paired trials promoted at a lower SNR but not the next higher SNR`
    : undefined,
  sweepLocalHighSnrDetectionViolations.length
    ? `${sweepLocalHighSnrDetectionViolations.length} sweep-local high-SNR pointwise Pd lower-confidence gates failed`
    : undefined,
  twoLookHighSnrPromotionViolations.length
    ? `${twoLookHighSnrPromotionViolations.length} two-look active-track high-SNR pointwise Pd lower-confidence gates failed`
    : undefined,
  gainInvarianceViolations.length
    ? `${gainInvarianceViolations.length} exact common-scale gain-invariance configurations failed`
    : undefined,
].filter((value): value is string => value !== undefined);

const report = {
  qualification: 'analytic-synthetic-development-validation-not-physical-calibration',
  interpretation: {
    nominalNull: 'The stationary common-scale Gamma family is exercised through the exact declared permissive high-candidate-load segmentation path; it is not claimed to be a superset of production segmentation. Shape 1 supplies exact exponential marginal draws, correlation width 1 is the exact iid cell model, and correlation width 3 is a perfect-block analytic correlation family whose RBW effective-count approximation is assessed empirically. Larger Gamma shapes are lower-variance averaged-power analytic stress variants, not a general proof of conservatism. The interval is a Bonferroni simultaneous-family 95% Wilson bound across all eight predeclared configurations.',
    sweepLocalProbabilityOfDetection: 'One-look Pd is the probability that the exact production sweep-local detector settings emit a threshold-connected local candidate containing the declared center before the runtime tracker promotion rule. Common random numbers provide pointwise monotonicity tests.',
    twoLookTrackPromotionProbabilityOfDetection: 'Two-look Pd passes two ordered independent analytic looks through the exact production detector and runtime tracker, then requires an active track containing the declared center after look two. Its engineering lower gates are the squares of the predeclared independent-look one-sweep gates.',
    probabilityConfidence: 'Every Pd interval and lower-confidence gate is pointwise for one shape, correlation width, signal width, and SNR cell. No simultaneous-family Pd confidence statement is made.',
    probabilityPrior: 'Both Pd matrices are conditional on the fixed 0.01 local-region prior, 0.99 posterior gate, and declared 18 dB-scale truncated positive-power-gain mixture. This validator does not establish detector-prior sensitivity or physical signal prevalence.',
    alternative: 'Alternative SNR is per-bin additive linear power relative to mean noise. It is not a synthesized RF waveform, protocol, receiver sensitivity, or field strength.',
    stress: 'Slope, in-span gain discontinuity, declared spurs, impulses, and compound heavy-tail clutter violate the stationary common-scale null. Their response is reported as susceptibility and is deliberately not laundered into a nominal false-alarm guarantee. A one-sweep scalar analyzer cannot distinguish a declared impulse or spur from a real narrow emission.',
    physical: 'No result is tinySA hardware calibration. Physical calibration still requires terminated-input and injected-signal captures across frequency, RBW, detector modes, temperature, attenuation, LNA, spurs, compression, and sweep timing.',
  },
  detector: BAYESIAN_DETECTOR_MODEL,
  validationConfigurations: { permissiveCfarConfig, productionDetectionConfig },
  matrix: {
    points: POINTS,
    binWidthHz: BIN_WIDTH_HZ,
    shapes: SHAPES,
    correlationWidths: CORRELATION_WIDTHS,
    nullFamilySize: NULL_FAMILY_SIZE,
    nullSweepsPerConfiguration: NULL_SWEEPS_PER_CONFIGURATION,
    minimumNullTrialsForZeroEventBound: MINIMUM_NULL_TRIALS_FOR_ZERO_EVENT_BOUND,
    simultaneousWilsonZ: SIMULTANEOUS_WILSON_Z,
    sweepLocalTrialsPerPoint: SIGNAL_SWEEPS_PER_POINT,
    twoLookTrackPromotionTrialsPerPoint: SIGNAL_SWEEPS_PER_POINT,
    analyticLooksPerTrackPromotionTrial: 2,
    signalSnrDb: SIGNAL_SNR_DB,
    signalWidthsRbw: SIGNAL_WIDTHS_RBW,
    stressSweepsPerCase: STRESS_SWEEPS_PER_CASE,
    gainInvarianceSweepsPerConfiguration: GAIN_INVARIANCE_SWEEPS_PER_CONFIGURATION,
  },
  nominalStationaryNull: {
    targetSweepFalseAlarmProbability: BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability,
    simultaneousFamilyConfidence: 0.95,
    segmentationScope: 'permissive-high-candidate-load-path-not-a-production-candidate-superset',
    designSufficient: nullDesignSufficient,
    nominalNullCells: NULL_SWEEPS_PER_CONFIGURATION * configurations.length * POINTS,
    effectiveNullCells: nullResults.reduce((sum, item) => sum + item.effectiveCells, 0),
    results: nullResults,
  },
  sweepLocalCandidateProbabilityOfDetection: {
    confidenceScope: 'pointwise-not-simultaneous',
    successCriterion: 'one-sweep-local-candidate-threshold-component-contains-declared-center-before-tracker-promotion',
    minimumLower95At15Db: MINIMUM_PD_LOWER_95_AT_15_DB,
    minimumLower95At20Db: MINIMUM_PD_LOWER_95_AT_20_DB,
    minimumLower95At25Db: MINIMUM_PD_LOWER_95_AT_25_DB,
    minimumLower95At30Db: MINIMUM_PD_LOWER_95_AT_30_DB,
    results: sweepLocalDetectionResults,
  },
  twoLookActiveTrackProbabilityOfDetection: {
    confidenceScope: 'pointwise-not-simultaneous',
    lookModel: 'two-ordered-independent-analytic-looks',
    successCriterion: 'active-runtime-track-threshold-component-contains-declared-center-after-exactly-two-looks',
    minimumLower95At15Db: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_15_DB,
    minimumLower95At20Db: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_20_DB,
    minimumLower95At25Db: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_25_DB,
    minimumLower95At30Db: MINIMUM_TWO_LOOK_PROMOTION_PD_LOWER_95_AT_30_DB,
    results: twoLookTrackPromotionResults,
  },
  commonScaleGainInvariance: gainInvarianceResults,
  outOfModelStressDiagnostics: stressResults,
  acceptance: {
    passed: acceptanceFailures.length === 0,
    failures: acceptanceFailures,
    nominalNullRateViolations,
    sweepLocalPairedMonotonicityViolations,
    twoLookPairedMonotonicityViolations,
    sweepLocalHighSnrDetectionViolations,
    twoLookHighSnrPromotionViolations,
    gainInvarianceViolations,
  },
};

console.log(JSON.stringify(report, null, 2));
if (acceptanceFailures.length) {
  console.error(`Bayesian detector validation failed:\n- ${acceptanceFailures.join('\n- ')}`);
  process.exitCode = 1;
}

function makeStationarySweep(
  sequence: number,
  configuration: Pick<StationaryConfiguration, 'shape' | 'correlationWidth'>,
  snrDb: number,
  signalWidthRbw: number,
): Sweep {
  const power = stationaryPowerMilliwatts(sequence, configuration.shape, configuration.correlationWidth, 0x407);
  if (Number.isFinite(snrDb)) {
    const signalBins = Math.max(1, Math.round(signalWidthRbw * configuration.correlationWidth));
    // Center the support on the frequency-grid midpoint. An odd support on an
    // even-point grid necessarily chooses one of the two central cells; the
    // declared policy selects the upper cell. Even supports remain exactly
    // symmetric about the midpoint between those cells.
    const first = Math.ceil((POINTS - signalBins) / 2);
    const last = first + signalBins - 1;
    const signalMilliwatts = MEAN_NOISE_MILLIWATTS * 10 ** (snrDb / 10);
    for (let index = first; index <= last; index++) power[index] = power[index]! + signalMilliwatts;
  }
  return sweepFromMilliwatts(
    `stationary-${configuration.shape}-${configuration.correlationWidth}-${sequence}-${snrDb}-${signalWidthRbw}`,
    sequence,
    power,
    configuration.correlationWidth,
  );
}

function stationaryPowerMilliwatts(sequence: number, shape: number, correlationWidth: number, salt: number): number[] {
  const groupNoise = Array.from({ length: Math.ceil(POINTS / correlationWidth) }, (_value, group) => gammaMeanOne(shape, sequence, group, salt));
  return Array.from({ length: POINTS }, (_value, index) => MEAN_NOISE_MILLIWATTS * groupNoise[Math.floor(index / correlationWidth)]!);
}

function sweepFromMilliwatts(id: string, sequence: number, powerMilliwatts: readonly number[], correlationWidth: number): Sweep {
  const actualRbwHz = BIN_WIDTH_HZ * correlationWidth;
  return {
    kind: 'spectrum', id, sequence, capturedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 50).toISOString(), elapsedMilliseconds: 50,
    frequencyHz: FREQUENCIES, powerDbm: powerMilliwatts.map((value) => 10 * Math.log10(Math.max(Number.MIN_VALUE, value))),
    requested: admittedSpectrum({ ...analyzer, rbwKhz: actualRbwHz / 1_000 }), actualStartHz: FREQUENCIES[0]!, actualStopHz: FREQUENCIES.at(-1)!, actualRbwHz,
    actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
  };
}

function admittedSpectrum(config: AnalyzerConfig): SweptSpectrumConfiguration {
  return {
    kind: 'swept-spectrum',
    startHz: config.startHz,
    stopHz: config.stopHz,
    points: config.points,
    sweepTimeSeconds: config.sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      acquisitionFormat: config.acquisitionFormat,
      resolutionBandwidthKhz: config.rbwKhz,
      attenuationDb: config.attenuationDb,
      detector: config.detector,
      spurRejection: config.spurRejection,
      lowNoiseAmplifier: config.lna,
      avoidSpurs: config.avoidSpurs,
      trigger: config.trigger,
    },
  };
}

function detectsTarget(values: readonly DetectedSignal[], targetHz: number): boolean {
  return values.some((value) => value.startHz <= targetHz && value.stopHz >= targetHz);
}

function detectsActiveTarget(values: readonly DetectedSignal[], targetHz: number): boolean {
  return values.some((value) => value.state === 'active'
    && value.startHz <= targetHz
    && value.stopHz >= targetHz);
}

function probabilityPoints(detectedBySnr: ReadonlyMap<number, number>): Record<string, ProbabilityPoint> {
  const probabilityOfDetection: Record<string, ProbabilityPoint> = {};
  for (const snrDb of SIGNAL_SNR_DB) {
    const detected = detectedBySnr.get(snrDb)!;
    probabilityOfDetection[String(snrDb)] = {
      trials: SIGNAL_SWEEPS_PER_POINT,
      detected,
      probability: detected / SIGNAL_SWEEPS_PER_POINT,
      interval95Percent: wilsonInterval(detected, SIGNAL_SWEEPS_PER_POINT, POINTWISE_WILSON_Z),
    };
  }
  return probabilityOfDetection;
}

function detectionTouchesDeclaredAnomaly(value: DetectedSignal, sweep: Sweep, anomalyIndices: readonly number[]): boolean {
  if (!anomalyIndices.length) return false;
  const toleranceBins = Math.max(2, Math.ceil(sweep.actualRbwHz / BIN_WIDTH_HZ) * 2);
  const peakIndex = Math.round((value.peakHz - sweep.actualStartHz) / BIN_WIDTH_HZ);
  return anomalyIndices.some((index) => Math.abs(index - peakIndex) <= toleranceBins);
}

function sameDetectionTopology(left: readonly DetectedSignal[], right: readonly DetectedSignal[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort((a, b) => a.startHz - b.startHz || a.peakHz - b.peakHz);
  const orderedRight = [...right].sort((a, b) => a.startHz - b.startHz || a.peakHz - b.peakHz);
  return orderedLeft.every((value, index) => value.startHz === orderedRight[index]!.startHz
    && value.stopHz === orderedRight[index]!.stopHz
    && value.peakHz === orderedRight[index]!.peakHz);
}

function gammaMeanOne(shape: number, sequence: number, group: number, salt: number): number {
  let total = 0;
  for (let look = 0; look < shape; look++) total += -Math.log(Math.max(Number.EPSILON, uniform(sequence, group, look, salt ^ Math.imul(look + 1, 0x9e3779b9))));
  return total / shape;
}

function uniform(sequence: number, group: number, look: number, salt: number): number {
  let value = (Math.imul(sequence + 1, 0x9e3779b1) ^ Math.imul(group + 11, 0x85ebca6b) ^ Math.imul(look + 101, 0xc2b2ae35) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  value ^= value >>> 15;
  return ((value >>> 0) + 0.5) / 0x1_0000_0000;
}

function standardNormal(sequence: number, group: number, salt: number): number {
  const left = uniform(sequence, group, 0, salt);
  const right = uniform(sequence, group, 1, salt ^ 0x68bc21eb);
  return Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, left))) * Math.cos(2 * Math.PI * right);
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function wilsonInterval(successes: number, trials: number, z: number): { lower: number; upper: number } {
  const estimate = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = (estimate + z * z / (2 * trials)) / denominator;
  const margin = z / denominator * Math.sqrt(estimate * (1 - estimate) / trials + z * z / (4 * trials * trials));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}
