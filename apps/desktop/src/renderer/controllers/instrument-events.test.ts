// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { InstrumentConfigurationState, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { AtomizerStore, createInitialRendererState } from '../store.js';
import { InstrumentEventsController } from './instrument-events.js';
import { RendererKernel } from './kernel.js';

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
    contractVersion: 1,
    contractSha256: HASH,
    catalogSha256: HASH,
    generatorSha256: HASH,
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
});
