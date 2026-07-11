import { z } from 'zod';

export const API_VERSION = 1 as const;
export type Hertz = number & { readonly __unit: 'Hz' };
export type DecibelMilliwatt = number & { readonly __unit: 'dBm' };
export type Microseconds = number & { readonly __unit: 'us' };

export const hertz = (value: number): Hertz => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Frequency must be a non-negative safe integer in Hz');
  return value as Hertz;
};
export const dBm = (value: number): DecibelMilliwatt => {
  if (!Number.isFinite(value)) throw new RangeError('Level must be finite');
  return value as DecibelMilliwatt;
};
export const microseconds = (value: number): Microseconds => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Duration must be a non-negative safe integer');
  return value as Microseconds;
};

export const portCandidateSchema = z.object({
  id: z.string().min(1), path: z.string().min(1), manufacturer: z.string().optional(),
  serialNumber: z.string().optional(), vendorId: z.string().optional(), productId: z.string().optional()
});
export type PortCandidate = z.infer<typeof portCandidateSchema>;

export interface DeviceIdentity {
  model: string;
  hardwareVersion?: string;
  firmwareVersion: string;
  port: PortCandidate;
}
export interface NumericRange { min: number; max: number; step?: number; unit: 'Hz' | 'dBm' | 'dB' | 'points'; }
export interface DeviceCapabilities {
  analyzerFrequency: NumericRange;
  generatorFrequency?: NumericRange;
  generatorLevel?: NumericRange;
  maxSweepPoints: number;
  screenCapture: boolean;
  remoteTouch: boolean;
  streaming: boolean;
  commands: readonly string[];
  evidence: 'observed' | 'documented' | 'simulated';
}
export type Verification = 'commanded' | 'verified' | 'unknown' | 'stale';
export type ConnectionState = 'disconnected' | 'discovering' | 'connecting' | 'identifying' | 'ready' | 'recovering' | 'faulted';
export type OperatingMode = 'idle' | 'analyzer' | 'generator';
export type GeneratorOutputState = 'off' | 'on' | 'unknown';

export interface DeviceSnapshot {
  connection: ConnectionState;
  mode: OperatingMode;
  generatorOutput: GeneratorOutputState;
  identity?: DeviceIdentity;
  capabilities?: DeviceCapabilities;
  verification: Verification;
}
export const analyzerConfigSchema = z.object({
  startHz: z.number().int().nonnegative(), stopHz: z.number().int().positive(),
  points: z.number().int().min(2).max(100_000).default(450),
  rbwKhz: z.number().positive().optional(), attenuationDb: z.union([z.literal('auto'), z.number().min(0).max(31)]).default('auto')
}).refine((v) => v.stopHz > v.startHz, { message: 'stopHz must be greater than startHz', path: ['stopHz'] });
export type AnalyzerConfig = z.infer<typeof analyzerConfigSchema>;

export const generatorConfigSchema = z.object({
  frequencyHz: z.number().int().positive(), levelDbm: z.number().finite(),
  modulation: z.enum(['off', 'am', 'nfm', 'wfm']).default('off')
});
export type GeneratorConfig = z.infer<typeof generatorConfigSchema>;

