import { describe, expect, it } from 'vitest';
import type { DeviceIdentity, Sweep } from '@tinysa/contracts';
import { measureThreeDecibelBandwidth } from './channel-bandwidth.js';
import { measureChannel } from './index.js';

const HALF_POWER_DECIBELS = 10 * Math.log10(2);
const identity: DeviceIdentity = {
  model: 'tinySA Ultra+ ZS407',
  hardwareVersion: 'test',
  firmwareVersion: 'test',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'channel-bandwidth-test',
    path: 'test://channel-bandwidth',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

describe('3 dB channel bandwidth', () => {
  it.each([
    { name: 'bin-centered equal grid/RBW', binWidthHz: 1_000, actualRbwHz: 1_000, offsetBins: 0, noiseFloorDbm: -120, expectedStatus: 'resolution-limited' },
    { name: 'quarter-bin RBW-dominated', binWidthHz: 1_000, actualRbwHz: 4_000, offsetBins: 0.25, noiseFloorDbm: -80, expectedStatus: 'resolution-limited' },
    { name: 'half-bin grid-dominated', binWidthHz: 4_000, actualRbwHz: 1_000, offsetBins: 0.5, noiseFloorDbm: -50, expectedStatus: 'resolution-limited' },
    { name: 'half-bin low-SNR floor-broadened', binWidthHz: 2_000, actualRbwHz: 2_000, offsetBins: 0.5, noiseFloorDbm: -47, expectedStatus: 'resolved' },
  ])('keeps $name narrow-line width local and distinct from 99% OBW', ({
    binWidthHz,
    actualRbwHz,
    offsetBins,
    noiseFloorDbm,
    expectedStatus,
  }) => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * binWidthHz);
    const visibleSpanHz = frequencyHz.at(-1)! - frequencyHz[0]!;
    const channelCenterHz = 100 * binWidthHz;
    const signalCenterHz = channelCenterHz + offsetBins * binWidthHz;
    const responseWidthHz = Math.max(binWidthHz, actualRbwHz);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      noiseFloorDbm,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - signalCenterHz) / responseWidthHz) ** 2,
    ));
    const result = measureChannel(makeSweep(frequencyHz, powerDbm, actualRbwHz), {
      centerHz: channelCenterHz,
      mainBandwidthHz: 40 * binWidthHz,
      adjacentBandwidthHz: 10 * binWidthHz,
      channelSpacingHz: 30 * binWidthHz,
      adjacentChannelCount: 1,
      occupiedPowerPercent: 99,
      obwNoiseCorrection: 'none',
    });

    expect(result.threeDecibelBandwidth.status).toBe(expectedStatus);
    if (result.threeDecibelBandwidth.status === 'unavailable') throw new Error('Expected bounded narrow-line crossings');
    expect(result.threeDecibelBandwidth.resolutionScaleHz).toBe(responseWidthHz);
    expect(result.threeDecibelBandwidth.bandwidthHz).toBeLessThan(visibleSpanHz / 10);
    expect(result.occupiedBandwidth.percent).toBe(99);
    expect(result.occupiedBandwidth.bandwidthHz).toBeGreaterThan(result.threeDecibelBandwidth.bandwidthHz);
    expect(result.occupiedBandwidth).not.toHaveProperty('status');
  });

  it('fails closed when the half-power level is buried in the observed noise floor', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 2_000);
    const signalCenterHz = 201_000;
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -44,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - signalCenterHz) / 2_000) ** 2,
    ));
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 2_000),
      160_000,
      240_000,
    );

    expect(measurement).toMatchObject({
      status: 'unavailable',
      reason: 'lower-crossing-not-observed',
      resolutionScaleHz: 2_000,
    });
    expect('bandwidthHz' in measurement).toBe(false);
  });

  it('keeps a narrow CW resolution-limited even when total-power OBW spans nearly the entire display', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -50,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 50_000) / 10_000) ** 2,
    ));
    const result = measureChannel(makeSweep(frequencyHz, powerDbm, 10_000), {
      centerHz: 50_000,
      mainBandwidthHz: 40_000,
      adjacentBandwidthHz: 10_000,
      channelSpacingHz: 30_000,
      adjacentChannelCount: 1,
      occupiedPowerPercent: 99,
      obwNoiseCorrection: 'none',
    });

    expect(result.occupiedBandwidth.bandwidthHz).toBeGreaterThan(90_000);
    expect(result.threeDecibelBandwidth.status).toBe('resolution-limited');
    if (result.threeDecibelBandwidth.status === 'unavailable') throw new Error('Expected observed CW crossings');
    expect(result.threeDecibelBandwidth.bandwidthHz).toBeCloseTo(10_000, 6);
    expect(result.threeDecibelBandwidth.resolutionScaleHz).toBe(10_000);
  });

  it('interpolates both half-power crossings for a resolved non-bin-aligned width', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const expectedWidthHz = 25_400;
    const powerDbm = frequencyHz.map((frequency) =>
      -30 - HALF_POWER_DECIBELS * (2 * (frequency - 50_000) / expectedWidthHz) ** 2);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      20_000,
      80_000,
    );

    expect(measurement.status).toBe('resolved');
    if (measurement.status === 'unavailable') throw new Error('Expected two observed half-power crossings');
    expect(Math.abs(measurement.startHz - 37_300)).toBeLessThan(25);
    expect(Math.abs(measurement.stopHz - 62_700)).toBeLessThan(25);
    expect(Math.abs(measurement.bandwidthHz - expectedWidthHz)).toBeLessThan(50);
  });

  it('uses a robust upper envelope so sub-resolution OFDM-like ripple cannot collapse a broad plateau to a few bins', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const rippleDb = [0, 5, 1, 6, 2];
    const powerDbm = frequencyHz.map((frequency, index) =>
      frequency >= 30_000 && frequency <= 70_000
        ? -40 - rippleDb[(index - 30) % rippleDb.length]!
        : -100);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      10_000,
      90_000,
    );

    expect(measurement.status).toBe('resolved');
    if (measurement.status === 'unavailable') throw new Error('Expected one resolved rippled plateau');
    expect(measurement.referenceKind).toBe('robust-upper-envelope');
    expect(measurement.referenceLevelDbm).toBeLessThanOrEqual(measurement.peakDbm);
    expect(measurement.bandwidthHz).toBeGreaterThan(38_000);
    expect(measurement.bandwidthHz).toBeLessThan(43_000);
  });

  it('searches beyond a low-SNR threshold component until robust half-power edges are actually bracketed', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = lowSnrRippledBand();
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      10_000,
      90_000,
    );

    expect(measurement.status).toBe('resolved');
    if (measurement.status === 'unavailable') throw new Error('Expected outward-bracketed robust crossings');
    expect(measurement.referenceKind).toBe('robust-upper-envelope');
    expect(measurement.startHz).toBeGreaterThan(15_000);
    expect(measurement.startHz).toBeLessThan(17_000);
    expect(measurement.stopHz).toBeGreaterThan(83_000);
    expect(measurement.stopHz).toBeLessThan(85_000);
    expect(measurement.bandwidthHz).toBeGreaterThan(66_000);
  });

  it('fails closed instead of reporting one lobe when resolved half-power islands remain separated', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => {
      if (frequency >= 25_000 && frequency <= 44_000) return -40;
      if (frequency > 44_000 && frequency < 56_000) return -60;
      if (frequency >= 56_000 && frequency <= 75_000) return -41;
      return -100;
    });
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      10_000,
      90_000,
    );

    expect(measurement).toMatchObject({
      status: 'unavailable',
      reason: 'nonmonotone-half-power-response',
      referenceKind: 'robust-upper-envelope',
    });
    expect('bandwidthHz' in measurement).toBe(false);
  });

  it.each([1, 2, 4, 5])('applies the one-resolution-element component-gap policy to a %i-RBW floor gap', (gapBins) => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const secondStart = 40 + gapBins;
    const powerDbm = frequencyHz.map((_frequency, index) =>
      (index >= 20 && index <= 39) || (index >= secondStart && index < secondStart + 20)
        ? -40
        : -110);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      10_000,
      90_000,
    );

    expect(measurement.status).not.toBe('unavailable');
    if (measurement.status === 'unavailable') throw new Error('Expected the strongest bounded plateau response');
    if (gapBins === 1) {
      expect(measurement.referenceKind).toBe('robust-upper-envelope');
      expect(measurement.bandwidthHz).toBeGreaterThan(39_000);
    } else {
      expect(measurement.referenceKind).toBe('sampled-peak');
      expect(measurement.bandwidthHz).toBeLessThan(21_000);
    }
  });

  it('does not round a non-integer RBW/grid ratio up into an over-wide component gap', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((_frequency, index) =>
      index >= 20 && index <= 39
        ? -40
        : index >= 42 && index <= 61
          ? -41
          : -110);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_100),
      10_000,
      90_000,
    );

    expect(measurement.status).toBe('resolved');
    if (measurement.status === 'unavailable') throw new Error('Expected the strongest local component width');
    expect(measurement.referenceKind).toBe('sampled-peak');
    expect(measurement.bandwidthHz).toBeLessThan(22_000);
  });

  it.each([1, 2, 4, 5])('closes only a bounded %i-RBW interior half-power null inside one above-floor component', (gapBins) => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const nullStart = 50 - Math.floor(gapBins / 2);
    const nullStop = nullStart + gapBins - 1;
    const powerDbm = frequencyHz.map((_frequency, index) => {
      if (index < 25 || index > 75) return -110;
      if (index >= nullStart && index <= nullStop) return -60;
      return -40;
    });
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      10_000,
      90_000,
    );

    if (gapBins <= 4) {
      expect(measurement.status).toBe('resolved');
      if (measurement.status === 'unavailable') throw new Error('Expected a closed bounded interior null');
      expect(measurement.referenceKind).toBe('robust-upper-envelope');
      expect(measurement.bandwidthHz).toBeGreaterThan(49_000);
    } else {
      expect(measurement).toMatchObject({
        status: 'unavailable',
        reason: 'nonmonotone-half-power-response',
        referenceKind: 'robust-upper-envelope',
      });
    }
  });

  it('keeps a true narrow CW on its sampled-peak reference without envelope broadening', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 50_000) / 1_000) ** 2,
    ));
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      20_000,
      80_000,
    );

    expect(measurement.status).toBe('resolution-limited');
    if (measurement.status === 'unavailable') throw new Error('Expected a narrow CW response');
    expect(measurement.referenceKind).toBe('sampled-peak');
    expect(measurement.referenceLevelDbm).toBe(measurement.peakDbm);
    expect(measurement.bandwidthHz).toBeLessThanOrEqual(2_000);
  });

  it.each([
    { edge: 'lower', signalCenterHz: 0, expectedReason: 'lower-crossing-not-observed', expectedPeakHz: 0 },
    { edge: 'upper', signalCenterHz: 100_000, expectedReason: 'upper-crossing-not-observed', expectedPeakHz: 100_000 },
  ] as const)('fails closed at the $edge sweep edge instead of returning the visible span', ({ signalCenterHz, expectedReason, expectedPeakHz }) => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) =>
      -40 - HALF_POWER_DECIBELS * ((frequency - signalCenterHz) / 5_000) ** 2);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      0,
      100_000,
    );

    expect(measurement).toMatchObject({
      status: 'unavailable',
      reason: expectedReason,
      peakHz: expectedPeakHz,
    });
    expect('bandwidthHz' in measurement).toBe(false);
  });

  it('does not borrow half-power crossings from outside the configured channel', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) =>
      Math.abs(frequency - 50_000) <= 20_000 ? -40 : -100);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      40_000,
      60_000,
    );

    expect(measurement).toMatchObject({
      status: 'unavailable',
      reason: 'crossing-outside-window',
    });
    expect('bandwidthHz' in measurement).toBe(false);
  });

  it('handles a tied flat-top peak deterministically and measures its nearest crossings', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) =>
      Math.abs(frequency - 50_000) <= 5_000 ? -40 : -80);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      20_000,
      80_000,
    );

    expect(measurement.status).toBe('resolved');
    if (measurement.status === 'unavailable') throw new Error('Expected flat-top crossings');
    expect(measurement.peakHz).toBe(45_000);
    expect(measurement.bandwidthHz).toBeGreaterThan(10_000);
    expect(measurement.bandwidthHz).toBeLessThan(11_000);
  });

  it.each([
    { binWidthHz: 1_000, actualRbwHz: 10_000, expectedLimitHz: 10_000 },
    { binWidthHz: 5_000, actualRbwHz: 1_000, expectedLimitHz: 5_000 },
  ])('uses the coarser of RBW and sample spacing as its resolution limit', ({ binWidthHz, actualRbwHz, expectedLimitHz }) => {
    const frequencyHz = Array.from({ length: Math.floor(100_000 / binWidthHz) + 1 }, (_, index) => index * binWidthHz);
    const powerDbm = frequencyHz.map((frequency) =>
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 50_000) / 5_000) ** 2);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, actualRbwHz),
      20_000,
      80_000,
    );

    expect(measurement.status, JSON.stringify({ binWidthHz, actualRbwHz, measurement })).toBe('resolution-limited');
    expect(measurement.resolutionScaleHz).toBe(expectedLimitHz);
  });

  it('uses the largest local sample interval as the grid-resolution limit across a sparse response', () => {
    const frequencyHz = [0, 1_000, 2_000, 3_000, 4_000, 100_000, 101_000, 102_000, 103_000, 104_000];
    const powerDbm = [-110, -40, -40, -40, -40, -40, -40, -40, -40, -110];
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, powerDbm, 1_000),
      0,
      104_000,
    );

    expect(measurement.status).toBe('resolution-limited');
    if (measurement.status === 'unavailable') throw new Error('Expected bounded sparse-grid crossings');
    expect(measurement.resolutionScaleHz).toBe(96_000);
    expect(measurement.bandwidthHz).toBeLessThanOrEqual(2 * measurement.resolutionScaleHz);
  });

  it('returns a typed unavailable result when the channel contains no sampled peak bin', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const measurement = measureThreeDecibelBandwidth(
      makeSweep(frequencyHz, frequencyHz.map(() => -80), 1_000),
      50_100,
      50_200,
    );

    expect(measurement).toEqual({
      status: 'unavailable',
      reason: 'no-sampled-peak',
      windowStartHz: 50_100,
      windowStopHz: 50_200,
      resolutionScaleHz: 1_000,
    });
  });

  it.each([
    { edge: 'lower', actualStartHz: 5_000, actualStopHz: 100_000 },
    { edge: 'upper', actualStartHz: 0, actualStopHz: 95_000 },
  ])('rejects direct $edge frequency-grid drift outside the declared actual span', ({ actualStartHz, actualStopHz }) => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const sweep = {
      ...makeSweep(frequencyHz, frequencyHz.map(() => -80), 1_000),
      actualStartHz,
      actualStopHz,
    };
    expect(() => measureThreeDecibelBandwidth(sweep, 10_000, 90_000))
      .toThrow(/frequency grid lies outside its actual span/i);
  });
});

