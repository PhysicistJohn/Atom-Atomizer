import { describe, expect, it } from 'vitest';
import {
  analyzerConfigSchema,
  dBm,
  generatorConfigSchema,
  hertz,
  markerConfigurationSchema,
  microseconds,
  modelPackageManifestSchema,
  portCandidateSchema,
  replayChannelConfigurationSchema,
  signalDetectionConfigSchema,
  synthesizedSignalProfileSchema,
  traceBankConfigurationSchema,
  waveformDescriptorSchema,
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
    expect(portCandidateSchema.safeParse({ id: 'x', path: '/dev/x', usbMatch: 'unverified-serial' }).success).toBe(true);
    expect(portCandidateSchema.safeParse({ id: 'x', path: '/dev/x', usbMatch: 'guessed' }).success).toBe(false);
    expect(signalDetectionConfigSchema.safeParse({ threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 2, releaseAfterMissedSweeps: 2 }).success).toBe(true);
    expect(signalDetectionConfigSchema.safeParse({ threshold: { strategy: 'noise-relative', marginDb: -1 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 0 }).success).toBe(false);
  });
  it('rejects malformed model package hashes', () => {
    expect(modelPackageManifestSchema.safeParse({ schemaVersion: 1, modelId: 'm', version: '1', assetSha256: 'not-a-hash' }).success).toBe(false);
  });
  it('closes the Signal Lab profile vocabulary', () => {
    expect(synthesizedSignalProfileSchema.options).toEqual(['cw', 'am', 'fm', 'gsm-normal-burst', 'lte-etm1.1', 'nr-fr1-tm1.1', 'wifi6-he-su']);
    expect(synthesizedSignalProfileSchema.safeParse('wifi').success).toBe(false);
  });
  it('closes trace, marker, and replay-channel contracts', () => {
    expect(traceBankConfigurationSchema.safeParse([
      { id: 1, mode: 'clear-write', averageCount: 8 }, { id: 2, mode: 'max-hold', averageCount: 8 },
      { id: 3, mode: 'average', averageCount: 16 }, { id: 4, mode: 'blank', averageCount: 8 },
    ]).success).toBe(true);
    expect(traceBankConfigurationSchema.safeParse(Array(4).fill({ id: 1, mode: 'blank', averageCount: 8 })).success).toBe(false);
    expect(markerConfigurationSchema.safeParse({ id: 2, enabled: true, traceId: 1, mode: 'delta', frequencyHz: 100_000_000, tracking: 'fixed' }).success).toBe(false);
    expect(replayChannelConfigurationSchema.safeParse({ model: 'rayleigh', noiseFloorDbm: -108, seed: 407, fadingRateHz: 2 }).success).toBe(true);
  });
  it('requires hashed evidence before a waveform can claim conformance validation', () => {
    const descriptor = { id: 'lte-etm1.1', label: 'LTE', family: 'e-utra', model: 'E-TM1.1', qualification: 'conformance-validated', centerHz: 1_840_000_000, occupiedBandwidthHz: 18_000_000, recommendedSpanHz: 30_000_000, standard: { organization: '3GPP', specification: 'TS 36.141', clause: '6.1.1', revision: '13.11.0', url: 'https://www.3gpp.org/' }, disclosure: 'Validated asset.' };
    expect(waveformDescriptorSchema.safeParse(descriptor).success).toBe(false);
    expect(waveformDescriptorSchema.safeParse({ ...descriptor, assetSha256: 'a'.repeat(64) }).success).toBe(true);
  });
});
