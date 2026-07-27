import { z } from 'zod';
import {
  isSourceQualifiedZs407CustomReceiverFirmwareIdentity,
  isSupportedZs407FirmwareIdentity,
  isZs407FirmwareVersionRevisionPair,
} from './firmware-provenance.js';

export const INSTRUMENT_CONTRACT_VERSION = 1 as const;
export const MAX_COMPLEX_IQ_BYTES_V1 = 64 * 1024 * 1024;
export const MAX_COMPLEX_IQ_SAMPLES_V1 = MAX_COMPLEX_IQ_BYTES_V1 / 8;
export const MAX_COMPLEX_IQ_SAMPLE_FORMATS_V1 = 4;
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
export const MAX_SIGNAL_LAB_SOURCE_REFERENCES_V1 = 32;
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

export const instrumentDriverIdSchema = z.string().min(1).max(MAX_INSTRUMENT_DRIVER_ID_CHARACTERS_V1)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export type InstrumentDriverId = z.infer<typeof instrumentDriverIdSchema>;
export const instrumentOpaqueIdSchema = z.string().min(1).max(MAX_INSTRUMENT_OPAQUE_ID_CHARACTERS_V1).regex(/\S/);
export const instrumentTimestampSchema = z.string().max(MAX_INSTRUMENT_TIMESTAMP_CHARACTERS_V1).datetime();

/**
 * One firmware-shell acknowledgement that the receive-only safety command was
 * accepted. This is command-path evidence only: it is deliberately not an RF
 * power measurement or an independent observation of the output connector.
 */
export const receiveOnlySafetyReceiptSchema = z.object({
  schemaVersion: z.literal(INSTRUMENT_CONTRACT_VERSION),
  receiptId: z.string().uuid(),
  sessionId: z.string().uuid(),
  command: z.literal('output off'),
  reason: z.enum([
    'connection-first-command',
    'analyzer-configuration',
    'pre-acquisition',
    'post-interaction-recovery',
    'disconnect',
  ]),
  outputState: z.literal('off'),
  acknowledgement: z.literal('empty-reply-acknowledged'),
  qualification: z.literal('device-command-acknowledged-not-rf-measured'),
  sequence: z.number().int().positive().max(MAX_INSTRUMENT_SEQUENCE_V1),
  acknowledgedAt: instrumentTimestampSchema,
}).strict();
export type ReceiveOnlySafetyReceipt = z.infer<typeof receiveOnlySafetyReceiptSchema>;

/**
 * Driver-neutral, separately qualified receive-only state. The connection
 * receipt proves the first command after transport open; currentReceipt is
 * the newest acknowledged reassertion in that same physical session.
 */
export const instrumentReceiveOnlySafetyStateSchema = z.object({
  connectionReceipt: receiveOnlySafetyReceiptSchema,
  currentReceipt: receiveOnlySafetyReceiptSchema,
}).strict().superRefine((state, context) => {
  if (state.connectionReceipt.reason !== 'connection-first-command') {
    context.addIssue({
      code: 'custom',
      path: ['connectionReceipt', 'reason'],
      message: 'Connection safety receipt must identify the first command after transport open',
    });
  }
  if (state.currentReceipt.sessionId !== state.connectionReceipt.sessionId) {
    context.addIssue({
      code: 'custom',
      path: ['currentReceipt', 'sessionId'],
      message: 'Current safety receipt must belong to the connection receipt session',
    });
  }
  if (state.currentReceipt.sequence < state.connectionReceipt.sequence) {
    context.addIssue({
      code: 'custom',
      path: ['currentReceipt', 'sequence'],
      message: 'Current safety receipt sequence cannot precede the connection receipt',
    });
  }
  if (Date.parse(state.currentReceipt.acknowledgedAt) < Date.parse(state.connectionReceipt.acknowledgedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['currentReceipt', 'acknowledgedAt'],
      message: 'Current safety receipt timestamp cannot precede the connection receipt',
    });
  }
  if (state.currentReceipt.sequence === state.connectionReceipt.sequence
    && (state.currentReceipt.receiptId !== state.connectionReceipt.receiptId
      || state.currentReceipt.reason !== state.connectionReceipt.reason
      || state.currentReceipt.acknowledgedAt !== state.connectionReceipt.acknowledgedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['currentReceipt'],
      message: 'Equal safety receipt sequences must identify the exact same receipt',
    });
  }
  if (state.currentReceipt.sequence !== state.connectionReceipt.sequence
    && state.currentReceipt.receiptId === state.connectionReceipt.receiptId) {
    context.addIssue({
      code: 'custom',
      path: ['currentReceipt', 'receiptId'],
      message: 'Distinct safety receipt sequences must use distinct receipt IDs',
    });
  }
});
export type InstrumentReceiveOnlySafetyState = z.infer<typeof instrumentReceiveOnlySafetyStateSchema>;

const endpointPathSchema = z.string().min(1).max(MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1);
const metadataStringSchema = z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1);
const frequencyHzSchema = z.number().int().nonnegative().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const positiveFrequencyHzSchema = z.number().int().positive().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const measuredFrequencyHzSchema = z.number().finite().nonnegative().max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const sampleRateHzSchema = z.number().int().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1);
const boundedPowerSchema = z.number().finite()
  .min(-MAX_INSTRUMENT_POWER_ABS_DB_V1)
  .max(MAX_INSTRUMENT_POWER_ABS_DB_V1);

/**
 * Interleaved I,Q wire encodings admitted at the instrument boundary. Drivers
 * may expose their efficient native encoding; consumers therefore never have
 * to infer component width, signedness, byte order, or I/Q ordering.
 */
export const COMPLEX_IQ_SAMPLE_FORMATS_V1 = ['cf32le', 'ci16le', 'ci8', 'cu8'] as const;
export const complexIqSampleFormatSchema = z.enum(COMPLEX_IQ_SAMPLE_FORMATS_V1);
export type ComplexIqSampleFormat = z.infer<typeof complexIqSampleFormatSchema>;
export const COMPLEX_IQ_BYTES_PER_SAMPLE_V1: Readonly<Record<ComplexIqSampleFormat, number>> = Object.freeze({
  cf32le: 8,
  ci16le: 4,
  ci8: 2,
  cu8: 2,
});

