import {
  complexIqConfigurationSchema,
  complexIqPayloadByteLength,
  type ComplexIqSampleFormat,
  type InstrumentAcquisitionCapability,
  type InstrumentConfiguration,
  type InstrumentMeasurement,
} from '@tinysa/contracts';

export type ComplexIqCapability = Extract<InstrumentAcquisitionCapability, { kind: 'complex-iq' }>;
export type ComplexIqConfiguration = Extract<InstrumentConfiguration, { kind: 'complex-iq' }>;
export type ComplexIqMeasurement = Extract<InstrumentMeasurement, { kind: 'complex-iq' }>;

export const DEFAULT_COMPLEX_IQ_CONFIGURATION: ComplexIqConfiguration = {
  kind: 'complex-iq',
  centerHz: 100_000_000,
  sampleRateHz: 2_000_000,
  bandwidthHz: 1_500_000,
  sampleCount: 65_536,
  sampleFormat: 'cf32le',
};

type NumericRange = Readonly<{ min: number; max: number; step?: number }>;

/**
 * Reconcile persisted I/Q staging to a newly connected driver's exact lattice.
 * The returned values are meant to be shown to the operator before configure.
 */
export function reconcileComplexIqConfiguration(
  capability: ComplexIqCapability,
  staged: ComplexIqConfiguration,
): ComplexIqConfiguration {
  const centerHz = reconcileRangeValue(staged.centerHz, capability.centerFrequencyHz);
  let sampleRateHz: number;
  let bandwidthHz: number;

  if (capability.bandwidthMode === 'equal-to-sample-rate') {
    const sharedRate = nearestSharedRangeValue(
      staged.sampleRateHz,
      capability.sampleRateHz,
      capability.bandwidthHz,
    );
    if (sharedRate === undefined) {
      throw new RangeError('Equal-rate complex-I/Q capability contains no shared sample-rate/bandwidth value');
    }
    sampleRateHz = sharedRate;
    bandwidthHz = sharedRate;
  } else {
    sampleRateHz = reconcileRangeValue(staged.sampleRateHz, capability.sampleRateHz);
    bandwidthHz = reconcileRangeValue(staged.bandwidthHz, capability.bandwidthHz);

    if (bandwidthHz > sampleRateHz) {
      const bandwidthAtRate = greatestAdmittedAtMost(capability.bandwidthHz, sampleRateHz);
      if (bandwidthAtRate !== undefined) {
        bandwidthHz = bandwidthAtRate;
      } else {
        bandwidthHz = capability.bandwidthHz.min;
        const rateForBandwidth = leastAdmittedAtLeast(capability.sampleRateHz, bandwidthHz);
        if (rateForBandwidth === undefined) {
          throw new RangeError('Complex-I/Q capability contains no sample-rate/bandwidth pair');
        }
        sampleRateHz = rateForBandwidth;
      }
    }
  }

  return complexIqConfigurationSchema.parse({
    kind: 'complex-iq',
    centerHz,
    sampleRateHz,
    bandwidthHz,
    sampleCount: reconcileRangeValue(staged.sampleCount, capability.sampleCount),
    sampleFormat: capability.sampleFormat,
  });
}

/** Build and independently range-check the exact I/Q request sent to a driver. */
export function complexIqConfigurationFor(
  capability: ComplexIqCapability,
  staged: ComplexIqConfiguration,
): ComplexIqConfiguration {
  const configuration = complexIqConfigurationSchema.parse(staged);
  requireRange(configuration.centerHz, capability.centerFrequencyHz, 'I/Q center');
  requireRange(configuration.sampleRateHz, capability.sampleRateHz, 'I/Q sample rate');
  requireRange(configuration.bandwidthHz, capability.bandwidthHz, 'I/Q bandwidth');
  requireRange(configuration.sampleCount, capability.sampleCount, 'I/Q sample count');
  if (configuration.sampleFormat !== capability.sampleFormat) {
    throw new RangeError(`I/Q format ${configuration.sampleFormat} is not advertised; expected ${capability.sampleFormat}`);
  }
  if (capability.bandwidthMode === 'equal-to-sample-rate'
    && configuration.bandwidthHz !== configuration.sampleRateHz) {
    throw new RangeError('I/Q bandwidth must equal sample rate for this acquisition capability');
  }
  return configuration;
}

export function sameComplexIqConfiguration(
  left: ComplexIqConfiguration,
  right: ComplexIqConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
  capture: Pick<ComplexIqMeasurement, 'samples' | 'sampleCount' | 'sampleFormat'>,
  maximumPoints = 4_096,
): ComplexIqPreview {
  if (!Number.isSafeInteger(maximumPoints) || maximumPoints < 1 || maximumPoints > 16_384) {
    throw new RangeError('I/Q preview point budget must be an integer from 1 through 16384');
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
    const [i, q] = decodeSample(view, sampleIndex, capture.sampleFormat);
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
 * keeps samples contiguous so band detection and resampling are meaningful. The
 * prefix is bounded (`maxSamples`) so the work stays fixed regardless of the
 * multi-megabyte capture size; the classifier normalizes to a canonical length
 * internally, so a few thousand contiguous samples suffice.
 */
export function decodeComplexIqChannels(
  capture: Pick<ComplexIqMeasurement, 'samples' | 'sampleCount' | 'sampleFormat'>,
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
    const [i, q] = decodeSample(view, k, capture.sampleFormat);
    re[k] = i;
    im[k] = q;
  }
  return { re, im };
}

function decodeSample(view: DataView, sampleIndex: number, format: ComplexIqSampleFormat): readonly [number, number] {
  switch (format) {
    case 'cf32le': {
      const offset = sampleIndex * 8;
      return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true)];
    }
    case 'ci16le': {
      const offset = sampleIndex * 4;
      return [view.getInt16(offset, true) / 32_768, view.getInt16(offset + 2, true) / 32_768];
    }
    case 'ci8': {
      const offset = sampleIndex * 2;
      return [view.getInt8(offset) / 128, view.getInt8(offset + 1) / 128];
    }
    case 'cu8': {
      const offset = sampleIndex * 2;
      return [(view.getUint8(offset) - 127.5) / 127.5, (view.getUint8(offset + 1) - 127.5) / 127.5];
    }
  }
}

