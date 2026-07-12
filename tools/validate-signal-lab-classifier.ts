import { SignalDetector, SignalLabBayesianClassifier, signalLabWaveformHypotheses } from '../packages/analysis/src/index.js';
import { waveformCatalog, synthesizeSpectrum, synthesizeZeroSpan } from '../../TinySA_SignalLab/src/waveforms.js';
import type { AnalyzerConfig, DetectedSignal, DeviceIdentity, Sweep, ZeroSpanCapture } from '../packages/contracts/src/index.js';

const identity = {
  model: 'SignalLab corpus fixture', hardwareVersion: 'offline', firmwareVersion: 'offline', firmwareSourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671',
  firmwareQualification: 'protocol-test',
  port: { id: 'offline', path: 'offline://signal-lab', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
  simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
} as DeviceIdentity;
const detector = new SignalDetector({ threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumProminenceDb: 6, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 2 });
const classifier = new SignalLabBayesianClassifier();
const hypothesisById = new Map(signalLabWaveformHypotheses.map((item) => [item.id, item]));
const cases: Array<{ profile: string; expectedFamily: string; result: string; decision: string; confidence: number; candidates: readonly { label: string; confidence: number }[]; features?: Readonly<Record<string, number>> }> = [];

for (const descriptor of waveformCatalog) {
  const startHz = Math.round(descriptor.centerHz - descriptor.recommendedSpanHz / 2);
  const stopHz = Math.round(descriptor.centerHz + descriptor.recommendedSpanHz / 2);
  const analyzer = analyzerFor(startHz, stopHz);
  const sweeps = Array.from({ length: 12 }, (_, index) => spectrumSweep(descriptor.id, analyzer, index));
  const detections = sweeps.flatMap((sweep) => detector.analyze(sweep).map((detection) => ({ sweep, detection })))
    .filter(({ detection }) => Math.abs(detection.peakHz - descriptor.centerHz) <= descriptor.recommendedSpanHz / 2);
  if (!detections.length) throw new Error(`${descriptor.id} produced no detected measurement evidence`);
  const detection = aggregateDetection(descriptor.id, detections.map((item) => item.detection), sweeps);
  const zeroSpan = zeroSpanCapture(descriptor.id, detection.peakHz, 0);
  const result = await classifier.classify(detection, { sweeps, zeroSpan });
  cases.push({ profile: descriptor.id, expectedFamily: descriptor.family, result: result.label, decision: result.decisionLevel, confidence: result.confidence, candidates: result.candidates.slice(0, 3), features: result.evidence.features });
}

const correctFamily = cases.filter((item) => inferredFamily(item.result) === item.expectedFamily).length;
const exact = cases.filter((item) => item.result === `signal-lab:${item.profile}`).length;
const unknown = cases.filter((item) => item.result === 'unknown');
const openSet = [] as Array<{ range: string; result: string; confidence: number; modelTopLogLikelihood?: number }>;
for (const reference of [waveformCatalog[0]!, waveformCatalog.find((item) => item.id === 'lte-etm1.1')!, waveformCatalog.find((item) => item.id === 'nr-fr1-tm1.1')!, waveformCatalog.find((item) => item.id === 'wifi6-he-su')!]) {
  const startHz = Math.round(reference.centerHz - reference.recommendedSpanHz / 2);
  const stopHz = Math.round(reference.centerHz + reference.recommendedSpanHz / 2);
  const analyzer = analyzerFor(startHz, stopHz);
  const sweeps = Array.from({ length: 12 }, (_, index) => spectrumSweep('survey', analyzer, index));
  const bySweep = sweeps.map((sweep) => detector.analyze(sweep));
  for (let signalIndex = 0; signalIndex < Math.min(...bySweep.map((items) => items.length)); signalIndex++) {
    const values = bySweep.map((items) => items[signalIndex]!);
    const result = await classifier.classify(aggregateDetection(`open-${reference.id}-${signalIndex}`, values, sweeps), { sweeps });
    openSet.push({ range: reference.id, result: result.label, confidence: result.confidence, modelTopLogLikelihood: result.evidence.features?.modelTopLogLikelihood });
  }
}
const openSetRejected = openSet.filter((item) => item.result === 'unknown').length;
const report = {
  model: classifier.modelId,
  profiles: cases.length,
  exact,
  familyCorrect: correctFamily,
  familyAccuracy: correctFamily / cases.length,
  unknown: unknown.length,
  knownTopLogLikelihood: range(cases.map((item) => item.features?.modelTopLogLikelihood).filter((value): value is number => typeof value === 'number')),
  failures: cases.filter((item) => inferredFamily(item.result) !== item.expectedFamily),
  openSet: { samples: openSet.length, rejected: openSetRejected, rejectionRate: openSetRejected / Math.max(1, openSet.length), accepted: openSet.filter((item) => item.result !== 'unknown') },
};
console.log(JSON.stringify(report, null, 2));
if (cases.length !== 79 || correctFamily / cases.length < 0.95 || openSetRejected / Math.max(1, openSet.length) < 0.7) process.exitCode = 1;

function spectrumSweep(profile: Parameters<typeof synthesizeSpectrum>[0]['profile'], analyzer: AnalyzerConfig, sweepIndex: number): Sweep {
  const frequencyHz = Array.from({ length: analyzer.points }, (_, index) => analyzer.startHz + (analyzer.stopHz - analyzer.startHz) * index / (analyzer.points - 1));
  return {
    kind: 'spectrum', id: `${profile}-${sweepIndex}`, sequence: sweepIndex + 1, capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sweepIndex)).toISOString(), elapsedMilliseconds: 50,
    frequencyHz,
    powerDbm: synthesizeSpectrum({ profile, startHz: analyzer.startHz, stopHz: analyzer.stopHz, points: analyzer.points, sweepIndex, channel: { model: 'awgn', noiseFloorDbm: -108, seed: 407, fadingRateHz: 2 } }),
    requested: analyzer, actualStartHz: analyzer.startHz, actualStopHz: analyzer.stopHz, actualRbwHz: (analyzer.stopHz - analyzer.startHz) / (analyzer.points - 1), actualAttenuationDb: 0,
    source: 'scan-text', complete: true, identity,
  };
}

