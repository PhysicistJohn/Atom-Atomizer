import { z } from 'zod';

export const API_VERSION = 2 as const;
export const FIRMWARE_SOURCE_COMMIT = 'c97938697b6c7485e7cab50bca9af76996b7d671' as const;
export const TINYSA_USB_VENDOR_ID = '0483' as const;
export const TINYSA_USB_PRODUCT_ID = '5740' as const;
export const TINYSA_SHELL_PROMPT = 'ch> ' as const;

export const ZS407_FIRMWARE_LIMITS = Object.freeze({
  analyzerMinimumHz: 0,
  analyzerNormalMaximumHz: 900_000_000,
  analyzerUltraTransitionHz: 7_370_100_000,
  analyzerHarmonicMaximumHz: 17_922_600_000,
  generatorFundamentalMaximumHz: 6_300_000_000,
  generatorMixerMaximumHz: 17_922_600_000,
  generatorMinimumDbm: -115,
  generatorMaximumDbm: -18.5,
  minimumRbwKhz: 0.2,
  maximumRbwKhz: 850,
  minimumSweepPoints: 20,
  maximumSweepPoints: 450,
  minimumSweepSeconds: 0.003,
  maximumSweepSeconds: 60,
  screenWidth: 480,
  screenHeight: 320,
  rawRssiDivisor: 32,
} as const);

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

export const usbMatchSchema = z.enum(['exact-zs407-cdc', 'unverified-serial']);
export type UsbMatch = z.infer<typeof usbMatchSchema>;
export const portCandidateSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  serialNumber: z.string().min(1).optional(),
  vendorId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  productId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  usbMatch: usbMatchSchema,
}).strict();
export type PortCandidate = z.infer<typeof portCandidateSchema>;

export interface DeviceIdentity {
  model: string;
  hardwareVersion: string;
  firmwareVersion: string;
  firmwareSourceCommit: typeof FIRMWARE_SOURCE_COMMIT;
  port: PortCandidate;
  simulated: boolean;
  usbIdentityVerified: boolean;
}

export interface NumericRange {
  min: number;
  max: number;
  step?: number;
  unit: 'Hz' | 'kHz' | 'dBm' | 'dB' | 'points' | 'seconds' | 'percent' | 'mV';
}
export type CapabilityEvidence = 'firmware-source' | 'device-observed' | 'simulated';
export interface DeviceCapabilities {
  profile: 'tinySA4-zs407';
  protocol: {
    transport: 'usb-cdc-acm';
    vendorId: typeof TINYSA_USB_VENDOR_ID;
    productId: typeof TINYSA_USB_PRODUCT_ID;
    prompt: typeof TINYSA_SHELL_PROMPT;
    commandTerminator: '\r';
    echoesCommands: true;
    maximumCommandCharacters: 47;
  };
  analyzerFrequency: NumericRange;
  analyzerNormalMaximumHz: number;
  analyzerUltraTransitionHz: number;
  generatorFrequency: NumericRange;
  generatorFundamentalMaximumHz: number;
  generatorLevel: NumericRange;
  rbwKhz: NumericRange;
  attenuationDb: NumericRange;
  sweepPoints: NumericRange;
  sweepSeconds: NumericRange;
  maxSweepPoints: number;
  screen: { width: 480; height: 320; format: 'rgb565le' };
  screenCapture: boolean;
  remoteTouch: boolean;
  streaming: boolean;
  rawSweep: boolean;
  markerCount: 8;
  traceCount: 4;
  firmwareMarkers: boolean;
  firmwareTraces: boolean;
  generatorReadback: false;
  modulation: readonly ('off' | 'am' | 'fm')[];
  commands: readonly string[];
  evidence: CapabilityEvidence;
  firmwareSourceCommit: typeof FIRMWARE_SOURCE_COMMIT;
  qualification: 'firmware-derived-awaiting-device';
}

