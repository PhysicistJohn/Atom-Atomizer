import type { DetectedSignal, Sweep, WaveformClassification, ZeroSpanCapture } from '@tinysa/contracts';

export const SIGNAL_LAB_EMSO_MODEL = {
  id: 'signal-lab-emso-bayes-v1',
  producer: 'tinysa-signal-lab',
  sourceCommit: '942c8f7dfa3215c101c81a183a605ae924b306b1',
  catalogSha256: 'e7c953bd54f120528ebfce361bd306cd4bba2933ea052e9db5c59ab1901df39a',
  generatorSha256: '42cb108a9252f55856ea23712fd5908fe48675773e80ebd980a68b910be95897',
  preprocessing: 'scalar-spectrum-envelope-features-v1',
  taxonomySize: 79,
  minimumSpectrumSweeps: 3,
  maximumSpectrumSweeps: 12,
  minimumInDomainLogLikelihood: -35,
} as const;

type Family = 'tone' | 'analog' | 'geran' | 'e-utra' | 'nr' | 'wlan';
type Allocation = 'carrier' | 'sidebands' | 'full' | 'boosted' | 'single-prb' | 'narrowband' | 'multi-ru' | 'resource-unit';
type Modulation = 'unmodulated' | 'am' | 'fm' | 'gmsk' | 'qpsk' | 'aqpsk' | '8psk' | '16qam' | '32qam' | '64qam' | '256qam' | '1024qam' | 'he-ofdm';
type Timing = 'continuous' | 'burst' | 'frame' | 'subslot' | 'slot' | 'sbfd-du' | 'sbfd-ud' | 'sbfd-dud';

export interface SignalLabWaveformHypothesis {
  id: string;
  label: string;
  family: Family;
  centerHz: number;
  occupiedBandwidthHz: number;
  recommendedSpanHz: number;
  allocation: Allocation;
  modulation: Modulation;
  timing: Timing;
}

export interface WaveformEvidence {
  sweeps: readonly Sweep[];
  zeroSpan?: ZeroSpanCapture;
}

interface SpectrumObservation {
  centerHz: number;
  bandwidthHz: number;
  binWidthHz: number;
  prominenceDb: number;
  activeDuty: number;
  flatness: number;
  entropy: number;
  texture: number;
  symmetry: number;
  centerNotch: number;
  peakDensity: number;
  peakDrift: number;
  powerVariation: number;
  sweeps: readonly string[];
}

interface EnvelopeObservation {
  rangeDb: number;
  standardDeviationDb: number;
  dutyCycle: number;
  transitionRate: number;
  dominantLagFraction: number;
}

interface ExpectedShape {
  flatness: number;
  entropy: number;
  texture: number;
  symmetry: number;
  centerNotch: number;
  peakDensity: number;
  peakDrift: number;
  powerVariation: number;
  activeDuty: number;
}

const gsm = [
  ['gsm-normal-burst', 'GSM GMSK normal burst', 'gmsk', 200_000],
  ['gsm-qpsk-normal-burst', 'GSM QPSK normal burst', 'qpsk', 325_000],
  ['gsm-aqpsk-normal-burst', 'GSM AQPSK normal burst', 'aqpsk', 250_000],
  ['gsm-8psk-normal-burst', 'EDGE 8-PSK normal burst', '8psk', 250_000],
  ['gsm-16qam-normal-burst', 'EGPRS2 16-QAM normal burst', '16qam', 325_000],
  ['gsm-32qam-normal-burst', 'EGPRS2 32-QAM normal burst', '32qam', 325_000],
] as const;

