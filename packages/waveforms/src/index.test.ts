import { describe, expect, it } from 'vitest';
import type { ReplayChannelConfiguration } from '@tinysa/contracts';
import {
  DEFAULT_REPLAY_CHANNEL,
  requireConformanceValidated,
  suggestedAnalyzerRange,
  synthesizeSpectrum,
  synthesizeZeroSpan,
  waveformCatalog,
  waveformDescriptor,
} from './index.js';

describe('qualified waveform replay engine', () => {
  it('publishes a closed catalog with source clauses and refuses unvalidated conformance claims', () => {
    expect(waveformCatalog.map((entry) => entry.id)).toEqual([
      'cw', 'am', 'fm', 'gsm-normal-burst', 'lte-etm1.1', 'nr-fr1-tm1.1', 'wifi6-he-su',
    ]);
    for (const descriptor of waveformCatalog) {
      expect(descriptor.standard.url).toMatch(/^https:\/\//);
      expect(descriptor.recommendedSpanHz).toBeGreaterThanOrEqual(descriptor.occupiedBandwidthHz);
    }
    expect(() => requireConformanceValidated('lte-etm1.1')).toThrow(/not installed/i);
  });

  it('produces seeded AWGN-derived frames that are repeatable and evolve by sweep', () => {
    const input = { profile: 'cw' as const, startHz: 200_000_000, stopHz: 202_000_000, points: 450, sweepIndex: 4, channel: DEFAULT_REPLAY_CHANNEL };
    const first = synthesizeSpectrum(input);
    const duplicate = synthesizeSpectrum(input);
    const next = synthesizeSpectrum({ ...input, sweepIndex: 5 });
    expect(duplicate).toEqual(first);
    expect(next).not.toEqual(first);
    expect(average(first)).toBeGreaterThan(-112);
    expect(average(first)).toBeLessThan(-103);
    expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(6);
  });

  it('adds reproducible frequency-selective Rayleigh fades rather than relabeling AWGN', () => {
    const descriptor = waveformDescriptor('lte-etm1.1');
    const range = suggestedAnalyzerRange(descriptor);
    const awgn = synthesizeSpectrum({ profile: descriptor.id, ...range, points: 450, sweepIndex: 7, channel: { ...DEFAULT_REPLAY_CHANNEL, noiseFloorDbm: -125 } });
    const rayleighChannel: ReplayChannelConfiguration = { ...DEFAULT_REPLAY_CHANNEL, model: 'rayleigh', noiseFloorDbm: -125 };
    const rayleigh = synthesizeSpectrum({ profile: descriptor.id, ...range, points: 450, sweepIndex: 7, channel: rayleighChannel });
    const occupied = rayleigh.filter((_value, index) => index > 110 && index < 340);
    const awgnOccupied = awgn.filter((_value, index) => index > 110 && index < 340);
    expect(standardDeviation(occupied)).toBeGreaterThan(standardDeviation(awgnOccupied) + 1);
    expect(Math.min(...occupied)).toBeLessThan(Math.min(...awgnOccupied) - 3);
    expect(synthesizeSpectrum({ profile: descriptor.id, ...range, points: 450, sweepIndex: 7, channel: rayleighChannel })).toEqual(rayleigh);
  });

  it('animates AM vertically and FM laterally with distinct replay behavior', () => {
    const amDescriptor = waveformDescriptor('am');
    const amRange = suggestedAnalyzerRange(amDescriptor);
    const amCenterLevels = Array.from({ length: 18 }, (_, sweepIndex) => {
      const values = synthesizeSpectrum({ profile: 'am', ...amRange, points: 401, sweepIndex, channel: DEFAULT_REPLAY_CHANNEL });
      return values[200]!;
    });
    expect(Math.max(...amCenterLevels) - Math.min(...amCenterLevels)).toBeGreaterThan(5);

    const fmDescriptor = waveformDescriptor('fm');
    const fmRange = suggestedAnalyzerRange(fmDescriptor);
    const peakFrequencies = Array.from({ length: 24 }, (_, sweepIndex) => {
      const values = synthesizeSpectrum({ profile: 'fm', ...fmRange, points: 401, sweepIndex, channel: DEFAULT_REPLAY_CHANNEL });
      const peak = values.reduce((best, value, index) => value > values[best]! ? index : best, 0);
      return fmRange.startHz + (fmRange.stopHz - fmRange.startHz) * peak / 400;
    });
    expect(Math.max(...peakFrequencies) - Math.min(...peakFrequencies)).toBeGreaterThan(130_000);
  });

  it('projects burst timing into zero-span replays for GSM and Wi-Fi', () => {
    const gsm = synthesizeZeroSpan({ profile: 'gsm-normal-burst', points: 208, sweepIndex: 0, channel: DEFAULT_REPLAY_CHANNEL });
    const wifi = synthesizeZeroSpan({ profile: 'wifi6-he-su', points: 178, sweepIndex: 0, channel: DEFAULT_REPLAY_CHANNEL });
    expect(gsm.filter((value) => value > -80).length / gsm.length).toBeCloseTo(1 / 8, 1);
    expect(wifi.some((value) => value > -70)).toBe(true);
    expect(wifi.some((value) => value < -100)).toBe(true);
  });
});

function average(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0) / values.length; }
function standardDeviation(values: readonly number[]): number {
  const mean = average(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length);
}
