import { describe, expect, it } from 'vitest';
import {
  COMPLEX_IQ_SAMPLE_FORMATS_V1,
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
  SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
  complexIqPayloadByteLength,
  instrumentCandidateDescriptorSchema,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentCapabilitySourceBindingIssues,
  instrumentConfigurationCapabilityBindingIssues,
  instrumentConfigurationSchema,
  instrumentDiscoveryResultSchema,
  instrumentDriverDiscoveryResultSchema,
  instrumentFeatureCommandSchema,
  instrumentFeatureRequestSchema,
  instrumentFeatureResultSchema,
  instrumentMeasurementSchema,
  instrumentReceiveOnlySafetyStateSchema,
  projectDetectedPowerTuneHz,
  instrumentSessionProvenanceSchema,
  instrumentSessionSnapshotSchema,
  instrumentSourceKindSchema,
  receiveOnlySafetyReceiptSchema,
  signalLabIqTransformReceiptSchema,
  signalLabProfileSelectionCapabilitySchema,
} from './instrument.js';
import {
  SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES,
  ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
} from './firmware-provenance.js';

describe('instrument boundary contracts', () => {
  it('admits only versioned same-session output-off command receipts without RF measurement claims', () => {
    const connection = safetyReceipt(1, 'connection-first-command');
    const current = safetyReceipt(2, 'pre-acquisition');
    const state = { connectionReceipt: connection, currentReceipt: current };

    expect(receiveOnlySafetyReceiptSchema.safeParse(connection).success).toBe(true);
    expect(instrumentReceiveOnlySafetyStateSchema.safeParse(state).success).toBe(true);
    for (const invalid of [
      { ...connection, schemaVersion: 2 },
      { ...connection, receiptId: 'receipt:not-a-uuid' },
      { ...connection, sessionId: 'session:not-a-uuid' },
      { ...connection, command: 'output on' },
      { ...connection, acknowledgement: 'assumed' },
      { ...connection, qualification: 'rf-measured' },
      { ...connection, sequence: 0 },
      { ...connection, invented: true },
    ]) expect(receiveOnlySafetyReceiptSchema.safeParse(invalid).success).toBe(false);
    expect(instrumentReceiveOnlySafetyStateSchema.safeParse({
      connectionReceipt: connection,
      currentReceipt: { ...current, sessionId: '50000000-0000-4000-8000-000000000002' },
    }).success).toBe(false);
    expect(instrumentReceiveOnlySafetyStateSchema.safeParse({
      connectionReceipt: connection,
      currentReceipt: { ...current, sequence: 1, receiptId: current.receiptId },
    }).success).toBe(false);
    expect(instrumentReceiveOnlySafetyStateSchema.safeParse({
      connectionReceipt: connection,
      currentReceipt: { ...current, receiptId: connection.receiptId },
    }).success).toBe(false);
  });

  it('projects a fractional detector centroid onto the admitted integer-Hz detected-power tune', () => {
    const projected = projectDetectedPowerTuneHz(100_000_000.49, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1);
    expect(projected).toBe(100_000_000);
    expect(instrumentConfigurationSchema.safeParse({
      kind: 'detected-power-timeseries',
      centerHz: projected,
      sampleCount: 450,
      sweepTimeSeconds: 0.05,
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
    }).success).toBe(true);
    expect(projectDetectedPowerTuneHz(100_000_000.5, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1))
      .toBe(100_000_001);
    expect(projectDetectedPowerTuneHz(105, { min: 90, max: 110, step: 10 })).toBe(110);
    expect(projectDetectedPowerTuneHz(104.999, { min: 90, max: 110, step: 10 })).toBe(100);
    expect(() => projectDetectedPowerTuneHz(Number.NaN, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1)).toThrow(/finite/);
    expect(() => projectDetectedPowerTuneHz(0.9, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1)).toThrow(/outside/);
  });

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

  it('parses both new Neptune P210 source kinds as strict, self-owned candidate variants', () => {
    expect(instrumentSourceKindSchema.safeParse('neptune-p210').success).toBe(true);
    expect(instrumentSourceKindSchema.safeParse('neptune-p210-twin').success).toBe(true);

    const physical = neptuneP210Candidate();
    const twin = neptuneP210TwinCandidate();
    expect(instrumentCandidateDescriptorSchema.parse(physical)).toEqual(physical);
    expect(instrumentCandidateDescriptorSchema.parse(twin)).toEqual(twin);
    expect(instrumentCandidateSchema.safeParse({ ...physical, discoveryRevision: 'discovery:neptune-p210' }).success).toBe(true);
    expect(instrumentCandidateSchema.safeParse({ ...twin, discoveryRevision: 'discovery:neptune-p210-twin' }).success).toBe(true);

    // The twin's physicalRfModeled marker is a fixed literal false, never a
    // configurable boolean: the twin can never truthfully claim RF fidelity.
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...twin,
      neptuneP210Twin: { ...twin.neptuneP210Twin, physicalRfModeled: true },
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...twin,
      neptuneP210Twin: { ...twin.neptuneP210Twin, profile: 'production' },
    }).success).toBe(false);
  });

  it('keeps Neptune P210 candidates from smuggling serial-port, firmware-twin, or SignalLab fields', () => {
    const physical = neptuneP210Candidate();
    const twin = neptuneP210TwinCandidate();
    const serial = serialCandidate();
    const signalLab = signalLabCandidate();

    // Borrowing another source kind's evidence field is rejected by the
    // strict object shape, per ADR 0004 "Source identity is not flattened".
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...physical,
      serialPort: serial.serialPort,
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...physical,
      signalLab: signalLab.signalLab,
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...twin,
      firmwareTwin: {
        bridge: 'renode-monitor-v1',
        repositoryCommit: 'a'.repeat(40),
        firmwareBinarySha256: 'b'.repeat(64),
        usbTransactionsModeled: false,
      },
    }).success).toBe(false);
    // A VID/PID pair belongs only to serial-port evidence.
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...physical,
      neptuneP210: { ...physical.neptuneP210, vendorId: '0483', productId: '5740' },
    }).success).toBe(false);
    // Declaring the wrong discriminant with the other kind's evidence group must fail.
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...physical,
      sourceKind: 'neptune-p210-twin',
    }).success).toBe(false);
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...twin,
      sourceKind: 'neptune-p210',
    }).success).toBe(false);
    // An empty endpoint is not truthful network evidence.
    expect(instrumentCandidateDescriptorSchema.safeParse({
      ...physical,
      neptuneP210: { endpoint: '' },
    }).success).toBe(false);
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
            fixtureVisualProfile('cw', 100_000_000, 1, 2_000_000),
            fixtureVisualProfile('fm', 101_000_000, 200_000, 500_000),
          ],
          selectedProfileId: 'cw',
          channel: {
            model: 'awgn', noiseFloorDbm: -108, seed: 407, fadingRateHz: 2,
            receiverImpairment: 'clean',
          },
          iqProfiles: [
            {
              profileId: 'cw', nativeSampleRateHz: null, signalBandwidthHz: 1,
              profileReferenceCenterHz: 100_000_000, nativeCarrierOffsetHz: 0,
              nativeMinimumCaptureBandwidthHz: null,
              replay: 'continuous', derivedTransportSupported: false,
            },
            {
              profileId: 'fm', nativeSampleRateHz: null, signalBandwidthHz: 200_000,
              profileReferenceCenterHz: 101_000_000, nativeCarrierOffsetHz: 0,
              nativeMinimumCaptureBandwidthHz: null,
              replay: 'continuous', derivedTransportSupported: false,
            },
          ],
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
        bandwidthHz: { min: 1, max: 1 }, sampleCount: { min: 1, max: 1 }, sampleFormat: 'cf64le',
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

  it('expresses and enforces equal-rate I/Q bandwidth without changing independent capabilities', () => {
    const equalRateCapability = {
      kind: 'complex-iq' as const,
      centerFrequencyHz: { min: 0, max: 6_000_000_000 },
      sampleRateHz: { min: 1_000_000, max: 4_000_000, step: 1_000_000 },
      bandwidthHz: { min: 1_000_000, max: 4_000_000, step: 1_000_000 },
      bandwidthMode: 'equal-to-sample-rate' as const,
      sampleCount: { min: 1, max: 65_536 },
      sampleFormat: 'cf32le' as const,
    };
    const capabilities = instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [equalRateCapability],
      features: [],
    });
    const unequalConfiguration = instrumentConfigurationSchema.parse({
      kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 2_000_000,
      bandwidthHz: 1_000_000, sampleCount: 1_024, sampleFormat: 'cf32le',
    });
    expect(instrumentConfigurationCapabilityBindingIssues(unequalConfiguration, capabilities))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: ['bandwidthHz'], message: expect.stringMatching(/must equal sample rate/) })]));

    const independent = instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [{ ...equalRateCapability, bandwidthMode: 'independent' }],
      features: [],
    });
    expect(instrumentConfigurationCapabilityBindingIssues(unequalConfiguration, independent)).toEqual([]);
    const legacyIndependent = instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [{ ...equalRateCapability, bandwidthMode: undefined }],
      features: [],
    });
    expect(instrumentConfigurationCapabilityBindingIssues(unequalConfiguration, legacyIndependent)).toEqual([]);
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        ...equalRateCapability,
        sampleRateHz: { min: 2, max: 8, step: 2 },
        bandwidthHz: { min: 1, max: 9, step: 2 },
      }],
      features: [],
    }).success).toBe(false);
  });

  it('admits common interleaved I/Q encodings with exact bounded byte geometry', () => {
    const bytesPerSample = { cf32le: 8, ci16le: 4, ci8: 2, cu8: 2 } as const;
    const commonMeasurement = {
      schemaVersion: 1 as const,
      measurementId: 'measurement:iq-formats',
      sessionId: 'session:iq-formats',
      configurationRevision: 'configuration:iq-formats',
      sequence: 1,
      capturedAt: '2026-07-17T18:00:00.000Z',
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: 'device-observed' as const,
      complete: true as const,
      kind: 'complex-iq' as const,
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleCount: 3,
    };

    for (const sampleFormat of COMPLEX_IQ_SAMPLE_FORMATS_V1) {
      const byteLength = bytesPerSample[sampleFormat] * commonMeasurement.sampleCount;
      expect(complexIqPayloadByteLength(commonMeasurement.sampleCount, sampleFormat)).toBe(byteLength);
      expect(instrumentCapabilitiesSchema.safeParse({
        schemaVersion: 1,
        acquisitions: [{
          kind: 'complex-iq',
          centerFrequencyHz: { min: 0, max: 6_000_000_000 },
          sampleRateHz: { min: 48_000, max: 20_000_000 },
          bandwidthHz: { min: 10_000, max: 20_000_000 },
          sampleCount: { min: 1, max: 1_024 },
          sampleFormat,
        }],
        features: [],
      }).success, sampleFormat).toBe(true);
      expect(instrumentConfigurationSchema.safeParse({
        kind: 'complex-iq', centerHz: commonMeasurement.centerHz,
        sampleRateHz: commonMeasurement.sampleRateHz, bandwidthHz: commonMeasurement.bandwidthHz,
        sampleCount: commonMeasurement.sampleCount, sampleFormat,
      }).success, sampleFormat).toBe(true);
      expect(instrumentMeasurementSchema.safeParse({
        ...commonMeasurement,
        sampleFormat,
        samples: new Uint8Array(byteLength),
      }).success, sampleFormat).toBe(true);
      expect(instrumentMeasurementSchema.safeParse({
        ...commonMeasurement,
        sampleFormat,
        samples: new Uint8Array(byteLength - 1),
      }).success, sampleFormat).toBe(false);
    }

    expect(() => complexIqPayloadByteLength(0, 'cf32le')).toThrow(/positive safe integer/);
    expect(() => complexIqPayloadByteLength(MAX_COMPLEX_IQ_SAMPLES_V1 + 1, 'ci8')).toThrow(/limited/);
  });

  it('rejects Neptune P210 sessions that advertise scalar, generator, or SignalLab profile capabilities', () => {
    for (const sourceKind of ['neptune-p210', 'neptune-p210-twin'] as const) {
      const iqOnly = neptuneComplexIqCapabilities();
      expect(instrumentCapabilitySourceBindingIssues(sourceKind, iqOnly)).toEqual([]);

      const withScalarSpectrum = {
        ...iqOnly,
        acquisitions: [...iqOnly.acquisitions, {
          kind: 'swept-spectrum' as const,
          frequencyHz: { min: 0, max: 1_000 },
          points: { min: 2, max: 3 },
          sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
          controls: receiverSpectrumCapability(),
          powerUnit: 'dBm' as const,
        }],
      };
      expect(instrumentCapabilitySourceBindingIssues(sourceKind, withScalarSpectrum))
        .toEqual(expect.arrayContaining([expect.objectContaining({
          path: ['acquisitions'],
          message: expect.stringMatching(/must not advertise swept-spectrum or detected-power/),
        })]));

      const withSyntheticScalar = {
        ...iqOnly,
        acquisitions: [...iqOnly.acquisitions, {
          kind: 'detected-power-timeseries' as const,
          centerFrequencyHz: { min: 0, max: 1_000 },
          sampleCount: { min: 1, max: 3 },
          sweepTimeSeconds: { automatic: false as const, manualSeconds: { min: 0.05, max: 0.05 } },
          controls: syntheticScalarControls(),
          powerUnit: 'dBm' as const,
          timing: 'uniform' as const,
        }],
      };
      expect(instrumentCapabilitySourceBindingIssues(sourceKind, withSyntheticScalar))
        .toEqual(expect.arrayContaining([expect.objectContaining({ path: ['acquisitions'] })]));

      const withGenerator = {
        ...iqOnly,
        features: [{
          kind: 'rf-generator' as const,
          paths: [{ path: 'normal' as const, frequencyHz: { min: 1, max: 1_000 } }],
          levelDbm: { min: -30, max: 0 },
          modulation: { off: true as const },
        }],
      };
      expect(instrumentCapabilitySourceBindingIssues(sourceKind, withGenerator))
        .toEqual(expect.arrayContaining([expect.objectContaining({
          path: ['features'],
          message: expect.stringMatching(/receive-only in v1 and must not advertise an RF-generator/),
        })]));

      const withProfileSelection = {
        ...iqOnly,
        features: [{
          kind: 'signal-lab-profile-selection' as const,
          profiles: [fixtureVisualProfile('fm', 100, 200, 200)],
          selectedProfileId: 'fm',
          channel: {
            model: 'awgn' as const, noiseFloorDbm: -108, seed: 407, fadingRateHz: 2,
            receiverImpairment: 'clean' as const,
          },
          iqProfiles: [{
            profileId: 'fm', nativeSampleRateHz: null, signalBandwidthHz: 200,
            profileReferenceCenterHz: 100, nativeCarrierOffsetHz: 0,
            nativeMinimumCaptureBandwidthHz: null, replay: 'continuous' as const,
            derivedTransportSupported: false,
          }],
        }],
      };
      expect(instrumentCapabilitySourceBindingIssues(sourceKind, withProfileSelection))
        .toEqual(expect.arrayContaining([expect.objectContaining({
          path: ['features'],
          message: expect.stringMatching(/cannot advertise SignalLab profile selection/),
        })]));

      const scalarOnly = {
        ...iqOnly,
        acquisitions: [withScalarSpectrum.acquisitions[1]!],
      };
      expect(instrumentCapabilitySourceBindingIssues(sourceKind, scalarOnly))
        .toEqual(expect.arrayContaining([expect.objectContaining({
          message: expect.stringMatching(/must advertise complex-I\/Q acquisition/),
        })]));
    }
  });

  it('carries complete SignalLab catalog and channel evidence without admitting partial descriptors', () => {
    const descriptor = {
      profileId: 'lte-etm1.1',
      label: 'LTE E-TM 1.1',
      family: 'e-utra' as const,
      model: 'E-TM 1.1',
      qualification: 'standards-derived' as const,
      centerFrequencyHz: 1_842_500_000,
      occupiedBandwidthHz: 9_000_000,
      recommendedSpanHz: 12_000_000,
      projection: {
        allocation: 'full' as const,
        modulation: 'ofdm-mixed' as const,
        timing: 'frame' as const,
        duplex: 'fdd' as const,
        subcarrierSpacingHz: 15_000,
        nominalResourceBlocks: 50,
      },
      source: {
        organization: '3GPP' as const,
        references: [{
          specification: 'TS 36.141',
          clause: '6.1',
          revision: 'Release 18',
          url: 'https://www.3gpp.org/dynareport/36141.htm',
        }],
      },
      governance: fixtureGovernance('lte-etm1.1', '3GPP'),
      disclosure: 'Standards-derived deterministic baseband projection.',
    };
    const channel = {
      model: 'awgn' as const,
      noiseFloorDbm: -100,
      seed: 1,
      fadingRateHz: 1,
      receiverImpairment: 'clean' as const,
    };
    const capability = {
      kind: 'signal-lab-profile-selection' as const,
      profiles: [descriptor],
      selectedProfileId: descriptor.profileId,
      channel,
      iqProfiles: [{
        profileId: descriptor.profileId,
        nativeSampleRateHz: null,
        signalBandwidthHz: descriptor.occupiedBandwidthHz,
        profileReferenceCenterHz: descriptor.centerFrequencyHz,
        nativeCarrierOffsetHz: 0,
        nativeMinimumCaptureBandwidthHz: null,
        replay: 'continuous' as const,
        derivedTransportSupported: false,
      }],
    };

    expect(signalLabProfileSelectionCapabilitySchema.parse(capability)).toEqual(capability);
    expect(signalLabProfileSelectionCapabilitySchema.safeParse({
      ...capability,
      profiles: [{
        profileId: descriptor.profileId,
        centerFrequencyHz: descriptor.centerFrequencyHz,
        recommendedSpanHz: descriptor.recommendedSpanHz,
        label: descriptor.label,
      }],
    }).success).toBe(false);
    expect(signalLabProfileSelectionCapabilitySchema.safeParse({
      ...capability,
      profiles: [descriptor, { profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }],
    }).success).toBe(false);
    expect(signalLabProfileSelectionCapabilitySchema.safeParse({
      ...capability,
      profiles: [{ ...descriptor, qualification: 'conformance-validated' }],
    }).success).toBe(false);
    expect(signalLabProfileSelectionCapabilitySchema.safeParse({
      ...capability,
      channel: { ...channel, seed: 0 },
    }).success).toBe(false);
    expect(signalLabProfileSelectionCapabilitySchema.safeParse({
      ...capability,
      iqProfiles: [{ ...capability.iqProfiles[0], profileId: 'missing-profile' }],
    }).success).toBe(false);
    expect(signalLabProfileSelectionCapabilitySchema.safeParse({
      ...capability,
      iqProfiles: [capability.iqProfiles[0], capability.iqProfiles[0]],
    }).success).toBe(false);
  });

  it('admits transform receipts whose native FIR support exceeds the output chunk', () => {
    const receipt = {
      receiptVersion: 1,
      sourceArtifactSha256: 'a'.repeat(64),
      sourceStartSample: -34,
      sourceSampleCount: 131_139,
      sourceBoundaryPolicy: 'one-shot-zero-extended',
      sourcePeriodSamples: null,
      outputStartSourceSampleNumerator: '0',
      outputStartSourceSampleDenominator: '1',
      sourceSampleRateHz: 80_000_000,
      outputSampleRateHz: 40_000_000,
      sourceCarrierOffsetHz: 0,
      outputCarrierOffsetHz: 0,
      outputSampleCount: 65_536,
      sourceSamplesSha256: 'b'.repeat(64),
      outputSamplesSha256: 'c'.repeat(64),
      operations: [{
        kind: 'resample',
        algorithm: 'blackman-windowed-sinc-v1',
        sourceSampleRateHz: 80_000_000,
        outputSampleRateHz: 40_000_000,
        antiAliasCutoffHz: 19_000_000,
        zeroCrossings: 16,
      }],
    } as const;
    expect(signalLabIqTransformReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(signalLabIqTransformReceiptSchema.safeParse({
      ...receipt,
      sourceSampleCount: receipt.sourceSampleCount - 1,
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
    const channelRequest = {
      kind: 'signal-lab-profile-selection' as const,
      action: 'configure-channel' as const,
      channel: { model: 'rayleigh' as const, noiseFloorDbm: -104, seed: 42, fadingRateHz: 3.5, receiverImpairment: 'phase-noise' as const },
    };
    expect(instrumentFeatureRequestSchema.parse(channelRequest)).toEqual(channelRequest);
    expect(instrumentFeatureCommandSchema.parse({ ...channelRequest, sessionId: 'session:opaque' }))
      .toEqual({ ...channelRequest, sessionId: 'session:opaque' });
    expect(instrumentFeatureResultSchema.parse({
      ...channelRequest,
      sessionId: 'session:opaque',
      producerConfigurationEpoch: 'producer-epoch:3',
    })).toEqual({
      ...channelRequest,
      sessionId: 'session:opaque',
      producerConfigurationEpoch: 'producer-epoch:3',
    });
    expect(instrumentFeatureRequestSchema.safeParse({
      ...channelRequest,
      channel: { ...channelRequest.channel, noiseFloorDbm: -151 },
    }).success).toBe(false);
    expect(instrumentFeatureRequestSchema.safeParse({
      ...channelRequest,
      channel: { ...channelRequest.channel, receiverImpairment: 'unbounded-custom-chain' },
    }).success).toBe(false);
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
      contractVersion: 2 as const,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorContractBindingSha256: 'c'.repeat(64),
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

  it('makes physical firmware provenance a closed qualification-dependent union', () => {
    const base = {
      sourceKind: 'serial-port' as const,
      execution: 'physical' as const,
      transport: 'usb-cdc-acm' as const,
      qualification: 'device-observed' as const,
      verifiedAt: '2026-07-14T18:00:00.000Z',
      serialPort: { path: '/dev/tty.fixture', vendorId: '0483', productId: '5740' },
    };
    const custom = {
      ...base,
      device: {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'tinySA4_custom-gdeadbee',
        firmwareReportedRevision: 'deadbee',
        firmwareQualification: 'custom-unqualified' as const,
        firmwareWarning: 'Custom firmware revision deadbee is admitted without source qualification.',
        usbIdentityVerified: true as const,
      },
    };
    expect(instrumentSessionProvenanceSchema.parse(custom)).toEqual(custom);
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...custom,
      device: { ...custom.device, firmwareSourceCommit: 'deadbee0000000000000000000000000000000000' },
    }).success).toBe(false);
    for (const omitted of ['firmwareReportedRevision', 'firmwareWarning'] as const) {
      const device: Partial<typeof custom.device> = { ...custom.device };
      delete device[omitted];
      expect(instrumentSessionProvenanceSchema.safeParse({ ...custom, device }).success).toBe(false);
    }

    const customReceiverRecord = SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES[
      'tinySA4_hw-v0.3-fft1024-g43eb0f1'
    ];
    const sourceQualifiedCustomReceiver = {
      ...base,
      device: {
        model: 'tinySA Ultra+ ZS407',
        hardwareVersion: 'ZS407',
        firmwareVersion: 'tinySA4_hw-v0.3-fft1024-g43eb0f1',
        firmwareReportedRevision: customReceiverRecord.reportedRevision,
        firmwareSourceCommit: ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
        firmwareQualification: 'custom-source-qualified-receive-only' as const,
        firmwareWarning: customReceiverRecord.warning,
        usbIdentityVerified: true as const,
      },
    };
    expect(instrumentSessionProvenanceSchema.parse(sourceQualifiedCustomReceiver))
      .toEqual(sourceQualifiedCustomReceiver);
    for (const device of [
      { ...sourceQualifiedCustomReceiver.device, firmwareVersion: `${sourceQualifiedCustomReceiver.device.firmwareVersion}-dirty` },
      { ...sourceQualifiedCustomReceiver.device, firmwareSourceCommit: `43eb0f1${'0'.repeat(33)}` },
      { ...sourceQualifiedCustomReceiver.device, firmwareWarning: `${customReceiverRecord.warning} altered` },
    ]) {
      expect(instrumentSessionProvenanceSchema.safeParse({ ...base, device }).success).toBe(false);
    }

    const supported = {
      ...base,
      device: {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
        firmwareReportedRevision: 'c5dd31f',
        firmwareSourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
        firmwareQualification: 'supported-oem' as const,
        usbIdentityVerified: true as const,
      },
    };
    expect(instrumentSessionProvenanceSchema.parse(supported)).toEqual(supported);
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...supported,
      device: { ...supported.device, firmwareSourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671' },
    }).success).toBe(false);
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...supported,
      device: { ...supported.device, firmwareVersion: 'custom-lab-v99-gdeadbee' },
    }).success).toBe(false);
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...supported,
      device: { ...supported.device, firmwareVersion: 'tinySA4_v1-gc5dd31f-extra-gc5dd31f' },
    }).success).toBe(false);
    for (const firmwareVersion of [
      'tinySA4_v1.4-217-gc5dd31f-dirty',
      'tinySA4_custom-gc5dd31f',
      'tinySA4_v1.4-217-gc5dd31f HACKED',
    ]) {
      expect(instrumentSessionProvenanceSchema.safeParse({
        ...supported,
        device: { ...supported.device, firmwareVersion },
      }).success).toBe(false);
    }
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...supported,
      device: {
        ...supported.device,
        firmwareVersion: 'tinySA4_custom-injected-gdeadbee',
        firmwareReportedRevision: 'deadbee',
        firmwareSourceCommit: `deadbee${'0'.repeat(33)}`,
      },
    }).success).toBe(false);
    const { firmwareSourceCommit: _omittedCommit, ...supportedWithoutCommit } = supported.device;
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...supported,
      device: supportedWithoutCommit,
    }).success).toBe(false);
    expect(instrumentSessionProvenanceSchema.safeParse({
      ...supported,
      device: { ...supported.device, firmwareWarning: 'contradictory warning' },
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
          model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_custom-gdeadbee',
          firmwareReportedRevision: 'deadbee',
          firmwareQualification: 'custom-unqualified' as const,
          firmwareWarning: 'Custom firmware revision deadbee is admitted without source qualification.',
          usbIdentityVerified: true,
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
    const safetySessionId = '50000000-0000-4000-8000-000000000001';
    const receiveOnlySafety = {
      connectionReceipt: safetyReceipt(1, 'connection-first-command', safetySessionId),
      currentReceipt: safetyReceipt(2, 'analyzer-configuration', safetySessionId),
    };
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      sessionId: safetySessionId,
      receiveOnlySafety,
    }).success).toBe(true);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      sessionId: safetySessionId,
      receiveOnlySafety: {
        ...receiveOnlySafety,
        currentReceipt: { ...receiveOnlySafety.currentReceipt, sessionId: '50000000-0000-4000-8000-000000000002' },
      },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...signalLabSnapshot(),
      sessionId: safetySessionId,
      receiveOnlySafety,
    }).success).toBe(false);
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

  it('binds both new Neptune P210 session kinds through provenance narrowing without a false source-narrowing throw', () => {
    const physicalSnapshot = neptuneP210Snapshot();
    const twinSnapshot = neptuneP210TwinSnapshot();
    expect(() => instrumentSessionSnapshotSchema.safeParse(physicalSnapshot)).not.toThrow();
    expect(() => instrumentSessionSnapshotSchema.safeParse(twinSnapshot)).not.toThrow();
    expect(instrumentSessionSnapshotSchema.safeParse(physicalSnapshot).success).toBe(true);
    expect(instrumentSessionSnapshotSchema.safeParse(twinSnapshot).success).toBe(true);

    // rfOutput must land as not-supported: Neptune v1 is receive-only and
    // advertises no RF-generator feature.
    expect(physicalSnapshot.rfOutput).toBe('not-supported');
    expect(physicalSnapshot.rfOutputQualification).toBe('not-applicable');
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...physicalSnapshot,
      rfOutput: 'off',
      rfOutputQualification: 'command-acknowledged',
    }).success).toBe(false);

    // Candidate/provenance endpoint evidence must agree exactly.
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...physicalSnapshot,
      provenance: { ...physicalSnapshot.provenance, endpoint: 'ip:10.0.0.251' },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...twinSnapshot,
      provenance: { ...twinSnapshot.provenance, physicalRfModeled: true },
    }).success).toBe(false);

    // A candidate/provenance source-kind mismatch is rejected, not thrown,
    // for both new source kinds.
    expect(() => instrumentSessionSnapshotSchema.safeParse({
      ...physicalSnapshot,
      provenance: twinSnapshot.provenance,
    })).not.toThrow();
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...physicalSnapshot,
      provenance: twinSnapshot.provenance,
    }).success).toBe(false);
    expect(() => instrumentSessionSnapshotSchema.safeParse({
      ...twinSnapshot,
      provenance: physicalSnapshot.provenance,
    })).not.toThrow();
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...twinSnapshot,
      provenance: physicalSnapshot.provenance,
    }).success).toBe(false);

    // Neptune capability/feature source binding is enforced inside the public snapshot too.
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...physicalSnapshot,
      capabilities: {
        ...physicalSnapshot.capabilities,
        features: [{
          kind: 'rf-generator' as const,
          paths: [{ path: 'normal' as const, frequencyHz: { min: 1, max: 1_000 } }],
          levelDbm: { min: -30, max: 0 },
          modulation: { off: true as const },
        }],
      },
      rfOutput: 'off',
      rfOutputQualification: 'command-acknowledged',
    }).success).toBe(false);
  });

  it('binds authoritative snapshot configuration to its session and advertised capabilities', () => {
    const candidate = { ...serialCandidate(), discoveryRevision: 'discovery:configured' };
    const snapshot = {
      sessionId: 'session:configured',
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
          model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'tinySA4_custom-gdeadbee',
          firmwareReportedRevision: 'deadbee',
          firmwareQualification: 'custom-unqualified' as const,
          firmwareWarning: 'Custom firmware revision deadbee is admitted without source qualification.',
          usbIdentityVerified: true,
        },
      },
      capabilities: {
        schemaVersion: 1 as const,
        acquisitions: [{
          kind: 'swept-spectrum' as const,
          frequencyHz: { min: 100, max: 1_000, step: 100 },
          points: { min: 2, max: 5, step: 1 },
          sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.01, max: 1 } },
          controls: receiverSpectrumCapability(),
          powerUnit: 'dBm' as const,
        }],
        features: [],
      },
      rfOutput: 'not-supported' as const,
      rfOutputQualification: 'not-applicable' as const,
      configuration: {
        sessionId: 'session:configured',
        configurationRevision: 'configuration:configured',
        configuredAt: '2026-07-14T18:00:00.000Z',
        configuration: {
          kind: 'swept-spectrum' as const,
          startHz: 100,
          stopHz: 1_000,
          points: 5,
          sweepTimeSeconds: 'auto' as const,
          controls: receiverSpectrumControls(),
        },
      },
    };

    expect(instrumentSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      configuration: { ...snapshot.configuration, sessionId: 'session:other' },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      configuration: {
        ...snapshot.configuration,
        configuration: { ...snapshot.configuration.configuration, stopHz: 950 },
      },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      configuration: {
        ...snapshot.configuration,
        configuration: {
          ...snapshot.configuration.configuration,
          controls: { ...snapshot.configuration.configuration.controls, detector: 'average' as const },
        },
      },
    }).success).toBe(false);
    expect(instrumentSessionSnapshotSchema.safeParse({
      ...snapshot,
      configuration: {
        ...snapshot.configuration,
        configuration: {
          kind: 'detected-power-timeseries' as const,
          centerHz: 100,
          sampleCount: 5,
          sweepTimeSeconds: 0.05,
          controls: {
            schemaVersion: 1 as const,
            model: 'receiver' as const,
            resolutionBandwidthKhz: 'auto' as const,
            attenuationDb: 'auto' as const,
            trigger: { mode: 'auto' as const },
          },
        },
      },
    }).success).toBe(false);
  });

  it('enforces the complete SignalLab source boundary in the public snapshot schema', () => {
    const snapshot = signalLabSnapshot();
    expect(instrumentSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.capabilities.acquisitions.some((capability) => capability.kind === 'complex-iq')).toBe(true);
    expect(snapshot.capabilities.features[0]?.iqProfiles?.map(({ profileId }) => profileId)).toEqual(['fm']);
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
    const safetySessionId = '50000000-0000-4000-8000-000000000001';
    const receipt = safetyReceipt(3, 'pre-acquisition', safetySessionId);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      sessionId: safetySessionId,
      kind: 'swept-spectrum',
      frequencyHz: [100, 200, 300],
      powerDbm: [-90, -80, -95],
      receiveOnlySafetyReceipt: receipt,
    }).success).toBe(true);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      sessionId: safetySessionId,
      kind: 'swept-spectrum',
      frequencyHz: [100, 200, 300],
      powerDbm: [-90, -80, -95],
      receiveOnlySafetyReceipt: { ...receipt, sessionId: '50000000-0000-4000-8000-000000000002' },
    }).success).toBe(false);
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
      qualification: 'analytic-complex-baseband',
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
      qualification: 'standards-derived-complex-baseband',
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
      qualification: 'analytic-complex-baseband',
      kind: 'swept-spectrum',
      frequencyHz: [100, 200],
      powerDbm: [-90, -80],
    }).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      qualification: 'analytic-complex-baseband',
      kind: 'detected-power-timeseries',
      centerHz: 433_920_000,
      sampleIntervalSeconds: 0.001,
      timingQualification: 'simulation-exact',
      powerDbm: [-91, -82],
    }).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      qualification: 'standards-derived-complex-baseband',
      kind: 'swept-spectrum',
      frequencyHz: [100, 200],
      powerDbm: [-90, -80],
    }).success).toBe(false);
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

  it('parses and round-trips Neptune P210 ADC evidence without mixing SignalLab v2 semantics', () => {
    const common = {
      schemaVersion: 1 as const,
      measurementId: 'measurement:neptune-p210',
      sessionId: 'session:neptune-p210',
      configurationRevision: 'configuration:neptune-p210',
      sequence: 1,
      capturedAt: '2026-07-14T18:00:00.000Z',
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: 'device-observed' as const,
      complete: true as const,
      kind: 'complex-iq' as const,
      centerHz: 433_920_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleFormat: 'cf32le' as const,
      sampleCount: 2,
      samples: new Uint8Array(16),
    };
    const withAdcEvidence = {
      ...common,
      adcSignificantBits: 12 as const,
      adcFullScaleCode: 2_048 as const,
      powerReference: 'uncalibrated-dbfs-relative' as const,
    };
    const parsed = instrumentMeasurementSchema.safeParse(withAdcEvidence);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(withAdcEvidence);

    // Fields must be present atomically: a driver cannot report only a
    // fragment of the truthful ADC evidence.
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      adcSignificantBits: 12,
    }).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse({
      ...common,
      adcFullScaleCode: 2_048,
      powerReference: 'uncalibrated-dbfs-relative',
    }).success).toBe(false);

    // The full-scale code and bit depth are fixed hardware facts, not
    // driver-chosen values.
    expect(instrumentMeasurementSchema.safeParse({
      ...withAdcEvidence,
      adcFullScaleCode: 4_096,
    }).success).toBe(false);
    expect(instrumentMeasurementSchema.safeParse({
      ...withAdcEvidence,
      adcSignificantBits: 16,
    }).success).toBe(false);

    // Neptune ADC evidence and SignalLab v2 I/Q semantics are parallel,
    // never-combined blocks.
    const mixed = instrumentMeasurementSchema.safeParse({
      ...withAdcEvidence,
      profileReferenceCenterHz: common.centerHz,
    });
    expect(mixed.success).toBe(false);
    if (!mixed.success) {
      expect(mixed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/must not be combined with SignalLab/) }),
      ]));
    }
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

  it('rejects oversized nested receiver capability enums before reading their elements', () => {
    const cases = [
      ['acquisitionFormats', 2, 'text'],
      ['detectors', 8, 'sample'],
      ['spurRejection', 3, 'off'],
      ['lowNoiseAmplifier', 2, 'off'],
      ['avoidSpurs', 3, 'off'],
      ['triggerModes', 3, 'auto'],
    ] as const;
    for (const [key, maximum, value] of cases) {
      let elementReads = 0;
      const oversized = new Proxy(Array.from({ length: maximum + 1 }, () => value), {
        get(target, property, receiver) {
          if (/^\d+$/.test(String(property))) elementReads++;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(instrumentCapabilitiesSchema.safeParse({
        schemaVersion: 1,
        acquisitions: [{
          kind: 'swept-spectrum',
          frequencyHz: { min: 100, max: 1_000 },
          points: { min: 2, max: 5 },
          sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.01, max: 1 } },
          controls: { ...receiverSpectrumCapability(), [key]: oversized },
          powerUnit: 'dBm',
        }],
        features: [],
      }).success).toBe(false);
      expect(elementReads, key).toBe(0);
    }

    let detectedPowerTriggerReads = 0;
    const oversizedTriggerModes = new Proxy(['auto', 'normal', 'single', 'auto'], {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) detectedPowerTriggerReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(instrumentCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'detected-power-timeseries',
        centerFrequencyHz: { min: 100, max: 1_000 },
        sampleCount: { min: 1, max: 5 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.01, max: 1 } },
        controls: { ...receiverDetectedPowerCapability(), triggerModes: oversizedTriggerModes },
        powerUnit: 'dBm',
        timing: 'uniform',
      }],
      features: [],
    }).success).toBe(false);
    expect(detectedPowerTriggerReads).toBe(0);
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

