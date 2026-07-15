import { z } from 'zod';
import {
  isSupportedZs407FirmwareIdentity,
  isZs407FirmwareVersionRevisionPair,
} from './firmware-provenance.js';

export const INSTRUMENT_CONTRACT_VERSION = 1 as const;
export const MAX_COMPLEX_IQ_BYTES_V1 = 64 * 1024 * 1024;
export const MAX_COMPLEX_IQ_SAMPLES_V1 = MAX_COMPLEX_IQ_BYTES_V1 / 8;
/**
 * Absolute resource limits for instrument contract v1. These are protocol
 * ceilings, not device capability claims: every driver (including future SDR
 * drivers) must advertise and return values inside them.
 */
export const MAX_SCALAR_MEASUREMENT_BYTES_V1 = 4 * 1024 * 1024;
export const MAX_SWEPT_SPECTRUM_POINTS_V1 = MAX_SCALAR_MEASUREMENT_BYTES_V1 / 16;
export const MAX_DETECTED_POWER_SAMPLES_V1 = MAX_SCALAR_MEASUREMENT_BYTES_V1 / 8;
export const MAX_SCREEN_FRAME_BYTES_V1 = 64 * 1024 * 1024;
export const MAX_SCREEN_DIMENSION_V1 = 8_192;
export const MAX_INSTRUMENT_FREQUENCY_HZ_V1 = 1_000_000_000_000;
export const MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1 = 10_000_000_000;
export const MAX_INSTRUMENT_DURATION_SECONDS_V1 = 86_400;
export const MAX_INSTRUMENT_ELAPSED_MILLISECONDS_V1 = 7 * 24 * 60 * 60 * 1_000;
export const MAX_INSTRUMENT_POWER_ABS_DB_V1 = 1_000;
export const MAX_DRIVER_DISCOVERY_CANDIDATES_V1 = 256;
export const MAX_DRIVER_DISCOVERY_FAILURES_V1 = 64;
export const MAX_DISCOVERY_CANDIDATES_V1 = 1_024;
export const MAX_DISCOVERY_FAILURES_V1 = 256;
export const MAX_ACQUISITION_CAPABILITIES_V1 = 3;
export const MAX_FEATURE_CAPABILITIES_V1 = 5;
export const MAX_RF_GENERATOR_PATHS_V1 = 2;
export const MAX_DIAGNOSTIC_REPORTS_V1 = 3;
export const MAX_DIAGNOSTIC_LINES_V1 = 256;
export const MAX_DIAGNOSTIC_LINE_CHARACTERS_V1 = 2_048;
export const MAX_SIGNAL_LAB_PROFILES_V1 = 1_024;
export const MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1 = 1_024;
export const MAX_INSTRUMENT_METADATA_CHARACTERS_V1 = 512;
export const MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1 = 4_096;
export const MAX_INSTRUMENT_TIMESTAMP_CHARACTERS_V1 = 64;
export const MAX_INSTRUMENT_SEQUENCE_V1 = Number.MAX_SAFE_INTEGER;
export const MAX_INSTRUMENT_DRIVER_ID_CHARACTERS_V1 = 128;
export const MAX_INSTRUMENT_OPAQUE_ID_CHARACTERS_V1 = 256;
export const MAX_INSTRUMENT_SOURCE_KINDS_V1 = 3;
export const SIGNAL_LAB_EXACT_SWEEP_SECONDS_V1 = 0.05;
/** Exact integer-Hz scalar tuning lattice advertised by the SignalLab v1 driver. */
export const SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1 = Object.freeze({
  min: 1,
  max: 17_922_600_000,
  step: 1,
} as const);

/**
 * Project a measured/detected centroid onto an advertised integer-Hz
 * detected-power tuning lattice. A missing capability step means every
 * integer hertz is supported. Half-step ties select the higher lattice point.
 * Out-of-range or non-finite observations are rejected rather than clamped.
 */
export function projectDetectedPowerTuneHz(
  observedFrequencyHz: number,
  centerFrequencyHz: Readonly<{ min: number; max: number; step?: number }>,
): number {
  if (!Number.isFinite(observedFrequencyHz)) {
    throw new TypeError(`Detected-power tune source ${observedFrequencyHz} Hz must be finite`);
  }
  const step = centerFrequencyHz.step ?? 1;
  if (!Number.isSafeInteger(centerFrequencyHz.min)
    || !Number.isSafeInteger(centerFrequencyHz.max)
    || !Number.isSafeInteger(step)
    || centerFrequencyHz.min < 0
    || centerFrequencyHz.max < centerFrequencyHz.min
    || step <= 0) {
    throw new TypeError('Detected-power center-frequency capability must be a nonnegative safe-integer range with a positive safe-integer step');
  }
  if (observedFrequencyHz < centerFrequencyHz.min || observedFrequencyHz > centerFrequencyHz.max) {
    throw new RangeError(`Detected-power tune source ${observedFrequencyHz} Hz is outside ${centerFrequencyHz.min}-${centerFrequencyHz.max} Hz`);
  }
  const maximumStepIndex = Math.floor((centerFrequencyHz.max - centerFrequencyHz.min) / step);
  const nearestStepIndex = Math.min(
    maximumStepIndex,
    Math.max(0, Math.round((observedFrequencyHz - centerFrequencyHz.min) / step)),
  );
  const projected = centerFrequencyHz.min + nearestStepIndex * step;
  if (!Number.isSafeInteger(projected)) throw new RangeError('Projected detected-power tune is not a safe integer hertz value');
  return projected;
}

export const INSTRUMENT_CONTRACT_LIMITS_V1 = Object.freeze({
  complexIqBytes: MAX_COMPLEX_IQ_BYTES_V1,
  scalarMeasurementBytes: MAX_SCALAR_MEASUREMENT_BYTES_V1,
  sweptSpectrumPoints: MAX_SWEPT_SPECTRUM_POINTS_V1,
  detectedPowerSamples: MAX_DETECTED_POWER_SAMPLES_V1,
  screenFrameBytes: MAX_SCREEN_FRAME_BYTES_V1,
  screenDimension: MAX_SCREEN_DIMENSION_V1,
  frequencyHz: MAX_INSTRUMENT_FREQUENCY_HZ_V1,
  sampleRateHz: MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1,
  durationSeconds: MAX_INSTRUMENT_DURATION_SECONDS_V1,
  elapsedMilliseconds: MAX_INSTRUMENT_ELAPSED_MILLISECONDS_V1,
  powerAbsoluteDb: MAX_INSTRUMENT_POWER_ABS_DB_V1,
  driverDiscoveryCandidates: MAX_DRIVER_DISCOVERY_CANDIDATES_V1,
  driverDiscoveryFailures: MAX_DRIVER_DISCOVERY_FAILURES_V1,
  discoveryCandidates: MAX_DISCOVERY_CANDIDATES_V1,
  discoveryFailures: MAX_DISCOVERY_FAILURES_V1,
  acquisitionCapabilities: MAX_ACQUISITION_CAPABILITIES_V1,
  featureCapabilities: MAX_FEATURE_CAPABILITIES_V1,
  rfGeneratorPaths: MAX_RF_GENERATOR_PATHS_V1,
  diagnosticReports: MAX_DIAGNOSTIC_REPORTS_V1,
  diagnosticLines: MAX_DIAGNOSTIC_LINES_V1,
  diagnosticLineCharacters: MAX_DIAGNOSTIC_LINE_CHARACTERS_V1,
  signalLabProfiles: MAX_SIGNAL_LAB_PROFILES_V1,
  endpointPathCharacters: MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1,
  metadataCharacters: MAX_INSTRUMENT_METADATA_CHARACTERS_V1,
  messageCharacters: MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1,
  timestampCharacters: MAX_INSTRUMENT_TIMESTAMP_CHARACTERS_V1,
  sequence: MAX_INSTRUMENT_SEQUENCE_V1,
  driverIdCharacters: MAX_INSTRUMENT_DRIVER_ID_CHARACTERS_V1,
  opaqueIdCharacters: MAX_INSTRUMENT_OPAQUE_ID_CHARACTERS_V1,
  sourceKinds: MAX_INSTRUMENT_SOURCE_KINDS_V1,
} as const);

export const instrumentDriverIdSchema = z.string().min(1).max(MAX_INSTRUMENT_DRIVER_ID_CHARACTERS_V1)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export type InstrumentDriverId = z.infer<typeof instrumentDriverIdSchema>;
export const instrumentOpaqueIdSchema = z.string().min(1).max(MAX_INSTRUMENT_OPAQUE_ID_CHARACTERS_V1).regex(/\S/);
export type InstrumentOpaqueId = z.infer<typeof instrumentOpaqueIdSchema>;
export const instrumentTimestampSchema = z.string().max(MAX_INSTRUMENT_TIMESTAMP_CHARACTERS_V1).datetime();

