import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLEX_IQ_SAMPLES_V1,
  MAX_DETECTED_POWER_SAMPLES_V1,
  MAX_DISCOVERY_CANDIDATES_V1,
  MAX_DRIVER_DISCOVERY_CANDIDATES_V1,
  MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1,
  MAX_INSTRUMENT_FREQUENCY_HZ_V1,
  MAX_INSTRUMENT_METADATA_CHARACTERS_V1,
  MAX_SCREEN_DIMENSION_V1,
  MAX_SIGNAL_LAB_PROFILES_V1,
  MAX_SWEPT_SPECTRUM_POINTS_V1,
  instrumentCandidateDescriptorSchema,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentConfigurationSchema,
  instrumentDiscoveryResultSchema,
  instrumentDriverDiscoveryResultSchema,
  instrumentFeatureCommandSchema,
  instrumentFeatureRequestSchema,
  instrumentFeatureResultSchema,
  instrumentMeasurementSchema,
  instrumentSessionProvenanceSchema,
  instrumentSessionSnapshotSchema,
} from './instrument.js';

describe('instrument boundary contracts', () => {
  it('keeps serial and SignalLab candidates as strict source-specific variants', () => {
    const serial = serialCandidate();
    const signalLab = signalLabCandidate();
    expect(instrumentCandidateDescriptorSchema.parse(serial)).toEqual(serial);
    expect(instrumentCandidateDescriptorSchema.parse(signalLab)).toEqual(signalLab);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...signalLab,
      serialPort: { path: '/dev/tty.fake', vendorId: '0483', productId: '5740' },
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...signalLab,
      vendorId: '0483',
      productId: '5740',
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...signalLab,
      signalLab: { sourceId: 'default', instrumentKind: 'neptune' },
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...serial,
      sourceKind: 'signal-lab',
    }).success).toBe(false);
    expect(instrumentCandidateSchema.safeParse({ ...serial, discoveryRevision: 'discovery:opaque' }).success).toBe(true);
  });

  it('preserves typed partial discovery failures across driver and public boundaries', () => {
    const descriptor = serialCandidate();
    const driverResult = {
      candidates: [descriptor],
      failures: [{
        sourceKind: 'tinysa-firmware-twin' as const,
        code: 'source-unavailable' as const,
        recoverable: true,
        message: 'firmware twin is not running',
      }],
    };
    expect(instrumentDriverDiscoveryResultSchema.parse(driverResult)).toEqual(driverResult);
    expect(instrumentDriverDiscoveryResultSchema.safeParse({
      ...driverResult,
      failures: [{ message: 'untyped failure' }],
    }).success).toBe(false);
    expect(instrumentDiscoveryResultSchema.safeParse({
      discoveryRevision: 'discovery:opaque',
      discoveredAt: '2026-07-14T18:00:00.000Z',
      candidates: [{ ...descriptor, discoveryRevision: 'discovery:opaque' }],
      failures: [{ driverId: 'tinysa-zs407', ...driverResult.failures[0] }],
    }).success).toBe(true);
  });

  it('models acquisition and optional feature capabilities without widening sample formats', () => {
    const capabilities = instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [
        {
          kind: 'swept-spectrum', frequencyHz: { min: 0, max: 1_000_000 }, points: { min: 20, max: 450, step: 1 },
          sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
          controls: receiverSpectrumCapability(), powerUnit: 'dBm',
        },
        {
          kind: 'detected-power-timeseries', centerFrequencyHz: { min: 0, max: 1_000_000 },
          sampleCount: { min: 20, max: 450 },
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 60 } },
          controls: receiverDetectedPowerCapability(),
          powerUnit: 'dBm', timing: 'uniform',
        },
        {
          kind: 'complex-iq',
          centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000 },
          sampleRateHz: { min: 48_000, max: 20_000_000 },
          bandwidthHz: { min: 10_000, max: 20_000_000 },
          sampleCount: { min: 1, max: MAX_COMPLEX_IQ_SAMPLES_V1 },
          sampleFormat: 'cf32le',
        },
      ],
      features: [
        {
          kind: 'rf-generator',
          paths: [{ path: 'normal', frequencyHz: { min: 1, max: 1_000_000 } }],
          levelDbm: { min: -115, max: -18.5 },
          modulation: {
            off: true,
            am: { modulationFrequencyHz: { min: 1, max: 10_000 }, depthPercent: { min: 0, max: 100 } },
          },
        },
        { kind: 'screen', width: 480, height: 320, pixelFormat: 'rgb565le' },
        { kind: 'touch', width: 480, height: 320 },
        { kind: 'diagnostics', reports: ['identity', 'health'] },
        {
          kind: 'signal-lab-profile-selection',
          profiles: [
            { profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 },
            { profileId: 'fm', centerFrequencyHz: 101_000_000, recommendedSpanHz: 500_000 },
          ],
          selectedProfileId: 'cw',
        },
      ],
    });
    expect(capabilities.acquisitions.map((capability) => capability.kind)).toEqual([
      'swept-spectrum', 'detected-power-timeseries', 'complex-iq',
    ]);
    expect(capabilities.acquisitions[2]).toEqual({
      kind: 'complex-iq',
      centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000 },
      sampleRateHz: { min: 48_000, max: 20_000_000 },
      bandwidthHz: { min: 10_000, max: 20_000_000 },
      sampleCount: { min: 1, max: MAX_COMPLEX_IQ_SAMPLES_V1 },
      sampleFormat: 'cf32le',
    });
    expect(instrumentCapabilitiesSchema.safeParse({
      ...capabilities,
      acquisitions: [...capabilities.acquisitions, capabilities.acquisitions[0]],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'detected-power-timeseries', centerFrequencyHz: { min: 0, max: 1 },
        sampleCount: { min: 1, max: 2 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0, max: 1 } },
        controls: receiverDetectedPowerCapability(),
        powerUnit: 'dBm', timing: 'uniform',
      }],
      features: [],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq', centerFrequencyHz: { min: 0, max: 1 }, sampleRateHz: { min: 1, max: 1 },
        bandwidthHz: { min: 1, max: 1 }, sampleCount: { min: 1, max: 4 }, maxChunkSamples: 5, sampleFormat: 'cf32le',
      }],
      features: [],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq', centerFrequencyHz: { min: 0, max: 1 }, sampleRateHz: { min: 1, max: 1 },
        bandwidthHz: { min: 1, max: 1 }, sampleCount: { min: 1, max: 1 }, sampleFormat: 'ci16le',
      }],
      features: [],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq', centerFrequencyHz: { min: 0, max: 1 }, sampleRateHz: { min: 1, max: 1 },
        bandwidthHz: { min: 1, max: 1 }, sampleCount: { min: 1, max: 1 }, sampleFormat: 'cf32le',
      }],
      features: [],
    }).success).toBe(true);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq', centerFrequencyHz: { min: 0, max: 1 }, sampleRateHz: { min: 1, max: 1 },
        bandwidthHz: { min: 1, max: 1 }, sampleCount: { min: 1, max: MAX_COMPLEX_IQ_SAMPLES_V1 + 1 }, sampleFormat: 'cf32le',
      }],
      features: [],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: capabilities.acquisitions,
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: [
          { profileId: 'cw', centerFrequencyHz: 100, recommendedSpanHz: 10 },
          { profileId: 'cw', centerFrequencyHz: 200, recommendedSpanHz: 10 },
        ],
        selectedProfileId: 'cw',
      }],
    }).success).toBe(false);
  });

  it('requires coherent complex-I/Q sampling geometry', () => {
    expect(instrumentConfigurationSchema.safeParse({
      kind: 'complex-iq',
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleCount: 262_144,
      sampleFormat: 'cf32le',
    }).success).toBe(true);
    expect(instrumentConfigurationSchema.safeParse({
      kind: 'complex-iq',
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 2_000_000,
      sampleCount: 262_144,
      sampleFormat: 'cf32le',
    }).success).toBe(false);
    expect(instrumentConfigurationSchema.safeParse({
      kind: 'complex-iq', centerHz: 2_450_000_000, sampleRateHz: 1_000_000,
      bandwidthHz: 800_000, sampleCount: MAX_COMPLEX_IQ_SAMPLES_V1 + 1, sampleFormat: 'cf32le',
    }).success).toBe(false);
  });

  it('keeps receiver controls explicit while synthetic scalar configurations carry only exact timing', () => {
    const receiver = {
      kind: 'swept-spectrum', startHz: 100, stopHz: 300, points: 3, sweepTimeSeconds: 0.05,
      controls: receiverSpectrumControls(),
    };
    const synthetic = {
      kind: 'swept-spectrum', startHz: 100, stopHz: 300, points: 3, sweepTimeSeconds: 0.05,
      controls: syntheticScalarControls(),
    };
    expect(instrumentConfigurationSchema.parse(receiver)).toEqual(receiver);
    expect(instrumentConfigurationSchema.parse(synthetic)).toEqual(synthetic);
    expect(instrumentConfigurationSchema.safeParse({ ...synthetic, sweepTimeSeconds: 'auto' }).success).toBe(false);
    expect(instrumentConfigurationSchema.safeParse({
      ...synthetic,
      controls: { ...synthetic.controls, attenuationDb: 0 },
    }).success).toBe(false);
    expect(instrumentConfigurationSchema.safeParse({
      ...receiver,
      controls: { ...receiver.controls, lowNoiseAmplifier: 'unsupported' },
    }).success).toBe(false);
    expect(instrumentConfigurationSchema.safeParse({
      ...receiver,
      controls: { ...receiver.controls, attenuationDb: -1 },
    }).success).toBe(false);
  });

  it('requires a trigger-level capability exactly when a receiver advertises leveled trigger modes', () => {
    const spectrum = {
      kind: 'swept-spectrum' as const,
      frequencyHz: { min: 0, max: 1_000 },
      points: { min: 2, max: 3 },
      sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
      controls: receiverSpectrumCapability(),
      powerUnit: 'dBm' as const,
    };
    const capabilities = (controls: unknown) => ({
      schemaVersion: 1 as const,
      acquisitions: [{ ...spectrum, controls }],
      features: [],
    });
    expect(instrumentCapabilitiesSchema.safeParse(capabilities({
      ...spectrum.controls, triggerModes: ['normal'], triggerLevelDbm: undefined,
    })).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse(capabilities({
      ...spectrum.controls, triggerModes: ['auto'], triggerLevelDbm: undefined,
    })).success).toBe(true);
    expect(instrumentCapabilitiesSchema.safeParse(capabilities({
      ...spectrum.controls, triggerModes: ['auto'], triggerLevelDbm: { min: -174, max: 30 },
    })).success).toBe(false);
  });

  it('rejects an automatic detected-power duration that v1 configurations cannot express', () => {
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'detected-power-timeseries',
        centerFrequencyHz: { min: 0, max: 1_000 },
        sampleCount: { min: 2, max: 3 },
        sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
        controls: receiverDetectedPowerCapability(),
        powerUnit: 'dBm',
        timing: 'uniform',
      }],
      features: [],
    }).success).toBe(false);
  });

  it('keeps feature requests, session-bound commands, and results explicit and strict', () => {
    const request = {
      kind: 'signal-lab-profile-selection' as const,
      action: 'select-profile' as const,
      profileId: 'lte-etm3.1',
    };
    expect(instrumentFeatureRequestSchema.parse(request)).toEqual(request);
    expect(instrumentFeatureCommandSchema.parse({ ...request, sessionId: 'session:opaque' }))
      .toEqual({ ...request, sessionId: 'session:opaque' });
    expect(instrumentFeatureRequestSchema.safeParse({ ...request, vendorId: '0483' }).success).toBe(false);
    expect(instrumentFeatureRequestSchema.safeParse({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'normal', modulation: { mode: 'fm', modulationFrequencyHz: 1_000, deviationHz: 25_000 },
    }).success).toBe(true);
    expect(instrumentFeatureResultSchema.safeParse({
      kind: 'screen',
      action: 'capture',
      sessionId: 'session:opaque',
      frame: {
        width: 2,
        height: 1,
        pixelFormat: 'rgb565le',
        pixels: new Uint8Array(4),
        capturedAt: '2026-07-14T18:00:00.000Z',
      },
    }).success).toBe(true);
    expect(instrumentFeatureResultSchema.safeParse({
      kind: 'screen',
      action: 'capture',
      sessionId: 'session:opaque',
      frame: {
        width: 2,
        height: 1,
        pixelFormat: 'rgb565le',
        pixels: new Uint8Array(3),
        capturedAt: '2026-07-14T18:00:00.000Z',
      },
    }).success).toBe(false);
    expect(instrumentFeatureResultSchema.safeParse({
      ...request,
      sessionId: 'session:opaque',
      producerConfigurationEpoch: 'producer-epoch:2',
    }).success).toBe(true);
    expect(instrumentFeatureResultSchema.safeParse({
      ...request,
      sessionId: 'session:opaque',
    }).success).toBe(false);
  });

  it('requires an opaque producer epoch in SignalLab provenance', () => {
    const provenance = {
      sourceKind: 'signal-lab' as const,
      sourceId: 'default',
      execution: 'signal-lab-simulation' as const,
      transport: 'signal-lab-measurement-bridge' as const,
      qualification: 'synthetic-visual-projection' as const,
      verifiedAt: '2026-07-14T18:00:00.000Z',
      producerConfigurationEpoch: 'producer-epoch:1',
      contractId: 'tinysa-signal-lab-atomizer-measurement' as const,
      contractVersion: 1 as const,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorSha256: 'c'.repeat(64),
      claims: { usbEmulated: false as const, firmwareExecuted: false as const, rfEmitted: false as const },
    };
    expect(instrumentSessionProvenanceSchema.parse(provenance)).toEqual(provenance);
    const { producerConfigurationEpoch: _omitted, ...missingEpoch } = provenance;
    expect(instrumentSessionProvenanceSchema.safeParse(missingEpoch).success).toBe(false);
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...provenance,
      producerConfigurationEpoch: 'fm',
      selectedProfileId: 'fm',
    }).success).toBe(false);
  });

  it('binds public session snapshots to their driver, candidate, and discovery provenance', () => {
    const candidate = { ...serialCandidate(), discoveryRevision: 'discovery:serial' };
    const snapshot = {
      sessionId: 'session:serial',
      driverId: candidate.driverId,
      candidate,
      provenance: {
        sourceKind: 'serial-port' as const,
        execution: 'physical' as const,
        transport: 'usb-cdc-acm' as const,
        qualification: 'device-observed' as const,
        verifiedAt: '2026-07-14T18:00:00.000Z',
        serialPort: candidate.serialPort,
        device: {
          model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'custom',
          firmwareQualification: 'custom-unqualified' as const, usbIdentityVerified: true,
        },
      },
      capabilities: {
        schemaVersion: 1 as const,
        acquisitions: [{
          kind: 'swept-spectrum' as const, frequencyHz: { min: 0, max: 1_000 }, points: { min: 2, max: 3 },
          sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
          controls: receiverSpectrumCapability(), powerUnit: 'dBm' as const,
        }],
        features: [],
      },
      rfOutput: 'not-supported' as const,
      rfOutputQualification: 'not-applicable' as const,
    };
    expect(instrumentSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(instrumentSessionSnapshotSchema.safeParse({ ...snapshot, driverId: 'other-driver' }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      provenance: { ...snapshot.provenance, serialPort: { ...snapshot.provenance.serialPort, path: '/dev/other' } },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      candidate: {
        schemaVersion: 1, driverId: snapshot.driverId, candidateId: 'signal-lab:forged', displayName: 'forged',
        sourceKind: 'signal-lab', signalLab: { sourceId: 'forged' }, discoveryRevision: 'discovery:forged',
      },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        acquisitions: snapshot.capabilities.acquisitions.map((capability) => ({
          ...capability,
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
          controls: syntheticScalarControls(),
        })),
      },
    }).success).toBe(false);
  });

  it('enforces the complete SignalLab source boundary in the public snapshot schema', () => {
    const snapshot = signalLabSnapshot();
    expect(instrumentSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      capabilities: { ...snapshot.capabilities, features: [] },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        acquisitions: snapshot.capabilities.acquisitions.slice(0, 1),
      },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        acquisitions: snapshot.capabilities.acquisitions.map((capability) => ({
          ...capability,
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.1, max: 0.1 } },
        })),
      },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        features: [{
          ...snapshot.capabilities.features[0],
          profiles: [{ profileId: 'fm', centerFrequencyHz: 2_000, recommendedSpanHz: 200 }],
        }],
      },
    }).success).toBe(false);
  });

  it('rejects capability ranges from which no schema-valid configuration can be built', () => {
    const acquisition = {
      spectrum: {
        kind: 'swept-spectrum', frequencyHz: { min: 0, max: 1 }, points: { min: 2, max: 2 },
        sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 1 } },
        controls: receiverSpectrumCapability(), powerUnit: 'dBm',
      },
      detected: {
        kind: 'detected-power-timeseries', centerFrequencyHz: { min: 0, max: 1 }, sampleCount: { min: 1, max: 1 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 1 } },
        controls: receiverDetectedPowerCapability(), powerUnit: 'dBm', timing: 'uniform',
      },
      iq: {
        kind: 'complex-iq', centerFrequencyHz: { min: 0, max: 1 }, sampleRateHz: { min: 2, max: 2 },
        bandwidthHz: { min: 1, max: 2 }, sampleCount: { min: 1, max: 1 }, sampleFormat: 'cf32le',
      },
    } as const;
    for (const capability of Object.values(acquisition)) {
      expect(instrumentCapabilitiesSchema.safeParse({ schemaVersion: 1, acquisitions: [capability], features: [] }).success).toBe(true);
    }
    const constructibleConfigurations = [{
      kind: 'swept-spectrum', startHz: acquisition.spectrum.frequencyHz.min,
      stopHz: acquisition.spectrum.frequencyHz.max, points: acquisition.spectrum.points.min,
      sweepTimeSeconds: 'auto', controls: receiverSpectrumControls(),
    }, {
      kind: 'detected-power-timeseries', centerHz: acquisition.detected.centerFrequencyHz.min,
      sampleCount: acquisition.detected.sampleCount.min,
      sweepTimeSeconds: acquisition.detected.sweepTimeSeconds.manualSeconds.min,
      controls: {
        schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz: 'auto',
        attenuationDb: 'auto', trigger: { mode: 'auto' },
      },
    }, {
      kind: 'complex-iq', centerHz: acquisition.iq.centerFrequencyHz.min,
      sampleRateHz: acquisition.iq.sampleRateHz.min, bandwidthHz: acquisition.iq.bandwidthHz.min,
      sampleCount: acquisition.iq.sampleCount.min, sampleFormat: 'cf32le',
    }];
    for (const configuration of constructibleConfigurations) {
      expect(instrumentConfigurationSchema.safeParse(configuration).success).toBe(true);
    }
    for (const invalid of [
      { ...acquisition.spectrum, points: { min: 0, max: 1 } },
      { ...acquisition.spectrum, frequencyHz: { min: 0, max: 10, step: 11 } },
      { ...acquisition.detected, sampleCount: { min: 0, max: 1 } },
      { ...acquisition.iq, sampleRateHz: { min: 0, max: 2 } },
      { ...acquisition.iq, bandwidthHz: { min: 0, max: 2 } },
      { ...acquisition.iq, sampleCount: { min: 0, max: 1 } },
      { ...acquisition.iq, sampleRateHz: { min: 1, max: 1 }, bandwidthHz: { min: 2, max: 2 } },
      { ...acquisition.iq, sampleRateHz: { min: 1, max: 3, step: 4 }, bandwidthHz: { min: 2, max: 2 } },
    ]) {
      expect(instrumentCapabilitiesSchema.safeParse({ schemaVersion: 1, acquisitions: [invalid], features: [] }).success).toBe(false);
    }
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [acquisition.spectrum],
      features: [{
        kind: 'rf-generator', paths: [{ path: 'normal', frequencyHz: { min: 1, max: 2 } }],
        levelDbm: { min: -100, max: -10 },
        modulation: { off: true, am: { modulationFrequencyHz: { min: 0, max: 0 }, depthPercent: { min: 0, max: 100 } } },
      }],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [acquisition.spectrum],
      features: [{
        kind: 'rf-generator', paths: [{ path: 'normal', frequencyHz: { min: 0, max: 0 } }],
        levelDbm: { min: -100, max: -10 }, modulation: { off: true },
      }],
    }).success).toBe(false);
  });

  it('binds every measurement to opaque session and configuration revisions', () => {
    const common = {
      schemaVersion: 1 as const,
      measurementId: 'measurement:opaque/not-a-uuid',
      sessionId: 'session:opaque/not-a-uuid',
      configurationRevision: 'configuration:opaque/not-a-uuid',
      sequence: 1,
      capturedAt: '2026-07-14T18:00:00.000Z',
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: 10,
      attenuationDb: 0,
      qualification: 'device-observed' as const,
      complete: true as const,
    };
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      producerConfigurationEpoch: 'producer-epoch:1',
      kind: 'swept-spectrum',
      frequencyHz: [100, 200, 300],
      powerDbm: [-90, -80, -95],
    }).success).toBe(true);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'swept-spectrum',
      frequencyHz: [100, 90],
      powerDbm: [-90, -80],
    }).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'detected-power-timeseries',
      centerHz: 433_920_000,
      sampleIntervalSeconds: 0.001,
      timingQualification: 'wall-clock-derived',
      powerDbm: [-91, -82],
    }).success).toBe(true);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'complex-iq',
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleFormat: 'cf32le',
      sampleCount: 2,
      samples: new Uint8Array(16),
    }).success).toBe(true);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'complex-iq',
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleFormat: 'cf32le',
      sampleCount: 2,
      samples: new Uint8Array(15),
    }).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'complex-iq', centerHz: 2_450_000_000, sampleRateHz: 1_000_000,
      bandwidthHz: 800_000, sampleFormat: 'cf32le',
      sampleCount: MAX_COMPLEX_IQ_SAMPLES_V1 + 1, samples: new Uint8Array(0),
    }).success).toBe(false);
  });

  it('accepts only compact, ordinary ArrayBuffer-backed screen and complex-I/Q payloads', () => {
    const capturedAt = '2026-07-14T18:00:00.000Z';
    const screenResult = (pixels: Uint8Array) => ({
      kind: 'screen' as const,
      action: 'capture' as const,
      sessionId: 'session:screen',
      frame: { width: 2, height: 1, pixelFormat: 'rgb565le' as const, pixels, capturedAt },
    });
    const iqMeasurement = (samples: Uint8Array) => ({
      schemaVersion: 1 as const,
      measurementId: 'measurement:iq-backing',
      sessionId: 'session:iq',
      configurationRevision: 'configuration:iq',
      sequence: 1,
      capturedAt,
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: 10,
      attenuationDb: 0,
      qualification: 'device-observed' as const,
      complete: true as const,
      kind: 'complex-iq' as const,
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleFormat: 'cf32le' as const,
      sampleCount: 2,
      samples,
    });

    expect(instrumentFeatureResultSchema.safeParse(screenResult(new Uint8Array(4))).success).toBe(true);
    expect(instrumentMeasurementSchema.safeParse(iqMeasurement(new Uint8Array(16))).success).toBe(true);

    const oversizedScreenBacking = new ArrayBuffer(64);
    const oversizedIqBacking = new ArrayBuffer(128);
    expect(instrumentFeatureResultSchema.safeParse(
      screenResult(new Uint8Array(oversizedScreenBacking, 8, 4)),
    ).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse(
      iqMeasurement(new Uint8Array(oversizedIqBacking, 0, 16)),
    ).success).toBe(false);

    const sharedScreenBacking = new SharedArrayBuffer(4);
    const sharedIqBacking = new SharedArrayBuffer(16);
    expect(instrumentFeatureResultSchema.safeParse(
      screenResult(new Uint8Array(sharedScreenBacking)),
    ).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse(
      iqMeasurement(new Uint8Array(sharedIqBacking)),
    ).success).toBe(false);
  });

  it('enforces v1 collection, string, scalar, screen, and profile ceilings', () => {
    const serial = serialCandidate();
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...serial,
      displayName: 'x'.repeat(MAX_INSTRUMENT_METADATA_CHARACTERS_V1 + 1),
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...serial,
      serialPort: { ...serial.serialPort, path: `/${'x'.repeat(MAX_INSTRUMENT_ENDPOINT_PATH_CHARACTERS_V1)}` },
    }).success).toBe(false);
    expect(instrumentDriverDiscoveryResultSchema.safeParse({
      candidates: Array.from({ length: MAX_DRIVER_DISCOVERY_CANDIDATES_V1 + 1 }, () => serial),
      failures: [],
    }).success).toBe(false);
    expect(instrumentDiscoveryResultSchema.safeParse({
      discoveryRevision: 'discovery:bounded',
      discoveredAt: '2026-07-14T18:00:00.000Z',
      candidates: Array.from(
        { length: MAX_DISCOVERY_CANDIDATES_V1 + 1 },
        () => ({ ...serial, discoveryRevision: 'discovery:bounded' }),
      ),
      failures: [],
    }).success).toBe(false);

    const profiles = Array.from({ length: MAX_SIGNAL_LAB_PROFILES_V1 + 1 }, (_value, index) => ({
      profileId: `profile:${index}`,
      centerFrequencyHz: 100_000_000,
      recommendedSpanHz: 1_000_000,
    }));
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'swept-spectrum',
        frequencyHz: { min: 0, max: 1_000_000 },
        points: { min: 2, max: 450 },
        powerUnit: 'dBm',
      }],
      features: [{
        kind: 'signal-lab-profile-selection', profiles, selectedProfileId: 'profile:0',
      }],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'swept-spectrum',
        frequencyHz: { min: 0, max: MAX_INSTRUMENT_FREQUENCY_HZ_V1 + 1 },
        points: { min: 2, max: 450 },
        powerUnit: 'dBm',
      }],
      features: [],
    }).success).toBe(false);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'swept-spectrum', frequencyHz: { min: 0, max: 1_000_000 },
        points: { min: 2, max: 450 }, powerUnit: 'dBm',
      }],
      features: [{
        kind: 'screen', width: MAX_SCREEN_DIMENSION_V1, height: MAX_SCREEN_DIMENSION_V1,
        pixelFormat: 'rgba8888',
      }],
    }).success).toBe(false);
    expect(instrumentFeatureResultSchema.safeParse({
      kind: 'screen', action: 'capture', sessionId: 'session:screen',
      frame: {
        width: MAX_SCREEN_DIMENSION_V1,
        height: MAX_SCREEN_DIMENSION_V1,
        pixelFormat: 'rgba8888',
        pixels: new Uint8Array(0),
        capturedAt: '2026-07-14T18:00:00.000Z',
      },
    }).success).toBe(false);
  });

  it('rejects scalar measurement vectors above their byte-derived v1 ceilings', () => {
    const common = {
      schemaVersion: 1 as const,
      measurementId: 'measurement:oversized',
      sessionId: 'session:future-sdr',
      configurationRevision: 'configuration:future-sdr',
      sequence: 1,
      capturedAt: '2026-07-14T18:00:00.000Z',
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: 10,
      attenuationDb: 0,
      qualification: 'device-observed' as const,
      complete: true as const,
    };
    let spectrumElementReads = 0;
    const frequencyHz = new Proxy(new Array<number>(MAX_SWEPT_SPECTRUM_POINTS_V1 + 1), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) spectrumElementReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'swept-spectrum',
      frequencyHz,
      powerDbm: [-90, -90],
    }).success).toBe(false);
    expect(spectrumElementReads).toBe(0);
    let timeseriesElementReads = 0;
    const timeseriesPowerDbm = new Proxy(new Array<number>(MAX_DETECTED_POWER_SAMPLES_V1 + 1), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) timeseriesElementReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      kind: 'detected-power-timeseries',
      centerHz: 100_000_000,
      sampleIntervalSeconds: 0.001,
      timingQualification: 'measured-calibrated',
      powerDbm: timeseriesPowerDbm,
    }).success).toBe(false);
    expect(timeseriesElementReads).toBe(0);
  });
});

