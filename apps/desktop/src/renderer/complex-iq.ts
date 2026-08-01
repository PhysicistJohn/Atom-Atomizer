import { decodeComplexSample } from '@atomos/dsp';
import {
  complexIqPayloadByteLength,
  type InstrumentConfiguration,
  type InstrumentMeasurement,
} from '@tinysa/contracts';

export type ComplexIqConfiguration = Extract<InstrumentConfiguration, { kind: 'complex-iq' }>;
export type ComplexIqMeasurement = Extract<InstrumentMeasurement, { kind: 'complex-iq' }>;

/** Largest contiguous capture prefix used by blind constellation recovery. */
export const COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT = 16_384;

export interface ComplexIqPoint {
  readonly sampleIndex: number;
  readonly i: number;
  readonly q: number;
}

export interface ComplexIqPreview {
  readonly points: readonly ComplexIqPoint[];
  readonly inspectedSampleCount: number;
  readonly rms: number;
  readonly peak: number;
  readonly dcI: number;
  readonly dcQ: number;
}

/**
 * Decode an evenly sampled, bounded preview from a compact interleaved capture.
 * UI work stays fixed even when a hardware driver returns the 64 MiB v1 limit.
 */
export function previewComplexIq(
  capture: Pick<ComplexIqMeasurement, 'samples' | 'sampleCount' | 'sampleFormat' | 'adcFullScaleCode'>,
  maximumPoints = 4_096,
): ComplexIqPreview {
  if (!Number.isSafeInteger(maximumPoints) || maximumPoints < 1 || maximumPoints > COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT) {
    throw new RangeError(`I/Q preview point budget must be an integer from 1 through ${COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT}`);
  }
  const expectedBytes = complexIqPayloadByteLength(capture.sampleCount, capture.sampleFormat);
  if (capture.samples.byteLength !== expectedBytes) {
    throw new RangeError(`I/Q payload contains ${capture.samples.byteLength} bytes; expected ${expectedBytes}`);
  }

  const inspectedSampleCount = Math.min(capture.sampleCount, maximumPoints);
  const points: ComplexIqPoint[] = [];
  const view = new DataView(capture.samples.buffer, capture.samples.byteOffset, capture.samples.byteLength);
  let sumMagnitudeSquared = 0;
  let peak = 0;
  let sumI = 0;
  let sumQ = 0;

  for (let previewIndex = 0; previewIndex < inspectedSampleCount; previewIndex++) {
    const sampleIndex = inspectedSampleCount === 1
      ? 0
      : Math.round(previewIndex * (capture.sampleCount - 1) / (inspectedSampleCount - 1));
    const [i, q] = decodeComplexSample(view, sampleIndex, capture.sampleFormat, {
      fullScaleCode: capture.adcFullScaleCode,
    });
    if (!Number.isFinite(i) || !Number.isFinite(q)) {
      throw new RangeError(`I/Q preview encountered a non-finite component at complex sample ${sampleIndex}`);
    }
    const magnitudeSquared = i * i + q * q;
    sumMagnitudeSquared += magnitudeSquared;
    peak = Math.max(peak, Math.sqrt(magnitudeSquared));
    sumI += i;
    sumQ += q;
    points.push({ sampleIndex, i, q });
  }

  return {
    points,
    inspectedSampleCount,
    rms: Math.sqrt(sumMagnitudeSquared / inspectedSampleCount),
    peak,
    dcI: sumI / inspectedSampleCount,
    dcQ: sumQ / inspectedSampleCount,
  };
}

/**
 * Decode a CONTIGUOUS full-resolution prefix of a capture into separate I and Q
 * `Float64Array` channels — the numeric form the embedding modulation classifier
 * consumes. Unlike {@link previewComplexIq} (which subsamples for plotting), this
 * keeps samples contiguous so band detection and resampling are meaningful.
 * The caller selects `maxSamples` from the classifier's admitted capture-length
 * contract; this decoder only validates byte geometry and materializes that
 * bounded prefix.
 */
export function decodeComplexIqChannels(
  capture: Pick<ComplexIqMeasurement, 'samples' | 'sampleCount' | 'sampleFormat' | 'adcFullScaleCode'>,
  maxSamples = 4_096,
): { re: Float64Array; im: Float64Array } {
  const expectedBytes = complexIqPayloadByteLength(capture.sampleCount, capture.sampleFormat);
  if (capture.samples.byteLength !== expectedBytes) {
    throw new RangeError(`I/Q payload contains ${capture.samples.byteLength} bytes; expected ${expectedBytes}`);
  }
  const n = Math.min(capture.sampleCount, Math.max(1, maxSamples));
  const view = new DataView(capture.samples.buffer, capture.samples.byteOffset, capture.samples.byteLength);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const [i, q] = decodeComplexSample(view, k, capture.sampleFormat, {
      fullScaleCode: capture.adcFullScaleCode,
    });
    re[k] = i;
    im[k] = q;
  }
  return { re, im };
}
