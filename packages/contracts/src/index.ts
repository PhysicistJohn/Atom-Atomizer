import { z } from 'zod';

export const API_VERSION = 2 as const;
export const FIRMWARE_SOURCE_COMMIT = 'c97938697b6c7485e7cab50bca9af76996b7d671' as const;
export const ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT = 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const;
export const DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT = 'd12bd826555eee51505542a55fd184ade5817d58' as const;
export const SUPPORTED_ZS407_FIRMWARE_REVISIONS = Object.freeze({
  c5dd31f: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  c979386: FIRMWARE_SOURCE_COMMIT,
} as const);
export type SupportedZs407FirmwareRevision = keyof typeof SUPPORTED_ZS407_FIRMWARE_REVISIONS;
export type FirmwareSourceCommit =
  | typeof FIRMWARE_SOURCE_COMMIT
  | typeof ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT
  | typeof DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT;
export const OEM_ZS407_FIRMWARE_RELEASE = Object.freeze({
  product: 'tinySA Ultra / Ultra+',
  version: 'tinySA4_v1.4-224-gc979386',
  revision: 'c979386' as const,
  sourceCommit: FIRMWARE_SOURCE_COMMIT,
  publishedAt: '2026-05-06T11:33:12.000Z',
  downloadUrl: 'http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin',
  sha256: '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
  sizeBytes: 185_704,
  transportIntegrity: 'pinned-sha256' as const,
});
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

export const instrumentTransportKindSchema = z.enum(['usb-cdc-acm', 'renode-monitor-bridge', 'protocol-test-double']);
export type InstrumentTransportKind = z.infer<typeof instrumentTransportKindSchema>;
export const executionEnvironmentSchema = z.enum(['physical', 'firmware-digital-twin', 'protocol-test-double']);
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;
export const usbMatchSchema = z.enum(['exact-zs407-cdc', 'unverified-serial', 'firmware-digital-twin', 'protocol-test-double']);
export type UsbMatch = z.infer<typeof usbMatchSchema>;
export const digitalTwinProvenanceSchema = z.object({
  contractVersion: z.literal(1),
  bridge: z.literal('renode-monitor-v1'),
  firmwareRelease: z.literal('lab-v0.2.0-protocol'),
  repositoryCommit: z.literal(DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT),
  firmwareBinarySha256: z.literal('a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7'),
  usbTransactionsModeled: z.literal(false),
  bootEvidence: z.string().startsWith('ZS407_TWIN_BOOT=PASS').optional(),
}).strict();
export type DigitalTwinProvenance = z.infer<typeof digitalTwinProvenanceSchema>;
export const portCandidateSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  manufacturer: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  serialNumber: z.string().min(1).optional(),
  vendorId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  productId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  usbMatch: usbMatchSchema,
  transport: instrumentTransportKindSchema,
  execution: executionEnvironmentSchema,
  digitalTwin: digitalTwinProvenanceSchema.optional(),
}).strict().superRefine((candidate, context) => {
  const twin = candidate.execution === 'firmware-digital-twin';
  if (twin !== (candidate.transport === 'renode-monitor-bridge') || twin !== (candidate.usbMatch === 'firmware-digital-twin') || twin !== Boolean(candidate.digitalTwin)) {
    context.addIssue({ code: 'custom', message: 'Digital-twin execution, transport, match label, and provenance must agree' });
  }
  if (candidate.execution === 'physical') {
    if (candidate.transport !== 'usb-cdc-acm') context.addIssue({ code: 'custom', message: 'Physical candidates require USB CDC transport' });
    if (candidate.usbMatch !== 'exact-zs407-cdc' && candidate.usbMatch !== 'unverified-serial') context.addIssue({ code: 'custom', message: 'Physical candidates require a physical USB match label' });
    if (candidate.usbMatch === 'exact-zs407-cdc' && (candidate.vendorId?.toLowerCase() !== TINYSA_USB_VENDOR_ID || candidate.productId?.toLowerCase() !== TINYSA_USB_PRODUCT_ID)) {
      context.addIssue({ code: 'custom', message: 'Exact ZS407 candidates require the exact 0483:5740 USB identifiers' });
    }
  }
  if (candidate.execution === 'protocol-test-double' && (candidate.transport !== 'protocol-test-double' || candidate.usbMatch !== 'protocol-test-double')) {
    context.addIssue({ code: 'custom', message: 'Protocol test doubles require their explicit transport and match labels' });
  }
});
export type PortCandidate = z.infer<typeof portCandidateSchema>;

