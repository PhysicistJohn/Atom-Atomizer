import { describe, expect, it } from 'vitest';
import type { AtomizerInstrumentPreferenceState, InstrumentCandidate } from '@tinysa/contracts';
import {
  instrumentCandidateMatchesPreference,
  instrumentPreferenceSelectionForCandidate,
} from './instrument-preference.js';

const first = physicalCandidate('serial:/dev/tty.usbmodem407', '/dev/tty.usbmodem407');
const second = physicalCandidate('serial:/dev/tty.usbmodem408', '/dev/tty.usbmodem408');

describe('renderer startup preference projection', () => {
  it('projects the exact human-selected candidate tuple', () => {
    expect(instrumentPreferenceSelectionForCandidate(second)).toEqual({
      driverId: 'tinysa-zs407',
      candidateKind: 'serial-port',
      candidateId: 'serial:/dev/tty.usbmodem408',
    });
  });

  it('distinguishes two physical candidates while retaining legacy broad matching', () => {
    const exact = preference({ candidateId: first.candidateId });
    expect(instrumentCandidateMatchesPreference(first, exact)).toBe(true);
    expect(instrumentCandidateMatchesPreference(second, exact)).toBe(false);

    const legacy = preference({});
    expect(instrumentCandidateMatchesPreference(first, legacy)).toBe(true);
    expect(instrumentCandidateMatchesPreference(second, legacy)).toBe(true);
  });
});

function physicalCandidate(candidateId: string, path: string): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId: 'tinysa-zs407',
    candidateId,
    displayName: candidateId,
    sourceKind: 'serial-port',
    serialPort: { path, vendorId: '0483', productId: '5740' },
    discoveryRevision: 'discovery:1',
  };
}

function preference(fields: { candidateId?: string }): AtomizerInstrumentPreferenceState {
  return {
    source: 'persisted',
    preference: {
      schemaVersion: 1,
      driverId: 'tinysa-zs407',
      candidateKind: 'serial-port',
      ...fields,
      updatedAt: '2026-07-14T20:00:00.000Z',
    },
  };
}