function receiverSpectrumCapability() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const, acquisitionFormats: ['text', 'raw'] as const,
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    detectors: ['sample', 'quasi-peak'] as const,
    spurRejection: ['off', 'on', 'auto'] as const, lowNoiseAmplifier: ['off', 'on'] as const,
    avoidSpurs: ['off', 'on', 'auto'] as const, triggerModes: ['auto', 'normal', 'single'] as const,
    triggerLevelDbm: { min: -174, max: 30 },
  };
}

function receiverDetectedPowerCapability() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const,
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    triggerModes: ['auto', 'normal', 'single'] as const, triggerLevelDbm: { min: -174, max: 30 },
  };
}

function receiverSpectrumControls() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const, acquisitionFormat: 'raw' as const,
    resolutionBandwidthKhz: 'auto' as const, attenuationDb: 'auto' as const,
    detector: 'sample' as const, spurRejection: 'auto' as const, lowNoiseAmplifier: 'off' as const,
    avoidSpurs: 'auto' as const, trigger: { mode: 'auto' as const },
  };
}

function syntheticScalarControls() {
  return { schemaVersion: 1 as const, model: 'synthetic-scalar' as const, timingQualification: 'simulation-exact' as const };
}

function serialCandidate() {
  return {
    schemaVersion: 1 as const,
    driverId: 'tinysa-zs407',
    candidateId: 'serial:/dev/tty.fixture',
    displayName: 'tinySA Ultra+ ZS407',
    sourceKind: 'serial-port' as const,
    serialPort: {
      path: '/dev/tty.fixture',
      serialNumber: 'CDC407',
      vendorId: '0483',
      productId: '5740',
    },
  };
}

