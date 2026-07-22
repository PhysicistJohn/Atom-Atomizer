import { describe, expect, it } from 'vitest';
import {
  continuousIqFramePeriodMilliseconds,
  continuousSpectrumFramePeriodMilliseconds,
} from './acquisition.js';

describe('global acquisition cadence', () => {
  it('uses complete-buffer duration for I/Q independently of classification cadence', () => {
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 56_000_000 }))
      .toBeCloseTo(1_000 / 60);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 2_000_000 }))
      .toBeCloseTo(32.768);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 1_000_000 }))
      .toBeCloseTo(65.536);
  });

  it('uses the admitted sweep duration and caps production at the display refresh rate', () => {
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 0.05 })).toBe(50);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 1 })).toBe(1_000);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 0.001 }))
      .toBeCloseTo(1_000 / 60);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 'auto' }))
      .toBeCloseTo(1_000 / 60);
  });
});
