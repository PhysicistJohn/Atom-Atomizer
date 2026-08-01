import { describe, expect, it } from 'vitest';
import { continuousIqFramePeriodMilliseconds } from './acquisition.js';

describe('global acquisition cadence', () => {
  it('uses complete-buffer duration while capping I/Q at a responsive analysis rate', () => {
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 56_000_000 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 2_000_000 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 1_000_000 }))
      .toBeCloseTo(1_000 / 10);
    expect(continuousIqFramePeriodMilliseconds({ sampleCount: 65_536, sampleRateHz: 500_000 }))
      .toBeCloseTo(131.072);
  });
});
