export const OBSERVABLE_TRAINING_SWEEP_POINTS = 450 as const;

export const SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ = 100_000 as const;

export const OBSERVABLE_TRAINING_DETECTED_POWER_SYNTHESIS_FILTER_POLICY = Object.freeze({
  id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
  divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
  signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
  signalLabProductionSynthesisFilterWidthHz:
    SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
  measurementActualRbwQualification: 'unavailable',
} as const);

export const SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY = Object.freeze({
  id: 'signal-lab-recommended-span-450-point-grid-v1',
  sourceKind: 'signal-lab',
  kind: 'recommended-span-inclusive-grid',
  sweepPoints: OBSERVABLE_TRAINING_SWEEP_POINTS,
  spanPolicy: 'canonical-recommended-span-v1',
  resolutionScalePolicy: 'recommended-span-divided-by-points-minus-one-v1',
} as const);

export const SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID =
  'shared-monotonic-source-clock-v1' as const;
export const SIGNAL_LAB_PRODUCTION_ACQUISITION_BRANCH_POLICY_ID =
  'independent-no-auto-spectrum-and-qualified-rank-0-integrated-excess-envelope-sessions-v2' as const;
export const SIGNAL_LAB_PRODUCTION_SPECTRUM_DETECTED_POWER_CAPTURE_POLICY_ID =
  'no-automatic-detected-power-capture-v1' as const;
export const SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID =
  'capture-once-after-rank-0-integrated-excess-current-target-runtime-admission-v3' as const;
export const SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID =
  'preferred-then-current-source-sweep-integrated-excess-power-physical-or-qualified-agile-member-target-v4' as const;

interface SignalLabProductionReleaseGateProfileSourcePlanBase {
  readonly profileId: string;
  readonly profileOrdinal: number;
  readonly sourceLookIndexOffset: number;
  readonly spectrumOpportunities: number;
}

export interface SignalLabProductionSpectrumReleaseGateProfileSourcePlan
  extends SignalLabProductionReleaseGateProfileSourcePlanBase {
  readonly automaticDetectedPowerCaptures: 0;
}

export interface SignalLabProductionQualifiedEnvelopeReleaseGateProfileSourcePlan
  extends SignalLabProductionReleaseGateProfileSourcePlanBase {
  readonly admittedDetectedPowerCaptures: 1;
}

const SIGNAL_LAB_PRODUCTION_RELEASE_GATE_PROFILE_HORIZONS = Object.freeze([
  Object.freeze({ profileId: 'cw', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'am', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'fm', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'gsm-900-loaded-bcch', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'lte-band3-fdd-20m', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'lte-band38-tdd-10m', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'nr-n3-fdd-20m', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'nr-n78-tdd-100m', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'wifi-hr-dsss-11m', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'wifi-ofdm-20m', spectrumOpportunities: 32 } as const),
  Object.freeze({ profileId: 'bluetooth-classic-connected', spectrumOpportunities: 96 } as const),
  Object.freeze({ profileId: 'bluetooth-le-advertising', spectrumOpportunities: 96 } as const),
] as const);

function signalLabProductionSpectrumReleaseGateSourcePlan():
readonly Readonly<SignalLabProductionSpectrumReleaseGateProfileSourcePlan>[] {
  let nextSourceLookIndex = 0;
  return Object.freeze(SIGNAL_LAB_PRODUCTION_RELEASE_GATE_PROFILE_HORIZONS.map(
    ({ profileId, spectrumOpportunities }, profileOrdinal) => {
      const sourcePlan = Object.freeze({
        profileId,
        profileOrdinal,
        sourceLookIndexOffset: nextSourceLookIndex,
        spectrumOpportunities,
        automaticDetectedPowerCaptures: 0,
      } as const);
      nextSourceLookIndex += spectrumOpportunities;
      return sourcePlan;
    },
  ));
}

function signalLabProductionQualifiedEnvelopeReleaseGateSourcePlan():
readonly Readonly<SignalLabProductionQualifiedEnvelopeReleaseGateProfileSourcePlan>[] {
  let nextSourceLookIndex = 0;
  return Object.freeze(SIGNAL_LAB_PRODUCTION_RELEASE_GATE_PROFILE_HORIZONS.map(
    ({ profileId, spectrumOpportunities }, profileOrdinal) => {
      const sourcePlan = Object.freeze({
        profileId,
        profileOrdinal,
        sourceLookIndexOffset: nextSourceLookIndex,
        spectrumOpportunities,
        admittedDetectedPowerCaptures: 1,
      } as const);
      nextSourceLookIndex += spectrumOpportunities + sourcePlan.admittedDetectedPowerCaptures;
      return sourcePlan;
    },
  ));
}

