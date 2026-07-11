import type {
  AnalysisModeDefinition,
  DetectedSignal,
  SignalDetectionConfig,
  Sweep,
  WaveformClassification,
  ZeroSpanCapture,
} from '@tinysa/contracts';

export const analysisModes: readonly AnalysisModeDefinition[] = [
  { id: 'signal-detection', name: 'Signal Detection', description: 'Detect and persist emissions above an absolute or robust adaptive noise floor.', status: 'available', requiredCapabilities: ['scan'] },
  { id: 'waveform-classification', name: 'Waveform Classification', description: 'Classify observable spectral morphology and zero-span envelope behavior with explicit unknown results.', status: 'experimental', requiredCapabilities: ['scan'] },
];

const DEFAULT_DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};

export class SignalDetector {
  static readonly id = 'robust-contiguous-v2';
  constructor(private config: SignalDetectionConfig = DEFAULT_DETECTION_CONFIG) {}
  configure(config: SignalDetectionConfig): void { this.config = structuredClone(config); }
  get configuration(): SignalDetectionConfig { return structuredClone(this.config); }

  analyze(sweep: Sweep): readonly DetectedSignal[] {
    validateSweep(sweep);
    const noiseFloorDbm = robustNoiseFloor(sweep.powerDbm);
    const thresholdDbm = this.config.threshold.strategy === 'absolute'
      ? this.config.threshold.levelDbm
      : noiseFloorDbm + this.config.threshold.marginDb;
    const groups: Array<{ start: number; end: number }> = [];
    let start: number | undefined;
    for (let index = 0; index < sweep.powerDbm.length; index++) {
      if (sweep.powerDbm[index]! >= thresholdDbm && start === undefined) start = index;
      if ((sweep.powerDbm[index]! < thresholdDbm || index === sweep.powerDbm.length - 1) && start !== undefined) {
        const end = sweep.powerDbm[index]! >= thresholdDbm ? index : index - 1;
        groups.push({ start, end });
        start = undefined;
      }
    }
    return groups.map(({ start: first, end: last }, index) => {
      let peak = first;
      for (let cursor = first + 1; cursor <= last; cursor++) if (sweep.powerDbm[cursor]! > sweep.powerDbm[peak]!) peak = cursor;
      const startHz = sweep.frequencyHz[first]!;
      const stopHz = sweep.frequencyHz[last]!;
      const qualityFlags: DetectedSignal['qualityFlags'][number][] = [];
      if (first === 0) qualityFlags.push('touches-lower-boundary');
      if (last === sweep.frequencyHz.length - 1) qualityFlags.push('touches-upper-boundary');
      if (first === last) qualityFlags.push('single-bin');
      return {
        id: `${sweep.id}:candidate-${index}`,
        startHz,
        stopHz,
        peakHz: sweep.frequencyHz[peak]!,
        peakDbm: sweep.powerDbm[peak]!,
        bandwidthHz: Math.max(0, stopHz - startHz),
        thresholdDbm,
        noiseFloorDbm,
        firstSeenAt: sweep.capturedAt,
        lastSeenAt: sweep.capturedAt,
        sweepIds: [sweep.id],
        persistenceSweeps: 1,
        missedSweeps: 0,
        state: this.config.minimumConsecutiveSweeps <= 1 ? 'active' : 'candidate',
        detectorId: SignalDetector.id,
        detectorConfig: structuredClone(this.config),
        qualityFlags,
      } satisfies DetectedSignal;
    }).filter((signal) => signal.bandwidthHz >= this.config.minimumBandwidthHz);
  }
}

interface Track { signal: DetectedSignal; released: boolean; }
export class SignalTracker {
  #tracks = new Map<string, Track>();
  #nextId = 1;
  constructor(private config: SignalDetectionConfig = DEFAULT_DETECTION_CONFIG) {}

  configure(config: SignalDetectionConfig): void {
    this.config = structuredClone(config);
    this.reset();
  }

