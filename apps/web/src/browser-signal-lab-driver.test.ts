// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AtomizerInstrumentEvent, InstrumentCandidate } from '@tinysa/contracts';
import { BrowserSignalLabWorkerDriver, type SignalLabWorkerPort } from './browser-signal-lab-driver.js';
import type { SignalLabWorkerMessage, SignalLabWorkerRequest } from './signal-lab-worker-protocol.js';
import { installSignalLabWorkerEndpoint, type SignalLabWorkerScope } from './signal-lab-worker-runtime.js';
import { createBrowserInstrumentApi } from './web-bridge.js';

const SYNTHETIC_CONTROLS = {
  schemaVersion: 1,
  model: 'synthetic-scalar',
  timingQualification: 'simulation-exact',
} as const;

class LoopbackSignalLabWorker implements SignalLabWorkerPort {
  onmessage: ((event: MessageEvent<SignalLabWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly transferredByteLengths: number[] = [];
  terminateCalls = 0;
  #terminated = false;
  #failNextMethod: SignalLabWorkerRequest['method'] | undefined;
  readonly #scope: SignalLabWorkerScope;

  constructor() {
    this.#scope = {
      onmessage: null,
      postMessage: (message, transfer = []) => {
        if (this.#terminated) return;
        for (const item of transfer) {
          if (item instanceof ArrayBuffer) this.transferredByteLengths.push(item.byteLength);
        }
        const delivered = structuredClone(message, { transfer: [...transfer] });
        queueMicrotask(() => this.onmessage?.({ data: delivered } as MessageEvent<SignalLabWorkerMessage>));
      },
    };
    installSignalLabWorkerEndpoint(this.#scope);
  }

  postMessage(message: SignalLabWorkerRequest, transfer: readonly Transferable[] = []): void {
    if (this.#terminated) throw new Error('Loopback SignalLab worker is terminated');
    if (this.#failNextMethod === message.method) {
      this.#failNextMethod = undefined;
      queueMicrotask(() => this.emitError(`SignalLab worker failed during ${message.method}`));
      return;
    }
    const delivered = structuredClone(message, { transfer: [...transfer] });
    queueMicrotask(() => this.#scope.onmessage?.({ data: delivered }));
  }

  terminate(): void {
    this.terminateCalls++;
    this.#terminated = true;
  }

  failNextRequest(method: SignalLabWorkerRequest['method']): void {
    this.#failNextMethod = method;
  }

  emitError(message = 'SignalLab worker failed'): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

describe('BrowserSignalLabWorkerDriver', () => {
  it('refreshes session state and transfers I/Q bytes while manual acquisition emits no duplicate measurement event', async () => {
    const worker = new LoopbackSignalLabWorker();
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => worker));
    const events: AtomizerInstrumentEvent[] = [];
    api.subscribe((event) => events.push(event));

    const discovery = await api.discover();
    const candidate: InstrumentCandidate = discovery.candidates[0]!;
    await api.connect(candidate);
    const execution = await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'nr-n78-tdd-100m',
    });
    const feature = execution.session.capabilities.features.find((entry) => entry.kind === 'signal-lab-profile-selection');
    expect(feature?.kind === 'signal-lab-profile-selection' ? feature.selectedProfileId : undefined).toBe('nr-n78-tdd-100m');
    if (execution.session.provenance.sourceKind !== 'signal-lab') throw new Error('Expected SignalLab provenance');
    expect(execution.session.provenance.producerConfigurationEpoch).toBe(
      execution.result.kind === 'signal-lab-profile-selection'
        ? execution.result.producerConfigurationEpoch
        : undefined,
    );

    await api.configure({
      kind: 'complex-iq',
      centerHz: 3_500_000_000,
      sampleRateHz: 2_000_000,
      bandwidthHz: 1_500_000,
      sampleCount: 1_024,
      sampleFormat: 'cf32le',
    });
    const measurement = await api.acquire();
    expect(measurement.kind).toBe('complex-iq');
    if (measurement.kind !== 'complex-iq') throw new Error('Expected complex-I/Q measurement');
    expect(measurement.samples.byteLength).toBe(1_024 * 8);
    expect(worker.transferredByteLengths).toContain(1_024 * 8);
    expect(events.filter((event) => event.type === 'measurement')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'status').map((event) => event.type === 'status' ? event.status : undefined))
      .toEqual(expect.arrayContaining(['busy', 'ready']));

    await api.disconnect();
  });

  it('keeps continuous scalar acquisition event-driven across the worker boundary', async () => {
    const worker = new LoopbackSignalLabWorker();
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => worker));
    const events: AtomizerInstrumentEvent[] = [];
    api.subscribe((event) => events.push(event));
    const candidate = (await api.discover()).candidates[0]!;
    await api.connect(candidate);
    await api.configure({
      kind: 'swept-spectrum',
      startHz: 88_000_000,
      stopHz: 108_000_000,
      points: 64,
      sweepTimeSeconds: 0.05,
      controls: SYNTHETIC_CONTROLS,
    });

    await api.startStreaming();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for worker-backed stream')), 2_000);
      const poll = () => {
        if (events.some((event) => event.type === 'measurement')) {
          clearTimeout(timeout);
          resolve();
        } else setTimeout(poll, 5);
      };
      poll();
    });
    await api.stopStreaming();

