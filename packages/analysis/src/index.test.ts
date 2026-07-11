import { describe, expect, it } from 'vitest';
import { SignalDetector, UnknownClassifier } from './index.js';
import type { Sweep } from '@tinysa/contracts';

const sweep: Sweep = {
  id: 's1', capturedAt: '2026-01-01T00:00:00.000Z', frequencyHz: [100, 200, 300, 400, 500], powerDbm: [-90, -89, -50, -51, -91],
  requested: { startHz: 100, stopHz: 500, points: 5, attenuationDb: 'auto' }, actualStartHz: 100, actualStopHz: 500,
  identity: { model: 'sim', firmwareVersion: 'sim', port: { id: 'sim', path: 'sim' } }
};
describe('analysis modes', () => {
  it('detects contiguous bins above an adaptive floor', () => {
    const results = new SignalDetector({ threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 1 }).analyze(sweep);
    expect(results).toHaveLength(1); expect(results[0]?.peakHz).toBe(300); expect(results[0]?.bandwidthHz).toBe(100);
    expect(results[0]?.detectorId).toBe('adaptive-contiguous-v1');
  });
  it('refuses to invent a waveform class without a model', async () => {
    const detection = new SignalDetector().analyze(sweep)[0]!;
    const result = await new UnknownClassifier().classify(detection);
    expect(result.label).toBe('unknown'); expect(result.unknownReason).toBe('model-unavailable');
  });
  it('fails loudly when sweep vectors are missing, mismatched, or non-finite', () => {
    const detector = new SignalDetector();
    expect(() => detector.analyze({ ...sweep, frequencyHz: [], powerDbm: [] })).toThrow(/no measurement points/i);
    expect(() => detector.analyze({ ...sweep, powerDbm: [-90] })).toThrow(/different lengths/i);
    expect(() => detector.analyze({ ...sweep, powerDbm: [-90, -89, Number.NaN, -51, -91] })).toThrow(/finite/i);
  });
});