const lte = [
  ['lte-etm1.1', 'LTE E-TM1.1', 'full', 'qpsk', 'frame'],
  ['lte-etm1.2', 'LTE E-TM1.2', 'boosted', 'qpsk', 'frame'],
  ['lte-etm2', 'LTE E-TM2', 'single-prb', '64qam', 'frame'],
  ['lte-etm2a', 'LTE E-TM2a', 'single-prb', '256qam', 'frame'],
  ['lte-etm2b', 'LTE E-TM2b', 'single-prb', '1024qam', 'frame'],
  ['lte-setm2-1', 'LTE sE-TM2-1', 'single-prb', '64qam', 'subslot'],
  ['lte-setm2a-1', 'LTE sE-TM2a-1', 'single-prb', '256qam', 'subslot'],
  ['lte-setm2-2', 'LTE sE-TM2-2', 'single-prb', '64qam', 'slot'],
  ['lte-setm2a-2', 'LTE sE-TM2a-2', 'single-prb', '256qam', 'slot'],
  ['lte-etm3.1', 'LTE E-TM3.1', 'full', '64qam', 'frame'],
  ['lte-etm3.1a', 'LTE E-TM3.1a', 'full', '256qam', 'frame'],
  ['lte-etm3.1b', 'LTE E-TM3.1b', 'full', '1024qam', 'frame'],
  ['lte-setm3.1-1', 'LTE sE-TM3.1-1', 'full', '64qam', 'subslot'],
  ['lte-setm3.1a-1', 'LTE sE-TM3.1a-1', 'full', '256qam', 'subslot'],
  ['lte-setm3.1-2', 'LTE sE-TM3.1-2', 'full', '64qam', 'slot'],
  ['lte-setm3.1a-2', 'LTE sE-TM3.1a-2', 'full', '256qam', 'slot'],
  ['lte-etm3.2', 'LTE E-TM3.2', 'boosted', '16qam', 'frame'],
  ['lte-setm3.2-1', 'LTE sE-TM3.2-1', 'boosted', '16qam', 'subslot'],
  ['lte-setm3.2-2', 'LTE sE-TM3.2-2', 'boosted', '16qam', 'slot'],
  ['lte-etm3.3', 'LTE E-TM3.3', 'boosted', 'qpsk', 'frame'],
  ['lte-setm3.3-1', 'LTE sE-TM3.3-1', 'boosted', 'qpsk', 'subslot'],
  ['lte-setm3.3-2', 'LTE sE-TM3.3-2', 'boosted', 'qpsk', 'slot'],
] as const;

const nr = [
  ['nr-fr1-tm1.1', '5G NR-FR1-TM1.1', 'full', 'qpsk'],
  ['nr-fr1-tm1.2', '5G NR-FR1-TM1.2', 'boosted', 'qpsk'],
  ['nr-fr1-tm2', '5G NR-FR1-TM2', 'single-prb', '64qam'],
  ['nr-fr1-tm2a', '5G NR-FR1-TM2a', 'single-prb', '256qam'],
  ['nr-fr1-tm2b', '5G NR-FR1-TM2b', 'single-prb', '1024qam'],
  ['nr-fr1-tm3.1', '5G NR-FR1-TM3.1', 'full', '64qam'],
  ['nr-fr1-tm3.1a', '5G NR-FR1-TM3.1a', 'full', '256qam'],
  ['nr-fr1-tm3.1b', '5G NR-FR1-TM3.1b', 'full', '1024qam'],
  ['nr-fr1-tm3.2', '5G NR-FR1-TM3.2', 'boosted', '16qam'],
  ['nr-fr1-tm3.3', '5G NR-FR1-TM3.3', 'boosted', 'qpsk'],
] as const;

