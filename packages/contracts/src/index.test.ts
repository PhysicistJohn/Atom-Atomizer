import { describe, expect, it } from 'vitest';
import {
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
  dBm,
  envelopeStftConfigurationSchema,
  firmwareUpdatePreflightSchema,
  firmwareUpdateStateSchema,
  generatorConfigSchema,
  hertz,
  markerConfigurationSchema,
  microseconds,
  modelPackageManifestSchema,
  OEM_ZS407_FIRMWARE_RELEASE,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  portCandidateSchema,
  signalDetectionConfigSchema,
  traceBankConfigurationSchema,
  waterfallConfigurationSchema,
} from './index.js';

const analyzer = {
  startHz: 100_000,
  stopHz: 900_000_000,
  points: 450,
  acquisitionFormat: 'text',
  rbwKhz: 'auto',
  attenuationDb: 'auto',
  sweepTimeSeconds: 'auto',
  detector: 'sample',
  spurRejection: 'auto',
  lna: 'off',
  avoidSpurs: 'auto',
  trigger: { mode: 'auto' },
} as const;

describe('domain units and firmware-derived validation', () => {
  it('accepts exact integer frequencies', () => expect(hertz(17_922_600_000)).toBe(17_922_600_000));
  it('rejects fractional frequencies', () => expect(() => hertz(1.5)).toThrow(RangeError));
  it('rejects invalid duration and level', () => {
    expect(() => microseconds(-1)).toThrow(RangeError);
    expect(() => dBm(Number.NaN)).toThrow(RangeError);
  });
  it('requires a complete, ordered analyzer request', () => {
    expect(analyzerConfigSchema.parse(analyzer)).toEqual(analyzer);
    expect(analyzerConfigSchema.safeParse({ ...analyzer, stopHz: 1 }).success).toBe(false);
    expect(analyzerConfigSchema.safeParse({ ...analyzer, points: 451 }).success).toBe(false);
    expect(analyzerConfigSchema.safeParse({ ...analyzer, rbwKhz: 851 }).success).toBe(false);
  });
  it('enforces ZS407 FM and output-path limits', () => {
    const base = { frequencyHz: 100_000_000, levelDbm: -30, path: 'mixer', modulation: 'fm', modulationFrequencyHz: 3_500, amDepthPercent: 80, fmDeviationHz: 3_000 } as const;
    expect(generatorConfigSchema.safeParse(base).success).toBe(true);
    expect(generatorConfigSchema.safeParse({ ...base, modulationFrequencyHz: 3_501 }).success).toBe(false);
    expect(generatorConfigSchema.safeParse({ ...base, path: 'normal', frequencyHz: 6_300_000_001 }).success).toBe(false);
  });
  it('requires exact USB candidate and detector schemas', () => {
    expect(portCandidateSchema.safeParse({ id: 'x', path: '/dev/x', usbMatch: 'unverified-serial', transport: 'usb-cdc-acm', execution: 'physical' }).success).toBe(true);
    expect(portCandidateSchema.safeParse({ id: 'x', path: '/dev/x', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical' }).success).toBe(true);
    expect(portCandidateSchema.safeParse({ id: 'x', path: '/dev/x', usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical' }).success).toBe(false);
    expect(portCandidateSchema.safeParse({ id: 'x', path: 'fake://x', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' }).success).toBe(true);
    expect(portCandidateSchema.safeParse({ id: 'x', path: 'fake://x', usbMatch: 'exact-zs407-cdc', transport: 'protocol-test-double', execution: 'protocol-test-double' }).success).toBe(false);
    expect(portCandidateSchema.safeParse({ id: 'x', path: '/dev/x', usbMatch: 'guessed', transport: 'usb-cdc-acm', execution: 'physical' }).success).toBe(false);
    expect(signalDetectionConfigSchema.safeParse({ threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 2, releaseAfterMissedSweeps: 2 }).success).toBe(true);
    expect(signalDetectionConfigSchema.safeParse({ threshold: { strategy: 'noise-relative', marginDb: -1 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 0 }).success).toBe(false);
  });
  it('rejects malformed model package hashes', () => {
    expect(modelPackageManifestSchema.safeParse({ schemaVersion: 1, modelId: 'm', version: '1', assetSha256: 'not-a-hash' }).success).toBe(false);
  });
  it('closes trace and marker contracts', () => {
    expect(traceBankConfigurationSchema.safeParse([
      { id: 1, mode: 'clear-write', averageCount: 8 }, { id: 2, mode: 'max-hold', averageCount: 8 },
      { id: 3, mode: 'average', averageCount: 16 }, { id: 4, mode: 'blank', averageCount: 8 },
    ]).success).toBe(true);
    expect(traceBankConfigurationSchema.safeParse(Array(4).fill({ id: 1, mode: 'blank', averageCount: 8 })).success).toBe(false);
    expect(markerConfigurationSchema.safeParse({ id: 2, enabled: true, traceId: 1, mode: 'delta', frequencyHz: 100_000_000, tracking: 'fixed' }).success).toBe(false);
  });
  it('closes advanced swept-measurement configuration and rejects silent ambiguity', () => {
    expect(waterfallConfigurationSchema.safeParse({ historyDepth: 35, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' }).success).toBe(true);
    expect(waterfallConfigurationSchema.safeParse({ historyDepth: 51, floorDbm: -20, ceilingDbm: -120, palette: 'thermal' }).success).toBe(false);
    const channel = { centerHz: 98_000_000, mainBandwidthHz: 200_000, adjacentBandwidthHz: 200_000, channelSpacingHz: 200_000, adjacentChannelCount: 2, occupiedPowerPercent: 99, obwNoiseCorrection: 'none' } as const;
    expect(channelMeasurementConfigurationSchema.safeParse(channel).success).toBe(true);
    expect(channelMeasurementConfigurationSchema.safeParse({ ...channel, channelSpacingHz: 100_000 }).success).toBe(false);
    expect(envelopeStftConfigurationSchema.safeParse({ windowSize: 64, hopSize: 16, window: 'hann', removeDc: true, dynamicRangeDb: 80 }).success).toBe(true);
    expect(envelopeStftConfigurationSchema.safeParse({ windowSize: 64, hopSize: 65, window: 'hann', removeDc: true, dynamicRangeDb: 80 }).success).toBe(false);
  });
  it('rejects impossible firmware write dispositions', () => {
    const idle = {
      phase: 'idle', target: OEM_ZS407_FIRMWARE_RELEASE, updateAvailable: false,
      dfuUtility: { available: false }, dfuDevice: { detected: false, count: 0 }, writeDisposition: 'not-started',
    } as const;
    expect(firmwareUpdateStateSchema.safeParse(idle).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse({ ...idle, phase: 'flashing' }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({ ...idle, writeDisposition: 'started' }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({ ...idle, phase: 'completed', writeDisposition: 'completed', writeStartedAt: 't1', writeCompletedAt: 't2' }).success).toBe(false);
    const flashing = {
      ...idle, phase: 'flashing', writeDisposition: 'started', writeStartedAt: '2026-07-11T22:00:01.000Z',
      flashProgress: { stage: 'writing', percent: 67, stagePercent: 49, updatedAt: '2026-07-11T22:00:20.000Z' },
    } as const;
    expect(firmwareUpdateStateSchema.safeParse(flashing).success).toBe(true);
    expect(firmwareUpdateStateSchema.safeParse({ ...flashing, flashProgress: { ...flashing.flashProgress, percent: 101 } }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({ ...flashing, flashProgress: { ...flashing.flashProgress, stage: 'verifying-reboot' } }).success).toBe(false);
    expect(firmwareUpdateStateSchema.safeParse({ ...idle, flashProgress: flashing.flashProgress }).success).toBe(false);
  });
  it('binds firmware preflight to the exact ZS407 CAL-to-RF self-test procedure', () => {
    const preflight = {
      selfTestPassed: true,
      selfTestProcedure: OEM_ZS407_SELF_TEST_PROCEDURE.id,
      configurationDisposition: 'new-device-unchanged',
      rfPortsDisconnected: true,
    } as const;
    expect(firmwareUpdatePreflightSchema.safeParse(preflight).success).toBe(true);
    expect(firmwareUpdatePreflightSchema.safeParse({ ...preflight, selfTestProcedure: 'generic-low-high' }).success).toBe(false);
  });
});