function neptuneP210Candidate() {
  return {
    schemaVersion: 1 as const,
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210:ip:10.0.0.250',
    displayName: 'NeptuneSDR P210',
    sourceKind: 'neptune-p210' as const,
    neptuneP210: { endpoint: 'ip:10.0.0.250' },
  };
}

function neptuneP210TwinCandidate() {
  return {
    schemaVersion: 1 as const,
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210-twin:ip:127.0.0.1',
    displayName: 'NeptuneSDR P210 Twin',
    sourceKind: 'neptune-p210-twin' as const,
    neptuneP210Twin: {
      endpoint: 'ip:127.0.0.1',
      profile: 'qemu-development' as const,
      physicalRfModeled: false as const,
    },
  };
}

function neptuneP210Provenance(endpoint = 'ip:10.0.0.250') {
  return {
    sourceKind: 'neptune-p210' as const,
    execution: 'physical' as const,
    transport: 'libiio-network' as const,
    qualification: 'device-observed' as const,
    verifiedAt: '2026-07-14T18:00:00.000Z',
    endpoint,
  };
}

function neptuneP210TwinProvenance(endpoint = 'ip:127.0.0.1') {
  return {
    sourceKind: 'neptune-p210-twin' as const,
    execution: 'firmware-executed-twin' as const,
    transport: 'libiio-network' as const,
    qualification: 'firmware-executed-twin' as const,
    verifiedAt: '2026-07-14T18:00:00.000Z',
    endpoint,
    profile: 'qemu-development' as const,
    physicalRfModeled: false as const,
  };
}