/**
 * Exact source-clock plan exercised by the deployed no-auto-capture spectrum
 * branch. Its independent session consumes only swept-spectrum acquisitions.
 */
export const SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN =
  signalLabProductionSpectrumReleaseGateSourcePlan();

/**
 * Exact source-clock plan exercised by the deployed qualified-envelope branch.
 * A profile start includes every preceding swept spectrum plus the one physical
 * detected-power capture triggered once its exact integrated-excess rank-0
 * target is runtime-admitted. A ready lower-ranked target is never substituted.
 */
export const SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN =
  signalLabProductionQualifiedEnvelopeReleaseGateSourcePlan();

/**
 * @deprecated Use SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.
 * This alias preserves the original combined-branch name while callers migrate.
 */
export const SIGNAL_LAB_PRODUCTION_RELEASE_GATE_SOURCE_PLAN =
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN;

export interface ObservableTrainingTemporalSchedule {
  readonly id: string;
  readonly sourcePlanProfileId: string;
  readonly sourceLookIndexOffset: number;
  readonly sourcePlanSpectrumOpportunities: number;
}

export interface ObservableTrainingProductionTemporalSchedulePair {
  readonly id: string;
  readonly sourcePlanProfileId: string;
  readonly spectrumTemporalSchedule: Readonly<ObservableTrainingTemporalSchedule>;
  readonly qualifiedEnvelopeTemporalSchedule: Readonly<ObservableTrainingTemporalSchedule>;
}

export const SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES:
readonly Readonly<ObservableTrainingTemporalSchedule>[] = Object.freeze(
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map((sourcePlan) => Object.freeze({
    id: `live-spectrum-release-gate-${sourcePlan.profileId}-start-v3`,
    sourcePlanProfileId: sourcePlan.profileId,
    sourceLookIndexOffset: sourcePlan.sourceLookIndexOffset,
    sourcePlanSpectrumOpportunities: sourcePlan.spectrumOpportunities,
  })),
);

export const SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES:
readonly Readonly<ObservableTrainingTemporalSchedule>[] = Object.freeze(
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN.map(
    (sourcePlan) => Object.freeze({
      id: `live-qualified-envelope-release-gate-${sourcePlan.profileId}-start-v3`,
      sourcePlanProfileId: sourcePlan.profileId,
      sourceLookIndexOffset: sourcePlan.sourceLookIndexOffset,
      sourcePlanSpectrumOpportunities: sourcePlan.spectrumOpportunities,
    }),
  ),
);

export const SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS:
readonly Readonly<ObservableTrainingProductionTemporalSchedulePair>[] = Object.freeze(
  SIGNAL_LAB_PRODUCTION_RELEASE_GATE_PROFILE_HORIZONS.map(({ profileId }, profileOrdinal) => {
    const spectrumTemporalSchedule =
      SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES[profileOrdinal]!;
    const qualifiedEnvelopeTemporalSchedule =
      SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES[profileOrdinal]!;
    if (spectrumTemporalSchedule.sourcePlanProfileId !== profileId
      || qualifiedEnvelopeTemporalSchedule.sourcePlanProfileId !== profileId) {
      throw new Error(`SignalLab production temporal schedules are mispaired for ${profileId}`);
    }
    return Object.freeze({
      id: `live-release-gate-independent-branches-${profileId}-v3`,
      sourcePlanProfileId: profileId,
      spectrumTemporalSchedule,
      qualifiedEnvelopeTemporalSchedule,
    });
  }),
);

/**
 * @deprecated Use SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES
 * or SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS to select branch semantics.
 */
export const SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES =
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES;

export const SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME_METADATA = Object.freeze({
  id: 'signal-lab-recommended-span-grid-with-independent-production-branch-source-clocks-v5',
  geometry: SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY,
  branchPolicy: SIGNAL_LAB_PRODUCTION_ACQUISITION_BRANCH_POLICY_ID,
  sourceClocks: Object.freeze({
    spectrum: Object.freeze({
      id: SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
      acquisitionIndexPolicy: 'one-look-index-per-physical-acquisition-v1',
      detectedPowerCapturePolicy:
        SIGNAL_LAB_PRODUCTION_SPECTRUM_DETECTED_POWER_CAPTURE_POLICY_ID,
    } as const),
    qualifiedEnvelope: Object.freeze({
      id: SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
      acquisitionIndexPolicy: 'one-look-index-per-physical-acquisition-v1',
      detectedPowerCapturePolicy: SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
      captureTargetSelectionPolicy:
        SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
      postCaptureSpectrumPolicy: 'continue-at-next-shared-look-index-v1',
    } as const),
  } as const),
  spectrumReleaseGateSourcePlan: SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN,
  qualifiedEnvelopeReleaseGateSourcePlan:
    SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN,
  temporalSchedulePairs: SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULE_PAIRS,
  componentFitIncluded: true,
  tailCalibrationIncluded: true,
} as const);

