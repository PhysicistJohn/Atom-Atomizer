// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import { createRendererRuntime } from '../AppShell.js';
import { DetectContainer } from './DetectContainer.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('DetectContainer global analysis view', () => {
  it('renders advancing shared FIFO state without creating classifier work', () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'classification', initialAgentOpen: false });
    runtime.store.set({
      continuous: true,
      continuousMode: 'complex-iq',
      classification: { source: 'iq', pending: false, evidenceLooks: 1, result: result('dsss', 0.9) },
    });

    render(<DetectContainer runtime={runtime}/>);
    expect(screen.getByText('COMPLEX I/Q · LIVE 1 LOOK')).toBeDefined();
    expect(document.querySelector('.detect-label')?.textContent).toBe('DSSS');

    act(() => runtime.store.set({
      classification: { source: 'iq', pending: false, evidenceLooks: 2, result: result('ofdm', 0.8) },
    }));
    expect(screen.getByText('COMPLEX I/Q · LIVE 2 LOOKS')).toBeDefined();
    expect(document.querySelector('.detect-label')?.textContent).toBe('OFDM');
  });
});

function result(family: string, confidence: number): ModulationClassification {
  return {
    flavor: 'iq', family, modulation: family, confidence, isUnknown: false,
    candidates: [{ label: family, confidence }], bwFraction: 0.5,
  };
}
