import type { Sweep } from '@tinysa/contracts';

export const FREQUENCY_AGILE_BAND_START_HZ = 2_402_000_000;
export const FREQUENCY_AGILE_BAND_STOP_HZ = 2_480_000_000;
export const FREQUENCY_AGILE_MAXIMUM_COMPONENT_BANDWIDTH_HZ = 4_000_000;

/**
 * The association is fitted only to 50 ms full-band scalar sweeps. Host delay
 * between sweeps may vary because the transition likelihood is conditioned on
 * admitted looks, but long gaps reset the recent-activity window.
 */
export const FREQUENCY_AGILE_ACQUISITION_MODEL = {
  requestedSweepTimeSeconds: 0.05,
  requestedSweepTimeToleranceSeconds: 1e-9,
  minimumCaptureGapMilliseconds: 25,
  maximumCaptureGapMilliseconds: 500,
} as const;

export function frequencyAgileSweepEligible(sweep: Sweep): boolean {
  const requestedSweepTimeSeconds = sweep.requested.sweepTimeSeconds;
  return sweep.actualStartHz <= FREQUENCY_AGILE_BAND_START_HZ
    && sweep.actualStopHz >= FREQUENCY_AGILE_BAND_STOP_HZ
    && typeof requestedSweepTimeSeconds === 'number'
    && Math.abs(requestedSweepTimeSeconds - FREQUENCY_AGILE_ACQUISITION_MODEL.requestedSweepTimeSeconds)
      <= FREQUENCY_AGILE_ACQUISITION_MODEL.requestedSweepTimeToleranceSeconds
    // Wall-clock command time includes transport and optional firmware-trace
    // reads; it is provenance, not the analyzer's configured sweep time.
    && Number.isFinite(sweep.elapsedMilliseconds)
    && sweep.elapsedMilliseconds > 0
    && Number.isFinite(Date.parse(sweep.capturedAt));
}

export function frequencyAgileSweepGeometryCompatible(previous: Sweep, candidate: Sweep): boolean {
  return frequencyAgileSweepEligible(previous)
    && frequencyAgileSweepEligible(candidate)
    && sameFrequencyGrid(previous.frequencyHz, candidate.frequencyHz)
    && previous.actualStartHz === candidate.actualStartHz
    && previous.actualStopHz === candidate.actualStopHz
    && previous.actualRbwHz === candidate.actualRbwHz
    && previous.actualAttenuationDb === candidate.actualAttenuationDb
    && previous.requested.sweepTimeSeconds === candidate.requested.sweepTimeSeconds
    && previous.requested.detector === candidate.requested.detector
    && previous.requested.lna === candidate.requested.lna
    && previous.requested.spurRejection === candidate.requested.spurRejection
    && previous.source === candidate.source
    && previous.identity.port.id === candidate.identity.port.id
    && previous.identity.firmwareVersion === candidate.identity.firmwareVersion
    && previous.identity.execution === candidate.identity.execution;
}

export function frequencyAgileStrictlyOrderedOpportunity(previous: Sweep, candidate: Sweep): boolean {
  const previousCapturedAt = Date.parse(previous.capturedAt);
  const candidateCapturedAt = Date.parse(candidate.capturedAt);
  return candidate.id !== previous.id
    && candidate.sequence > previous.sequence
    && Number.isFinite(previousCapturedAt)
    && Number.isFinite(candidateCapturedAt)
    && candidateCapturedAt > previousCapturedAt;
}

export function frequencyAgileSequentialOpportunity(previous: Sweep, candidate: Sweep): boolean {
  const captureGapMilliseconds = Date.parse(candidate.capturedAt) - Date.parse(previous.capturedAt);
  return frequencyAgileStrictlyOrderedOpportunity(previous, candidate)
    && candidate.sequence === previous.sequence + 1
    && captureGapMilliseconds >= FREQUENCY_AGILE_ACQUISITION_MODEL.minimumCaptureGapMilliseconds
    && captureGapMilliseconds <= FREQUENCY_AGILE_ACQUISITION_MODEL.maximumCaptureGapMilliseconds;
}

export function frequencyAgileGeometryId(sweep: Sweep): string {
  const firstHz = sweep.frequencyHz[0]!;
  const lastHz = sweep.frequencyHz.at(-1)!;
  return [
    'full-2g4-scalar-v2',
    firstHz,
    lastHz,
    sweep.frequencyHz.length,
    frequencyGridChecksum(sweep.frequencyHz),
    sweep.actualStartHz,
    sweep.actualStopHz,
    sweep.actualRbwHz,
    sweep.actualAttenuationDb,
    sweep.requested.sweepTimeSeconds,
    sweep.requested.detector,
    sweep.requested.lna,
    sweep.requested.spurRejection,
    sweep.source,
    sweep.identity.port.id,
    sweep.identity.firmwareVersion,
    sweep.identity.execution,
  ].join(':');
}

function sameFrequencyGrid(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((frequency, index) => frequency === right[index]);
}

function frequencyGridChecksum(frequencyHz: readonly number[]): string {
  // Two independent 32-bit accumulators make accidental geometry aliasing
  // conspicuous; scientific validation still compares every grid point.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const frequency of frequencyHz) {
    const token = Number.isInteger(frequency) ? String(frequency) : frequency.toPrecision(17);
    for (let index = 0; index < token.length; index++) {
      const code = token.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second + code + 0x7ed55d16, 0x85ebca6b) >>> 0;
    }
    first = Math.imul(first ^ 0xff, 0x01000193) >>> 0;
    second = Math.imul(second ^ 0xa5, 0xc2b2ae35) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