export interface DeviceIdentity {
  model: string;
  hardwareVersion: string;
  firmwareVersion: string;
  firmwareReportedRevision?: SupportedZs407FirmwareRevision;
  firmwareSourceCommit: FirmwareSourceCommit;
  port: PortCandidate;
  simulated: boolean;
  usbIdentityVerified: boolean;
  execution: ExecutionEnvironment;
  digitalTwin?: DigitalTwinProvenance;
}

export interface NumericRange {
  min: number;
  max: number;
  step?: number;
  unit: 'Hz' | 'kHz' | 'dBm' | 'dB' | 'points' | 'seconds' | 'percent' | 'mV';
}
export type CapabilityEvidence = 'firmware-source' | 'device-observed' | 'firmware-executed-twin' | 'protocol-test-double';
export interface DeviceCapabilities {
  profile: 'tinySA4-zs407';
  protocol: {
    transport: InstrumentTransportKind;
    vendorId?: typeof TINYSA_USB_VENDOR_ID;
    productId?: typeof TINYSA_USB_PRODUCT_ID;
    prompt: typeof TINYSA_SHELL_PROMPT;
    commandTerminator: '\r';
    echoesCommands: true;
    maximumCommandCharacters: 47;
    usbTransactionsModeled: boolean;
    bridgeContractVersion?: 1;
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
  rawSweepOffsetReadback: boolean;
  markerCount: 8;
  traceCount: 4;
  firmwareMarkers: boolean;
  firmwareTraces: boolean;
  generatorReadback: false;
  modulation: readonly ('off' | 'am' | 'fm')[];
  commands: readonly string[];
  evidence: CapabilityEvidence;
  firmwareSourceCommit: FirmwareSourceCommit;
  hostContractSourceCommit: typeof FIRMWARE_SOURCE_COMMIT;
  qualification: 'device-observed-awaiting-rf-qualification' | 'executable-twin-observed' | 'protocol-test-only';
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
  pendingPort?: PortCandidate;
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
  source: 'scan-text' | 'scanraw-binary' | 'renode-executable-state';
  rawSweepOffsetDb?: number;
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
  source: 'scan-text' | 'renode-executable-state';
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
  rawSweepOffsetDb: number;
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

export const firmwareUpdatePhaseSchema = z.enum([
  'idle', 'available', 'downloading', 'verified', 'awaiting-dfu', 'ready-to-flash',
  'flashing', 'reconnecting', 'completed', 'up-to-date', 'failed',
]);
export type FirmwareUpdatePhase = z.infer<typeof firmwareUpdatePhaseSchema>;
export const firmwareWriteDispositionSchema = z.enum(['not-started', 'started', 'completed', 'indeterminate']);
export type FirmwareWriteDisposition = z.infer<typeof firmwareWriteDispositionSchema>;
const supportedZs407FirmwareRevisionSchema = z.enum(['c5dd31f', 'c979386']);
const firmwareSourceCommitSchema = z.union([
  z.literal(FIRMWARE_SOURCE_COMMIT),
  z.literal(ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT),
  z.literal(DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT),
]);
const oemZs407FirmwareReleaseSchema = z.object({
  product: z.literal(OEM_ZS407_FIRMWARE_RELEASE.product),
  version: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
  revision: z.literal(OEM_ZS407_FIRMWARE_RELEASE.revision),
  sourceCommit: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sourceCommit),
  publishedAt: z.literal(OEM_ZS407_FIRMWARE_RELEASE.publishedAt),
  downloadUrl: z.literal(OEM_ZS407_FIRMWARE_RELEASE.downloadUrl),
  sha256: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sha256),
  sizeBytes: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes),
  transportIntegrity: z.literal(OEM_ZS407_FIRMWARE_RELEASE.transportIntegrity),
}).strict();
export const firmwareUpdateStateSchema = z.object({
  phase: firmwareUpdatePhaseSchema,
  target: oemZs407FirmwareReleaseSchema,
  updateAvailable: z.boolean(),
  current: z.object({
    version: z.string().min(1),
    revision: supportedZs407FirmwareRevisionSchema.optional(),
    sourceCommit: firmwareSourceCommitSchema,
  }).strict().optional(),
  artifact: z.object({
    sizeBytes: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes),
    sha256: z.literal(OEM_ZS407_FIRMWARE_RELEASE.sha256),
    verifiedAt: z.string().min(1),
  }).strict().optional(),
  dfuUtility: z.object({ available: z.boolean(), version: z.string().min(1).optional() }).strict(),
  dfuDevice: z.object({ detected: z.boolean(), count: z.number().int().nonnegative() }).strict(),
  preparation: z.object({
    id: z.string().uuid(),
    preparedAt: z.string().min(1),
    batteryMillivolts: z.number().int().positive(),
    deviceId: z.number().int().nonnegative(),
    screenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    selfTestPassed: z.literal(true),
    configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
    rfPortsDisconnected: z.literal(true),
  }).strict().optional(),
  writeDisposition: firmwareWriteDispositionSchema,
  writeStartedAt: z.string().min(1).optional(),
  writeCompletedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).strict().superRefine((state, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (state.writeDisposition === 'not-started' && (state.writeStartedAt || state.writeCompletedAt)) issue('A not-started write cannot have write timestamps');
  if (state.writeDisposition === 'started' && (!state.writeStartedAt || state.writeCompletedAt)) issue('A started write requires only writeStartedAt');
  if (state.writeDisposition === 'completed' && (!state.writeStartedAt || !state.writeCompletedAt)) issue('A completed write requires both write timestamps');
  if (state.writeDisposition === 'indeterminate' && state.phase !== 'failed') issue('An indeterminate write disposition must remain failed');
  if (['flashing', 'reconnecting', 'completed'].includes(state.phase) && state.writeDisposition === 'not-started') issue(`${state.phase} requires durable write-attempt evidence`);
  if (state.phase === 'completed' && (state.writeDisposition !== 'completed' || !state.completedAt)) issue('Completed firmware state requires a completed write and post-reboot timestamp');
  if (state.phase === 'ready-to-flash' && (!state.dfuDevice.detected || state.dfuDevice.count !== 1)) issue('Ready-to-flash requires exactly one detected DFU target');
});
export type FirmwareUpdateState = z.infer<typeof firmwareUpdateStateSchema>;
export const firmwareUpdateJournalSchema = z.object({
  schemaVersion: z.literal(1),
  targetVersion: z.literal(OEM_ZS407_FIRMWARE_RELEASE.version),
  writtenAt: z.string().min(1),
  state: firmwareUpdateStateSchema,
}).strict();
export type FirmwareUpdateJournal = z.infer<typeof firmwareUpdateJournalSchema>;
export const firmwareUpdatePreflightSchema = z.object({
  selfTestPassed: z.literal(true),
  configurationDisposition: z.enum(['new-device-unchanged', 'backup-complete-and-recalibration-accepted']),
  rfPortsDisconnected: z.literal(true),
}).strict();
export type FirmwareUpdatePreflight = z.infer<typeof firmwareUpdatePreflightSchema>;
export const firmwareFlashRequestSchema = z.object({
  preparationId: z.string().uuid(),
  confirmation: z.literal('FLASH VERIFIED OEM FIRMWARE'),
}).strict();
export type FirmwareFlashRequest = z.infer<typeof firmwareFlashRequestSchema>;

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

