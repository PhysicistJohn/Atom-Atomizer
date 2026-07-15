import { z } from 'zod';
import {
  MAX_INSTRUMENT_ELAPSED_MILLISECONDS_V1,
  MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1,
  MAX_INSTRUMENT_FREQUENCY_HZ_V1,
  MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1,
  MAX_INSTRUMENT_METADATA_CHARACTERS_V1,
  MAX_INSTRUMENT_POWER_ABS_DB_V1,
  MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1,
  MAX_INSTRUMENT_SEQUENCE_V1,
  instrumentDriverIdSchema,
  instrumentOpaqueIdSchema,
  instrumentSessionProvenanceSchema,
  sweptSpectrumConfigurationSchema,
  detectedPowerTimeseriesConfigurationSchema,
  instrumentTimestampSchema,
  type SweptSpectrumConfiguration,
  type DetectedPowerTimeseriesConfiguration,
  type InstrumentSessionProvenance,
} from './instrument.js';
import {
  DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
  FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  isSupportedZs407FirmwareIdentity,
  isZs407FirmwareVersionRevisionPair,
  type FirmwareQualification,
  type FirmwareSourceCommit,
} from './firmware-provenance.js';

export * from './instrument.js';
export * from './firmware-provenance.js';
export * from './atomizer-instrument-api.js';

/** Version of the internal TinySA ZS407 shell/protocol contract, not the public renderer API. */
export const TINYSA_PROTOCOL_CONTRACT_VERSION = 3 as const;
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
  firmwareReportedRevision?: string;
  firmwareSourceCommit?: FirmwareSourceCommit;
  firmwareQualification: FirmwareQualification;
  firmwareWarning?: string;
  port: PortCandidate;
  simulated: boolean;
  usbIdentityVerified: boolean;
  execution: ExecutionEnvironment;
  digitalTwin?: DigitalTwinProvenance;
}

/** Runtime boundary for legacy device-service identity before a driver may
 * project it into a generic instrument session. */