function zeroSpanCapture(profile: Parameters<typeof synthesizeZeroSpan>[0]['profile'], frequencyHz: number, sweepIndex: number): ZeroSpanCapture {
  const points = 450;
  const sweepTimeSeconds = 0.45;
  return {
    kind: 'zero-span', id: `zero-${profile}`, sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: 450,
    frequencyHz, samplePeriodSeconds: sweepTimeSeconds / points,
    powerDbm: synthesizeZeroSpan({ profile, points, sweepIndex, channel: { model: 'awgn', noiseFloorDbm: -108, seed: 407, fadingRateHz: 2 } }),
    requested: { frequencyHz, points, rbwKhz: 100, attenuationDb: 'auto', sweepTimeSeconds, trigger: { mode: 'auto' } },
    actualRbwHz: 100_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
  };
}

function aggregateDetection(profile: string, values: readonly DetectedSignal[], sweeps: readonly Sweep[]): DetectedSignal {
  const sorted = [...values].sort((left, right) => right.peakDbm - left.peakDbm);
  const representative = sorted[0]!;
  return {
    ...representative,
    id: `observed-${profile}`,
    startHz: median(values.map((value) => value.startHz)),
    stopHz: median(values.map((value) => value.stopHz)),
    bandwidthHz: median(values.map((value) => value.bandwidthHz)),
    sweepIds: sweeps.map((sweep) => sweep.id),
    persistenceSweeps: values.length,
    state: 'active',
  };
}

function analyzerFor(startHz: number, stopHz: number): AnalyzerConfig {
  return { startHz, stopHz, points: 450, acquisitionFormat: 'text', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } };
}

function inferredFamily(label: string): string | undefined {
  if (label.startsWith('signal-lab-family:')) return label.slice('signal-lab-family:'.length);
  if (!label.startsWith('signal-lab:')) return undefined;
  return hypothesisById.get(label.slice('signal-lab:'.length))?.family;
}

function median(values: readonly number[]): number { const ordered = [...values].sort((left, right) => left - right); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2; }
function range(values: readonly number[]) { return { minimum: Math.min(...values), median: median(values), maximum: Math.max(...values) }; }
