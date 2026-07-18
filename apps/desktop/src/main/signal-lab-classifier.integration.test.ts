import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classificationCaptureTargetProjections,
  classificationRepresentatives,
  createDetectedPowerCaptureReceipt,
  extractObservableFeatures,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
  SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN,
  SignalDetector,
  SignalTracker,
  type WaveformEvidence,
} from '@tinysa/analysis';
import { observableRepresentativeIsInClassDomain } from '../../../../../Atom-Classifier/src/observable-hypothesis-domain.js';
import type { ObservableLeafClass } from '../../../../../Atom-Classifier/src/observable-classifier-model.js';
import { SignalLabBayesianClassifier } from '../../../../../Atom-Classifier/src/signal-lab-classifier.js';
import { projectDetectedPowerTuneHz } from '@tinysa/contracts';
import type {
  DetectedSignal,
  InstrumentMeasurement,
  InstrumentConfiguration,
  InstrumentFeatureCapability,
  SignalDetectionConfig,
  Sweep,
  WaveformClassification,
} from '@tinysa/contracts';
import {
  SIGNAL_LAB_EXACT_SWEEP_SECONDS,
  SignalLabInstrumentDriver,
} from '@tinysa/signal-lab-driver';
import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';
import { AtomizerInstrumentHost } from './atomizer-instrument-host.js';
import {
  projectDetectedPowerMeasurement,
  projectSpectrumMeasurement,
} from '../renderer/instrument-measurement-projection.js';

const SPECTRUM_POINTS = 450;
const HISTORY_LIMIT = 128;
const CLASSIFICATION_SWEEPS = 8;
const STANDARD_OPPORTUNITIES = 32;
const FULL_BAND_BLUETOOTH_OPPORTUNITIES = 96;
const DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};

interface CanonizedProfileGate {
  readonly profileId: string;
  readonly modelTruth: ObservableLeafClass;
  readonly allowedLabels: readonly string[];
  readonly opportunities: number;
}

const CANONIZED_PROFILE_GATES: readonly CanonizedProfileGate[] = [
  profile('cw', 'cw-like', ['observable:cw-like']),
  profile('am', 'am-dsb-full-carrier-like', ['observable:am-dsb-full-carrier-like']),
  profile('fm', 'fm-angle-modulated-like', ['observable:fm-angle-modulated-like']),
  profile('gsm-900-loaded-bcch', 'gsm-like', ['observable:gsm-like']),
  profile('lte-band3-fdd-20m', 'lte-fdd-like', [
    'observable:cellular-ofdm-ambiguous',
  ]),
  profile('lte-band38-tdd-10m', 'lte-tdd-like', [
    'observable:cellular-ofdm-ambiguous',
  ]),
  profile('nr-n3-fdd-20m', 'nr-fdd-like', [
    'observable:cellular-ofdm-ambiguous',
  ]),
  profile('nr-n78-tdd-100m', 'nr-tdd-like', [
    'observable:nr-tdd-like', 'observable:nr-like',
  ]),
  profile('wifi-hr-dsss-11m', 'wifi-hr-dsss-like', [
    'observable:wifi-like',
  ]),
  profile('wifi-ofdm-20m', 'wifi-ofdm-like', [
    'observable:wifi-like',
  ]),
  profile('bluetooth-classic-connected', 'bluetooth-like', [
    'observable:bluetooth-like',
  ], FULL_BAND_BLUETOOTH_OPPORTUNITIES),
  profile('bluetooth-le-advertising', 'bluetooth-like', [
    'observable:bluetooth-like',
  ], FULL_BAND_BLUETOOTH_OPPORTUNITIES),
];

const atomizerRepositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const shippedBridge = resolve(atomizerRepositoryRoot, '..', 'Atom-SignalLab', 'dist', 'bridge', 'atomizer-bridge.js');
const signalLabIntegrationRequired = process.env.SIGNAL_LAB_INTEGRATION_REQUIRED === '1';
const profileFilter = process.env.SIGNAL_LAB_CLASSIFIER_PROFILE?.trim();

if (signalLabIntegrationRequired && !existsSync(shippedBridge)) {
  throw new Error(`Required SignalLab integration bridge is missing at ${shippedBridge}`);
}
if (signalLabIntegrationRequired && profileFilter) {
  throw new Error('Required SignalLab integration may not narrow the canonized profile matrix');
}
const activeProfileGates = profileFilter
  ? CANONIZED_PROFILE_GATES.filter((gate) => gate.profileId === profileFilter)
  : CANONIZED_PROFILE_GATES;
