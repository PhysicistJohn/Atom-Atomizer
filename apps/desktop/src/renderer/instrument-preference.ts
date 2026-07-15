import {
  atomizerInstrumentPreferenceSelectionSchema,
  type AtomizerInstrumentPreferenceSelection,
  type AtomizerInstrumentPreferenceState,
  type InstrumentCandidate,
} from '@tinysa/contracts';

/** Converts one human-selected discovery candidate into an exact persisted selector. */
export function instrumentPreferenceSelectionForCandidate(
  candidate: InstrumentCandidate,
): AtomizerInstrumentPreferenceSelection {
  return atomizerInstrumentPreferenceSelectionSchema.parse({
    driverId: candidate.driverId,
    candidateKind: candidate.sourceKind,
    candidateId: candidate.candidateId,
  });
}

/** Legacy v1 preferences remain broad; newly persisted preferences bind the exact tuple. */
export function instrumentCandidateMatchesPreference(
  candidate: InstrumentCandidate,
  state: AtomizerInstrumentPreferenceState | undefined,
): boolean {
  const preference = state?.preference;
  return preference !== undefined
    && preference.driverId === candidate.driverId
    && (preference.candidateKind === undefined || preference.candidateKind === candidate.sourceKind)
    && (preference.candidateId === undefined || preference.candidateId === candidate.candidateId);
}