/** Exact byte geometry for one compact, interleaved I/Q capture. */
export function complexIqPayloadByteLength(
  sampleCount: number,
  sampleFormat: ComplexIqSampleFormat,
): number {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
    throw new TypeError('Complex-I/Q sample count must be a positive safe integer');
  }
  if (sampleCount > MAX_COMPLEX_IQ_SAMPLES_V1) {
    throw new RangeError(`Complex-I/Q sample count is limited to ${MAX_COMPLEX_IQ_SAMPLES_V1} in contract v1`);
  }
  const bytesPerSample = COMPLEX_IQ_BYTES_PER_SAMPLE_V1[sampleFormat];
  if (bytesPerSample === undefined) throw new TypeError(`Unsupported complex-I/Q sample format ${String(sampleFormat)}`);
  const byteLength = sampleCount * bytesPerSample;
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_COMPLEX_IQ_BYTES_V1) {
    throw new RangeError(`Complex-I/Q payloads are limited to ${MAX_COMPLEX_IQ_BYTES_V1} bytes in contract v1`);
  }
  return byteLength;
}

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
  bandwidthMode: z.enum(['independent', 'equal-to-sample-rate']).optional(),
  sampleCount: complexIqSampleCountRangeSchema,
  sampleFormat: complexIqSampleFormatSchema,
}).strict().superRefine((capability, context) => {
  if (capability.bandwidthHz.min > maximumReachableRangeValue(capability.sampleRateHz)) {
    context.addIssue({ code: 'custom', path: ['bandwidthHz', 'min'], message: 'Complex-I/Q capability must admit a bandwidth no greater than an advertised sample rate' });
  }
  if (capability.bandwidthMode === 'equal-to-sample-rate'
    && !integerRangesShareValue(capability.sampleRateHz, capability.bandwidthHz)) {
    context.addIssue({
      code: 'custom',
      path: ['bandwidthMode'],
      message: 'Equal-rate complex-I/Q capability must admit at least one common sample-rate and bandwidth value',
    });
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

const signalLabProfileGeometryShape = {
  profileId: instrumentOpaqueIdSchema,
  centerFrequencyHz: frequencyHzSchema,
  recommendedSpanHz: positiveFrequencyHzSchema,
} as const;

export const signalLabProfileGeometrySchema = z.object(signalLabProfileGeometryShape).strict();

const signalLabWaveformProjectionSchema = z.object({
  allocation: z.enum([
    'carrier', 'sidebands', 'full', 'narrowband', 'multi-ru', 'resource-unit',
    'frequency-hopping', 'advertising-channels',
  ]),
  modulation: z.enum([
    'unmodulated', 'am', 'fm', 'gmsk', 'qpsk', 'aqpsk', '8psk', '16qam',
    '32qam', '64qam', '256qam', '1024qam', 'ofdm-mixed', 'he-ofdm',
    'hr-dsss', 'br-gfsk', 'br-edr', 'ble-1m',
  ]),
  timing: z.enum(['continuous', 'burst', 'frame', 'tdd-frame', 'classic-slots', 'advertising-events']),
  duplex: z.enum(['fdd', 'tdd']).optional(),
  subcarrierSpacingHz: sampleRateHzSchema.optional(),
  nominalResourceBlocks: z.number().int().positive().max(100_000).optional(),
}).strict();

const signalLabSourceReferenceSchema = z.object({
  specification: metadataStringSchema,
  clause: metadataStringSchema,
  revision: metadataStringSchema,
  url: z.string().min(1).max(MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1).url(),
}).strict();

export const signalLabGovernanceOrganizationSchema = z.enum([
  '3GPP',
  'IEEE',
  'Bluetooth SIG',
  'TinySA SignalLab',
]);

export const signalLabProfileGovernanceSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: instrumentOpaqueIdSchema,
  signalKind: z.enum([
    'normative-fixed-profile',
    'standards-derived-engineering-profile',
    'standards-component-fixture',
    'operator-defined-builder',
    'mathematical-lab-reference',
  ]),
  governingOrganizations: boundedReadonlyArray(signalLabGovernanceOrganizationSchema, 4, 1),
  governingBodies: boundedReadonlyArray(z.object({
    organization: signalLabGovernanceOrganizationSchema,
    technicalBody: z.enum([
      '3GPP TSG RAN',
      'IEEE Standards Association / IEEE 802.11 Working Group',
      'Bluetooth SIG Core Specification Working Group',
      'TinySA SignalLab project',
    ]),
    authorityScope: z.string().trim().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
  }).strict(), 4, 1),
  normativeReferences: boundedReadonlyArray(z.object({
    organization: signalLabGovernanceOrganizationSchema.exclude(['TinySA SignalLab']),
    documentId: metadataStringSchema,
    revision: metadataStringSchema,
    clauses: boundedReadonlyArray(metadataStringSchema, MAX_SIGNAL_LAB_SOURCE_REFERENCES_V1, 1),
    url: z.string().min(1).max(MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1).url()
      .refine((value) => value.startsWith('https://'), 'Normative reference must use HTTPS'),
  }).strict(), MAX_SIGNAL_LAB_SOURCE_REFERENCES_V1),
  applicability: z.object({
    status: z.enum(['applicable', 'configuration-only', 'not-applicable']),
    reason: z.string().trim().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
  }).strict(),
  implementedQualificationState: z.enum([
    'mathematical-reference',
    'standards-derived-engineering-projection',
    'digitally-qualified',
  ]),
  testedClaimScope: z.object({
    kind: z.enum([
      'deterministic-mathematical-reference',
      'deterministic-engineering-projection',
      'configuration-constraints-only',
      'content-bound-independent-digital-baseband',
    ]),
    statement: z.string().trim().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
    testLocations: boundedReadonlyArray(
      z.string().trim().regex(/^src\/[^#]+\.test\.(?:ts|tsx)$/),
      MAX_SIGNAL_LAB_SOURCE_REFERENCES_V1,
      1,
    ),
  }).strict(),
  claims: z.object({
    standardsCompliance: z.literal('not-claimed'),
    digitalStandardsAdherence: z.enum([
      'not-applicable',
      'configuration-only',
      'not-verified',
      'verified-for-declared-digital-scope',
    ]),
    digitalQualification: z.enum(['not-qualified', 'qualified']),
    rfConformance: z.literal('not-qualified'),
  }).strict(),
  digitalQualificationEvidence: z.object({
    artifact: z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mediaType: metadataStringSchema,
      producer: metadataStringSchema,
    }).strict(),
    independentEvidence: z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      reportPath: z.string().trim().regex(/^validation\/[^/]+\.json$/),
      result: z.literal('pass'),
      oracleProvider: metadataStringSchema,
      suite: metadataStringSchema,
    }).strict(),
  }).strict().nullable(),
  qualificationBlockers: boundedReadonlyArray(
    z.string().trim().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
    MAX_SIGNAL_LAB_SOURCE_REFERENCES_V1,
    1,
  ),
  reason: z.string().trim().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
}).strict().superRefine((governance, context) => {
  const organizations = new Set(governance.governingOrganizations);
  if (organizations.size !== governance.governingOrganizations.length) {
    context.addIssue({ code: 'custom', path: ['governingOrganizations'], message: 'Governing organizations must be unique' });
  }
  const bodyOrganizations = governance.governingBodies.map(({ organization }) => organization);
  if (new Set(bodyOrganizations).size !== bodyOrganizations.length
    || bodyOrganizations.length !== organizations.size
    || bodyOrganizations.some((organization) => !organizations.has(organization))) {
    context.addIssue({ code: 'custom', path: ['governingBodies'], message: 'Governing body details must exactly cover the governing organizations' });
  }
  for (const [index, reference] of governance.normativeReferences.entries()) {
    if (!organizations.has(reference.organization)) {
      context.addIssue({
        code: 'custom',
        path: ['normativeReferences', index, 'organization'],
        message: 'Every normative reference organization must be listed as governing',
      });
    }
  }
  const digitallyQualified = governance.claims.digitalQualification === 'qualified'
    || governance.implementedQualificationState === 'digitally-qualified';
  if (digitallyQualified && (
    governance.claims.digitalQualification !== 'qualified'
    || governance.implementedQualificationState !== 'digitally-qualified'
    || governance.claims.digitalStandardsAdherence !== 'verified-for-declared-digital-scope'
    || governance.testedClaimScope.kind !== 'content-bound-independent-digital-baseband'
    || governance.digitalQualificationEvidence === null
  )) {
    context.addIssue({
      code: 'custom',
      path: ['claims'],
      message: 'Digital qualification requires matching claim state, independent scope, and content-addressed evidence',
    });
  }
  if (!digitallyQualified && governance.digitalQualificationEvidence !== null) {
    context.addIssue({
      code: 'custom',
      path: ['digitalQualificationEvidence'],
      message: 'Unqualified profiles must not carry digital qualification evidence',
    });
  }
});
export type SignalLabProfileGovernance = z.infer<typeof signalLabProfileGovernanceSchema>;

/**
 * A complete, admitted SignalLab catalog entry. The lightweight geometry
 * geometry schema remains available for incomplete non-session discovery
 * views; every complete v2 descriptor carries its governance evidence.
 */
