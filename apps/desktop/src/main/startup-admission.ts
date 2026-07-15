import type {
  InstrumentCandidate,
  InstrumentDiscoveryResult,
} from '@tinysa/contracts';
import type { InstrumentPreference } from './instrument-preference.js';

export class PreferredInstrumentAdmissionError extends Error {
  override readonly name = 'PreferredInstrumentAdmissionError';
}

/**
 * Selects only the configured driver from one completed discovery generation.
 * A missing, failed, or ambiguous preferred driver is visible and never falls
 * through to a different instrument backend.
 */
export function selectPreferredInstrument(
  discovery: InstrumentDiscoveryResult,
  preference: InstrumentPreference,
): InstrumentCandidate {
  const driverFailure = discovery.failures.find((failure) => failure.driverId === preference.driverId
    && (preference.candidateKind === undefined || failure.sourceKind === undefined || failure.sourceKind === preference.candidateKind));
  if (driverFailure) {
    throw new PreferredInstrumentAdmissionError(
      `Preferred instrument driver ${preference.driverId} failed discovery: ${driverFailure.message}`,
    );
  }
  const matches = discovery.candidates.filter((candidate) => candidate.driverId === preference.driverId
    && (preference.candidateKind === undefined || candidate.sourceKind === preference.candidateKind)
    && (preference.candidateId === undefined || candidate.candidateId === preference.candidateId));
  if (matches.length === 0) {
    const kind = preference.candidateKind ? ` (${preference.candidateKind})` : '';
    const candidate = preference.candidateId ? ` candidate ${preference.candidateId}` : '';
    throw new PreferredInstrumentAdmissionError(`Preferred instrument ${preference.driverId}${kind}${candidate} is unavailable`);
  }
  if (matches.length > 1) {
    throw new PreferredInstrumentAdmissionError(
      `Preferred instrument ${preference.driverId} matched ${matches.length} candidates; select one explicitly`,
    );
  }
  return matches[0]!;
}
