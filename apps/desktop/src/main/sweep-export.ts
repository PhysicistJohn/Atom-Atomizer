import {
  MAX_SWEEP_EXPORT_BYTES_V1,
  instrumentTimestampSchema,
  sweepExportSweepSchema,
  type DeviceIdentity,
  type InstrumentMeasurementIdentity,
  type InstrumentSessionProvenance,
  type Sweep,
} from '@tinysa/contracts';

export function serializeSweep(sweep: Sweep, format: 'csv' | 'json'): string {
  const admitted = sweepExportSweepSchema.parse(sweep);
  if (format === 'json') return requireBoundedOutput(`${JSON.stringify(admitted, null, 2)}\n`);

  const relativePower = admitted.powerReference === 'uncalibrated-dbfs-relative';
  const header = [
    'frequency_hz',
    relativePower ? 'power_dbfs_relative' : 'power_dbm',
    'sweep_id',
    'captured_at',
    'device_model',
    'firmware_version',
    'simulated',
    'driver_id',
    'candidate_id',
    'session_id',
    'source_kind',
    'source',
    'actual_rbw_hz',
    'rbw_qualification',
    'actual_attenuation_db',
    'attenuation_qualification',
    'requested_configuration_json',
    'identity_json',
    'power_reference',
  ];
  const identity = exportIdentity(admitted);
  const metadata = [
    admitted.id,
    admitted.capturedAt,
    identity.deviceModel,
    identity.firmwareVersion,
    identity.simulated,
    identity.driverId,
    identity.candidateId,
    identity.sessionId,
    identity.sourceKind,
    admitted.source,
    admitted.actualRbwHz,
    admitted.resolutionBandwidthQualification ?? 'legacy-unspecified',
    admitted.actualAttenuationDb,
    admitted.attenuationQualification ?? 'legacy-unspecified',
    JSON.stringify(admitted.requested),
    JSON.stringify(admitted.identity),
    admitted.powerReference ?? 'calibrated-dbm',
  ];
  const lines = [header.map(csvCell).join(',')];
  let bytes = utf8ByteLength(lines[0]!) + 1;
  for (let index = 0; index < admitted.frequencyHz.length; index++) {
    const line = [admitted.frequencyHz[index], admitted.powerDbm[index], ...metadata].map(csvCell).join(',');
    bytes += utf8ByteLength(line) + 1;
    if (bytes > MAX_SWEEP_EXPORT_BYTES_V1) throw exportSizeError(bytes);
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

function exportIdentity(sweep: Sweep): {
  deviceModel: string;
  firmwareVersion: string;
  simulated: boolean;
  driverId: string;
  candidateId: string;
  sessionId: string;
  sourceKind: string;
} {
  const identity = sweep.identity;
  if ((identity as { kind?: unknown }).kind === 'instrument-session') {
    const genericIdentity = identity as InstrumentMeasurementIdentity;
    const provenance = genericIdentity.provenance;
    const device = provenanceDeviceEvidence(provenance);
    return {
      deviceModel: device.model,
      firmwareVersion: device.firmwareVersion,
      simulated: provenance.execution !== 'physical',
      driverId: genericIdentity.driverId,
      candidateId: genericIdentity.candidateId,
      sessionId: genericIdentity.sessionId,
      sourceKind: provenance.sourceKind,
    };
  }
  const deviceIdentity = identity as DeviceIdentity;
  return {
    deviceModel: deviceIdentity.model,
    firmwareVersion: deviceIdentity.firmwareVersion,
    simulated: deviceIdentity.simulated,
    driverId: '',
    candidateId: deviceIdentity.port.id,
    sessionId: '',
    sourceKind: deviceIdentity.execution,
  };
}

/**
 * Text sweep exports have no truthful device evidence for provenance kinds
 * without a `device` object (SignalLab is synthetic; Neptune P210 exports are
 * host-derived I/Q projections rather than device scalar readback). Exhaustive
 * over InstrumentSessionProvenance so a future source kind fails to compile
 * here rather than silently defaulting.
 */
function provenanceDeviceEvidence(provenance: InstrumentSessionProvenance): { model: string; firmwareVersion: string } {
  switch (provenance.sourceKind) {
    case 'serial-port':
    case 'tinysa-firmware-twin':
      return { model: provenance.device.model, firmwareVersion: provenance.device.firmwareVersion };
    case 'signal-lab':
    case 'neptune-p210':
    case 'neptune-p210-twin':
      return { model: '', firmwareVersion: '' };
    default: {
      const unhandled: never = provenance;
      throw new Error(`Sweep export device evidence is undefined for ${JSON.stringify(unhandled)}`);
    }
  }
}

export function defaultSweepFilename(sweep: Sweep, format: 'csv' | 'json'): string {
  const timestamp = instrumentTimestampSchema.parse(sweep.capturedAt).replace(/[:.]/g, '-');
  return `atomizer-${timestamp}.${format}`;
}

function requireBoundedOutput(content: string): string {
  const bytes = utf8ByteLength(content);
  if (bytes > MAX_SWEEP_EXPORT_BYTES_V1) throw exportSizeError(bytes);
  return content;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exportSizeError(bytes: number): RangeError {
  return new RangeError(`Sweep export is ${bytes} bytes; contract v1 permits at most ${MAX_SWEEP_EXPORT_BYTES_V1} bytes`);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  // Device and driver metadata is untrusted text. Keep spreadsheet programs
  // from interpreting it as a formula while leaving numeric samples numeric.
  const text = typeof value === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
