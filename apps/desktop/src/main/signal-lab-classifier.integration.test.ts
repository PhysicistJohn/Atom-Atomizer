import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classificationRepresentatives,
  extractObservableFeatures,
  observableAssociationEvidenceIsCurrentlyQualified,
  observableRepresentativeIsInClassDomain,
  SignalDetector,
  SignalLabBayesianClassifier,
  SignalTracker,
  type ObservableLeafClass,
  type WaveformEvidence,
} from '@tinysa/analysis';
import { projectDetectedPowerTuneHz } from '@tinysa/contracts';
import type {
  DetectedSignal,
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
const shippedBridge = resolve(atomizerRepositoryRoot, '..', 'TinySA_SignalLab', 'dist', 'bridge', 'atomizer-bridge.js');
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

describe('SignalLab live observable-classification release gate', () => {
  // Standalone Atomizer checkouts can omit sibling repositories. `npm run
  // check` and the trio release gate build SignalLab first, so this test is
  // mandatory there and skipped only when the owned executable is absent.
  it.skipIf(!existsSync(shippedBridge))(
    'admits every canonized profile through bridge, host, projection, and the production classifier',
    async () => {
      const driver = new SignalLabInstrumentDriver({
        atomizerRepositoryRoot,
        environment: {},
        bridge: { readyTimeoutMs: 10_000, requestTimeoutMs: 7_000, shutdownTimeoutMs: 3_000 },
      });
      const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]));
      const host = new AtomizerInstrumentHost(manager, {
        load: async () => ({
          source: 'factory-default',
          preference: { schemaVersion: 1, driverId: 'signal-lab', updatedAt: new Date(0).toISOString() },
        }),
        save: async () => { throw new Error('Live classifier gate never persists preferences'); },
      });

      try {
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
        expect(CANONIZED_PROFILE_GATES.map((item) => item.profileId).every((profileId) =>
          profileCapability.profiles.some((item) => item.profileId === profileId))).toBe(true);

        let aggregateRollingCases = 0;
        let aggregateCoveredRollingCases = 0;
        let aggregateHierarchicalRollingCases = 0;
        let aggregateIncompatibleNonUnknownCases = 0;
        let envelopeCases = 0;
        let compatibleEnvelopeCases = 0;
        const envelopeOutcomes = new Map<string, Readonly<Record<string, unknown>>>();
        for (const gate of activeProfileGates) {
          const currentProfileCapability = requireProfileCapability(host.state().session?.capabilities.features);
          if (currentProfileCapability.selectedProfileId !== gate.profileId) {
            await host.executeFeature({
              kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: gate.profileId,
            });
          }
          const selectedCapability = requireProfileCapability(host.state().session?.capabilities.features);
          expect(selectedCapability.selectedProfileId).toBe(gate.profileId);
          const geometry = selectedCapability.profiles.find((item) => item.profileId === gate.profileId);
          if (!geometry) throw new Error(`SignalLab omitted admitted geometry for ${gate.profileId}`);

          const spectrumConfiguration = syntheticSpectrumConfiguration(
            geometry.centerFrequencyHz,
            geometry.recommendedSpanHz,
          );
          let spectrumState = await host.configure(spectrumConfiguration);
          expect(spectrumState.configuration).toEqual(spectrumConfiguration);
          expect(host.state().session?.configuration).toEqual(spectrumState);
          const detector = new SignalDetector(DETECTION_CONFIG);
          const tracker = new SignalTracker(DETECTION_CONFIG);
          const classifier = new SignalLabBayesianClassifier();
          let history: readonly Sweep[] = [];
          let rollingCases = 0;
          let coveredRollingCases = 0;
          let hierarchicalRollingCases = 0;
          let incompatibleNonUnknownCases = 0;
          let truthClassDomainCases = 0;
          let envelopeConsumed = false;
          const unknownReasons = new Map<string, number>();
          const supportRanks: number[] = [];
          const representativeGeometry = new Map<string, number>();
          const classificationOutcomes = new Map<string, number>();
          const rawCandidatePatterns = new Map<string, number>();

          for (let opportunity = 1; opportunity <= gate.opportunities; opportunity++) {
            const measurement = await host.acquire();
            if (measurement.kind !== 'swept-spectrum') {
              throw new Error(`Expected swept-spectrum measurement for ${gate.profileId}`);
            }
            expect(measurement.configurationRevision).toBe(spectrumState.configurationRevision);
            assertNoClassificationLabels(measurement, gate);
            const session = host.state().session;
            if (!session) throw new Error('SignalLab session disappeared during spectrum projection');
            const sweep = projectSpectrumMeasurement(measurement, session, spectrumConfiguration);
            expect(sweep).toMatchObject({
              source: 'signal-lab-synthetic',
              resolutionBandwidthQualification: 'synthetic-grid-equivalent',
              actualAttenuationDb: null,
              attenuationQualification: 'not-applicable',
            });
            expect(sweep.requested).toEqual(spectrumConfiguration);
            const minimumExportedGridSpacing = Math.min(...sweep.frequencyHz.slice(1).map(
              (frequency, index) => frequency - sweep.frequencyHz[index]!,
            ));
            expect(sweep.actualRbwHz).toBe(minimumExportedGridSpacing);
            assertNoClassificationLabels(sweep, gate);
            history = [sweep, ...history].slice(0, HISTORY_LIMIT);

            const rawCandidates = detector.analyze(sweep);
            const rawPattern = JSON.stringify(rawCandidates
              .map((candidate) => ({
                startHz: candidate.startHz,
                stopHz: candidate.stopHz,
                bandwidthHz: candidate.bandwidthHz,
                centerHz: (candidate.startHz + candidate.stopHz) / 2,
              }))
              .sort((left, right) => left.centerHz - right.centerHz));
            rawCandidatePatterns.set(rawPattern, (rawCandidatePatterns.get(rawPattern) ?? 0) + 1);
            const detections = tracker.update(sweep, rawCandidates);
            const representatives = classificationRepresentatives(
              detections.filter((item) => item.state === 'active'),
            );
            for (const detection of representatives) {
              const geometryKey = JSON.stringify({
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
              representativeGeometry.set(geometryKey, (representativeGeometry.get(geometryKey) ?? 0) + 1);
              assertNoClassificationLabels(detection, gate);
              if (!observableAssociationEvidenceIsCurrentlyQualified(detection)
                || classificationSourceSweepIds(detection).length < CLASSIFICATION_SWEEPS) continue;
              const evidence = { sweeps: history } satisfies WaveformEvidence;
              assertNoClassificationLabels(evidence, gate);
              const result = await classifier.classify(detection, evidence);
              assertSpectrumOnlyResult(result, gate);
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
                supportRank: result.evidence.features?.['model.maximumKnownSyntheticSupportRank'],
              });
              classificationOutcomes.set(outcomeKey, (classificationOutcomes.get(outcomeKey) ?? 0) + 1);
              expect(observation.sweepIds).toHaveLength(CLASSIFICATION_SWEEPS);
              if (observableRepresentativeIsInClassDomain(gate.modelTruth, observation)) truthClassDomainCases++;
              if (result.label !== 'unknown') expect(result.decisionSupport?.kind).toBe('model-posterior');

              if (!envelopeConsumed) {
                const detectedPowerTuneHz = projectDetectedPowerTuneHz(
                  detection.peakHz,
                  detectedPowerCapability.centerFrequencyHz,
                );
                expect(Number.isInteger(detectedPowerTuneHz)).toBe(true);
                expect(Math.abs(detectedPowerTuneHz - detection.peakHz))
                  .toBeLessThanOrEqual((detectedPowerCapability.centerFrequencyHz.step ?? 1) / 2);
                const detectedPowerConfiguration = syntheticDetectedPowerConfiguration(detectedPowerTuneHz);
                const detectedPowerState = await host.configure(detectedPowerConfiguration);
                expect(detectedPowerState.configuration).toEqual(detectedPowerConfiguration);
                expect(host.state().session?.configuration).toEqual(detectedPowerState);
                const detectedPowerMeasurement = await host.acquire();
                if (detectedPowerMeasurement.kind !== 'detected-power-timeseries') {
                  throw new Error(`Expected detected-power measurement for ${gate.profileId}`);
                }
                expect(detectedPowerMeasurement.centerHz).toBe(detectedPowerTuneHz);
                expect(detectedPowerMeasurement.configurationRevision).toBe(detectedPowerState.configurationRevision);
                assertNoClassificationLabels(detectedPowerMeasurement, gate);
                const detectedPowerSession = host.state().session;
                if (!detectedPowerSession) throw new Error('SignalLab session disappeared during detected-power projection');
                const projectedEnvelope = projectDetectedPowerMeasurement(
                  detectedPowerMeasurement,
                  detectedPowerSession,
                  detectedPowerConfiguration,
                  detection.id,
                );
                expect(projectedEnvelope).toMatchObject({
                  targetDetectionId: detection.id,
                  frequencyHz: detectedPowerTuneHz,
                  actualRbwHz: null,
                  resolutionBandwidthQualification: 'unavailable',
                  actualAttenuationDb: null,
                  attenuationQualification: 'not-applicable',
                  timingQualification: 'simulation-exact',
                });
                expect(projectedEnvelope.requested).toEqual(detectedPowerConfiguration);
                expect(projectedEnvelope.requested.centerHz).toBe(detectedPowerTuneHz);
                assertNoClassificationLabels(projectedEnvelope, gate);
                const envelopeEvidence = {
                  sweeps: history,
                  zeroSpan: projectedEnvelope,
                  zeroSpanSpectrumSweepIds: classificationWindowSweepIds(detection, history),
                } satisfies WaveformEvidence;
                const envelopeObservation = extractObservableFeatures(detection, envelopeEvidence);
                expect(
                  envelopeObservation.zeroSpanCaptureId,
                  `live ${gate.profileId} envelope rejection at ${detectedPowerTuneHz} Hz for peak ${detection.peakHz} Hz, bandwidth ${detection.bandwidthHz} Hz, bin ${envelopeObservation.binWidthHz} Hz: ${envelopeObservation.limitations.join(', ')}`,
                ).toBe(projectedEnvelope.id);
                expect(envelopeObservation.sweepIds).toHaveLength(CLASSIFICATION_SWEEPS);
                expect(envelopeObservation.views).toEqual(['scalar-spectrum', 'detected-power-envelope']);
                expect(envelopeObservation.limitations).toContain('zero-span-rbw-unavailable');
                expect(envelopeObservation.limitations).not.toEqual(expect.arrayContaining([
                  'zero-span-missing', 'zero-span-provenance-mismatch', 'zero-span-tune-mismatch', 'zero-span-geometry-out-of-domain',
                ]));
                expect(envelopeObservation.values['envelope.logTransitionRateHz']).toBeTypeOf('number');
                const envelopeResult = await classifier.classify(detection, envelopeEvidence);
                assertEnvelopeResult(envelopeResult, projectedEnvelope.id, gate);
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
                expect(spectrumState.configuration).toEqual(spectrumConfiguration);
              }
            }
          }

          expect(
            rollingCases,
            `${gate.profileId} produced no current-qualified online-ready production representatives; representatives=${JSON.stringify(Object.fromEntries(representativeGeometry))}; raw=${JSON.stringify(Object.fromEntries(rawCandidatePatterns))}`,
          )
            .toBeGreaterThan(0);
          const supportRange = supportRanks.length
            ? `${Math.min(...supportRanks)}..${Math.max(...supportRanks)}`
            : 'unavailable';
          expect(
            coveredRollingCases / rollingCases,
            `${gate.profileId} complete-denominator rolling known coverage; unknown=${JSON.stringify(Object.fromEntries(unknownReasons))}; support=${supportRange}; representatives=${JSON.stringify(Object.fromEntries(representativeGeometry))}; outcomes=${JSON.stringify(Object.fromEntries(classificationOutcomes))}; raw=${JSON.stringify(Object.fromEntries(rawCandidatePatterns))}`,
          ).toBeGreaterThanOrEqual(0.9);
          expect(hierarchicalRollingCases / rollingCases, `${gate.profileId} complete-denominator rolling hierarchy`).toBeGreaterThanOrEqual(0.9);
          expect(incompatibleNonUnknownCases, `${gate.profileId} emitted an incompatible non-unknown result`).toBe(0);
          expect(truthClassDomainCases, `${gate.profileId} had no representatives in its shared observation-only class domain`).toBeGreaterThan(0);
          expect(envelopeConsumed, `${gate.profileId} never consumed its live projected envelope`).toBe(true);
          aggregateRollingCases += rollingCases;
          aggregateCoveredRollingCases += coveredRollingCases;
          aggregateHierarchicalRollingCases += hierarchicalRollingCases;
          aggregateIncompatibleNonUnknownCases += incompatibleNonUnknownCases;
        }
        expect(aggregateCoveredRollingCases / aggregateRollingCases).toBeGreaterThanOrEqual(0.95);
        expect(aggregateHierarchicalRollingCases / aggregateRollingCases).toBeGreaterThanOrEqual(0.95);
        expect(aggregateIncompatibleNonUnknownCases).toBe(0);
        expect(envelopeCases).toBe(activeProfileGates.length);
        expect(
          compatibleEnvelopeCases / envelopeCases,
          `complete live envelope compatibility: ${JSON.stringify(Object.fromEntries(envelopeOutcomes))}`,
        ).toBeGreaterThanOrEqual(0.95);
      } finally {
        await host.shutdown();
      }
    },
    180_000,
  );
});

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