if (profileFilter && activeProfileGates.length !== 1) {
  throw new Error(`Unknown SignalLab classifier profile filter ${profileFilter}`);
}

describe('SignalLab live observable-classification release gates', () => {
  // Standalone Atomizer checkouts can omit sibling repositories. `npm run
  // check` and the trio release gate build SignalLab first, so these tests are
  // mandatory there and skipped only when the owned executable is absent.
  it.skipIf(!existsSync(shippedBridge))(
    'matches the App-compatible consecutive-spectrum branch with no automatic detected-power capture',
    async () => {
      const host = createLiveSignalLabHost();
      try {
        const { profileCapability } = await connectLiveSignalLabHost(host);
        assertSourcePlanMatchesProfiles(SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN);
        let expectedSourceSequence = 0;
        let aggregateRollingCases = 0;
        let aggregateCoveredRollingCases = 0;
        let aggregateHierarchicalRollingCases = 0;
        let aggregateIncompatibleNonUnknownCases = 0;

        for (const gate of activeProfileGates) {
          const sourcePlan = SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN
            .find((item) => item.profileId === gate.profileId)!;
          expect(sourcePlan.automaticDetectedPowerCaptures).toBe(0);
          if (!profileFilter) expect(expectedSourceSequence).toBe(sourcePlan.sourceLookIndexOffset);
          const geometry = await selectProfileGeometry(host, gate, profileCapability.profiles);
          const spectrumConfiguration = syntheticSpectrumConfiguration(
            geometry.centerFrequencyHz,
            geometry.recommendedSpanHz,
          );
          const spectrumState = await host.configure(spectrumConfiguration);
          const detector = new SignalDetector(DETECTION_CONFIG);
          const tracker = new SignalTracker(DETECTION_CONFIG);
          const classifier = new SignalLabBayesianClassifier();
          let history: readonly Sweep[] = [];
          let rollingCases = 0;
          let coveredRollingCases = 0;
          let hierarchicalRollingCases = 0;
          let incompatibleNonUnknownCases = 0;
          let truthClassDomainCases = 0;
          const unknownReasons = new Map<string, number>();
          const supportRanks: number[] = [];
          const representativeGeometry = new Map<string, number>();
          const classificationOutcomes = new Map<string, number>();
          const rawCandidatePatterns = new Map<string, number>();

          for (let opportunity = 1; opportunity <= gate.opportunities; opportunity++) {
            const measurement = await host.acquire();
            expectedSourceSequence++;
            expect(measurement.sequence).toBe(expectedSourceSequence);
            if (measurement.kind !== 'swept-spectrum') {
              throw new Error(`App-compatible branch unexpectedly acquired ${measurement.kind}`);
            }
            expect(measurement.configurationRevision).toBe(spectrumState.configurationRevision);
            assertNoClassificationLabels(measurement, gate);
            const sweep = projectLiveSpectrum(host, measurement, spectrumConfiguration, gate);
            history = [sweep, ...history].slice(0, HISTORY_LIMIT);
            const rawCandidates = detector.analyze(sweep);
            const rawPattern = JSON.stringify(rawCandidates.map((candidate) => ({
              startHz: candidate.startHz,
              stopHz: candidate.stopHz,
              bandwidthHz: candidate.bandwidthHz,
              centerHz: (candidate.startHz + candidate.stopHz) / 2,
            })).sort((left, right) => left.centerHz - right.centerHz));
            rawCandidatePatterns.set(rawPattern, (rawCandidatePatterns.get(rawPattern) ?? 0) + 1);
            const representatives = classificationRepresentatives(
              tracker.update(sweep, rawCandidates).filter((item) => item.state === 'active'),
            );
            for (const detection of representatives) {
              const geometryKey = representativeGeometryKey(detection);
              representativeGeometry.set(geometryKey, (representativeGeometry.get(geometryKey) ?? 0) + 1);
              assertNoClassificationLabels(detection, gate);
              if (!runtimeRepresentativeIsReady(detection)) continue;
              const evidence = { sweeps: history } satisfies WaveformEvidence;
              assertNoClassificationLabels(evidence, gate);
              const result = await classifier.classify(detection, evidence);
              assertSpectrumOnlyResult(result, gate, 'zero-span-missing');
              expect(result.evidence.sweepIds).toHaveLength(CLASSIFICATION_SWEEPS);
              rollingCases++;
              const compatible = gate.allowedLabels.includes(result.label);
              if (result.label !== 'unknown') coveredRollingCases++;
              if (compatible) hierarchicalRollingCases++;
              if (result.label !== 'unknown' && !compatible) incompatibleNonUnknownCases++;
              if (result.label === 'unknown') {
                const reason = result.unknownReason ?? 'unspecified';
                unknownReasons.set(reason, (unknownReasons.get(reason) ?? 0) + 1);
              }
              const supportRank = result.evidence.features?.['model.maximumKnownSyntheticSupportRank'];
              if (supportRank !== undefined) supportRanks.push(supportRank);
              const observation = extractObservableFeatures(detection, evidence);
              const outcomeKey = JSON.stringify({
                localBandwidthHz: detection.bandwidthHz,
                classificationRegionWidthHz: detection.classificationRegionStartHz !== undefined
                  && detection.classificationRegionStopHz !== undefined
                  ? detection.classificationRegionStopHz - detection.classificationRegionStartHz
                  : null,
                observedBandwidthHz: observation.bandwidthHz,
                label: result.label,
                unknownReason: result.unknownReason,
                supportRank,
              });
              classificationOutcomes.set(outcomeKey, (classificationOutcomes.get(outcomeKey) ?? 0) + 1);
              if (observableRepresentativeIsInClassDomain(gate.modelTruth, observation)) truthClassDomainCases++;
              if (result.label !== 'unknown') expect(result.decisionSupport?.kind).toBe('model-posterior');
            }
          }

          expect(rollingCases, `${gate.profileId} produced no current-qualified online-ready production representatives`).toBeGreaterThan(0);
          const supportRange = supportRanks.length
            ? `${Math.min(...supportRanks)}..${Math.max(...supportRanks)}`
            : 'unavailable';
          expect(
            coveredRollingCases / rollingCases,
            `${gate.profileId} complete-denominator rolling known coverage; unknown=${JSON.stringify(Object.fromEntries(unknownReasons))}; support=${supportRange}; representatives=${JSON.stringify(Object.fromEntries(representativeGeometry))}; outcomes=${JSON.stringify(Object.fromEntries(classificationOutcomes))}; raw=${JSON.stringify(Object.fromEntries(rawCandidatePatterns))}`,
          ).toBeGreaterThanOrEqual(0.9);
          expect(hierarchicalRollingCases / rollingCases).toBeGreaterThanOrEqual(0.9);
          expect(incompatibleNonUnknownCases).toBe(0);
          expect(truthClassDomainCases).toBeGreaterThan(0);
          if (!profileFilter) {
            expect(expectedSourceSequence)
              .toBe(sourcePlan.sourceLookIndexOffset + sourcePlan.spectrumOpportunities);
          }
          aggregateRollingCases += rollingCases;
          aggregateCoveredRollingCases += coveredRollingCases;
          aggregateHierarchicalRollingCases += hierarchicalRollingCases;
          aggregateIncompatibleNonUnknownCases += incompatibleNonUnknownCases;
        }

        expect(aggregateCoveredRollingCases / aggregateRollingCases).toBeGreaterThanOrEqual(0.95);
        expect(aggregateHierarchicalRollingCases / aggregateRollingCases).toBeGreaterThanOrEqual(0.95);
        expect(aggregateIncompatibleNonUnknownCases).toBe(0);
        expect(expectedSourceSequence).toBe(activeProfileGates.reduce(
          (total, gate) => total + gate.opportunities,
          0,
        ));
        if (!profileFilter) expect(expectedSourceSequence).toBe(512);
      } finally {
        await host.shutdown();
      }
    },
    600_000,
  );

  it.skipIf(!existsSync(shippedBridge))(
    'keeps a fresh qualified-envelope branch causal and excludes unqualified manual captures from Bayesian envelope evidence',
    async () => {
      const host = createLiveSignalLabHost();
      try {
        const { profileCapability, detectedPowerCapability } = await connectLiveSignalLabHost(host);
        assertSourcePlanMatchesProfiles(
          SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN,
        );
        let expectedSourceSequence = 0;
        let envelopeCases = 0;
        let compatibleEnvelopeCases = 0;
        const envelopeOutcomes = new Map<string, Readonly<Record<string, unknown>>>();

        for (const gate of activeProfileGates) {
          const sourcePlan = SIGNAL_LAB_PRODUCTION_QUALIFIED_ENVELOPE_RELEASE_GATE_SOURCE_PLAN
            .find((item) => item.profileId === gate.profileId)!;
          expect(sourcePlan.admittedDetectedPowerCaptures).toBe(1);
          if (!profileFilter) expect(expectedSourceSequence).toBe(sourcePlan.sourceLookIndexOffset);
          const geometry = await selectProfileGeometry(host, gate, profileCapability.profiles);
          const spectrumConfiguration = syntheticSpectrumConfiguration(
            geometry.centerFrequencyHz,
            geometry.recommendedSpanHz,
          );
          let spectrumState = await host.configure(spectrumConfiguration);
          const detector = new SignalDetector(DETECTION_CONFIG);
          const tracker = new SignalTracker(DETECTION_CONFIG);
          const classifier = new SignalLabBayesianClassifier();
          let history: readonly Sweep[] = [];
          let envelopeConsumed = false;

          for (let opportunity = 1; opportunity <= gate.opportunities; opportunity++) {
            const measurement = await host.acquire();
            expectedSourceSequence++;
            expect(measurement.sequence).toBe(expectedSourceSequence);
            if (measurement.kind !== 'swept-spectrum') {
              throw new Error(`Expected swept-spectrum measurement for ${gate.profileId}`);
            }
            expect(measurement.configurationRevision).toBe(spectrumState.configurationRevision);
            const sweep = projectLiveSpectrum(host, measurement, spectrumConfiguration, gate);
            history = [sweep, ...history].slice(0, HISTORY_LIMIT);
            const captureTargetSignals = tracker.update(sweep, detector.analyze(sweep));
            const projections = classificationCaptureTargetProjections(captureTargetSignals);
            for (const { rawTarget, projectedRepresentative: detection } of projections) {
              if (envelopeConsumed || !runtimeRepresentativeIsReady(detection)) continue;
              let spectrumObservation: ReturnType<typeof extractObservableFeatures>;
              try {
                spectrumObservation = extractObservableFeatures(detection, {
                  sweeps: history,
                });
              } catch (error) {
                if (error instanceof ObservableEvidenceUnavailableError) continue;
                throw error;
              }
              if (spectrumObservation.sweepIds.length !== CLASSIFICATION_SWEEPS) {
                continue;
              }
              const detectedPowerTuneHz = projectDetectedPowerTuneHz(
                rawTarget.peakHz,
                detectedPowerCapability.centerFrequencyHz,
              );
              const detectedPowerConfiguration = syntheticDetectedPowerConfiguration(detectedPowerTuneHz);
              const detectedPowerState = await host.configure(detectedPowerConfiguration);
              const detectedPowerMeasurement = await host.acquire();
              expectedSourceSequence++;
              expect(detectedPowerMeasurement.sequence).toBe(expectedSourceSequence);
              if (detectedPowerMeasurement.kind !== 'detected-power-timeseries') {
                throw new Error(`Expected detected-power measurement for ${gate.profileId}`);
              }
              expect(detectedPowerMeasurement.centerHz).toBe(detectedPowerTuneHz);
              expect(detectedPowerMeasurement.configurationRevision).toBe(detectedPowerState.configurationRevision);
              const detectedPowerSession = host.state().session;
              if (!detectedPowerSession) throw new Error('SignalLab session disappeared during detected-power projection');
              const projectedEnvelope = projectDetectedPowerMeasurement(
                detectedPowerMeasurement,
                detectedPowerSession,
                detectedPowerConfiguration,
                rawTarget.id,
              );
              expect(projectedEnvelope).toMatchObject({
                targetDetectionId: rawTarget.id,
                frequencyHz: detectedPowerTuneHz,
                actualRbwHz: null,
                resolutionBandwidthQualification: 'unavailable',
                actualAttenuationDb: null,
                attenuationQualification: 'not-applicable',
                timingQualification: 'simulation-exact',
              });
              const zeroSpanSpectrumSweepIds = spectrumObservation.sweepIds;
              const unqualifiedManualEvidence = {
                sweeps: history,
                zeroSpan: projectedEnvelope,
                zeroSpanSpectrumSweepIds,
              } satisfies WaveformEvidence;
              const unqualifiedObservation = extractObservableFeatures(
                detection,
                unqualifiedManualEvidence,
              );
              expect(unqualifiedObservation.views).toEqual(['scalar-spectrum']);
              expect(unqualifiedObservation).not.toHaveProperty('zeroSpanCaptureId');
              expect(unqualifiedObservation.limitations).toEqual(expect.arrayContaining([
                'zero-span-acquisition-policy-unqualified',
                'zero-span-missing',
              ]));
              const unqualifiedResult = await classifier.classify(
                detection,
                unqualifiedManualEvidence,
              );
              assertSpectrumOnlyResult(
                unqualifiedResult,
                gate,
                'zero-span-acquisition-policy-unqualified',
              );

              const qualifiedEvidence = {
                ...unqualifiedManualEvidence,
                detectedPowerCaptureReceipt: createDetectedPowerCaptureReceipt({
                  activeSignals: captureTargetSignals,
                  evidenceSweeps: history,
                  capture: projectedEnvelope,
                  admittedTargetTuneHz: detectedPowerTuneHz,
                  spectrumSweepIds: zeroSpanSpectrumSweepIds,
                }),
              } satisfies WaveformEvidence;
              const envelopeObservation = extractObservableFeatures(detection, qualifiedEvidence);
              expect(envelopeObservation.sweepIds).toHaveLength(CLASSIFICATION_SWEEPS);
              const agileFixedTuneCensored =
                detection.associationMode === 'frequency-agile-2g4-activity';
              if (agileFixedTuneCensored) {
                expect(envelopeObservation.views).toEqual(['scalar-spectrum']);
                expect(envelopeObservation.values).toEqual(spectrumObservation.values);
                expect(envelopeObservation.zeroSpanCaptureId).toBeUndefined();
                expect(envelopeObservation.detectedPowerAcquisitionQualification).toBeUndefined();
                expect(envelopeObservation.limitations)
                  .toContain('frequency-agile-fixed-tune-envelope-censored');
              } else {
                expect(
                  envelopeObservation.zeroSpanCaptureId,
                  `live ${gate.profileId} envelope rejection: ${envelopeObservation.limitations.join(', ')}`,
                ).toBe(projectedEnvelope.id);
                expect(envelopeObservation.views).toEqual(['scalar-spectrum', 'detected-power-envelope']);
                expect(envelopeObservation.detectedPowerAcquisitionQualification)
                  .toBe('receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5');
                expect(envelopeObservation.values['envelope.logTransitionRateHz']).toBeTypeOf('number');
              }
              const envelopeResult = await classifier.classify(detection, qualifiedEvidence);
              if (agileFixedTuneCensored) {
                assertSpectrumOnlyResult(
                  envelopeResult,
                  gate,
                  'frequency-agile-fixed-tune-envelope-censored',
                );
              } else {
                assertEnvelopeResult(envelopeResult, projectedEnvelope.id, gate);
              }
              envelopeOutcomes.set(gate.profileId, {
                label: envelopeResult.label,
                unknownReason: envelopeResult.unknownReason,
                confidence: envelopeResult.confidence,
                supportRank: envelopeResult.evidence.features?.['model.maximumKnownSyntheticSupportRank'],
              });
              envelopeCases++;
              if (gate.allowedLabels.includes(envelopeResult.label)) compatibleEnvelopeCases++;
              envelopeConsumed = true;
              spectrumState = await host.configure(spectrumConfiguration);
            }
          }
          expect(envelopeConsumed, `${gate.profileId} never consumed its sole qualified envelope`).toBe(true);
          if (!profileFilter) {
            expect(expectedSourceSequence).toBe(
              sourcePlan.sourceLookIndexOffset
                + sourcePlan.spectrumOpportunities
                + sourcePlan.admittedDetectedPowerCaptures,
            );
          }
        }

        expect(envelopeCases).toBe(activeProfileGates.length);
        expect(
          compatibleEnvelopeCases / envelopeCases,
          `complete live envelope compatibility: ${JSON.stringify(Object.fromEntries(envelopeOutcomes))}`,
        ).toBeGreaterThanOrEqual(0.95);
        expect(expectedSourceSequence).toBe(activeProfileGates.reduce(
          (total, gate) => total + gate.opportunities + 1,
          0,
        ));
        if (!profileFilter) expect(expectedSourceSequence).toBe(524);
      } finally {
        await host.shutdown();
      }
    },
    600_000,
  );

  it.skipIf(!existsSync(shippedBridge))(
    'keeps the live LTE E-TM3.1 equivalence-class probability inside the worker boundary',
    async () => {
      const host = createLiveSignalLabHost();
      const gate = profile('lte-etm3.1', 'lte-fdd-like', [
        'observable:cellular-ofdm-ambiguous',
      ]);
      try {
        const { profileCapability } = await connectLiveSignalLabHost(host);
        const geometry = await selectProfileGeometry(host, gate, profileCapability.profiles);
        const spectrumConfiguration = syntheticSpectrumConfiguration(
          geometry.centerFrequencyHz,
          geometry.recommendedSpanHz,
        );
        await host.configure(spectrumConfiguration);
        const detector = new SignalDetector(DETECTION_CONFIG);
        const tracker = new SignalTracker(DETECTION_CONFIG);
        const classifier = new SignalLabBayesianClassifier();
        let history: readonly Sweep[] = [];
        let classified = 0;

        for (let opportunity = 0; opportunity < gate.opportunities; opportunity++) {
          const measurement = await host.acquire();
          if (measurement.kind !== 'swept-spectrum') {
            throw new Error(`Expected swept-spectrum measurement for ${gate.profileId}`);
          }
          const sweep = projectLiveSpectrum(host, measurement, spectrumConfiguration, gate);
          history = [sweep, ...history].slice(0, HISTORY_LIMIT);
          const representatives = classificationRepresentatives(
            tracker.update(sweep, detector.analyze(sweep)).filter((item) => item.state === 'active'),
          );
          for (const detection of representatives) {
            if (!runtimeRepresentativeIsReady(detection)) continue;
            const result = await classifier.classify(detection, { sweeps: history });
            assertProbabilityContract(result);
            expect(result.label).toBe('observable:cellular-ofdm-ambiguous');
            classified++;
          }
        }

        expect(classified).toBeGreaterThan(0);
      } finally {
        await host.shutdown();
      }
    },
    120_000,
  );
});

