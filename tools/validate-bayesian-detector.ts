import { BAYESIAN_DETECTOR_MODEL, SignalDetector } from '../packages/analysis/src/index.js';
import type { AnalyzerConfig, DetectedSignal, DeviceIdentity, SignalDetectionConfig, Sweep } from '../packages/contracts/src/index.js';

const POINTS = 450;
const BIN_WIDTH_HZ = 10_000;
const CENTER_INDEX = Math.floor(POINTS / 2);
const MEAN_NOISE_DBM = -110;
const MEAN_NOISE_MILLIWATTS = 10 ** (MEAN_NOISE_DBM / 10);
const SHAPES = [1, 2, 6, 12] as const;
const CORRELATION_WIDTHS = [1, 3] as const;
const SIGNAL_SNR_DB = [0, 5, 10, 15, 20, 25, 30] as const;
const SIGNAL_WIDTHS_RBW = [1, 8] as const;
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
  // This deliberately weak prefilter exposes the Bayesian gate to more null
  // candidates than the production 10 dB / 6 dB configuration.
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
  modelRole: 'exact-exponential' | 'conservative-gamma-average';
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
  modelRole: shape === 1 ? 'exact-exponential' as const : 'conservative-gamma-average' as const,
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

const detectionResults = configurations.flatMap((configuration) => SIGNAL_WIDTHS_RBW.map((signalWidthRbw) => {
  const detectedBySnr = new Map<number, number>(SIGNAL_SNR_DB.map((snrDb) => [snrDb, 0]));
  let pairedMonotonicityViolations = 0;
  const pairedMonotonicityExamples: Array<{ trial: number; lowerSnrDb: number; higherSnrDb: number }> = [];
  for (let trial = 0; trial < SIGNAL_SWEEPS_PER_POINT; trial++) {
    let previousDetected = false;
    for (const [snrIndex, snrDb] of SIGNAL_SNR_DB.entries()) {
      // Common random numbers make this a pointwise monotonicity test rather
      // than a comparison of two noisy Monte Carlo proportions.
      const sweep = makeStationarySweep(1_000_000 + trial, configuration, snrDb, signalWidthRbw);
      const detected = detectsTarget(productionDetector.analyze(sweep), sweep.frequencyHz[CENTER_INDEX]!);
      if (detected) detectedBySnr.set(snrDb, detectedBySnr.get(snrDb)! + 1);
      if (snrIndex > 0 && previousDetected && !detected) {
        pairedMonotonicityViolations++;
        if (pairedMonotonicityExamples.length < 20) pairedMonotonicityExamples.push({
          trial,
          lowerSnrDb: SIGNAL_SNR_DB[snrIndex - 1]!,
          higherSnrDb: snrDb,
        });
      }
      previousDetected = detected;
    }
  }
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
  return {
    ...configuration,
    signalWidthRbw,
    signalDefinition: 'constant per-bin signal power relative to mean noise power',
    probabilityOfDetection,
    pairedMonotonicityViolations,
    pairedMonotonicityExamples,
  };
}));

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
const pairedMonotonicityViolations = detectionResults.reduce((sum, item) => sum + item.pairedMonotonicityViolations, 0);
const highSnrDetectionViolations = detectionResults.flatMap((item) => {
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
const gainInvarianceViolations = gainInvarianceResults.filter((item) => item.topologyMismatches > 0
  || item.maximumTailProbabilityDifference > SCALE_INVARIANCE_TOLERANCE
  || item.maximumPosteriorDifference > SCALE_INVARIANCE_TOLERANCE);
const acceptanceFailures = [
  !nullDesignSufficient
    ? `null design has ${NULL_SWEEPS_PER_CONFIGURATION} trials/configuration; at least ${MINIMUM_NULL_TRIALS_FOR_ZERO_EVENT_BOUND} are required for a zero-event simultaneous-family Wilson upper bound <= ${BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability}`
    : undefined,
  nominalNullRateViolations.length
    ? `${nominalNullRateViolations.length} stationary Gamma configurations exceed the actual ${BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability} simultaneous-family Wilson upper bound`
    : undefined,
  pairedMonotonicityViolations
    ? `${pairedMonotonicityViolations} paired trials detected at a lower SNR but not the next higher SNR`
    : undefined,
  highSnrDetectionViolations.length
    ? `${highSnrDetectionViolations.length} high-SNR Pd lower-confidence gates failed`
    : undefined,
  gainInvarianceViolations.length
    ? `${gainInvarianceViolations.length} exact common-scale gain-invariance configurations failed`
    : undefined,
].filter((value): value is string => value !== undefined);

const report = {
  qualification: 'analytic-synthetic-development-validation-not-physical-calibration',
  interpretation: {
    nominalNull: 'Only the stationary common-scale Gamma family with RBW-matched block correlation is used for acceptance of the 0.001 sweep false-alarm target. Shape 1 is the detector\'s exact exponential model; larger shapes are conservative averaged-power variants. The interval is a Bonferroni simultaneous-family 95% Wilson bound across all eight predeclared configurations.',
    probabilityOfDetection: 'Pd is measured through the exact production detector configuration for two predeclared signal widths. Common random numbers provide a pointwise monotonicity test. These SNRs are per-bin additive signal power relative to mean noise, not receiver sensitivity or field strength.',
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
    signalSweepsPerPoint: SIGNAL_SWEEPS_PER_POINT,
    signalSnrDb: SIGNAL_SNR_DB,
    signalWidthsRbw: SIGNAL_WIDTHS_RBW,
    stressSweepsPerCase: STRESS_SWEEPS_PER_CASE,
    gainInvarianceSweepsPerConfiguration: GAIN_INVARIANCE_SWEEPS_PER_CONFIGURATION,
  },
  nominalStationaryNull: {
    targetSweepFalseAlarmProbability: BAYESIAN_DETECTOR_MODEL.targetSweepFalseAlarmProbability,
    simultaneousFamilyConfidence: 0.95,
    designSufficient: nullDesignSufficient,
    nominalNullCells: NULL_SWEEPS_PER_CONFIGURATION * configurations.length * POINTS,
    effectiveNullCells: nullResults.reduce((sum, item) => sum + item.effectiveCells, 0),
    results: nullResults,
  },
  probabilityOfDetection: {
    minimumLower95At15Db: MINIMUM_PD_LOWER_95_AT_15_DB,
    minimumLower95At20Db: MINIMUM_PD_LOWER_95_AT_20_DB,
    minimumLower95At25Db: MINIMUM_PD_LOWER_95_AT_25_DB,
    minimumLower95At30Db: MINIMUM_PD_LOWER_95_AT_30_DB,
    results: detectionResults,
  },
  commonScaleGainInvariance: gainInvarianceResults,
  outOfModelStressDiagnostics: stressResults,
  acceptance: {
    passed: acceptanceFailures.length === 0,
    failures: acceptanceFailures,
    nominalNullRateViolations,
    pairedMonotonicityViolations,
    highSnrDetectionViolations,
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
    const first = CENTER_INDEX - Math.floor((signalBins - 1) / 2);
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
    kind: 'spectrum', id, sequence, capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60)).toISOString(), elapsedMilliseconds: 50,
    frequencyHz: FREQUENCIES, powerDbm: powerMilliwatts.map((value) => 10 * Math.log10(Math.max(Number.MIN_VALUE, value))),
    requested: { ...analyzer, rbwKhz: actualRbwHz / 1_000 }, actualStartHz: FREQUENCIES[0]!, actualStopHz: FREQUENCIES.at(-1)!, actualRbwHz,
    actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
  };
}

function detectsTarget(values: readonly DetectedSignal[], targetHz: number): boolean {
  return values.some((value) => value.startHz <= targetHz && value.stopHz >= targetHz);
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
