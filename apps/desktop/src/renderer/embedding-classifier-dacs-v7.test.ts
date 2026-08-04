/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyIqModulation } from './embedding-classifier-runtime.js';

interface ParityRow {
  readonly name: string;
  readonly iq: {
    readonly in_phase: number[];
    readonly quadrature: number[];
  };
}

const v4Root = new URL('../../../web/public/classifier/v4/', import.meta.url);
const v7Root = new URL('../../../web/public/classifier/v7/', import.meta.url);
const wasmSource = new URL(
  '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  import.meta.url,
);
const parityRoot = new URL(
  '../../../../../Atom-Classifier/src/embedding/assets-v3-dual-staging/',
  import.meta.url,
);
const parityManifest = JSON.parse(
  await readFile(new URL('runtime-package-manifest.json', parityRoot), 'utf8'),
) as { readonly external_evidence: { readonly parity: { readonly path: string } } };
const parity = JSON.parse(
  await readFile(new URL(parityManifest.external_evidence.parity.path, parityRoot), 'utf8'),
) as { readonly rows: readonly ParityRow[] };

function parityRow(name: string): ParityRow {
  const row = parity.rows.find((candidate) => candidate.name === name);
  if (!row) throw new Error(`missing parity row ${name}`);
  return row;
}

function prefix(row: ParityRow, sampleCount: number): {
  readonly real: Float64Array;
  readonly imaginary: Float64Array;
} {
  return {
    real: Float64Array.from(row.iq.in_phase.slice(0, sampleCount)),
    imaginary: Float64Array.from(row.iq.quadrature.slice(0, sampleCount)),
  };
}

describe('route-conditioned v4 open-set gate with DACS v7 refinement', () => {
  const requested: string[] = [];

  beforeAll(() => {
    vi.stubGlobal('location', new URL('https://fixture.invalid/'));
    vi.stubGlobal('fetch', (async (input) => {
      const url = input instanceof Request
        ? new URL(input.url)
        : new URL(input.toString());
      const filename = url.pathname.split('/').at(-1)!;
      const root = url.pathname.startsWith('/classifier/v7/') ? v7Root : v4Root;
      requested.push(url.pathname);
      try {
        const sourceUrl = filename === 'onnxruntime-wasm-1.27.0.wasm'
          || filename === 'ort-wasm-simd-threaded.wasm'
          ? wasmSource
          : new URL(filename, root);
        const bytes = Uint8Array.from(await readFile(sourceUrl));
        return new Response(bytes.buffer, {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }) satisfies typeof fetch);
  });

  afterAll(() => vi.unstubAllGlobals());

  it('does not load or run the closed-set DACS model after a v4 exact-zero rejection', async () => {
    const result = await classifyIqModulation(
      new Float64Array(20_000),
      new Float64Array(20_000),
      18_000_000,
      20_000_000,
      'historical',
    );

    expect(result).toMatchObject({
      isUnknown: true,
      rejection: { stage: 0, reason: 'no-signal' },
    });
    expect(requested.some((path) => path.startsWith('/classifier/v7/'))).toBe(false);
  });

  it('runs DACS only after the v4 gate accepts a known exact-rate capture', async () => {
    const capture = prefix(parityRow('causal-prefix-survivor-N32768'), 20_000);
    const result = await classifyIqModulation(
      capture.real,
      capture.imaginary,
      18_000_000,
      20_000_000,
      'historical',
    );

    expect(result).toMatchObject({
      isUnknown: false,
      runtime: {
        model: 'dacs-v7',
        openSetGate: 'time-domain-v4',
        dwell: '1ms',
        dwellSamples: 20_000,
        executionProvider: 'wasm',
      },
    });
    expect(requested).toContain('/classifier/v7/runtime-package-manifest.json');
    expect(requested).toContain('/classifier/v7/dacs-v7-encoder.onnx');
    expect(requested).toContain('/classifier/v7/dacs-v7-prototypes.json');
    expect(requested.some((path) =>
      path.endsWith('/ort-wasm-simd-threaded.wasm')
      || path.endsWith('/onnxruntime-wasm-1.27.0.wasm'))).toBe(true);
  }, 30_000);

  it('keeps the v4 gate as the visible classifier outside the exact training rate', async () => {
    const requestsBefore = requested.length;
    const capture = prefix(parityRow('causal-prefix-survivor-N32768'), 20_000);
    const legacyPrefix = {
      real: capture.real.subarray(0, 16_384),
      imaginary: capture.imaginary.subarray(0, 16_384),
    };
    const result = await classifyIqModulation(
      capture.real,
      capture.imaginary,
      18_000_000,
      19_999_999,
      'historical',
    );
    const legacyResult = await classifyIqModulation(
      legacyPrefix.real,
      legacyPrefix.imaginary,
      18_000_000,
      19_999_999,
      'historical',
    );

    expect(result.runtime).toEqual({ model: 'time-domain-v4' });
    expect(result).toEqual(legacyResult);
    expect(requested.slice(requestsBefore).filter((path) =>
      path.startsWith('/classifier/v7/'))).toEqual([]);
  });
});