    expect(events.filter((event) => event.type === 'measurement')).toHaveLength(1);
    await api.disconnect();
  });

  it('restarts a sessionless Worker after onerror interrupts discovery', async () => {
    const workers: LoopbackSignalLabWorker[] = [];
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => {
      const worker = new LoopbackSignalLabWorker();
      workers.push(worker);
      return worker;
    }));
    workers[0]!.failNextRequest('discover');

    const failed = await api.discover();
    expect(failed.candidates).toHaveLength(0);
    expect(failed.failures).toEqual([
      expect.objectContaining({ driverId: 'signal-lab', code: 'driver-failure' }),
    ]);
    expect(workers[0]!.terminateCalls).toBe(1);

    const recovered = await api.discover();
    expect(workers).toHaveLength(2);
    expect(recovered.candidates).toHaveLength(1);
    expect(recovered.failures).toHaveLength(0);
  });

  it('tears down a connected session locally after Worker onerror and reconnects with a fresh Worker', async () => {
    const workers: LoopbackSignalLabWorker[] = [];
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => {
      const worker = new LoopbackSignalLabWorker();
      workers.push(worker);
      return worker;
    }));
    const candidate = (await api.discover()).candidates[0]!;
    await api.connect(candidate);

    workers[0]!.emitError('connected worker crashed');

    expect(workers[0]!.terminateCalls).toBe(1);
    await expect(api.disconnect()).resolves.toBeUndefined();
    const disconnected = await api.getState();
    expect(disconnected.session).toBeUndefined();
    expect(disconnected.connectionCleanup).toEqual({ status: 'not-required' });
    await expect(api.disconnect()).resolves.toBeUndefined();

    const restartedCandidate = (await api.discover()).candidates[0]!;
    expect(workers).toHaveLength(2);
    await expect(api.connect(restartedCandidate)).resolves.toMatchObject({ candidate: restartedCandidate });
    await api.disconnect();
  });

  it('cleans up a pending connect locally after Worker onerror and reconnects with a fresh Worker', async () => {
    const workers: LoopbackSignalLabWorker[] = [];
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => {
      const worker = new LoopbackSignalLabWorker();
      workers.push(worker);
      return worker;
    }));
    const candidate = (await api.discover()).candidates[0]!;
    workers[0]!.failNextRequest('connect');

    await expect(api.connect(candidate)).rejects.toThrow(/SignalLab worker failed during connect/);
    expect(workers[0]!.terminateCalls).toBe(1);
    const failedConnection = await api.getState();
    expect(failedConnection.session).toBeUndefined();
    expect(failedConnection.connectionCleanup).toEqual({ status: 'not-required' });
    await expect(api.disconnect()).resolves.toBeUndefined();

    const restartedCandidate = (await api.discover()).candidates[0]!;
    expect(workers).toHaveLength(2);
    await expect(api.connect(restartedCandidate)).resolves.toMatchObject({ candidate: restartedCandidate });
    await api.disconnect();
  });
});