export const signalLabWaveformHypotheses: readonly SignalLabWaveformHypothesis[] = closeHypotheses([
  hypothesis('cw', 'CW carrier', 'tone', 98_000_000, 5_000, 2_000_000, 'carrier', 'unmodulated', 'continuous'),
  hypothesis('am', 'AM replay', 'analog', 98_000_000, 60_000, 500_000, 'sidebands', 'am', 'continuous'),
  hypothesis('fm', 'FM replay', 'analog', 98_000_000, 200_000, 500_000, 'sidebands', 'fm', 'continuous'),
  ...gsm.map(([id, label, modulation, bandwidth]) => hypothesis(id, label, 'geran', 947_400_000, bandwidth, 2_000_000, 'narrowband', modulation, 'burst')),
  ...lte.map(([id, label, allocation, modulation, timing]) => hypothesis(id, label, 'e-utra', 1_840_000_000, 18_000_000, 30_000_000, allocation, modulation, timing)),
  hypothesis('lte-ntm', 'LTE N-TM', 'e-utra', 1_840_000_000, 180_000, 2_000_000, 'narrowband', 'qpsk', 'frame'),
  hypothesis('lte-ntm-guard', 'LTE N-TM guard-band', 'e-utra', 1_840_000_000, 180_000, 2_000_000, 'narrowband', 'qpsk', 'frame'),
  hypothesis('lte-ntm-inband', 'LTE N-TM in-band', 'e-utra', 1_840_000_000, 180_000, 2_000_000, 'narrowband', 'qpsk', 'frame'),
  ...nr.map(([id, label, allocation, modulation]) => hypothesis(id, label, 'nr', 3_500_000_000, 98_280_000, 120_000_000, allocation, modulation, 'frame')),
  hypothesis('nr-ntm', '5G NR-N-TM', 'nr', 3_500_000_000, 180_000, 2_000_000, 'narrowband', 'qpsk', 'frame'),
  ...nr.flatMap(([id, label, allocation, modulation]) => (['du', 'ud', 'dud'] as const).map((pattern) => hypothesis(
    `${id}-sbfd-${pattern}`, `${label}_SBFD_${pattern.toUpperCase()}`, 'nr', 3_500_000_000, 98_280_000, 120_000_000,
    allocation, modulation, `sbfd-${pattern}`,
  ))),
  hypothesis('wifi6-he-su', 'Wi-Fi 6 HE SU', 'wlan', 5_180_000_000, 18_906_250, 30_000_000, 'full', 'he-ofdm', 'burst'),
  hypothesis('wifi6-he-er-su', 'Wi-Fi 6 HE ER SU', 'wlan', 5_180_000_000, 8_281_250, 30_000_000, 'resource-unit', 'he-ofdm', 'burst'),
  hypothesis('wifi6-he-mu', 'Wi-Fi 6 HE MU', 'wlan', 5_180_000_000, 18_906_250, 30_000_000, 'multi-ru', 'he-ofdm', 'burst'),
  hypothesis('wifi6-he-tb', 'Wi-Fi 6 HE TB', 'wlan', 5_180_000_000, 18_906_250, 30_000_000, 'multi-ru', 'he-ofdm', 'burst'),
]);

export class SignalLabBayesianClassifier {
  readonly modelId = SIGNAL_LAB_EMSO_MODEL.id;

  async classify(detection: DetectedSignal, evidence: WaveformEvidence, signal?: AbortSignal): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    const sweeps = coherentSweeps(detection, evidence.sweeps).slice(0, SIGNAL_LAB_EMSO_MODEL.maximumSpectrumSweeps);
    if (!sweeps.length) return unknown(detection, [], 'insufficient-evidence');
    const spectrum = observeSpectrum(detection, sweeps);
    const zeroSpan = matchingZeroSpan(detection, spectrum.binWidthHz, evidence.zeroSpan);
    const envelope = zeroSpan ? observeEnvelope(zeroSpan) : undefined;
    const eligible = signalLabWaveformHypotheses.filter((item) => Math.abs(spectrum.centerHz - item.centerHz) <= item.recommendedSpanHz / 2);
    if (!eligible.length || detection.qualityFlags.some((flag) => flag.startsWith('touches-'))) {
      return unknown(detection, [], 'out-of-domain', spectrum, zeroSpan, envelope);
    }
    const likelihoods = eligible.map((item) => ({ item, logLikelihood: logLikelihood(spectrum, envelope, item) }));
    const candidates = posteriorCandidates(likelihoods);
    const top = candidates[0]!;
    const second = candidates[1];
    const familyPosterior = new Map<Family, number>();
    for (const candidate of candidates) familyPosterior.set(candidate.item.family, (familyPosterior.get(candidate.item.family) ?? 0) + candidate.probability);
    const families = [...familyPosterior].sort((left, right) => right[1] - left[1]);
    const topFamily = families[0]!;
    const secondFamily = families[1];
    const common = resultCommon(detection, spectrum, zeroSpan, envelope, candidates);
    if (sweeps.length < SIGNAL_LAB_EMSO_MODEL.minimumSpectrumSweeps) return { ...common, label: 'unknown', confidence: top.probability, decisionLevel: 'unknown', unknownReason: 'insufficient-evidence' };
    if (spectrum.prominenceDb < 8) return { ...common, label: 'unknown', confidence: top.probability, decisionLevel: 'unknown', unknownReason: 'low-confidence' };
    if (top.logLikelihood < SIGNAL_LAB_EMSO_MODEL.minimumInDomainLogLikelihood) return { ...common, label: 'unknown', confidence: top.probability, decisionLevel: 'unknown', unknownReason: 'out-of-domain' };
    if (requiresEnvelope(top.item.family) && !envelope) return { ...common, label: 'unknown', confidence: top.probability, decisionLevel: 'unknown', unknownReason: 'insufficient-evidence' };
    if (top.probability >= 0.58 && top.probability - (second?.probability ?? 0) >= 0.14) {
      return { ...common, label: `signal-lab:${top.item.id}`, confidence: top.probability, decisionLevel: 'profile' };
    }
    if (topFamily[1] >= 0.72 && topFamily[1] - (secondFamily?.[1] ?? 0) >= 0.2) {
      return { ...common, label: `signal-lab-family:${topFamily[0]}`, confidence: topFamily[1], decisionLevel: 'family' };
    }
    return { ...common, label: 'unknown', confidence: top.probability, decisionLevel: 'unknown', unknownReason: 'low-confidence' };
  }
}

