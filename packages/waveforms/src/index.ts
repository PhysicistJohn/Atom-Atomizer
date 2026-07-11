import {
  replayChannelConfigurationSchema,
  synthesizedSignalProfileSchema,
  type ReplayChannelConfiguration,
  type SynthesizedSignalProfile,
  type WaveformDescriptor,
  type WaveformProjection,
} from '@tinysa/contracts';
import { waveformDescriptor } from './catalog.js';

export { requireConformanceValidated, suggestedAnalyzerRange, waveformCatalog, waveformDescriptor } from './catalog.js';

export type ReplayProfile = SynthesizedSignalProfile | 'survey';

export interface SpectrumSynthesisInput {
  profile: ReplayProfile;
  startHz: number;
  stopHz: number;
  points: number;
  sweepIndex: number;
  channel: ReplayChannelConfiguration;
}

export interface ZeroSpanSynthesisInput {
  profile: ReplayProfile;
  points: number;
  sweepIndex: number;
  channel: ReplayChannelConfiguration;
}

export const DEFAULT_REPLAY_CHANNEL: ReplayChannelConfiguration = replayChannelConfigurationSchema.parse({
  model: 'awgn',
  noiseFloorDbm: -108,
  seed: 407,
  fadingRateHz: 2,
});

export function synthesizeSpectrum(input: SpectrumSynthesisInput): number[] {
  validateSpectrumInput(input);
  const channel = replayChannelConfigurationSchema.parse(input.channel);
  return Array.from({ length: input.points }, (_, index) => {
    const frequencyHz = input.startHz + (input.stopHz - input.startHz) * index / (input.points - 1);
    const noiseDbm = receiverNoiseDbm(index, input.points, input.sweepIndex, channel);
    const signalDbm = signalPowerDbm(input.profile, frequencyHz, index, input);
    if (!Number.isFinite(signalDbm)) return noiseDbm;
    const fadingDb = channel.model === 'rayleigh'
      ? rayleighFadingDb(index, input.points, input.sweepIndex, channel)
      : 0;
    return combineDbm(noiseDbm, signalDbm + fadingDb);
  });
}

export function synthesizeZeroSpan(input: ZeroSpanSynthesisInput): number[] {
  if (!Number.isInteger(input.points) || input.points < 1) throw new Error('Zero-span synthesis requires a positive integer point count');
  if (!Number.isInteger(input.sweepIndex) || input.sweepIndex < 0) throw new Error('Zero-span synthesis requires a non-negative integer sweep index');
  const channel = replayChannelConfigurationSchema.parse(input.channel);
  const descriptor = input.profile === 'survey' ? undefined : waveformDescriptor(input.profile);
  return Array.from({ length: input.points }, (_, index) => {
    const phase = (index + input.sweepIndex * 3) * Math.PI / 13;
    const normalized = index / Math.max(1, input.points - 1);
    const signalDbm = zeroSpanSignalDbm(input.profile, descriptor, index, input.sweepIndex, phase);
    const noiseDbm = channel.noiseFloorDbm + awgnPeriodogramDb(index, input.sweepIndex, channel.seed);
    const fadingDb = channel.model === 'rayleigh'
      ? rayleighFadingDb(index, input.points, input.sweepIndex + normalized, channel)
      : 0;
    return combineDbm(noiseDbm, signalDbm + fadingDb);
  });
}