export const OBSERVABLE_TRAINING_BASELINE_SPECTRUM_TEMPORAL_SCHEDULE =
  SIGNAL_LAB_PRODUCTION_SPECTRUM_TEMPORAL_SCHEDULES[0]!;
export const OBSERVABLE_TRAINING_BASELINE_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULE =
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULES[0]!;
/** @deprecated Select the branch-specific baseline schedule explicitly. */
export const OBSERVABLE_TRAINING_BASELINE_TEMPORAL_SCHEDULE =
  OBSERVABLE_TRAINING_BASELINE_QUALIFIED_ENVELOPE_TEMPORAL_SCHEDULE;

export interface ObservableTrainingScenarioGeometry {
  readonly occupiedBandwidthHz: number;
  readonly recommendedSpanHz: number;
}

export type ObservableTrainingAcquisitionGeometry =
  | Readonly<{
    id: string;
    kind: 'occupied-bandwidth-rbw-divisor';
    rbwDivisor: number;
    sweepPoints: typeof OBSERVABLE_TRAINING_SWEEP_POINTS;
  }>
  | typeof SIGNAL_LAB_PRODUCTION_ACQUISITION_GEOMETRY;

export interface ObservableTrainingAcquisitionRegime {
  readonly id: string;
  readonly geometry: ObservableTrainingAcquisitionGeometry;
  readonly spectrumTemporalSchedule: ObservableTrainingTemporalSchedule;
  readonly qualifiedEnvelopeTemporalSchedule: ObservableTrainingTemporalSchedule;
}

export type ObservableTrainingSourceClockEvent =
  | ObservableTrainingSpectrumClockEvent
  | ObservableTrainingDetectedPowerClockEvent;

export interface ObservableTrainingSpectrumClockEvent {
  readonly kind: 'swept-spectrum';
  readonly clockPolicyId: typeof SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID;
  readonly acquisitionOrdinal: number;
  readonly lookIndex: number;
  readonly contextId?: string;
  readonly spectrumOpportunity?: number;
}

export interface ObservableTrainingDetectedPowerClockEvent {
  readonly kind: 'detected-power';
  readonly clockPolicyId: typeof SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID;
  readonly acquisitionOrdinal: number;
  readonly lookIndex: number;
  readonly triggerSpectrumAcquisitionOrdinal: number;
  readonly triggerSpectrumLookIndex: number;
  readonly contextId?: string;
  readonly targetSelectionPolicyId:
    typeof SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID;
  readonly rawTargetId: string;
  readonly projectedRepresentativeId: string;
  readonly representativeKey: string;
  readonly selectedPeakHz: number;
  readonly selectedPeakDbm: number;
  readonly admittedTuneHz: number;
}

export interface ObservableTrainingSpectrumClockContext {
  readonly contextId?: string;
  readonly spectrumOpportunity?: number;
}

export interface ObservableTrainingDetectedPowerClockContext {
  readonly contextId?: string;
  readonly targetSelectionPolicyId:
    typeof SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID;
  readonly rawTargetId: string;
  readonly projectedRepresentativeId: string;
  readonly representativeKey: string;
  readonly selectedPeakHz: number;
  readonly selectedPeakDbm: number;
  readonly admittedTuneHz: number;
}

export interface ObservableTrainingSourceClock {
  readonly policyId: typeof SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID;
  allocateSpectrum(
    context?: Readonly<ObservableTrainingSpectrumClockContext>,
  ): Readonly<ObservableTrainingSpectrumClockEvent>;
  allocateDetectedPower(
    triggerSpectrum: Readonly<ObservableTrainingSpectrumClockEvent>,
    context: Readonly<ObservableTrainingDetectedPowerClockContext>,
  ): Readonly<ObservableTrainingDetectedPowerClockEvent>;
  trace(): readonly Readonly<ObservableTrainingSourceClockEvent>[];
}