const endpointPathSchema = z.string().min(1).max(MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1);
const metadataStringSchema = z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1);
const frequencyHzSchema = z.number().int().nonnegative().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const positiveFrequencyHzSchema = z.number().int().positive().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const measuredFrequencyHzSchema = z.number().finite().nonnegative().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const sampleRateHzSchema = z.number().int().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1);
const boundedPowerSchema = z.number().finite()
  .min(-MAX_INSTRUMENT_POWER_ABS_DB_V1)
  .max(MAX_INSTRUMENT_POWER_ABS_DB_V1);

/** Rejects over-limit arrays before Zod walks or copies their elements. */
function boundedReadonlyArray<Element extends z.ZodType>(
  element: Element,
  maximum: number,
  minimum = 0,
) {
  return z.unknown()
    .transform((value, context) => {
      if (Array.isArray(value) && value.length > maximum) {
        context.addIssue({
          code: 'custom',
          message: `Instrument contract v1 permits at most ${maximum} items`,
        });
        // A non-fatal refine still lets the containing object's superRefine
        // inspect the original array. Abort the property pipeline so an
        // oversized vector is never traversed by geometry checks.
        return z.NEVER;
      }
      return value;
    })
    .pipe(z.array(element).min(minimum).max(maximum).readonly());
}

/**
 * Binary payloads cross the Electron boundary with their entire backing
 * buffer. Require a dedicated, compact ArrayBuffer so a small admitted view
 * cannot smuggle a much larger allocation (or shared memory) through IPC.
 */
function compactUint8ArraySchema(maximumBytes: number) {
  return z.instanceof(Uint8Array).superRefine((bytes, context) => {
    if (!(bytes.buffer instanceof ArrayBuffer)) {
      context.addIssue({
        code: 'custom',
        message: 'Binary payloads must be backed by an ordinary ArrayBuffer',
      });
      return;
    }
    if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
      context.addIssue({
        code: 'custom',
        message: 'Binary payloads must use a compact, dedicated backing buffer',
      });
    }
    if (bytes.byteLength > maximumBytes) {
      context.addIssue({
        code: 'custom',
        message: `Binary payloads are limited to ${maximumBytes} bytes in contract v1`,
      });
    }
  });
}

export const instrumentSourceKindSchema = z.enum(['serial-port', 'tinysa-firmware-twin', 'signal-lab']);
export type InstrumentSourceKind = z.infer<typeof instrumentSourceKindSchema>;

const candidateBaseShape = {
  schemaVersion: z.literal(INSTRUMENT_CONTRACT_VERSION),
  driverId: instrumentDriverIdSchema,
  candidateId: instrumentOpaqueIdSchema,
  displayName: z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
} as const;

/** A concrete serial endpoint. USB evidence is confined to this variant. */
export const serialInstrumentCandidateDescriptorSchema = z.object({
  ...candidateBaseShape,
  sourceKind: z.literal('serial-port'),
  serialPort: z.object({
    path: endpointPathSchema,
    manufacturer: metadataStringSchema.optional(),
    product: metadataStringSchema.optional(),
    serialNumber: metadataStringSchema.optional(),
    vendorId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
    productId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  }).strict(),
}).strict();

/** Executable TinySA firmware backend; it is explicitly not a USB device. */
export const tinySaFirmwareTwinCandidateDescriptorSchema = z.object({
  ...candidateBaseShape,
  sourceKind: z.literal('tinysa-firmware-twin'),
  firmwareTwin: z.object({
    bridge: z.literal('renode-monitor-v1'),
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/),
    firmwareBinarySha256: z.string().regex(/^[a-f0-9]{64}$/),
    usbTransactionsModeled: z.literal(false),
  }).strict(),
}).strict();

/** A SignalLab-owned synthetic source. Hardware identity belongs to hardware drivers. */
export const signalLabInstrumentCandidateDescriptorSchema = z.object({
  ...candidateBaseShape,
  sourceKind: z.literal('signal-lab'),
  signalLab: z.object({
    sourceId: instrumentOpaqueIdSchema,
  }).strict(),
}).strict();

export const instrumentCandidateDescriptorSchema = z.discriminatedUnion('sourceKind', [
  serialInstrumentCandidateDescriptorSchema,
  tinySaFirmwareTwinCandidateDescriptorSchema,
  signalLabInstrumentCandidateDescriptorSchema,
]);
export type InstrumentCandidateDescriptor = z.infer<typeof instrumentCandidateDescriptorSchema>;

/** A source-scoped discovery outcome returned by one instrument driver. */
export const instrumentDriverDiscoveryFailureSchema = z.object({
  sourceKind: instrumentSourceKindSchema.optional(),
  code: z.enum(['source-unavailable', 'driver-failure']),
  recoverable: z.boolean(),
  message: z.string().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
}).strict();
export type InstrumentDriverDiscoveryFailure = z.infer<typeof instrumentDriverDiscoveryFailureSchema>;
export const instrumentDriverDiscoveryResultSchema = z.object({
  candidates: boundedReadonlyArray(instrumentCandidateDescriptorSchema, MAX_DRIVER_DISCOVERY_CANDIDATES_V1),
  failures: boundedReadonlyArray(instrumentDriverDiscoveryFailureSchema, MAX_DRIVER_DISCOVERY_FAILURES_V1),
}).strict();
export type InstrumentDriverDiscoveryResult = z.infer<typeof instrumentDriverDiscoveryResultSchema>;

export const serialInstrumentCandidateSchema = serialInstrumentCandidateDescriptorSchema.extend({
  discoveryRevision: instrumentOpaqueIdSchema,
}).strict();
export const tinySaFirmwareTwinCandidateSchema = tinySaFirmwareTwinCandidateDescriptorSchema.extend({
  discoveryRevision: instrumentOpaqueIdSchema,
}).strict();
export const signalLabInstrumentCandidateSchema = signalLabInstrumentCandidateDescriptorSchema.extend({
  discoveryRevision: instrumentOpaqueIdSchema,
}).strict();
export const instrumentCandidateSchema = z.discriminatedUnion('sourceKind', [
  serialInstrumentCandidateSchema,
  tinySaFirmwareTwinCandidateSchema,
  signalLabInstrumentCandidateSchema,
]);
export type InstrumentCandidate = z.infer<typeof instrumentCandidateSchema>;

function boundedIntegerRangeSchema(maximum: number, minimum = 0) {
  return z.object({
    min: z.number().int().min(minimum).max(maximum),
    max: z.number().int().min(minimum).max(maximum),
    step: z.number().int().positive().max(maximum).optional(),
  }).strict().superRefine((range, context) => {
    if (range.max < range.min) context.addIssue({ code: 'custom', path: ['max'], message: 'Range maximum must not be below its minimum' });
  });
}

function boundedFiniteRangeSchema(minimum: number, maximum: number) {
  return z.object({
    min: z.number().finite().min(minimum).max(maximum),
    max: z.number().finite().min(minimum).max(maximum),
    step: z.number().finite().positive().max(maximum - minimum).optional(),
  }).strict().superRefine((range, context) => {
    if (range.max < range.min) context.addIssue({ code: 'custom', path: ['max'], message: 'Range maximum must not be below its minimum' });
  });
}

