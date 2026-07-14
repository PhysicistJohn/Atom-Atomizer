import { describe, expect, it } from 'vitest';
import { logGamma, mixtureLogLikelihood, posteriorCandidates, studentTLogDensity, studentTModelTailProbability, type StudentTLikelihoodComponent } from './bayesian-predictive.js';
import { selectObservableDecision } from './bayesian-waveform-classifier.js';
import { BAYESIAN_OBSERVABLE_MODEL } from './models/bayesian-observable-v5.generated.js';

const unitCauchy: StudentTLikelihoodComponent = {
  id: 'unit-cauchy',
  logWeight: 0,
  degreesOfFreedom: 1,
  dimensions: ['x'],
  location: [0],
  scale: [[1]],
};

describe('Bayesian classifier Student-t likelihood math', () => {
  it('keeps the generated class priors and per-class mixtures normalized independently of scenario count', () => {
    expect(new Set(BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id)).size).toBe(12);
    expect(BAYESIAN_OBSERVABLE_MODEL.dimensions).toHaveLength(28);
    expect(BAYESIAN_OBSERVABLE_MODEL.classModels.reduce((sum, model) => sum + Math.exp(model.logPrior), 0)).toBeCloseTo(1, 12);
    for (const model of BAYESIAN_OBSERVABLE_MODEL.classModels) {
      expect(model.components.reduce((sum, component) => sum + Math.exp(component.logWeight), 0)).toBeCloseTo(1, 12);
    }
  });

  it('evaluates the log-gamma and Student-t normalizing constants', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(studentTLogDensity({ x: 0 }, unitCauchy)).toBeCloseTo(-Math.log(Math.PI), 12);
    expect(studentTLogDensity({ x: 1 }, unitCauchy)).toBeCloseTo(-Math.log(2 * Math.PI), 12);
    expect(studentTModelTailProbability({ x: 0 }, unitCauchy)).toBe(1);
    expect(studentTModelTailProbability({ x: 1 }, unitCauchy)).toBeCloseTo(0.5, 12);
  });

  it('marginalizes missing features instead of scoring their absence as negative evidence', () => {
    const component: StudentTLikelihoodComponent = {
      id: 'two-dimensional', logWeight: 0, degreesOfFreedom: 7,
      dimensions: ['spectrum', 'envelope'], location: [0, 2], scale: [[1, 0.25], [0.25, 2]],
    };
    expect(studentTLogDensity({}, component)).toBe(0);
    expect(studentTLogDensity({ spectrum: 0 }, component)).toBeCloseTo(studentTLogDensity({ spectrum: 0, unavailable: 99 }, component), 12);
    expect(Number.isFinite(studentTLogDensity({ spectrum: 0, envelope: 2 }, component))).toBe(true);
  });

  it('keeps a class likelihood invariant when an identical scenario component is duplicated with normalized weights', () => {
    const single = mixtureLogLikelihood({ x: 0.4 }, [unitCauchy]);
    const duplicated = mixtureLogLikelihood({ x: 0.4 }, [
      { ...unitCauchy, id: 'duplicate-a', logWeight: Math.log(0.5) },
      { ...unitCauchy, id: 'duplicate-b', logWeight: Math.log(0.5) },
    ]);
    expect(duplicated).toBeCloseTo(single, 12);
  });

  it('normalizes known and unknown hypotheses in the same posterior denominator', () => {
    const candidates = posteriorCandidates({ x: 0.1 }, [
      { id: 'known', logPrior: Math.log(0.8), components: [unitCauchy] },
      { id: 'unknown-signal', logPrior: Math.log(0.2), components: [{ ...unitCauchy, id: 'unknown', location: [4] }] },
    ]);
    expect(candidates.map((item) => item.id)).toContain('unknown-signal');
    expect(candidates.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(1, 12);
    expect(candidates[0]!.id).toBe('known');
  });

  it('fails loudly for a non-positive-definite predictive scale', () => {
    expect(() => studentTLogDensity({ x: 1, y: 2 }, {
      id: 'invalid', logWeight: 0, degreesOfFreedom: 4,
      dimensions: ['x', 'y'], location: [0, 0], scale: [[1, 2], [2, 1]],
    })).toThrow(/positive definite/i);
  });

  it('canonically abstains between LTE and NR below the scalar identifiability boundary', () => {
    const candidates = [
      candidate('lte-fdd-like', 0.7),
      candidate('nr-fdd-like', 0.25),
      candidate('unknown-signal', 0.05),
    ];
    expect(selectObservableDecision(candidates, { centerHz: 1_840_000_000, bandwidthHz: 19_000_000, values: {} })).toEqual({
      label: 'cellular-ofdm-ambiguous', probability: 0.95,
    });
    expect(selectObservableDecision(candidates, { centerHz: 1_840_000_000, bandwidthHz: 40_000_000, values: {} }).label).toBe('unknown');
  });

  it('does not turn aggregate cellular mass into a cellular claim when the leading hypothesis is non-cellular', () => {
    const candidates = [
      candidate('wifi-ofdm-like', 0.4),
      candidate('lte-fdd-like', 0.3),
      candidate('nr-fdd-like', 0.25),
      candidate('unknown-signal', 0.05),
    ];
    expect(selectObservableDecision(candidates, {
      centerHz: 2_425_000_000,
      bandwidthHz: 20_000_000,
      values: {},
    }).label).toBe('unknown');
  });

  it('abstains below the detector-conditioned cellular bandwidth domain', () => {
    const candidates = [candidate('lte-tdd-like', 0.9), candidate('unknown-signal', 0.1)];
    expect(selectObservableDecision(candidates, {
      centerHz: 2_350_000_000,
      bandwidthHz: 2_500_000,
      values: {},
    }).label).toBe('unknown');
  });

  it('requires provenance-bound frequency-agile activity before a Bluetooth-family decision', () => {
    const candidates = [candidate('bluetooth-like', 0.9), candidate('unknown-signal', 0.1)];
    const observation = { centerHz: 2_441_000_000, bandwidthHz: 78_000_000, values: {} };
    expect(selectObservableDecision(candidates, observation).label).toBe('unknown');
    expect(selectObservableDecision(candidates, {
      ...observation,
      limitations: ['frequency-agile-band-activity-association'],
    }).label).toBe('unknown');
    expect(selectObservableDecision(candidates, {
      ...observation,
      values: { 'association.logBayesFactor': 10 },
      limitations: ['frequency-agile-band-activity-association'],
    }).label).toBe('unknown');
  });

  it('keeps a narrow 2.4 GHz observation outside the fitted HR-DSSS decision domain', () => {
    const candidates = [candidate('wifi-hr-dsss-like', 0.9), candidate('unknown-signal', 0.1)];
    expect(selectObservableDecision(candidates, {
      centerHz: 2_425_000_000,
      bandwidthHz: 2_500_000,
      values: {},
    }).label).toBe('unknown');
  });

  it('requires the measured wireless interval, not just its center, to fit a model band', () => {
    expect(selectObservableDecision([
      candidate('wifi-ofdm-like', 0.9), candidate('unknown-signal', 0.1),
    ], { centerHz: 2_490_000_000, bandwidthHz: 80_000_000, values: {} }, 1).label).toBe('unknown');
    expect(selectObservableDecision([
      candidate('wifi-hr-dsss-like', 0.9), candidate('unknown-signal', 0.1),
    ], { centerHz: 2_500_000_000, bandwidthHz: 22_000_000, values: {} }, 1).label).toBe('unknown');
    expect(selectObservableDecision([
      candidate('lte-fdd-like', 0.9), candidate('unknown-signal', 0.1),
    ], { centerHz: 2_200_000_000, bandwidthHz: 20_000_000, values: {} }, 1).label).toBe('unknown');
    expect(selectObservableDecision([
      candidate('wifi-ofdm-like', 0.9), candidate('unknown-signal', 0.1),
    ], {
      centerHz: 2_470_000_000,
      bandwidthHz: 20_000_000,
      occupiedStartHz: 2_450_000_000,
      occupiedStopHz: 2_505_000_000,
      values: {},
    }, 1).label).toBe('unknown');
  });

  it('does not promote a cellular duplex leaf from scalar spectrum texture alone', () => {
    const tdd = [candidate('nr-tdd-like', 0.9), candidate('unknown-signal', 0.1)];
    const observation = { centerHz: 3_500_000_000, bandwidthHz: 40_000_000 };
    expect(selectObservableDecision(tdd, { ...observation, values: {} }, 1)).toEqual({
      label: 'nr-like', probability: 0.9,
    });
    expect(selectObservableDecision(tdd, {
      ...observation,
      values: { 'envelope.logTransitionRateHz': 3 },
    }, 1)).toEqual({ label: 'nr-tdd-like', probability: 0.9 });

    const fdd = [candidate('nr-fdd-like', 0.9), candidate('unknown-signal', 0.1)];
    expect(selectObservableDecision(fdd, {
      centerHz: 1_840_000_000,
      bandwidthHz: 40_000_000,
      values: { 'envelope.logTransitionRateHz': 0 },
    }, 1)).toEqual({ label: 'nr-like', probability: 0.9 });
  });

  it('makes GSM model-band compatibility structural rather than a defeatable soft penalty', () => {
    const candidates = [candidate('gsm-like', 0.9), candidate('unknown-signal', 0.1)];
    expect(selectObservableDecision(candidates, {
      centerHz: 98_000_000,
      bandwidthHz: 200_000,
      values: {},
    }).label).toBe('unknown');
  });

  it('requires a dominant carrier plus sideband or envelope evidence for full-carrier AM', () => {
    const candidates = [candidate('am-dsb-full-carrier-like', 0.9), candidate('unknown-signal', 0.1)];
    const base = { centerHz: 98_000_000, bandwidthHz: 52_000 };
    expect(selectObservableDecision(candidates, {
      ...base,
      values: { 'spectrum.centerFraction': 0.9, 'spectrum.sidebandScore': 0 },
    }).label).toBe('unknown');
    expect(selectObservableDecision(candidates, {
      ...base,
      values: { 'spectrum.centerFraction': 0.9, 'spectrum.sidebandScore': 0.8 },
    }, 1).label).toBe('am-dsb-full-carrier-like');
    expect(selectObservableDecision(candidates, {
      ...base,
      values: {
        'spectrum.centerFraction': 0.9,
        'spectrum.sidebandScore': 0,
        'envelope.rangeDb': 8,
        'envelope.standardDeviationDb': 2,
      },
    }, 1).label).toBe('am-dsb-full-carrier-like');
  });

  it('rejects an observation outside every fixed known component even when relative posterior favors a known leaf', () => {
    const candidates = [candidate('wifi-ofdm-like', 0.9), candidate('unknown-signal', 0.1)];
    expect(selectObservableDecision(candidates, {
      centerHz: 5_180_000_000,
      bandwidthHz: 20_000_000,
      values: { 'spectrum.logBandwidthHz': 1_000 },
    })).toEqual({ label: 'unknown', probability: 0.1 });
  });
});

function candidate(id: string, probability: number) {
  return { id, probability, logLikelihood: Math.log(probability), logJoint: Math.log(probability) };
}