function signalPowerDbm(profile: ReplayProfile, frequencyHz: number, index: number, input: SpectrumSynthesisInput): number {
  const spanHz = input.stopHz - input.startHz;
  const normalized = index / Math.max(1, input.points - 1);
  if (profile === 'survey') {
    return combineManyDbm([
      bellDbm(-54, normalized - 0.23, 0.018),
      bellDbm(-69, normalized - 0.51, 0.045),
      bellDbm(-61, normalized - 0.79, 0.009),
    ]);
  }
  const descriptor = waveformDescriptor(profile);
  const offsetHz = frequencyHz - descriptor.centerHz;
  const binWidthHz = spanHz / Math.max(1, input.points - 1);
  if (profile === 'cw') return bellDbm(-48, offsetHz, Math.max(2_000, binWidthHz * 1.2));
  if (profile === 'am') {
    const envelope = 0.5 + 0.5 * Math.sin(input.sweepIndex * 0.45);
    return combineManyDbm([
      bellDbm(-54 + 6 * envelope, offsetHz, Math.max(1_800, binWidthHz * 1.1)),
      bellDbm(-76 + 12 * envelope, offsetHz - 25_000, Math.max(2_000, binWidthHz * 1.2)),
      bellDbm(-76 + 12 * envelope, offsetHz + 25_000, Math.max(2_000, binWidthHz * 1.2)),
    ]);
  }
  if (profile === 'fm') return fmProjection(offsetHz, binWidthHz, input.sweepIndex);
  return standardsProjection(descriptor, offsetHz, binWidthHz, input.sweepIndex);
}

function fmProjection(offsetHz: number, binWidthHz: number, sweepIndex: number): number {
  const instantaneousOffset = 75_000 * Math.sin(sweepIndex * 0.34);
  const lineWidthHz = Math.max(1_800, binWidthHz * 1.2);
  const carrier = bellDbm(-50, offsetHz - instantaneousOffset, Math.max(2_500, binWidthHz * 1.35));
  const resolvedSidebands = [-3, -2, -1, 1, 2, 3].map((order) => {
    const breathing = 1.2 * Math.sin(sweepIndex * 0.29 + order * 0.8);
    return bellDbm(-80 - Math.abs(order) * 3 + breathing, offsetHz - order * 25_000, lineWidthHz);
  });
  return combineManyDbm([carrier, ...resolvedSidebands]);
}

function standardsProjection(descriptor: WaveformDescriptor, offsetHz: number, binWidthHz: number, sweepIndex: number): number {
  if (!transmissionActive(descriptor.projection.timing, sweepIndex)) return Number.NEGATIVE_INFINITY;
  if (descriptor.family === 'geran') return geranProjection(descriptor, offsetHz, sweepIndex);
  if (descriptor.family === 'wlan') return wlanProjection(descriptor, offsetHz, sweepIndex);
  if (descriptor.family !== 'e-utra' && descriptor.family !== 'nr') throw new Error(`No standards projection exists for ${descriptor.id}`);
  return cellularProjection(descriptor, offsetHz, binWidthHz, sweepIndex);
}

function geranProjection(descriptor: WaveformDescriptor, offsetHz: number, sweepIndex: number): number {
  const half = descriptor.occupiedBandwidthHz / 2;
  if (Math.abs(offsetHz) > half * 2.4) return Number.NEGATIVE_INFINITY;
  const modulationBroadening = modulationTexture(descriptor.projection.modulation);
  const normalized = offsetHz / half;
  const main = -55 - (descriptor.projection.modulation === 'gmsk' ? 11.5 : 8.5) * normalized ** 2;
  const structured = 0.7 * modulationBroadening * Math.cos(offsetHz / 18_000 + sweepIndex * 0.21);
  return main + structured;
}

function cellularProjection(descriptor: WaveformDescriptor, offsetHz: number, binWidthHz: number, sweepIndex: number): number {
  const spacingHz = descriptor.projection.subcarrierSpacingHz;
  if (!spacingHz) throw new Error(`${descriptor.id} is missing subcarrier spacing`);
  const textureScale = modulationTexture(descriptor.projection.modulation);
  if (descriptor.projection.allocation === 'narrowband') {
    return ofdmProjection(offsetHz, descriptor.occupiedBandwidthHz, -65, spacingHz, sweepIndex, hashText(descriptor.id), textureScale);
  }
  if (descriptor.projection.allocation === 'single-prb') {
    const fullGridHz = descriptor.family === 'e-utra' ? 18_000_000 : 98_280_000;
    const positions = [-0.38, -0.19, 0, 0.21, 0.39];
    const prbCenterHz = positions[sweepIndex % positions.length]! * fullGridHz;
    const prbWidthHz = spacingHz * 12;
    const measuredPrb = ofdmProjection(offsetHz - prbCenterHz, prbWidthHz, -62, spacingHz, sweepIndex, hashText(descriptor.id), textureScale);
    const physicalChannels = ofdmProjection(offsetHz, fullGridHz, -96, spacingHz, sweepIndex, hashText(`${descriptor.id}:control`), 0.4);
    return combineDbm(measuredPrb, physicalChannels);
  }
  const base = ofdmProjection(offsetHz, descriptor.occupiedBandwidthHz, descriptor.family === 'e-utra' ? -64 : -63, spacingHz, sweepIndex, hashText(descriptor.id), textureScale);
  if (descriptor.projection.allocation !== 'boosted' || !Number.isFinite(base)) return base;
  const rbWidthHz = spacingHz * 12;
  const rbIndex = Math.floor((offsetHz + descriptor.occupiedBandwidthHz / 2) / rbWidthHz);
  const boost = (rbIndex + sweepIndex) % 4 === 0 ? 3 : -1.25;
  return base + boost;
}