function createLiveSignalLabHost(): AtomizerInstrumentHost {
  const driver = new SignalLabInstrumentDriver({
    atomizerRepositoryRoot,
    environment: {},
    bridge: { readyTimeoutMs: 10_000, requestTimeoutMs: 7_000, shutdownTimeoutMs: 3_000 },
  });
  const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]));
  return new AtomizerInstrumentHost(manager, {
    load: async () => ({
      source: 'factory-default',
      preference: {
        schemaVersion: 1,
        driverId: 'signal-lab',
        updatedAt: new Date(0).toISOString(),
      },
    }),
    save: async () => { throw new Error('Live classifier gate never persists preferences'); },
  });
}

async function connectLiveSignalLabHost(host: AtomizerInstrumentHost) {
  const discovery = await host.discover();
  expect(discovery.failures).toEqual([]);
  expect(discovery.candidates).toHaveLength(1);
  const connected = await host.connect(discovery.candidates[0]!);
  expect(connected.provenance).toMatchObject({
    sourceKind: 'signal-lab',
    execution: 'signal-lab-simulation',
    qualification: 'synthetic-visual-projection',
    claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
  });
  const profileCapability = connected.capabilities.features.find(
    (candidate) => candidate.kind === 'signal-lab-profile-selection',
  );
  if (!profileCapability || profileCapability.kind !== 'signal-lab-profile-selection') {
    throw new Error('SignalLab session omitted profile-selection capability');
  }
  const detectedPowerCapability = connected.capabilities.acquisitions.find(
    (candidate) => candidate.kind === 'detected-power-timeseries',
  );
  if (!detectedPowerCapability || detectedPowerCapability.kind !== 'detected-power-timeseries') {
    throw new Error('SignalLab session omitted detected-power capability');
  }
  expect(profileCapability.profiles).toHaveLength(34);
  expect(CANONIZED_PROFILE_GATES.every((gate) =>
    profileCapability.profiles.some((item) => item.profileId === gate.profileId))).toBe(true);
  return { profileCapability, detectedPowerCapability } as const;
}