function assertSpectrumOnlyResult(result: WaveformClassification, gate: CanonizedProfileGate): void {
  expect(result.qualification).toBe('bayesian-observable-equivalence');
  expect(result.evidence.views).toEqual(['scalar-spectrum']);
  expect(result.evidence.limitations).toContain('zero-span-missing');
  expect(result.evidence).not.toHaveProperty('zeroSpanCaptureId');
  assertNoClassificationLabels(result.evidence, gate);
}

function assertEnvelopeResult(
  result: WaveformClassification,
  captureId: string,
  gate: CanonizedProfileGate,
): void {
  expect(result.qualification).toBe('bayesian-observable-equivalence');
  expect(result.evidence.views).toEqual(['scalar-spectrum', 'detected-power-envelope']);
  expect(result.evidence.zeroSpanCaptureId).toBe(captureId);
  expect(result.evidence.limitations).toContain('zero-span-rbw-unavailable');
  expect(result.evidence.limitations).not.toEqual(expect.arrayContaining([
    'zero-span-missing', 'zero-span-provenance-mismatch', 'zero-span-tune-mismatch', 'zero-span-geometry-out-of-domain',
  ]));
  assertNoClassificationLabels(result.evidence, gate);
}

function classificationSourceSweepIds(detection: DetectedSignal): readonly string[] {
  return detection.associationMode !== undefined && detection.associationMode !== 'frequency-local'
    ? detection.associationRegionSweepIds ?? []
    : detection.sweepIds;
}

function classificationWindowSweepIds(
  detection: DetectedSignal,
  history: readonly Sweep[],
): readonly string[] {
  const admitted = new Set(classificationSourceSweepIds(detection));
  return history
    .filter((sweep) => admitted.has(sweep.id))
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, CLASSIFICATION_SWEEPS)
    .map((sweep) => sweep.id);
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
