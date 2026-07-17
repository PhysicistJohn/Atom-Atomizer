// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZeroSpanConfig } from '@tinysa/contracts';
import { ClassificationWorkspace } from './components/ClassificationWorkspace.js';

const zeroConfig: ZeroSpanConfig = {
  frequencyHz: 433_920_000,
  points: 450,
  rbwKhz: 100,
  attenuationDb: 'auto',
  sweepTimeSeconds: 0.05,
  trigger: { mode: 'auto' },
};

afterEach(cleanup);

describe('classification model availability', () => {
  it('states that classification is unavailable without disabling acquisition or detection', () => {
    render(<ClassificationWorkspace
      detections={[]}
      classifications={[]}
      modelAvailability="unavailable"
      onSelectedId={vi.fn()}
      detectionConfig={{
        threshold: { strategy: 'noise-relative', marginDb: 10 },
        minimumProminenceDb: 6,
        minimumBandwidthHz: 0,
        minimumConsecutiveSweeps: 2,
        releaseAfterMissedSweeps: 2,
      }}
      onDetectionConfig={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    expect(screen.getByText('Bayesian model unavailable')).toBeTruthy();
    expect(screen.getByText('Classification unavailable')).toBeTruthy();
    expect(screen.getByText(/Regenerate it and reload; acquisition and detection remain available/i)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Threshold mode' }).hasAttribute('disabled')).toBe(false);
  });
});