export type Verification = 'commanded' | 'verified' | 'unknown' | 'stale';
export type ConnectionState = 'disconnected' | 'discovering' | 'connecting' | 'identifying' | 'ready' | 'disconnecting' | 'faulted';
export type OperatingMode = 'idle' | 'analyzer' | 'generator';
export type GeneratorOutputState = 'off' | 'on' | 'unknown';
export type SweepStatus = 'paused' | 'resumed';
export type TraceDetector = 'sample' | 'minimum-hold' | 'maximum-hold' | 'maximum-decay' | 'average-4' | 'average-16' | 'average' | 'quasi-peak';
export type SpurRejection = 'off' | 'on' | 'auto';
export type TriggerMode = 'auto' | 'normal' | 'single';

export const traceIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type TraceId = z.infer<typeof traceIdSchema>;
export const traceModeSchema = z.enum(['clear-write', 'max-hold', 'min-hold', 'average', 'view', 'blank']);
export type TraceMode = z.infer<typeof traceModeSchema>;
export const traceConfigurationSchema = z.object({
  id: traceIdSchema,
  mode: traceModeSchema,
  averageCount: z.number().int().min(2).max(100),
}).strict();
export type TraceConfiguration = z.infer<typeof traceConfigurationSchema>;
export const traceBankConfigurationSchema = z.array(traceConfigurationSchema).length(4).superRefine((traces, context) => {
  const identifiers = new Set(traces.map((trace) => trace.id));
  if (identifiers.size !== 4) context.addIssue({ code: 'custom', message: 'Trace bank must contain traces 1 through 4 exactly once' });
});
export type TraceBankConfiguration = z.infer<typeof traceBankConfigurationSchema>;

export const markerIdSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4),
  z.literal(5), z.literal(6), z.literal(7), z.literal(8),
]);
export type MarkerId = z.infer<typeof markerIdSchema>;
export const markerModeSchema = z.enum(['normal', 'delta', 'noise-density']);
export type MarkerMode = z.infer<typeof markerModeSchema>;
export const markerConfigurationSchema = z.object({
  id: markerIdSchema,
  enabled: z.boolean(),
  traceId: traceIdSchema,
  mode: markerModeSchema,
  frequencyHz: z.number().int().min(ZS407_FIRMWARE_LIMITS.analyzerMinimumHz).max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  tracking: z.enum(['fixed', 'peak']),
  referenceMarkerId: markerIdSchema.optional(),
}).strict().superRefine((marker, context) => {
  if (marker.mode === 'delta' && marker.referenceMarkerId === undefined) {
    context.addIssue({ code: 'custom', path: ['referenceMarkerId'], message: 'Delta markers require a reference marker' });
  }
  if (marker.referenceMarkerId === marker.id) {
    context.addIssue({ code: 'custom', path: ['referenceMarkerId'], message: 'A marker cannot reference itself' });
  }
});
export type MarkerConfiguration = z.infer<typeof markerConfigurationSchema>;
export const markerSearchConfigurationSchema = z.object({
  minimumLevelDbm: z.number().finite().min(-174).max(30),
  minimumExcursionDb: z.number().finite().min(0).max(100),
}).strict();
export type MarkerSearchConfiguration = z.infer<typeof markerSearchConfigurationSchema>;
export const markerSearchActionSchema = z.enum(['peak', 'minimum', 'next-left', 'next-right']);
export type MarkerSearchAction = z.infer<typeof markerSearchActionSchema>;
export const spectrumDisplayConfigurationSchema = z.object({
  referenceLevelDbm: z.number().finite().min(-150).max(30),
  decibelsPerDivision: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10), z.literal(20)]),
  divisions: z.literal(10),
}).strict();
export type SpectrumDisplayConfiguration = z.infer<typeof spectrumDisplayConfigurationSchema>;

/** Host measurement views. They never imply a corresponding tinySA firmware mode. */
export const measurementViewIdSchema = z.enum(['spectrum', 'waterfall', 'channel', 'envelope-stft']);
export type MeasurementViewId = z.infer<typeof measurementViewIdSchema>;

