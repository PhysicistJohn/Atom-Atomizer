import {
  MAX_SWEEP_EXPORT_BYTES_V1,
  instrumentTimestampSchema,
  sweepExportSweepSchema,
  type DeviceIdentity,
  type InstrumentMeasurementIdentity,
  type Sweep,
} from '@tinysa/contracts';

export function serializeSweep(sweep: Sweep, format: 'csv' | 'json'): string {
  const admitted = sweepExportSweepSchema.parse(sweep);
  if (format === 'json') return requireBoundedOutput(`${JSON.stringify(admitted, null, 2)}\n`);

  const header = [
    'frequency_hz',
    'power_dbm',
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
  ];
  const lines = [header.map(csvCell).join(',')];
  let bytes = Buffer.byteLength(lines[0]!) + 1;
  for (let index = 0; index < admitted.frequencyHz.length; index++) {
    const line = [admitted.frequencyHz[index], admitted.powerDbm[index], ...metadata].map(csvCell).join(',');
    bytes += Buffer.byteLength(line) + 1;
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
    return {
      deviceModel: provenance.sourceKind === 'signal-lab' ? '' : provenance.device.model,
      firmwareVersion: provenance.sourceKind === 'signal-lab' ? '' : provenance.device.firmwareVersion,
      simulated: provenance.sourceKind !== 'serial-port',
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

export function defaultSweepFilename(sweep: Sweep, format: 'csv' | 'json'): string {
  const timestamp = instrumentTimestampSchema.parse(sweep.capturedAt).replace(/[:.]/g, '-');
  return `tinysa-atomizer-${timestamp}.${format}`;
}

function requireBoundedOutput(content: string): string {
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_SWEEP_EXPORT_BYTES_V1) throw exportSizeError(bytes);
  return content;
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