export interface SignalLabProductionProfileCapturePolicy {
  readonly policyId: typeof SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID;
  readonly profileId: string;
  allocateSpectrum(spectrumOpportunity?: number): Readonly<ObservableTrainingSpectrumClockEvent>;
  captureAfterRuntimeAdmission(
    triggerSpectrum: Readonly<ObservableTrainingSpectrumClockEvent>,
    target: Readonly<Omit<ObservableTrainingDetectedPowerClockContext, 'contextId'>>,
  ): Readonly<ObservableTrainingDetectedPowerClockEvent> | null;
  detectedPowerCapture(): Readonly<ObservableTrainingDetectedPowerClockEvent> | null;
}

export function occupiedBandwidthRbwDivisorGeometry(
  rbwDivisor: number,
): ObservableTrainingAcquisitionGeometry {
  if (!Number.isFinite(rbwDivisor) || rbwDivisor <= 0) {
    throw new Error('Observable-training RBW divisor must be finite and positive');
  }
  return Object.freeze({
    id: `occupied-bandwidth-rbw-divisor:${rbwDivisor}`,
    kind: 'occupied-bandwidth-rbw-divisor',
    rbwDivisor,
    sweepPoints: OBSERVABLE_TRAINING_SWEEP_POINTS,
  });
}

export function observableTrainingActualRbwHz(
  scenario: ObservableTrainingScenarioGeometry,
  geometry: ObservableTrainingAcquisitionGeometry,
): number {
  if (!Number.isFinite(scenario.occupiedBandwidthHz) || scenario.occupiedBandwidthHz <= 0
    || !Number.isFinite(scenario.recommendedSpanHz)
    || scenario.recommendedSpanHz < scenario.occupiedBandwidthHz) {
    throw new Error('Observable-training scenario geometry must have a finite positive occupied bandwidth contained by its recommended span');
  }
  const inclusiveGridSpacingHz = scenario.recommendedSpanHz / (geometry.sweepPoints - 1);
  if (geometry.kind === 'recommended-span-inclusive-grid') return inclusiveGridSpacingHz;
  return Math.max(
    inclusiveGridSpacingHz * 0.8,
    scenario.occupiedBandwidthHz / geometry.rbwDivisor,
    1_000,
  );
}

/**
 * Returns an explicit generator parameter, never observed measurement evidence.
 * Divisor regimes retain the broad v11 receiver-filter nuisance matrix, while
 * the named SignalLab production regime reproduces its owned 100 kHz replay.
 */
export function observableTrainingDetectedPowerSynthesisFilterWidthHz(
  scenario: ObservableTrainingScenarioGeometry,
  geometry: ObservableTrainingAcquisitionGeometry,
): number {
  const spectrumActualRbwHz = observableTrainingActualRbwHz(scenario, geometry);
  return geometry.kind === 'recommended-span-inclusive-grid'
    ? SIGNAL_LAB_PRODUCTION_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ
    : spectrumActualRbwHz;
}

function assertSourceLookIndexOffset(sourceLookIndexOffset: number): void {
  if (!Number.isSafeInteger(sourceLookIndexOffset) || sourceLookIndexOffset < 0) {
    throw new Error('Observable-training source look-index offset must be a non-negative safe integer');
  }
}

