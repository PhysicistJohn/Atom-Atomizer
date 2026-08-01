// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { InstrumentConfigurationState, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { AtomizerStore, createInitialRendererState } from '../store.js';
import { InstrumentEventsController } from './instrument-events.js';
import { RendererKernel } from './kernel.js';
import { AcquisitionController } from './acquisition.js';
import { MeasurementController } from './measurement.js';
import { waveformDescriptor } from '../../../../../../Atom-SignalLab/src/waveforms.js';
import { fixedDigitalProfileBinding } from '../../../../../../Atom-SignalLab/src/fixed-digital-profile-binding.js';

const HASH = 'a'.repeat(64);
const SESSION: InstrumentSessionSnapshot = {
  sessionId: 'session-signal-lab',
  driverId: 'signal-lab',
  candidate: {
    schemaVersion: 1,
    driverId: 'signal-lab',
    candidateId: 'signal-lab:local',
    displayName: 'SignalLab',
    sourceKind: 'signal-lab',
    signalLab: { sourceId: 'local' },
    discoveryRevision: 'discovery-1',
  },
  provenance: {
    sourceKind: 'signal-lab',
    sourceId: 'local',
    execution: 'signal-lab-simulation',
    transport: 'signal-lab-measurement-bridge',
    qualification: 'synthetic-visual-projection',
    verifiedAt: '2026-07-22T00:00:00.000Z',
    producerConfigurationEpoch: 'producer-epoch:1',
    contractId: 'tinysa-signal-lab-atomizer-measurement',
    contractVersion: 3,
    contractSha256: HASH,
    catalogSha256: HASH,
    generatorContractBindingSha256: HASH,
    claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
  },
  capabilities: {
    schemaVersion: 1,
    acquisitions: [{
      kind: 'swept-spectrum',
      frequencyHz: { min: 0, max: 1_000 },
      points: { min: 2, max: 100 },
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
      powerUnit: 'dBm',
    }],
    features: [],
  },
  rfOutput: 'not-supported',
  rfOutputQualification: 'not-applicable',
};

const CONFIGURATION: InstrumentConfigurationState = {
  sessionId: SESSION.sessionId,
  configurationRevision: 'configuration-1',
  configuredAt: '2026-07-22T00:00:01.000Z',
  configuration: {
    kind: 'swept-spectrum',
    startHz: 100,
    stopHz: 300,
    points: 3,
    sweepTimeSeconds: 0.05,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  },
};

describe('instrument configuration event admission', () => {
  it('does not publish the same authoritative revision twice and rejects revision equivocation', () => {
    const store = new AtomizerStore(createInitialRendererState({ initialWorkspace: 'spectrum', initialAgentOpen: false }));
    store.set({ instrument: { ...store.get().instrument, session: SESSION } });
    const controller = new InstrumentEventsController(new RendererKernel(store));
    const before = store.revision;

    controller.acceptConfiguration(CONFIGURATION);
    expect(store.revision).toBe(before + 1);

    controller.acceptConfiguration(structuredClone(CONFIGURATION));
    expect(store.revision).toBe(before + 1);

    expect(() => controller.acceptConfiguration({
      ...CONFIGURATION,
      configuration: {
        kind: 'swept-spectrum',
        startHz: 100,
        stopHz: 300,
        points: 4,
        sweepTimeSeconds: 0.05,
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
      },
    })).toThrow(/changed after admission/);
    expect(store.revision).toBe(before + 1);
  });

  // Capture bandwidth is a symmetric passband about the RF tune center, so
  // holding a Bluetooth artifact's native carrier offset costs
  // `2 * |offset| + signalBandwidth`: 63 MHz for BR at -31 MHz and 31 MHz for
  // LE at -15 MHz. Staging the old 1 MHz signal bandwidth would have silently
  // asked for translated, derived bytes instead of the native ones.
  it.each([
    ['bluetooth-classic-connected' as const, 2_410_000_000, -31_000_000, 63_000_000],
    ['bluetooth-le-advertising' as const, 2_426_000_000, -15_000_000, 31_000_000],
  ])('stages %s at its exact-native symmetric capture about the 2.441 GHz native RF reference', (
    profileId,
    signalCenterHz,
    nativeCarrierOffsetHz,
    exactNativeCaptureBandwidthHz,
  ) => {
    const store = new AtomizerStore(createInitialRendererState({
      initialWorkspace: 'iq',
      initialAgentOpen: false,
    }));
    const kernel = new RendererKernel(store);
    kernel.measurement = new MeasurementController(kernel);
    const controller = new InstrumentEventsController(kernel);
    const session = bluetoothSession(profileId);

    store.set({ instrument: { ...store.get().instrument, session } });
    controller.initializeSessionSelection(session);

    expect(store.get().iqConfiguration).toMatchObject({
      centerHz: signalCenterHz,
      sampleRateHz: 80_000_000,
      bandwidthHz: exactNativeCaptureBandwidthHz,
    });
    expect(exactNativeCaptureBandwidthHz)
      .toBe(2 * Math.abs(nativeCarrierOffsetHz) + 1_000_000);
    expect(store.get().iqConfiguration.centerHz - nativeCarrierOffsetHz).toBe(2_441_000_000);
  });

  // A custom build republishes the `custom-${standard}` descriptor and its
  // matching I/Q transport together, so the staged capture geometry has to move
  // with it. The previous behaviour assumed only the descriptor changed and left
  // the renderer staged at the superseded signal bandwidth.
  it('reconciles staged I/Q geometry against the refreshed custom-waveform capability', () => {
    const store = new AtomizerStore(createInitialRendererState({
      initialWorkspace: 'iq',
      initialAgentOpen: false,
    }));
    const kernel = new RendererKernel(store);
    kernel.measurement = new MeasurementController(kernel);
    kernel.acquisition = new AcquisitionController(kernel);
    const controller = new InstrumentEventsController(kernel);
    const initial = customNrSession(38_160_000, 40_000_000);

    store.set({ instrument: { ...store.get().instrument, session: initial } });
    controller.initializeSessionSelection(initial);
    expect(store.get().iqConfiguration).toMatchObject({
      centerHz: 3_500_000_000,
      bandwidthHz: 38_160_000,
    });

    const refreshed = customNrSession(380_160_000, 400_000_000);
    store.set({ instrument: { ...store.get().instrument, session: refreshed } });
    controller.acceptFeatureResult({
      sessionId: refreshed.sessionId,
      kind: 'signal-lab-profile-selection',
      action: 'configure-custom-waveform',
      standard: 'nr',
      selections: {
        frequencyRange: 'FR2',
        operatingBand: 'n257',
        subcarrierSpacingKHz: '120',
        channelBandwidthMHz: '400',
      },
      producerConfigurationEpoch: 'producer-epoch:2',
    });

    expect(store.get().selectedProfile).toBe('custom-nr');
    expect(store.get().iqConfiguration).toMatchObject({
      centerHz: 3_500_000_000,
      bandwidthHz: 380_160_000,
    });
    expect(store.get().analyzer.stopHz - store.get().analyzer.startHz).toBe(400_000_000);
  });
});