  reset(): void { this.#tracks.clear(); this.#nextId = 1; }

  update(sweep: Sweep, candidates: readonly DetectedSignal[]): readonly DetectedSignal[] {
    validateSweep(sweep);
    const unmatchedTracks = new Set(this.#tracks.keys());
    const usedCandidates = new Set<number>();
    const matches: Array<{ trackId: string; candidateIndex: number; score: number }> = [];
    for (const [trackId, track] of this.#tracks) {
      candidates.forEach((candidate, candidateIndex) => {
        const score = matchScore(track.signal, candidate, sweep);
        if (score >= 0) matches.push({ trackId, candidateIndex, score });
      });
    }
    matches.sort((left, right) => right.score - left.score);
    for (const match of matches) {
      if (!unmatchedTracks.has(match.trackId) || usedCandidates.has(match.candidateIndex)) continue;
      const track = this.#tracks.get(match.trackId)!;
      track.signal = mergeSignal(track.signal, candidates[match.candidateIndex]!, sweep, this.config);
      track.released = false;
      unmatchedTracks.delete(match.trackId);
      usedCandidates.add(match.candidateIndex);
    }

    candidates.forEach((candidate, index) => {
      if (usedCandidates.has(index)) return;
      const id = `signal-${String(this.#nextId++).padStart(4, '0')}`;
      this.#tracks.set(id, {
        released: false,
        signal: {
          ...candidate,
          id,
          state: this.config.minimumConsecutiveSweeps <= 1 ? 'active' : 'candidate',
          detectorConfig: structuredClone(this.config),
        },
      });
    });

    for (const trackId of unmatchedTracks) {
      const track = this.#tracks.get(trackId)!;
      const missedSweeps = track.signal.missedSweeps + 1;
      if (missedSweeps > this.config.releaseAfterMissedSweeps) {
        track.signal = { ...track.signal, missedSweeps, state: 'released' };
        track.released = true;
      } else {
        track.signal = { ...track.signal, missedSweeps };
      }
    }

    const result = [...this.#tracks.values()].map((track) => structuredClone(track.signal));
    for (const [trackId, track] of this.#tracks) if (track.released) this.#tracks.delete(trackId);
    return result.sort((left, right) => right.peakDbm - left.peakDbm);
  }
}

export interface SweepMetrics {
  peakDbm: number;
  peakHz: number;
  minimumDbm: number;
  meanDbm: number;
  medianDbm: number;
  noiseFloorDbm: number;
  summedPowerDbm: number;
  occupiedBandwidth99Hz: number;
  crestFactorDb: number;
}

export function calculateSweepMetrics(sweep: Sweep): SweepMetrics {
  validateSweep(sweep);
  let peakIndex = 0;
  let minimumDbm = Number.POSITIVE_INFINITY;
  let linearSumMilliwatts = 0;
  for (let index = 0; index < sweep.powerDbm.length; index++) {
    const value = sweep.powerDbm[index]!;
    if (value > sweep.powerDbm[peakIndex]!) peakIndex = index;
    minimumDbm = Math.min(minimumDbm, value);
    linearSumMilliwatts += dbmToMilliwatts(value);
  }
  const meanMilliwatts = linearSumMilliwatts / sweep.powerDbm.length;
  const meanDbm = milliwattsToDbm(meanMilliwatts);
  return {
    peakDbm: sweep.powerDbm[peakIndex]!,
    peakHz: sweep.frequencyHz[peakIndex]!,
    minimumDbm,
    meanDbm,
    medianDbm: median(sweep.powerDbm),
    noiseFloorDbm: robustNoiseFloor(sweep.powerDbm),
    summedPowerDbm: milliwattsToDbm(linearSumMilliwatts),
    occupiedBandwidth99Hz: occupiedBandwidth(sweep, 0.99),
    crestFactorDb: sweep.powerDbm[peakIndex]! - meanDbm,
  };
}

export interface AnalysisModePlugin<Config, Input, Result> {
  readonly definition: AnalysisModeDefinition;
  readonly configSchemaVersion: number;
  readonly resultSchemaVersion: number;
  validateConfig(input: unknown): Config;
  analyze(input: Input, config: Config, signal: AbortSignal): Promise<Result>;
}

export interface WaveformClassifier {
  readonly modelId: string;
  classify(detection: DetectedSignal, sweep: Sweep, signal?: AbortSignal): Promise<WaveformClassification>;
}

export class SpectralMorphologyClassifier implements WaveformClassifier {
  readonly modelId = 'spectral-morphology-v1';

  async classify(detection: DetectedSignal, sweep: Sweep, signal?: AbortSignal): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    validateSweep(sweep);
    if (!detection.sweepIds.includes(sweep.id)) return unknownClassification(detection, this.modelId, 'insufficient-evidence');
    const indices = sweep.frequencyHz.map((frequency, index) => ({ frequency, index }))
      .filter(({ frequency }) => frequency >= detection.startHz && frequency <= detection.stopHz)
      .map(({ index }) => index);
    if (!indices.length) return unknownClassification(detection, this.modelId, 'insufficient-evidence');
    const values = indices.map((index) => sweep.powerDbm[index]!);
    const binWidthHz = sweep.frequencyHz.length > 1 ? Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!) : 0;
    const features = {
      bins: values.length,
      binWidthHz,
      bandwidthHz: detection.bandwidthHz,
      prominenceDb: detection.peakDbm - detection.noiseFloorDbm,
      flatness: spectralFlatness(values),
      localPeaks: countLocalPeaks(values, detection.noiseFloorDbm + 6),
      occupiedFraction: detection.bandwidthHz / Math.max(1, sweep.actualStopHz - sweep.actualStartHz),
    };
    const scores = [
      { label: 'narrowband-carrier', score: clamp01((4 - features.bins) / 3) * 0.55 + clamp01(features.prominenceDb / 30) * 0.45 },
      { label: 'multi-carrier', score: clamp01((features.localPeaks - 1) / 3) * 0.75 + clamp01(features.prominenceDb / 25) * 0.25 },
      { label: 'wideband-noise-like', score: clamp01((features.bins - 5) / 12) * 0.45 + features.flatness * 0.55 },
      { label: 'band-limited-emission', score: clamp01((features.bins - 2) / 8) * 0.55 + (1 - features.flatness) * 0.2 + clamp01(features.prominenceDb / 25) * 0.25 },
    ];
    const total = scores.reduce((sum, item) => sum + Math.max(0.0001, item.score), 0);
    const candidates = scores.map((item) => ({ label: item.label, confidence: Math.max(0.0001, item.score) / total }))
      .sort((left, right) => right.confidence - left.confidence);
    const top = candidates[0]!;
    const common = {
      detectionId: detection.id,
      candidates,
      modelId: this.modelId,
      classifiedAt: new Date().toISOString(),
      evidence: {
        centerHz: (detection.startHz + detection.stopHz) / 2,
        bandwidthHz: detection.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: detection.sweepIds,
        features,
      },
    };
    if (top.confidence < 0.42 || features.prominenceDb < 6) {
      return { ...common, label: 'unknown', confidence: top.confidence, unknownReason: 'low-confidence' };
    }
    return { ...common, label: top.label, confidence: top.confidence };
  }
}

