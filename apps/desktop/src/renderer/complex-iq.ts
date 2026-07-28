import { decodeComplexSample } from '@atomos/dsp';
import {
  complexIqConfigurationSchema,
  complexIqPayloadByteLength,
  signalLabMinimumDerivedSampleRateHz,
  signalLabOutputOneShotSampleLimit,
  type InstrumentAcquisitionCapability,
  type InstrumentConfiguration,
  type InstrumentMeasurement,
  type SignalLabIqProfileCapability,
} from '@tinysa/contracts';

export type ComplexIqCapability = Extract<InstrumentAcquisitionCapability, { kind: 'complex-iq' }>;
export type ComplexIqConfiguration = Extract<InstrumentConfiguration, { kind: 'complex-iq' }>;
export type ComplexIqMeasurement = Extract<InstrumentMeasurement, { kind: 'complex-iq' }>;

/** Largest contiguous capture prefix used by blind constellation recovery. */
export const COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT = 16_384;

// Default to a wide NeptuneSDR-class capture (56 MHz sample rate, 40 MHz usable
// bandwidth). This is wide enough to represent the single-carrier reference
// waveforms (7 Msym/s => 8 samples/symbol) and any real signal an operator points
// at; a connected driver with a narrower lattice reconciles this down to its own
// capability. The complete 16K buffer is also the largest prefix consumed by
// recovery; synthesizing the former 64K default discarded three quarters of each
// buffer before display. Operators can still stage larger driver-admitted buffers.
export const DEFAULT_COMPLEX_IQ_CONFIGURATION: ComplexIqConfiguration = {
  kind: 'complex-iq',
  centerHz: 100_000_000,
  sampleRateHz: 56_000_000,
  bandwidthHz: 40_000_000,
  sampleCount: COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT,
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

/**
 * Smallest capture bandwidth that still yields exact native bytes.
 *
 * Capture bandwidth is a symmetric passband about the RF tune center, so
 * keeping an artifact's native carrier offset costs `2 * |offset| + signal`.
 * Bluetooth BR sits at -31 MHz inside its 80 Msps artifact and therefore needs
 * 63 MHz; Bluetooth LE sits at -15 MHz and needs 31 MHz. Every zero-offset
 * artifact reduces to its plain signal bandwidth. Rate-flexible generators have
 * no native artifact, so their floor is the signal bandwidth too.
 */
export function signalLabExactNativeCaptureBandwidthHz(
  profile: Pick<
    SignalLabIqProfileCapability,
    'nativeMinimumCaptureBandwidthHz' | 'signalBandwidthHz'
  >,
): number {
  return profile.nativeMinimumCaptureBandwidthHz ?? profile.signalBandwidthHz;
}

/**
 * Stage the selected SignalLab profile at its canonical digital interface.
 * The I/Q transport's profile reference is the profile signal center; it may
 * intentionally differ from the aggregate scalar/catalog reference (Bluetooth
 * is centered at 2.441 GHz while its packet signals are at 2.410/2.426 GHz).
 * Operators may retune centerHz later without changing the source waveform.
 *
 * Capture bandwidth is staged at the exact-native floor rather than the bare
 * signal bandwidth, so an offset artifact such as Bluetooth defaults to bytes
 * that are still the independently verified native ones. A narrower operator
 * request stays legal; it just translates the carrier to DC and downgrades to
 * derived qualification.
 */
export function reconcileSignalLabProfileComplexIqConfiguration(
  capability: ComplexIqCapability,
  profile: SignalLabIqProfileCapability,
  staged: ComplexIqConfiguration,
): ComplexIqConfiguration {
  const base = reconcileComplexIqConfiguration(capability, {
    ...staged,
    centerHz: profile.profileReferenceCenterHz,
  });
  const sampleRateHz = profile.nativeSampleRateHz ?? base.sampleRateHz;
  const bandwidthHz = reconcileRangeValue(
    Math.min(signalLabExactNativeCaptureBandwidthHz(profile), sampleRateHz),
    capability.bandwidthHz,
  );
  const outputLimit = signalLabOutputOneShotSampleLimit(profile, sampleRateHz);
  const sampleCount = outputLimit === undefined
    ? base.sampleCount
    : reconcileRangeValue(Math.min(base.sampleCount, outputLimit), capability.sampleCount);
  const native = complexIqConfigurationSchema.parse({
    ...base,
    sampleRateHz,
    bandwidthHz,
    sampleCount,
  });
  return reconcileSignalLabTransportComplexIqConfiguration(capability, profile, native);
}

/** Reconcile operator-selected output transport while respecting the selected
 * profile's transform support and output-domain one-shot duration. */
export function reconcileSignalLabTransportComplexIqConfiguration(
  capability: ComplexIqCapability,
  profile: SignalLabIqProfileCapability,
  staged: ComplexIqConfiguration,
): ComplexIqConfiguration {
  const base = reconcileComplexIqConfiguration(capability, staged);
  let sampleRateHz = profile.nativeSampleRateHz !== null
    && base.sampleRateHz !== profile.nativeSampleRateHz
    && !profile.derivedTransportSupported
      ? profile.nativeSampleRateHz
      : base.sampleRateHz;
  if (sampleRateHz < profile.signalBandwidthHz) {
    const supportedRate = leastAdmittedAtLeast(capability.sampleRateHz, profile.signalBandwidthHz);
    if (supportedRate === undefined) {
      throw new RangeError(`Complex-I/Q output cannot represent the ${profile.signalBandwidthHz} Hz profile signal bandwidth`);
    }
    sampleRateHz = supportedRate;
  }
  if (profile.nativeSampleRateHz !== null
    && sampleRateHz !== profile.nativeSampleRateHz
    && sampleRateHz < profile.nativeSampleRateHz) {
    const minimumDerivedRate = signalLabMinimumDerivedSampleRateHz(profile.signalBandwidthHz);
    if (sampleRateHz < minimumDerivedRate) {
      const supportedRate = leastAdmittedAtLeast(capability.sampleRateHz, minimumDerivedRate);
      if (supportedRate === undefined) {
        throw new RangeError(`Complex-I/Q output cannot preserve the ${profile.signalBandwidthHz} Hz profile anti-alias support`);
      }
      sampleRateHz = supportedRate;
    }
  }
  let bandwidthHz = base.bandwidthHz;
  if (bandwidthHz < profile.signalBandwidthHz) {
    const supportedBandwidth = leastAdmittedAtLeast(capability.bandwidthHz, profile.signalBandwidthHz);
    if (supportedBandwidth === undefined) {
      throw new RangeError(`Complex-I/Q capture cannot include the ${profile.signalBandwidthHz} Hz profile signal bandwidth`);
    }
    bandwidthHz = supportedBandwidth;
  }
  if (bandwidthHz > sampleRateHz) {
    const supportedRate = leastAdmittedAtLeast(capability.sampleRateHz, bandwidthHz);
    if (supportedRate === undefined) {
      throw new RangeError('Complex-I/Q capability cannot represent the selected capture bandwidth');
    }
    sampleRateHz = supportedRate;
  }
  const outputLimit = signalLabOutputOneShotSampleLimit(profile, sampleRateHz);
  const sampleCount = outputLimit === undefined
    ? base.sampleCount
    : reconcileRangeValue(Math.min(base.sampleCount, outputLimit), capability.sampleCount);
  return complexIqConfigurationFor(capability, complexIqConfigurationSchema.parse({
    ...base,
    sampleRateHz,
    bandwidthHz,
    sampleCount,
  }));
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
    const [i, q] = decodeComplexSample(view, sampleIndex, capture.sampleFormat);
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
    const [i, q] = decodeComplexSample(view, k, capture.sampleFormat);
    re[k] = i;
    im[k] = q;
  }
  return { re, im };
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