function assertSourcePlanMatchesProfiles(
  sourcePlan: readonly Readonly<{
    profileId: string;
    sourceLookIndexOffset: number;
    spectrumOpportunities: number;
  }>[],
): void {
  expect(sourcePlan.map((item) => ({
    profileId: item.profileId,
    spectrumOpportunities: item.spectrumOpportunities,
  }))).toEqual(CANONIZED_PROFILE_GATES.map((item) => ({
    profileId: item.profileId,
    spectrumOpportunities: item.opportunities,
  })));
  for (let index = 1; index < sourcePlan.length; index++) {
    expect(sourcePlan[index]!.sourceLookIndexOffset)
      .toBeGreaterThan(sourcePlan[index - 1]!.sourceLookIndexOffset);
  }
}

async function selectProfileGeometry(
  host: AtomizerInstrumentHost,
  gate: CanonizedProfileGate,
  profiles: Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }>['profiles'],
) {
  const current = requireProfileCapability(host.state().session?.capabilities.features);
  if (current.selectedProfileId !== gate.profileId) {
    await host.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: gate.profileId,
    });
  }
  const selected = requireProfileCapability(host.state().session?.capabilities.features);
  expect(selected.selectedProfileId).toBe(gate.profileId);
  const geometry = profiles.find((item) => item.profileId === gate.profileId);
  if (!geometry) throw new Error(`SignalLab omitted admitted geometry for ${gate.profileId}`);
  return geometry;
}

