// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type {
  AtomizerInstrumentState,
  CanonicalInstrumentSurface,
  InstrumentConfigurationState,
  InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import { AtomizerStore, createInitialRendererState } from '../store.js';
import { InstrumentEventsController } from './instrument-events.js';
import { RendererKernel } from './kernel.js';
import { AcquisitionController } from './acquisition.js';
import { ConnectionController } from './connection.js';

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

  it('does not let a delayed initial state read erase a newer admitted configuration', async () => {
    const store = new AtomizerStore(createInitialRendererState({ initialWorkspace: 'spectrum', initialAgentOpen: false }));
    const kernel = new RendererKernel(store);
    kernel.acquisition = new AcquisitionController(kernel);
    kernel.connection = new ConnectionController(kernel);
    const controller = new InstrumentEventsController(kernel);
    kernel.rendererMounted.current = true;
    kernel.initializationGeneration.current = 1;
    const staleState = {
      ...store.get().instrument,
      session: SESSION,
    } as AtomizerInstrumentState;
    const admittedState = {
      ...staleState,
      session: { ...SESSION, configuration: CONFIGURATION },
    } as AtomizerInstrumentState;
    const pendingState = deferred<AtomizerInstrumentState>();
    const previous = window.atomizerInstrument;
    window.atomizerInstrument = {
      getState: vi.fn().mockReturnValue(pendingState.promise),
      discover: vi.fn().mockResolvedValue({ candidates: [], failures: [] }),
    } as unknown as typeof window.atomizerInstrument;
    try {
      const initialization = controller.initialize(1);

      controller.acceptInstrumentState(admittedState);
      pendingState.resolve(staleState);
      await initialization;

      expect(store.get().instrument.session?.configuration).toEqual(CONFIGURATION);
    } finally {
      window.atomizerInstrument = previous;
    }
  });

  it('uses only the driver-published generic surface for an Auto/manual operation', async () => {
    const store = new AtomizerStore(createInitialRendererState({ initialWorkspace: 'spectrum', initialAgentOpen: false }));
    const kernel = new RendererKernel(store);
    kernel.acquisition = new AcquisitionController(kernel);
    const controller = new InstrumentEventsController(kernel);
    store.set({ instrument: { ...store.get().instrument, session: SESSION } });
    const surface = genericCaptureSurface();
    const executeCanonicalOperation = vi.fn().mockResolvedValue({
      sessionId: SESSION.sessionId,
      operationId: 'capture',
      surface,
    });
    const previous = window.atomizerInstrument;
    window.atomizerInstrument = {
      canonicalSurface: vi.fn().mockResolvedValue(surface),
      executeCanonicalOperation,
    } as unknown as typeof window.atomizerInstrument;
    try {
      controller.refreshCanonicalSurface(SESSION.sessionId);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(store.get().canonicalSurface).toEqual(surface);

      await controller.executeCanonicalOperation(surface, 'capture', [{
        parameterId: 'capture.tune',
        intent: { mode: 'auto' },
      }]);

      expect(executeCanonicalOperation).toHaveBeenCalledWith({
        sessionId: SESSION.sessionId,
        surfaceRevision: surface.revision,
        operationId: 'capture',
        parameters: [{ parameterId: 'capture.tune', intent: { mode: 'auto' } }],
      });
      expect(store.get().canonicalSurface).toEqual(surface);
      expect(store.get().notice).toBe('Instrument operation applied');
    } finally {
      window.atomizerInstrument = previous;
    }
  });

});

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function genericCaptureSurface(): CanonicalInstrumentSurface {
  return {
    schemaVersion: 1,
    revision: 'surface-generic-capture',
    presentation: {
      title: 'Connected capture interface',
      qualification: 'DRIVER OBSERVED',
      facts: [],
    },
    parameters: [{
      id: 'capture.tune',
      label: 'Tune',
      group: 'Capture',
      unit: 'Hz',
      manual: { kind: 'integer', range: { min: 1, max: 1_000, step: 1 } },
      auto: { resolver: 'driver', description: 'Choose the driver policy.' },
      requested: { mode: 'auto' },
      effectiveValue: 100,
      verification: 'device-readback',
    }],
    operations: [{
      id: 'capture',
      label: 'Capture',
      parameterIds: ['capture.tune'],
      outputs: [],
      availability: 'available',
      primary: true,
      confirmation: 'none',
    }],
  };
}