const frequencyRangeSchema = boundedIntegerRangeSchema(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const positiveFrequencyRangeSchema = boundedIntegerRangeSchema(MAX_INSTRUMENT_FREQUENCY_HZ_V1, 1);
const sampleRateRangeSchema = boundedIntegerRangeSchema(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1, 1);
const sweptSpectrumPointRangeSchema = boundedIntegerRangeSchema(MAX_SWEPT_SPECTRUM_POINTS_V1, 2);
const detectedPowerSampleCountRangeSchema = boundedIntegerRangeSchema(MAX_DETECTED_POWER_SAMPLES_V1, 1);
const complexIqSampleCountRangeSchema = boundedIntegerRangeSchema(MAX_COMPLEX_IQ_SAMPLES_V1, 1);
const durationRangeSchema = boundedFiniteRangeSchema(Number.MIN_VALUE, MAX_INSTRUMENT_DURATION_SECONDS_V1)
  .refine((range) => range.min > 0, { path: ['min'], message: 'Range minimum must be positive' });
const scalarSweepTimeCapabilitySchema = z.object({
  automatic: z.boolean(),
  manualSeconds: durationRangeSchema,
}).strict();
const detectedPowerSweepTimeCapabilitySchema = z.object({
  // Detected-power v1 binds a requested total duration to returned cadence;
  // it has no configuration representation for an automatic duration.
  automatic: z.literal(false),
  manualSeconds: durationRangeSchema,
}).strict();
const powerRangeSchema = boundedFiniteRangeSchema(
  -MAX_INSTRUMENT_POWER_ABS_DB_V1,
  MAX_INSTRUMENT_POWER_ABS_DB_V1,
);

const receiverScalarSpectrumControlCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('receiver'),
  acquisitionFormats: boundedReadonlyArray(z.enum(['text', 'raw']), 2, 1),
  resolutionBandwidthKhz: z.object({
    automatic: z.boolean(),
    manual: boundedFiniteRangeSchema(Number.MIN_VALUE, MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1 / 1_000)
      .refine((range) => range.min > 0, { path: ['min'], message: 'RBW minimum must be positive' }),
  }).strict(),
  attenuationDb: z.object({
    automatic: z.boolean(),
    manual: boundedFiniteRangeSchema(0, MAX_INSTRUMENT_POWER_ABS_DB_V1),
  }).strict(),
  detectors: boundedReadonlyArray(z.enum([
    'sample', 'minimum-hold', 'maximum-hold', 'maximum-decay',
    'average-4', 'average-16', 'average', 'quasi-peak',
  ]), 8, 1),
  spurRejection: boundedReadonlyArray(z.enum(['off', 'on', 'auto']), 3, 1),
  lowNoiseAmplifier: boundedReadonlyArray(z.enum(['off', 'on']), 2, 1),
  avoidSpurs: boundedReadonlyArray(z.enum(['off', 'on', 'auto']), 3, 1),
  triggerModes: boundedReadonlyArray(z.enum(['auto', 'normal', 'single']), 3, 1),
  triggerLevelDbm: powerRangeSchema.optional(),
}).strict().superRefine((capability, context) => {
  for (const key of ['acquisitionFormats', 'detectors', 'spurRejection', 'lowNoiseAmplifier', 'avoidSpurs', 'triggerModes'] as const) {
    if (new Set(capability[key]).size !== capability[key].length) {
      context.addIssue({ code: 'custom', path: [key], message: `${key} capability values must be unique` });
    }
  }
  const hasLeveledTrigger = capability.triggerModes.some((mode) => mode !== 'auto');
  if (hasLeveledTrigger && capability.triggerLevelDbm === undefined) {
    context.addIssue({ code: 'custom', path: ['triggerLevelDbm'], message: 'Normal or single trigger modes require a trigger-level capability' });
  } else if (!hasLeveledTrigger && capability.triggerLevelDbm !== undefined) {
    context.addIssue({ code: 'custom', path: ['triggerLevelDbm'], message: 'An auto-only trigger capability must omit the unused trigger-level range' });
  }
});

const receiverDetectedPowerControlCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('receiver'),
  resolutionBandwidthKhz: z.object({
    automatic: z.boolean(),
    manual: boundedFiniteRangeSchema(Number.MIN_VALUE, MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1 / 1_000)
      .refine((range) => range.min > 0, { path: ['min'], message: 'RBW minimum must be positive' }),
  }).strict(),
  attenuationDb: z.object({
    automatic: z.boolean(),
    manual: boundedFiniteRangeSchema(0, MAX_INSTRUMENT_POWER_ABS_DB_V1),
  }).strict(),
  triggerModes: boundedReadonlyArray(z.enum(['auto', 'normal', 'single']), 3, 1),
  triggerLevelDbm: powerRangeSchema.optional(),
}).strict().superRefine((capability, context) => {
  if (new Set(capability.triggerModes).size !== capability.triggerModes.length) {
    context.addIssue({ code: 'custom', path: ['triggerModes'], message: 'Trigger-mode capability values must be unique' });
  }
  const hasLeveledTrigger = capability.triggerModes.some((mode) => mode !== 'auto');
  if (hasLeveledTrigger && capability.triggerLevelDbm === undefined) {
    context.addIssue({ code: 'custom', path: ['triggerLevelDbm'], message: 'Normal or single trigger modes require a trigger-level capability' });
  } else if (!hasLeveledTrigger && capability.triggerLevelDbm !== undefined) {
    context.addIssue({ code: 'custom', path: ['triggerLevelDbm'], message: 'An auto-only trigger capability must omit the unused trigger-level range' });
  }
});

const syntheticScalarControlCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('synthetic-scalar'),
  timingQualification: z.literal('simulation-exact'),
}).strict();

export const sweptSpectrumCapabilitySchema = z.object({
  kind: z.literal('swept-spectrum'),
  frequencyHz: frequencyRangeSchema,
  points: sweptSpectrumPointRangeSchema,
  sweepTimeSeconds: scalarSweepTimeCapabilitySchema,
  controls: z.discriminatedUnion('model', [
    receiverScalarSpectrumControlCapabilitySchema,
    syntheticScalarControlCapabilitySchema,
  ]),
  powerUnit: z.literal('dBm'),
}).strict().superRefine((capability, context) => {
  if (capability.frequencyHz.max <= capability.frequencyHz.min) {
    context.addIssue({ code: 'custom', path: ['frequencyHz', 'max'], message: 'Swept-spectrum frequency capability must contain at least two distinct frequencies' });
  } else if (capability.frequencyHz.step !== undefined
    && capability.frequencyHz.min + capability.frequencyHz.step > capability.frequencyHz.max) {
    context.addIssue({ code: 'custom', path: ['frequencyHz', 'step'], message: 'Swept-spectrum frequency step must admit a second frequency' });
  }
});
export const detectedPowerTimeseriesCapabilitySchema = z.object({
  kind: z.literal('detected-power-timeseries'),
  centerFrequencyHz: frequencyRangeSchema,
  sampleCount: detectedPowerSampleCountRangeSchema,
  sweepTimeSeconds: detectedPowerSweepTimeCapabilitySchema,
  controls: z.discriminatedUnion('model', [
    receiverDetectedPowerControlCapabilitySchema,
    syntheticScalarControlCapabilitySchema,
  ]),
  powerUnit: z.literal('dBm'),
  timing: z.literal('uniform'),
}).strict();
export const complexIqCapabilitySchema = z.object({
  kind: z.literal('complex-iq'),
  centerFrequencyHz: frequencyRangeSchema,
  sampleRateHz: sampleRateRangeSchema,
  bandwidthHz: sampleRateRangeSchema,
  sampleCount: complexIqSampleCountRangeSchema,
  sampleFormat: z.literal('cf32le'),
}).strict().superRefine((capability, context) => {
  if (capability.bandwidthHz.min > maximumReachableRangeValue(capability.sampleRateHz)) {
    context.addIssue({ code: 'custom', path: ['bandwidthHz', 'min'], message: 'Complex-I/Q capability must admit a bandwidth no greater than an advertised sample rate' });
  }
});
export const instrumentAcquisitionCapabilitySchema = z.discriminatedUnion('kind', [
  sweptSpectrumCapabilitySchema,
  detectedPowerTimeseriesCapabilitySchema,
  complexIqCapabilitySchema,
]);
export type InstrumentAcquisitionCapability = z.infer<typeof instrumentAcquisitionCapabilitySchema>;

const rfGeneratorPathCapabilitySchema = z.object({
  path: z.enum(['normal', 'mixer']),
  frequencyHz: positiveFrequencyRangeSchema,
}).strict();

export const rfGeneratorCapabilitySchema = z.object({
  kind: z.literal('rf-generator'),
  paths: boundedReadonlyArray(rfGeneratorPathCapabilitySchema, MAX_RF_GENERATOR_PATHS_V1, 1),
  levelDbm: powerRangeSchema,
  modulation: z.object({
    off: z.literal(true),
    am: z.object({
      modulationFrequencyHz: positiveFrequencyRangeSchema,
      depthPercent: boundedIntegerRangeSchema(100),
    }).strict().optional(),
    fm: z.object({
      modulationFrequencyHz: positiveFrequencyRangeSchema,
      deviationHz: sampleRateRangeSchema,
    }).strict().optional(),
  }).strict(),
}).strict().superRefine((capability, context) => {
  if (capability.paths.length > MAX_RF_GENERATOR_PATHS_V1) return;
  if (new Set(capability.paths.map((path) => path.path)).size !== capability.paths.length) {
    context.addIssue({ code: 'custom', path: ['paths'], message: 'RF generator paths must be unique' });
  }
});
const screenDimensionSchema = z.number().int().positive().max(MAX_SCREEN_DIMENSION_V1);
function screenFrameByteLength(width: number, height: number, bytesPerPixel: 2 | 4): number | undefined {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) return undefined;
  const bytes = pixels * bytesPerPixel;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}
