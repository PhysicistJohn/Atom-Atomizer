/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  classifyDacsV7,
  dacsV7Spectrogram,
  isDacsV7SampleRate,
  selectDacsV7Dwell,
} from './dacs-v7-runtime.js';

const packageRoot = new URL(
  '../../../web/public/classifier/v7/',
  import.meta.url,
);
const wasmSource = new URL(
  '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  import.meta.url,
);
const remoteRoot = new URL('https://fixture.invalid/classifier/v7/');

function deterministicIq(sampleCount = 20_000): {
  readonly real: Float64Array;
  readonly imaginary: Float64Array;
} {
  const real = new Float64Array(sampleCount);
  const imaginary = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    real[index] = ((index * 17) % 257 - 128) / 128;
    imaginary[index] = ((index * 43 + 11) % 263 - 131) / 131;
  }
  return { real, imaginary };
}

function packageFetch(
  requested: string[],
  transform?: (filename: string, bytes: Uint8Array) => Uint8Array,
): typeof fetch {
  const allowed = new Set([
    'runtime-package-manifest.json',
    'dacs-v7-encoder.onnx',
    'dacs-v7-prototypes.json',
    'onnxruntime-wasm-1.27.0.wasm',
  ]);
  return async (input) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : new URL(input.toString());
    const filename = url.pathname.split('/').at(-1)!;
    requested.push(filename);
    if (!allowed.has(filename)) return new Response('not found', { status: 404 });
    const sourceUrl = filename === 'onnxruntime-wasm-1.27.0.wasm'
      ? wasmSource
      : new URL(filename, packageRoot);
    const original = Uint8Array.from(await readFile(sourceUrl));
    const bytes = transform?.(filename, original) ?? original;
    return new Response(Uint8Array.from(bytes).buffer, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    });
  };
}

describe('DACS v7 browser runtime', () => {
  it('selects only the three trained contiguous dwells and exact sample rate', () => {
    expect(selectDacsV7Dwell(19_999)).toBeUndefined();
    expect(selectDacsV7Dwell(20_000)).toBe('1ms');
    expect(selectDacsV7Dwell(49_999)).toBe('1ms');
    expect(selectDacsV7Dwell(50_000)).toBe('2.5ms');
    expect(selectDacsV7Dwell(199_999)).toBe('2.5ms');
    expect(selectDacsV7Dwell(200_000)).toBe('10ms');
    expect(selectDacsV7Dwell(200_001)).toBe('10ms');
    expect(isDacsV7SampleRate(20_000_000)).toBe(true);
    expect(isDacsV7SampleRate(19_999_999)).toBe(false);
  });

  it('matches the Torch preprocessing reference across all three planes', () => {
    const { real, imaginary } = deterministicIq();
    const spectrogram = dacsV7Spectrogram(real, imaginary, '1ms');
    expect(spectrogram.frames).toBe(624);
    expect(spectrogram.bins).toBe(33);
    expect(spectrogram.data).toHaveLength(61_776);
    const expected = new Map<number, number>([
      [0, 1.5187218189239502],
      [1, 0.4275268316268921],
      [32, -0.0896921157836914],
      [33, 0.24371659755706787],
      [100, -0.865127682685852],
      [20_591, -0.07610207796096802],
      [20_592, 1.0552172660827637],
      [20_593, -1.8310043811798096],
      [41_183, -6.030665397644043],
      [41_184, 1.0470818281173706],
      [41_185, 1.0578786134719849],
      [61_775, 1.9503496885299683],
    ]);
    for (const [index, value] of expected) {
      expect(spectrogram.data[index]).toBeCloseTo(value, 4);
    }
  });

  it('hash-verifies the package and matches Torch at every dynamic dwell', async () => {
    const requested: string[] = [];
    const references = [
      { dwell: '1ms' as const, samples: 20_000, confidence: 0.9987656, confidenceLogit: 5.449768 },
      { dwell: '2.5ms' as const, samples: 50_000, confidence: 0.9997082, confidenceLogit: 5.480314 },
      { dwell: '10ms' as const, samples: 200_000, confidence: 0.9999665, confidenceLogit: 5.508060 },
    ];
    for (const reference of references) {
      const { real, imaginary } = deterministicIq(reference.samples);
      const result = await classifyDacsV7(real, imaginary, reference.dwell, {
        manifestUrl: new URL('runtime-package-manifest.json', remoteRoot),
        wasmUrl: new URL('onnxruntime-wasm-1.27.0.wasm', remoteRoot),
        fetcher: packageFetch(requested),
      });

      expect(result).toMatchObject({
        family: 'ofdm',
        dwell: reference.dwell,
        dwellSamples: reference.samples,
        executionProvider: 'wasm',
      });
      expect(result.confidence).toBeCloseTo(reference.confidence, 3);
      expect(result.confidenceLogit).toBeCloseTo(reference.confidenceLogit, 2);
      expect(result.candidates[0]?.label).toBe('ofdm');
      expect(
        Object.values(result.posterior).reduce((sum, value) => sum + value, 0),
      ).toBeCloseTo(1, 6);
    }

    expect([...new Set(requested)].sort()).toEqual([
      'dacs-v7-encoder.onnx',
      'dacs-v7-prototypes.json',
      'onnxruntime-wasm-1.27.0.wasm',
      'runtime-package-manifest.json',
    ].sort());
    expect(requested).not.toContain('dacs-v7-validation.json');
  }, 30_000);

  it('rejects changed model bytes before ONNX Runtime sees them', async () => {
    const requested: string[] = [];
    const { real, imaginary } = deterministicIq();
    const fetcher = packageFetch(requested, (filename, original) => {
      if (filename !== 'dacs-v7-encoder.onnx') return original;
      const changed = Uint8Array.from(original);
      changed[0] = changed[0]! ^ 0xff;
      return changed;
    });

    await expect(classifyDacsV7(real, imaginary, '1ms', {
      manifestUrl: new URL('runtime-package-manifest.json', remoteRoot),
      wasmUrl: new URL('onnxruntime-wasm-1.27.0.wasm', remoteRoot),
      fetcher,
    })).rejects.toThrow(/encoder.*SHA-256 does not match/);
  });
});
