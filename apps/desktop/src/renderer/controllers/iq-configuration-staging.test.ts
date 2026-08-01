// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DetectedSignal,
  InstrumentAcquisitionCapability,
  InstrumentSessionSnapshot,
  Sweep,
  TraceFrame,
} from '@tinysa/contracts';
import { createRendererRuntime } from '../AppShell.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const p210IqCapability: Extract<InstrumentAcquisitionCapability, { kind: 'complex-iq' }> = {
  kind: 'complex-iq',
  centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000, step: 1 },
  sampleRateHz: { min: 2_083_334, max: 61_440_000, step: 1 },
  bandwidthHz: { min: 200_000, max: 50_000_000, step: 1 },
  sampleCount: { min: 1, max: 16_777_216, step: 1 },
  sampleFormat: 'ci16le',
};

describe('I/Q receiver-tune staging', () => {
  it('clears evidence captured at the prior tune and centers fresh channel windows on the staged tune', () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    const state = runtime.store.get();
    runtime.store.set({
      instrument: {
        ...state.instrument,
        session: {
          sessionId: 'p210-session',
          capabilities: { schemaVersion: 1, acquisitions: [p210IqCapability], features: [] },
        } as unknown as InstrumentSessionSnapshot,
      },
      sweep: { id: 'captured-at-80' } as Sweep,
      history: [{ id: 'captured-at-80' } as Sweep],
      traceFrames: [{ traceId: 1 } as TraceFrame],
      detections: [{ id: 'stale-signal' } as DetectedSignal],
      iqCapture: { centerHz: 80_000_000 } as never,
      iqConfiguration: { ...state.iqConfiguration, centerHz: 80_000_000, sampleFormat: 'ci16le' },
      channelConfiguration: { ...state.channelConfiguration, centerHz: 80_000_000 },
    });

    runtime.acquisition.stageIqConfiguration({
      ...runtime.store.get().iqConfiguration,
      centerHz: 100_000_000,
      sampleFormat: 'ci16le',
    });

    expect(runtime.store.get()).toMatchObject({
      iqConfiguration: expect.objectContaining({ centerHz: 100_000_000 }),
      iqCapture: undefined,
      sweep: undefined,
      history: [],
      traceFrames: [],
      detections: [],
      channelConfiguration: expect.objectContaining({ centerHz: 100_000_000 }),
      notice: 'Receiver tune staged at 100 MHz. Select Single or Run to acquire a fresh trace.',
    });
    runtime.classification.dispose();
  });
});
