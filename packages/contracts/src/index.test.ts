import { describe, expect, it } from 'vitest';
import { analyzerConfigSchema, dBm, hertz, microseconds, modelPackageManifestSchema, signalDetectionConfigSchema } from './index.js';

describe('domain units and validation', () => {
  it('accepts exact integer frequencies', () => expect(hertz(7_300_000_000)).toBe(7_300_000_000));
  it('rejects fractional frequencies', () => expect(() => hertz(1.5)).toThrow(RangeError));
  it('rejects invalid duration and level', () => {
    expect(() => microseconds(-1)).toThrow(RangeError);
    expect(() => dBm(Number.NaN)).toThrow(RangeError);
  });
  it('requires an ordered analyzer range', () => {
    expect(analyzerConfigSchema.safeParse({ startHz: 2, stopHz: 1 }).success).toBe(false);
    expect(analyzerConfigSchema.parse({ startHz: 100_000, stopHz: 900_000_000 }).points).toBe(450);
  });
  it('bounds detector configuration and model package hashes', () => {
    expect(signalDetectionConfigSchema.safeParse({ threshold:{strategy:'noise-relative',marginDb:-1},minimumBandwidthHz:0,minimumConsecutiveSweeps:1 }).success).toBe(false);
    expect(modelPackageManifestSchema.safeParse({ schemaVersion:1,modelId:'m',version:'1',assetSha256:'not-a-hash' }).success).toBe(false);
  });
});