function signalLabCandidate() {
  return {
    schemaVersion: 1 as const,
    driverId: 'signal-lab',
    candidateId: 'signal-lab:default',
    displayName: 'SignalLab',
    sourceKind: 'signal-lab' as const,
    signalLab: { sourceId: 'default' },
  };
}

function signalLabSnapshot() {
  const candidate = { ...signalLabCandidate(), discoveryRevision: 'discovery:signal-lab' };
  return {
    sessionId: 'session:signal-lab',
    driverId: candidate.driverId,
    candidate,
    provenance: {
      sourceKind: 'signal-lab' as const,
      sourceId: candidate.signalLab.sourceId,
      execution: 'signal-lab-simulation' as const,
      transport: 'signal-lab-measurement-bridge' as const,
      qualification: 'synthetic-visual-projection' as const,
      verifiedAt: '2026-07-14T18:00:00.000Z',
      producerConfigurationEpoch: 'producer-epoch:1',
      contractId: 'tinysa-signal-lab-atomizer-measurement' as const,
      contractVersion: 1 as const,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorSha256: 'c'.repeat(64),
      claims: { usbEmulated: false as const, firmwareExecuted: false as const, rfEmitted: false as const },
    },
    capabilities: {
      schemaVersion: 1 as const,
      acquisitions: [{
        kind: 'swept-spectrum' as const,
        frequencyHz: { min: 1, max: 1_000, step: 1 },
        points: { min: 2, max: 450, step: 1 },
        sweepTimeSeconds: { automatic: false as const, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: syntheticScalarControls(),
        powerUnit: 'dBm' as const,
      }, {
        kind: 'detected-power-timeseries' as const,
        centerFrequencyHz: { min: 1, max: 1_000, step: 1 },
        sampleCount: { min: 1, max: 450, step: 1 },
        sweepTimeSeconds: { automatic: false as const, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: syntheticScalarControls(),
        powerUnit: 'dBm' as const,
        timing: 'uniform' as const,
      }],
      features: [{
        kind: 'signal-lab-profile-selection' as const,
        profiles: [{ profileId: 'fm', centerFrequencyHz: 100, recommendedSpanHz: 200 }],
        selectedProfileId: 'fm',
      }],
    },
    rfOutput: 'not-supported' as const,
    rfOutputQualification: 'not-applicable' as const,
  };
}
