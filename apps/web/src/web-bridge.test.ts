// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { instrumentMeasurementSchema, instrumentSessionSnapshotSchema } from '@tinysa/contracts';
import { BrowserInstrumentBridge } from './web-bridge.js';

describe('Atomizer browser bridge', () => {
  it('discovers, connects, configures, and acquires a contract-valid SignalLab sweep', async () => {
    const bridge = new BrowserInstrumentBridge();
    const discovery = await bridge.discover();
    const session = await bridge.connect(discovery.candidates[0]!);
    expect(instrumentSessionSnapshotSchema.parse(session).candidate.sourceKind).toBe('signal-lab');
    const signalLab = session.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    expect(signalLab?.profiles.length).toBeGreaterThan(10);
    expect(signalLab?.profiles[0]).toEqual(expect.objectContaining({ profileId: 'cw', label: expect.any(String) }));
    expect(signalLab?.channel).toEqual(expect.objectContaining({ model: 'awgn' }));
    await bridge.configure({
      kind: 'swept-spectrum',
      startHz: 88_000_000,
      stopHz: 108_000_000,
      points: 450,
      sweepTimeSeconds: 0.05,
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
    });
    const measurement = instrumentMeasurementSchema.parse(await bridge.acquire());
    expect(measurement.kind).toBe('swept-spectrum');
    if (measurement.kind === 'swept-spectrum') {
      expect(measurement.frequencyHz).toHaveLength(450);
      expect(Math.max(...measurement.powerDbm)).toBeGreaterThan(-80);
    }
  });
});