function requiresEnvelope(family: Family): boolean { return family === 'geran' || family === 'e-utra' || family === 'nr' || family === 'wlan'; }

function hypothesis(id: string, label: string, family: Family, centerHz: number, occupiedBandwidthHz: number, recommendedSpanHz: number, allocation: Allocation, modulation: Modulation, timing: Timing): SignalLabWaveformHypothesis {
  return { id, label, family, centerHz, occupiedBandwidthHz, recommendedSpanHz, allocation, modulation, timing };
}

function closeHypotheses(values: readonly SignalLabWaveformHypothesis[]): readonly SignalLabWaveformHypothesis[] {
  if (values.length !== SIGNAL_LAB_EMSO_MODEL.taxonomySize) throw new Error(`SignalLab EMSO taxonomy has ${values.length} profiles, expected ${SIGNAL_LAB_EMSO_MODEL.taxonomySize}`);
  if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error('SignalLab EMSO taxonomy contains duplicate profile IDs');
  return values.map((value) => Object.freeze({ ...value }));
}

function coherentSweeps(detection: DetectedSignal, sweeps: readonly Sweep[]): Sweep[] {
  return sweeps.filter((sweep) => {
    validateSweep(sweep);
    const span = sweep.actualStopHz - sweep.actualStartHz;
    return detection.peakHz >= sweep.actualStartHz && detection.peakHz <= sweep.actualStopHz && span > 0;
  }).sort((left, right) => right.sequence - left.sequence);
}

function observeSpectrum(detection: DetectedSignal, sweeps: readonly Sweep[]): SpectrumObservation {
  const observations = sweeps.map((sweep) => observeOneSweep(detection, sweep));
  const active = observations.filter((item) => item.active);
  if (!active.length) throw new Error('SignalLab classification contains no active spectral evidence');
  const centerHz = median(active.map((item) => item.centerHz));
  const bandwidthHz = Math.max(median(active.map((item) => item.bandwidthHz)), median(observations.map((item) => item.binWidthHz)));
  return {
    centerHz,
    bandwidthHz,
    binWidthHz: median(observations.map((item) => item.binWidthHz)),
    prominenceDb: Math.max(...observations.map((item) => item.prominenceDb)),
    activeDuty: active.length / observations.length,
    flatness: mean(active.map((item) => item.flatness)),
    entropy: mean(active.map((item) => item.entropy)),
    texture: mean(active.map((item) => item.texture)),
    symmetry: mean(active.map((item) => item.symmetry)),
    centerNotch: mean(active.map((item) => item.centerNotch)),
    peakDensity: mean(active.map((item) => item.peakDensity)),
    peakDrift: standardDeviation(active.map((item) => item.peakHz)) / Math.max(bandwidthHz, median(observations.map((item) => item.binWidthHz))),
    powerVariation: standardDeviation(active.map((item) => item.integratedDb)),
    sweeps: observations.map((item) => item.id),
  };
}