function requireRange(value: number, range: NumericRange, label: string): void {
  if (!rangeContains(value, range)) throw new RangeError(`${label} ${value} is outside the advertised capability`);
}

function reconcileRangeValue(value: number, range: NumericRange): number {
  if (rangeContains(value, range)) return value;
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (range.step === undefined) return clamped;
  const maximumIndex = Math.floor((range.max - range.min) / range.step);
  const nearestIndex = Math.max(0, Math.min(maximumIndex, Math.round((clamped - range.min) / range.step)));
  return range.min + nearestIndex * range.step;
}

function rangeContains(value: number, range: NumericRange): boolean {
  if (value < range.min || value > range.max) return false;
  if (range.step === undefined) return true;
  const offset = (value - range.min) / range.step;
  return Math.abs(offset - Math.round(offset)) <= Number.EPSILON * Math.max(8, Math.abs(offset) * 8);
}

function greatestAdmittedAtMost(range: NumericRange, ceiling: number): number | undefined {
  if (ceiling < range.min) return undefined;
  if (range.step === undefined) return Math.min(range.max, ceiling);
  const index = Math.floor((Math.min(range.max, ceiling) - range.min) / range.step);
  return range.min + index * range.step;
}

function leastAdmittedAtLeast(range: NumericRange, floor: number): number | undefined {
  if (floor > range.max) return undefined;
  if (range.step === undefined) return Math.max(range.min, floor);
  const index = Math.max(0, Math.ceil((floor - range.min) / range.step));
  const value = range.min + index * range.step;
  return value <= range.max ? value : undefined;
}

/** Find the admitted common integer nearest the staged rate without walking a
 * potentially terahertz-wide lattice. Capability validation guarantees that a
 * shared value exists, but the renderer still fails closed if an unchecked
 * driver snapshot reaches this boundary. */
function nearestSharedRangeValue(
  target: number,
  left: NumericRange,
  right: NumericRange,
): number | undefined {
  const lower = Math.max(left.min, right.min);
  const upper = Math.min(left.max, right.max);
  if (lower > upper) return undefined;

  if (left.step === undefined && right.step === undefined) {
    return Math.max(lower, Math.min(upper, Math.round(target)));
  }
  if (left.step === undefined) return nearestRangeValueWithin(target, right, lower, upper);
  if (right.step === undefined) return nearestRangeValueWithin(target, left, lower, upper);

  const leftStep = BigInt(left.step);
  const rightStep = BigInt(right.step);
  const divisor = greatestCommonDivisor(leftStep, rightStep);
  const difference = BigInt(right.min) - BigInt(left.min);
  if (difference % divisor !== 0n) return undefined;

  const reducedLeft = leftStep / divisor;
  const reducedRight = rightStep / divisor;
  const multiplier = positiveModulo(
    difference / divisor * modularInverse(reducedLeft, reducedRight),
    reducedRight,
  );
  const firstSolution = BigInt(left.min) + leftStep * multiplier;
  const period = leftStep * reducedRight;
  const lowerBigInt = BigInt(lower);
  const upperBigInt = BigInt(upper);
  const firstInRange = firstSolution >= lowerBigInt
    ? firstSolution
    : firstSolution + divideCeiling(lowerBigInt - firstSolution, period) * period;
  if (firstInRange > upperBigInt) return undefined;

  const targetBigInt = BigInt(Math.max(lower, Math.min(upper, Math.round(target))));
  const candidateIndex = targetBigInt <= firstInRange
    ? 0n
    : (targetBigInt - firstInRange + period / 2n) / period;
  const maximumIndex = (upperBigInt - firstInRange) / period;
  const candidate = firstInRange + (candidateIndex > maximumIndex ? maximumIndex : candidateIndex) * period;
  return Number(candidate);
}

function nearestRangeValueWithin(
  target: number,
  range: NumericRange,
  lower: number,
  upper: number,
): number | undefined {
  if (range.step === undefined) return Math.max(lower, Math.min(upper, Math.round(target)));
  const firstIndex = Math.max(0, Math.ceil((lower - range.min) / range.step));
  const lastIndex = Math.floor((Math.min(upper, range.max) - range.min) / range.step);
  if (firstIndex > lastIndex) return undefined;
  const targetIndex = Math.round((target - range.min) / range.step);
  const index = Math.max(firstIndex, Math.min(lastIndex, targetIndex));
  return range.min + index * range.step;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function modularInverse(value: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let oldR = value;
  let r = modulus;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return positiveModulo(oldS, modulus);
}

function positiveModulo(value: bigint, modulus: bigint): bigint {
  const remainder = value % modulus;
  return remainder < 0n ? remainder + modulus : remainder;
}

function divideCeiling(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}
