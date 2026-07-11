import {
  replayChannelConfigurationSchema,
  synthesizedSignalProfileSchema,
  waveformDescriptorSchema,
  type ReplayChannelConfiguration,
  type SynthesizedSignalProfile,
  type WaveformDescriptor,
} from '@tinysa/contracts';

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

const visualStandard = {
  organization: 'TinySA Atomizer' as const,
  specification: 'Synthetic replay contract',
  clause: 'Visual laboratory profiles',
  revision: '2.1',
  url: 'https://tinysa.org/wiki/',
};

export const waveformCatalog: readonly WaveformDescriptor[] = [
  {
    id: 'cw', label: 'CW carrier', family: 'tone', model: 'Unmodulated carrier', qualification: 'visual',
    centerHz: 98_000_000, occupiedBandwidthHz: 5_000, recommendedSpanHz: 2_000_000,
    standard: visualStandard,
    disclosure: 'Deterministic unmodulated carrier for interaction and marker testing; not a calibrated RF source.',
  },
  {
    id: 'am', label: 'AM replay', family: 'analog', model: 'AM · time-compressed envelope', qualification: 'visual',
    centerHz: 98_000_000, occupiedBandwidthHz: 60_000, recommendedSpanHz: 500_000,
    standard: visualStandard,
    disclosure: 'Carrier and symmetric sidebands use a time-compressed amplitude cycle so modulation is visible sweep to sweep.',
  },
  {
    id: 'fm', label: 'FM replay', family: 'analog', model: 'FM · ±75 kHz deviation', qualification: 'visual',
    centerHz: 98_000_000, occupiedBandwidthHz: 200_000, recommendedSpanHz: 500_000,
    standard: visualStandard,
    disclosure: 'Instantaneous carrier energy traverses a time-compressed ±75 kHz deviation with a residual occupied comb.',
  },
  {
    id: 'gsm-normal-burst', label: 'GSM normal burst', family: 'geran', model: 'GMSK normal-burst spectrum projection', qualification: 'standards-derived',
    centerHz: 947_400_000, occupiedBandwidthHz: 200_000, recommendedSpanHz: 2_000_000,
    standard: { organization: '3GPP', specification: 'TS 45.002', clause: 'Clause 5 · normal burst', revision: '18.0.0', url: 'https://www.3gpp.org/DynaReport/45002.htm' },
    disclosure: 'Standards-derived GMSK occupancy and time-slot replay; it is not a bit-exact or conformance-validated I/Q vector.',
  },
  {
    id: 'lte-etm1.1', label: 'LTE E-TM1.1', family: 'e-utra', model: 'E-UTRA Test Model 1.1 · 20 MHz', qualification: 'standards-derived',
    centerHz: 1_840_000_000, occupiedBandwidthHz: 18_000_000, recommendedSpanHz: 30_000_000,
    standard: { organization: '3GPP', specification: 'TS 36.141', clause: 'Clause 6.1.1 · E-TM1.1', revision: '13.11.0', url: 'https://www.etsi.org/deliver/etsi_ts/136100_136199/136141/13.11.00_60/ts_136141v131100p.pdf' },
    disclosure: 'Standards-derived full-allocation OFDM spectrum projection; no conformance claim is made without a validated I/Q asset.',
  },
  {
    id: 'nr-fr1-tm1.1', label: '5G NR TM1.1', family: 'nr', model: 'NR-FR1-TM1.1 · 100 MHz · 30 kHz SCS', qualification: 'standards-derived',
    centerHz: 3_500_000_000, occupiedBandwidthHz: 98_280_000, recommendedSpanHz: 120_000_000,
    standard: { organization: '3GPP', specification: 'TS 38.141-1', clause: 'Table 4.9.2.2.1-1 · NR-FR1-TM1.1', revision: '18.8.0', url: 'https://www.etsi.org/deliver/etsi_TS/138100_138199/13814101/18.08.00_60/ts_13814101v180800p.pdf' },
    disclosure: 'Standards-derived 273-RB full-allocation spectrum projection; no conformance claim is made without a validated I/Q asset.',
  },
  {
    id: 'wifi6-he-su', label: 'Wi-Fi 6 HE SU', family: 'wlan', model: '802.11ax HE SU PPDU · 20 MHz', qualification: 'standards-derived',
    centerHz: 5_180_000_000, occupiedBandwidthHz: 18_906_250, recommendedSpanHz: 30_000_000,
    standard: { organization: 'IEEE', specification: 'IEEE 802.11ax-2021', clause: 'HE single-user PPDU', revision: '2021', url: 'https://standards.ieee.org/ieee/802.11ax/7180/' },
    disclosure: 'Standards-derived occupied-tone and burst projection. IEEE defines PPDUs rather than a named conformance test model; this is not a validated packet I/Q vector.',
  },
].map((descriptor) => waveformDescriptorSchema.parse(descriptor));

