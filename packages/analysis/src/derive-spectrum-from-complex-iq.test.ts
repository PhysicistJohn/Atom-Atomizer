import { describe, expect, it } from 'vitest';
import { complexIqPayloadByteLength } from '@tinysa/contracts';
import { deriveSpectrumFromComplexIq } from './index.js';

function encodeCf32leTone(sampleCount: number, offsetHz: number, sampleRateHz: number, amplitude = 0.5): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 8);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < sampleCount; n++) {
    const phase = 2 * Math.PI * offsetHz * n / sampleRateHz;
    view.setFloat32(n * 8, amplitude * Math.cos(phase), true);
    view.setFloat32(n * 8 + 4, amplitude * Math.sin(phase), true);
  }
  return bytes;
}

function encodeCi16leTone(
  sampleCount: number,
  offsetHz: number,
  sampleRateHz: number,
  amplitude = 0.5,
  fullScaleCode = 32_768,
): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 4);
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < sampleCount; n++) {
    const phase = 2 * Math.PI * offsetHz * n / sampleRateHz;
    view.setInt16(n * 4, Math.round(amplitude * Math.cos(phase) * fullScaleCode), true);
    view.setInt16(n * 4 + 2, Math.round(amplitude * Math.sin(phase) * fullScaleCode), true);
  }
  return bytes;
}

describe('deriveSpectrumFromComplexIq', () => {
  const sampleCount = 2_048;
  const sampleRateHz = 1_000_000;
  const centerHz = 100_000_000;
  const toneOffsetHz = 100_000;

  it('projects a real hardware-shaped complex tone to its true frequency (cf32le)', () => {
    const samples = encodeCf32leTone(sampleCount, toneOffsetHz, sampleRateHz);
    const result = deriveSpectrumFromComplexIq({ samples, sampleCount, sampleFormat: 'cf32le', centerHz, sampleRateHz });

    expect(result.fftSize).toBe(2_048);
    expect(result.frequencyHz).toHaveLength(result.fftSize);
    expect(result.powerDbm).toHaveLength(result.fftSize);
    expect(result.powerDbm.every((value) => Number.isFinite(value))).toBe(true);
    for (let index = 1; index < result.frequencyHz.length; index++) {
      expect(result.frequencyHz[index]!).toBeGreaterThan(result.frequencyHz[index - 1]!);
    }
    // fftshift centers DC at fftSize/2.
    expect(result.frequencyHz[result.fftSize / 2]!).toBeCloseTo(centerHz, 0);

    let peakIndex = 0;
    for (let index = 1; index < result.powerDbm.length; index++) {
      if (result.powerDbm[index]! > result.powerDbm[peakIndex]!) peakIndex = index;
    }
    const binWidthHz = sampleRateHz / result.fftSize;
    expect(Math.abs(result.frequencyHz[peakIndex]! - (centerHz + toneOffsetHz))).toBeLessThanOrEqual(binWidthHz);

    const median = [...result.powerDbm].sort((a, b) => a - b)[Math.floor(result.powerDbm.length / 2)]!;
    expect(result.powerDbm[peakIndex]! - median).toBeGreaterThan(40);

    expect(result.actualRbwHz).toBeGreaterThan(binWidthHz);
    expect(result.actualRbwHz).toBeLessThan(binWidthHz * 3);
  });

  it('decodes the AD9361-shaped ci16le format identically in kind (Neptune P210 native format)', () => {
    const samples = encodeCi16leTone(sampleCount, toneOffsetHz, sampleRateHz, 0.5, 2_048);
    const result = deriveSpectrumFromComplexIq({
      samples,
      sampleCount,
      sampleFormat: 'ci16le',
      centerHz,
      sampleRateHz,
      adcFullScaleCode: 2_048,
    });

    let peakIndex = 0;
    for (let index = 1; index < result.powerDbm.length; index++) {
      if (result.powerDbm[index]! > result.powerDbm[peakIndex]!) peakIndex = index;
    }
    const binWidthHz = sampleRateHz / result.fftSize;
    expect(Math.abs(result.frequencyHz[peakIndex]! - (centerHz + toneOffsetHz))).toBeLessThanOrEqual(binWidthHz);

    const incorrectlyContainerNormalized = deriveSpectrumFromComplexIq({
      samples,
      sampleCount,
      sampleFormat: 'ci16le',
      centerHz,
      sampleRateHz,
    });
    expect(Math.max(...result.powerDbm) - Math.max(...incorrectlyContainerNormalized.powerDbm))
      .toBeCloseTo(20 * Math.log10(32_768 / 2_048), 6);
  });

  it('caps the FFT size for a wide Neptune-class capture and still resolves the tone', () => {
    const wideSampleCount = 16_384;
    const samples = encodeCf32leTone(wideSampleCount, toneOffsetHz, sampleRateHz);
    const result = deriveSpectrumFromComplexIq({ samples, sampleCount: wideSampleCount, sampleFormat: 'cf32le', centerHz, sampleRateHz });
    expect(result.fftSize).toBe(4_096);
  });

  it('rejects a payload whose byte length does not match its declared sample geometry', () => {
    const samples = encodeCf32leTone(sampleCount, toneOffsetHz, sampleRateHz).slice(0, -8);
    expect(() => deriveSpectrumFromComplexIq({ samples, sampleCount, sampleFormat: 'cf32le', centerHz, sampleRateHz }))
      .toThrow(RangeError);
  });

  it('rejects a capture too short to yield a meaningful projection', () => {
    const shortSampleCount = 2;
    const samples = new Uint8Array(complexIqPayloadByteLength(shortSampleCount, 'cf32le'));
    expect(() => deriveSpectrumFromComplexIq({ samples, sampleCount: shortSampleCount, sampleFormat: 'cf32le', centerHz, sampleRateHz }))
      .toThrow(/at least four/);
  });
});
