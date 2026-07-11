import { describe, expect, it } from 'vitest';
import { assertWorkspaceTransition, DEFAULT_ANALYZER, DEFAULT_GENERATOR, DISCONNECTED_SNAPSHOT, selectedPort, type DesktopUiState } from './ui-contracts.js';

describe('UI safety and selection contracts', () => {
  it('blocks leaving Generator while RF output is on', () => {
    expect(() => assertWorkspaceTransition('generator', 'spectrum', 'on')).toThrow(/Disable RF output/);
    expect(() => assertWorkspaceTransition('generator', 'spectrum', 'off')).not.toThrow();
  });
  it('uses the selected port and falls back deterministically', () => {
    const state: DesktopUiState = { workspace:'spectrum',connectionPanel:'closed',acquisition:'idle',snapshot:DISCONNECTED_SNAPSHOT,ports:[{ id:'one',path:'one' },{ id:'two',path:'two' }],selectedPortId:'two',analyzer:DEFAULT_ANALYZER,generator:DEFAULT_GENERATOR };
    expect(selectedPort(state)?.id).toBe('two');
    expect(selectedPort({ ...state, selectedPortId:'missing' })).toBeUndefined();
  });
});