function neptuneComplexIqCapabilities() {
  return {
    schemaVersion: 1 as const,
    acquisitions: [{
      kind: 'complex-iq' as const,
      centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000 },
      sampleRateHz: { min: 520_833, max: 61_440_000 },
      bandwidthHz: { min: 200_000, max: 56_000_000 },
      sampleCount: { min: 1, max: 1_048_576 },
      sampleFormat: 'cf32le' as const,
    }],
    features: [] as const,
  };
}

function neptuneP210Snapshot() {
  const candidate = { ...neptuneP210Candidate(), discoveryRevision: 'discovery:neptune-p210' };
  return {
    sessionId: 'session:neptune-p210',
    driverId: candidate.driverId,
    candidate,
    provenance: neptuneP210Provenance(candidate.neptuneP210.endpoint),
    capabilities: neptuneComplexIqCapabilities(),
    rfOutput: 'not-supported' as const,
    rfOutputQualification: 'not-applicable' as const,
  };
}

function neptuneP210TwinSnapshot() {
  const candidate = { ...neptuneP210TwinCandidate(), discoveryRevision: 'discovery:neptune-p210-twin' };
  return {
    sessionId: 'session:neptune-p210-twin',
    driverId: candidate.driverId,
    candidate,
    provenance: neptuneP210TwinProvenance(candidate.neptuneP210Twin.endpoint),
    capabilities: neptuneComplexIqCapabilities(),
    rfOutput: 'not-supported' as const,
    rfOutputQualification: 'not-applicable' as const,
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
      contractVersion: 2 as const,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorContractBindingSha256: 'c'.repeat(64),
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
      }, {
        kind: 'complex-iq' as const,
        centerFrequencyHz: { min: 1, max: 1_000, step: 1 },
        sampleRateHz: { min: 1, max: 1_000, step: 1 },
        bandwidthHz: { min: 1, max: 1_000, step: 1 },
        bandwidthMode: 'independent' as const,
        sampleCount: { min: 1, max: 1_024, step: 1 },
        sampleFormat: 'cf32le' as const,
      }],
      features: [{
        kind: 'signal-lab-profile-selection' as const,
        profiles: [fixtureVisualProfile('fm', 100, 200, 200)],
        selectedProfileId: 'fm',
        channel: {
          model: 'awgn' as const,
          noiseFloorDbm: -108,
          seed: 407,
          fadingRateHz: 2,
          receiverImpairment: 'clean' as const,
        },
        iqProfiles: [{
          profileId: 'fm',
          nativeSampleRateHz: null,
          signalBandwidthHz: 200,
          profileReferenceCenterHz: 100,
          nativeCarrierOffsetHz: 0,
          nativeMinimumCaptureBandwidthHz: null,
          replay: 'continuous' as const,
          derivedTransportSupported: false,
        }],
      }],
    },
    rfOutput: 'not-supported' as const,
    rfOutputQualification: 'not-applicable' as const,
  };
}