export const waterfallConfigurationSchema = z.object({
  historyDepth: z.number().int().min(5).max(50),
  floorDbm: z.number().finite().min(-174).max(29),
  ceilingDbm: z.number().finite().min(-173).max(30),
  palette: z.literal('atomic'),
}).strict().refine((value) => value.ceilingDbm > value.floorDbm, {
  message: 'Waterfall ceiling must be greater than its floor',
  path: ['ceilingDbm'],
});
export type WaterfallConfiguration = z.infer<typeof waterfallConfigurationSchema>;

export const channelMeasurementConfigurationSchema = z.object({
  centerHz: z.number().int().min(ZS407_FIRMWARE_LIMITS.analyzerMinimumHz).max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  mainBandwidthHz: z.number().int().positive().max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  adjacentBandwidthHz: z.number().int().positive().max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  channelSpacingHz: z.number().int().positive().max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  adjacentChannelCount: z.number().int().min(1).max(3),
  occupiedPowerPercent: z.number().finite().min(10).max(99.9),
  obwNoiseCorrection: z.enum(['none', 'robust-floor']),
}).strict().superRefine((value, context) => {
  if (value.channelSpacingHz < (value.mainBandwidthHz + value.adjacentBandwidthHz) / 2) {
    context.addIssue({ code: 'custom', path: ['channelSpacingHz'], message: 'Adjacent channels must not overlap the main channel' });
  }
});
export type ChannelMeasurementConfiguration = z.infer<typeof channelMeasurementConfigurationSchema>;

export const envelopeStftConfigurationSchema = z.object({
  windowSize: z.union([z.literal(16), z.literal(32), z.literal(64), z.literal(128), z.literal(256)]),
  hopSize: z.number().int().min(1).max(256),
  window: z.literal('hann'),
  removeDc: z.boolean(),
  dynamicRangeDb: z.number().finite().min(20).max(120),
}).strict().superRefine((value, context) => {
  if (value.hopSize > value.windowSize) context.addIssue({ code: 'custom', path: ['hopSize'], message: 'STFT hop size cannot exceed its window size' });
});
export type EnvelopeStftConfiguration = z.infer<typeof envelopeStftConfigurationSchema>;

export interface IntegratedBandPower {
  startHz: number;
  stopHz: number;
  bandwidthHz: number;
  powerDbm: number;
  powerSpectralDensityDbmHz: number;
  binsUsed: number;
}
export interface OccupiedBandwidthMeasurement {
  percent: number;
  startHz: number;
  stopHz: number;
  bandwidthHz: number;
  occupiedPowerDbm: number;
  noiseCorrection: ChannelMeasurementConfiguration['obwNoiseCorrection'];
}
export interface AdjacentChannelMeasurement extends IntegratedBandPower {
  side: 'lower' | 'upper';
  order: 1 | 2 | 3;
  relativeToCarrierDbc: number;
}
export interface ChannelMeasurementResult {
  carrier: IntegratedBandPower;
  adjacent: readonly AdjacentChannelMeasurement[];
  occupiedBandwidth: OccupiedBandwidthMeasurement;
  sourceSweepId: string;
  actualRbwHz: number;
  nominalBinWidthHz: number;
  evidence: 'host-derived-scalar-sweep';
  qualification: 'engineering-estimate';
}

export interface EnvelopeStftFrame {
  startSeconds: number;
  centerSeconds: number;
  magnitudeDbRelative: readonly number[];
}
export interface EnvelopeStftResult {
  sourceCaptureId: string;
  sampleRateHz: number;
  modulationFrequencyHz: readonly number[];
  frames: readonly EnvelopeStftFrame[];
  peakModulationFrequencyHz: number;
  evidence: 'zero-span-detected-envelope';
  qualification: 'not-iq';
}

export interface TraceFrame {
  traceId: TraceId;
  mode: TraceMode;
  frequencyHz: readonly number[];
  powerDbm: readonly number[];
  sweepCount: number;
  sourceSweepId: string;
  evidence: 'host-derived';
}
export interface MarkerReading {
  markerId: MarkerId;
  traceId: TraceId;
  mode: MarkerMode;
  binIndex: number;
  frequencyHz: number;
  powerDbm: number;
  deltaFrequencyHz?: number;
  deltaPowerDb?: number;
  noiseDensityDbmHz?: number;
  sourceSweepId: string;
  evidence: 'host-derived';
}