const descriptorById = new Map(waveformCatalog.map((descriptor) => [descriptor.id, descriptor]));

export const DEFAULT_REPLAY_CHANNEL: ReplayChannelConfiguration = replayChannelConfigurationSchema.parse({
  model: 'awgn',
  noiseFloorDbm: -108,
  seed: 407,
  fadingRateHz: 2,
});

export function waveformDescriptor(profile: SynthesizedSignalProfile): WaveformDescriptor {
  const descriptor = descriptorById.get(synthesizedSignalProfileSchema.parse(profile));
  if (!descriptor) throw new Error(`Waveform catalog is missing ${profile}`);
  return structuredClone(descriptor);
}

export function suggestedAnalyzerRange(descriptor: WaveformDescriptor): { startHz: number; stopHz: number } {
  waveformDescriptorSchema.parse(descriptor);
  const startHz = Math.round(descriptor.centerHz - descriptor.recommendedSpanHz / 2);
  const stopHz = Math.round(descriptor.centerHz + descriptor.recommendedSpanHz / 2);
  if (startHz < 0) throw new Error(`Waveform ${descriptor.id} recommends a negative start frequency`);
  return { startHz, stopHz };
}

export function requireConformanceValidated(profile: SynthesizedSignalProfile): WaveformDescriptor {
  const descriptor = waveformDescriptor(profile);
  if (descriptor.qualification !== 'conformance-validated' || !descriptor.assetSha256) {
    throw new Error(`${descriptor.label} is ${descriptor.qualification}; a conformance-validated I/Q asset is not installed`);
  }
  return descriptor;
}