function wlanProjection(descriptor: WaveformDescriptor, offsetHz: number, sweepIndex: number): number {
  const spacingHz = descriptor.projection.subcarrierSpacingHz;
  if (!spacingHz) throw new Error(`${descriptor.id} is missing subcarrier spacing`);
  let projected = ofdmProjection(offsetHz, descriptor.occupiedBandwidthHz, -61, spacingHz, sweepIndex, hashText(descriptor.id), 1);
  if (!Number.isFinite(projected)) return projected;
  if (descriptor.projection.allocation === 'multi-ru') {
    const normalized = offsetHz / (descriptor.occupiedBandwidthHz / 2);
    const resourceStep = Math.floor((normalized + 1) * 4);
    projected += resourceStep % 2 === 0 ? 1.8 : -2.2;
  }
  if (Math.abs(offsetHz) < spacingHz) projected -= 12;
  return projected;
}

function ofdmProjection(
  offsetHz: number,
  occupiedBandwidthHz: number,
  plateauDbm: number,
  subcarrierSpacingHz: number,
  sweepIndex: number,
  salt: number,
  textureScale: number,
): number {
  const half = occupiedBandwidthHz / 2;
  const distance = Math.abs(offsetHz);
  if (distance > half + occupiedBandwidthHz * 0.12) return Number.NEGATIVE_INFINITY;
  if (distance > half) {
    const shoulder = (distance - half) / (occupiedBandwidthHz * 0.035);
    return plateauDbm - 12 - 16 * shoulder;
  }
  const edgeTaper = distance > half * 0.965 ? -4 * (distance - half * 0.965) / (half * 0.035) : 0;
  const subcarrierPhase = offsetHz / subcarrierSpacingHz;
  const texture = textureScale * (
    0.85 * Math.sin(subcarrierPhase * 0.37 + sweepIndex * 0.41 + salt)
    + 0.55 * Math.cos(subcarrierPhase * 0.11 - sweepIndex * 0.23)
  );
  return plateauDbm + edgeTaper + texture;
}

function zeroSpanSignalDbm(
  profile: ReplayProfile,
  descriptor: WaveformDescriptor | undefined,
  index: number,
  sweepIndex: number,
  phase: number,
): number {
  if (profile === 'survey') return -82 + 7 * Math.sin(phase) + (index % 47 < 5 ? 13 : 0);
  if (profile === 'cw') return -52 + 0.25 * Math.sin(phase * 1.7);
  if (profile === 'am') return -68 + 15 * Math.sin(phase);
  if (profile === 'fm') return -56 + 0.35 * Math.sin(phase * 2.3);
  if (!descriptor) throw new Error(`Waveform descriptor is missing for ${profile}`);
  if (descriptor.family === 'geran') return ((index + sweepIndex * 7) % 104) < 13 ? -55 : -118;
  if (descriptor.family === 'wlan') return wlanZeroSpan(descriptor.id, index, sweepIndex, phase);
  const timing = descriptor.projection.timing;
  if (!transmissionActiveAtSample(timing, index, sweepIndex)) return -118;
  const allocationOffset = descriptor.projection.allocation === 'single-prb' ? -13 : descriptor.projection.allocation === 'narrowband' ? -8 : 0;
  const texture = 2.2 + modulationTexture(descriptor.projection.modulation) * 0.7;
  return -64 + allocationOffset + texture * smoothNoise(index / 2.5, sweepIndex, hashText(descriptor.id));
}

