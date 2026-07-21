import { describe, expect, it } from 'vitest';
import type { InstrumentAcquisitionCapability } from '@tinysa/contracts';
import {
  DEFAULT_COMPLEX_IQ_CONFIGURATION,
  complexIqConfigurationFor,
  previewComplexIq,
  reconcileComplexIqConfiguration,
} from './complex-iq.js';

const capability: Extract<InstrumentAcquisitionCapability, { kind: 'complex-iq' }> = {
  kind: 'complex-iq',
  centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000, step: 1_000 },
  sampleRateHz: { min: 1_000_000, max: 20_000_000, step: 1_000_000 },
  bandwidthHz: { min: 200_000, max: 16_000_000, step: 200_000 },
  sampleCount: { min: 1_024, max: 1_048_576, step: 1_024 },
  sampleFormat: 'ci16le',
};

describe('driver-neutral complex I/Q staging', () => {
  it('reconciles persisted values to the exact connected-driver lattice', () => {
    // The wide default reconciles down to this driver's advertised maxima
    // (20 MHz sample rate, 16 MHz bandwidth on the ci16le lattice).
    expect(reconcileComplexIqConfiguration(capability, DEFAULT_COMPLEX_IQ_CONFIGURATION)).toEqual({
      kind: 'complex-iq',
      centerHz: 100_000_000,
      sampleRateHz: 20_000_000,
      bandwidthHz: 16_000_000,
      sampleCount: 65_536,
      sampleFormat: 'ci16le',
    });
  });

  it('preserves a standards-raster center offset exactly through renderer staging and admission', () => {
    const staged = reconcileComplexIqConfiguration(capability, {
      ...DEFAULT_COMPLEX_IQ_CONFIGURATION,
      centerHz: 3_500_010_000,
    });
    expect(staged.centerHz).toBe(3_500_010_000);
    expect(complexIqConfigurationFor(capability, staged).centerHz).toBe(3_500_010_000);
  });

  it('rejects values and formats that the driver did not advertise', () => {
    const valid = reconcileComplexIqConfiguration(capability, DEFAULT_COMPLEX_IQ_CONFIGURATION);
    expect(complexIqConfigurationFor(capability, valid)).toEqual(valid);
    expect(() => complexIqConfigurationFor(capability, { ...valid, sampleRateHz: 20_500_000 }))
      .toThrow(/sample rate.*outside/i);
    expect(() => complexIqConfigurationFor(capability, { ...valid, sampleFormat: 'cf32le' }))
      .toThrow(/not advertised/i);
  });

  it('finds a valid rate when the bandwidth minimum exceeds the staged rate', () => {
    const highBandwidth: typeof capability = {
      ...capability,
      sampleRateHz: { min: 1_000_000, max: 8_000_000, step: 1_000_000 },
      bandwidthHz: { min: 3_000_000, max: 6_000_000, step: 1_000_000 },
    };
    const reconciled = reconcileComplexIqConfiguration(highBandwidth, {
      ...DEFAULT_COMPLEX_IQ_CONFIGURATION,
      sampleRateHz: 1_000_000,
      bandwidthHz: 5_000_000,
    });
    expect(reconciled.sampleRateHz).toBe(3_000_000);
    expect(reconciled.bandwidthHz).toBe(3_000_000);
  });

  it('locks equal-rate capabilities to the nearest common driver lattice', () => {
    const equalRate = {
      ...capability,
      bandwidthMode: 'equal-to-sample-rate' as const,
      sampleRateHz: { min: 1_000_000, max: 20_000_000, step: 3_000_000 },
      bandwidthHz: { min: 2_000_000, max: 20_000_000, step: 2_000_000 },
    };
    const reconciled = reconcileComplexIqConfiguration(equalRate, {
      ...DEFAULT_COMPLEX_IQ_CONFIGURATION,
      sampleRateHz: 7_500_000,
      bandwidthHz: 1_500_000,
    });
    expect(reconciled.sampleRateHz).toBe(10_000_000);
    expect(reconciled.bandwidthHz).toBe(10_000_000);
    expect(complexIqConfigurationFor(equalRate, reconciled)).toEqual(reconciled);
    expect(() => complexIqConfigurationFor(equalRate, { ...reconciled, bandwidthHz: 8_000_000 }))
      .toThrow(/must equal sample rate/i);
  });
});

describe('bounded complex I/Q preview decoding', () => {
  it('decodes cf32le samples and computes preview metrics', () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    [[1, 0], [0, 1], [-1, 0]].forEach(([i, q], index) => {
      view.setFloat32(index * 8, i!, true);
      view.setFloat32(index * 8 + 4, q!, true);
    });
    const preview = previewComplexIq({ samples: bytes, sampleCount: 3, sampleFormat: 'cf32le' });
    expect(preview.points).toEqual([
      { sampleIndex: 0, i: 1, q: 0 },
      { sampleIndex: 1, i: 0, q: 1 },
      { sampleIndex: 2, i: -1, q: 0 },
    ]);
    expect(preview.rms).toBe(1);
    expect(preview.peak).toBe(1);
  });

  it('decodes integer hardware formats and respects the preview budget', () => {
    const ci16 = new Uint8Array(16);
    const view = new DataView(ci16.buffer);
    for (let index = 0; index < 4; index++) {
      view.setInt16(index * 4, index * 1_000, true);
      view.setInt16(index * 4 + 2, -index * 1_000, true);
    }
    const preview = previewComplexIq({ samples: ci16, sampleCount: 4, sampleFormat: 'ci16le' }, 2);
    expect(preview.points.map((point) => point.sampleIndex)).toEqual([0, 3]);
    expect(preview.points[1]).toMatchObject({ i: 3_000 / 32_768, q: -3_000 / 32_768 });

    expect(previewComplexIq({ samples: new Uint8Array([0, 255]), sampleCount: 1, sampleFormat: 'cu8' }).points[0])
      .toMatchObject({ i: -1, q: 1 });
  });

  it('rejects payload geometry and unbounded UI work', () => {
    expect(() => previewComplexIq({ samples: new Uint8Array(7), sampleCount: 1, sampleFormat: 'cf32le' }))
      .toThrow(/expected 8/i);
    expect(() => previewComplexIq({ samples: new Uint8Array(8), sampleCount: 1, sampleFormat: 'cf32le' }, 20_000))
      .toThrow(/point budget/i);
    const nonFinite = new Uint8Array(8);
    new DataView(nonFinite.buffer).setFloat32(0, Number.NaN, true);
    expect(() => previewComplexIq({ samples: nonFinite, sampleCount: 1, sampleFormat: 'cf32le' }))
      .toThrow(/non-finite.*sample 0/i);
  });
});