export const triggerConfigSchema = z.object({
  mode: z.enum(['auto', 'normal', 'single']),
  levelDbm: z.number().finite().min(-174).max(30).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode !== 'auto' && value.levelDbm === undefined) {
    context.addIssue({ code: 'custom', path: ['levelDbm'], message: 'A trigger level is required for normal and single trigger modes' });
  }
});
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const analyzerConfigSchema = z.object({
  startHz: z.number().int().min(ZS407_FIRMWARE_LIMITS.analyzerMinimumHz).max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  stopHz: z.number().int().positive().max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  points: z.number().int().min(ZS407_FIRMWARE_LIMITS.minimumSweepPoints).max(ZS407_FIRMWARE_LIMITS.maximumSweepPoints),
  acquisitionFormat: z.enum(['text', 'raw']),
  rbwKhz: z.union([z.literal('auto'), z.number().finite().min(ZS407_FIRMWARE_LIMITS.minimumRbwKhz).max(ZS407_FIRMWARE_LIMITS.maximumRbwKhz)]),
  attenuationDb: z.union([z.literal('auto'), z.number().int().min(0).max(31)]),
  sweepTimeSeconds: z.union([z.literal('auto'), z.number().finite().min(ZS407_FIRMWARE_LIMITS.minimumSweepSeconds).max(ZS407_FIRMWARE_LIMITS.maximumSweepSeconds)]),
  detector: z.enum(['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak']),
  spurRejection: z.enum(['off', 'on', 'auto']),
  lna: z.enum(['off', 'on']),
  avoidSpurs: z.enum(['off', 'on', 'auto']),
  trigger: triggerConfigSchema,
}).strict().refine((value) => value.stopHz > value.startHz, { message: 'stopHz must be greater than startHz', path: ['stopHz'] });
export type AnalyzerConfig = z.infer<typeof analyzerConfigSchema>;

export const zeroSpanConfigSchema = z.object({
  frequencyHz: z.number().int().min(ZS407_FIRMWARE_LIMITS.analyzerMinimumHz).max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  points: z.number().int().min(ZS407_FIRMWARE_LIMITS.minimumSweepPoints).max(ZS407_FIRMWARE_LIMITS.maximumSweepPoints),
  rbwKhz: z.union([z.literal('auto'), z.number().finite().min(ZS407_FIRMWARE_LIMITS.minimumRbwKhz).max(ZS407_FIRMWARE_LIMITS.maximumRbwKhz)]),
  attenuationDb: z.union([z.literal('auto'), z.number().int().min(0).max(31)]),
  sweepTimeSeconds: z.number().finite().min(ZS407_FIRMWARE_LIMITS.minimumSweepSeconds).max(ZS407_FIRMWARE_LIMITS.maximumSweepSeconds),
  trigger: triggerConfigSchema,
}).strict();
export type ZeroSpanConfig = z.infer<typeof zeroSpanConfigSchema>;

export const generatorConfigSchema = z.object({
  frequencyHz: z.number().int().positive().max(ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz),
  levelDbm: z.number().finite().min(ZS407_FIRMWARE_LIMITS.generatorMinimumDbm).max(ZS407_FIRMWARE_LIMITS.generatorMaximumDbm),
  path: z.enum(['normal', 'mixer']),
  modulation: z.enum(['off', 'am', 'fm']),
  modulationFrequencyHz: z.number().int().min(1).max(10_000),
  amDepthPercent: z.number().int().min(0).max(100),
  fmDeviationHz: z.number().int().min(1_000).max(300_000),
}).strict().superRefine((value, context) => {
  if (value.modulation === 'fm' && value.modulationFrequencyHz > 3_500) {
    context.addIssue({ code: 'custom', path: ['modulationFrequencyHz'], message: 'ZS407 FM modulation frequency cannot exceed 3.5 kHz' });
  }
  const maximum = value.path === 'normal'
    ? ZS407_FIRMWARE_LIMITS.generatorFundamentalMaximumHz
    : ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz;
  if (value.frequencyHz > maximum) {
    context.addIssue({ code: 'custom', path: ['frequencyHz'], message: `${value.path} output cannot exceed ${maximum} Hz` });
  }
});
export type GeneratorConfig = z.infer<typeof generatorConfigSchema>;

