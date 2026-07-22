// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetectWorkspace } from './DetectWorkspace.js';
import { DEFAULT_DETECTION, DEFAULT_ZERO_SPAN } from '../store.js';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';

afterEach(cleanup);

const iqResult: ModulationClassification = {
  flavor: 'iq', modulation: 'fm', family: 'fm', confidence: 0.93, isUnknown: false,
  candidates: [{ label: 'fm', confidence: 0.93 }, { label: 'am', confidence: 0.05 }],
  bwFraction: 0.12, topLeaf: { label: 'fm-broadcast', probability: 0.71 },
};

const baseProps = {
  detectorBusy: false,
  onDetectionConfig: vi.fn(),
  busy: false,
  onAcquireZero: vi.fn(),
};

describe('DetectWorkspace', () => {
  it('does not crash when the detector/zero-span config is momentarily undefined (SSR / pre-hydration)', () => {
    // The web app builds the initial store in a useState initializer that also
    // runs during SSR, where localStorage-backed config can be undefined. The
    // detector settings + capture strip must be guarded, not rendered blindly.
    expect(() => render(
      <DetectWorkspace {...baseProps} source="none" pending={false} detectionConfig={undefined} zeroConfig={undefined} />,
    )).not.toThrow();
    expect(screen.getByText(/Acquire a complex-I\/Q buffer/i)).toBeDefined();
    expect(screen.queryByText('Detection')).toBeNull();
  });

  it('renders the classification result and the re-homed detector settings + capture control', () => {
    render(
      <DetectWorkspace
        {...baseProps}
        source="iq"
        pending={false}
        modulation={iqResult}
        live
        evidenceLooks={7}
        detectionConfig={DEFAULT_DETECTION}
        zeroConfig={DEFAULT_ZERO_SPAN}
      />,
    );
    expect(screen.getByText('COMPLEX I/Q · LIVE 7 LOOKS')).toBeDefined();
    expect(document.querySelector('.detect-label')?.textContent).toBe('FM');
    expect(screen.getByText('Detection')).toBeDefined();
    expect(screen.getByText('Capture envelope')).toBeDefined();
    expect(document.querySelector('[data-agent-control="detection.threshold-mode"]')).not.toBeNull();
    expect(document.querySelector('[data-agent-control="classification.capture-envelope"]')).not.toBeNull();
  });
});