export const screenCapabilitySchema = z.object({
  kind: z.literal('screen'),
  width: screenDimensionSchema,
  height: screenDimensionSchema,
  pixelFormat: z.enum(['rgb565le', 'rgba8888']),
}).strict().superRefine((capability, context) => {
  const bytes = screenFrameByteLength(capability.width, capability.height, capability.pixelFormat === 'rgb565le' ? 2 : 4);
  if (bytes === undefined || bytes > MAX_SCREEN_FRAME_BYTES_V1) {
    context.addIssue({ code: 'custom', path: ['width'], message: `Screen frames are limited to ${MAX_SCREEN_FRAME_BYTES_V1} bytes in contract v1` });
  }
});
export const touchCapabilitySchema = z.object({
  kind: z.literal('touch'),
  width: screenDimensionSchema,
  height: screenDimensionSchema,
}).strict();
export const diagnosticsCapabilitySchema = z.object({
  kind: z.literal('diagnostics'),
  reports: boundedReadonlyArray(z.enum(['identity', 'health', 'configuration']), MAX_DIAGNOSTIC_REPORTS_V1, 1),
}).strict().superRefine((capability, context) => {
  if (capability.reports.length > MAX_DIAGNOSTIC_REPORTS_V1) return;
  if (new Set(capability.reports).size !== capability.reports.length) {
    context.addIssue({ code: 'custom', path: ['reports'], message: 'Diagnostic report kinds must be unique' });
  }
});
export const signalLabProfileSelectionCapabilitySchema = z.object({
  kind: z.literal('signal-lab-profile-selection'),
  profiles: boundedReadonlyArray(z.object({
    profileId: instrumentOpaqueIdSchema,
    centerFrequencyHz: frequencyHzSchema,
    recommendedSpanHz: positiveFrequencyHzSchema,
  }).strict(), MAX_SIGNAL_LAB_PROFILES_V1, 1),
  selectedProfileId: instrumentOpaqueIdSchema,
}).strict().superRefine((capability, context) => {
  if (capability.profiles.length > MAX_SIGNAL_LAB_PROFILES_V1) return;
  if (new Set(capability.profiles.map((profile) => profile.profileId)).size !== capability.profiles.length) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'SignalLab profile IDs must be unique' });
  }
  if (!capability.profiles.some((profile) => profile.profileId === capability.selectedProfileId)) {
    context.addIssue({ code: 'custom', path: ['selectedProfileId'], message: 'Selected SignalLab profile must be advertised' });
  }
});
export const instrumentFeatureCapabilitySchema = z.discriminatedUnion('kind', [
  rfGeneratorCapabilitySchema,
  screenCapabilitySchema,
  touchCapabilitySchema,
  diagnosticsCapabilitySchema,
  signalLabProfileSelectionCapabilitySchema,
]);
export type InstrumentFeatureCapability = z.infer<typeof instrumentFeatureCapabilitySchema>;

export const instrumentCapabilitiesSchema = z.object({
  schemaVersion: z.literal(INSTRUMENT_CONTRACT_VERSION),
  acquisitions: boundedReadonlyArray(instrumentAcquisitionCapabilitySchema, MAX_ACQUISITION_CAPABILITIES_V1, 1),
  features: boundedReadonlyArray(instrumentFeatureCapabilitySchema, MAX_FEATURE_CAPABILITIES_V1),
}).strict().superRefine((capabilities, context) => {
  if (capabilities.acquisitions.length > MAX_ACQUISITION_CAPABILITIES_V1
    || capabilities.features.length > MAX_FEATURE_CAPABILITIES_V1) return;
  if (new Set(capabilities.acquisitions.map((capability) => capability.kind)).size !== capabilities.acquisitions.length) {
    context.addIssue({ code: 'custom', path: ['acquisitions'], message: 'Acquisition capability kinds must be unique' });
  }
  if (new Set(capabilities.features.map((capability) => capability.kind)).size !== capabilities.features.length) {
    context.addIssue({ code: 'custom', path: ['features'], message: 'Feature capability kinds must be unique' });
  }
});
export type InstrumentCapabilities = z.infer<typeof instrumentCapabilitiesSchema>;

export interface InstrumentCapabilitySourceBindingIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Source identity closes the otherwise generic capability union. Keep this
 * independent of manager code because snapshots cross the public IPC schema. */
export function instrumentCapabilitySourceBindingIssues(
  sourceKind: InstrumentSourceKind,
  capabilities: InstrumentCapabilities,
): readonly InstrumentCapabilitySourceBindingIssue[] {
  const issues: InstrumentCapabilitySourceBindingIssue[] = [];
  const scalar = capabilities.acquisitions.filter((capability) => capability.kind !== 'complex-iq');
  if (sourceKind === 'signal-lab') {
    const spectrum = capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
    const detected = capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
    if (capabilities.acquisitions.length !== 2 || !spectrum || !detected) {
      issues.push({ path: ['acquisitions'], message: 'SignalLab must advertise exactly swept-spectrum and detected-power acquisitions' });
    }
    if (capabilities.acquisitions.some((capability) => capability.kind === 'complex-iq')
      || scalar.some((capability) => capability.controls.model !== 'synthetic-scalar')) {
      issues.push({ path: ['acquisitions'], message: 'SignalLab acquisitions must use only synthetic scalar controls' });
    }
    for (const [index, capability] of capabilities.acquisitions.entries()) {
      if (capability.kind === 'complex-iq') continue;
      if (capability.sweepTimeSeconds.automatic
        || capability.sweepTimeSeconds.manualSeconds.min !== SIGNAL_LAB_EXACT_SWEEP_SECONDS_V1
        || capability.sweepTimeSeconds.manualSeconds.max !== SIGNAL_LAB_EXACT_SWEEP_SECONDS_V1) {
        issues.push({
          path: ['acquisitions', index, 'sweepTimeSeconds'],
          message: `SignalLab scalar acquisitions must advertise exact non-automatic ${SIGNAL_LAB_EXACT_SWEEP_SECONDS_V1}s timing`,
        });
      }
    }
    const profileFeature = capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    if (capabilities.features.length !== 1 || !profileFeature) {
      issues.push({ path: ['features'], message: 'SignalLab must advertise exactly one profile-selection feature' });
    } else if (spectrum && detected) {
      for (const [profileIndex, profile] of profileFeature.profiles.entries()) {
        if (!numericRangePermits(profile.centerFrequencyHz, spectrum.frequencyHz)) {
          issues.push({ path: ['features', 0, 'profiles', profileIndex, 'centerFrequencyHz'], message: 'SignalLab profile center must lie on the swept-spectrum frequency grid' });
        }
        if (!numericRangePermits(profile.centerFrequencyHz, detected.centerFrequencyHz)) {
          issues.push({ path: ['features', 0, 'profiles', profileIndex, 'centerFrequencyHz'], message: 'SignalLab profile center must lie on the detected-power frequency grid' });
        }
      }
    }
    return issues;
  }
  if (scalar.some((capability) => capability.controls.model !== 'receiver')) {
    issues.push({ path: ['acquisitions'], message: `${sourceKind} scalar acquisitions must expose receiver controls` });
  }
  if (capabilities.features.some((feature) => feature.kind === 'signal-lab-profile-selection')) {
    issues.push({ path: ['features'], message: `${sourceKind} cannot advertise SignalLab profile selection` });
  }
  return issues;
}

function numericRangePermits(value: number, range: { min: number; max: number; step?: number }): boolean {
  if (value < range.min || value > range.max) return false;
  if (range.step === undefined) return true;
  const steps = (value - range.min) / range.step;
  return Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(1, Math.abs(steps));
}

/** Range maxima are inclusive ceilings; when a step is present the largest
 * constructible value is the final lattice point at or below that ceiling. */
function maximumReachableRangeValue(range: { min: number; max: number; step?: number }): number {
  if (range.step === undefined) return range.max;
  return range.min + Math.floor((range.max - range.min) / range.step) * range.step;
}

export const instrumentMeasurementQualificationSchema = z.enum([
  'device-observed',
  'firmware-executed-twin',
  'synthetic-visual-projection',
]);
export type InstrumentMeasurementQualification = z.infer<typeof instrumentMeasurementQualificationSchema>;

const sessionSerialPortSchema = z.object({
  path: endpointPathSchema,
  manufacturer: metadataStringSchema.optional(),
  product: metadataStringSchema.optional(),
  serialNumber: metadataStringSchema.optional(),
  vendorId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
  productId: z.string().regex(/^[a-f0-9]{4}$/i).optional(),
}).strict();

const serialSessionDeviceBaseShape = {
  model: metadataStringSchema,
  hardwareVersion: metadataStringSchema,
  firmwareVersion: metadataStringSchema,
  usbIdentityVerified: z.literal(true),
} as const;

const supportedOemSerialSessionDeviceSchema = z.object({
  ...serialSessionDeviceBaseShape,
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/i),
  firmwareSourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
  firmwareQualification: z.literal('supported-oem'),
  firmwareWarning: z.never().optional(),
}).strict().superRefine((device, context) => {
  if (!isZs407FirmwareVersionRevisionPair(device.firmwareVersion, device.firmwareReportedRevision)) {
    context.addIssue({
      code: 'custom',
      path: ['firmwareReportedRevision'],
      message: 'Supported OEM reported revision must equal the single revision token in the firmware version',
    });
  }
  if (!isSupportedZs407FirmwareIdentity(device.firmwareVersion, device.firmwareReportedRevision, device.firmwareSourceCommit)) {
    context.addIssue({
      code: 'custom',
      path: ['firmwareSourceCommit'],
      message: 'Supported OEM firmware revision and source commit must match the closed qualification registry',
    });
  }
});

