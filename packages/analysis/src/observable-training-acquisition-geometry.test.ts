import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OBSERVABLE_TRAINING_SWEEP_POINTS,
  OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY,
  OBSERVABLE_TRAINING_BASELINE_SPECTRUM_TEMPORAL_SCHEDULE,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_BRANCH_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME_METADATA,
  SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES,
  SIGNAL_LAB_PRODUCTION_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_DETECTED_POWER_CAPTURE_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES,
  SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES,
  SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS,
  SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
  createObservableTrainingSourceClock,
  createSignalLabProductionProfileCapturePolicy,
  observableTrainingActualRbwHz,
  observableTrainingDetectedPowerSynthesisFilterWidthHz,
  occupiedBandwidthRbwDivisorGeometry,
  type ObservableTrainingAcquisitionRegime,
  type ObservableTrainingSourceClock,
} from './observable-training-acquisition-geometry.js';

function captureTarget(rawTargetId = 'signal-0001') {
  return {
    targetSelectionPolicyId: SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
    rawTargetId,
    projectedRepresentativeId: rawTargetId,
    representativeKey: `frequency-local:${rawTargetId}`,
    selectedPeakHz: 100_000_000,
    selectedPeakDbm: -42,
    admittedTuneHz: 100_000_000,
  } as const;
}