export const deviceIdentitySchema = z.object({
  model: z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
  hardwareVersion: z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
  firmwareVersion: z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
  firmwareSourceCommit: z.union([
    z.literal(FIRMWARE_SOURCE_COMMIT),
    z.literal(ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT),
    z.literal(DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT),
  ]).optional(),
  firmwareQualification: z.enum(['supported-oem', 'custom-unqualified', 'executable-twin', 'protocol-test']),
  firmwareWarning: z.string().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1).optional(),
  port: portCandidateSchema,
  simulated: z.boolean(),
  usbIdentityVerified: z.boolean(),
  execution: executionEnvironmentSchema,
  digitalTwin: digitalTwinProvenanceSchema.optional(),
}).strict().superRefine((identity, context) => {
  if (identity.execution !== identity.port.execution) {
    context.addIssue({ code: 'custom', path: ['execution'], message: 'Device identity execution must match its port provenance' });
  }
  if (identity.simulated !== (identity.execution !== 'physical')) {
    context.addIssue({ code: 'custom', path: ['simulated'], message: 'Device identity simulation label must match execution' });
  }
  const expectedUsbVerification = identity.execution === 'physical'
    && identity.port.usbMatch === 'exact-zs407-cdc';
  if (identity.usbIdentityVerified !== expectedUsbVerification) {
    context.addIssue({ code: 'custom', path: ['usbIdentityVerified'], message: 'USB verification must match exact physical ZS407 evidence' });
  }
  const executableTwin = identity.execution === 'firmware-digital-twin';
  if (Boolean(identity.digitalTwin) !== executableTwin
    || Boolean(identity.port.digitalTwin) !== executableTwin
    || (identity.digitalTwin && identity.port.digitalTwin
      && JSON.stringify(identity.digitalTwin) !== JSON.stringify(identity.port.digitalTwin))) {
    context.addIssue({ code: 'custom', path: ['digitalTwin'], message: 'Device and port executable-twin provenance must agree exactly' });
  }
  if (identity.execution === 'physical') {
    if (identity.firmwareQualification !== 'supported-oem'
      && identity.firmwareQualification !== 'custom-unqualified') {
      context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Physical identity requires supported or explicitly unqualified firmware' });
    }
    if (!identity.firmwareReportedRevision
      || !isZs407FirmwareVersionRevisionPair(identity.firmwareVersion, identity.firmwareReportedRevision)) {
      context.addIssue({ code: 'custom', path: ['firmwareReportedRevision'], message: 'Physical identity revision must equal its single tinySA4 version token' });
    } else if (identity.firmwareQualification === 'supported-oem') {
      if (!identity.firmwareSourceCommit
        || !isSupportedZs407FirmwareIdentity(identity.firmwareVersion, identity.firmwareReportedRevision, identity.firmwareSourceCommit)
        || identity.firmwareWarning !== undefined) {
        context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Supported physical firmware must match the closed revision registry without a warning' });
      }
    } else if (identity.firmwareQualification === 'custom-unqualified'
      && (identity.firmwareSourceCommit !== undefined
        || !identity.firmwareWarning?.toLowerCase().includes(identity.firmwareReportedRevision.toLowerCase()))) {
      context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Custom physical firmware requires an exact unresolved-revision warning and no invented commit' });
    }
  } else if (identity.execution === 'firmware-digital-twin') {
    if (identity.firmwareQualification !== 'executable-twin'
      || identity.firmwareSourceCommit !== DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT
      || identity.firmwareReportedRevision !== undefined
      || identity.firmwareWarning !== undefined) {
      context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Executable-twin firmware identity is contradictory' });
    }
  } else if (identity.firmwareQualification !== 'protocol-test') {
    context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Protocol-test execution requires protocol-test firmware qualification' });
  }
});

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
  analyzerNormalMaximumHz?: number;
  analyzerUltraTransitionHz?: number;
  /** Present only when the connected firmware advertised the complete generator command surface. */
  generatorFrequency?: NumericRange;
  generatorFundamentalMaximumHz?: number;
  generatorLevel?: NumericRange;
  rbwKhz: NumericRange;
  attenuationDb: NumericRange;
  sweepPoints: NumericRange;
  sweepSeconds: NumericRange;
  /** Command- and syntax-derived scalar receiver surface for this exact connected firmware. */
  scalarReceiver: {
    sweptSpectrum: boolean;
    detectedPower: boolean;
    acquisitionFormats: readonly ('text' | 'raw')[];
    resolutionBandwidthAutomatic: boolean;
    attenuationAutomatic: boolean;
    sweepTimeAutomatic: boolean;
    detectors: readonly TraceDetector[];
    spurRejection: readonly SpurRejection[];
    lowNoiseAmplifier: readonly ('off' | 'on')[];
    avoidSpurs: readonly SpurRejection[];
    triggerModes: readonly TriggerMode[];
    triggerLevelDbm?: NumericRange;
  };
  maxSweepPoints: number;
  screen: { width: 480; height: 320; format: 'rgb565le' };
  screenCapture: boolean;
  remoteTouch: boolean;
  streaming: boolean;
  rawSweep: boolean;
  rawSweepOffsetReadback: boolean;
  markerCount?: 8;
  traceCount?: 4;
  firmwareMarkers: boolean;
  firmwareTraces: boolean;
  generatorReadback: false;
  modulation: readonly ('off' | 'am' | 'fm')[];
  commands: readonly string[];
  evidence: CapabilityEvidence;
  firmwareSourceCommit?: FirmwareSourceCommit;
  hostContractSourceCommit: typeof FIRMWARE_SOURCE_COMMIT;
  qualification: 'device-observed-awaiting-rf-qualification' | 'custom-firmware-unqualified' | 'executable-twin-observed' | 'protocol-test-only';
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
  if (marker.mode !== 'delta' && marker.referenceMarkerId !== undefined) {
    context.addIssue({ code: 'custom', path: ['referenceMarkerId'], message: 'Only delta markers accept a reference marker' });
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

export const triggerConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({
    mode: z.enum(['normal', 'single']),
    levelDbm: z.number().finite().min(-174).max(30),
  }).strict(),
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

const analyzerConfigShape = {
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
} as const;

export const analyzerConfigSchema = z.object(analyzerConfigShape).strict().refine((value) => value.stopHz > value.startHz, { message: 'stopHz must be greater than startHz', path: ['stopHz'] });
export type AnalyzerConfig = z.infer<typeof analyzerConfigSchema>;

/**
 * Application-layer analyzer edits are patches. The host merges a patch into
 * the current staged configuration and validates the resulting full config
 * before it can reach the generic instrument configuration boundary.
 */
export const analyzerConfigPatchSchema = z.object(analyzerConfigShape).partial().strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Analyzer patch must change at least one field' })
  .superRefine((value, context) => {
    if (value.startHz !== undefined && value.stopHz !== undefined && value.stopHz <= value.startHz) {
      context.addIssue({ code: 'custom', path: ['stopHz'], message: 'stopHz must be greater than startHz' });
    }
  });
export type AnalyzerConfigPatch = z.infer<typeof analyzerConfigPatchSchema>;

const zeroSpanConfigShape = {
  frequencyHz: z.number().int().min(ZS407_FIRMWARE_LIMITS.analyzerMinimumHz).max(ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz),
  points: z.number().int().min(ZS407_FIRMWARE_LIMITS.minimumSweepPoints).max(ZS407_FIRMWARE_LIMITS.maximumSweepPoints),
  rbwKhz: z.union([z.literal('auto'), z.number().finite().min(ZS407_FIRMWARE_LIMITS.minimumRbwKhz).max(ZS407_FIRMWARE_LIMITS.maximumRbwKhz)]),
  attenuationDb: z.union([z.literal('auto'), z.number().int().min(0).max(31)]),
  sweepTimeSeconds: z.number().finite().min(ZS407_FIRMWARE_LIMITS.minimumSweepSeconds).max(ZS407_FIRMWARE_LIMITS.maximumSweepSeconds),
  trigger: triggerConfigSchema,
} as const;

export const zeroSpanConfigSchema = z.object(zeroSpanConfigShape).strict();
export type ZeroSpanConfig = z.infer<typeof zeroSpanConfigSchema>;

/** Detected-power staging follows the same merge-then-admit contract as the
 * swept analyzer. Receiver-only controls remain representable here so the
 * active driver can either admit them truthfully or reject them explicitly. */
export const zeroSpanConfigPatchSchema = z.object(zeroSpanConfigShape).partial().strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Zero-span patch must change at least one field' });
export type ZeroSpanConfigPatch = z.infer<typeof zeroSpanConfigPatchSchema>;

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

export const firmwareTraceIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type FirmwareTraceId = z.infer<typeof firmwareTraceIdSchema>;
export const firmwareTraceVisibilitySchema = z.array(firmwareTraceIdSchema).max(4).superRefine((traceIds, context) => {
  if (new Set(traceIds).size !== traceIds.length) context.addIssue({ code: 'custom', message: 'Firmware trace visibility cannot repeat a trace identifier' });
});
export type FirmwareTraceVisibility = z.infer<typeof firmwareTraceVisibilitySchema>;
export interface FirmwareTraceFrame {
  traceId: FirmwareTraceId;
  role: 'measured' | 'stored' | 'raw';
  unit: 'dBm';
  frozen: boolean | 'unknown';
  frequencyHz: readonly number[];
  powerDbm: readonly number[];
  sourceSweepId: string;
  capturedAt: string;
  evidence: 'firmware-readback';
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

/**
 * Driver-neutral acquisition identity retained by analysis and exports.
 *
 * The wrapper deliberately carries the admitted session/candidate identifiers
 * alongside source-discriminated provenance.  It must never be projected into
 * a DeviceIdentity: SignalLab has no USB or firmware identity to report.
 */
export interface InstrumentMeasurementIdentity {
  kind: 'instrument-session';
  sessionId: string;
  driverId: string;
  candidateId: string;
  provenance: InstrumentSessionProvenance;
}
export type MeasurementIdentity = DeviceIdentity | InstrumentMeasurementIdentity;
export type ResolutionBandwidthQualification = 'device-observed' | 'firmware-executed-twin' | 'synthetic-grid-equivalent' | 'unavailable';
export type AttenuationQualification = 'device-observed' | 'firmware-executed-twin' | 'not-applicable';

export interface Sweep {
  kind: 'spectrum';
  id: string;
  sequence: number;
  capturedAt: string;
  elapsedMilliseconds: number;
  frequencyHz: readonly number[];
  powerDbm: readonly number[];
  /** Exact scalar configuration admitted by the main-process driver boundary. */
  requested: SweptSpectrumConfiguration;
  actualStartHz: number;
  actualStopHz: number;
  actualRbwHz: number;
  actualAttenuationDb: number | null;
  /** Explicit whenever a driver-neutral projection supplied the analysis value. */
  resolutionBandwidthQualification?: ResolutionBandwidthQualification;
  /** Explicit whenever a driver-neutral projection supplied the analysis value. */
  attenuationQualification?: AttenuationQualification;
  source: 'scan-text' | 'scanraw-binary' | 'renode-executable-state' | 'instrument-driver-scalar' | 'signal-lab-synthetic';
  rawSweepOffsetDb?: number;
  firmwareTraces?: readonly FirmwareTraceFrame[];
  complete: true;
  identity: MeasurementIdentity;
}
export interface ZeroSpanCapture {
  kind: 'zero-span';
  id: string;
  sequence: number;
  capturedAt: string;
  elapsedMilliseconds: number;
  frequencyHz: number;
  samplePeriodSeconds: number;
  /** Whether the sample cadence is merely inferred from wall time or calibrated against the returned samples. */
  timingQualification?: 'wall-clock-derived' | 'measured-calibrated' | 'simulation-exact';
  /** Detection selected when this envelope capture was requested, when bound by the host workflow. */
  targetDetectionId?: string;
  powerDbm: readonly number[];
  /** Exact detected-power configuration admitted by the main-process driver boundary. */
  requested: DetectedPowerTimeseriesConfiguration;
  actualRbwHz: number | null;
  actualAttenuationDb: number | null;
  /** Explicit whenever a driver-neutral projection supplied the analysis value. */
  resolutionBandwidthQualification?: ResolutionBandwidthQualification;
  /** Explicit whenever a driver-neutral projection supplied the analysis value. */
  attenuationQualification?: AttenuationQualification;
  source: 'scan-text' | 'renode-executable-state' | 'instrument-driver-detected-power' | 'signal-lab-synthetic';
  complete: true;
  identity: MeasurementIdentity;
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
  minimumProminenceDb: z.number().finite().min(0).max(60),
  minimumConsecutiveSweeps: z.number().int().min(1).max(1_000),
  releaseAfterMissedSweeps: z.number().int().min(0).max(100),
}).strict();
export type SignalDetectionConfig = z.infer<typeof signalDetectionConfigSchema>;
export interface BayesianDetectionEvidence {
  modelId: string;
  /** Scope of the displayed model score; neither value is a sweep-family posterior. */
  posteriorScope: 'selected-local-region' | 'track-state' | 'track-predictive-state';
  priorSignalProbability: number;
  posteriorSignalProbability: number;
  logBayesFactor: number;
  effectiveIndependentBins: number;
  effectiveReferenceCells: number;
  noiseShape: number;
  posteriorPredictiveNullProbability: number;
  targetPosteriorPredictiveNullProbability: number;
  targetSweepFalseAlarmProbability: number;
  multiplicityAdjustedTests: number;
  testedRegionStartHz: number;
  testedRegionStopHz: number;
  qualification: 'ideal-exponential-not-physically-calibrated' | 'receiver-calibrated' | 'synthetic-known-presence';
  noiseSigmaDb: number;
  observedMeanShiftDb: number;
  looks: number;
}
export interface LocalClassificationRegionObservation {
  /** Complete immutable detector input for the one look that froze this local ROI. */
  sourceSweep: Sweep;
  startHz: number;
  stopHz: number;
  peakHz: number;
  detectorId: string;
  /** Immutable one-look evidence; never the later track-state posterior. */
  localBayesianEvidence: BayesianDetectionEvidence;
}
export interface ActivityAssociationObservation {
  /** Complete sweep containing an independently admitted CFAR-local look. */
  sweepId: string;
  /** Frequency-local tracker identity; this is provenance, not emitter identity. */
  trackId: string;
  /** Observed center of the threshold-connected local component in this look. */
  centerHz: number;
  startHz: number;
  stopHz: number;
  rbwHz: number;
  binWidthHz: number;
  /** Immutable local detector model and score that admitted this look. */
  detectorId: string;
  localBayesianEvidence: BayesianDetectionEvidence;
}
export interface MulticomponentSweptRegionMemberObservation {
  /** Frequency-local tracker identity in this sweep; never an emitter identity. */
  trackId: string;
  startHz: number;
  stopHz: number;
  peakHz: number;
  detectorId: string;
  /** Immutable one-look detector evidence, before the tracker posterior is applied. */
  localBayesianEvidence: BayesianDetectionEvidence;
}
export interface MulticomponentSweptRegionAssociationObservation {
  /** Complete sweep in which every listed member was independently detected. */
  sweepId: string;
  sweepSequence: number;
  /** Stable acquisition/source/configuration identity, not a signal identity. */
  geometryId: string;
  sweepStartHz: number;
  sweepStopHz: number;
  rbwHz: number;
  binWidthHz: number;
  observedRegionStartHz: number;
  observedRegionStopHz: number;
  containmentToleranceHz: number;
  /** Observation-only eligibility path; neither path claims a common emitter or process. */
  qualification:
    | 'selected-multiscale-region-containment-not-emitter-identity'
    | 'resolved-component-raster-not-emitter-identity';
  /** Present only when a member's selected multiscale region contains the observed hull. */
  anchorTrackId?: string;
  /** Exact current-sweep members, sorted by track ID. */
  members: readonly MulticomponentSweptRegionMemberObservation[];
}
export interface RegularSpectralComponentAssociationObservation {
  /** Complete immutable detector input for this simultaneous regular-line look. */
  sourceSweep: Sweep;
  observedRegionStartHz: number;
  observedRegionStopHz: number;
  /** Exact independently admitted members, sorted by frequency-local track ID. */
  members: readonly MulticomponentSweptRegionMemberObservation[];
}
export interface ActivityAssociationOpportunity {
  /** Complete, stable-geometry wide sweep considered by the association model. */
  sweepId: string;
  /** Multiple eligible local detections are censored rather than assigned to one emitter. */
  outcome: 'none' | 'exactly-one' | 'ambiguous';
}
export interface BayesianActivityAssociationEvidence {
  modelId: 'bayesian-frequency-agile-transition-v3';
  priorAgileDynamicsProbability: number;
  posteriorAgileDynamicsProbability: number;
  logBayesFactor: number;
  /** Engineering 79-cell full-band transition family; not a Bluetooth BR/EDR protocol likelihood. */
  fullBand79CellAgileLogMarginalLikelihood: number;
  /** Engineering three-primary-channel transition family; not a Bluetooth LE protocol likelihood. */
  threePrimaryChannelAgileLogMarginalLikelihood: number;
  stationaryLogMarginalLikelihood: number;
  positiveObservationCount: number;
  transitionCount: number;
  changedTransitionCount: number;
  uniqueResolutionCellCount: number;
  primaryChannelCenterHitCount: number;
  opportunityCount: number;
  maximumOpportunityWindow: number;
  modeledSweepTimeSeconds: number;
  promotionPosteriorProbability: number;
  retentionPosteriorProbability: number;
  qualification: 'engineering-transition-families-conditional-on-unambiguous-cfar-looks-not-protocol-or-emitter-identity';
}
export interface DetectedSignal {
  id: string;
  startHz: number;
  stopHz: number;
  peakHz: number;
  peakDbm: number;
  prominenceDb: number;
  prominenceThresholdDb: number;
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
  bayesianEvidence: BayesianDetectionEvidence;
  /** Frequency region frozen at the first locally admitted detector candidate for non-recentered classification. */
  classificationRegionStartHz?: number;
  classificationRegionStopHz?: number;
  classificationRegionSweepIds?: readonly string[];
  /** Self-contained one-look provenance used to recompute the frozen local ROI. */
  classificationRegionObservation?: LocalClassificationRegionObservation;
  /** Whether the track is local or carries a separately disclosed, non-emitter-identity association. */
  associationMode?: 'frequency-local' | 'frequency-agile-2g4-activity' | 'regular-spectral-component-activity' | 'multicomponent-swept-region-activity';
  /** Latest independently qualified region in the disclosed non-identity activity lineage. */
  associationRegionStartHz?: number;
  associationRegionStopHz?: number;
  /** Retained same-geometry observations with bounded overlap to the latest public region. */
  associationRegionSweepIds?: readonly string[];
  /** Association-lineage identifier; never an emitter or common-process identity. */
  associationId?: string;
  associationModelId?: string;
  associationMemberTrackIds?: readonly string[];
  /** Ordered local-look provenance for a disclosed, non-identity activity association. */
  associationObservations?: readonly ActivityAssociationObservation[];
  /** Ordered, bounded-overlap same-sweep member provenance ending at the current public region. */
  multicomponentAssociationObservations?: readonly MulticomponentSweptRegionAssociationObservation[];
  /** Ordered, bounded regular-line looks with the detector inputs needed for recomputation. */
  regularComponentAssociationObservations?: readonly RegularSpectralComponentAssociationObservation[];
  /** Every stable-geometry opportunity in the rolling association window. */
  associationOpportunities?: readonly ActivityAssociationOpportunity[];
  /** Bayesian activity evidence, separate from every local detector posterior. */
  associationBayesianEvidence?: BayesianActivityAssociationEvidence;
  /** Stable acquisition-geometry identity for the rolling association window. */
  associationGeometryId?: string;
  /** Consecutive eligible opportunities since the latest exactly-one local look. */
  associationMissedSweeps?: number;
  qualityFlags: readonly ('touches-lower-boundary' | 'touches-upper-boundary' | 'single-bin')[];
}
export interface ClassificationCandidate { label: string; confidence: number; family?: string; }
export type ClassificationUnknownReason = 'model-unavailable' | 'low-confidence' | 'out-of-domain' | 'insufficient-evidence' | 'inference-failed';
export interface WaveformClassification {
  detectionId: string;
  label: string | 'unknown';
  confidence: number;
  candidates: readonly ClassificationCandidate[];
  modelId: string;
  qualification: 'spectral-morphology' | 'signal-lab-synthetic-hypothesis' | 'bayesian-observable-equivalence' | 'unavailable';
  scoreKind: 'relative-score' | 'model-posterior' | 'none';
  decisionLevel: 'morphology' | 'profile' | 'family' | 'equivalence-class' | 'unknown';
  /** Evidence supporting the primary decision; ranked candidates retain their own score semantics. */
  decisionSupport?: {
    kind: 'model-posterior' | 'synthetic-support-rank';
    value: number;
    threshold?: number;
  };
  modelProvenance?: {
    producer: 'tinysa-signal-lab';
    sourceCommit: string;
    /** SHA-256 of the canonical JSON manifest of every admitted training-source artifact. */
    corpusSha256: string;
    preprocessing: string;
    modelAssetSha256?: string;
    priorId?: string;
    calibrationId?: string;
    decisionPolicyId?: string;
  };
  classifiedAt: string;
  unknownReason?: ClassificationUnknownReason;
  evidence: {
    centerHz: number;
    bandwidthHz: number;
    peakDbm: number;
    sweepIds: readonly string[];
    zeroSpanCaptureId?: string;
    views?: readonly ('scalar-spectrum' | 'detected-power-envelope')[];
    features?: Readonly<Record<string, number>>;
    limitations?: readonly string[];
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

/** Text export v1 is intentionally smaller than the binary acquisition limits. */
export const MAX_SWEEP_EXPORT_POINTS_V1 = 100_000;
export const MAX_SWEEP_EXPORT_BYTES_V1 = 8 * 1024 * 1024;
export const MAX_SWEEP_EXPORT_PROVENANCE_CHARACTERS_V1 = 4_096;
export const MAX_SWEEP_EXPORT_FIRMWARE_TRACES_V1 = 4;

const exportMetadataStringSchema = z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1);
const exportFrequencySchema = z.number().finite().nonnegative().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const exportPowerSchema = z.number().finite()
  .min(-MAX_INSTRUMENT_POWER_ABS_DB_V1)
  .max(MAX_INSTRUMENT_POWER_ABS_DB_V1);
function boundedExportArray<Element extends z.ZodType>(
  element: Element,
  maximum: number,
  minimum = 0,
) {
  return z.unknown()
    .transform((value, context) => {
      if (Array.isArray(value) && value.length > maximum) {
        context.addIssue({
          code: 'custom',
          message: `Sweep export v1 permits at most ${maximum} items`,
        });
        return z.NEVER;
      }
      return value;
    })
    .pipe(z.array(element).min(minimum).max(maximum).readonly());
}
const exportDigitalTwinProvenanceSchema = digitalTwinProvenanceSchema.extend({
  bootEvidence: z.string()
    .min(1)
    .max(MAX_SWEEP_EXPORT_PROVENANCE_CHARACTERS_V1)
    .startsWith('ZS407_TWIN_BOOT=PASS')
    .optional(),
}).strict();
const exportPortCandidateSchema = z.object({
  id: instrumentOpaqueIdSchema,
  path: z.string().min(1).max(MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1),
  manufacturer: exportMetadataStringSchema.optional(),
  product: exportMetadataStringSchema.optional(),
  serialNumber: exportMetadataStringSchema.optional(),
  vendorId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  productId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  usbMatch: usbMatchSchema,
  transport: instrumentTransportKindSchema,
  execution: executionEnvironmentSchema,
  digitalTwin: exportDigitalTwinProvenanceSchema.optional(),
}).strict().superRefine((candidate, context) => {
  if (!portCandidateSchema.safeParse(candidate).success) {
    context.addIssue({ code: 'custom', message: 'Export port provenance is internally inconsistent' });
  }
});
const exportFirmwareSourceCommitSchema = z.union([
  z.literal(FIRMWARE_SOURCE_COMMIT),
  z.literal(ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT),
  z.literal(DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT),
]);
const exportDeviceIdentitySchema = z.object({
  model: exportMetadataStringSchema,
  hardwareVersion: exportMetadataStringSchema,
  firmwareVersion: exportMetadataStringSchema,
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
  firmwareSourceCommit: exportFirmwareSourceCommitSchema.optional(),
  firmwareQualification: z.enum(['supported-oem', 'custom-unqualified', 'executable-twin', 'protocol-test']),
  firmwareWarning: z.string().min(1).max(MAX_SWEEP_EXPORT_PROVENANCE_CHARACTERS_V1).optional(),
  port: exportPortCandidateSchema,
  simulated: z.boolean(),
  usbIdentityVerified: z.boolean(),
  execution: executionEnvironmentSchema,
  digitalTwin: exportDigitalTwinProvenanceSchema.optional(),
}).strict().superRefine((identity, context) => {
  if (identity.execution !== identity.port.execution) {
    context.addIssue({ code: 'custom', path: ['execution'], message: 'Export identity execution must match its admitted port' });
  }
  const simulated = identity.execution !== 'physical';
  if (identity.simulated !== simulated) {
    context.addIssue({ code: 'custom', path: ['simulated'], message: 'Export identity simulation label must match execution' });
  }
  if (Boolean(identity.digitalTwin) !== (identity.execution === 'firmware-digital-twin')) {
    context.addIssue({ code: 'custom', path: ['digitalTwin'], message: 'Export identity digital-twin provenance must match execution' });
  }
  if (identity.execution === 'firmware-digital-twin'
    && JSON.stringify(identity.digitalTwin) !== JSON.stringify(identity.port.digitalTwin)) {
    context.addIssue({ code: 'custom', path: ['digitalTwin'], message: 'Export identity and port digital-twin provenance must agree' });
  }
  if (identity.usbIdentityVerified && identity.port.usbMatch !== 'exact-zs407-cdc') {
    context.addIssue({ code: 'custom', path: ['usbIdentityVerified'], message: 'Verified USB identity requires an exact ZS407 match' });
  }
  if (identity.firmwareQualification === 'supported-oem') {
    if (identity.execution !== 'physical') {
      context.addIssue({ code: 'custom', path: ['execution'], message: 'Supported OEM export identity must be physical' });
    }
    if (!identity.firmwareReportedRevision || !identity.firmwareSourceCommit) {
      context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Supported OEM export identity requires reported revision and exact source commit' });
    } else if (!isZs407FirmwareVersionRevisionPair(identity.firmwareVersion, identity.firmwareReportedRevision)) {
      context.addIssue({ code: 'custom', path: ['firmwareReportedRevision'], message: 'Supported OEM export revision must equal the single revision token in the firmware version' });
    } else if (!isSupportedZs407FirmwareIdentity(identity.firmwareVersion, identity.firmwareReportedRevision, identity.firmwareSourceCommit)) {
      context.addIssue({ code: 'custom', path: ['firmwareSourceCommit'], message: 'Supported OEM export revision and source commit must match the closed qualification registry' });
    }
    if (identity.firmwareWarning !== undefined) {
      context.addIssue({ code: 'custom', path: ['firmwareWarning'], message: 'Supported OEM export identity cannot carry a custom-firmware warning' });
    }
  }
  if (identity.firmwareQualification === 'custom-unqualified') {
    if (identity.execution !== 'physical') {
      context.addIssue({ code: 'custom', path: ['execution'], message: 'Custom export identity must be physical' });
    }
    if (!identity.firmwareReportedRevision || !identity.firmwareWarning) {
      context.addIssue({ code: 'custom', path: ['firmwareQualification'], message: 'Custom export identity requires reported revision and exact warning' });
    } else if (!isZs407FirmwareVersionRevisionPair(identity.firmwareVersion, identity.firmwareReportedRevision)) {
      context.addIssue({ code: 'custom', path: ['firmwareReportedRevision'], message: 'Custom export revision must equal the single revision token in the firmware version' });
    } else if (!identity.firmwareWarning.toLowerCase().includes(identity.firmwareReportedRevision.toLowerCase())) {
      context.addIssue({ code: 'custom', path: ['firmwareWarning'], message: 'Custom export warning must identify the unresolved reported revision' });
    }
    if (identity.firmwareSourceCommit !== undefined) {
      context.addIssue({ code: 'custom', path: ['firmwareSourceCommit'], message: 'Custom export identity cannot invent a source commit' });
    }
  }
});
const exportInstrumentMeasurementIdentitySchema = z.object({
  kind: z.literal('instrument-session'),
  sessionId: instrumentOpaqueIdSchema,
  driverId: instrumentDriverIdSchema,
  candidateId: instrumentOpaqueIdSchema,
  provenance: instrumentSessionProvenanceSchema,
}).strict();
const exportMeasurementIdentitySchema = z.union([
  exportInstrumentMeasurementIdentitySchema,
  exportDeviceIdentitySchema,
]);
const exportFirmwareTraceFrameSchema = z.object({
  traceId: firmwareTraceIdSchema,
  role: z.enum(['measured', 'stored', 'raw']),
  unit: z.literal('dBm'),
  frozen: z.union([z.boolean(), z.literal('unknown')]),
  frequencyHz: boundedExportArray(exportFrequencySchema, MAX_SWEEP_EXPORT_POINTS_V1, 1),
  powerDbm: boundedExportArray(exportPowerSchema, MAX_SWEEP_EXPORT_POINTS_V1, 1),
  sourceSweepId: instrumentOpaqueIdSchema,
  capturedAt: instrumentTimestampSchema,
  evidence: z.literal('firmware-readback'),
}).strict().superRefine((trace, context) => {
  if (trace.frequencyHz.length > MAX_SWEEP_EXPORT_POINTS_V1
    || trace.powerDbm.length > MAX_SWEEP_EXPORT_POINTS_V1) return;
  if (trace.frequencyHz.length !== trace.powerDbm.length) {
    context.addIssue({ code: 'custom', path: ['powerDbm'], message: 'Firmware trace vectors must have equal length' });
  }
  for (let index = 1; index < trace.frequencyHz.length; index++) {
    if (trace.frequencyHz[index]! <= trace.frequencyHz[index - 1]!) {
      context.addIssue({ code: 'custom', path: ['frequencyHz', index], message: 'Firmware trace frequencies must increase strictly' });
      break;
    }
  }
});
export const sweepExportSweepSchema: z.ZodType<Sweep> = z.object({
  kind: z.literal('spectrum'),
  id: instrumentOpaqueIdSchema,
  sequence: z.number().int().positive().max(MAX_INSTRUMENT_SEQUENCE_V1),
  capturedAt: instrumentTimestampSchema,
  elapsedMilliseconds: z.number().finite().nonnegative().max(MAX_INSTRUMENT_ELAPSED_MILLISECONDS_V1),
  frequencyHz: boundedExportArray(exportFrequencySchema, MAX_SWEEP_EXPORT_POINTS_V1, 1),
  powerDbm: boundedExportArray(exportPowerSchema, MAX_SWEEP_EXPORT_POINTS_V1, 1),
  requested: sweptSpectrumConfigurationSchema,
  actualStartHz: exportFrequencySchema,
  actualStopHz: exportFrequencySchema,
  actualRbwHz: z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1),
  actualAttenuationDb: exportPowerSchema.nullable(),
  resolutionBandwidthQualification: z.enum([
    'device-observed', 'firmware-executed-twin', 'synthetic-grid-equivalent', 'unavailable',
  ]).optional(),
  attenuationQualification: z.enum(['device-observed', 'firmware-executed-twin', 'not-applicable']).optional(),
  source: z.enum([
    'scan-text', 'scanraw-binary', 'renode-executable-state', 'instrument-driver-scalar', 'signal-lab-synthetic',
  ]),
  rawSweepOffsetDb: exportPowerSchema.optional(),
  firmwareTraces: boundedExportArray(
    exportFirmwareTraceFrameSchema,
    MAX_SWEEP_EXPORT_FIRMWARE_TRACES_V1,
  ).optional(),
  complete: z.literal(true),
  identity: exportMeasurementIdentitySchema,
}).strict().superRefine((sweep, context) => {
  if (sweep.frequencyHz.length > MAX_SWEEP_EXPORT_POINTS_V1
    || sweep.powerDbm.length > MAX_SWEEP_EXPORT_POINTS_V1
    || (sweep.firmwareTraces?.length ?? 0) > MAX_SWEEP_EXPORT_FIRMWARE_TRACES_V1) return;
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) {
    context.addIssue({ code: 'custom', path: ['powerDbm'], message: 'Spectrum export vectors must have equal length' });
  }
  if (sweep.frequencyHz.length !== sweep.requested.points) {
    context.addIssue({ code: 'custom', path: ['frequencyHz'], message: 'Spectrum export vectors must match the requested point count' });
  }
  if (!matchesRequestedExportGrid(sweep.frequencyHz, sweep.requested.startHz, sweep.requested.stopHz)) {
    context.addIssue({ code: 'custom', path: ['requested'], message: 'Spectrum export frequency grid must match the complete requested geometry' });
  }
  for (let index = 1; index < sweep.frequencyHz.length; index++) {
    if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) {
      context.addIssue({ code: 'custom', path: ['frequencyHz', index], message: 'Spectrum export frequencies must increase strictly' });
      break;
    }
  }
  if (sweep.actualStartHz !== sweep.frequencyHz[0] || sweep.actualStopHz !== sweep.frequencyHz.at(-1)) {
    context.addIssue({ code: 'custom', path: ['actualStartHz'], message: 'Actual spectrum endpoints must match the exported frequency vector' });
  }
  if (sweep.actualAttenuationDb === null && sweep.attenuationQualification !== 'not-applicable') {
    context.addIssue({ code: 'custom', path: ['attenuationQualification'], message: 'Unavailable attenuation must be explicitly not-applicable' });
  }
  if (sweep.source === 'scanraw-binary' && sweep.rawSweepOffsetDb === undefined) {
    context.addIssue({ code: 'custom', path: ['rawSweepOffsetDb'], message: 'scanraw-binary exports require raw sweep offset evidence' });
  }
  if (sweep.rawSweepOffsetDb !== undefined
    && sweep.source !== 'scanraw-binary'
    && sweep.source !== 'renode-executable-state') {
    context.addIssue({ code: 'custom', path: ['rawSweepOffsetDb'], message: 'Raw sweep offset evidence requires binary scan or executable-twin acquisition provenance' });
  }

  const requireSource = (allowed: readonly Sweep['source'][], label: string): void => {
    if (!allowed.includes(sweep.source)) {
      context.addIssue({ code: 'custom', path: ['source'], message: `${label} requires source ${allowed.join(' or ')}` });
    }
  };
  const requireResolutionQualification = (
    expected: NonNullable<Sweep['resolutionBandwidthQualification']>,
    required: boolean,
    label: string,
  ): void => {
    if ((required && sweep.resolutionBandwidthQualification !== expected)
      || (!required && sweep.resolutionBandwidthQualification !== undefined && sweep.resolutionBandwidthQualification !== expected)) {
      context.addIssue({ code: 'custom', path: ['resolutionBandwidthQualification'], message: `${label} requires ${expected} resolution qualification${required ? '' : ' when specified'}` });
    }
  };
  const requireAttenuation = (
    expected: NonNullable<Sweep['attenuationQualification']> | undefined,
    value: 'observed' | 'not-applicable',
    required: boolean,
    label: string,
  ): void => {
    if ((required && sweep.attenuationQualification !== expected)
      || (!required && sweep.attenuationQualification !== undefined && sweep.attenuationQualification !== expected)) {
      context.addIssue({ code: 'custom', path: ['attenuationQualification'], message: `${label} has contradictory attenuation qualification` });
    }
    if ((value === 'not-applicable') !== (sweep.actualAttenuationDb === null)) {
      context.addIssue({ code: 'custom', path: ['actualAttenuationDb'], message: `${label} has contradictory attenuation value` });
    }
  };

  if ('kind' in sweep.identity) {
    const provenance = sweep.identity.provenance;
    if (sweep.rawSweepOffsetDb !== undefined) {
      context.addIssue({ code: 'custom', path: ['rawSweepOffsetDb'], message: 'Driver-neutral instrument-session projection cannot assert transport raw-sweep offset evidence' });
    }
    if (provenance.sourceKind === 'serial-port') {
      requireExportControlModel(sweep, context, 'receiver', 'Physical instrument-session provenance');
      requireSource(['instrument-driver-scalar'], 'Physical instrument-session provenance');
      requireResolutionQualification('device-observed', true, 'Physical instrument-session provenance');
      requireAttenuation('device-observed', 'observed', true, 'Physical instrument-session provenance');
    } else if (provenance.sourceKind === 'tinysa-firmware-twin') {
      requireExportControlModel(sweep, context, 'receiver', 'Executable-twin instrument-session provenance');
      requireSource(['renode-executable-state'], 'Executable-twin instrument-session provenance');
      requireResolutionQualification('firmware-executed-twin', true, 'Executable-twin instrument-session provenance');
      requireAttenuation('firmware-executed-twin', 'observed', true, 'Executable-twin instrument-session provenance');
    } else if (provenance.sourceKind === 'signal-lab') {
      requireExportControlModel(sweep, context, 'synthetic-scalar', 'SignalLab instrument-session provenance');
      requireSource(['signal-lab-synthetic'], 'SignalLab instrument-session provenance');
      requireResolutionQualification('synthetic-grid-equivalent', true, 'SignalLab instrument-session provenance');
      requireAttenuation('not-applicable', 'not-applicable', true, 'SignalLab instrument-session provenance');
      const minimumGridSpacing = Math.min(...sweep.frequencyHz.slice(1).map(
        (frequency, index) => frequency - sweep.frequencyHz[index]!,
      ));
      if (!Number.isFinite(minimumGridSpacing) || minimumGridSpacing <= 0 || sweep.actualRbwHz !== minimumGridSpacing) {
        context.addIssue({ code: 'custom', path: ['actualRbwHz'], message: 'SignalLab synthetic-grid resolution must equal the minimum exported frequency spacing' });
      }
    } else {
      const unhandledProvenance: never = provenance;
      throw new Error(`Sweep export validation is undefined for ${JSON.stringify(unhandledProvenance)}`);
    }
  } else if (sweep.identity.execution === 'physical') {
    requireExportControlModel(sweep, context, 'receiver', 'Physical legacy device provenance');
    requireSource(['scan-text', 'scanraw-binary'], 'Physical legacy device provenance');
    requireResolutionQualification('device-observed', false, 'Physical legacy device provenance');
    requireAttenuation('device-observed', 'observed', false, 'Physical legacy device provenance');
  } else if (sweep.identity.execution === 'firmware-digital-twin') {
    requireExportControlModel(sweep, context, 'receiver', 'Executable-twin legacy device provenance');
    requireSource(['renode-executable-state'], 'Executable-twin legacy device provenance');
    requireResolutionQualification('firmware-executed-twin', false, 'Executable-twin legacy device provenance');
    requireAttenuation('firmware-executed-twin', 'observed', false, 'Executable-twin legacy device provenance');
  } else {
    requireExportControlModel(sweep, context, 'receiver', 'Protocol-test legacy device provenance');
    requireSource(['scan-text', 'scanraw-binary'], 'Protocol-test legacy device provenance');
    if (sweep.resolutionBandwidthQualification !== undefined || sweep.attenuationQualification !== undefined) {
      context.addIssue({ code: 'custom', path: ['identity'], message: 'Protocol-test legacy provenance cannot claim observed measurement qualifications' });
    }
    requireAttenuation(undefined, 'observed', false, 'Protocol-test legacy device provenance');
  }
});