const customSerialSessionDeviceSchema = z.object({
  ...serialSessionDeviceBaseShape,
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/i),
  firmwareSourceCommit: z.never().optional(),
  firmwareQualification: z.literal('custom-unqualified'),
  firmwareWarning: metadataStringSchema,
}).strict().superRefine((device, context) => {
  if (!isZs407FirmwareVersionRevisionPair(device.firmwareVersion, device.firmwareReportedRevision)) {
    context.addIssue({
      code: 'custom',
      path: ['firmwareReportedRevision'],
      message: 'Custom reported revision must equal the single revision token in the firmware version',
    });
  }
  if (!device.firmwareWarning.toLowerCase().includes(device.firmwareReportedRevision.toLowerCase())) {
    context.addIssue({
      code: 'custom',
      path: ['firmwareWarning'],
      message: 'Custom firmware warning must identify the unresolved reported revision',
    });
  }
});

const serialSessionDeviceSchema = z.union([
  supportedOemSerialSessionDeviceSchema,
  customSerialSessionDeviceSchema,
]);

export const serialInstrumentSessionProvenanceSchema = z.object({
  sourceKind: z.literal('serial-port'),
  execution: z.literal('physical'),
  transport: z.literal('usb-cdc-acm'),
  qualification: z.literal('device-observed'),
  verifiedAt: instrumentTimestampSchema,
  serialPort: sessionSerialPortSchema,
  device: serialSessionDeviceSchema,
}).strict();

export const tinySaFirmwareTwinSessionProvenanceSchema = z.object({
  sourceKind: z.literal('tinysa-firmware-twin'),
  execution: z.literal('firmware-executed-twin'),
  transport: z.literal('renode-monitor-bridge'),
  qualification: z.literal('firmware-executed-twin'),
  verifiedAt: instrumentTimestampSchema,
  bridge: z.literal('renode-monitor-v1'),
  repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/),
  firmwareBinarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  usbTransactionsModeled: z.literal(false),
  device: z.object({
    model: metadataStringSchema,
    hardwareVersion: metadataStringSchema,
    firmwareVersion: metadataStringSchema,
  }).strict(),
}).strict();

export const signalLabInstrumentSessionProvenanceSchema = z.object({
  sourceKind: z.literal('signal-lab'),
  sourceId: instrumentOpaqueIdSchema,
  execution: z.literal('signal-lab-simulation'),
  transport: z.literal('signal-lab-measurement-bridge'),
  qualification: z.literal('synthetic-visual-projection'),
  verifiedAt: instrumentTimestampSchema,
  producerConfigurationEpoch: instrumentOpaqueIdSchema,
  contractId: z.literal('tinysa-signal-lab-atomizer-measurement'),
  contractVersion: z.literal(1),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generatorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  claims: z.object({
    usbEmulated: z.literal(false),
    firmwareExecuted: z.literal(false),
    rfEmitted: z.literal(false),
  }).strict(),
}).strict();

export const instrumentSessionProvenanceSchema = z.discriminatedUnion('sourceKind', [
  serialInstrumentSessionProvenanceSchema,
  tinySaFirmwareTwinSessionProvenanceSchema,
  signalLabInstrumentSessionProvenanceSchema,
]);
export type InstrumentSessionProvenance = z.infer<typeof instrumentSessionProvenanceSchema>;

export const rfGeneratorConfigureFeatureRequestSchema = z.object({
  kind: z.literal('rf-generator'),
  action: z.literal('configure'),
  frequencyHz: frequencyHzSchema,
  levelDbm: boundedPowerSchema,
  path: z.enum(['normal', 'mixer']),
  modulation: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('off') }).strict(),
    z.object({
      mode: z.literal('am'),
      modulationFrequencyHz: positiveFrequencyHzSchema,
      depthPercent: z.number().int().min(0).max(100),
    }).strict(),
    z.object({
      mode: z.literal('fm'),
      modulationFrequencyHz: positiveFrequencyHzSchema,
      deviationHz: sampleRateHzSchema,
    }).strict(),
  ]),
}).strict();
export const rfGeneratorOutputFeatureRequestSchema = z.object({
  kind: z.literal('rf-generator'),
  action: z.literal('set-output'),
  enabled: z.boolean(),
}).strict();
export const screenCaptureFeatureRequestSchema = z.object({
  kind: z.literal('screen'),
  action: z.literal('capture'),
}).strict();
export const touchTapFeatureRequestSchema = z.object({
  kind: z.literal('touch'),
  action: z.literal('tap'),
  x: z.number().int().nonnegative().max(MAX_SCREEN_DIMENSION_V1 - 1),
  y: z.number().int().nonnegative().max(MAX_SCREEN_DIMENSION_V1 - 1),
}).strict();
export const diagnosticsReadFeatureRequestSchema = z.object({
  kind: z.literal('diagnostics'),
  action: z.literal('read'),
  report: z.enum(['identity', 'health', 'configuration']),
}).strict();
export const signalLabSelectProfileFeatureRequestSchema = z.object({
  kind: z.literal('signal-lab-profile-selection'),
  action: z.literal('select-profile'),
  profileId: instrumentOpaqueIdSchema,
}).strict();
export const instrumentFeatureRequestSchema = z.union([
  rfGeneratorConfigureFeatureRequestSchema,
  rfGeneratorOutputFeatureRequestSchema,
  screenCaptureFeatureRequestSchema,
  touchTapFeatureRequestSchema,
  diagnosticsReadFeatureRequestSchema,
  signalLabSelectProfileFeatureRequestSchema,
]);
export type InstrumentFeatureRequest = z.infer<typeof instrumentFeatureRequestSchema>;

const featureCommandSessionShape = { sessionId: instrumentOpaqueIdSchema } as const;
export const rfGeneratorConfigureFeatureCommandSchema = rfGeneratorConfigureFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const rfGeneratorOutputFeatureCommandSchema = rfGeneratorOutputFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const screenCaptureFeatureCommandSchema = screenCaptureFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const touchTapFeatureCommandSchema = touchTapFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const diagnosticsReadFeatureCommandSchema = diagnosticsReadFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const signalLabSelectProfileFeatureCommandSchema = signalLabSelectProfileFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const instrumentFeatureCommandSchema = z.union([
  rfGeneratorConfigureFeatureCommandSchema,
  rfGeneratorOutputFeatureCommandSchema,
  screenCaptureFeatureCommandSchema,
  touchTapFeatureCommandSchema,
  diagnosticsReadFeatureCommandSchema,
  signalLabSelectProfileFeatureCommandSchema,
]);
export type InstrumentFeatureCommand = z.infer<typeof instrumentFeatureCommandSchema>;

const featureResultSessionShape = { sessionId: instrumentOpaqueIdSchema } as const;
export const rfGeneratorConfigureFeatureResultSchema = rfGeneratorConfigureFeatureRequestSchema.extend(featureResultSessionShape).strict();
export const rfGeneratorOutputFeatureResultSchema = rfGeneratorOutputFeatureRequestSchema.extend(featureResultSessionShape).strict();
const rgb565ScreenFrameSchema = z.object({
  width: screenDimensionSchema,
  height: screenDimensionSchema,
  pixelFormat: z.literal('rgb565le'),
  pixels: compactUint8ArraySchema(MAX_SCREEN_FRAME_BYTES_V1),
  capturedAt: instrumentTimestampSchema,
}).strict().superRefine((frame, context) => {
  const expectedBytes = screenFrameByteLength(frame.width, frame.height, 2);
  if (expectedBytes === undefined || expectedBytes > MAX_SCREEN_FRAME_BYTES_V1 || frame.pixels.byteLength !== expectedBytes) {
    context.addIssue({ code: 'custom', path: ['pixels'], message: 'rgb565le requires exactly two bytes per pixel' });
  }
});
const rgbaScreenFrameSchema = z.object({
  width: screenDimensionSchema,
  height: screenDimensionSchema,
  pixelFormat: z.literal('rgba8888'),
  pixels: compactUint8ArraySchema(MAX_SCREEN_FRAME_BYTES_V1),
  capturedAt: instrumentTimestampSchema,
}).strict().superRefine((frame, context) => {
  const expectedBytes = screenFrameByteLength(frame.width, frame.height, 4);
  if (expectedBytes === undefined || expectedBytes > MAX_SCREEN_FRAME_BYTES_V1 || frame.pixels.byteLength !== expectedBytes) {
    context.addIssue({ code: 'custom', path: ['pixels'], message: 'rgba8888 requires exactly four bytes per pixel' });
  }
});
export const instrumentScreenFrameSchema = z.discriminatedUnion('pixelFormat', [
  rgb565ScreenFrameSchema,
  rgbaScreenFrameSchema,
]);
export type InstrumentScreenFrame = z.infer<typeof instrumentScreenFrameSchema>;
export const screenCaptureFeatureResultSchema = z.object({
  ...featureResultSessionShape,
  kind: z.literal('screen'),
  action: z.literal('capture'),
  frame: instrumentScreenFrameSchema,
}).strict();
export const touchTapFeatureResultSchema = touchTapFeatureRequestSchema.extend({
  ...featureResultSessionShape,
  accepted: z.literal(true),
}).strict();
export const diagnosticsReadFeatureResultSchema = diagnosticsReadFeatureRequestSchema.extend({
  ...featureResultSessionShape,
  lines: boundedReadonlyArray(
    z.string().min(1).max(MAX_DIAGNOSTIC_LINE_CHARACTERS_V1),
    MAX_DIAGNOSTIC_LINES_V1,
    1,
  ),
}).strict();
export const signalLabSelectProfileFeatureResultSchema = signalLabSelectProfileFeatureRequestSchema.extend({
  ...featureResultSessionShape,
  producerConfigurationEpoch: instrumentOpaqueIdSchema,
}).strict();
export const instrumentFeatureResultSchema = z.union([
  rfGeneratorConfigureFeatureResultSchema,
  rfGeneratorOutputFeatureResultSchema,
  screenCaptureFeatureResultSchema,
  touchTapFeatureResultSchema,
  diagnosticsReadFeatureResultSchema,
  signalLabSelectProfileFeatureResultSchema,
]);
export type InstrumentFeatureResult = z.infer<typeof instrumentFeatureResultSchema>;

const scalarTriggerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({
    mode: z.enum(['normal', 'single']),
    levelDbm: boundedPowerSchema,
  }).strict(),
]);
const receiverScalarSpectrumControlsSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('receiver'),
  acquisitionFormat: z.enum(['text', 'raw']),
  resolutionBandwidthKhz: z.union([
    z.literal('auto'),
    z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1 / 1_000),
  ]),
  attenuationDb: z.union([
    z.literal('auto'),
    z.number().finite().nonnegative().max(MAX_INSTRUMENT_POWER_ABS_DB_V1),
  ]),
  detector: z.enum([
    'sample', 'minimum-hold', 'maximum-hold', 'maximum-decay',
    'average-4', 'average-16', 'average', 'quasi-peak',
  ]),
  spurRejection: z.enum(['off', 'on', 'auto']),
  lowNoiseAmplifier: z.enum(['off', 'on']),
  avoidSpurs: z.enum(['off', 'on', 'auto']),
  trigger: scalarTriggerSchema,
}).strict();
const receiverDetectedPowerControlsSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('receiver'),
  resolutionBandwidthKhz: z.union([
    z.literal('auto'),
    z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1 / 1_000),
  ]),
  attenuationDb: z.union([
    z.literal('auto'),
    z.number().finite().nonnegative().max(MAX_INSTRUMENT_POWER_ABS_DB_V1),
  ]),
  trigger: scalarTriggerSchema,
}).strict();
const syntheticScalarControlsSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('synthetic-scalar'),
  timingQualification: z.literal('simulation-exact'),
}).strict();

export const sweptSpectrumConfigurationSchema = z.object({
  kind: z.literal('swept-spectrum'),
  startHz: frequencyHzSchema,
  stopHz: positiveFrequencyHzSchema,
  points: z.number().int().min(2).max(MAX_SWEPT_SPECTRUM_POINTS_V1),
  sweepTimeSeconds: z.union([
    z.literal('auto'),
    z.number().finite().positive().max(MAX_INSTRUMENT_DURATION_SECONDS_V1),
  ]),
  controls: z.discriminatedUnion('model', [
    receiverScalarSpectrumControlsSchema,
    syntheticScalarControlsSchema,
  ]),
}).strict().superRefine((configuration, context) => {
  if (configuration.stopHz <= configuration.startHz) {
    context.addIssue({ code: 'custom', path: ['stopHz'], message: 'Sweep stop must exceed sweep start' });
  }
  if (configuration.controls.model === 'synthetic-scalar' && configuration.sweepTimeSeconds === 'auto') {
    context.addIssue({ code: 'custom', path: ['sweepTimeSeconds'], message: 'Synthetic scalar sweeps require an exact simulated sweep time' });
  }
});
export type SweptSpectrumConfiguration = z.infer<typeof sweptSpectrumConfigurationSchema>;
export const detectedPowerTimeseriesConfigurationSchema = z.object({
  kind: z.literal('detected-power-timeseries'),
  centerHz: frequencyHzSchema,
  sampleCount: z.number().int().positive().max(MAX_DETECTED_POWER_SAMPLES_V1),
  sweepTimeSeconds: z.number().finite().positive().max(MAX_INSTRUMENT_DURATION_SECONDS_V1),
  controls: z.discriminatedUnion('model', [
    receiverDetectedPowerControlsSchema,
    syntheticScalarControlsSchema,
  ]),
}).strict();
export type DetectedPowerTimeseriesConfiguration = z.infer<typeof detectedPowerTimeseriesConfigurationSchema>;
export const complexIqConfigurationSchema = z.object({
  kind: z.literal('complex-iq'),
  centerHz: frequencyHzSchema,
  sampleRateHz: sampleRateHzSchema,
  bandwidthHz: sampleRateHzSchema,
  sampleCount: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1),
  sampleFormat: z.literal('cf32le'),
}).strict().superRefine((configuration, context) => {
  if (configuration.bandwidthHz > configuration.sampleRateHz) {
    context.addIssue({ code: 'custom', path: ['bandwidthHz'], message: 'Complex-I/Q bandwidth cannot exceed its sample rate' });
  }
});
export const instrumentConfigurationSchema = z.discriminatedUnion('kind', [
  sweptSpectrumConfigurationSchema,
  detectedPowerTimeseriesConfigurationSchema,
  complexIqConfigurationSchema,
]);
export type InstrumentConfiguration = z.infer<typeof instrumentConfigurationSchema>;

export const instrumentConfigurationCommandSchema = z.object({
  sessionId: instrumentOpaqueIdSchema,
  configurationRevision: instrumentOpaqueIdSchema,
  configuration: instrumentConfigurationSchema,
}).strict();
export type InstrumentConfigurationCommand = z.infer<typeof instrumentConfigurationCommandSchema>;

export const instrumentConfigurationStateSchema = instrumentConfigurationCommandSchema.extend({
  configuredAt: instrumentTimestampSchema,
}).strict();
export type InstrumentConfigurationState = z.infer<typeof instrumentConfigurationStateSchema>;

export interface InstrumentConfigurationCapabilityBindingIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Relational validation for authoritative configuration state. The standalone
 * configuration schema proves only that a request is well formed; a public
 * session snapshot must also prove that the active capability set admits every
 * requested value and control.
 */
export function instrumentConfigurationCapabilityBindingIssues(
  configuration: InstrumentConfiguration,
  capabilities: InstrumentCapabilities,
): readonly InstrumentConfigurationCapabilityBindingIssue[] {
  const issues: InstrumentConfigurationCapabilityBindingIssue[] = [];
  const capability = capabilities.acquisitions.find((candidate) => candidate.kind === configuration.kind);
  if (!capability) {
    return [{ path: ['kind'], message: `Configuration kind ${configuration.kind} is not advertised by the session` }];
  }

  if (configuration.kind === 'swept-spectrum' && capability.kind === 'swept-spectrum') {
    appendRangeBindingIssue(issues, ['startHz'], configuration.startHz, capability.frequencyHz, 'Sweep start');
    appendRangeBindingIssue(issues, ['stopHz'], configuration.stopHz, capability.frequencyHz, 'Sweep stop');
    appendRangeBindingIssue(issues, ['points'], configuration.points, capability.points, 'Sweep points');
    appendAutomaticOrRangeBindingIssue(
      issues,
      ['sweepTimeSeconds'],
      configuration.sweepTimeSeconds,
      capability.sweepTimeSeconds,
      'Sweep time',
    );
    if (configuration.controls.model !== capability.controls.model) {
      issues.push({ path: ['controls', 'model'], message: `Sweep control model ${configuration.controls.model} is not advertised` });
    } else if (configuration.controls.model === 'receiver' && capability.controls.model === 'receiver') {
      if (!capability.controls.acquisitionFormats.includes(configuration.controls.acquisitionFormat)) {
        issues.push({ path: ['controls', 'acquisitionFormat'], message: `Acquisition format ${configuration.controls.acquisitionFormat} is not advertised` });
      }
      appendAutomaticOrManualRangeBindingIssue(
        issues,
        ['controls', 'resolutionBandwidthKhz'],
        configuration.controls.resolutionBandwidthKhz,
        capability.controls.resolutionBandwidthKhz,
        'Resolution bandwidth',
      );
      appendAutomaticOrManualRangeBindingIssue(
        issues,
        ['controls', 'attenuationDb'],
        configuration.controls.attenuationDb,
        capability.controls.attenuationDb,
        'Attenuation',
      );
      if (!capability.controls.detectors.includes(configuration.controls.detector)) {
        issues.push({ path: ['controls', 'detector'], message: `Detector ${configuration.controls.detector} is not advertised` });
      }
      if (!capability.controls.spurRejection.includes(configuration.controls.spurRejection)) {
        issues.push({ path: ['controls', 'spurRejection'], message: `Spur-rejection mode ${configuration.controls.spurRejection} is not advertised` });
      }
      if (!capability.controls.lowNoiseAmplifier.includes(configuration.controls.lowNoiseAmplifier)) {
        issues.push({ path: ['controls', 'lowNoiseAmplifier'], message: `LNA mode ${configuration.controls.lowNoiseAmplifier} is not advertised` });
      }
      if (!capability.controls.avoidSpurs.includes(configuration.controls.avoidSpurs)) {
        issues.push({ path: ['controls', 'avoidSpurs'], message: `Avoid-spurs mode ${configuration.controls.avoidSpurs} is not advertised` });
      }
      appendTriggerBindingIssues(issues, configuration.controls.trigger, capability.controls);
    }
  } else if (configuration.kind === 'detected-power-timeseries' && capability.kind === 'detected-power-timeseries') {
    appendRangeBindingIssue(issues, ['centerHz'], configuration.centerHz, capability.centerFrequencyHz, 'Detected-power center');
    appendRangeBindingIssue(issues, ['sampleCount'], configuration.sampleCount, capability.sampleCount, 'Detected-power sample count');
    appendRangeBindingIssue(issues, ['sweepTimeSeconds'], configuration.sweepTimeSeconds, capability.sweepTimeSeconds.manualSeconds, 'Detected-power sweep time');
    if (configuration.controls.model !== capability.controls.model) {
      issues.push({ path: ['controls', 'model'], message: `Detected-power control model ${configuration.controls.model} is not advertised` });
    } else if (configuration.controls.model === 'receiver' && capability.controls.model === 'receiver') {
      appendAutomaticOrManualRangeBindingIssue(
        issues,
        ['controls', 'resolutionBandwidthKhz'],
        configuration.controls.resolutionBandwidthKhz,
        capability.controls.resolutionBandwidthKhz,
        'Resolution bandwidth',
      );
      appendAutomaticOrManualRangeBindingIssue(
        issues,
        ['controls', 'attenuationDb'],
        configuration.controls.attenuationDb,
        capability.controls.attenuationDb,
        'Attenuation',
      );
      appendTriggerBindingIssues(issues, configuration.controls.trigger, capability.controls);
    }
  } else if (configuration.kind === 'complex-iq' && capability.kind === 'complex-iq') {
    appendRangeBindingIssue(issues, ['centerHz'], configuration.centerHz, capability.centerFrequencyHz, 'I/Q center');
    appendRangeBindingIssue(issues, ['sampleRateHz'], configuration.sampleRateHz, capability.sampleRateHz, 'I/Q sample rate');
    appendRangeBindingIssue(issues, ['bandwidthHz'], configuration.bandwidthHz, capability.bandwidthHz, 'I/Q bandwidth');
    appendRangeBindingIssue(issues, ['sampleCount'], configuration.sampleCount, capability.sampleCount, 'I/Q sample count');
    if (configuration.sampleFormat !== capability.sampleFormat) {
      issues.push({ path: ['sampleFormat'], message: `I/Q sample format ${configuration.sampleFormat} is not advertised` });
    }
  }
  return issues;
}