export const TINYSA_API_V2_METHODS = [
  'listDevices', 'connect', 'disconnect', 'getSnapshot', 'configureAnalyzer', 'acquireSweep',
  'startStreaming', 'stopStreaming', 'acquireZeroSpan', 'configureGenerator', 'setGeneratorOutput',
  'readDiagnostics', 'captureScreen', 'touch', 'releaseTouch', 'exportSweep',
  'getFirmwareUpdateState', 'downloadFirmwareUpdate', 'prepareFirmwareUpdate', 'detectDfuDevice', 'flashFirmwareUpdate',
  'subscribe',
] as const;
export type TinySaApiV2Method = typeof TINYSA_API_V2_METHODS[number];

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
  getFirmwareUpdateState(): Promise<FirmwareUpdateState>;
  downloadFirmwareUpdate(): Promise<FirmwareUpdateState>;
  prepareFirmwareUpdate(preflight: FirmwareUpdatePreflight): Promise<FirmwareUpdateState>;
  detectDfuDevice(): Promise<FirmwareUpdateState>;
  flashFirmwareUpdate(request: FirmwareFlashRequest): Promise<FirmwareUpdateState>;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}

type AssertNoApiMethodDrift<T extends never> = T;
type _TinySaApiMethodsMissingFromRuntimeCatalog = AssertNoApiMethodDrift<Exclude<Exclude<keyof TinySaApiV2, 'version'>, TinySaApiV2Method>>;
type _TinySaApiRuntimeCatalogUnknownMethods = AssertNoApiMethodDrift<Exclude<TinySaApiV2Method, Exclude<keyof TinySaApiV2, 'version'>>>;

export type TinySaApiV1 = TinySaApiV2;
