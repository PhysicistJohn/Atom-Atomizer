// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InstrumentConfigurationState,
  InstrumentConfiguration,
  InstrumentSessionSnapshot,
  SweptSpectrumConfiguration,
} from '@tinysa/contracts';
import type { ComplexIqMeasurement } from '../complex-iq.js';
import { createRendererRuntime } from '../AppShell.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const spectrum: SweptSpectrumConfiguration = {
  kind: 'swept-spectrum',
  startHz: 88_000_000,
  stopHz: 108_000_000,
  points: 20,
  sweepTimeSeconds: 0.05,
  controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
};

const complexIq: InstrumentConfiguration = {
  kind: 'complex-iq',
  centerHz: 100_000_000,
  sampleRateHz: 2_000_000,
  bandwidthHz: 1_500_000,
  sampleCount: 4_096,
  sampleFormat: 'cf32le',
};

function activeConfiguration(configuration: InstrumentConfiguration = spectrum): InstrumentConfigurationState {
  return {
    sessionId: 'canonical-session',
    configurationRevision: 'configuration:canonical',
    configuration,
    configuredAt: '2026-08-01T00:00:00.000Z',
  };
}

function installSession(
  runtime: ReturnType<typeof createRendererRuntime>,
  configuration?: InstrumentConfigurationState,
): void {
  runtime.store.set({
    instrument: {
      ...runtime.store.get().instrument,
      session: {
        sessionId: 'canonical-session',
        capabilities: { acquisitions: [], features: [] },
        ...(configuration === undefined ? {} : { configuration }),
      } as unknown as InstrumentSessionSnapshot,
    },
  });
}