function projectLiveSpectrum(
  host: AtomizerInstrumentHost,
  measurement: Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }>,
  configuration: Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }>,
  gate: CanonizedProfileGate,
): Sweep {
  const session = host.state().session;
  if (!session) throw new Error('SignalLab session disappeared during spectrum projection');
  const sweep = projectSpectrumMeasurement(measurement, session, configuration);
  expect(sweep).toMatchObject({
    source: 'signal-lab-synthetic',
    resolutionBandwidthQualification: 'synthetic-grid-equivalent',
    actualAttenuationDb: null,
    attenuationQualification: 'not-applicable',
  });
  expect(sweep.requested).toEqual(configuration);
  const minimumExportedGridSpacing = Math.min(...sweep.frequencyHz.slice(1).map(
    (frequency, index) => frequency - sweep.frequencyHz[index]!,
  ));
  expect(sweep.actualRbwHz).toBe(minimumExportedGridSpacing);
  assertNoClassificationLabels(sweep, gate);
  return sweep;
}

function runtimeRepresentativeIsReady(detection: DetectedSignal): boolean {
  return observableAssociationEvidenceIsCurrentlyQualified(detection)
    && classificationSourceSweepIds(detection).length >= CLASSIFICATION_SWEEPS;
}

function representativeGeometryKey(detection: DetectedSignal): string {
  return JSON.stringify({
    bandwidthHz: detection.bandwidthHz,
    startHz: detection.startHz,
    stopHz: detection.stopHz,
    classificationRegionStartHz: detection.classificationRegionStartHz,
    classificationRegionStopHz: detection.classificationRegionStopHz,
    associationMode: detection.associationMode,
    associationRegionStartHz: detection.associationRegionStartHz,
    associationRegionStopHz: detection.associationRegionStopHz,
    associationMemberCount: detection.associationMemberTrackIds?.length,
  });
}

