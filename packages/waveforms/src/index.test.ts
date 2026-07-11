import { describe, expect, it } from 'vitest';
import { synthesizedSignalProfileSchema, type ReplayChannelConfiguration } from '@tinysa/contracts';
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
    expect(waveformCatalog.map((entry) => entry.id)).toEqual(synthesizedSignalProfileSchema.options);
    expect(waveformCatalog).toHaveLength(79);
    expect(countFamilies(waveformCatalog)).toEqual({ tone: 1, analog: 2, geran: 6, 'e-utra': 25, nr: 41, wlan: 4 });
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

  it('keeps the FM-adjacent channel floor at the AWGN floor instead of drawing a false occupied pedestal', () => {
    const descriptor = waveformDescriptor('fm');
    const range = suggestedAnalyzerRange(descriptor);
    const values = synthesizeSpectrum({ profile: 'fm', ...range, points: 1001, sweepIndex: 8, channel: DEFAULT_REPLAY_CHANNEL });
    const frequencies = values.map((_value, index) => range.startHz + (range.stopHz - range.startHz) * index / 1000);
    const adjacent = values.filter((_value, index) => {
      const offset = Math.abs(frequencies[index]! - descriptor.centerHz);
      const sidebandDistance = Math.min(...[25_000, 50_000, 75_000].map((line) => Math.abs(offset - line)));
      return offset < 105_000 && sidebandDistance > 5_000;
    });
    const outside = values.filter((_value, index) => {
      const offset = Math.abs(frequencies[index]! - descriptor.centerHz);
      return offset > 145_000 && offset < 225_000;
    });
    expect(Math.abs(median(adjacent) - median(outside))).toBeLessThan(4);
  });

  it('synthesizes every closed Release 19 and HE profile with finite, correctly sized output', () => {
    for (const descriptor of waveformCatalog) {
      const range = suggestedAnalyzerRange(descriptor);
      const values = synthesizeSpectrum({ profile: descriptor.id, ...range, points: 121, sweepIndex: 2, channel: DEFAULT_REPLAY_CHANNEL });
      expect(values).toHaveLength(121);
      expect(values.every(Number.isFinite), descriptor.id).toBe(true);
    }
  });

  it('projects full, boosted, and single-PRB test models as distinct allocations', () => {
    const range = suggestedAnalyzerRange(waveformDescriptor('lte-etm1.1'));
    const full = synthesizeSpectrum({ profile: 'lte-etm1.1', ...range, points: 450, sweepIndex: 3, channel: DEFAULT_REPLAY_CHANNEL });
    const boosted = synthesizeSpectrum({ profile: 'lte-etm1.2', ...range, points: 450, sweepIndex: 3, channel: DEFAULT_REPLAY_CHANNEL });
    const single = synthesizeSpectrum({ profile: 'lte-etm2', ...range, points: 450, sweepIndex: 3, channel: DEFAULT_REPLAY_CHANNEL });
    expect(standardDeviation(boosted.slice(100, 350))).toBeGreaterThan(standardDeviation(full.slice(100, 350)) + 0.2);
    expect(single.filter((value) => value > -75).length).toBeLessThan(full.filter((value) => value > -75).length / 8);
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
function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) throw new Error('Median requires samples');
  return ordered[Math.floor(ordered.length / 2)]!;
}
function countFamilies(catalog: typeof waveformCatalog): Record<string, number> {
  return catalog.reduce<Record<string, number>>((counts, descriptor) => ({ ...counts, [descriptor.family]: (counts[descriptor.family] ?? 0) + 1 }), {});
}