function wlanZeroSpan(profile: SynthesizedSignalProfile, index: number, sweepIndex: number, phase: number): number {
  const coordinate = index + sweepIndex * 11;
  if (profile === 'wifi6-he-er-su') return coordinate % 113 < 84 ? -65 + 1.4 * Math.sin(phase) : -118;
  if (profile === 'wifi6-he-mu') return coordinate % 97 < 72 ? -60 + 3 * smoothNoise(index / 3, sweepIndex, 0x6d75) : -118;
  if (profile === 'wifi6-he-tb') return coordinate % 89 >= 27 && coordinate % 89 < 63 ? -62 + 2.5 * Math.sin(phase * 2.7) : -118;
  return coordinate % 89 < 58 ? -61 + 2 * Math.sin(phase * 2.7) : -118;
}

function transmissionActive(timing: WaveformProjection['timing'], sweepIndex: number): boolean {
  if (timing === 'burst') return sweepIndex % 9 < 7;
  if (timing === 'sbfd-du') return sweepIndex % 2 === 0;
  if (timing === 'sbfd-ud') return sweepIndex % 2 === 1;
  if (timing === 'sbfd-dud') return sweepIndex % 3 !== 1;
  return true;
}

function transmissionActiveAtSample(timing: WaveformProjection['timing'], index: number, sweepIndex: number): boolean {
  const coordinate = index + sweepIndex * 3;
  if (timing === 'subslot') return coordinate % 14 < 4;
  if (timing === 'slot') return coordinate % 28 < 14;
  if (timing === 'sbfd-du') return coordinate % 28 < 14;
  if (timing === 'sbfd-ud') return coordinate % 28 >= 14;
  if (timing === 'sbfd-dud') { const symbol = coordinate % 42; return symbol < 14 || symbol >= 28; }
  return true;
}

function modulationTexture(modulation: WaveformProjection['modulation']): number {
  return ({
    unmodulated: 0, am: 0.2, fm: 0.3, gmsk: 0.3, qpsk: 0.55, aqpsk: 0.65, '8psk': 0.72,
    '16qam': 0.8, '32qam': 0.85, '64qam': 0.9, '256qam': 1.05, '1024qam': 1.2, 'ofdm-mixed': 1, 'he-ofdm': 1,
  })[modulation];
}

function receiverNoiseDbm(index: number, points: number, sweepIndex: number, channel: ReplayChannelConfiguration): number {
  const x = index / Math.max(1, points - 1);
  const broadShape = 1.15 * Math.sin(Math.PI * 2 * (x * 1.45 + 0.08 + sweepIndex * 0.0015))
    + 0.8 * Math.cos(Math.PI * 2 * (x * 3.7 - 0.19));
  const stableRipple = 0.95 * smoothNoise(index / 6.5, 0, channel.seed ^ 0x4a39b70d);
  const edgeLift = 1.2 * Math.pow(Math.abs(x - 0.5) * 2, 1.7);
  const awgn = awgnPeriodogramDb(index, sweepIndex, channel.seed);
  const floor = channel.noiseFloorDbm + broadShape + stableRipple + edgeLift + awgn;
  const spurs = [
    bellDbm(channel.noiseFloorDbm + 6, x - 0.083, 0.0025),
    bellDbm(channel.noiseFloorDbm + 4.5, x - 0.647, 0.0038),
    bellDbm(channel.noiseFloorDbm + 6.5, x - 0.914, 0.0022),
  ];
  return combineDbm(floor, combineManyDbm(spurs));
}

