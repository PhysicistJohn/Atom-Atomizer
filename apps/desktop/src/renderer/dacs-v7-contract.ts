export const DACS_V7_SAMPLE_RATE_HZ = 20_000_000;

export type DacsV7Dwell = '1ms' | '2.5ms' | '10ms';

export const DACS_V7_DWELL_SAMPLES: Readonly<Record<DacsV7Dwell, number>> = {
  '1ms': 20_000,
  '2.5ms': 50_000,
  '10ms': 200_000,
};

/** Select the largest trained DACS dwell present in a contiguous capture. */
export function selectDacsV7Dwell(sampleCount: number): DacsV7Dwell | undefined {
  if (!Number.isInteger(sampleCount) || sampleCount < DACS_V7_DWELL_SAMPLES['1ms']) {
    return undefined;
  }
  if (sampleCount >= DACS_V7_DWELL_SAMPLES['10ms']) return '10ms';
  if (sampleCount >= DACS_V7_DWELL_SAMPLES['2.5ms']) return '2.5ms';
  return '1ms';
}

export function isDacsV7SampleRate(sampleRateHz: number): boolean {
  return sampleRateHz === DACS_V7_SAMPLE_RATE_HZ;
}