export interface Sweep {
  id: string; capturedAt: string; frequencyHz: readonly number[]; powerDbm: readonly number[];
  requested: AnalyzerConfig; actualStartHz: number; actualStopHz: number; identity: DeviceIdentity;
}
export interface ScreenFrame { width: number; height: number; format: 'rgb565le'; pixels: Uint8Array; capturedAt: string; }
export type AnalysisModeId = 'signal-detection' | 'waveform-classification' | (string & {});
export const signalDetectionConfigSchema = z.object({
  threshold: z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('absolute'), levelDbm: z.number().finite().min(-174).max(30) }),
    z.object({ strategy: z.literal('noise-relative'), marginDb: z.number().finite().min(0).max(100) })
  ]),
  minimumBandwidthHz: z.number().int().nonnegative(),
  minimumConsecutiveSweeps: z.number().int().min(1).max(10_000)
});
export type SignalDetectionConfig = z.infer<typeof signalDetectionConfigSchema>;
export interface DetectedSignal {
  id: string; startHz: number; stopHz: number; peakHz: number; peakDbm: number;
  bandwidthHz: number; firstSeenAt: string; lastSeenAt: string; sweepIds: readonly string[];
  detectorId: string; detectorConfig: SignalDetectionConfig;
  qualityFlags: readonly ('touches-lower-boundary' | 'touches-upper-boundary' | 'single-bin')[];
}
export interface ClassificationCandidate { label: string; confidence: number; }
export type ClassificationUnknownReason = 'model-unavailable' | 'low-confidence' | 'out-of-domain' | 'insufficient-evidence' | 'inference-failed';
export interface WaveformClassification {
  detectionId: string; label: string | 'unknown'; confidence: number;
  candidates: readonly ClassificationCandidate[]; modelId: string; classifiedAt: string;
  unknownReason?: ClassificationUnknownReason;
  evidence: { centerHz: number; bandwidthHz: number; peakDbm: number; sweepIds: readonly string[] };
}
export interface AnalysisModeDefinition {
  id: AnalysisModeId; name: string; description: string;
  status: 'available' | 'experimental' | 'requires-model';
  requiredCapabilities: readonly string[];
}
export const modelPackageManifestSchema = z.object({
  schemaVersion: z.literal(1), modelId: z.string().min(1), version: z.string().min(1),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/i), taxonomyId: z.string().min(1), preprocessingId: z.string().min(1), license: z.string().min(1),
  supportedDomain: z.object({ models: z.array(z.string().min(1)).min(1), firmware: z.array(z.string().min(1)), minimumFrequencyHz: z.number().int().nonnegative(), maximumFrequencyHz: z.number().int().positive(), pointCounts: z.array(z.number().int().min(2)).min(1) }).refine((v)=>v.maximumFrequencyHz>v.minimumFrequencyHz,{message:'maximumFrequencyHz must exceed minimumFrequencyHz'}),
  metrics: z.object({ datasetId: z.string().min(1), macroF1: z.number().min(0).max(1), expectedCalibrationError: z.number().min(0).max(1), openSetRecall: z.number().min(0).max(1) })
});
export type ModelPackageManifest = z.infer<typeof modelPackageManifestSchema>;
export type DeviceErrorCode = 'not-connected' | 'unsupported' | 'invalid-state' | 'invalid-request' | 'timeout' | 'cancelled' | 'transport' | 'protocol';
export interface DeviceError { code: DeviceErrorCode; message: string; operationId?: string; recoverable: boolean; }
export type DeviceEvent =
  | { type: 'snapshot'; snapshot: DeviceSnapshot }
  | { type: 'sweep'; sweep: Sweep }
  | { type: 'screen'; frame: ScreenFrame }
  | { type: 'error'; error: DeviceError };

export interface AnalysisApiV1 {
  listModes(): Promise<readonly AnalysisModeDefinition[]>;
  configureDetection(config: SignalDetectionConfig): Promise<void>;
  analyzeSweep(sweep: Sweep): Promise<readonly DetectedSignal[]>;
  classify(detection: DetectedSignal): Promise<WaveformClassification>;
}

export interface TinySaApiV1 {
  readonly version: typeof API_VERSION;
  listDevices(): Promise<PortCandidate[]>;
  connect(port: PortCandidate): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  getSnapshot(): Promise<DeviceSnapshot>;
  configureAnalyzer(config: AnalyzerConfig): Promise<DeviceSnapshot>;
  acquireSweep(): Promise<Sweep>;
  configureGenerator(config: GeneratorConfig): Promise<DeviceSnapshot>;
  setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot>;
  captureScreen(): Promise<ScreenFrame>;
  touch(point: { x: number; y: number }): Promise<void>;
  releaseTouch(): Promise<void>;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}