function lowSnrRippledBand(): readonly number[] {
  return Array.from({ length: 101 }, (_value, index) => {
    if (index === 15 || index === 85) return -92;
    if (index === 16 || index === 84) return -90.9;
    if (index === 17 || index === 83) return -90.7;
    if (index === 18 || index === 82) return -90.5;
    if (index === 19 || index === 81) return -90.2;
    if (index >= 20 && index <= 80) return index % 2 === 0 ? -88 : -92;
    return -100;
  });
}

function makeSweep(
  frequencyHz: readonly number[],
  powerDbm: readonly number[],
  actualRbwHz: number,
): Sweep {
  return {
    kind: 'spectrum',
    id: 'channel-bandwidth-sweep',
    sequence: 1,
    capturedAt: '2026-07-16T00:00:00.000Z',
    elapsedMilliseconds: 20,
    frequencyHz,
    powerDbm,
    requested: {
      kind: 'swept-spectrum',
      startHz: frequencyHz[0]!,
      stopHz: frequencyHz.at(-1)!,
      points: frequencyHz.length,
      sweepTimeSeconds: 'auto',
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormat: 'text',
        resolutionBandwidthKhz: actualRbwHz / 1_000,
        attenuationDb: 'auto',
        detector: 'sample',
        spurRejection: 'auto',
        lowNoiseAmplifier: 'off',
        avoidSpurs: 'auto',
        trigger: { mode: 'auto' },
      },
    },
    actualStartHz: frequencyHz[0]!,
    actualStopHz: frequencyHz.at(-1)!,
    actualRbwHz,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity,
  };
}