type NumericCapabilityRange = Readonly<{ min: number; max: number; step?: number }>;

function appendRangeBindingIssue(
  issues: InstrumentConfigurationCapabilityBindingIssue[],
  path: readonly (string | number)[],
  value: number,
  range: NumericCapabilityRange,
  label: string,
): void {
  if (!capabilityRangeAdmits(value, range)) {
    issues.push({ path, message: `${label} ${value} is outside the advertised capability` });
  }
}

function appendAutomaticOrRangeBindingIssue(
  issues: InstrumentConfigurationCapabilityBindingIssue[],
  path: readonly (string | number)[],
  value: 'auto' | number,
  capability: Readonly<{ automatic: boolean; manualSeconds: NumericCapabilityRange }>,
  label: string,
): void {
  if (value === 'auto') {
    if (!capability.automatic) issues.push({ path, message: `${label} does not advertise automatic selection` });
  } else {
    appendRangeBindingIssue(issues, path, value, capability.manualSeconds, label);
  }
}

function appendAutomaticOrManualRangeBindingIssue(
  issues: InstrumentConfigurationCapabilityBindingIssue[],
  path: readonly (string | number)[],
  value: 'auto' | number,
  capability: Readonly<{ automatic: boolean; manual: NumericCapabilityRange }>,
  label: string,
): void {
  if (value === 'auto') {
    if (!capability.automatic) issues.push({ path, message: `${label} does not advertise automatic selection` });
  } else {
    appendRangeBindingIssue(issues, path, value, capability.manual, label);
  }
}

function appendTriggerBindingIssues(
  issues: InstrumentConfigurationCapabilityBindingIssue[],
  trigger: z.infer<typeof scalarTriggerSchema>,
  capability: Readonly<{
    triggerModes: readonly ('auto' | 'normal' | 'single')[];
    triggerLevelDbm?: NumericCapabilityRange;
  }>,
): void {
  if (!capability.triggerModes.includes(trigger.mode)) {
    issues.push({ path: ['controls', 'trigger', 'mode'], message: `Trigger mode ${trigger.mode} is not advertised` });
    return;
  }
  if (trigger.mode !== 'auto') {
    if (!capability.triggerLevelDbm) {
      issues.push({ path: ['controls', 'trigger', 'levelDbm'], message: `Trigger mode ${trigger.mode} has no advertised level range` });
    } else {
      appendRangeBindingIssue(issues, ['controls', 'trigger', 'levelDbm'], trigger.levelDbm, capability.triggerLevelDbm, 'Trigger level');
    }
  }
}

function capabilityRangeAdmits(value: number, range: NumericCapabilityRange): boolean {
  if (value < range.min || value > range.max) return false;
  if (range.step === undefined) return true;
  const stepOffset = (value - range.min) / range.step;
  return Math.abs(stepOffset - Math.round(stepOffset))
    <= Number.EPSILON * Math.max(8, Math.abs(stepOffset) * 8);
}

const measurementBaseShape = {
  schemaVersion: z.literal(INSTRUMENT_CONTRACT_VERSION),
  measurementId: instrumentOpaqueIdSchema,
  sessionId: instrumentOpaqueIdSchema,
  configurationRevision: instrumentOpaqueIdSchema,
  producerConfigurationEpoch: instrumentOpaqueIdSchema.optional(),
  sequence: z.number().int().positive().max(MAX_INSTRUMENT_SEQUENCE_V1),
  capturedAt: instrumentTimestampSchema,
  elapsedMilliseconds: z.number().finite().nonnegative().max(MAX_INSTRUMENT_ELAPSED_MILLISECONDS_V1),
  resolutionBandwidthHz: z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1).nullable(),
  attenuationDb: boundedPowerSchema.nullable(),
  qualification: instrumentMeasurementQualificationSchema,
  complete: z.literal(true),
} as const;

export const sweptSpectrumMeasurementSchema = z.object({
  ...measurementBaseShape,
  kind: z.literal('swept-spectrum'),
  frequencyHz: boundedReadonlyArray(measuredFrequencyHzSchema, MAX_SWEPT_SPECTRUM_POINTS_V1, 2),
  powerDbm: boundedReadonlyArray(boundedPowerSchema, MAX_SWEPT_SPECTRUM_POINTS_V1, 2),
}).strict().superRefine((measurement, context) => {
  if (measurement.frequencyHz.length > MAX_SWEPT_SPECTRUM_POINTS_V1
    || measurement.powerDbm.length > MAX_SWEPT_SPECTRUM_POINTS_V1) return;
  if (measurement.frequencyHz.length !== measurement.powerDbm.length) {
    context.addIssue({ code: 'custom', path: ['powerDbm'], message: 'Spectrum frequency and power arrays must have equal length' });
  }
  for (let index = 1; index < measurement.frequencyHz.length; index++) {
    if (measurement.frequencyHz[index]! <= measurement.frequencyHz[index - 1]!) {
      context.addIssue({ code: 'custom', path: ['frequencyHz', index], message: 'Spectrum frequencies must increase strictly' });
      break;
    }
  }
});
export const detectedPowerTimeseriesMeasurementSchema = z.object({
  ...measurementBaseShape,
  kind: z.literal('detected-power-timeseries'),
  centerHz: frequencyHzSchema,
  sampleIntervalSeconds: z.number().finite().positive().max(MAX_INSTRUMENT_DURATION_SECONDS_V1),
  timingQualification: z.enum(['wall-clock-derived', 'measured-calibrated', 'simulation-exact']),
  powerDbm: boundedReadonlyArray(boundedPowerSchema, MAX_DETECTED_POWER_SAMPLES_V1, 1),
}).strict();
export const complexIqMeasurementSchema = z.object({
  ...measurementBaseShape,
  kind: z.literal('complex-iq'),
  centerHz: frequencyHzSchema,
  sampleRateHz: sampleRateHzSchema,
  bandwidthHz: sampleRateHzSchema,
  sampleFormat: z.literal('cf32le'),
  sampleCount: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1),
  samples: compactUint8ArraySchema(MAX_COMPLEX_IQ_BYTES_V1),
}).strict().superRefine((measurement, context) => {
  if (measurement.bandwidthHz > measurement.sampleRateHz) {
    context.addIssue({ code: 'custom', path: ['bandwidthHz'], message: 'Complex-I/Q bandwidth cannot exceed its sample rate' });
  }
  if (measurement.samples.byteLength !== measurement.sampleCount * 8) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'cf32le requires exactly eight bytes per complex sample' });
  }
});
export const instrumentMeasurementSchema = z.discriminatedUnion('kind', [
  sweptSpectrumMeasurementSchema,
  detectedPowerTimeseriesMeasurementSchema,
  complexIqMeasurementSchema,
]);
export type InstrumentMeasurement = z.infer<typeof instrumentMeasurementSchema>;