export class UnknownClassifier implements WaveformClassifier {
  readonly modelId = 'unconfigured';
  async classify(detection: DetectedSignal): Promise<WaveformClassification> {
    return unknownClassification(detection, this.modelId, 'model-unavailable');
  }
}

export interface EnvelopeClassification {
  label: 'steady-envelope' | 'amplitude-modulated' | 'pulsed-envelope' | 'unknown';
  confidence: number;
  modelId: 'zero-span-envelope-v1';
  features: {
    peakToPeakDb: number;
    standardDeviationDb: number;
    dutyCycle: number;
    transitionCount: number;
    dominantLagSamples: number;
  };
}

export function classifyZeroSpanEnvelope(capture: ZeroSpanCapture): EnvelopeClassification {
  if (capture.powerDbm.length < 20 || capture.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Zero-span classification requires at least 20 finite power samples');
  }
  const minimum = Math.min(...capture.powerDbm);
  const maximum = Math.max(...capture.powerDbm);
  const mean = capture.powerDbm.reduce((sum, value) => sum + value, 0) / capture.powerDbm.length;
  const variance = capture.powerDbm.reduce((sum, value) => sum + (value - mean) ** 2, 0) / capture.powerDbm.length;
  const threshold = minimum + (maximum - minimum) * 0.6;
  const high = capture.powerDbm.map((value) => value >= threshold);
  const dutyCycle = high.filter(Boolean).length / high.length;
  let transitionCount = 0;
  for (let index = 1; index < high.length; index++) if (high[index] !== high[index - 1]) transitionCount++;
  const features = {
    peakToPeakDb: maximum - minimum,
    standardDeviationDb: Math.sqrt(variance),
    dutyCycle,
    transitionCount,
    dominantLagSamples: dominantAutocorrelationLag(capture.powerDbm),
  };
  if (features.peakToPeakDb < 2 && features.standardDeviationDb < 0.8) return { label: 'steady-envelope', confidence: 0.92, modelId: 'zero-span-envelope-v1', features };
  if (features.peakToPeakDb >= 8 && dutyCycle > 0.05 && dutyCycle < 0.45 && transitionCount >= 2) return { label: 'pulsed-envelope', confidence: clamp01(0.55 + features.peakToPeakDb / 50), modelId: 'zero-span-envelope-v1', features };
  if (features.peakToPeakDb >= 3 && features.dominantLagSamples > 0) return { label: 'amplitude-modulated', confidence: clamp01(0.5 + features.standardDeviationDb / 15), modelId: 'zero-span-envelope-v1', features };
  return { label: 'unknown', confidence: 0.35, modelId: 'zero-span-envelope-v1', features };
}