function awgnPeriodogramDb(index: number, sweepIndex: number, seed: number): number {
  let power = 0;
  const looks = 6;
  for (let look = 0; look < looks; look++) {
    const [i, q] = normalPair(index, sweepIndex, seed ^ Math.imul(look + 1, 0x632be59b));
    power += (i * i + q * q) / 2;
  }
  return clamp(10 * Math.log10(power / looks), -8, 6);
}

function rayleighFadingDb(index: number, points: number, sweepIndex: number, channel: ReplayChannelConfiguration): number {
  const frequencyCoordinate = index / Math.max(3, points / 14);
  const timeCoordinate = sweepIndex * Math.min(1, channel.fadingRateHz / 9);
  const [inPhase, quadrature] = interpolatedComplexGaussian(frequencyCoordinate, timeCoordinate, channel.seed ^ 0x72a11e);
  const magnitude = Math.sqrt((inPhase * inPhase + quadrature * quadrature) / 2);
  return clamp(20 * Math.log10(Math.max(0.035, magnitude)), -28, 8);
}

function interpolatedComplexGaussian(x: number, y: number, seed: number): readonly [number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smootherStep(x - x0);
  const ty = smootherStep(y - y0);
  const sample = (xi: number, yi: number): readonly [number, number] => normalPair(xi, yi, seed);
  const a = sample(x0, y0);
  const b = sample(x0 + 1, y0);
  const c = sample(x0, y0 + 1);
  const d = sample(x0 + 1, y0 + 1);
  return [
    lerp(lerp(a[0], b[0], tx), lerp(c[0], d[0], tx), ty),
    lerp(lerp(a[1], b[1], tx), lerp(c[1], d[1], tx), ty),
  ];
}

function normalPair(index: number, sweepIndex: number, seed: number): readonly [number, number] {
  const first = Math.max(Number.EPSILON, uniform(index, sweepIndex, seed ^ 0x9e3779b9));
  const second = uniform(index, sweepIndex, seed ^ 0x243f6a88);
  const radius = Math.sqrt(-2 * Math.log(first));
  const angle = Math.PI * 2 * second;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function uniform(index: number, sweepIndex: number, seed: number): number {
  let value = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(sweepIndex + 1, 0x85ebca77) ^ seed;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return ((value >>> 0) + 0.5) / 0x1_0000_0000;
}

function smoothNoise(position: number, sweepIndex: number, seed: number): number {
  const left = Math.floor(position);
  const fraction = smootherStep(position - left);
  const start = uniform(left, sweepIndex, seed) * 2 - 1;
  const stop = uniform(left + 1, sweepIndex, seed) * 2 - 1;
  return lerp(start, stop, fraction);
}

function bellDbm(peakDbm: number, offset: number, width: number): number {
  if (width <= 0) throw new Error('Spectrum bell width must be positive');
  return peakDbm - 4.342944819 * (offset / width) ** 2;
}

function combineDbm(left: number, right: number): number {
  if (!Number.isFinite(left)) return right;
  if (!Number.isFinite(right)) return left;
  const maximum = Math.max(left, right);
  return maximum + 10 * Math.log10(10 ** ((left - maximum) / 10) + 10 ** ((right - maximum) / 10));
}

function combineManyDbm(values: readonly number[]): number {
  return values.reduce(combineDbm, Number.NEGATIVE_INFINITY);
}

function validateSpectrumInput(input: SpectrumSynthesisInput): void {
  if (!Number.isSafeInteger(input.startHz) || !Number.isSafeInteger(input.stopHz) || input.stopHz <= input.startHz) throw new Error('Spectrum synthesis requires an increasing safe-integer frequency range');
  if (!Number.isInteger(input.points) || input.points < 2) throw new Error('Spectrum synthesis requires at least two points');
  if (!Number.isInteger(input.sweepIndex) || input.sweepIndex < 0) throw new Error('Spectrum synthesis requires a non-negative integer sweep index');
  if (input.profile !== 'survey') synthesizedSignalProfileSchema.parse(input.profile);
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash | 0;
}

function smootherStep(value: number): number { return value * value * (3 - 2 * value); }
function lerp(start: number, stop: number, amount: number): number { return start + (stop - start) * amount; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