export const signalLabWaveformDescriptorSchema = z.object({
  ...signalLabProfileGeometryShape,
  label: metadataStringSchema,
  family: z.enum(['tone', 'analog', 'geran', 'e-utra', 'nr', 'wlan', 'bluetooth', 'reference']),
  model: metadataStringSchema,
  qualification: z.enum([
    'visual',
    'standards-derived',
    'independently-verified-digital-baseband',
    'conformance-validated',
  ]),
  occupiedBandwidthHz: positiveFrequencyHzSchema,
  projection: signalLabWaveformProjectionSchema,
  source: z.object({
    organization: z.enum(['TinySA SignalLab', '3GPP', 'IEEE', 'Bluetooth SIG']),
    references: boundedReadonlyArray(
      signalLabSourceReferenceSchema,
      MAX_SIGNAL_LAB_SOURCE_REFERENCES_V1,
      1,
    ),
  }).strict(),
  governance: signalLabProfileGovernanceSchema,
  disclosure: z.string().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((descriptor, context) => {
  if (descriptor.recommendedSpanHz < descriptor.occupiedBandwidthHz) {
    context.addIssue({ code: 'custom', path: ['recommendedSpanHz'], message: 'Recommended span must contain the occupied bandwidth' });
  }
  if ((descriptor.qualification === 'independently-verified-digital-baseband'
    || descriptor.qualification === 'conformance-validated')
    && descriptor.assetSha256 === undefined) {
    context.addIssue({ code: 'custom', path: ['assetSha256'], message: 'Digitally qualified waveforms require a verified I/Q asset hash' });
  }
  if (descriptor.qualification === 'visual' && descriptor.source.organization !== 'TinySA SignalLab') {
    context.addIssue({ code: 'custom', path: ['source', 'organization'], message: 'Visual analytic waveforms must cite TinySA SignalLab' });
  }
  if (descriptor.qualification !== 'visual' && descriptor.source.organization === 'TinySA SignalLab') {
    context.addIssue({ code: 'custom', path: ['source', 'organization'], message: 'Standards or conformance-qualified waveforms require an external standards organization' });
  }
  if (descriptor.governance.profileId !== descriptor.profileId) {
    context.addIssue({ code: 'custom', path: ['governance', 'profileId'], message: 'Governance profile ID must match the waveform descriptor ID' });
  }
  if (!descriptor.governance.governingOrganizations.includes(descriptor.source.organization)) {
    context.addIssue({ code: 'custom', path: ['governance', 'governingOrganizations'], message: 'Descriptor source organization must be represented in governance' });
  }
  if (descriptor.qualification === 'independently-verified-digital-baseband'
    && descriptor.governance.claims.digitalQualification !== 'qualified') {
    context.addIssue({ code: 'custom', path: ['governance', 'claims', 'digitalQualification'], message: 'Independent digital-baseband qualification requires qualified governance' });
  }
  const evidenceHash = descriptor.governance.digitalQualificationEvidence?.artifact.sha256;
  if (descriptor.assetSha256 !== undefined && evidenceHash !== undefined
    && descriptor.assetSha256.toLowerCase() !== evidenceHash) {
    context.addIssue({ code: 'custom', path: ['assetSha256'], message: 'Descriptor asset hash must match the governance artifact hash' });
  }
});
export type SignalLabWaveformDescriptor = z.infer<typeof signalLabWaveformDescriptorSchema>;

export const signalLabIqProfileCapabilitySchema = z.object({
  profileId: instrumentOpaqueIdSchema,
  /** Null means the generator has no single content-bound native rate. */
  nativeSampleRateHz: sampleRateHzSchema.nullable(),
  /** Signal/channel support, distinct from requested output/capture bandwidth. */
  signalBandwidthHz: sampleRateHzSchema,
  /**
   * I/Q profile reference signal center; it may intentionally differ from an
   * aggregate scalar/catalog reference center (for example Bluetooth).
   */
  profileReferenceCenterHz: frequencyHzSchema,
  /** Carrier location inside the native complex artifact. */
  nativeCarrierOffsetHz: z.number().int().min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1),
  /**
   * Smallest symmetric capture about the native RF tune center that still
   * contains the whole offset signal support, so `2 * |offset| + signal`.
   * Requesting less than this is legal but forces the producer to translate
   * the carrier to DC, which changes the bytes and downgrades qualification.
   * Null for rate-flexible generators, which have no native artifact.
   */
  nativeMinimumCaptureBandwidthHz: sampleRateHzSchema.nullable(),
  replay: z.enum(['continuous', 'cyclic', 'one-shot']),
  /** Native-domain period used for modular FIR support and exact replay. */
  nativePeriodSamples: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1).optional(),
  /** Native-domain bound; output-domain limits scale with the requested rate. */
  maxOneShotSamples: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1).optional(),
  derivedTransportSupported: z.boolean(),
}).strict().superRefine((profile, context) => {
  if ((profile.replay === 'one-shot') !== (profile.maxOneShotSamples !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['maxOneShotSamples'],
      message: 'One-shot profiles require a native-domain sample bound and all other profiles must omit it',
    });
  }
  if ((profile.replay === 'cyclic') !== (profile.nativePeriodSamples !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['nativePeriodSamples'],
      message: 'Only cyclic artifact profiles declare a native-domain period',
    });
  }
  if ((profile.nativeSampleRateHz === null) !== (profile.replay === 'continuous')) {
    context.addIssue({
      code: 'custom',
      path: ['replay'],
      message: 'Only rate-flexible generators use continuous replay',
    });
  }
  if (profile.nativeSampleRateHz === null && profile.derivedTransportSupported) {
    context.addIssue({
      code: 'custom',
      path: ['derivedTransportSupported'],
      message: 'A rate-flexible generator has no native artifact to derive',
    });
  }
  if (profile.nativeSampleRateHz !== null
    && Math.abs(profile.nativeCarrierOffsetHz) + profile.signalBandwidthHz / 2
      > profile.nativeSampleRateHz / 2) {
    context.addIssue({
      code: 'custom', path: ['nativeCarrierOffsetHz'],
      message: 'Native carrier offset plus half the signal bandwidth must fit below native Nyquist',
    });
  }
  if (profile.nativeSampleRateHz === null && profile.nativeCarrierOffsetHz !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['nativeCarrierOffsetHz'],
      message: 'A generator with no fixed native artifact must generate its carrier at baseband',
    });
  }
  if ((profile.nativeSampleRateHz === null)
    !== (profile.nativeMinimumCaptureBandwidthHz === null)) {
    context.addIssue({
      code: 'custom',
      path: ['nativeMinimumCaptureBandwidthHz'],
      message: 'Only fixed native artifacts declare a native minimum capture bandwidth',
    });
  }
  if (profile.nativeSampleRateHz !== null) {
    const expectedMinimumCaptureBandwidthHz =
      2 * Math.abs(profile.nativeCarrierOffsetHz) + profile.signalBandwidthHz;
    if (profile.nativeMinimumCaptureBandwidthHz !== expectedMinimumCaptureBandwidthHz) {
      context.addIssue({
        code: 'custom',
        path: ['nativeMinimumCaptureBandwidthHz'],
        message: 'Native minimum capture bandwidth must symmetrically contain the offset signal support',
      });
    }
    if (expectedMinimumCaptureBandwidthHz > profile.nativeSampleRateHz) {
      context.addIssue({
        code: 'custom',
        path: ['nativeMinimumCaptureBandwidthHz'],
        message: 'Native minimum capture bandwidth may not exceed the native sample rate',
      });
    }
  }
  const rfReferenceCenterHz = profile.profileReferenceCenterHz - profile.nativeCarrierOffsetHz;
  if (rfReferenceCenterHz < 0 || rfReferenceCenterHz > MAX_INSTRUMENT_FREQUENCY_HZ_V1) {
    context.addIssue({
      code: 'custom',
      path: ['profileReferenceCenterHz'],
      message: 'Canonical RF reference center must be within the admitted RF range',
    });
  }
});
export type SignalLabIqProfileCapability = z.infer<typeof signalLabIqProfileCapabilitySchema>;