export function robustNoiseFloor(values: readonly number[]): number {
  if (!values.length) throw new Error('Noise-floor estimation requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  const cutoff = Math.max(1, Math.floor(sorted.length * 0.6));
  return median(sorted.slice(0, cutoff));
}

function mergeSignal(previous: DetectedSignal, candidate: DetectedSignal, sweep: Sweep, config: SignalDetectionConfig): DetectedSignal {
  const persistenceSweeps = previous.persistenceSweeps + 1;
  return {
    ...candidate,
    id: previous.id,
    firstSeenAt: previous.firstSeenAt,
    lastSeenAt: sweep.capturedAt,
    sweepIds: [...previous.sweepIds, sweep.id].slice(-64),
    persistenceSweeps,
    missedSweeps: 0,
    state: persistenceSweeps >= config.minimumConsecutiveSweeps ? 'active' : 'candidate',
    detectorConfig: structuredClone(config),
  };
}

function matchScore(previous: DetectedSignal, candidate: DetectedSignal, sweep: Sweep): number {
  const overlap = Math.max(0, Math.min(previous.stopHz, candidate.stopHz) - Math.max(previous.startHz, candidate.startHz));
  const union = Math.max(previous.stopHz, candidate.stopHz) - Math.min(previous.startHz, candidate.startHz);
  const intersectionOverUnion = union > 0 ? overlap / union : previous.peakHz === candidate.peakHz ? 1 : 0;
  const binWidth = sweep.frequencyHz.length > 1 ? Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!) : 1;
  const centerDistance = Math.abs(previous.peakHz - candidate.peakHz);
  const tolerance = Math.max(binWidth * 3, previous.bandwidthHz, candidate.bandwidthHz, 1);
  if (intersectionOverUnion === 0 && centerDistance > tolerance) return -1;
  return intersectionOverUnion * 0.7 + (1 - Math.min(1, centerDistance / tolerance)) * 0.3;
}

