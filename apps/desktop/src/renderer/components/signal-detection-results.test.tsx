// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DetectedSignal, SignalDetectionConfig, Sweep } from '@tinysa/contracts';
import { SignalDetectionResults } from './DetectorControls.js';

const config: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};

const sweep = {
  powerReference: 'uncalibrated-dbfs-relative',
} as Sweep;

const candidate = {
  id: 'signal-0001',
  peakHz: 98_096_000,
  peakDbm: -27.5,
  bandwidthHz: 930_000,
  prominenceDb: 74.5,
  persistenceSweeps: 1,
  missedSweeps: 0,
  state: 'candidate',
} as DetectedSignal;

describe('SignalDetectionResults', () => {
  it('shows the first valid detector look as a candidate with promotion guidance', () => {
    render(<SignalDetectionResults sweep={sweep} detections={[candidate]} config={config}/>);

    expect(screen.getByRole('region', { name: 'Detected signal regions' }).getAttribute('aria-live')).toBeNull();
    expect(screen.getByText('0 tracked · 1 candidate').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('CANDIDATE')).toBeTruthy();
    expect(screen.getByText('1 / 2 sweeps to track')).toBeTruthy();
    expect(screen.getByText(/98\.096 MHz/)).toBeTruthy();
    expect(screen.getByText(/-27\.5 dBFS \(relative\)/)).toBeTruthy();
    expect(screen.getByText(/Repeat Single or use Run/)).toBeTruthy();
  });

  it('labels a promoted detector row independently of classifier output', () => {
    render(<SignalDetectionResults
      sweep={sweep}
      detections={[{ ...candidate, state: 'active', persistenceSweeps: 2 }]}
      config={config}
    />);

    expect(screen.getByText('TRACKED')).toBeTruthy();
    expect(screen.getByText('2 sweeps tracked')).toBeTruthy();
    expect(screen.getByText('1 tracked · 0 candidates')).toBeTruthy();
  });

  it('distinguishes no sweep from a sweep with no threshold crossings', () => {
    const view = render(<SignalDetectionResults detections={[]} config={config}/>);
    expect(screen.getByText('No sweep to detect')).toBeTruthy();

    view.rerender(<SignalDetectionResults sweep={sweep} detections={[]} config={config}/>);
    expect(screen.getByText('No regions above threshold')).toBeTruthy();
  });
});