export interface AnalyzerReadback {
  startHz: number;
  stopHz: number;
  points: number;
  actualRbwHz: number;
  attenuationDb: number;
  sweepStatus: SweepStatus;
  readAt: string;
}
export interface AnalyzerState {
  requested: AnalyzerConfig;
  readback: AnalyzerReadback;
  verification: Verification;
}
export interface GeneratorState {
  commanded: GeneratorConfig;
  configuredAt: string;
  readbackAvailable: false;
  verification: 'commanded';
}
export interface DeviceTelemetry {
  batteryMillivolts: number;
  deviceId: number;
  sweepStatus: SweepStatus;
  capturedAt: string;
}
export interface DeviceFault {
  code: DeviceErrorCode;
  message: string;
  occurredAt: string;
  recoverable: boolean;
}
export interface DeviceSnapshot {
  connection: ConnectionState;
  mode: OperatingMode;
  generatorOutput: GeneratorOutputState;
  verification: Verification;
  identity?: DeviceIdentity;
  capabilities?: DeviceCapabilities;
  sessionId?: string;
  connectedAt?: string;
  lastOperationAt?: string;
  analyzer?: AnalyzerState;
  generator?: GeneratorState;
  telemetry?: DeviceTelemetry;
  fault?: DeviceFault;
}

export interface Sweep {
  kind: 'spectrum';
  id: string;
  sequence: number;
  capturedAt: string;
  elapsedMilliseconds: number;
  frequencyHz: readonly number[];
  powerDbm: readonly number[];
  requested: AnalyzerConfig;
  actualStartHz: number;
  actualStopHz: number;
  actualRbwHz: number;
  actualAttenuationDb: number;
  source: 'scan-text' | 'scanraw-binary';
  complete: true;
  identity: DeviceIdentity;
}
export interface ZeroSpanCapture {
  kind: 'zero-span';
  id: string;
  sequence: number;
  capturedAt: string;
  elapsedMilliseconds: number;
  frequencyHz: number;
  samplePeriodSeconds: number;
  powerDbm: readonly number[];
  requested: ZeroSpanConfig;
  actualRbwHz: number;
  actualAttenuationDb: number;
  source: 'scan-text';
  complete: true;
  identity: DeviceIdentity;
}
export interface ScreenFrame {
  width: 480;
  height: 320;
  format: 'rgb565le';
  pixels: Uint8Array;
  capturedAt: string;
}
export interface DeviceDiagnostics {
  identity: DeviceIdentity;
  firmwareVersionResponse: string;
  infoLines: readonly string[];
  commands: readonly string[];
  analyzerReadback: AnalyzerReadback;
  telemetry: DeviceTelemetry;
  capturedAt: string;
}