export const signalLabReceiverImpairmentPresetSchema = z.enum([
  'clean',
  'awgn',
  'multipath',
  'carrier-offset',
  'phase-noise',
  'iq-imbalance',
  'dc-offset',
  'pa-compression',
  'composite',
]);
export const signalLabChannelStateSchema = z.object({
  model: z.enum(['awgn', 'rayleigh']),
  noiseFloorDbm: z.number().finite().min(-150).max(-30),
  seed: z.number().int().min(1).max(0xffff_ffff),
  fadingRateHz: z.number().finite().min(0.1).max(100),
  /** Explicit v2 complex-I/Q receiver preset, including the clean state. */
  receiverImpairment: signalLabReceiverImpairmentPresetSchema,
}).strict();
export type SignalLabChannelState = z.infer<typeof signalLabChannelStateSchema>;

export const signalLabProfileSelectionCapabilitySchema = z.object({
  kind: z.literal('signal-lab-profile-selection'),
  profiles: boundedReadonlyArray(
    signalLabWaveformDescriptorSchema,
    MAX_SIGNAL_LAB_PROFILES_V1,
    1,
  ),
  selectedProfileId: instrumentOpaqueIdSchema,
  channel: signalLabChannelStateSchema,
  iqProfiles: boundedReadonlyArray(signalLabIqProfileCapabilitySchema, MAX_SIGNAL_LAB_PROFILES_V1, 1),
}).strict().superRefine((capability, context) => {
  if (capability.profiles.length > MAX_SIGNAL_LAB_PROFILES_V1) return;
  if (new Set(capability.profiles.map((profile) => profile.profileId)).size !== capability.profiles.length) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'SignalLab profile IDs must be unique' });
  }
  if (!capability.profiles.some((profile) => profile.profileId === capability.selectedProfileId)) {
    context.addIssue({ code: 'custom', path: ['selectedProfileId'], message: 'Selected SignalLab profile must be advertised' });
  }
  const profileIds = capability.iqProfiles.map(({ profileId }) => profileId);
  if (new Set(profileIds).size !== profileIds.length) {
    context.addIssue({ code: 'custom', path: ['iqProfiles'], message: 'SignalLab I/Q profile capabilities must be unique' });
  }
  const catalogIds = new Set(capability.profiles.map((profile) => profile.profileId));
  for (const [index, profileId] of profileIds.entries()) {
    if (!catalogIds.has(profileId)) {
      context.addIssue({ code: 'custom', path: ['iqProfiles', index, 'profileId'], message: 'SignalLab I/Q profile capability must belong to the admitted catalog' });
    }
  }
  if (profileIds.length !== catalogIds.size
    || capability.profiles.some((profile) => !profileIds.includes(profile.profileId))) {
    context.addIssue({
      code: 'custom',
      path: ['iqProfiles'],
      message: 'Measurement-bridge v2 requires exactly one I/Q transport for every governed catalog profile',
    });
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
    if (scalar.length !== 2 || !spectrum || !detected) {
      issues.push({ path: ['acquisitions'], message: 'SignalLab must advertise swept-spectrum and detected-power scalar acquisitions' });
    }
    if (scalar.some((capability) => capability.controls.model !== 'synthetic-scalar')) {
      issues.push({ path: ['acquisitions'], message: 'SignalLab scalar acquisitions must use only synthetic scalar controls' });
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
      const iqCapability = capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq');
      const advertisesIq = iqCapability !== undefined;
      if (!advertisesIq) {
        issues.push({
          path: ['features', 0, 'iqProfiles'],
          message: 'SignalLab v2 must advertise complex-I/Q acquisition with its per-profile transports',
        });
      }
      if (iqCapability?.kind === 'complex-iq' && profileFeature.iqProfiles) {
        for (const [profileIndex, profile] of profileFeature.iqProfiles.entries()) {
          if (profile.nativeSampleRateHz !== null
            && !numericRangePermits(profile.nativeSampleRateHz, iqCapability.sampleRateHz)) {
            issues.push({
              path: ['features', 0, 'iqProfiles', profileIndex, 'nativeSampleRateHz'],
              message: 'SignalLab profile native rate must lie on the complex-I/Q output-rate grid',
            });
          }
          if (!numericRangePermits(profile.signalBandwidthHz, iqCapability.bandwidthHz)) {
            issues.push({
              path: ['features', 0, 'iqProfiles', profileIndex, 'signalBandwidthHz'],
              message: 'SignalLab profile bandwidth must lie on the complex-I/Q output-bandwidth grid',
            });
          }
          if (profile.maxOneShotSamples !== undefined
            && !numericRangePermits(profile.maxOneShotSamples, iqCapability.sampleCount)) {
            issues.push({
              path: ['features', 0, 'iqProfiles', profileIndex, 'maxOneShotSamples'],
              message: 'SignalLab native one-shot bound must lie on the complex-I/Q sample-count grid',
            });
          }
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

/** Exact arithmetic-progression intersection for safe-integer capability ranges. */
function integerRangesShareValue(
  left: Readonly<{ min: number; max: number; step?: number }>,
  right: Readonly<{ min: number; max: number; step?: number }>,
): boolean {
  const lower = BigInt(Math.max(left.min, right.min));
  const upper = BigInt(Math.min(left.max, right.max));
  if (upper < lower) return false;
  const leftStart = BigInt(left.min);
  const rightStart = BigInt(right.min);
  const leftStep = BigInt(left.step ?? 1);
  const rightStep = BigInt(right.step ?? 1);
  const divisor = greatestCommonDivisor(leftStep, rightStep);
  const difference = rightStart - leftStart;
  if (difference % divisor !== 0n) return false;
  const reducedRightStep = rightStep / divisor;
  const multiplier = reducedRightStep === 1n
    ? 0n
    : positiveRemainder(
        (difference / divisor) * modularInverse(leftStep / divisor, reducedRightStep),
        reducedRightStep,
      );
  let candidate = leftStart + leftStep * multiplier;
  const period = leftStep * reducedRightStep;
  if (candidate < lower) candidate += ((lower - candidate + period - 1n) / period) * period;
  return candidate <= upper;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-12);
}

function modularInverse(value: bigint, modulus: bigint): bigint {
  let oldRemainder = value;
  let remainder = modulus;
  let oldCoefficient = 1n;
  let coefficient = 0n;
  while (remainder !== 0n) {
    const quotient = oldRemainder / remainder;
    [oldRemainder, remainder] = [remainder, oldRemainder - quotient * remainder];
    [oldCoefficient, coefficient] = [coefficient, oldCoefficient - quotient * coefficient];
  }
  return positiveRemainder(oldCoefficient, modulus);
}

function positiveRemainder(value: bigint, modulus: bigint): bigint {
  const remainder = value % modulus;
  return remainder < 0n ? remainder + modulus : remainder;
}

export const instrumentMeasurementQualificationSchema = z.enum([
  'device-observed',
  'firmware-executed-twin',
  'synthetic-visual-projection',
  'analytic-complex-baseband',
  'standards-derived-complex-baseband',
  'reference-generated-digital-baseband',
  'independently-verified-digital-baseband',
  'derived-from-independently-verified-digital-baseband',
  'receiver-impaired-complex-baseband',
]);

const scalarMeasurementQualificationSchema = z.enum([
  'device-observed',
  'firmware-executed-twin',
  'synthetic-visual-projection',
]);

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

const sourceQualifiedCustomReceiverSerialSessionDeviceSchema = z.object({
  ...serialSessionDeviceBaseShape,
  firmwareReportedRevision: z.string().regex(/^[a-f0-9]{7,40}$/i),
  firmwareSourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
  firmwareQualification: z.literal('custom-source-qualified-receive-only'),
  firmwareWarning: metadataStringSchema,
}).strict().superRefine((device, context) => {
  if (!isZs407FirmwareVersionRevisionPair(device.firmwareVersion, device.firmwareReportedRevision)) {
    context.addIssue({
      code: 'custom',
      path: ['firmwareReportedRevision'],
      message: 'Source-qualified custom receive-only revision must equal the single revision token in the firmware version',
    });
  }
  if (!isSourceQualifiedZs407CustomReceiverFirmwareIdentity(
    device.firmwareVersion,
    device.firmwareReportedRevision,
    device.firmwareSourceCommit,
    device.firmwareWarning,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['firmwareSourceCommit'],
      message: 'Source-qualified custom receive-only firmware must match its exact frozen source record and warning',
    });
  }
});

const serialSessionDeviceSchema = z.union([
  supportedOemSerialSessionDeviceSchema,
  sourceQualifiedCustomReceiverSerialSessionDeviceSchema,
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
  contractVersion: z.literal(2),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generatorContractBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
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
export const signalLabConfigureChannelFeatureRequestSchema = z.object({
  kind: z.literal('signal-lab-profile-selection'),
  action: z.literal('configure-channel'),
  channel: signalLabChannelStateSchema,
}).strict();
export const signalLabCustomWaveformStandardSchema = z.enum(['lte', 'nr', 'wifi']);
/** Custom-builder selections: parameter key -> option ('auto' or a legal value); legality is re-validated by the SignalLab constraint resolver. */
export const signalLabCustomWaveformSelectionsSchema = z.record(
  z.string().min(1).max(48).regex(/^[A-Za-z][A-Za-z0-9]*$/),
  z.string().min(1).max(48),
).refine((selections) => Object.keys(selections).length <= 32, { message: 'Too many custom-waveform selections' });
export const signalLabConfigureCustomWaveformFeatureRequestSchema = z.object({
  kind: z.literal('signal-lab-profile-selection'),
  action: z.literal('configure-custom-waveform'),
  standard: signalLabCustomWaveformStandardSchema,
  selections: signalLabCustomWaveformSelectionsSchema,
}).strict();
export const instrumentFeatureRequestSchema = z.union([
  rfGeneratorConfigureFeatureRequestSchema,
  rfGeneratorOutputFeatureRequestSchema,
  screenCaptureFeatureRequestSchema,
  touchTapFeatureRequestSchema,
  diagnosticsReadFeatureRequestSchema,
  signalLabSelectProfileFeatureRequestSchema,
  signalLabConfigureChannelFeatureRequestSchema,
  signalLabConfigureCustomWaveformFeatureRequestSchema,
]);
export type InstrumentFeatureRequest = z.infer<typeof instrumentFeatureRequestSchema>;

const featureCommandSessionShape = { sessionId: instrumentOpaqueIdSchema } as const;
export const rfGeneratorConfigureFeatureCommandSchema = rfGeneratorConfigureFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const rfGeneratorOutputFeatureCommandSchema = rfGeneratorOutputFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const screenCaptureFeatureCommandSchema = screenCaptureFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const touchTapFeatureCommandSchema = touchTapFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const diagnosticsReadFeatureCommandSchema = diagnosticsReadFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const signalLabSelectProfileFeatureCommandSchema = signalLabSelectProfileFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const signalLabConfigureChannelFeatureCommandSchema = signalLabConfigureChannelFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const signalLabConfigureCustomWaveformFeatureCommandSchema = signalLabConfigureCustomWaveformFeatureRequestSchema.extend(featureCommandSessionShape).strict();
export const instrumentFeatureCommandSchema = z.union([
  rfGeneratorConfigureFeatureCommandSchema,
  rfGeneratorOutputFeatureCommandSchema,
  screenCaptureFeatureCommandSchema,
  touchTapFeatureCommandSchema,
  diagnosticsReadFeatureCommandSchema,
  signalLabSelectProfileFeatureCommandSchema,
  signalLabConfigureChannelFeatureCommandSchema,
  signalLabConfigureCustomWaveformFeatureCommandSchema,
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
export const signalLabConfigureChannelFeatureResultSchema = signalLabConfigureChannelFeatureRequestSchema.extend({
  ...featureResultSessionShape,
  producerConfigurationEpoch: instrumentOpaqueIdSchema,
}).strict();
export const signalLabConfigureCustomWaveformFeatureResultSchema = signalLabConfigureCustomWaveformFeatureRequestSchema.extend({
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
  signalLabConfigureChannelFeatureResultSchema,
  signalLabConfigureCustomWaveformFeatureResultSchema,
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
  sampleFormat: complexIqSampleFormatSchema,
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
    if (capability.bandwidthMode === 'equal-to-sample-rate'
      && configuration.bandwidthHz !== configuration.sampleRateHz) {
      issues.push({
        path: ['bandwidthHz'],
        message: 'I/Q bandwidth must equal sample rate for this acquisition capability',
      });
    }
    const signalLab = capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    const profile = signalLab?.kind === 'signal-lab-profile-selection'
      ? signalLab.iqProfiles.find((candidate) => candidate.profileId === signalLab.selectedProfileId)
      : undefined;
    if (signalLab?.kind === 'signal-lab-profile-selection' && !profile) {
      issues.push({
        path: ['kind'],
        message: `SignalLab profile ${signalLab.selectedProfileId} has no admitted complex-I/Q transport`,
      });
    } else if (profile) {
      if (configuration.sampleRateHz < profile.signalBandwidthHz) {
        issues.push({
          path: ['sampleRateHz'],
          message: `SignalLab output rate cannot represent the ${profile.signalBandwidthHz} Hz profile signal bandwidth`,
        });
      }
      if (configuration.bandwidthHz < profile.signalBandwidthHz) {
        issues.push({
          path: ['bandwidthHz'],
          message: `SignalLab capture bandwidth cannot exclude part of the ${profile.signalBandwidthHz} Hz profile signal support`,
        });
      }
      if (profile.nativeSampleRateHz !== null
        && configuration.sampleRateHz !== profile.nativeSampleRateHz
        && !profile.derivedTransportSupported) {
        issues.push({
          path: ['sampleRateHz'],
          message: `SignalLab profile ${profile.profileId} does not support derived I/Q transport`,
        });
      }
      if (profile.nativeSampleRateHz !== null
        && configuration.sampleRateHz !== profile.nativeSampleRateHz
        && configuration.sampleRateHz < profile.nativeSampleRateHz
        && configuration.sampleRateHz < signalLabMinimumDerivedSampleRateHz(profile.signalBandwidthHz)) {
        issues.push({
          path: ['sampleRateHz'],
          message: `SignalLab derived output rate must be at least ${signalLabMinimumDerivedSampleRateHz(profile.signalBandwidthHz)} samples/s to preserve anti-alias support`,
        });
      }
      const outputLimit = signalLabOutputOneShotSampleLimit(profile, configuration.sampleRateHz);
      if (outputLimit !== undefined && configuration.sampleCount > outputLimit) {
        issues.push({
          path: ['sampleCount'],
          message: `SignalLab profile ${profile.profileId} permits at most ${outputLimit} output samples at ${configuration.sampleRateHz} samples/s`,
        });
      }
    }
  }
  return issues;
}

/** Convert a native one-shot artifact bound into the requested output-rate
 * domain without pretending the native sample count is an output count. */
export function signalLabOutputOneShotSampleLimit(
  profile: Pick<SignalLabIqProfileCapability, 'nativeSampleRateHz' | 'maxOneShotSamples'>,
  outputSampleRateHz: number,
): number | undefined {
  if (profile.maxOneShotSamples === undefined) return undefined;
  if (profile.nativeSampleRateHz === null) return profile.maxOneShotSamples;
  if (!Number.isSafeInteger(outputSampleRateHz) || outputSampleRateHz < 1) {
    throw new TypeError('SignalLab output sample rate must be a positive safe integer');
  }
  const scaled = BigInt(profile.maxOneShotSamples) * BigInt(outputSampleRateHz)
    / BigInt(profile.nativeSampleRateHz);
  return Number(
    scaled < 1n
      ? 1n
      : scaled > BigInt(MAX_COMPLEX_IQ_SAMPLES_V1)
        ? BigInt(MAX_COMPLEX_IQ_SAMPLES_V1)
        : scaled,
  );
}

/** v2's windowed-sinc lane preserves a 95%-of-Nyquist complex passband. */
export function signalLabMinimumDerivedSampleRateHz(signalBandwidthHz: number): number {
  if (!Number.isSafeInteger(signalBandwidthHz) || signalBandwidthHz < 1) {
    throw new TypeError('SignalLab signal bandwidth must be a positive safe integer');
  }
  return Number((BigInt(signalBandwidthHz) * 100n + 94n) / 95n);
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
  receiveOnlySafetyReceipt: receiveOnlySafetyReceiptSchema.optional(),
  complete: z.literal(true),
} as const;

export const sweptSpectrumMeasurementSchema = z.object({
  ...measurementBaseShape,
  kind: z.literal('swept-spectrum'),
  qualification: scalarMeasurementQualificationSchema,
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
  qualification: scalarMeasurementQualificationSchema,
  centerHz: frequencyHzSchema,
  sampleIntervalSeconds: z.number().finite().positive().max(MAX_INSTRUMENT_DURATION_SECONDS_V1),
  timingQualification: z.enum(['wall-clock-derived', 'measured-calibrated', 'simulation-exact']),
  powerDbm: boundedReadonlyArray(boundedPowerSchema, MAX_DETECTED_POWER_SAMPLES_V1, 1),
}).strict();

export const signalLabIqTransformOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resample'),
    algorithm: z.literal('blackman-windowed-sinc-v1'),
    sourceSampleRateHz: sampleRateHzSchema,
    outputSampleRateHz: sampleRateHzSchema,
    antiAliasCutoffHz: z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1),
    zeroCrossings: z.literal(16),
  }).strict(),
  z.object({
    kind: z.literal('fractional-delay'),
    algorithm: z.literal('blackman-windowed-sinc-v1'),
    sampleRateHz: sampleRateHzSchema,
    phaseNumerator: z.string().regex(/^[1-9][0-9]{0,39}$/),
    phaseDenominator: z.string().regex(/^[1-9][0-9]{0,39}$/),
    antiAliasCutoffHz: z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1),
    zeroCrossings: z.literal(16),
  }).strict(),
  z.object({
    kind: z.literal('receiver-impairment'),
    algorithm: z.literal('signal-lab-receiver-impairment-v1'),
    preset: signalLabReceiverImpairmentPresetSchema.exclude(['clean']),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
  }).strict(),
  z.object({
    kind: z.literal('frequency-translate'),
    algorithm: z.literal('complex-rotator-v1'),
    sourceCarrierOffsetHz: z.number().int()
      .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1),
    outputCarrierOffsetHz: z.number().int()
      .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1),
  }).strict(),
]);

