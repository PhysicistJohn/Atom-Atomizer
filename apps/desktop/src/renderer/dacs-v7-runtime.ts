/// <reference types="vite/client" />

import type { InferenceSession, Tensor } from 'onnxruntime-web';
import onnxRuntimeModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import {
  DACS_V7_DWELL_SAMPLES,
  DACS_V7_SAMPLE_RATE_HZ,
  type DacsV7Dwell,
} from './dacs-v7-contract.js';

export {
  isDacsV7SampleRate,
  selectDacsV7Dwell,
  type DacsV7Dwell,
} from './dacs-v7-contract.js';

const DACS_V7_PACKAGE_SCHEMA = 'atomos.dacs-v7.runtime-package';
const DACS_V7_PROTOTYPE_SCHEMA = 'atomos.dacs-v7.fixed-prototypes';
const DACS_V7_RELEASE_MANIFEST_SHA256 =
  '19aaa1b93c8a22a613e18cfee728718a998aec633fc085456fca9c96684f7d1f';
const DACS_V7_MANIFEST = 'runtime-package-manifest.json';
const DACS_V7_MODEL = 'dacs-v7-encoder.onnx';
const DACS_V7_PROTOTYPES = 'dacs-v7-prototypes.json';
const DACS_V7_VALIDATION = 'dacs-v7-validation.json';
const DACS_V7_WASM = 'onnxruntime-wasm-1.27.0.wasm';
const DACS_V7_WASM_SHA256 =
  'd1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6';
const DACS_V7_WASM_BYTES = 13_479_978;
const DACS_V7_PUBLIC_DIRECTORY = 'classifier/v7/';
const DACS_V7_EMBEDDING_DIMENSION = 128;
const NFFT = 64;
const HOP = 32;
const BINS = NFFT / 2 + 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

declare const __ATOMIZER_ORT_EXTERNAL_WASM__: boolean;

export const DACS_V7_CLASSES = [
  'am',
  'bluetooth',
  'cw',
  'dsss',
  'fm',
  'gsm',
  'ofdm',
] as const;

export type DacsV7Class = (typeof DACS_V7_CLASSES)[number];
interface RuntimeAssetDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface DacsV7PrototypeBank {
  readonly logitScale: number;
  readonly byDwell: Readonly<Record<DacsV7Dwell, readonly Float32Array[]>>;
}

interface DacsV7LoadedRuntime {
  readonly session: InferenceSession;
  createTensor(data: Float32Array, dimensions: readonly number[]): Tensor;
  readonly prototypes: DacsV7PrototypeBank;
}

type DacsV7Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DacsV7RuntimeOptions {
  readonly manifestUrl?: string | URL;
  readonly wasmUrl?: string | URL;
  readonly fetcher?: DacsV7Fetch;
}

export interface DacsV7Spectrogram {
  readonly data: Float32Array;
  readonly frames: number;
  readonly bins: number;
}

export interface DacsV7Classification {
  readonly family: DacsV7Class;
  readonly confidence: number;
  readonly posterior: Readonly<Record<DacsV7Class, number>>;
  readonly candidates: readonly {
    readonly label: DacsV7Class;
    readonly confidence: number;
  }[];
  readonly dwell: DacsV7Dwell;
  readonly dwellSamples: number;
  readonly confidenceLogit: number;
  readonly executionProvider: 'wasm';
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExact(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) {
    throw new RangeError(`${path} must be ${JSON.stringify(expected)}`);
  }
}

function requireExactArray(
  value: unknown,
  expected: readonly unknown[],
  path: string,
): void {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((entry, index) => entry !== expected[index])
  ) {
    throw new RangeError(`${path} does not match the sealed DACS v7 release`);
  }
}

function requireSha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function runtimeAssetUrl(filename: string): URL {
  if (typeof globalThis.location?.href !== 'string') {
    throw new Error('the DACS v7 runtime package URL is unavailable');
  }
  const locationUrl = new URL(globalThis.location.href);
  if (locationUrl.protocol === 'file:') {
    return new URL(`atomizer-classifier://runtime/v7/${filename}`);
  }
  return new URL(`/${DACS_V7_PUBLIC_DIRECTORY}${filename}`, locationUrl.origin);
}

function runtimeWasmUrl(): URL {
  return runtimeAssetUrl(DACS_V7_WASM);
}

function runtimeModuleUrl(): URL {
  if (typeof globalThis.location?.href !== 'string') {
    throw new Error('the ONNX Runtime module URL is unavailable');
  }
  return new URL(onnxRuntimeModuleUrl, globalThis.location.href);
}