export type AnalysisModeId = 'signal-detection' | 'waveform-classification' | (string & {});
export const signalDetectionConfigSchema = z.object({
  threshold: z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('absolute'), levelDbm: z.number().finite().min(-174).max(30) }).strict(),
    z.object({ strategy: z.literal('noise-relative'), marginDb: z.number().finite().min(0).max(100) }).strict(),
  ]),
  minimumBandwidthHz: z.number().int().nonnegative(),
  minimumConsecutiveSweeps: z.number().int().min(1).max(1_000),
  releaseAfterMissedSweeps: z.number().int().min(0).max(100),
}).strict();
export type SignalDetectionConfig = z.infer<typeof signalDetectionConfigSchema>;
export interface DetectedSignal {
  id: string;
  startHz: number;
  stopHz: number;
  peakHz: number;
  peakDbm: number;
  bandwidthHz: number;
  thresholdDbm: number;
  noiseFloorDbm: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sweepIds: readonly string[];
  persistenceSweeps: number;
  missedSweeps: number;
  state: 'candidate' | 'active' | 'released';
  detectorId: string;
  detectorConfig: SignalDetectionConfig;
  qualityFlags: readonly ('touches-lower-boundary' | 'touches-upper-boundary' | 'single-bin')[];
}
export interface ClassificationCandidate { label: string; confidence: number; }
export type ClassificationUnknownReason = 'model-unavailable' | 'low-confidence' | 'out-of-domain' | 'insufficient-evidence' | 'inference-failed';
export interface WaveformClassification {
  detectionId: string;
  label: string | 'unknown';
  confidence: number;
  candidates: readonly ClassificationCandidate[];
  modelId: string;
  classifiedAt: string;
  unknownReason?: ClassificationUnknownReason;
  evidence: {
    centerHz: number;
    bandwidthHz: number;
    peakDbm: number;
    sweepIds: readonly string[];
    features?: Readonly<Record<string, number>>;
  };
}
export interface AnalysisModeDefinition {
  id: AnalysisModeId;
  name: string;
  description: string;
  status: 'available' | 'experimental' | 'requires-model';
  requiredCapabilities: readonly string[];
}
export const modelPackageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().min(1),
  version: z.string().min(1),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  taxonomyId: z.string().min(1),
  preprocessingId: z.string().min(1),
  license: z.string().min(1),
  supportedDomain: z.object({
    models: z.array(z.string().min(1)).min(1),
    firmware: z.array(z.string().min(1)),
    minimumFrequencyHz: z.number().int().nonnegative(),
    maximumFrequencyHz: z.number().int().positive(),
    pointCounts: z.array(z.number().int().min(2)).min(1),
  }).strict().refine((value) => value.maximumFrequencyHz > value.minimumFrequencyHz, { message: 'maximumFrequencyHz must exceed minimumFrequencyHz' }),
  metrics: z.object({
    datasetId: z.string().min(1),
    macroF1: z.number().min(0).max(1),
    expectedCalibrationError: z.number().min(0).max(1),
    openSetRecall: z.number().min(0).max(1),
  }).strict(),
}).strict();
export type ModelPackageManifest = z.infer<typeof modelPackageManifestSchema>;

export const screenPointSchema = z.object({
  x: z.number().int().min(0).max(ZS407_FIRMWARE_LIMITS.screenWidth - 1),
  y: z.number().int().min(0).max(ZS407_FIRMWARE_LIMITS.screenHeight - 1),
}).strict();
export type ScreenPoint = z.infer<typeof screenPointSchema>;
export const sweepExportRequestSchema = z.object({
  sweep: z.custom<Sweep>((value) => Boolean(value && typeof value === 'object' && (value as Sweep).kind === 'spectrum')),
  format: z.enum(['csv', 'json']),
}).strict();
export type SweepExportRequest = z.infer<typeof sweepExportRequestSchema>;
export type SweepExportResult =
  | { status: 'saved'; path: string; format: 'csv' | 'json'; bytesWritten: number }
  | { status: 'cancelled'; format: 'csv' | 'json' };

export type DeviceErrorCode = 'not-connected' | 'unsupported' | 'invalid-state' | 'invalid-request' | 'timeout' | 'cancelled' | 'transport' | 'protocol' | 'identity-mismatch';
export interface DeviceError { code: DeviceErrorCode; message: string; operationId?: string; recoverable: boolean; }
export type DeviceEvent =
  | { type: 'snapshot'; snapshot: DeviceSnapshot }
  | { type: 'sweep'; sweep: Sweep }
  | { type: 'zero-span'; capture: ZeroSpanCapture }
  | { type: 'screen'; frame: ScreenFrame }
  | { type: 'diagnostics'; diagnostics: DeviceDiagnostics }
  | { type: 'error'; error: DeviceError };

export interface AnalysisApiV2 {
  listModes(): Promise<readonly AnalysisModeDefinition[]>;
  configureDetection(config: SignalDetectionConfig): Promise<void>;
  analyzeSweep(sweep: Sweep): Promise<readonly DetectedSignal[]>;
  classify(detection: DetectedSignal, sweep: Sweep): Promise<WaveformClassification>;
}

