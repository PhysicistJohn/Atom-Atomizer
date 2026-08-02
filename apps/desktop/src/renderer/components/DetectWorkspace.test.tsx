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
        sampleCount={17}
        detectionConfig={DEFAULT_DETECTION}
        zeroConfig={DEFAULT_ZERO_SPAN}
      />,
    );
    expect(screen.getByText('COMPLEX I/Q · LIVE · 500 MS TREND · 17 SAMPLES')).toBeDefined();
    expect(document.querySelector('.detect-label')?.textContent).toBe('FM');
    expect(screen.getByText('Detection')).toBeDefined();
    expect(screen.getByText('Capture envelope')).toBeDefined();
    expect(document.querySelector('[data-agent-control="detection.threshold-mode"]')).not.toBeNull();
    expect(document.querySelector('[data-agent-control="classification.capture-envelope"]')).not.toBeNull();
    expect(screen.getByText(/Occupied bandwidth ≈ 12% of sample rate/i)).toBeDefined();
  });

  it('classifies only while pending and replaces a stale result with an actionable classifier issue', () => {
    const view = render(
      <DetectWorkspace
        {...baseProps}
        source="iq"
        pending
      />,
    );
    expect(screen.getByText('Classifying…')).toBeDefined();

    view.rerender(
      <DetectWorkspace
        {...baseProps}
        source="iq"
        pending={false}
        modulation={iqResult}
        classificationIssue={{
          kind: 'failure',
          message: 'Modulation classification failed: worker unavailable. Capture again.',
        }}
      />,
    );
    expect(screen.queryByText('Classifying…')).toBeNull();
    expect(screen.getByText(/worker unavailable.*Capture again/i)).toBeDefined();
    expect(document.querySelector('.detect-label')).toBeNull();
  });

  it('does not claim an occupied bandwidth when stage one gates a noise-like capture', () => {
    const stageOneRejection: ModulationClassification = {
      ...iqResult,
      modulation: 'unknown',
      family: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      topLeaf: undefined,
      bwFraction: 1,
      rejection: {
        stage: 1,
        reason: 'noise',
        score: 0.99,
        threshold: 0.5,
      },
    };
    render(
      <DetectWorkspace
        {...baseProps}
        source="iq"
        pending={false}
        modulation={stageOneRejection}
      />,
    );

    expect(screen.getByText(/Noise-like capture gated before bandwidth estimation/i)).toBeDefined();
    expect(screen.queryByText(/Occupied bandwidth ≈/i)).toBeNull();
    expect(document.querySelector('.detect-bar')).toBeNull();
  });

  it('does not claim an occupied bandwidth for an exact-zero v4 capture', () => {
    const noSignal: ModulationClassification = {
      ...iqResult,
      modulation: 'unknown',
      family: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      topLeaf: undefined,
      bwFraction: 1,
      rejection: {
        stage: 0,
        reason: 'no-signal',
      },
    };
    render(
      <DetectWorkspace
        {...baseProps}
        source="iq"
        pending={false}
        modulation={noSignal}
      />,
    );

    expect(
      screen.getByText(/Exact-zero capture rejected as no signal/i),
    ).toBeDefined();
    expect(screen.queryByText(/Occupied bandwidth ≈/i)).toBeNull();
  });
});