function resolveUrl(
  value: string | URL | undefined,
  defaultFilename: string,
): URL {
  if (value === undefined) return runtimeAssetUrl(defaultFilename);
  try {
    return new URL(value);
  } catch {
    return new URL(value, runtimeAssetUrl(defaultFilename));
  }
}

async function responseBytes(
  fetcher: DacsV7Fetch,
  url: URL,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(url, {
    cache: 'no-cache',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`DACS v7 runtime asset fetch failed (${response.status} ${url})`);
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(statedLength)
      || !Number.isSafeInteger(Number(statedLength))
    ) {
      throw new RangeError(`DACS v7 runtime asset has an invalid byte length (${url})`);
    }
    if (Number(statedLength) > maximumBytes) {
      throw new RangeError(`DACS v7 runtime asset exceeds its byte limit (${url})`);
    }
  }
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) {
      throw new RangeError(`DACS v7 runtime asset exceeds its byte limit (${url})`);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Uint8Array.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RangeError(`DACS v7 runtime asset exceeds its byte limit (${url})`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array<ArrayBuffer>, path: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${path} is not valid UTF-8`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${path} is not valid JSON`);
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function descriptor(
  value: unknown,
  path: string,
  expectedPath: string,
  expectedSchema: string,
  maximumBytes: number,
): RuntimeAssetDescriptor {
  const asset = record(value, path);
  requireExact(asset.path, expectedPath, `${path}.path`);
  requireExact(asset.schema, expectedSchema, `${path}.schema`);
  if (
    typeof asset.bytes !== 'number'
    || !Number.isSafeInteger(asset.bytes)
    || asset.bytes <= 0
    || asset.bytes > maximumBytes
  ) {
    throw new RangeError(`${path}.bytes is outside its release bound`);
  }
  return {
    path: expectedPath,
    bytes: asset.bytes,
    sha256: requireSha256(asset.sha256, `${path}.sha256`),
  };
}

function validateManifest(value: unknown): {
  readonly encoder: RuntimeAssetDescriptor;
  readonly prototypes: RuntimeAssetDescriptor;
} {
  const manifest = record(value, 'DACS v7 package manifest');
  requireExact(manifest.schema, DACS_V7_PACKAGE_SCHEMA, 'manifest.schema');
  requireExact(manifest.schema_version, 1, 'manifest.schema_version');
  requireExact(manifest.status, 'release', 'manifest.status');
  requireExact(manifest.development_only, false, 'manifest.development_only');
  requireExactArray(manifest.classes, DACS_V7_CLASSES, 'manifest.classes');

  const architecture = record(manifest.architecture, 'manifest.architecture');
  requireExact(architecture.name, 'DACS', 'manifest.architecture.name');
  requireExact(architecture.model_line, 'v7', 'manifest.architecture.model_line');
  requireExact(
    architecture.embedding_dimension,
    DACS_V7_EMBEDDING_DIMENSION,
    'manifest.architecture.embedding_dimension',
  );
  const preprocessing = record(
    architecture.preprocessing,
    'manifest.architecture.preprocessing',
  );
  requireExact(preprocessing.nfft, NFFT, 'manifest.preprocessing.nfft');
  requireExact(preprocessing.hop, HOP, 'manifest.preprocessing.hop');
  requireExact(preprocessing.periodic_hann, true, 'manifest.preprocessing.periodic_hann');
  requireExact(preprocessing.bins, BINS, 'manifest.preprocessing.bins');
  requireExactArray(
    preprocessing.channels,
    ['real', 'imaginary', 'log1p_magnitude'],
    'manifest.preprocessing.channels',
  );

  const constraints = record(
    manifest.runtime_constraints,
    'manifest.runtime_constraints',
  );
  requireExact(
    constraints.sample_rate_hz,
    DACS_V7_SAMPLE_RATE_HZ,
    'manifest.runtime_constraints.sample_rate_hz',
  );
  requireExact(
    constraints.resampling_in_runtime,
    false,
    'manifest.runtime_constraints.resampling_in_runtime',
  );
  requireExact(
    constraints.closed_set_only,
    true,
    'manifest.runtime_constraints.closed_set_only',
  );
  requireExact(
    constraints.released_open_set_gate_required_ahead_of_dacs,
    true,
    'manifest.runtime_constraints.released_open_set_gate_required_ahead_of_dacs',
  );
  requireExact(
    constraints.confidence_head_decision_authority,
    false,
    'manifest.runtime_constraints.confidence_head_decision_authority',
  );
  requireExactArray(
    constraints.supported_dwell_samples,
    Object.values(DACS_V7_DWELL_SAMPLES),
    'manifest.runtime_constraints.supported_dwell_samples',
  );

  const assets = record(manifest.assets, 'manifest.assets');
  const assetKeys = Object.keys(assets).sort();
  requireExactArray(assetKeys, ['encoder', 'prototypes', 'validation'], 'manifest.assets keys');
  const encoder = descriptor(
    assets.encoder,
    'manifest.assets.encoder',
    DACS_V7_MODEL,
    'onnx.ModelProto.opset18',
    8 * 1024 * 1024,
  );
  const prototypes = descriptor(
    assets.prototypes,
    'manifest.assets.prototypes',
    DACS_V7_PROTOTYPES,
    DACS_V7_PROTOTYPE_SCHEMA,
    256 * 1024,
  );
  descriptor(
    assets.validation,
    'manifest.assets.validation',
    DACS_V7_VALIDATION,
    'atomos.dacs-v7.fixed-prototype-validation',
    256 * 1024,
  );
  return { encoder, prototypes };
}

async function verifiedAsset(
  fetcher: DacsV7Fetch,
  manifestUrl: URL,
  asset: RuntimeAssetDescriptor,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await responseBytes(
    fetcher,
    new URL(asset.path, manifestUrl),
    asset.bytes,
  );
  if (bytes.byteLength !== asset.bytes) {
    throw new RangeError(`${asset.path} byte length does not match its manifest`);
  }
  if (await sha256Hex(bytes) !== asset.sha256) {
    throw new RangeError(`${asset.path} SHA-256 does not match its manifest`);
  }
  return bytes;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite`);
  }
  return value;
}

function validatePrototypes(value: unknown): DacsV7PrototypeBank {
  const prototypes = record(value, 'DACS v7 prototypes');
  requireExact(prototypes.schema, DACS_V7_PROTOTYPE_SCHEMA, 'prototypes.schema');
  requireExact(prototypes.schema_version, 1, 'prototypes.schema_version');
  requireExact(prototypes.sample_rate_hz, DACS_V7_SAMPLE_RATE_HZ, 'prototypes.sample_rate_hz');
  requireExact(
    prototypes.embedding_dimension,
    DACS_V7_EMBEDDING_DIMENSION,
    'prototypes.embedding_dimension',
  );
  requireExactArray(prototypes.classes, DACS_V7_CLASSES, 'prototypes.classes');
  const dwellSamples = record(prototypes.dwell_samples, 'prototypes.dwell_samples');
  const source = record(
    prototypes.prototypes_by_dwell,
    'prototypes.prototypes_by_dwell',
  );
  const byDwell = {} as Record<DacsV7Dwell, readonly Float32Array[]>;
  for (const dwell of Object.keys(DACS_V7_DWELL_SAMPLES) as DacsV7Dwell[]) {
    requireExact(
      dwellSamples[dwell],
      DACS_V7_DWELL_SAMPLES[dwell],
      `prototypes.dwell_samples.${dwell}`,
    );
    const classes = source[dwell];
    if (!Array.isArray(classes) || classes.length !== DACS_V7_CLASSES.length) {
      throw new RangeError(`prototypes.${dwell} must contain seven classes`);
    }
    byDwell[dwell] = classes.map((candidate, classIndex) => {
      if (
        !Array.isArray(candidate)
        || candidate.length !== DACS_V7_EMBEDDING_DIMENSION
      ) {
        throw new RangeError(
          `prototypes.${dwell}[${classIndex}] must contain 128 values`,
        );
      }
      return Float32Array.from(candidate.map((entry, index) =>
        finiteNumber(entry, `prototypes.${dwell}[${classIndex}][${index}]`)));
    });
  }
  return {
    logitScale: finiteNumber(prototypes.logit_scale, 'prototypes.logit_scale'),
    byDwell,
  };
}

const HANN = Float32Array.from(
  { length: NFFT },
  (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / NFFT),
);
const BIT_REVERSE = Uint8Array.from({ length: NFFT }, (_, value) => {
  let source = value;
  let reversed = 0;
  for (let bit = 0; bit < 6; bit += 1) {
    reversed = (reversed << 1) | (source & 1);
    source >>= 1;
  }
  return reversed;
});
const FFT_STAGES = [2, 4, 8, 16, 32, 64].map((size) => {
  const half = size / 2;
  return {
    size,
    half,
    twiddleReal: Array.from(
      { length: half },
      (_, index) => Math.cos(-2 * Math.PI * index / size),
    ),
    twiddleImaginary: Array.from(
      { length: half },
      (_, index) => Math.sin(-2 * Math.PI * index / size),
    ),
  };
});

/** Exact browser counterpart of the training RMS + Hann-64/hop-32 FFT path. */
export function dacsV7Spectrogram(
  real: ArrayLike<number>,
  imaginary: ArrayLike<number>,
  dwell: DacsV7Dwell,
): DacsV7Spectrogram {
  const sampleCount = DACS_V7_DWELL_SAMPLES[dwell];
  if (real.length !== imaginary.length || real.length < sampleCount) {
    throw new RangeError(`DACS ${dwell} requires ${sampleCount} parallel I/Q samples`);
  }
  let power = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const re = Math.fround(real[index]!);
    const im = Math.fround(imaginary[index]!);
    if (!Number.isFinite(re) || !Number.isFinite(im)) {
      throw new RangeError('DACS input samples must be finite');
    }
    power += re * re + im * im;
  }
  const inverseRms = 1 / Math.max(Math.sqrt(power / sampleCount), 1e-9);
  const frames = Math.floor((sampleCount - NFFT) / HOP) + 1;
  const planeSize = frames * BINS;
  const output = new Float32Array(3 * planeSize);
  const fftReal = new Float32Array(NFFT);
  const fftImaginary = new Float32Array(NFFT);

  for (let frame = 0; frame < frames; frame += 1) {
    const frameStart = frame * HOP;
    for (let index = 0; index < NFFT; index += 1) {
      const target = BIT_REVERSE[index]!;
      const window = HANN[index]! * inverseRms;
      fftReal[target] = Math.fround(Math.fround(real[frameStart + index]!) * window);
      fftImaginary[target] = Math.fround(
        Math.fround(imaginary[frameStart + index]!) * window,
      );
    }
    for (const stage of FFT_STAGES) {
      for (let start = 0; start < NFFT; start += stage.size) {
        for (let index = 0; index < stage.half; index += 1) {
          const twiddleReal = stage.twiddleReal[index]!;
          const twiddleImaginary = stage.twiddleImaginary[index]!;
          const even = start + index;
          const odd = even + stage.half;
          const oddReal = fftReal[odd]!;
          const oddImaginary = fftImaginary[odd]!;
          const productReal = twiddleReal * oddReal - twiddleImaginary * oddImaginary;
          const productImaginary = twiddleReal * oddImaginary + twiddleImaginary * oddReal;
          const evenReal = fftReal[even]!;
          const evenImaginary = fftImaginary[even]!;
          fftReal[even] = Math.fround(evenReal + productReal);
          fftImaginary[even] = Math.fround(evenImaginary + productImaginary);
          fftReal[odd] = Math.fround(evenReal - productReal);
          fftImaginary[odd] = Math.fround(evenImaginary - productImaginary);
        }
      }
    }
    const frameOffset = frame * BINS;
    for (let bin = 0; bin < BINS; bin += 1) {
      const re = fftReal[bin]!;
      const im = fftImaginary[bin]!;
      const offset = frameOffset + bin;
      output[offset] = re;
      output[planeSize + offset] = im;
      output[2 * planeSize + offset] = Math.fround(
        Math.log1p(Math.hypot(re, im)),
      );
    }
  }
  return { data: output, frames, bins: BINS };
}

async function createRuntime(
  options: DacsV7RuntimeOptions,
): Promise<DacsV7LoadedRuntime> {
  const manifestUrl = resolveUrl(options.manifestUrl, DACS_V7_MANIFEST);
  const wasmUrl = options.wasmUrl === undefined
    ? runtimeWasmUrl()
    : resolveUrl(options.wasmUrl, DACS_V7_WASM);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const [manifestBytes, wasmBytes] = await Promise.all([
    responseBytes(fetcher, manifestUrl, 256 * 1024),
    responseBytes(fetcher, wasmUrl, DACS_V7_WASM_BYTES),
  ]);
  if (await sha256Hex(manifestBytes) !== DACS_V7_RELEASE_MANIFEST_SHA256) {
    throw new RangeError(
      'production DACS v7 manifest SHA-256 does not match the sealed release',
    );
  }
  if (
    wasmBytes.byteLength !== DACS_V7_WASM_BYTES
    || await sha256Hex(wasmBytes) !== DACS_V7_WASM_SHA256
  ) {
    throw new RangeError('ONNX Runtime WASM does not match the sealed release');
  }
  const assets = validateManifest(parseJson(manifestBytes, DACS_V7_MANIFEST));
  const [modelBytes, prototypeBytes] = await Promise.all([
    verifiedAsset(fetcher, manifestUrl, assets.encoder),
    verifiedAsset(fetcher, manifestUrl, assets.prototypes),
  ]);
  const prototypes = validatePrototypes(
    parseJson(prototypeBytes, DACS_V7_PROTOTYPES),
  );

  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  if (
    typeof __ATOMIZER_ORT_EXTERNAL_WASM__ !== 'undefined'
    && __ATOMIZER_ORT_EXTERNAL_WASM__
  ) {
    ort.env.wasm.wasmPaths = { mjs: runtimeModuleUrl().href };
  }
  ort.env.wasm.wasmBinary = wasmBytes.buffer;
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return {
    session,
    createTensor: (data, dimensions) =>
      new ort.Tensor('float32', data, [...dimensions]),
    prototypes,
  };
}

let productionRuntime: Promise<DacsV7LoadedRuntime> | undefined;

async function loadRuntime(
  options?: DacsV7RuntimeOptions,
): Promise<DacsV7LoadedRuntime> {
  if (options) return createRuntime(options);
  if (!productionRuntime) {
    const attempt = createRuntime({});
    productionRuntime = attempt;
    void attempt.catch(() => {
      if (productionRuntime === attempt) productionRuntime = undefined;
    });
  }
  return productionRuntime;
}

function classifyEmbedding(
  embedding: ArrayLike<number>,
  confidenceLogit: number,
  dwell: DacsV7Dwell,
  prototypes: DacsV7PrototypeBank,
): DacsV7Classification {
  if (embedding.length !== DACS_V7_EMBEDDING_DIMENSION) {
    throw new RangeError('DACS encoder returned the wrong embedding dimension');
  }
  for (let index = 0; index < embedding.length; index += 1) {
    finiteNumber(embedding[index], `DACS embedding[${index}]`);
  }
  const distances = prototypes.byDwell[dwell].map((prototype) => {
    let sum = 0;
    for (let index = 0; index < DACS_V7_EMBEDDING_DIMENSION; index += 1) {
      const difference = embedding[index]! - prototype[index]!;
      sum += difference * difference;
    }
    return finiteNumber(sum, 'DACS prototype distance');
  });
  const scale = Math.min(100, Math.max(1e-3, Math.exp(prototypes.logitScale)));
  const logits = distances.map((distance) => -distance * scale);
  const maximum = Math.max(...logits);
  const exponentials = logits.map((logit) => Math.exp(logit - maximum));
  const normalizer = exponentials.reduce((sum, value) => sum + value, 0);
  const ranked = DACS_V7_CLASSES.map((label, index) => ({
    label,
    confidence: exponentials[index]! / normalizer,
  })).sort((left, right) =>
    right.confidence - left.confidence || left.label.localeCompare(right.label));
  const posterior = Object.fromEntries(
    ranked.map(({ label, confidence }) => [label, confidence]),
  ) as Record<DacsV7Class, number>;
  return {
    family: ranked[0]!.label,
    confidence: ranked[0]!.confidence,
    posterior,
    candidates: ranked.slice(0, 4),
    dwell,
    dwellSamples: DACS_V7_DWELL_SAMPLES[dwell],
    confidenceLogit: finiteNumber(confidenceLogit, 'DACS confidence logit'),
    executionProvider: 'wasm',
  };
}

/** Run the sealed DACS v7 release. An upstream open-set gate is mandatory. */
export async function classifyDacsV7(
  real: ArrayLike<number>,
  imaginary: ArrayLike<number>,
  dwell: DacsV7Dwell,
  options?: DacsV7RuntimeOptions,
): Promise<DacsV7Classification> {
  const runtime = await loadRuntime(options);
  const spectrogram = dacsV7Spectrogram(real, imaginary, dwell);
  const outputs = await runtime.session.run({
    spectrogram: runtime.createTensor(
      spectrogram.data,
      [1, 3, spectrogram.frames, spectrogram.bins],
    ),
  });
  const embedding = outputs.embedding?.data;
  const confidence = outputs.confidence_logit?.data;
  if (
    !(embedding instanceof Float32Array)
    || !(confidence instanceof Float32Array)
    || confidence.length !== 1
  ) {
    throw new Error('DACS encoder returned an incomplete output');
  }
  return classifyEmbedding(
    embedding,
    confidence[0]!,
    dwell,
    runtime.prototypes,
  );
}