export interface TinySaApiV2 {
  readonly version: typeof API_VERSION;
  listDevices(): Promise<PortCandidate[]>;
  connect(port: PortCandidate): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  getSnapshot(): Promise<DeviceSnapshot>;
  configureAnalyzer(config: AnalyzerConfig): Promise<DeviceSnapshot>;
  acquireSweep(): Promise<Sweep>;
  startStreaming(): Promise<void>;
  stopStreaming(): Promise<void>;
  acquireZeroSpan(config: ZeroSpanConfig): Promise<ZeroSpanCapture>;
  configureGenerator(config: GeneratorConfig): Promise<DeviceSnapshot>;
  setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot>;
  readDiagnostics(): Promise<DeviceDiagnostics>;
  captureScreen(): Promise<ScreenFrame>;
  touch(point: ScreenPoint): Promise<void>;
  releaseTouch(point?: ScreenPoint): Promise<void>;
  exportSweep(request: SweepExportRequest): Promise<SweepExportResult>;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}

export type TinySaApiV1 = TinySaApiV2;

export const SYNTHESIZED_SIGNAL_PROFILES = [
  'cw',
  'am',
  'fm',
  'gsm-normal-burst',
  'gsm-qpsk-normal-burst',
  'gsm-aqpsk-normal-burst',
  'gsm-8psk-normal-burst',
  'gsm-16qam-normal-burst',
  'gsm-32qam-normal-burst',
  'lte-etm1.1',
  'lte-etm1.2',
  'lte-etm2',
  'lte-etm2a',
  'lte-etm2b',
  'lte-setm2-1',
  'lte-setm2a-1',
  'lte-setm2-2',
  'lte-setm2a-2',
  'lte-etm3.1',
  'lte-etm3.1a',
  'lte-etm3.1b',
  'lte-setm3.1-1',
  'lte-setm3.1a-1',
  'lte-setm3.1-2',
  'lte-setm3.1a-2',
  'lte-etm3.2',
  'lte-setm3.2-1',
  'lte-setm3.2-2',
  'lte-etm3.3',
  'lte-setm3.3-1',
  'lte-setm3.3-2',
  'lte-ntm',
  'lte-ntm-guard',
  'lte-ntm-inband',
  'nr-fr1-tm1.1',
  'nr-fr1-tm1.2',
  'nr-fr1-tm2',
  'nr-fr1-tm2a',
  'nr-fr1-tm2b',
  'nr-fr1-tm3.1',
  'nr-fr1-tm3.1a',
  'nr-fr1-tm3.1b',
  'nr-fr1-tm3.2',
  'nr-fr1-tm3.3',
  'nr-ntm',
  'nr-fr1-tm1.1-sbfd-du',
  'nr-fr1-tm1.1-sbfd-ud',
  'nr-fr1-tm1.1-sbfd-dud',
  'nr-fr1-tm1.2-sbfd-du',
  'nr-fr1-tm1.2-sbfd-ud',
  'nr-fr1-tm1.2-sbfd-dud',
  'nr-fr1-tm2-sbfd-du',
  'nr-fr1-tm2-sbfd-ud',
  'nr-fr1-tm2-sbfd-dud',
  'nr-fr1-tm2a-sbfd-du',
  'nr-fr1-tm2a-sbfd-ud',
  'nr-fr1-tm2a-sbfd-dud',
  'nr-fr1-tm2b-sbfd-du',
  'nr-fr1-tm2b-sbfd-ud',
  'nr-fr1-tm2b-sbfd-dud',
  'nr-fr1-tm3.1-sbfd-du',
  'nr-fr1-tm3.1-sbfd-ud',
  'nr-fr1-tm3.1-sbfd-dud',
  'nr-fr1-tm3.1a-sbfd-du',
  'nr-fr1-tm3.1a-sbfd-ud',
  'nr-fr1-tm3.1a-sbfd-dud',
  'nr-fr1-tm3.1b-sbfd-du',
  'nr-fr1-tm3.1b-sbfd-ud',
  'nr-fr1-tm3.1b-sbfd-dud',
  'nr-fr1-tm3.2-sbfd-du',
  'nr-fr1-tm3.2-sbfd-ud',
  'nr-fr1-tm3.2-sbfd-dud',
  'nr-fr1-tm3.3-sbfd-du',
  'nr-fr1-tm3.3-sbfd-ud',
  'nr-fr1-tm3.3-sbfd-dud',
  'wifi6-he-su',
  'wifi6-he-er-su',
  'wifi6-he-mu',
  'wifi6-he-tb',
] as const;
export const synthesizedSignalProfileSchema = z.enum(SYNTHESIZED_SIGNAL_PROFILES);
export type SynthesizedSignalProfile = z.infer<typeof synthesizedSignalProfileSchema>;
export const replayChannelConfigurationSchema = z.object({
  model: z.enum(['awgn', 'rayleigh']),
  noiseFloorDbm: z.number().finite().min(-150).max(-30),
  seed: z.number().int().min(1).max(0xffff_ffff),
  fadingRateHz: z.number().finite().min(0.1).max(100),
}).strict();
export type ReplayChannelConfiguration = z.infer<typeof replayChannelConfigurationSchema>;
export const waveformQualificationSchema = z.enum(['visual', 'standards-derived', 'conformance-validated']);
export type WaveformQualification = z.infer<typeof waveformQualificationSchema>;
export const waveformProjectionSchema = z.object({
  allocation: z.enum(['carrier', 'sidebands', 'full', 'boosted', 'single-prb', 'narrowband', 'multi-ru', 'resource-unit']),
  modulation: z.enum(['unmodulated', 'am', 'fm', 'gmsk', 'qpsk', 'aqpsk', '8psk', '16qam', '32qam', '64qam', '256qam', '1024qam', 'ofdm-mixed', 'he-ofdm']),
  timing: z.enum(['continuous', 'burst', 'frame', 'subslot', 'slot', 'sbfd-du', 'sbfd-ud', 'sbfd-dud']),
  subcarrierSpacingHz: z.number().int().positive().optional(),
  nominalResourceBlocks: z.number().int().positive().optional(),
}).strict();
export type WaveformProjection = z.infer<typeof waveformProjectionSchema>;
export const waveformDescriptorSchema = z.object({
  id: synthesizedSignalProfileSchema,
  label: z.string().min(1),
  family: z.enum(['tone', 'analog', 'geran', 'e-utra', 'nr', 'wlan']),
  model: z.string().min(1),
  qualification: waveformQualificationSchema,
  centerHz: z.number().int().positive().max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  occupiedBandwidthHz: z.number().int().positive(),
  recommendedSpanHz: z.number().int().positive(),
  projection: waveformProjectionSchema,
  standard: z.object({
    organization: z.enum(['TinySA Atomizer', '3GPP', 'IEEE']),
    specification: z.string().min(1),
    clause: z.string().min(1),
    revision: z.string().min(1),
    url: z.string().url(),
  }).strict(),
  disclosure: z.string().min(1),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict().superRefine((descriptor, context) => {
  if (descriptor.recommendedSpanHz < descriptor.occupiedBandwidthHz) {
    context.addIssue({ code: 'custom', path: ['recommendedSpanHz'], message: 'Recommended span must contain the occupied bandwidth' });
  }
  if (descriptor.qualification === 'conformance-validated' && descriptor.assetSha256 === undefined) {
    context.addIssue({ code: 'custom', path: ['assetSha256'], message: 'Conformance-validated waveforms require a verified I/Q asset hash' });
  }
});
export type WaveformDescriptor = z.infer<typeof waveformDescriptorSchema>;
export interface DemoLabStatus {
  available: boolean;
  active: boolean;
  playback: boolean;
  profile: SynthesizedSignalProfile;
  profiles: readonly SynthesizedSignalProfile[];
  waveform: WaveformDescriptor;
  catalog: readonly WaveformDescriptor[];
  channel: ReplayChannelConfiguration;
}
export interface DemoLabApi {
  status(): Promise<DemoLabStatus>;
  select(profile: SynthesizedSignalProfile): Promise<DemoLabStatus>;
  configureChannel(config: ReplayChannelConfiguration): Promise<DemoLabStatus>;
  subscribe(listener: (status: DemoLabStatus) => void): () => void;
}