function validateSweep(sweep: Sweep): void {
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('Sweep frequency and power arrays have different lengths');
  if (sweep.powerDbm.length === 0) throw new Error('Sweep contains no measurement points');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Sweep contains non-finite measurement values');
  for (let index = 1; index < sweep.frequencyHz.length; index++) if (sweep.frequencyHz[index]! < sweep.frequencyHz[index - 1]!) throw new Error('Sweep frequencies are not monotonic');
}

function unknownClassification(detection: DetectedSignal, modelId: string, unknownReason: WaveformClassification['unknownReason']): WaveformClassification {
  return {
    detectionId: detection.id,
    label: 'unknown',
    confidence: 0,
    candidates: [],
    modelId,
    unknownReason,
    classifiedAt: new Date().toISOString(),
    evidence: {
      centerHz: (detection.startHz + detection.stopHz) / 2,
      bandwidthHz: detection.bandwidthHz,
      peakDbm: detection.peakDbm,
      sweepIds: detection.sweepIds,
    },
  };
}

function occupiedBandwidth(sweep: Sweep, fraction: number): number {
  const floorMilliwatts = dbmToMilliwatts(robustNoiseFloor(sweep.powerDbm));
  const corrected = sweep.powerDbm.map((value) => Math.max(0, dbmToMilliwatts(value) - floorMilliwatts));
  const total = corrected.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const tail = (1 - fraction) / 2;
  let cumulative = 0;
  let lower = 0;
  let upper = corrected.length - 1;
  for (let index = 0; index < corrected.length; index++) {
    cumulative += corrected[index]!;
    if (cumulative / total >= tail) { lower = index; break; }
  }
  cumulative = 0;
  for (let index = corrected.length - 1; index >= 0; index--) {
    cumulative += corrected[index]!;
    if (cumulative / total >= tail) { upper = index; break; }
  }
  return Math.max(0, sweep.frequencyHz[upper]! - sweep.frequencyHz[lower]!);
}

function spectralFlatness(valuesDbm: readonly number[]): number {
  const linear = valuesDbm.map((value) => Math.max(Number.MIN_VALUE, dbmToMilliwatts(value)));
  const geometric = Math.exp(linear.reduce((sum, value) => sum + Math.log(value), 0) / linear.length);
  const arithmetic = linear.reduce((sum, value) => sum + value, 0) / linear.length;
  return arithmetic > 0 ? clamp01(geometric / arithmetic) : 0;
}

function countLocalPeaks(values: readonly number[], threshold: number): number {
  if (values.length < 3) return values.some((value) => value >= threshold) ? 1 : 0;
  let count = 0;
  for (let index = 1; index < values.length - 1; index++) {
    if (values[index]! >= threshold && values[index]! > values[index - 1]! && values[index]! >= values[index + 1]!) count++;
  }
  return count;
}

function dominantAutocorrelationLag(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  let bestLag = 0;
  let best = 0;
  const maximumLag = Math.min(Math.floor(values.length / 2), 100);
  for (let lag = 2; lag <= maximumLag; lag++) {
    let numerator = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let index = lag; index < centered.length; index++) {
      const left = centered[index]!;
      const right = centered[index - lag]!;
      numerator += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const correlation = leftPower > 0 && rightPower > 0 ? numerator / Math.sqrt(leftPower * rightPower) : 0;
    if (correlation > best) { best = correlation; bestLag = lag; }
  }
  return best >= 0.45 ? bestLag : 0;
}

function dbmToMilliwatts(value: number): number { return 10 ** (value / 10); }
function milliwattsToDbm(value: number): number { return value > 0 ? 10 * Math.log10(value) : Number.NEGATIVE_INFINITY; }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