function profile(
  profileId: string,
  modelTruth: ObservableLeafClass,
  allowedLabels: readonly string[],
  opportunities = STANDARD_OPPORTUNITIES,
): CanonizedProfileGate {
  return Object.freeze({ profileId, modelTruth, allowedLabels, opportunities });
}

function syntheticSpectrumConfiguration(
  centerHz: number,
  spanHz: number,
): Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }> {
  return {
    kind: 'swept-spectrum',
    startHz: centerHz - spanHz / 2,
    stopHz: centerHz + spanHz / 2,
    points: SPECTRUM_POINTS,
    sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

function syntheticDetectedPowerConfiguration(
  centerHz: number,
): Extract<InstrumentConfiguration, { kind: 'detected-power-timeseries' }> {
  return {
    kind: 'detected-power-timeseries',
    centerHz,
    sampleCount: SPECTRUM_POINTS,
    sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

function requireProfileCapability(
  features: readonly InstrumentFeatureCapability[] | undefined,
): Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }> {
  const capability = features?.find(
    (candidate) => candidate.kind === 'signal-lab-profile-selection',
  );
  if (!capability || capability.kind !== 'signal-lab-profile-selection') {
    throw new Error('SignalLab session omitted profile-selection capability');
  }
  return capability;
}

function assertSpectrumOnlyResult(
  result: WaveformClassification,
  gate: CanonizedProfileGate,
  expectedLimitation:
    | 'zero-span-missing'
    | 'zero-span-acquisition-policy-unqualified'
    | 'frequency-agile-fixed-tune-envelope-censored',
): void {
  assertProbabilityContract(result);
  expect(result.qualification).toBe('bayesian-observable-equivalence');
  expect(result.evidence.views).toEqual(['scalar-spectrum']);
  expect(result.evidence.limitations).toContain(expectedLimitation);
  expect(result.evidence).not.toHaveProperty('zeroSpanCaptureId');
  expect(result.evidence).not.toHaveProperty('detectedPowerAcquisitionQualification');
  assertNoClassificationLabels(result.evidence, gate);
}

function assertEnvelopeResult(
  result: WaveformClassification,
  captureId: string,
  gate: CanonizedProfileGate,
): void {
  assertProbabilityContract(result);
  expect(result.qualification).toBe('bayesian-observable-equivalence');
  expect(result.evidence.views).toEqual(['scalar-spectrum', 'detected-power-envelope']);
  expect(result.evidence.zeroSpanCaptureId).toBe(captureId);
  expect(result.evidence.detectedPowerAcquisitionQualification)
    .toBe('receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5');
  expect(result.evidence.limitations).toContain('zero-span-rbw-unavailable');
  expect(result.evidence.limitations).not.toEqual(expect.arrayContaining([
    'zero-span-missing', 'zero-span-provenance-mismatch', 'zero-span-tune-mismatch', 'zero-span-geometry-out-of-domain',
  ]));
  assertNoClassificationLabels(result.evidence, gate);
}

function assertProbabilityContract(result: WaveformClassification): void {
  expect(Number.isFinite(result.confidence)).toBe(true);
  expect(result.confidence).toBeGreaterThanOrEqual(0);
  expect(result.confidence).toBeLessThanOrEqual(1);
  for (const candidate of result.candidates) {
    expect(Number.isFinite(candidate.confidence)).toBe(true);
    expect(candidate.confidence).toBeGreaterThanOrEqual(0);
    expect(candidate.confidence).toBeLessThanOrEqual(1);
  }
  if (result.decisionSupport) {
    expect(Number.isFinite(result.decisionSupport.value)).toBe(true);
    expect(result.decisionSupport.value).toBeGreaterThanOrEqual(0);
    expect(result.decisionSupport.value).toBeLessThanOrEqual(1);
    if (result.decisionSupport.threshold !== undefined) {
      expect(Number.isFinite(result.decisionSupport.threshold)).toBe(true);
      expect(result.decisionSupport.threshold).toBeGreaterThanOrEqual(0);
      expect(result.decisionSupport.threshold).toBeLessThanOrEqual(1);
    }
  }
}

function classificationSourceSweepIds(detection: DetectedSignal): readonly string[] {
  return detection.associationMode !== undefined && detection.associationMode !== 'frequency-local'
    ? detection.associationRegionSweepIds ?? []
    : detection.sweepIds;
}

function assertNoClassificationLabels(value: unknown, gate: CanonizedProfileGate): void {
  const forbiddenKeys = new Set(['profile', 'profileId', 'truth', 'truthClass', 'scenario', 'scenarioId', 'waveform', 'label']);
  const forbiddenStringValues = new Set([
    gate.profileId,
    gate.modelTruth,
    ...gate.allowedLabels,
  ]);
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      expect(forbiddenStringValues.has(candidate), `Classifier input leaked label value ${candidate}`).toBe(false);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (ArrayBuffer.isView(candidate)) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      expect(forbiddenKeys.has(key), `Classifier input leaked metadata key ${key}`).toBe(false);
      visit(item);
    }
  };
  visit(value);
}
