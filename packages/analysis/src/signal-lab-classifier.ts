import { BAYESIAN_WAVEFORM_MODEL, BayesianWaveformClassifier } from './bayesian-waveform-classifier.js';
export type { WaveformEvidence } from './observable-features.js';

export const SIGNAL_LAB_EMSO_MODEL = {
  id: BAYESIAN_WAVEFORM_MODEL.id,
  producer: 'tinysa-signal-lab',
  sourceCommit: BAYESIAN_WAVEFORM_MODEL.sourceCommit,
  catalogSha256: BAYESIAN_WAVEFORM_MODEL.corpusSha256,
  generatorSha256: BAYESIAN_WAVEFORM_MODEL.corpusSha256,
  preprocessing: BAYESIAN_WAVEFORM_MODEL.preprocessing,
  priorId: BAYESIAN_WAVEFORM_MODEL.priorId,
  calibrationId: BAYESIAN_WAVEFORM_MODEL.calibrationId,
  observableClassCount: BAYESIAN_WAVEFORM_MODEL.classCount,
  legacyProfileTaxonomySize: 79,
  taxonomySize: 79,
  minimumSpectrumSweeps: 8,
  maximumSpectrumSweeps: 8,
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

/** Compatibility name retained for the desktop integration; inference is observable-class v5. */
export class SignalLabBayesianClassifier extends BayesianWaveformClassifier {}

function hypothesis(id: string, label: string, family: Family, centerHz: number, occupiedBandwidthHz: number, recommendedSpanHz: number, allocation: Allocation, modulation: Modulation, timing: Timing): SignalLabWaveformHypothesis {
  return { id, label, family, centerHz, occupiedBandwidthHz, recommendedSpanHz, allocation, modulation, timing };
}

function closeHypotheses(values: readonly SignalLabWaveformHypothesis[]): readonly SignalLabWaveformHypothesis[] {
  if (values.length !== SIGNAL_LAB_EMSO_MODEL.taxonomySize) throw new Error(`SignalLab EMSO taxonomy has ${values.length} profiles, expected ${SIGNAL_LAB_EMSO_MODEL.taxonomySize}`);
  if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error('SignalLab EMSO taxonomy contains duplicate profile IDs');
  return values.map((value) => Object.freeze({ ...value }));
}