describe('canonical acquisition routing', () => {
  it('uses the active admitted spectrum configuration for Single without issuing a renderer configure', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    const configured = activeConfiguration();
    installSession(runtime, configured);
    const acquireConfigured = vi.spyOn(runtime.acquisition, 'acquireConfiguredSpectrum')
      .mockResolvedValue({ id: 'sweep:canonical' } as never);
    vi.spyOn(runtime.acquisition, 'recordSweepEvidence').mockReturnValue(true);
    const configure = vi.fn();
    vi.stubGlobal('atomizerInstrument', { configure });

    await runtime.acquisition.acquire();

    expect(acquireConfigured).toHaveBeenCalledWith(configured);
    expect(configure).not.toHaveBeenCalled();
    expect(runtime.kernel.configurationRevisions.current.read(configured.configurationRevision))
      .toEqual({ kind: 'swept-spectrum', admitted: spectrum });
    runtime.classification.dispose();
  });

  it('chooses the admitted configuration kind instead of inferring a combined capture from capabilities', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    const configuration = activeConfiguration({
      kind: 'complex-iq',
      centerHz: 100_000_000,
      sampleRateHz: 2_000_000,
      bandwidthHz: 1_500_000,
      sampleCount: 4_096,
      sampleFormat: 'cf32le',
    });
    installSession(runtime, configuration);
    const acquireIq = vi.spyOn(runtime.acquisition, 'acquireIq').mockResolvedValue({ measurementId: 'iq:canonical' } as never);
    const acquireSpectrum = vi.spyOn(runtime.acquisition, 'acquire').mockResolvedValue({ id: 'sweep:unexpected' } as never);

    await expect(runtime.acquisition.acquireGlobalFrame()).resolves.toEqual({ iq: { measurementId: 'iq:canonical' } });

    expect(acquireIq).toHaveBeenCalledOnce();
    expect(acquireSpectrum).not.toHaveBeenCalled();
    runtime.classification.dispose();
  });

  it('starts Run with the active admitted spectrum revision without reconfiguring it', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    const configured = activeConfiguration();
    installSession(runtime, configured);
    const configure = vi.fn();
    const startStreaming = vi.fn().mockResolvedValue({ status: 'running' });
    const stopStreaming = vi.fn().mockResolvedValue({ status: 'stopped' });
    vi.stubGlobal('atomizerInstrument', { configure, startStreaming, stopStreaming });

    await runtime.acquisition.startContinuous();

    expect(startStreaming).toHaveBeenCalledOnce();
    expect(configure).not.toHaveBeenCalled();
    expect(runtime.kernel.continuousStreamOwnership.current?.configurationRevision)
      .toBe(configured.configurationRevision);
    await runtime.acquisition.stopContinuous();
    runtime.classification.dispose();
  });

  it('gates Single and Run until a driver-admitted configuration exists', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    installSession(runtime);

    await expect(runtime.acquisition.acquire()).rejects.toThrow('Apply driver controls before acquiring');
    await expect(runtime.acquisition.startContinuous()).rejects.toThrow('Apply driver controls before acquiring');

    runtime.classification.dispose();
  });

  it('gates envelope capture on its active detected-power configuration before any renderer reconfigure', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    installSession(runtime, activeConfiguration());
    const configure = vi.fn();
    const acquire = vi.fn();
    vi.stubGlobal('atomizerInstrument', { configure, acquire });

    await expect(runtime.acquisition.acquireZeroSpan())
      .rejects.toThrow('Apply driver controls for a detected-power capture before acquiring');

    expect(configure).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    runtime.classification.dispose();
  });

  it('drops a late complete I/Q buffer after disconnect and does not start another canonical request', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'iq', initialAgentOpen: false });
    const configured = activeConfiguration(complexIq);
    installSession(runtime, configured);
    const pending = deferred<ComplexIqMeasurement>();
    const acquire = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('atomizerInstrument', { acquire });

    await runtime.acquisition.startContinuous();
    await flush();
    expect(acquire).toHaveBeenCalledOnce();
    const task = runtime.kernel.continuousIqTask.current;
    expect(task).toBeDefined();

    runtime.events.handleValidatedInstrumentEvent({
      type: 'disconnected',
      sessionId: configured.sessionId,
      driverId: 'tinysa-zs407',
    } as never);
    pending.resolve(complexIqMeasurement(configured, 'late-iq-buffer'));

    await expect(task).rejects.toThrow(/invalidated with instrument session canonical-session/);
    await flush();
    expect(acquire).toHaveBeenCalledOnce();
    expect(runtime.store.get()).toMatchObject({
      continuous: false,
      instrument: { session: undefined },
      iqCapture: undefined,
    });
    runtime.classification.dispose();
  });

  it('stops the canonical I/Q pump after its first acquisition failure without retrying', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'iq', initialAgentOpen: false });
    installSession(runtime, activeConfiguration(complexIq));
    const acquire = vi.fn().mockRejectedValue(new Error('I/Q transport failed'));
    vi.stubGlobal('atomizerInstrument', { acquire });

    await runtime.acquisition.startContinuous();
    const task = runtime.kernel.continuousIqTask.current;
    expect(task).toBeDefined();
    await expect(task).rejects.toThrow('I/Q transport failed');
    await flush();

    expect(acquire).toHaveBeenCalledOnce();
    expect(runtime.store.get()).toMatchObject({
      continuous: false,
      acquisition: 'failed',
      error: 'Global analysis acquisition failed: I/Q transport failed',
    });
    runtime.classification.dispose();
  });
});

function complexIqMeasurement(
  configured: InstrumentConfigurationState,
  measurementId: string,
): ComplexIqMeasurement {
  if (configured.configuration.kind !== 'complex-iq') throw new Error('expected complex I/Q configuration');
  return {
    kind: 'complex-iq',
    measurementId,
    sessionId: configured.sessionId,
    configurationRevision: configured.configurationRevision,
    sequence: 1,
    capturedAt: '2026-08-01T00:00:01.000Z',
    elapsedMilliseconds: 2,
    centerHz: configured.configuration.centerHz,
    sampleRateHz: configured.configuration.sampleRateHz,
    bandwidthHz: configured.configuration.bandwidthHz,
    sampleCount: configured.configuration.sampleCount,
    sampleFormat: configured.configuration.sampleFormat,
    samples: new Uint8Array(configured.configuration.sampleCount * 8),
  } as ComplexIqMeasurement;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
