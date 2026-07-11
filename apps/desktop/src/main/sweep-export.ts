import type { Sweep } from '@tinysa/contracts';

export function serializeSweep(sweep: Sweep, format: 'csv' | 'json'): string {
  validateSweepForExport(sweep);
  if (format === 'json') return `${JSON.stringify(sweep, null, 2)}\n`;

  const header = [
    'frequency_hz',
    'power_dbm',
    'sweep_id',
    'captured_at',
    'device_model',
    'firmware_version',
    'simulated',
    'source',
    'actual_rbw_hz',
    'actual_attenuation_db',
  ];
  const metadata = [
    sweep.id,
    sweep.capturedAt,
    sweep.identity.model,
    sweep.identity.firmwareVersion,
    sweep.identity.simulated,
    sweep.source,
    sweep.actualRbwHz,
    sweep.actualAttenuationDb,
  ];
  const rows = sweep.frequencyHz.map((frequency, index) => [frequency, sweep.powerDbm[index], ...metadata]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

export function defaultSweepFilename(sweep: Sweep, format: 'csv' | 'json'): string {
  const timestamp = sweep.capturedAt.replace(/[:.]/g, '-');
  return `tinysa-atomizer-${timestamp}.${format}`;
}

function validateSweepForExport(sweep: Sweep): void {
  if (sweep.kind !== 'spectrum' || sweep.complete !== true) throw new Error('Only complete spectrum sweeps can be exported');
  if (!sweep.frequencyHz.length) throw new Error('Cannot export an empty sweep');
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('Cannot export a sweep with mismatched vectors');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Cannot export non-finite measurement values');
  }
}

function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