function customNrSession(
  occupiedBandwidthHz: number,
  recommendedSpanHz: number,
): InstrumentSessionSnapshot {
  const descriptor = waveformDescriptor('custom-nr');
  return {
    ...SESSION,
    capabilities: {
      schemaVersion: 1,
      acquisitions: [{
        kind: 'swept-spectrum',
        frequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
        points: { min: 2, max: 450, step: 1 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
        powerUnit: 'dBm',
      }, {
        kind: 'complex-iq',
        centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
        sampleRateHz: { min: 1, max: 491_520_000, step: 1 },
        bandwidthHz: { min: 1, max: 491_520_000, step: 1 },
        bandwidthMode: 'independent',
        sampleCount: { min: 1, max: 65_536, step: 1 },
        sampleFormat: 'cf32le',
      }],
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: [{
          profileId: descriptor.id,
          label: descriptor.label,
          family: descriptor.family,
          model: descriptor.model,
          qualification: descriptor.qualification,
          centerFrequencyHz: 3_500_000_000,
          occupiedBandwidthHz,
          recommendedSpanHz,
          projection: descriptor.projection,
          source: descriptor.source,
          governance: descriptor.governance,
          disclosure: descriptor.disclosure,
          ...(descriptor.assetSha256 === undefined ? {} : { assetSha256: descriptor.assetSha256 }),
        }],
        selectedProfileId: descriptor.id,
        channel: {
          model: 'awgn',
          noiseFloorDbm: -108,
          seed: 407,
          fadingRateHz: 2,
          receiverImpairment: 'clean',
        },
        iqProfiles: [{
          profileId: descriptor.id,
          nativeSampleRateHz: null,
          signalBandwidthHz: occupiedBandwidthHz,
          profileReferenceCenterHz: 3_500_000_000,
          nativeCarrierOffsetHz: 0,
          nativeMinimumCaptureBandwidthHz: null,
          replay: 'continuous',
          derivedTransportSupported: false,
        }],
      }],
    },
  };
}

function bluetoothSession(
  profileId: 'bluetooth-classic-connected' | 'bluetooth-le-advertising',
): InstrumentSessionSnapshot {
  const descriptor = waveformDescriptor(profileId);
  const binding = fixedDigitalProfileBinding(profileId);
  return {
    ...SESSION,
    capabilities: {
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq',
        centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
        sampleRateHz: { min: 1, max: 491_520_000, step: 1 },
        bandwidthHz: { min: 1, max: 491_520_000, step: 1 },
        bandwidthMode: 'independent',
        sampleCount: { min: 1, max: 65_536, step: 1 },
        sampleFormat: 'cf32le',
      }],
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: [{
          profileId: descriptor.id,
          label: descriptor.label,
          family: descriptor.family,
          model: descriptor.model,
          qualification: descriptor.qualification,
          centerFrequencyHz: descriptor.centerHz,
          occupiedBandwidthHz: descriptor.occupiedBandwidthHz,
          recommendedSpanHz: descriptor.recommendedSpanHz,
          projection: descriptor.projection,
          source: descriptor.source,
          governance: descriptor.governance,
          disclosure: descriptor.disclosure,
          ...(descriptor.assetSha256 === undefined ? {} : { assetSha256: descriptor.assetSha256 }),
        }],
        selectedProfileId: profileId,
        channel: {
          model: 'awgn',
          noiseFloorDbm: -108,
          seed: 407,
          fadingRateHz: 2,
          receiverImpairment: 'clean',
        },
        iqProfiles: [{
          profileId,
          nativeSampleRateHz: binding.nativeSampleRateHz,
          signalBandwidthHz: binding.signalBandwidthHz,
          profileReferenceCenterHz: binding.profileReferenceCenterHz,
          nativeCarrierOffsetHz: binding.nativeCarrierOffsetHz,
          nativeMinimumCaptureBandwidthHz:
            2 * Math.abs(binding.nativeCarrierOffsetHz) + binding.signalBandwidthHz,
          replay: binding.replay,
          maxOneShotSamples: binding.captureSamples,
          derivedTransportSupported: true,
        }],
      }],
    },
  };
}