export const instrumentDiscoveryFailureSchema = z.object({
  driverId: instrumentDriverIdSchema,
  sourceKind: instrumentSourceKindSchema.optional(),
  code: z.enum(['source-unavailable', 'driver-failure']),
  recoverable: z.boolean(),
  message: z.string().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
}).strict();
export type InstrumentDiscoveryFailure = z.infer<typeof instrumentDiscoveryFailureSchema>;
export const instrumentDiscoveryResultSchema = z.object({
  discoveryRevision: instrumentOpaqueIdSchema,
  discoveredAt: instrumentTimestampSchema,
  candidates: boundedReadonlyArray(instrumentCandidateSchema, MAX_DISCOVERY_CANDIDATES_V1),
  failures: boundedReadonlyArray(instrumentDiscoveryFailureSchema, MAX_DISCOVERY_FAILURES_V1),
}).strict();
export type InstrumentDiscoveryResult = z.infer<typeof instrumentDiscoveryResultSchema>;

export const instrumentErrorSchema = z.object({
  code: z.enum(['driver-contract', 'driver-failure', 'session-fault']),
  message: z.string().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
  recoverable: z.boolean(),
}).strict();
export type InstrumentError = z.infer<typeof instrumentErrorSchema>;

/** Main-process-owned RF truth. `unknown` is unsafe and requires disconnect/reconnect. */
export const instrumentRfOutputStateSchema = z.enum(['not-supported', 'off', 'on', 'unknown']);
export type InstrumentRfOutputState = z.infer<typeof instrumentRfOutputStateSchema>;
export const instrumentRfOutputQualificationSchema = z.enum([
  'not-applicable',
  'command-acknowledged',
  'firmware-executed-twin',
  'unverified',
]);
export type InstrumentRfOutputQualification = z.infer<typeof instrumentRfOutputQualificationSchema>;

export const instrumentSessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('measurement'), measurement: instrumentMeasurementSchema }).strict(),
  z.object({
    type: z.literal('status'),
    sessionId: instrumentOpaqueIdSchema,
    status: z.enum(['ready', 'busy', 'faulted']),
    message: z.string().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1).optional(),
  }).strict(),
  z.object({ type: z.literal('error'), sessionId: instrumentOpaqueIdSchema, error: instrumentErrorSchema }).strict(),
]);
export type InstrumentSessionEvent = z.infer<typeof instrumentSessionEventSchema>;

export const instrumentSessionSnapshotSchema = z.object({
  sessionId: instrumentOpaqueIdSchema,
  driverId: instrumentDriverIdSchema,
  candidate: instrumentCandidateSchema,
  provenance: instrumentSessionProvenanceSchema,
  capabilities: instrumentCapabilitiesSchema,
  rfOutput: instrumentRfOutputStateSchema,
  rfOutputQualification: instrumentRfOutputQualificationSchema,
  fault: instrumentErrorSchema.optional(),
  configuration: instrumentConfigurationStateSchema.optional(),
}).strict().superRefine((session, context) => {
  if (session.driverId !== session.candidate.driverId) {
    context.addIssue({ code: 'custom', path: ['candidate', 'driverId'], message: 'Session candidate must be owned by the session driver' });
  }
  if (session.candidate.sourceKind !== session.provenance.sourceKind) {
    context.addIssue({ code: 'custom', path: ['provenance', 'sourceKind'], message: 'Session provenance must match the admitted candidate source kind' });
  } else {
    switch (session.candidate.sourceKind) {
      case 'serial-port': {
        if (session.provenance.sourceKind !== 'serial-port') throw new Error('Candidate/provenance source narrowing failed');
        for (const field of ['path', 'manufacturer', 'product', 'serialNumber', 'vendorId', 'productId'] as const) {
          if (session.candidate.serialPort[field] !== session.provenance.serialPort[field]) {
            context.addIssue({ code: 'custom', path: ['provenance', 'serialPort', field], message: `Session serial ${field} must match the admitted endpoint` });
          }
        }
        break;
      }
      case 'tinysa-firmware-twin': {
        if (session.provenance.sourceKind !== 'tinysa-firmware-twin') throw new Error('Candidate/provenance source narrowing failed');
        for (const field of ['bridge', 'repositoryCommit', 'firmwareBinarySha256', 'usbTransactionsModeled'] as const) {
          if (session.candidate.firmwareTwin[field] !== session.provenance[field]) {
            context.addIssue({ code: 'custom', path: ['provenance', field], message: `Session firmware-twin ${field} must match discovery evidence` });
          }
        }
        break;
      }
      case 'signal-lab': {
        if (session.provenance.sourceKind !== 'signal-lab') throw new Error('Candidate/provenance source narrowing failed');
        if (session.candidate.signalLab.sourceId !== session.provenance.sourceId) {
          context.addIssue({ code: 'custom', path: ['provenance', 'sourceId'], message: 'Session SignalLab source must match the admitted candidate' });
        }
        break;
      }
      default: {
        const unhandledCandidate: never = session.candidate;
        throw new Error(`Session candidate binding is undefined for ${JSON.stringify(unhandledCandidate)}`);
      }
    }
  }
  for (const issue of instrumentCapabilitySourceBindingIssues(session.candidate.sourceKind, session.capabilities)) {
    context.addIssue({ code: 'custom', path: ['capabilities', ...issue.path], message: issue.message });
  }
  if (session.configuration) {
    if (session.configuration.sessionId !== session.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['configuration', 'sessionId'],
        message: 'Configuration state must belong to the enclosing session',
      });
    }
    for (const issue of instrumentConfigurationCapabilityBindingIssues(
      session.configuration.configuration,
      session.capabilities,
    )) {
      context.addIssue({
        code: 'custom',
        path: ['configuration', 'configuration', ...issue.path],
        message: issue.message,
      });
    }
  }
  const supportsRf = session.capabilities.features.some((feature) => feature.kind === 'rf-generator');
  if (supportsRf && session.rfOutput === 'not-supported') {
    context.addIssue({ code: 'custom', path: ['rfOutput'], message: 'RF-capable sessions must expose off, on, or unknown output state' });
  } else if (!supportsRf && session.rfOutput !== 'not-supported') {
    context.addIssue({ code: 'custom', path: ['rfOutput'], message: 'Sessions without RF capability must expose not-supported output state' });
  }
  const expectedQualification = expectedSessionRfOutputQualification(session.provenance, session.rfOutput);
  if (session.rfOutputQualification !== expectedQualification) {
    context.addIssue({ code: 'custom', path: ['rfOutputQualification'], message: `RF output qualification must be ${expectedQualification}` });
  }
});
export type InstrumentSessionSnapshot = z.infer<typeof instrumentSessionSnapshotSchema>;

function expectedSessionRfOutputQualification(
  provenance: InstrumentSessionProvenance,
  state: InstrumentRfOutputState,
): InstrumentRfOutputQualification {
  if (state === 'unknown') return 'unverified';
  if (state === 'not-supported') return 'not-applicable';
  switch (provenance.sourceKind) {
    case 'serial-port': return 'command-acknowledged';
    case 'tinysa-firmware-twin': return 'firmware-executed-twin';
    case 'signal-lab': return 'not-applicable';
    default: {
      const unhandledProvenance: never = provenance;
      throw new Error(`RF-output qualification is undefined for ${JSON.stringify(unhandledProvenance)}`);
    }
  }
}

export const instrumentManagerEventSchema = z.union([
  instrumentSessionEventSchema,
  z.object({ type: z.literal('discovery'), result: instrumentDiscoveryResultSchema }).strict(),
  z.object({ type: z.literal('connected'), session: instrumentSessionSnapshotSchema }).strict(),
  z.object({ type: z.literal('configured'), configuration: instrumentConfigurationStateSchema }).strict(),
  z.object({
    type: z.literal('configuration-invalidated'),
    sessionId: instrumentOpaqueIdSchema,
    reason: z.enum(['source-profile-changed', 'instrument-mode-changed']),
    session: instrumentSessionSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal('session-state'),
    reason: z.enum(['rf-output-changed', 'session-faulted']),
    session: instrumentSessionSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal('feature-result'),
    result: instrumentFeatureResultSchema,
    session: instrumentSessionSnapshotSchema,
  }).strict(),
  z.object({ type: z.literal('disconnected'), sessionId: instrumentOpaqueIdSchema, driverId: instrumentDriverIdSchema }).strict(),
]);
export type InstrumentManagerEvent = z.infer<typeof instrumentManagerEventSchema>;