function requireExportControlModel(
  sweep: Sweep,
  context: z.RefinementCtx,
  expected: Sweep['requested']['controls']['model'],
  label: string,
): void {
  if (sweep.requested.controls.model !== expected) {
    context.addIssue({ code: 'custom', path: ['requested', 'controls', 'model'], message: `${label} requires ${expected} requested controls` });
  }
}

function matchesRequestedExportGrid(
  frequencyHz: readonly number[],
  startHz: number,
  stopHz: number,
): boolean {
  if (frequencyHz.length < 2) return false;
  const spanHz = stopHz - startHz;
  return matchesExportUniformGrid(frequencyHz, startHz, spanHz / (frequencyHz.length - 1))
    || matchesExportUniformGrid(frequencyHz, startHz, spanHz / frequencyHz.length);
}

function matchesExportUniformGrid(
  frequencyHz: readonly number[],
  startHz: number,
  stepHz: number,
): boolean {
  const toleranceHz = Math.max(1, Math.abs(stepHz) * 1e-9);
  return Number.isFinite(stepHz)
    && stepHz > 0
    && frequencyHz.every((frequency, index) => Math.abs(frequency - (startHz + stepHz * index)) <= toleranceHz);
}
export const sweepExportRequestSchema = z.object({
  sweep: sweepExportSweepSchema,
  format: z.enum(['csv', 'json']),
}).strict();
export type SweepExportRequest = z.infer<typeof sweepExportRequestSchema>;
export type SweepExportResult =
  | { status: 'saved'; path: string; format: 'csv' | 'json'; bytesWritten: number }
  | { status: 'cancelled'; format: 'csv' | 'json' };