function observeOneSweep(detection: DetectedSignal, sweep: Sweep) {
  const binWidthHz = nominalBinWidth(sweep);
  const halfWidth = Math.max(detection.bandwidthHz * 0.7, binWidthHz * 4, sweep.actualRbwHz * 2);
  const indices = sweep.frequencyHz.map((frequency, index) => ({ frequency, index }))
    .filter(({ frequency }) => Math.abs(frequency - detection.peakHz) <= halfWidth)
    .map(({ index }) => index);
  if (indices.length < 3) throw new Error('SignalLab classification requires at least three bins around a detection');
  const floor = robustFloor(sweep.powerDbm);
  const powers = indices.map((index) => sweep.powerDbm[index]!);
  const prominenceDb = Math.max(...powers) - floor;
  const active = prominenceDb >= 6;
  const weights = powers.map((power) => Math.max(1e-9, 10 ** ((power - floor) / 10) - 1));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const normalized = weights.map((value) => value / total);
  const frequencies = indices.map((index) => sweep.frequencyHz[index]!);
  const centerHz = sum(normalized.map((value, index) => value * frequencies[index]!));
  const lower = weightedQuantile(frequencies, normalized, 0.005);
  const upper = weightedQuantile(frequencies, normalized, 0.995);
  const arithmetic = mean(weights);
  const geometric = Math.exp(mean(weights.map((value) => Math.log(value))));
  const entropy = -sum(normalized.map((value) => value * Math.log(Math.max(Number.MIN_VALUE, value)))) / Math.log(normalized.length);
  const residuals = powers.map((value, index) => value - localMean(powers, index, 2));
  const symmetry = symmetryScore(normalized);
  const middle = Math.floor(powers.length / 2);
  const centerNotch = clamp((mean(powers) - powers[middle]!) / 15, -1, 1);
  const localPeaks = powers.filter((value, index) => index > 0 && index < powers.length - 1 && value > powers[index - 1]! && value >= powers[index + 1]! && value >= floor + 6).length;
  const peakIndex = maximumIndex(powers);
  return {
    id: sweep.id,
    active,
    centerHz,
    bandwidthHz: Math.max(binWidthHz, upper - lower),
    binWidthHz,
    prominenceDb,
    flatness: clamp(geometric / Math.max(Number.MIN_VALUE, arithmetic), 0, 1),
    entropy: clamp(entropy, 0, 1),
    texture: clamp(standardDeviation(residuals) / 8, 0, 1.5),
    symmetry,
    centerNotch,
    peakDensity: localPeaks / powers.length,
    peakHz: frequencies[peakIndex]!,
    integratedDb: 10 * Math.log10(total),
  };
}

