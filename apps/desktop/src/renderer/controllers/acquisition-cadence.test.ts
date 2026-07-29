import { describe, expect, it } from 'vitest';
import {
  continuousIqFramePeriodMilliseconds,
  continuousSpectrumFramePeriodMilliseconds,
} from './acquisition.js';

describe('global acquisition cadence', () => {
  it('uses complete-buffer duration while capping synthetic I/Q at a responsive analysis rate', () => {
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 56_000_000 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 2_000_000 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 1_000_000 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 500_000 }))
      .toBeCloseTo(131.072);
  });

  it('uses the admitted sweep duration and caps production at the display refresh rate', () => {
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 0.05 })).toBe(100);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 1 })).toBe(1_000);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 0.001 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousSpectrumFramePeriodMilliseconds({ sweepTimeSeconds: 'auto' }))
      .toBeCloseTo(1_000 / 10);
  });
});