function assertOptionalNonEmptyString(value: string | undefined, label: string): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when provided`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertOptionalSpectrumOpportunity(spectrumOpportunity: number | undefined): void {
  if (spectrumOpportunity !== undefined
    && (!Number.isSafeInteger(spectrumOpportunity) || spectrumOpportunity < 0)) {
    throw new Error('Observable-training spectrum opportunity must be a non-negative safe integer when provided');
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

/**
 * Allocates one monotonically increasing source look index per physical
 * acquisition. Detected-power events must be allocated immediately after the
 * swept spectrum that triggered them; no inferred or precomputed skip exists.
 */
export function createObservableTrainingSourceClock(
  sourceLookIndexOffset = 0,
): Readonly<ObservableTrainingSourceClock> {
  assertSourceLookIndexOffset(sourceLookIndexOffset);
  const events: Readonly<ObservableTrainingSourceClockEvent>[] = [];
  let nextLookIndex = sourceLookIndexOffset;

  const allocateLookIndex = (): { readonly acquisitionOrdinal: number; readonly lookIndex: number } => {
    if (!Number.isSafeInteger(nextLookIndex)) {
      throw new Error('Observable-training source clock exhausted the safe-integer look-index domain');
    }
    const allocation = Object.freeze({
      acquisitionOrdinal: events.length,
      lookIndex: nextLookIndex,
    });
    nextLookIndex += 1;
    return allocation;
  };

  const clock: ObservableTrainingSourceClock = {
    policyId: SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
    allocateSpectrum(context = {}) {
      assertOptionalNonEmptyString(context.contextId, 'Observable-training clock context ID');
      assertOptionalSpectrumOpportunity(context.spectrumOpportunity);
      const allocation = allocateLookIndex();
      const event = Object.freeze({
        kind: 'swept-spectrum',
        clockPolicyId: SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
        ...allocation,
        ...(context.contextId === undefined ? {} : { contextId: context.contextId }),
        ...(context.spectrumOpportunity === undefined
          ? {}
          : { spectrumOpportunity: context.spectrumOpportunity }),
      } as const);
      events.push(event);
      return event;
    },
    allocateDetectedPower(triggerSpectrum, context) {
      assertOptionalNonEmptyString(context.contextId, 'Observable-training clock context ID');
      if (context.targetSelectionPolicyId
        !== SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID) {
        throw new Error(`Detected-power target selection policy must be ${SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID}`);
      }
      assertNonEmptyString(context.rawTargetId, 'Observable-training raw target ID');
      assertNonEmptyString(
        context.projectedRepresentativeId,
        'Observable-training projected representative ID',
      );
      assertNonEmptyString(context.representativeKey, 'Observable-training representative key');
      assertFiniteNumber(context.selectedPeakHz, 'Observable-training selected peak frequency');
      assertFiniteNumber(context.selectedPeakDbm, 'Observable-training selected peak power');
      assertFiniteNumber(context.admittedTuneHz, 'Observable-training admitted tune frequency');
      if (triggerSpectrum.kind !== 'swept-spectrum'
        || events[triggerSpectrum.acquisitionOrdinal] !== triggerSpectrum) {
        throw new Error('Detected-power trigger must be a swept-spectrum event from this source clock');
      }
      if (events.at(-1) !== triggerSpectrum) {
        throw new Error('Detected-power acquisition must immediately follow its triggering swept spectrum');
      }
      if (context.contextId !== undefined
        && triggerSpectrum.contextId !== undefined
        && context.contextId !== triggerSpectrum.contextId) {
        throw new Error('Detected-power context ID must match its triggering swept spectrum');
      }
      const allocation = allocateLookIndex();
      const event = Object.freeze({
        kind: 'detected-power',
        clockPolicyId: SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID,
        ...allocation,
        triggerSpectrumAcquisitionOrdinal: triggerSpectrum.acquisitionOrdinal,
        triggerSpectrumLookIndex: triggerSpectrum.lookIndex,
        ...(context.contextId === undefined ? {} : { contextId: context.contextId }),
        targetSelectionPolicyId: context.targetSelectionPolicyId,
        rawTargetId: context.rawTargetId,
        projectedRepresentativeId: context.projectedRepresentativeId,
        representativeKey: context.representativeKey,
        selectedPeakHz: context.selectedPeakHz,
        selectedPeakDbm: context.selectedPeakDbm,
        admittedTuneHz: context.admittedTuneHz,
      } as const);
      events.push(event);
      return event;
    },
    trace() {
      return Object.freeze([...events]);
    },
  };
  return Object.freeze(clock);
}

/**
 * Per-profile live policy layered on a shared source clock. The caller invokes
 * capture only once a representative has actually passed runtime admission.
 * Allocation happens after spectrum feature extraction but before the
 * physical detected-power synthesis and envelope extraction. Once allocated,
 * a later failure cannot roll back or reuse that physical acquisition index.
 */
export function createSignalLabProductionProfileCapturePolicy(
  sourceClock: Readonly<ObservableTrainingSourceClock>,
  profileId: string,
): Readonly<SignalLabProductionProfileCapturePolicy> {
  if (sourceClock.policyId !== SIGNAL_LAB_PRODUCTION_SOURCE_CLOCK_POLICY_ID) {
    throw new Error('SignalLab production capture policy requires the shared monotonic source clock');
  }
  assertNonEmptyString(profileId, 'SignalLab production profile ID');
  let capture: Readonly<ObservableTrainingDetectedPowerClockEvent> | null = null;
  const policy: SignalLabProductionProfileCapturePolicy = {
    policyId: SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
    profileId,
    allocateSpectrum: (spectrumOpportunity) => sourceClock.allocateSpectrum({
      contextId: profileId,
      ...(spectrumOpportunity === undefined ? {} : { spectrumOpportunity }),
    }),
    captureAfterRuntimeAdmission(triggerSpectrum, target) {
      if (capture !== null) return null;
      capture = sourceClock.allocateDetectedPower(triggerSpectrum, {
        contextId: profileId,
        ...target,
      });
      return capture;
    },
    detectedPowerCapture: () => capture,
  };
  return Object.freeze(policy);
}