export const signalLabIqTransformReceiptSchema = z.object({
  receiptVersion: z.literal(1),
  sourceArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sourceStartSample: z.number().int()
    .min(-MAX_INSTRUMENT_SEQUENCE_V1).max(MAX_INSTRUMENT_SEQUENCE_V1),
  sourceSampleCount: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1),
  sourceBoundaryPolicy: z.enum([
    'continuous-session-origin-zero-extended',
    'cyclic-modular',
    'one-shot-zero-extended',
  ]),
  sourcePeriodSamples: z.number().int().positive().max(MAX_INSTRUMENT_SEQUENCE_V1).nullable(),
  outputStartSourceSampleNumerator: z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/),
  outputStartSourceSampleDenominator: z.string().regex(/^[1-9][0-9]{0,39}$/),
  sourceSampleRateHz: sampleRateHzSchema,
  outputSampleRateHz: sampleRateHzSchema,
  sourceCarrierOffsetHz: z.number().int()
    .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1),
  outputCarrierOffsetHz: z.number().int()
    .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1),
  outputSampleCount: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1),
  sourceSamplesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputSamplesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  operations: boundedReadonlyArray(signalLabIqTransformOperationSchema, 3),
}).strict().superRefine((receipt, context) => {
  if ((receipt.sourceBoundaryPolicy === 'cyclic-modular')
    !== (receipt.sourcePeriodSamples !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['sourcePeriodSamples'],
      message: 'Only cyclic modular sources declare a native period',
    });
  }
  if (receipt.sourceBoundaryPolicy === 'continuous-session-origin-zero-extended'
    && receipt.sourceArtifactSha256 !== null) {
    context.addIssue({
      code: 'custom',
      path: ['sourceArtifactSha256'],
      message: 'Continuous generated sources do not identify a canonical artifact',
    });
  }
  if (receipt.sourceBoundaryPolicy !== 'continuous-session-origin-zero-extended'
    && receipt.sourceArtifactSha256 === null) {
    context.addIssue({
      code: 'custom',
      path: ['sourceArtifactSha256'],
      message: 'Cyclic and one-shot source windows require a canonical artifact identity',
    });
  }
  const startNumerator = BigInt(receipt.outputStartSourceSampleNumerator);
  const startDenominator = BigInt(receipt.outputStartSourceSampleDenominator);
  if (greatestCommonDivisor(startNumerator, startDenominator) !== 1n) {
    context.addIssue({
      code: 'custom',
      path: ['outputStartSourceSampleNumerator'],
      message: 'Output-start native coordinate must be a reduced rational',
    });
  }
  const integerStart = startNumerator / startDenominator;
  if (integerStart < BigInt(receipt.sourceStartSample)
    || integerStart >= BigInt(receipt.sourceStartSample) + BigInt(receipt.sourceSampleCount)) {
    context.addIssue({
      code: 'custom',
      path: ['sourceStartSample'],
      message: 'Native FIR/source support window must contain output sample zero',
    });
  }
  const resamples = receipt.operations.filter((operation) => operation.kind === 'resample');
  if ((receipt.sourceSampleRateHz !== receipt.outputSampleRateHz) !== (resamples.length === 1)) {
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'Exactly one resample operation is required if and only if sample rates differ',
    });
  }
  if (resamples.length > 1) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'At most one resampling operation is permitted' });
  }
  const resample = resamples[0];
  if (resample && (resample.sourceSampleRateHz !== receipt.sourceSampleRateHz
    || resample.outputSampleRateHz !== receipt.outputSampleRateHz)) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'Resampling operation must match receipt rate geometry' });
  }
  if (resample !== undefined) {
    const expectedCutoffHz = receipt.outputSampleRateHz < receipt.sourceSampleRateHz
      ? 0.5 * receipt.outputSampleRateHz * 0.95
      : 0.5 * receipt.sourceSampleRateHz;
    if (!nearlyEqual(resample.antiAliasCutoffHz, expectedCutoffHz)) {
      context.addIssue({
        code: 'custom',
        path: ['operations'],
        message: 'Resample cutoff must preserve source Nyquist unless downsampling, where it must be 95% of output Nyquist',
      });
    }
  }
  const fractionalDelays = receipt.operations.filter((operation) => operation.kind === 'fractional-delay');
  if (fractionalDelays.length > 1) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'At most one fractional-delay operation is permitted' });
  }
  const fractionalDelay = fractionalDelays[0];
  const phaseNumerator = startNumerator % startDenominator;
  if (fractionalDelay !== undefined && (
    receipt.sourceSampleRateHz !== receipt.outputSampleRateHz
    || fractionalDelay.sampleRateHz !== receipt.sourceSampleRateHz
    || BigInt(fractionalDelay.phaseNumerator) !== phaseNumerator
    || BigInt(fractionalDelay.phaseDenominator) !== startDenominator
    || !nearlyEqual(fractionalDelay.antiAliasCutoffHz, receipt.sourceSampleRateHz / 2)
  )) {
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'Fractional delay is only valid at one unchanged receipt sample rate',
    });
  }
  if (receipt.sourceSampleRateHz === receipt.outputSampleRateHz
    && ((phaseNumerator !== 0n) !== (fractionalDelays.length === 1))) {
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'At an unchanged sample rate, fractional delay is required if and only if output starts at fractional native phase',
    });
  }
  const firOperation = resample ?? fractionalDelay;
  if (firOperation === undefined) {
    if (phaseNumerator !== 0n
      || BigInt(receipt.sourceStartSample) !== integerStart
      || receipt.sourceSampleCount !== receipt.outputSampleCount) {
      context.addIssue({
        code: 'custom',
        path: ['sourceStartSample'],
        message: 'Without resampling, source support must exactly equal the integer-aligned output window',
      });
    }
  } else {
    const cutoffHz = firOperation.antiAliasCutoffHz;
    const radius = Math.ceil(
      16 / (2 * (cutoffHz / receipt.sourceSampleRateHz)),
    );
    const requiredStart = integerStart - BigInt(radius);
    const lastNumerator =
      startNumerator * BigInt(receipt.outputSampleRateHz)
      + BigInt(receipt.outputSampleCount - 1)
        * BigInt(receipt.sourceSampleRateHz)
        * startDenominator;
    const lastDenominator =
      startDenominator * BigInt(receipt.outputSampleRateHz);
    const requiredEnd = (
      lastNumerator + lastDenominator - 1n
    ) / lastDenominator + BigInt(radius);
    const requiredCount = requiredEnd - requiredStart + 1n;
    if (BigInt(receipt.sourceStartSample) !== requiredStart
      || BigInt(receipt.sourceSampleCount) !== requiredCount) {
      context.addIssue({
        code: 'custom',
        path: ['sourceSampleCount'],
        message: 'FIR source support must exactly equal the deterministic full output support window',
      });
    }
  }
  const translations = receipt.operations.filter((operation) => operation.kind === 'frequency-translate');
  if ((receipt.sourceCarrierOffsetHz !== receipt.outputCarrierOffsetHz)
    !== (translations.length === 1)) {
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'Exactly one frequency translation is required if and only if carrier offsets differ',
    });
  }
  const translation = translations[0];
  if (translation !== undefined && (
    translation.sourceCarrierOffsetHz !== receipt.sourceCarrierOffsetHz
    || translation.outputCarrierOffsetHz !== receipt.outputCarrierOffsetHz
  )) {
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'Frequency-translation offsets must match the receipt',
    });
  }
});
export type SignalLabIqTransformReceipt = z.infer<typeof signalLabIqTransformReceiptSchema>;