export function synthesizeSpectrum(input: SpectrumSynthesisInput): number[] {
  validateSpectrumInput(input);
  const channel = replayChannelConfigurationSchema.parse(input.channel);
  return Array.from({ length: input.points }, (_, index) => {
    const frequencyHz = input.points === 1
      ? input.startHz
      : input.startHz + (input.stopHz - input.startHz) * index / (input.points - 1);
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
  return Array.from({ length: input.points }, (_, index) => {
    const phase = (index + input.sweepIndex * 3) * Math.PI / 13;
    const normalized = index / Math.max(1, input.points - 1);
    let signalDbm: number;
    switch (input.profile) {
      case 'cw': signalDbm = -52 + 0.25 * Math.sin(phase * 1.7); break;
      case 'am': signalDbm = -68 + 15 * Math.sin(phase); break;
      case 'fm': signalDbm = -56 + 0.35 * Math.sin(phase * 2.3); break;
      case 'gsm-normal-burst': signalDbm = ((index + input.sweepIndex * 7) % 104) < 13 ? -55 : -118; break;
      case 'lte-etm1.1': signalDbm = -65 + 2.4 * smoothNoise(index / 2.5, input.sweepIndex, channel.seed ^ 0x1e7e); break;
      case 'nr-fr1-tm1.1': signalDbm = -64 + 3.1 * smoothNoise(index / 2.1, input.sweepIndex, channel.seed ^ 0x5a11); break;
      case 'wifi6-he-su': signalDbm = ((index + input.sweepIndex * 11) % 89) < 58 ? -61 + 2 * Math.sin(phase * 2.7) : -118; break;
      case 'survey': {
        const envelope = 7 * Math.sin(phase);
        signalDbm = -82 + envelope + (index % 47 < 5 ? 13 : 0);
        break;
      }
      default: assertNever(input.profile);
    }
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
  const descriptor = descriptorById.get(profile);
  if (!descriptor) throw new Error(`Waveform catalog is missing ${profile}`);
  const offsetHz = frequencyHz - descriptor.centerHz;
  const binWidthHz = spanHz / Math.max(1, input.points - 1);
  switch (profile) {
    case 'cw': return bellDbm(-48, offsetHz, Math.max(2_000, binWidthHz * 1.2));
    case 'am': {
      const envelope = 0.5 + 0.5 * Math.sin(input.sweepIndex * 0.45);
      return combineManyDbm([
        bellDbm(-54 + 6 * envelope, offsetHz, Math.max(1_800, binWidthHz * 1.1)),
        bellDbm(-76 + 12 * envelope, offsetHz - 25_000, Math.max(2_000, binWidthHz * 1.2)),
        bellDbm(-76 + 12 * envelope, offsetHz + 25_000, Math.max(2_000, binWidthHz * 1.2)),
      ]);
    }
    case 'fm': {
      const instantaneousOffset = 75_000 * Math.sin(input.sweepIndex * 0.34);
      const carrier = bellDbm(-50, offsetHz - instantaneousOffset, Math.max(2_500, binWidthHz * 1.35));
      const occupied = Math.abs(offsetHz) <= 105_000
        ? -76 + 2.2 * Math.cos(offsetHz / 8_000 + input.sweepIndex * 0.2)
        : Number.NEGATIVE_INFINITY;
      return combineDbm(carrier, occupied);
    }
    case 'gsm-normal-burst': {
      const slotActive = input.sweepIndex % 8 < 2;
      const peak = slotActive ? -55 : -80;
      return peak - 11.5 * (offsetHz / 100_000) ** 2;
    }
    case 'lte-etm1.1': return ofdmProjection(offsetHz, descriptor.occupiedBandwidthHz, -64, 15_000, input.sweepIndex, 0x36_141);
    case 'nr-fr1-tm1.1': return ofdmProjection(offsetHz, descriptor.occupiedBandwidthHz, -63, 30_000, input.sweepIndex, 0x38_141);
    case 'wifi6-he-su': {
      if (input.sweepIndex % 9 >= 7) return Number.NEGATIVE_INFINITY;
      const projected = ofdmProjection(offsetHz, descriptor.occupiedBandwidthHz, -61, 78_125, input.sweepIndex, 0x80_211);
      return Math.abs(offsetHz) < 78_125 ? projected - 12 : projected;
    }
    default: return assertNever(profile);
  }
}

function ofdmProjection(offsetHz: number, occupiedBandwidthHz: number, plateauDbm: number, subcarrierSpacingHz: number, sweepIndex: number, salt: number): number {
  const half = occupiedBandwidthHz / 2;
  const distance = Math.abs(offsetHz);
  if (distance > half + occupiedBandwidthHz * 0.12) return Number.NEGATIVE_INFINITY;
  if (distance > half) {
    const shoulder = (distance - half) / (occupiedBandwidthHz * 0.035);
    return plateauDbm - 12 - 16 * shoulder;
  }
  const edgeTaper = distance > half * 0.965 ? -4 * (distance - half * 0.965) / (half * 0.035) : 0;
  const subcarrierPhase = offsetHz / subcarrierSpacingHz;
  const texture = 0.85 * Math.sin(subcarrierPhase * 0.37 + sweepIndex * 0.41 + salt)
    + 0.55 * Math.cos(subcarrierPhase * 0.11 - sweepIndex * 0.23);
  return plateauDbm + edgeTaper + texture;
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

function smootherStep(value: number): number { return value * value * (3 - 2 * value); }
function lerp(start: number, stop: number, amount: number): number { return start + (stop - start) * amount; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function assertNever(value: never): never { throw new Error(`Unsupported waveform profile: ${String(value)}`); }
