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
  it('renders the advancing shared 500 ms trend without creating classifier work', () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'classification', initialAgentOpen: false });
    runtime.store.set({
      continuous: true,
      continuousMode: 'complex-iq',
      classification: {
        source: 'iq', pending: false, sampleCount: 1, result: result('dsss', 0.9), issue: undefined,
      },
    });

    render(<DetectContainer runtime={runtime}/>);
    expect(screen.getByText('COMPLEX I/Q · LIVE · 500 MS TREND · 1 SAMPLE')).toBeDefined();
    expect(document.querySelector('.detect-label')?.textContent).toBe('DSSS');

    act(() => runtime.store.set({
      classification: {
        source: 'iq', pending: false, sampleCount: 12, result: result('ofdm', 0.8), issue: undefined,
      },
    }));
    expect(screen.getByText('COMPLEX I/Q · LIVE · 500 MS TREND · 12 SAMPLES')).toBeDefined();
    expect(document.querySelector('.detect-label')?.textContent).toBe('OFDM');
  });

  it('projects an actionable global classifier failure instead of an endless busy state', () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'classification', initialAgentOpen: false });
    runtime.store.set({
      classification: {
        source: 'iq',
        pending: false,
        sampleCount: 0,
        result: undefined,
        issue: {
          kind: 'failure',
          message: 'Modulation classification failed. Capture again.',
        },
      },
    });

    render(<DetectContainer runtime={runtime}/>);
    expect(screen.queryByText('Classifying…')).toBeNull();
    expect(screen.getByText(/classification failed.*Capture again/i)).toBeDefined();
  });
});

function result(family: string, confidence: number): ModulationClassification {
  return {
    flavor: 'iq', family, modulation: family, confidence, isUnknown: false,
    candidates: [{ label: family, confidence }], bwFraction: 0.5,
  };
}