describe('observable-training acquisition geometry', () => {
  it('reproduces the production SignalLab recommended-span inclusive grid exactly', () => {
    const wifiOfdm20 = { occupiedBandwidthHz: 16_600_000, recommendedSpanHz: 30_000_000 };

    expect(SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY).toMatchObject({
      id: 'signal-lab-recommended-span-450-point-grid-v1',
      sourceKind: 'signal-lab',
      kind: 'recommended-span-inclusive-grid',
      sweepPoints: 450,
    });
    expect(observableTrainingActualRbwHz(
      wifiOfdm20,
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    )).toBe(wifiOfdm20.recommendedSpanHz / (OBSERVABLE_TRAINING_SWEEP_POINTS - 1));
  });

  it('does not disguise scenario-dependent production geometry as a global RBW divisor', () => {
    const wifiOfdm20 = { occupiedBandwidthHz: 16_600_000, recommendedSpanHz: 30_000_000 };
    const wifiOfdm80 = { occupiedBandwidthHz: 79_000_000, recommendedSpanHz: 84_000_000 };
    const effectiveDivisor = (scenario: typeof wifiOfdm20) => scenario.occupiedBandwidthHz
      / observableTrainingActualRbwHz(scenario, SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY);

    expect(effectiveDivisor(wifiOfdm20)).toBeCloseTo(248.446_666_666_7, 10);
    expect(effectiveDivisor(wifiOfdm80)).toBeCloseTo(422.273_809_523_8, 10);
    expect(effectiveDivisor(wifiOfdm20)).not.toBe(effectiveDivisor(wifiOfdm80));
  });

  it('preserves the pre-existing occupied-bandwidth nuisance-grid policy separately', () => {
    const scenario = { occupiedBandwidthHz: 16_600_000, recommendedSpanHz: 30_000_000 };
    const divisorGeometry = occupiedBandwidthRbwDivisorGeometry(120);

    expect(divisorGeometry.id).toBe('occupied-bandwidth-rbw-divisor:120');
    expect(observableTrainingActualRbwHz(scenario, divisorGeometry)).toBe(16_600_000 / 120);
    expect(observableTrainingActualRbwHz(scenario, divisorGeometry)).not.toBe(
      observableTrainingActualRbwHz(scenario, SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY),
    );
    expect(observableTrainingDetectedPowerSynthesisFilterWidthHz(scenario, divisorGeometry))
      .toBe(observableTrainingActualRbwHz(scenario, divisorGeometry));
  });

  it('pins the generator-internal production filter without claiming a measured RBW', () => {
    const am = { occupiedBandwidthHz: 52_000, recommendedSpanHz: 500_000 };
    const spectrumActualRbwHz = observableTrainingActualRbwHz(
      am,
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    );

    expect(spectrumActualRbwHz).toBe(500_000 / 449);
    expect(observableTrainingDetectedPowerSynthesisFilterWidthHz(
      am,
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    )).toBe(SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ);
    expect(OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY).toEqual({
      id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
      divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
      signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
      signalLabProductionSynthesisFilterWidthHz: 100_000,
      measurementActualRbwQualification: 'unavailable',
    });
    expect(spectrumActualRbwHz).not.toBe(
      SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
    );
  });

  it('derives both exact deployed release-gate source clocks from profile order and horizons', () => {
    const profileIds = [
      'cw',
      'am',
      'fm',
      'gsm-900-loaded-bcch',
      'lte-band3-fdd-20m',
      'lte-band38-tdd-10m',
      'nr-n3-fdd-20m',
      'nr-n78-tdd-100m',
      'wifi-hr-dsss-11m',
      'wifi-ofdm-20m',
      'bluetooth-classic-connected',
      'bluetooth-le-advertising',
    ];
    const horizons = [32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 96, 96];

    expect(SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map(
      (profile) => profile.profileId,
    )).toEqual(profileIds);
    expect(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.map(
      (profile) => profile.profileId,
    )).toEqual(profileIds);
    expect(SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map(
      (profile) => profile.spectrumOpportunities,
    )).toEqual(horizons);
    expect(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.map(
      (profile) => profile.spectrumOpportunities,
    )).toEqual(horizons);
    expect(SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map(
      (profile) => profile.sourceLookIndexOffset,
    )).toEqual([0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 416]);
    expect(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.map(
      (profile) => profile.sourceLookIndexOffset,
    )).toEqual([0, 33, 66, 99, 132, 165, 198, 231, 264, 297, 330, 427]);
    expect(SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.every(
      (profile) => profile.automaticDetectedPowerCaptures === 0,
    )).toBe(true);
    expect(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.every(
      (profile) => profile.admittedDetectedPowerCaptures === 1,
    )).toBe(true);

    const spectrumLast = SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.at(-1)!;
    const qualifiedEnvelopeLast =
      SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.at(-1)!;
    expect(spectrumLast.sourceLookIndexOffset + spectrumLast.spectrumOpportunities
      + spectrumLast.automaticDetectedPowerCaptures).toBe(512);
    expect(qualifiedEnvelopeLast.sourceLookIndexOffset
      + qualifiedEnvelopeLast.spectrumOpportunities
      + qualifiedEnvelopeLast.admittedDetectedPowerCaptures).toBe(524);
    expect(SIGNAL_LAB_PRODUCTION_RELEASE_GATE_SOURCE_PLAN)
      .toBe(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN);
  });

  it('pairs the independent production branch schedules for the same profile', () => {
    expect(SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES).toEqual(
      SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map((profile) => ({
        id: `live-spectrum-release-gate-${profile.profileId}-start-v3`,
        sourcePlanProfileId: profile.profileId,
        sourceLookIndexOffset: profile.sourceLookIndexOffset,
        sourcePlanSpectrumOpportunities: profile.spectrumOpportunities,
      })),
    );
    expect(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES).toEqual(
      SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.map((profile) => ({
        id: `live-qualified-envelope-release-gate-${profile.profileId}-start-v3`,
        sourcePlanProfileId: profile.profileId,
        sourceLookIndexOffset: profile.sourceLookIndexOffset,
        sourcePlanSpectrumOpportunities: profile.spectrumOpportunities,
      })),
    );
    expect(SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS).toHaveLength(12);
    for (const [profileOrdinal, pair] of
      SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS.entries()) {
      expect(pair.id).toBe(
        `live-release-gate-independent-branches-${pair.sourcePlanProfileId}-v3`,
      );
      expect(pair.spectrumTemporalSchedule)
        .toBe(SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES[profileOrdinal]);
      expect(pair.qualifiedEnvelopeTemporalSchedule)
        .toBe(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES[profileOrdinal]);
      expect(pair.spectrumTemporalSchedule.sourcePlanProfileId)
        .toBe(pair.sourcePlanProfileId);
      expect(pair.qualifiedEnvelopeTemporalSchedule.sourcePlanProfileId)
        .toBe(pair.sourcePlanProfileId);
    }
    expect(SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES)
      .toBe(SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES);
  });

  it('requires acquisition regimes to name both branch schedules', () => {
    const divisorRegime: ObservableTrainingAcquisitionRegime = {
      id: 'occupied-bandwidth-rbw-divisor:120/baseline-start-zero',
      geometry: occupiedBandwidthRbwDivisorGeometry(120),
      spectrumTemporalSchedule: OBSERVABLE_TRAINING_BASELINE_SPECTRUM_TEMPORAL_SCHEDULE,
      qualifiedEnvelopeTemporalSchedule:
        OBSERVABLE_TRAINING_BASELINE_SPECTRUM_TEMPORAL_SCHEDULE,
    };
    const productionPair = SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS[7]!;
    const productionRegime: ObservableTrainingAcquisitionRegime = {
      id: `${SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY.id}/${productionPair.id}`,
      geometry: SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
      spectrumTemporalSchedule: productionPair.spectrumTemporalSchedule,
      qualifiedEnvelopeTemporalSchedule: productionPair.qualifiedEnvelopeTemporalSchedule,
    };

    expect(divisorRegime.spectrumTemporalSchedule)
      .toBe(divisorRegime.qualifiedEnvelopeTemporalSchedule);
    expect(productionRegime.spectrumTemporalSchedule.sourcePlanProfileId)
      .toBe(productionRegime.qualifiedEnvelopeTemporalSchedule.sourcePlanProfileId);
  });

  it('pins independent spectrum and qualified-envelope sessions in model metadata', () => {
    expect(SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME_METADATA).toMatchObject({
      id: 'signal-lab-recommended-span-grid-with-independent-production-branch-source-clocks-v4',
      branchPolicy:
        'independent-no-auto-spectrum-and-qualified-first-admitted-envelope-sessions-v1',
      sourceClocks: {
        spectrum: {
          id: 'shared-monotonic-source-clock-v1',
          acquisitionIndexPolicy: 'one-look-index-per-physical-acquisition-v1',
          detectedPowerCapturePolicy: 'no-automatic-detected-power-capture-v1',
        },
        qualifiedEnvelope: {
          id: 'shared-monotonic-source-clock-v1',
          acquisitionIndexPolicy: 'one-look-index-per-physical-acquisition-v1',
          detectedPowerCapturePolicy:
            'capture-once-after-first-runtime-admitted-strongest-current-target-v2',
          captureTargetSelectionPolicy:
            'preferred-then-strongest-current-physical-or-qualified-agile-member-target-v3',
          postCaptureSpectrumPolicy: 'continue-at-next-shared-look-index-v1',
        },
      },
      spectrumReleaseGateSourcePlan:
        SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN,
      qualifiedEnvelopeReleaseGateSourcePlan:
        SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN,
      temporalSchedulePairs: SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS,
    });
    expect(SIGNAL_LAB_PRODUCTION_ACQUISITION_BRANCH_POLICY_ID)
      .toBe('independent-no-auto-spectrum-and-qualified-first-admitted-envelope-sessions-v1');
    expect(SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID)
      .toBe('shared-monotonic-source-clock-v1');
    expect(SIGNAL_LAB_PRODUCTION_SPECTRUM_DETECTED_POWER_CAPTURE_POLICY_ID)
      .toBe('no-automatic-detected-power-capture-v1');
    expect(SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID)
      .toBe('capture-once-after-first-runtime-admitted-strongest-current-target-v2');
    expect(SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID)
      .toBe('preferred-then-strongest-current-physical-or-qualified-agile-member-target-v3');
  });

  it('allocates one unique strictly increasing shared look index for every physical acquisition', () => {
    const clock = createObservableTrainingSourceClock(41);
    const first = clock.allocateSpectrum();
    const second = clock.allocateSpectrum();
    const capture = clock.allocateDetectedPower(second, captureTarget());
    const third = clock.allocateSpectrum();
    const trace = clock.trace();

    expect(trace).toEqual([first, second, capture, third]);
    expect(trace.map((event) => event.lookIndex)).toEqual([41, 42, 43, 44]);
    expect(new Set(trace.map((event) => event.lookIndex)).size).toBe(trace.length);
    expect(trace.every((event, index) => index === 0
      || event.lookIndex > trace[index - 1]!.lookIndex)).toBe(true);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(trace.every(Object.isFrozen)).toBe(true);
  });

  it('places the admitted envelope immediately after its trigger and resumes spectrum at the next index', () => {
    const clock = createObservableTrainingSourceClock(800);
    const trigger = clock.allocateSpectrum();
    const envelope = clock.allocateDetectedPower(trigger, captureTarget());
    const nextSpectrum = clock.allocateSpectrum();

    expect(envelope.lookIndex).toBe(trigger.lookIndex + 1);
    expect(envelope.triggerSpectrumLookIndex).toBe(trigger.lookIndex);
    expect(nextSpectrum.lookIndex).toBe(envelope.lookIndex + 1);
  });

  it('delays capture until runtime admission and captures at most once for the whole profile', () => {
    const clock = createObservableTrainingSourceClock();
    const policy = createSignalLabProductionProfileCapturePolicy(clock, 'nr-n78-tdd-100m');
    const unavailableCandidateSpectrum = policy.allocateSpectrum(0);

    // The caller does not invoke capture when the first candidate has typed
    // unavailable evidence. A later admitted candidate remains causal.
    expect(policy.detectedPowerCapture()).toBeNull();
    const admittedCandidateSpectrum = policy.allocateSpectrum(1);
    const capture = policy.captureAfterRuntimeAdmission(
      admittedCandidateSpectrum,
      {
        ...captureTarget('signal-n78-primary'),
        representativeKey: 'association:n78:primary',
      },
    );

    expect(unavailableCandidateSpectrum.lookIndex).toBe(0);
    expect(capture?.lookIndex).toBe(2);
    expect(policy.captureAfterRuntimeAdmission(
      admittedCandidateSpectrum,
      captureTarget('signal-n78-primary'),
    )).toBeNull();
    expect(policy.detectedPowerCapture()).toBe(capture);
    expect(clock.trace().filter((event) => event.kind === 'detected-power')).toEqual([capture]);
  });

  it('uses zero captures when no representative is admitted', () => {
    const clock = createObservableTrainingSourceClock(90);
    const policy = createSignalLabProductionProfileCapturePolicy(clock, 'bluetooth-le-advertising');
    for (let opportunity = 0; opportunity < 8; opportunity += 1) {
      policy.allocateSpectrum(opportunity);
    }

    expect(policy.detectedPowerCapture()).toBeNull();
    expect(clock.trace()).toHaveLength(8);
    expect(clock.trace().every((event) => event.kind === 'swept-spectrum')).toBe(true);
  });

  it('keeps an acquired envelope consumed when later feature extraction fails', () => {
    const clock = createObservableTrainingSourceClock(1_000);
    const policy = createSignalLabProductionProfileCapturePolicy(clock, 'wifi-ofdm-20m');
    const trigger = policy.allocateSpectrum(7);
    const acquiredBeforeExtraction = policy.captureAfterRuntimeAdmission(
      trigger,
      {
        ...captureTarget('signal-wifi-primary'),
        representativeKey: 'association:wifi:primary',
      },
    );

    // A caller can catch a typed extraction failure here, but cannot roll the
    // physical acquisition back. The next spectrum advances past it.
    const nextSpectrum = policy.allocateSpectrum();
    expect(acquiredBeforeExtraction?.lookIndex).toBe(1_001);
    expect(nextSpectrum.lookIndex).toBe(1_002);
  });

  it('retains immutable profile, opportunity, and representative attribution in trace snapshots', () => {
    const clock = createObservableTrainingSourceClock(500);
    const policy = createSignalLabProductionProfileCapturePolicy(clock, 'wifi-hr-dsss-11m');
    const trigger = policy.allocateSpectrum(11);
    policy.captureAfterRuntimeAdmission(trigger, {
      ...captureTarget('signal-wifi-dsss-primary'),
      representativeKey: 'association:wifi-dsss:primary',
    });
    const frozenSnapshot = clock.trace();
    const clonedSnapshot = structuredClone(frozenSnapshot);

    expect(clonedSnapshot).toMatchObject([
      {
        kind: 'swept-spectrum',
        contextId: 'wifi-hr-dsss-11m',
        spectrumOpportunity: 11,
        lookIndex: 500,
      },
      {
        kind: 'detected-power',
        contextId: 'wifi-hr-dsss-11m',
        targetSelectionPolicyId:
          'preferred-then-strongest-current-physical-or-qualified-agile-member-target-v3',
        rawTargetId: 'signal-wifi-dsss-primary',
        projectedRepresentativeId: 'signal-wifi-dsss-primary',
        representativeKey: 'association:wifi-dsss:primary',
        selectedPeakHz: 100_000_000,
        selectedPeakDbm: -42,
        admittedTuneHz: 100_000_000,
        triggerSpectrumLookIndex: 500,
        lookIndex: 501,
      },
    ]);
    expect(Object.isFrozen(frozenSnapshot)).toBe(true);
    expect(frozenSnapshot.every(Object.isFrozen)).toBe(true);
    policy.allocateSpectrum(12);
    expect(frozenSnapshot).toHaveLength(2);
  });

  it('binds source-clock identity to the selected raw association member', () => {
    const traceHash = (rawTargetId: string) => {
      const clock = createObservableTrainingSourceClock(700);
      const trigger = clock.allocateSpectrum({ contextId: 'fm' });
      clock.allocateDetectedPower(trigger, {
        ...captureTarget(rawTargetId),
        projectedRepresentativeId: 'signal-association-center',
        representativeKey: 'regular-spectral-component-activity:lineage-0001',
      });
      return createHash('sha256')
        .update(JSON.stringify(clock.trace()))
        .digest('hex');
    };

    expect(traceHash('signal-left')).not.toBe(traceHash('signal-right'));
  });

  it('rejects invalid geometry inputs', () => {
    expect(() => occupiedBandwidthRbwDivisorGeometry(0)).toThrow(/finite and positive/);
    expect(() => observableTrainingActualRbwHz(
      { occupiedBandwidthHz: 20, recommendedSpanHz: 10 },
      SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
    )).toThrow(/contained by its recommended span/);
    expect(() => createObservableTrainingSourceClock(-1)).toThrow(/non-negative safe integer/);
    expect(() => createObservableTrainingSourceClock(1.5)).toThrow(/non-negative safe integer/);
    expect(() => createObservableTrainingSourceClock(Number.NaN))
      .toThrow(/non-negative safe integer/);
  });

  it('rejects incomplete or mutated detected-power target attribution', () => {
    const wrongPolicyClock = createObservableTrainingSourceClock();
    const wrongPolicyTrigger = wrongPolicyClock.allocateSpectrum();
    expect(() => wrongPolicyClock.allocateDetectedPower(wrongPolicyTrigger, {
      ...captureTarget(),
      targetSelectionPolicyId:
        'unreviewed-target-selection-policy' as typeof SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
    })).toThrow(/target selection policy/);

    const missingRawTargetClock = createObservableTrainingSourceClock();
    const missingRawTargetTrigger = missingRawTargetClock.allocateSpectrum();
    expect(() => missingRawTargetClock.allocateDetectedPower(
      missingRawTargetTrigger,
      { ...captureTarget(), rawTargetId: '' },
    )).toThrow(/raw target ID must be a non-empty string/);

    const invalidTuneClock = createObservableTrainingSourceClock();
    const invalidTuneTrigger = invalidTuneClock.allocateSpectrum();
    expect(() => invalidTuneClock.allocateDetectedPower(
      invalidTuneTrigger,
      { ...captureTarget(), admittedTuneHz: Number.NaN },
    )).toThrow(/admitted tune frequency must be finite/);
  });

  it('rejects foreign and stale detected-power triggers', () => {
    const firstClock = createObservableTrainingSourceClock();
    const secondClock = createObservableTrainingSourceClock();
    const foreign = firstClock.allocateSpectrum();
    expect(() => secondClock.allocateDetectedPower(
      foreign,
      captureTarget(),
    )).toThrow(/from this source clock/);

    const stale = secondClock.allocateSpectrum();
    secondClock.allocateSpectrum();
    expect(() => secondClock.allocateDetectedPower(
      stale,
      captureTarget(),
    )).toThrow(/immediately follow/);

    const wrongClock = {
      policyId: 'not-the-production-clock',
    } as unknown as Readonly<ObservableTrainingSourceClock>;
    expect(() => createSignalLabProductionProfileCapturePolicy(wrongClock, 'cw'))
      .toThrow(/shared monotonic source clock/);
    expect(() => createSignalLabProductionProfileCapturePolicy(firstClock, '  '))
      .toThrow(/profile ID must be a non-empty string/);
    expect(() => firstClock.allocateSpectrum({ contextId: '' }))
      .toThrow(/context ID must be a non-empty string/);
    expect(() => firstClock.allocateSpectrum({ spectrumOpportunity: -1 }))
      .toThrow(/spectrum opportunity must be a non-negative safe integer/);
  });
});