export const ATOMIZER_FILES_API_VERSION = 1 as const;
export interface AtomizerFilesApiV1 {
  readonly version: typeof ATOMIZER_FILES_API_VERSION;
  exportSweep(request: SweepExportRequest): Promise<SweepExportResult>;
}

export type DeviceErrorCode = 'not-connected' | 'unsupported' | 'invalid-state' | 'invalid-request' | 'timeout' | 'cancelled' | 'transport' | 'protocol' | 'identity-mismatch';
export interface DeviceError { code: DeviceErrorCode; message: string; operationId?: string; recoverable: boolean; }
export type DeviceEvent =
  | { type: 'snapshot'; snapshot: DeviceSnapshot }
  | { type: 'sweep'; sweep: Sweep }
  | { type: 'zero-span'; capture: ZeroSpanCapture }
  | { type: 'screen'; frame: ScreenFrame }
  | { type: 'diagnostics'; diagnostics: DeviceDiagnostics }
  | { type: 'error'; error: DeviceError };

export interface WaveformClassificationEvidence {
  /** Provenance-bound repeated scalar spectra; the production model requires eight admissions. */
  sweeps: readonly Sweep[];
  /** Optional fixed-tune detected-power capture bound to the selected detection. */
  zeroSpan?: ZeroSpanCapture;
}

export interface AnalysisApiV2 {
  listModes(): Promise<readonly AnalysisModeDefinition[]>;
  configureDetection(config: SignalDetectionConfig): Promise<void>;
  analyzeSweep(sweep: Sweep): Promise<readonly DetectedSignal[]>;
  classify(detection: DetectedSignal, evidence: WaveformClassificationEvidence): Promise<WaveformClassification>;
}
