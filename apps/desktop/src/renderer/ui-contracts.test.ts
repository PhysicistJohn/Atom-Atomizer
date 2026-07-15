import { describe, expect, it } from 'vitest';
import { assertWorkspaceTransition, DEFAULT_ANALYZER, DEFAULT_GENERATOR, INITIAL_INSTRUMENT_STATE, instrumentCandidateUiKey, selectedCandidate, type DesktopUiState } from './ui-contracts.js';

describe('UI safety and selection contracts', () => {
  it('blocks leaving Generator unless RF output is known off', () => {
    expect(() => assertWorkspaceTransition('generator', 'spectrum', 'on')).toThrow(/Disable RF output/);
    expect(() => assertWorkspaceTransition('generator', 'spectrum', 'unknown')).toThrow(/state is unknown/);
    expect(() => assertWorkspaceTransition('generator', 'spectrum', 'off')).not.toThrow();
    expect(() => assertWorkspaceTransition('spectrum', 'classification', 'on')).toThrow(/Disable RF output/);
  });
  it('uses the selected driver candidate without transport-specific assumptions', () => {
    const candidates = [
      { schemaVersion: 1 as const, driverId: 'signal-lab', candidateId: 'one', displayName: 'SignalLab', sourceKind: 'signal-lab' as const, signalLab: { sourceId: 'one' }, discoveryRevision: 'r1' },
      { schemaVersion: 1 as const, driverId: 'signal-lab', candidateId: 'two', displayName: 'SignalLab two', sourceKind: 'signal-lab' as const, signalLab: { sourceId: 'two' }, discoveryRevision: 'r1' },
    ];
    const state: DesktopUiState = { workspace: 'spectrum', connectionPanel: 'closed', acquisition: 'idle', instrument: INITIAL_INSTRUMENT_STATE, candidates, selectedCandidateId: instrumentCandidateUiKey(candidates[1]!), analyzer: DEFAULT_ANALYZER, generator: DEFAULT_GENERATOR };
    expect(selectedCandidate(state)?.candidateId).toBe('two');
    expect(selectedCandidate({ ...state, selectedCandidateId: 'missing' })).toBeUndefined();

    const collision = {
      schemaVersion: 1 as const, driverId: 'neptune-sdr', candidateId: 'two', displayName: 'NeptuneSDR',
      sourceKind: 'serial-port' as const, serialPort: { path: '/dev/neptune' }, discoveryRevision: 'r1',
    };
    const collisionState = {
      ...state,
      candidates: [...candidates, collision],
      selectedCandidateId: instrumentCandidateUiKey(collision),
    };
    expect(selectedCandidate(collisionState)?.driverId).toBe('neptune-sdr');
  });
});