function fixtureVisualProfile(
  profileId: string,
  centerFrequencyHz: number,
  occupiedBandwidthHz: number,
  recommendedSpanHz: number,
) {
  return {
    profileId,
    label: profileId.toUpperCase(),
    family: 'tone' as const,
    model: 'deterministic-fixture',
    qualification: 'visual' as const,
    centerFrequencyHz,
    occupiedBandwidthHz,
    recommendedSpanHz,
    projection: {
      allocation: 'carrier' as const,
      modulation: 'unmodulated' as const,
      timing: 'continuous' as const,
    },
    source: {
      organization: 'TinySA SignalLab' as const,
      references: [{
        specification: 'SignalLab fixture',
        clause: profileId,
        revision: '1',
        url: `https://example.test/signal-lab/${encodeURIComponent(profileId)}`,
      }],
    },
    governance: fixtureGovernance(profileId, 'TinySA SignalLab'),
    disclosure: 'Deterministic mathematical fixture profile.',
  };
}

function fixtureGovernance(profileId: string, organization: '3GPP' | 'TinySA SignalLab') {
  const standardsDerived = organization === '3GPP';
  return {
    schemaVersion: 1 as const,
    profileId,
    signalKind: standardsDerived
      ? 'standards-derived-engineering-profile' as const
      : 'mathematical-lab-reference' as const,
    governingOrganizations: [organization],
    governingBodies: [{
      organization,
      technicalBody: standardsDerived ? '3GPP TSG RAN' as const : 'TinySA SignalLab project' as const,
      authorityScope: standardsDerived
        ? 'LTE waveform definition and test-model configuration.'
        : 'Deterministic mathematical laboratory reference.',
    }],
    normativeReferences: standardsDerived ? [{
      organization: '3GPP' as const,
      documentId: '3GPP TS 36.141',
      revision: 'Release 18',
      clauses: ['6.1'],
      url: 'https://www.3gpp.org/dynareport/36141.htm',
    }] : [],
    applicability: {
      status: standardsDerived ? 'applicable' as const : 'not-applicable' as const,
      reason: standardsDerived
        ? 'The engineering projection is governed by the cited LTE test-model specification.'
        : 'A mathematical tone has no external radio-standard applicability.',
    },
    implementedQualificationState: standardsDerived
      ? 'standards-derived-engineering-projection' as const
      : 'mathematical-reference' as const,
    testedClaimScope: {
      kind: standardsDerived
        ? 'deterministic-engineering-projection' as const
        : 'deterministic-mathematical-reference' as const,
      statement: 'Fixture verifies the declared deterministic SignalLab profile boundary.',
      testLocations: ['src/instrument.test.ts'],
    },
    claims: {
      standardsCompliance: 'not-claimed' as const,
      digitalStandardsAdherence: standardsDerived ? 'not-verified' as const : 'not-applicable' as const,
      digitalQualification: 'not-qualified' as const,
      rfConformance: 'not-qualified' as const,
    },
    digitalQualificationEvidence: null,
    qualificationBlockers: ['Fixture carries no independent digital-baseband qualification evidence.'],
    reason: 'Contract fixture declares only its directly tested deterministic scope.',
  };
}

function safetyReceipt(
  sequence: number,
  reason: 'connection-first-command' | 'analyzer-configuration' | 'pre-acquisition' | 'post-interaction-recovery' | 'disconnect',
  sessionId = '50000000-0000-4000-8000-000000000001',
) {
  return {
    schemaVersion: 1 as const,
    receiptId: `60000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`,
    sessionId,
    command: 'output off' as const,
    reason,
    outputState: 'off' as const,
    acknowledgement: 'empty-reply-acknowledged' as const,
    qualification: 'device-command-acknowledged-not-rf-measured' as const,
    sequence,
    acknowledgedAt: `2026-07-14T18:00:${sequence.toString().padStart(2, '0')}.000Z`,
  };
}
