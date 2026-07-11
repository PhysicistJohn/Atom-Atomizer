import type { AnalysisModeDefinition, DetectedSignal, SignalDetectionConfig, Sweep, WaveformClassification } from '@tinysa/contracts';

export const analysisModes: readonly AnalysisModeDefinition[] = [
  { id: 'signal-detection', name: 'Signal Detection', description: 'Find and track emissions above an absolute or adaptive noise-floor threshold.', status: 'available', requiredCapabilities: ['scan'] },
  { id: 'waveform-classification', name: 'Waveform Classification', description: 'Assign waveform families to detections with calibrated confidence and an explicit unknown class.', status: 'requires-model', requiredCapabilities: ['scan'] }
];

export class SignalDetector {
  static readonly id = 'adaptive-contiguous-v1';
  constructor(private config: SignalDetectionConfig = { threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 1 }) {}
  configure(config: SignalDetectionConfig): void { this.config = config; }
  analyze(sweep: Sweep): readonly DetectedSignal[] {
    if(sweep.frequencyHz.length!==sweep.powerDbm.length)throw new Error('Sweep frequency and power arrays have different lengths');
    if(sweep.powerDbm.length===0)throw new Error('Sweep contains no measurement points');
    if(sweep.frequencyHz.some(value=>!Number.isFinite(value))||sweep.powerDbm.some(value=>!Number.isFinite(value)))throw new Error('Sweep contains non-finite measurement values');
    const threshold = this.config.threshold.strategy === 'absolute'
      ? this.config.threshold.levelDbm
      : median(sweep.powerDbm) + this.config.threshold.marginDb;
    const groups: Array<{ start: number; end: number }> = [];
    let start: number | undefined;
    for (let i = 0; i < sweep.powerDbm.length; i++) {
      if (sweep.powerDbm[i]! >= threshold && start === undefined) start = i;
      if ((sweep.powerDbm[i]! < threshold || i === sweep.powerDbm.length - 1) && start !== undefined) {
        const end = sweep.powerDbm[i]! >= threshold ? i : i - 1; groups.push({ start, end }); start = undefined;
      }
    }
    return groups.map(({ start: first, end: last }, index) => {
      let peak = first;
      for (let i = first + 1; i <= last; i++) if (sweep.powerDbm[i]! > sweep.powerDbm[peak]!) peak = i;
      const startHz = sweep.frequencyHz[first]!; const stopHz = sweep.frequencyHz[last]!;
      const qualityFlags: DetectedSignal['qualityFlags'][number][] = [];
      if (first === 0) qualityFlags.push('touches-lower-boundary');
      if (last === sweep.frequencyHz.length - 1) qualityFlags.push('touches-upper-boundary');
      if (first === last) qualityFlags.push('single-bin');
      return { id: `${sweep.id}:${index}`, startHz, stopHz, peakHz: sweep.frequencyHz[peak]!, peakDbm: sweep.powerDbm[peak]!, bandwidthHz: Math.max(0, stopHz - startHz), firstSeenAt: sweep.capturedAt, lastSeenAt: sweep.capturedAt, sweepIds: [sweep.id], detectorId: SignalDetector.id, detectorConfig: structuredClone(this.config), qualityFlags };
    }).filter((signal) => signal.bandwidthHz >= this.config.minimumBandwidthHz);
  }
}

export interface AnalysisModePlugin<Config, Input, Result> {
  readonly definition: AnalysisModeDefinition;
  readonly configSchemaVersion: number;
  readonly resultSchemaVersion: number;
  validateConfig(input: unknown): Config;
  analyze(input: Input, config: Config, signal: AbortSignal): Promise<Result>;
}
export interface WaveformClassifier { readonly modelId: string; classify(detection: DetectedSignal, signal?: AbortSignal): Promise<WaveformClassification>; }
export class UnknownClassifier implements WaveformClassifier {
  readonly modelId = 'unconfigured';
  async classify(detection: DetectedSignal): Promise<WaveformClassification> {
    return { detectionId: detection.id, label: 'unknown', confidence: 0, candidates: [], modelId: this.modelId, unknownReason: 'model-unavailable', classifiedAt: new Date().toISOString(), evidence: { centerHz: (detection.startHz + detection.stopHz) / 2, bandwidthHz: detection.bandwidthHz, peakDbm: detection.peakDbm, sweepIds: detection.sweepIds } };
  }
}
function median(values: readonly number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
