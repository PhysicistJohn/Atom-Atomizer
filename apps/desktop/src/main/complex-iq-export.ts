import { z } from 'zod';
import {
  MAX_COMPLEX_IQ_BYTES_V1,
  complexIqMeasurementSchema,
  instrumentDriverIdSchema,
  instrumentOpaqueIdSchema,
  instrumentSessionProvenanceSchema,
  instrumentTimestampSchema,
  type ComplexIqExportCapture,
  type ComplexIqSampleFormat,
  type InstrumentMeasurement,
  type InstrumentMeasurementIdentity,
  type InstrumentSessionProvenance,
} from '@tinysa/contracts';

/**
 * Native, source-agnostic raw-I/Q export as SigMF (https://github.com/sigmf/SigMF
 * core namespace): a JSON `.sigmf-meta` sidecar plus a raw `.sigmf-data` file
 * containing the admitted samples written byte-for-byte, never transcoded.
 * This mirrors sweep-export.ts's provenance-preserving conventions
 * (requested_configuration_json / identity_json) but for any complex-iq
 * acquisition — SignalLab's synthetic captures today, Neptune P210's
 * hardware/twin captures, and any future complex-iq driver.
 */

export type ComplexIqMeasurement = Extract<InstrumentMeasurement, { kind: 'complex-iq' }>;
export type { ComplexIqExportCapture } from '@tinysa/contracts';

const complexIqExportIdentitySchema = z.object({
  kind: z.literal('instrument-session'),
  sessionId: instrumentOpaqueIdSchema,
  driverId: instrumentDriverIdSchema,
  candidateId: instrumentOpaqueIdSchema,
  provenance: instrumentSessionProvenanceSchema,
}).strict();

export const complexIqExportCaptureSchema = z.object({
  measurement: complexIqMeasurementSchema,
  identity: complexIqExportIdentitySchema,
}).strict().superRefine((capture, context) => {
  if (capture.measurement.sessionId !== capture.identity.sessionId) {
    context.addIssue({
      code: 'custom',
      path: ['identity', 'sessionId'],
      message: 'Complex-I/Q export identity session must match the measurement session',
    });
  }
}) satisfies z.ZodType<ComplexIqExportCapture>;

export interface ComplexIqSigmfExport {
  metaFilename: string;
  dataFilename: string;
  /** UTF-8 JSON text for the `.sigmf-meta` sidecar, newline-terminated. */
  meta: string;
  /** Exact interleaved wire bytes for the `.sigmf-data` file; never transcoded. */
  data: Uint8Array;
}

const SIGMF_CORE_VERSION = '1.0.0';

/** SigMF core dataset-datatype strings for every wire encoding contract v1 admits. */
const SIGMF_DATATYPE_BY_SAMPLE_FORMAT: Readonly<Record<ComplexIqSampleFormat, string>> = Object.freeze({
  cf32le: 'cf32_le',
  ci16le: 'ci16_le',
  ci8: 'ci8',
  cu8: 'cu8',
});

export function serializeComplexIqSigmf(capture: ComplexIqExportCapture): ComplexIqSigmfExport {
  const admitted = complexIqExportCaptureSchema.parse(capture);
  requireBoundedComplexIqData(admitted.measurement.samples.byteLength);
  const basename = defaultComplexIqBasename(admitted.measurement.capturedAt);
  const meta = requireBoundedMeta(`${JSON.stringify(buildSigmfMeta(admitted.measurement, admitted.identity), null, 2)}\n`);
  return {
    metaFilename: `${basename}.sigmf-meta`,
    dataFilename: `${basename}.sigmf-data`,
    meta,
    // Byte-exact, freshly-copied so a later mutation of the caller's buffer
    // can never retroactively change what was already admitted for export.
    data: admitted.measurement.samples.slice(),
  };
}

export function defaultComplexIqBasename(capturedAt: string): string {
  const timestamp = instrumentTimestampSchema.parse(capturedAt).replace(/[:.]/g, '-');
  return `atomizer-iq-${timestamp}`;
}

export function defaultComplexIqMetaFilename(capture: ComplexIqExportCapture): string {
  return `${defaultComplexIqBasename(capture.measurement.capturedAt)}.sigmf-meta`;
}

/** Derives the sibling `.sigmf-data` path from a user-chosen `.sigmf-meta` save path. */
export function deriveComplexIqDataPath(metaPath: string): string {
  return metaPath.toLowerCase().endsWith('.sigmf-meta')
    ? `${metaPath.slice(0, -'.sigmf-meta'.length)}.sigmf-data`
    : `${metaPath}.sigmf-data`;
}

