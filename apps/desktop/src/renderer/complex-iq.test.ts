import { describe, expect, it } from 'vitest';
import {
  previewComplexIq,
} from './complex-iq.js';

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

    const ad9361 = new Uint8Array(4);
    const ad9361View = new DataView(ad9361.buffer);
    ad9361View.setInt16(0, 2_047, true);
    ad9361View.setInt16(2, -2_048, true);
    expect(previewComplexIq({
      samples: ad9361,
      sampleCount: 1,
      sampleFormat: 'ci16le',
      adcFullScaleCode: 2_048,
    }).points[0]).toMatchObject({ i: 2_047 / 2_048, q: -1 });

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
