import { describe, expect, it } from 'vitest';
import { continuousSpectrumFramePeriodMilliseconds } from './acquisition.js';

describe('global acquisition cadence', () => {
  it('uses the admitted sweep duration and caps production at the display refresh rate', () => {
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 0.05 })).toBe(50);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 1 })).toBe(1_000);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 0.001 }))
      .toBeCloseTo(1_000 / 60);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 'auto' }))
      .toBeCloseTo(1_000 / 60);
  });
});