function buildSigmfMeta(
  measurement: ComplexIqMeasurement,
  identity: InstrumentMeasurementIdentity,
): Record<string, unknown> {
  const provenance = identity.provenance;
  const { samples: _samples, ...measurementWithoutSamples } = measurement;
  const requestedConfiguration = {
    centerHz: measurement.centerHz,
    sampleRateHz: measurement.sampleRateHz,
    bandwidthHz: measurement.bandwidthHz,
    sampleFormat: measurement.sampleFormat,
    sampleCount: measurement.sampleCount,
  };
  const global: Record<string, unknown> = {
    'core:datatype': SIGMF_DATATYPE_BY_SAMPLE_FORMAT[measurement.sampleFormat],
    'core:version': SIGMF_CORE_VERSION,
    'core:sample_rate': measurement.sampleRateHz,
    'core:num_channels': 1,
    'core:description': `AtomOS Atomizer complex-I/Q export (${identity.driverId} / ${provenance.sourceKind})`,
    'core:recorder': 'AtomOS Atomizer',
    'core:hw': describeProvenanceHardware(provenance),
    'atomizer:schema_version': measurement.schemaVersion,
    'atomizer:driver_id': identity.driverId,
    'atomizer:candidate_id': identity.candidateId,
    'atomizer:session_id': identity.sessionId,
    'atomizer:source_kind': provenance.sourceKind,
    'atomizer:measurement_qualification': measurement.qualification,
    'atomizer:provenance_qualification': provenance.qualification,
    // Full admitted tuning/format configuration, mirroring CSV's
    // requested_configuration_json field-for-field in spirit.
    'atomizer:requested_configuration_json': JSON.stringify(requestedConfiguration),
    // The complete measurement (everything but the raw samples, which live
    // byte-exact in the paired .sigmf-data file) so the sidecar alone is
    // self-describing evidence, not just a partial projection.
    'atomizer:measurement_json': JSON.stringify(measurementWithoutSamples),
    // Full session identity/provenance, mirroring CSV's identity_json field.
    'atomizer:identity_json': JSON.stringify(identity),
  };
  // Present only when the driver supplied it (today: Neptune P210 ADC
  // evidence); this is legitimate per-source provenance, not a Neptune
  // special case baked into the export logic itself.
  if (measurement.powerReference !== undefined) global['atomizer:power_reference'] = measurement.powerReference;
  return {
    global,
    captures: [{
      'core:sample_start': 0,
      'core:frequency': measurement.centerHz,
      'core:datetime': measurement.capturedAt,
    }],
    annotations: [{
      'core:sample_start': 0,
      'core:sample_count': measurement.sampleCount,
    }],
  };
}

/** Exhaustive over InstrumentSessionProvenance so a future source kind fails to compile here. */
function describeProvenanceHardware(provenance: InstrumentSessionProvenance): string {
  switch (provenance.sourceKind) {
    case 'serial-port':
    case 'tinysa-firmware-twin':
      return `${provenance.device.model} (${provenance.device.hardwareVersion})`;
    case 'signal-lab':
      return `SignalLab synthetic source ${provenance.sourceId}`;
    case 'neptune-p210':
      return `NeptuneSDR P210 at ${provenance.endpoint}`;
    case 'neptune-p210-twin':
      return `NeptuneSDR P210 QEMU twin at ${provenance.endpoint} (${provenance.profile})`;
    default: {
      const unhandled: never = provenance;
      throw new Error(`Complex-I/Q export hardware description is undefined for ${JSON.stringify(unhandled)}`);
    }
  }
}

function requireBoundedComplexIqData(byteLength: number): void {
  // The contract schema already caps samples at MAX_COMPLEX_IQ_BYTES_V1; this
  // is a defense-in-depth restatement using the same named ceiling, matching
  // sweep-export.ts's own belt-and-suspenders bounded-output checks.
  if (byteLength > MAX_COMPLEX_IQ_BYTES_V1) throw exportSizeError(byteLength);
}

function requireBoundedMeta(meta: string): string {
  const bytes = new TextEncoder().encode(meta).byteLength;
  if (bytes > MAX_COMPLEX_IQ_BYTES_V1) throw exportSizeError(bytes);
  return meta;
}

function exportSizeError(bytes: number): RangeError {
  return new RangeError(`Complex-I/Q export is ${bytes} bytes; contract v1 permits at most ${MAX_COMPLEX_IQ_BYTES_V1} bytes`);
}
