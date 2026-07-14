import type { DetectedSignal } from '@tinysa/contracts';
import { describe, expect, it } from 'vitest';
import {
  observableHypothesisHasRequiredEvidence,
  observableRepresentativeIsEligibleForModelFit,
  type ObservableHypothesisDomainObservation,
} from './observable-hypothesis-domain.js';

const localDetection = { associationMode: 'frequency-local' } satisfies Pick<
  DetectedSignal,
  'associationMode' | 'associationBayesianEvidence'
>;

describe('observable hypothesis domain', () => {
  it('keeps narrow detector fragments out of both an LTE-TDD fit and runtime support', () => {
    // This reproduces the held-out divisor-98 failure: a nominal 10 MHz TDD
    // scenario can yield a high-SNR local fragment below the fitted 3.5 MHz
    // measured-width floor. The fragment is an acquisition miss, not a
    // representative from which to fit or score the LTE hypothesis.
    const narrowFragment = {
      centerHz: 2_350_000_000,
      bandwidthHz: 2_900_000,
      occupiedStartHz: 2_348_550_000,
      occupiedStopHz: 2_351_450_000,
      values: { 'spectrum.logBandwidthRbwRatio': 1.4 },
    } satisfies ObservableHypothesisDomainObservation;

    expect(observableHypothesisHasRequiredEvidence('lte-tdd-like', narrowFragment)).toBe(false);
    expect(observableRepresentativeIsEligibleForModelFit(
      'lte-tdd-like',
      10_000_000,
      localDetection,
      narrowFragment,
    )).toBe(false);

    const resolvedChannel = {
      ...narrowFragment,
      bandwidthHz: 8_000_000,
      occupiedStartHz: 2_346_000_000,
      occupiedStopHz: 2_354_000_000,
    };
    expect(observableHypothesisHasRequiredEvidence('lte-tdd-like', resolvedChannel)).toBe(true);
    expect(observableRepresentativeIsEligibleForModelFit(
      'lte-tdd-like',
      10_000_000,
      localDetection,
      resolvedChannel,
    )).toBe(true);
  });

  it('also applies fitted band containment before admitting a training representative', () => {
    const outOfBand = {
      centerHz: 2_450_000_000,
      bandwidthHz: 10_000_000,
      occupiedStartHz: 2_445_000_000,
      occupiedStopHz: 2_455_000_000,
      values: {},
    } satisfies ObservableHypothesisDomainObservation;
    expect(observableHypothesisHasRequiredEvidence('lte-tdd-like', outOfBand)).toBe(false);
    expect(observableRepresentativeIsEligibleForModelFit(
      'lte-tdd-like',
      10_000_000,
      localDetection,
      outOfBand,
    )).toBe(false);
  });

  it('retains the stricter analog fragment rule after runtime-domain qualification', () => {
    const resolvedAmEvidence = {
      centerHz: 98_000_000,
      bandwidthHz: 4_000,
      values: {
        'spectrum.centerFraction': 0.8,
        'spectrum.sidebandScore': 0.7,
      },
    } satisfies ObservableHypothesisDomainObservation;
    expect(observableHypothesisHasRequiredEvidence('am-dsb-full-carrier-like', resolvedAmEvidence)).toBe(true);
    expect(observableRepresentativeIsEligibleForModelFit(
      'am-dsb-full-carrier-like',
      50_000,
      localDetection,
      resolvedAmEvidence,
    )).toBe(false);
    expect(observableRepresentativeIsEligibleForModelFit(
      'am-dsb-full-carrier-like',
      50_000,
      { associationMode: 'regular-spectral-component-activity' },
      resolvedAmEvidence,
    )).toBe(true);
  });
});