export const complexIqMeasurementSchema = z.object({
  ...measurementBaseShape,
  kind: z.literal('complex-iq'),
  qualification: instrumentMeasurementQualificationSchema,
  centerHz: frequencyHzSchema,
  sampleRateHz: sampleRateHzSchema,
  bandwidthHz: sampleRateHzSchema,
  sampleFormat: complexIqSampleFormatSchema,
  sampleCount: z.number().int().positive().max(MAX_COMPLEX_IQ_SAMPLES_V1),
  samples: compactUint8ArraySchema(MAX_COMPLEX_IQ_BYTES_V1),
  /** v2 SignalLab-only evidence; omitted by v1 and hardware drivers. */
  profileReferenceCenterHz: frequencyHzSchema.optional(),
  rfReferenceCenterHz: frequencyHzSchema.optional(),
  nativeCarrierOffsetHz: z.number().int()
    .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1).optional(),
  rfPlacement: z.enum(['profile-reference', 'operator-translated']).optional(),
  outputCarrierOffsetHz: z.number().int()
    .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1).max(MAX_INSTRUMENT_FREQUENCY_HZ_V1).optional(),
  rfTuneCenterHz: frequencyHzSchema.optional(),
  signalBandwidthHz: sampleRateHzSchema.optional(),
  nativeSampleRateHz: sampleRateHzSchema.optional(),
  payloadKind: z.enum([
    'native-canonical',
    'derived-hardware-ready',
    'generated-at-output-rate',
    'receiver-impaired-derived',
  ]).optional(),
  canonicalArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  transformReceipt: signalLabIqTransformReceiptSchema.optional(),
  representation: z.enum([
    'normalized-complex-envelope',
    'source-preserved-complex-envelope',
    'derived-complex-envelope',
  ]).optional(),
  normalization: z.enum(['unit-peak', 'none', 'peak-to-0.98']).optional(),
  receiverImpairment: signalLabReceiverImpairmentPresetSchema.optional(),
  channelApplication: z.enum(['not-applied', 'receiver-impairment-preset']).optional(),
}).strict().superRefine((measurement, context) => {
  if (measurement.bandwidthHz > measurement.sampleRateHz) {
    context.addIssue({ code: 'custom', path: ['bandwidthHz'], message: 'Complex-I/Q bandwidth cannot exceed its sample rate' });
  }
  if (!Number.isSafeInteger(measurement.sampleCount)
    || measurement.sampleCount < 1
    || measurement.sampleCount > MAX_COMPLEX_IQ_SAMPLES_V1) return;
  const expectedByteLength = complexIqPayloadByteLength(measurement.sampleCount, measurement.sampleFormat);
  if (measurement.samples.byteLength !== expectedByteLength) {
    context.addIssue({
      code: 'custom',
      path: ['samples'],
      message: `${measurement.sampleFormat} requires exactly ${expectedByteLength} bytes for ${measurement.sampleCount} complex samples`,
    });
  }
  const semanticKeys = [
    'profileReferenceCenterHz',
    'rfReferenceCenterHz',
    'nativeCarrierOffsetHz',
    'rfPlacement',
    'outputCarrierOffsetHz',
    'rfTuneCenterHz',
    'signalBandwidthHz',
    'nativeSampleRateHz',
    'payloadKind',
    'canonicalArtifactSha256',
    'transformReceipt',
    'representation',
    'normalization',
    'receiverImpairment',
    'channelApplication',
  ] as const;
  const semanticCount = semanticKeys.filter((key) => measurement[key] !== undefined).length;
  if (semanticCount !== 0 && semanticCount !== semanticKeys.length) {
    context.addIssue({
      code: 'custom',
      path: ['payloadKind'],
      message: 'SignalLab v2 I/Q semantics must be present atomically',
    });
    return;
  }
  if (semanticCount === 0) return;
  if ((measurement.centerHz === measurement.profileReferenceCenterHz)
    !== (measurement.rfPlacement === 'profile-reference')) {
    context.addIssue({
      code: 'custom',
      path: ['rfPlacement'],
      message: 'RF placement must distinguish the profile reference from operator translation',
    });
  }
  if (measurement.rfReferenceCenterHz! + measurement.nativeCarrierOffsetHz!
    !== measurement.profileReferenceCenterHz) {
    context.addIssue({
      code: 'custom',
      path: ['rfReferenceCenterHz'],
      message: 'Native RF reference plus native carrier offset must equal the profile signal center',
    });
  }
  if (measurement.rfTuneCenterHz! + measurement.outputCarrierOffsetHz! !== measurement.centerHz) {
    context.addIssue({
      code: 'custom',
      path: ['rfTuneCenterHz'],
      message: 'RF tune center plus complex-envelope carrier offset must equal the requested signal center',
    });
  }
  const impaired = measurement.receiverImpairment !== 'clean';
  if (impaired !== (measurement.channelApplication === 'receiver-impairment-preset')
    || impaired !== (measurement.qualification === 'receiver-impaired-complex-baseband')) {
    context.addIssue({
      code: 'custom',
      path: ['qualification'],
      message: 'Every receiver-impaired result must be downgraded and every clean result must declare no channel application',
    });
  }
  if (impaired && (measurement.payloadKind !== 'receiver-impaired-derived'
    || !measurement.transformReceipt!.operations.some((operation) => operation.kind === 'receiver-impairment'))) {
    context.addIssue({
      code: 'custom',
      path: ['payloadKind'],
      message: 'Receiver-impaired payloads require an explicit impairment operation',
    });
  }
  if (measurement.transformReceipt!.outputSampleRateHz !== measurement.sampleRateHz) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt', 'outputSampleRateHz'],
      message: 'Transform receipt output rate must match the delivered I/Q rate',
    });
  }
  if (measurement.transformReceipt!.outputSampleCount !== measurement.sampleCount
    || measurement.transformReceipt!.sourceSampleRateHz !== measurement.nativeSampleRateHz) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt'],
      message: 'Transform receipt output count and native rate must match the delivered I/Q geometry',
    });
  }
  if (measurement.transformReceipt!.sourceArtifactSha256 !== measurement.canonicalArtifactSha256) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt', 'sourceArtifactSha256'],
      message: 'Receipt source artifact hash must equal the measurement canonical artifact hash',
    });
  }
  if (measurement.transformReceipt!.sourceCarrierOffsetHz !== measurement.nativeCarrierOffsetHz
    || measurement.transformReceipt!.outputCarrierOffsetHz !== measurement.outputCarrierOffsetHz) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt'],
      message: 'Receipt carrier offsets must match the measurement carrier offsets',
    });
  }
  const operations = measurement.transformReceipt!.operations;
  const impairmentOperations = operations.filter((operation) => operation.kind === 'receiver-impairment');
  if (impaired !== (impairmentOperations.length === 1)) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt', 'operations'],
      message: 'Exactly one receiver-impairment operation is required if and only if the result is impaired',
    });
  }
  if (impairmentOperations[0] !== undefined
    && impairmentOperations[0].preset !== measurement.receiverImpairment) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt', 'operations'],
      message: 'Receiver-impairment operation preset must match the measurement',
    });
  }
  const derived = measurement.payloadKind === 'derived-hardware-ready';
  const transportTransformed = operations.some((operation) =>
    operation.kind === 'resample'
    || operation.kind === 'fractional-delay'
    || operation.kind === 'frequency-translate');
  if (!impaired && derived !== transportTransformed
    && measurement.payloadKind !== 'generated-at-output-rate') {
    context.addIssue({
      code: 'custom',
      path: ['payloadKind'],
      message: 'Derived payloads require an explicit transport operation and native payloads require an empty receipt',
    });
  }
  if (measurement.payloadKind === 'native-canonical' && (
    operations.length !== 0
    || measurement.transformReceipt!.sourceSamplesSha256 !== measurement.transformReceipt!.outputSamplesSha256
    || measurement.nativeCarrierOffsetHz !== measurement.outputCarrierOffsetHz
  )) {
    context.addIssue({
      code: 'custom',
      path: ['payloadKind'],
      message: 'Native-canonical payloads require identical source/output bytes, offsets, and no operations',
    });
  }
  if (measurement.payloadKind === 'generated-at-output-rate' && (
    measurement.canonicalArtifactSha256 !== null
    || measurement.nativeSampleRateHz !== measurement.sampleRateHz
    || operations.some((operation) => operation.kind !== 'fractional-delay')
  )) {
    context.addIssue({
      code: 'custom',
      path: ['payloadKind'],
      message: 'Generated-at-output-rate payloads have no canonical artifact and permit only an explicit same-rate fractional delay',
    });
  }
  const operationKinds = operations.map((operation) => operation.kind);
  const translationIndex = operationKinds.indexOf('frequency-translate');
  const resampleIndex = operationKinds.findIndex((kind) =>
    kind === 'resample' || kind === 'fractional-delay');
  if (translationIndex >= 0 && resampleIndex >= 0 && translationIndex > resampleIndex) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt', 'operations'],
      message: 'Frequency translation must precede resampling',
    });
  }
  const impairmentIndex = operationKinds.indexOf('receiver-impairment');
  if (impairmentIndex >= 0 && impairmentIndex !== operationKinds.length - 1) {
    context.addIssue({
      code: 'custom',
      path: ['transformReceipt', 'operations'],
      message: 'Receiver impairment must be the final transform operation',
    });
  }
  if ((measurement.payloadKind === 'receiver-impaired-derived') !== impaired) {
    context.addIssue({
      code: 'custom',
      path: ['payloadKind'],
      message: 'Receiver-impaired bytes must use the receiver-impaired-derived payload kind exclusively',
    });
  }
  if (!impaired && measurement.qualification === 'independently-verified-digital-baseband'
    && (derived
      || measurement.sampleRateHz !== measurement.nativeSampleRateHz
      || measurement.payloadKind !== 'native-canonical'
      || measurement.transformReceipt!.operations.length !== 0
      || measurement.representation !== 'source-preserved-complex-envelope'
      || measurement.normalization !== 'none')) {
    context.addIssue({
      code: 'custom',
      path: ['qualification'],
      message: 'Independent digital-baseband qualification requires clean source-preserved native-rate bytes',
    });
  }
  // A derived result needs an explicit transport transform, but a bare
  // frequency translation is one of them: capture bandwidth narrower than the
  // native offset span produces new bytes at the native rate with no resampling
  // at all. Requiring resample/fractional-delay here would reject that lane.
  if (!impaired && measurement.qualification === 'derived-from-independently-verified-digital-baseband'
    && (!derived
      || measurement.canonicalArtifactSha256 === null
      || !transportTransformed
      || measurement.representation !== 'derived-complex-envelope'
      || measurement.normalization !== 'none')) {
    context.addIssue({
      code: 'custom',
      path: ['qualification'],
      message: 'Derived digital-baseband qualification requires a canonical artifact and explicit transform',
    });
  }
});
export const instrumentMeasurementSchema = z.discriminatedUnion('kind', [
  sweptSpectrumMeasurementSchema,
  detectedPowerTimeseriesMeasurementSchema,
  complexIqMeasurementSchema,
]).superRefine((measurement, context) => {
  const receipt = measurement.receiveOnlySafetyReceipt;
  if (!receipt) return;
  if (receipt.sessionId !== measurement.sessionId) {
    context.addIssue({
      code: 'custom',
      path: ['receiveOnlySafetyReceipt', 'sessionId'],
      message: 'Measurement safety receipt must belong to the measurement session',
    });
  }
  if (measurement.kind === 'complex-iq' || measurement.qualification !== 'device-observed') {
    context.addIssue({
      code: 'custom',
      path: ['receiveOnlySafetyReceipt'],
      message: 'Receive-only safety receipts qualify only physical scalar device observations',
    });
  }
});
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
  receiveOnlySafety: instrumentReceiveOnlySafetyStateSchema.optional(),
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
        const feature = session.capabilities.features.find(
          (candidate) => candidate.kind === 'signal-lab-profile-selection',
        );
        if (feature?.kind === 'signal-lab-profile-selection') {
          if (feature.iqProfiles === undefined) {
            context.addIssue({
              code: 'custom',
              path: ['capabilities', 'features', 0, 'iqProfiles'],
              message: 'Measurement-bridge v2 requires per-profile I/Q transports',
            });
          }
          for (const [profileIndex, profile] of feature.profiles.entries()) {
            if (!('label' in profile)) {
              context.addIssue({
                code: 'custom',
                path: ['capabilities', 'features', 0, 'profiles', profileIndex],
                message: 'Measurement-bridge v2 requires complete governed waveform descriptors',
              });
            }
          }
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
  if (session.receiveOnlySafety) {
    if (session.provenance.sourceKind !== 'serial-port' || session.provenance.execution !== 'physical') {
      context.addIssue({
        code: 'custom',
        path: ['receiveOnlySafety'],
        message: 'Receive-only safety receipts require a physical serial-port session',
      });
    }
    if (session.rfOutput !== 'not-supported') {
      context.addIssue({
        code: 'custom',
        path: ['receiveOnlySafety'],
        message: 'Receive-only safety state is separate from sessions that advertise RF-generator output control',
      });
    }
    if (session.receiveOnlySafety.connectionReceipt.sessionId !== session.sessionId
      || session.receiveOnlySafety.currentReceipt.sessionId !== session.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['receiveOnlySafety'],
        message: 'Receive-only safety receipts must belong to the enclosing session',
      });
    }
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
    reason: z.enum(['source-profile-changed', 'source-channel-changed', 'instrument-mode-changed']),
    session: instrumentSessionSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal('session-state'),
    reason: z.enum(['rf-output-changed', 'receive-only-safety-advanced', 'session-faulted']),
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
