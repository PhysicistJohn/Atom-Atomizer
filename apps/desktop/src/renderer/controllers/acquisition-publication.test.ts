// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentAcquisitionCapability, InstrumentSessionSnapshot, Sweep } from '@tinysa/contracts';
import { createRendererRuntime } from '../AppShell.js';
import { sweptSpectrumConfigurationFor } from '../instrument-configuration.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('sweep evidence publication', () => {
  it('commits sweep, history, traces, and detections in one subscriber notification', () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    const capability: Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }> = {
      kind: 'swept-spectrum',
      frequencyHz: { min: 0, max: 17_922_600_000 },
      points: { min: 20, max: 450 },
      sweepTimeSeconds: {
        automatic: true,
        manualSeconds: { min: 0.003, max: 60, step: 0.000_001 },
      },
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormats: ['text', 'raw'],
        resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
        attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
        detectors: ['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak'],
        spurRejection: ['off', 'on', 'auto'],
        lowNoiseAmplifier: ['off', 'on'],
        avoidSpurs: ['off', 'on', 'auto'],
        triggerModes: ['auto', 'normal', 'single'],
        triggerLevelDbm: { min: -174, max: 30 },
      },
      powerUnit: 'dBm',
    };
    const session = {
      capabilities: { acquisitions: [capability], features: [] },
    } as unknown as InstrumentSessionSnapshot;
    runtime.store.set({
      instrument: { ...runtime.store.get().instrument, session },
    });
    vi.spyOn(runtime.kernel.traceAccumulator.current, 'update').mockReturnValue([]);
    vi.spyOn(runtime.kernel.detector.current, 'analyze').mockReturnValue([]);
    vi.spyOn(runtime.kernel.tracker.current, 'update').mockReturnValue([]);

    const frequencyHz = Array.from({ length: 450 }, (_, index) => 88_000_000 + index * (20_000_000 / 449));
    const sweep: Sweep = {
      kind: 'spectrum',
      id: 'batched-sweep',
      sequence: 1,
      capturedAt: '2026-07-22T00:00:00.000Z',
      elapsedMilliseconds: 20,
      frequencyHz,
      powerDbm: frequencyHz.map((_, index) => index === 225 ? -50 : -100),
      requested: sweptSpectrumConfigurationFor(capability, runtime.store.get().analyzer),
      actualStartHz: frequencyHz[0]!,
      actualStopHz: frequencyHz.at(-1)!,
      actualRbwHz: 10_000,
      actualAttenuationDb: 0,
      source: 'scan-text',
      complete: true,
      identity: {
        model: 'test',
        hardwareVersion: 'test',
        firmwareVersion: 'test',
        firmwareQualification: 'protocol-test',
        port: {
          id: 'batch-test',
          path: 'test://batch',
          usbMatch: 'protocol-test-double',
          transport: 'protocol-test-double',
          execution: 'protocol-test-double',
        },
        simulated: true,
        usbIdentityVerified: false,
        execution: 'protocol-test-double',
      },
    };
    let notifications = 0;
    const unsubscribe = runtime.store.subscribe(() => { notifications++; });

    expect(runtime.acquisition.recordSweepEvidence(sweep, 'configuration-test')).toBe(true);

    unsubscribe();
    expect(notifications).toBe(1);
    expect(runtime.store.get()).toMatchObject({
      sweep,
      history: [sweep],
      traceFrames: [],
      detections: [],
    });

    const failedSweep: Sweep = {
      ...sweep,
      id: 'analysis-failed-sweep',
      sequence: 2,
      capturedAt: '2026-07-22T00:00:01.000Z',
    };
    notifications = 0;
    const failedUnsubscribe = runtime.store.subscribe(() => { notifications++; });
    vi.mocked(runtime.kernel.detector.current.analyze).mockImplementationOnce(() => {
      throw new Error('detector failed');
    });

    expect(() => runtime.acquisition.recordSweepEvidence(failedSweep, 'configuration-test')).toThrow('detector failed');

    failedUnsubscribe();
    expect(notifications).toBe(1);
    expect(runtime.store.get()).toMatchObject({
      sweep: failedSweep,
      history: [failedSweep, sweep],
      traceFrames: [],
      detections: [],
    });
  });
});