function observeEnvelope(capture: ZeroSpanCapture): EnvelopeObservation {
  if (!capture.complete || capture.powerDbm.length < 20 || capture.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('SignalLab envelope evidence must be complete and contain at least 20 finite samples');
  const sorted = [...capture.powerDbm].sort((left, right) => left - right);
  const low = quantile(sorted, 0.05);
  const high = quantile(sorted, 0.95);
  const threshold = low + (high - low) * 0.55;
  const active = capture.powerDbm.map((value) => value >= threshold);
  let transitions = 0;
  for (let index = 1; index < active.length; index++) if (active[index] !== active[index - 1]) transitions++;
  return {
    rangeDb: high - low,
    standardDeviationDb: standardDeviation(capture.powerDbm),
    dutyCycle: active.filter(Boolean).length / active.length,
    transitionRate: transitions / Math.max(1, active.length - 1),
    dominantLagFraction: dominantLag(capture.powerDbm) / capture.powerDbm.length,
  };
}

function matchingZeroSpan(detection: DetectedSignal, binWidthHz: number, capture?: ZeroSpanCapture): ZeroSpanCapture | undefined {
  if (!capture) return undefined;
  const tolerance = Math.max(detection.bandwidthHz / 2, binWidthHz * 3, capture.requested.frequencyHz === detection.peakHz ? 1 : 0);
  return Math.abs(capture.frequencyHz - detection.peakHz) <= tolerance ? capture : undefined;
}

function logLikelihood(spectrum: SpectrumObservation, envelope: EnvelopeObservation | undefined, item: SignalLabWaveformHypothesis): number {
  const shape = expectedShape(item);
  let score = -Math.log(signalLabWaveformHypotheses.length);
  const centerSigma = Math.max(spectrum.binWidthHz * 2, item.allocation === 'single-prb' ? item.recommendedSpanHz * 0.28 : Math.max(item.occupiedBandwidthHz * 0.18, 2_000));
  score += gaussian(spectrum.centerHz, item.centerHz, centerSigma);
  const resolvableBandwidthHz = Math.max(item.occupiedBandwidthHz, spectrum.binWidthHz * (item.allocation === 'carrier' ? 6 : 2));
  score += gaussian(Math.log10(spectrum.bandwidthHz), Math.log10(resolvableBandwidthHz), item.allocation === 'carrier' ? 0.42 : 0.34);
  score += gaussian(spectrum.flatness, shape.flatness, 0.24);
  score += gaussian(spectrum.entropy, shape.entropy, 0.2);
  score += gaussian(spectrum.texture, shape.texture, 0.24);
  score += gaussian(spectrum.symmetry, shape.symmetry, 0.25);
  score += gaussian(spectrum.centerNotch, shape.centerNotch, 0.3);
  score += gaussian(spectrum.peakDensity, shape.peakDensity, 0.12);
  score += gaussian(spectrum.peakDrift, shape.peakDrift, 0.24);
  score += gaussian(spectrum.powerVariation, shape.powerVariation, 3.5);
  score += gaussian(spectrum.activeDuty, shape.activeDuty, 0.2);
  if (envelope) {
    const expected = expectedEnvelope(item);
    score += gaussian(envelope.rangeDb, expected.rangeDb, 8);
    score += gaussian(envelope.standardDeviationDb, expected.standardDeviationDb, 3.5);
    score += gaussian(envelope.dutyCycle, expected.dutyCycle, 0.16);
    score += gaussian(envelope.transitionRate, expected.transitionRate, 0.07);
    score += gaussian(envelope.dominantLagFraction, expected.dominantLagFraction, 0.08);
  }
  return score;
}

function expectedShape(item: SignalLabWaveformHypothesis): ExpectedShape {
  const allocation = ({
    carrier: [0.04, 0.25, 0.8, -1, 0.05], sidebands: [0.2, 0.48, 0.82, -0.3, 0.22],
    narrowband: [0.58, 0.78, 0.9, 0, 0.12], full: [0.86, 0.94, 0.84, 0.02, 0.1],
    boosted: [0.7, 0.9, 0.76, 0.02, 0.16], 'single-prb': [0.65, 0.82, 0.7, 0, 0.16],
    'multi-ru': [0.66, 0.88, 0.72, 0.3, 0.17], 'resource-unit': [0.82, 0.92, 0.8, 0.35, 0.12],
  } satisfies Record<Allocation, readonly [number, number, number, number, number]>)[item.allocation];
  const texture = ({ unmodulated: 0.03, am: 0.12, fm: 0.18, gmsk: 0.2, qpsk: 0.32, aqpsk: 0.38, '8psk': 0.43, '16qam': 0.48, '32qam': 0.52, '64qam': 0.56, '256qam': 0.65, '1024qam': 0.74, 'he-ofdm': 0.6 } satisfies Record<Modulation, number>)[item.modulation];
  const activeDuty = ({ continuous: 1, frame: 1, subslot: 1, slot: 1, burst: 7 / 9, 'sbfd-du': 0.5, 'sbfd-ud': 0.5, 'sbfd-dud': 2 / 3 } satisfies Record<Timing, number>)[item.timing];
  const peakDrift = item.modulation === 'fm' ? 0.35 : item.allocation === 'single-prb' ? 0.28 : 0.04;
  const powerVariation = item.modulation === 'am' ? 4.5 : item.timing === 'burst' || item.timing.startsWith('sbfd') ? 2.5 : 1.2;
  return { flatness: allocation[0], entropy: allocation[1], texture, symmetry: allocation[2], centerNotch: allocation[3], peakDensity: allocation[4], peakDrift, powerVariation, activeDuty };
}

function expectedEnvelope(item: SignalLabWaveformHypothesis): EnvelopeObservation {
  if (item.modulation === 'am') return { rangeDb: 28, standardDeviationDb: 10, dutyCycle: 0.45, transitionRate: 0.08, dominantLagFraction: 0.08 };
  if (item.modulation === 'unmodulated' || item.modulation === 'fm') return { rangeDb: 2, standardDeviationDb: 0.7, dutyCycle: 0.5, transitionRate: 0.1, dominantLagFraction: 0.08 };
  const timing = ({
    continuous: [6, 2, 0.5, 0.08], frame: [7, 2.5, 0.5, 0.08], burst: [55, 18, 0.65, 0.03],
    subslot: [54, 22, 4 / 14, 0.14], slot: [54, 25, 0.5, 0.07],
    'sbfd-du': [54, 25, 0.5, 0.07], 'sbfd-ud': [54, 25, 0.5, 0.07], 'sbfd-dud': [54, 23, 2 / 3, 0.09],
  } satisfies Record<Timing, readonly [number, number, number, number]>)[item.timing];
  return { rangeDb: timing[0], standardDeviationDb: timing[1], dutyCycle: timing[2], transitionRate: timing[3], dominantLagFraction: item.timing === 'frame' ? 0.08 : 0.05 };
}

function posteriorCandidates(values: readonly { item: SignalLabWaveformHypothesis; logLikelihood: number }[]) {
  const maximum = Math.max(...values.map((value) => value.logLikelihood));
  const temperature = 2.4;
  const weighted = values.map((value) => ({ item: value.item, weight: Math.exp((value.logLikelihood - maximum) / temperature), logLikelihood: value.logLikelihood }));
  const total = sum(weighted.map((value) => value.weight));
  return weighted.map((value) => ({ item: value.item, probability: value.weight / total, logLikelihood: value.logLikelihood })).sort((left, right) => right.probability - left.probability);
}

function resultCommon(detection: DetectedSignal, spectrum: SpectrumObservation, zeroSpan: ZeroSpanCapture | undefined, envelope: EnvelopeObservation | undefined, candidates: readonly { item: SignalLabWaveformHypothesis; probability: number; logLikelihood: number }[]): Omit<WaveformClassification, 'label' | 'confidence' | 'decisionLevel' | 'unknownReason'> {
  return {
    detectionId: detection.id,
    candidates: candidates.slice(0, 8).map((candidate) => ({ label: candidate.item.id, confidence: candidate.probability, family: candidate.item.family })),
    modelId: SIGNAL_LAB_EMSO_MODEL.id,
    qualification: 'signal-lab-synthetic-hypothesis',
    scoreKind: 'model-posterior',
    modelProvenance: {
      producer: SIGNAL_LAB_EMSO_MODEL.producer,
      sourceCommit: SIGNAL_LAB_EMSO_MODEL.sourceCommit,
      catalogSha256: SIGNAL_LAB_EMSO_MODEL.catalogSha256,
      generatorSha256: SIGNAL_LAB_EMSO_MODEL.generatorSha256,
      preprocessing: SIGNAL_LAB_EMSO_MODEL.preprocessing,
    },
    classifiedAt: new Date().toISOString(),
    evidence: {
      centerHz: spectrum.centerHz,
      bandwidthHz: spectrum.bandwidthHz,
      peakDbm: detection.peakDbm,
      sweepIds: spectrum.sweeps,
      ...(zeroSpan ? { zeroSpanCaptureId: zeroSpan.id } : {}),
      views: zeroSpan ? ['scalar-spectrum', 'detected-power-envelope'] : ['scalar-spectrum'],
      features: {
        spectrumSweeps: spectrum.sweeps.length,
        modelTopLogLikelihood: candidates[0]?.logLikelihood ?? -1e9,
        binWidthHz: spectrum.binWidthHz,
        prominenceDb: spectrum.prominenceDb,
        activeDuty: spectrum.activeDuty,
        flatness: spectrum.flatness,
        entropy: spectrum.entropy,
        texture: spectrum.texture,
        symmetry: spectrum.symmetry,
        centerNotch: spectrum.centerNotch,
        peakDensity: spectrum.peakDensity,
        peakDrift: spectrum.peakDrift,
        powerVariation: spectrum.powerVariation,
        ...(envelope ? {
          envelopeRangeDb: envelope.rangeDb,
          envelopeStandardDeviationDb: envelope.standardDeviationDb,
          envelopeDutyCycle: envelope.dutyCycle,
          envelopeTransitionRate: envelope.transitionRate,
          envelopeDominantLagFraction: envelope.dominantLagFraction,
        } : {}),
      },
    },
  };
}

function unknown(detection: DetectedSignal, candidates: readonly { item: SignalLabWaveformHypothesis; probability: number; logLikelihood: number }[], reason: WaveformClassification['unknownReason'], spectrum?: SpectrumObservation, zeroSpan?: ZeroSpanCapture, envelope?: EnvelopeObservation): WaveformClassification {
  const fallback: SpectrumObservation = spectrum ?? {
    centerHz: detection.peakHz, bandwidthHz: detection.bandwidthHz, binWidthHz: 0, prominenceDb: detection.peakDbm - detection.noiseFloorDbm,
    activeDuty: 0, flatness: 0, entropy: 0, texture: 0, symmetry: 0, centerNotch: 0, peakDensity: 0, peakDrift: 0, powerVariation: 0, sweeps: detection.sweepIds,
  };
  return { ...resultCommon(detection, fallback, zeroSpan, envelope, candidates), label: 'unknown', confidence: candidates[0]?.probability ?? 0, decisionLevel: 'unknown', unknownReason: reason };
}

function validateSweep(sweep: Sweep): void {
  if (!sweep.complete || sweep.frequencyHz.length < 3 || sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('SignalLab classification requires a complete scalar sweep with at least three aligned bins');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('SignalLab classification rejects non-finite sweep evidence');
  for (let index = 1; index < sweep.frequencyHz.length; index++) if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) throw new Error('SignalLab classification requires strictly increasing frequencies');
}

function nominalBinWidth(sweep: Sweep): number { return median(sweep.frequencyHz.slice(1).map((frequency, index) => frequency - sweep.frequencyHz[index]!)); }
function robustFloor(values: readonly number[]): number { const ordered = [...values].sort((left, right) => left - right); return median(ordered.slice(0, Math.max(1, Math.floor(ordered.length * 0.2)))); }
function gaussian(value: number, expected: number, sigma: number): number { const z = (value - expected) / sigma; return -0.5 * z * z - Math.log(sigma); }
function mean(values: readonly number[]): number { if (!values.length) throw new Error('Mean requires values'); return sum(values) / values.length; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function median(values: readonly number[]): number { if (!values.length) throw new Error('Median requires values'); const ordered = [...values].sort((left, right) => left - right); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2; }
function quantile(ordered: readonly number[], probability: number): number { const position = (ordered.length - 1) * probability; const lower = Math.floor(position); const upper = Math.ceil(position); return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower); }
function weightedQuantile(values: readonly number[], weights: readonly number[], probability: number): number { let cumulative = 0; for (let index = 0; index < values.length; index++) { cumulative += weights[index]!; if (cumulative >= probability) return values[index]!; } return values.at(-1)!; }
function standardDeviation(values: readonly number[]): number { if (!values.length) return 0; const average = mean(values); return Math.sqrt(mean(values.map((value) => (value - average) ** 2))); }
function localMean(values: readonly number[], index: number, radius: number): number { return mean(values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))); }
function symmetryScore(values: readonly number[]): number { let difference = 0; let mass = 0; for (let index = 0; index < Math.floor(values.length / 2); index++) { const left = values[index]!; const right = values[values.length - 1 - index]!; difference += Math.abs(left - right); mass += left + right; } return clamp(1 - difference / Math.max(Number.MIN_VALUE, mass), 0, 1); }
function maximumIndex(values: readonly number[]): number { let index = 0; for (let cursor = 1; cursor < values.length; cursor++) if (values[cursor]! > values[index]!) index = cursor; return index; }
function dominantLag(values: readonly number[]): number { const centered = values.map((value) => value - mean(values)); const maximumLag = Math.min(Math.floor(values.length / 2), 128); let bestLag = 0; let best = 0; for (let lag = 2; lag <= maximumLag; lag++) { let correlation = 0; for (let index = lag; index < centered.length; index++) correlation += centered[index]! * centered[index - lag]!; if (correlation > best) { best = correlation; bestLag = lag; } } return bestLag; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
