// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtomizerInstrumentEvent, InstrumentCandidate } from '@tinysa/contracts';
import {
  BROWSER_SIGNAL_LAB_WORKER_RESPONSE_TIMEOUT_MILLISECONDS,
  BrowserSignalLabWorkerDriver,
  type SignalLabWorkerPort,
} from './browser-signal-lab-driver.js';
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
  #throwNextMethod: SignalLabWorkerRequest['method'] | undefined;
  #silenceNextMethod: SignalLabWorkerRequest['method'] | undefined;
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
    if (this.#throwNextMethod === message.method) {
      this.#throwNextMethod = undefined;
      throw new Error(`SignalLab postMessage failed during ${message.method}`);
    }
    if (this.#failNextMethod === message.method) {
      this.#failNextMethod = undefined;
      queueMicrotask(() => this.emitError(`SignalLab worker failed during ${message.method}`));
      return;
    }
    if (this.#silenceNextMethod === message.method) {
      this.#silenceNextMethod = undefined;
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

  throwNextRequest(method: SignalLabWorkerRequest['method']): void {
    this.#throwNextMethod = method;
  }

  silenceNextRequest(method: SignalLabWorkerRequest['method']): void {
    this.#silenceNextMethod = method;
  }

  emitMessage(message: SignalLabWorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<SignalLabWorkerMessage>);
  }

  emitError(message = 'SignalLab worker failed'): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserSignalLabWorkerDriver', () => {
  it('constructs without starting browser transport and creates it lazily on discovery', async () => {
    const factory = vi.fn(() => new LoopbackSignalLabWorker());
    const driver = new BrowserSignalLabWorkerDriver(factory);

    expect(factory).not.toHaveBeenCalled();
    const discovery = await driver.discover();
    expect(factory).toHaveBeenCalledOnce();
    expect(discovery.candidates).toHaveLength(1);
  });

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
      centerHz: 3_500_010_000,
      sampleRateHz: 122_880_000,
      bandwidthHz: 100_000_000,
      sampleCount: 1_024,
      sampleFormat: 'cf32le',
    });
    const measurement = await api.acquire();
    expect(measurement.kind).toBe('complex-iq');
    if (measurement.kind !== 'complex-iq') throw new Error('Expected complex-I/Q measurement');
    expect(measurement.samples.byteLength).toBe(1_024 * 8);
    expect(measurement).toMatchObject({
      profileReferenceCenterHz: 3_500_010_000,
      rfReferenceCenterHz: 3_500_010_000,
      nativeCarrierOffsetHz: 0,
      outputCarrierOffsetHz: 0,
      rfTuneCenterHz: 3_500_010_000,
      rfPlacement: 'profile-reference',
      signalBandwidthHz: 100_000_000,
      nativeSampleRateHz: 122_880_000,
      payloadKind: 'native-canonical',
      qualification: 'independently-verified-digital-baseband',
      representation: 'source-preserved-complex-envelope',
      normalization: 'none',
      transformReceipt: {
        sourceBoundaryPolicy: 'cyclic-modular',
        sourcePeriodSamples: 2_457_600,
        sourceCarrierOffsetHz: 0,
        outputCarrierOffsetHz: 0,
        operations: [],
      },
    });
    expect(worker.transferredByteLengths).toContain(1_024 * 8);
    expect(events.filter((event) => event.type === 'measurement')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'status').map((event) => event.type === 'status' ? event.status : undefined))
      .toEqual(expect.arrayContaining(['busy', 'ready']));

    await api.disconnect();
  });

  it('preserves canonical lineage while translating RF placement and resampling for hardware transport', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'nr-n78-tdd-100m',
    });
    await api.configure({
      kind: 'complex-iq',
      centerHz: 3_450_000_000,
      sampleRateHz: 120_000_000,
      bandwidthHz: 100_000_000,
      sampleCount: 1_024,
      sampleFormat: 'cf32le',
    });
    const measurement = await api.acquire();
    if (measurement.kind !== 'complex-iq') throw new Error('Expected complex-I/Q measurement');
    expect(measurement).toMatchObject({
      centerHz: 3_450_000_000,
      profileReferenceCenterHz: 3_500_010_000,
      rfPlacement: 'operator-translated',
      qualification: 'derived-from-independently-verified-digital-baseband',
      payloadKind: 'derived-hardware-ready',
      representation: 'derived-complex-envelope',
      normalization: 'none',
    });
    expect(measurement.canonicalArtifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(measurement.transformReceipt?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'resample',
        sourceSampleRateHz: 122_880_000,
        outputSampleRateHz: 120_000_000,
      }),
    ]));
    await api.disconnect();
  });

  it('downgrades receiver-impaired buffers without losing their canonical source lineage', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'lte-etm1.1',
    });
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'configure-channel',
      channel: {
        model: 'awgn',
        noiseFloorDbm: -108,
        seed: 12_345,
        fadingRateHz: 2,
        receiverImpairment: 'iq-imbalance',
      },
    });
    await api.configure({
      kind: 'complex-iq',
      centerHz: 1_840_000_000,
      sampleRateHz: 15_360_000,
      bandwidthHz: 10_000_000,
      sampleCount: 256,
      sampleFormat: 'cf32le',
    });
    const measurement = await api.acquire();
    expect(measurement).toMatchObject({
      kind: 'complex-iq',
      qualification: 'receiver-impaired-complex-baseband',
      receiverImpairment: 'iq-imbalance',
      channelApplication: 'receiver-impairment-preset',
      canonicalArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await api.disconnect();
  });

  it('acquires every fixed governed profile at its advertised native geometry', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    const connected = await api.connect((await api.discover()).candidates[0]!);
    const feature = connected.capabilities.features.find(
      (capability) => capability.kind === 'signal-lab-profile-selection',
    );
    if (feature?.kind !== 'signal-lab-profile-selection' || !feature.iqProfiles) {
      throw new Error('Expected SignalLab v3 profile transports');
    }
    const contentBound = feature.iqProfiles.filter(
      (profile) => profile.nativeSampleRateHz !== null && profile.replay !== 'unbounded',
    );
    const unbounded = feature.iqProfiles.filter((profile) => profile.replay === 'unbounded');
    expect(contentBound).toHaveLength(31);
    expect(unbounded).toHaveLength(2);
    for (const profile of contentBound) {
      await api.executeFeature({
        kind: 'signal-lab-profile-selection',
        action: 'select-profile',
        profileId: profile.profileId,
      });
      // Capture bandwidth is a symmetric passband about the RF tune center, so
      // exact native bytes need the declared native minimum span, not the bare
      // signal bandwidth. They only differ for the two offset Bluetooth
      // artifacts, and for those the difference is the whole point.
      await api.configure({
        kind: 'complex-iq',
        centerHz: profile.profileReferenceCenterHz,
        sampleRateHz: profile.nativeSampleRateHz!,
        bandwidthHz: profile.nativeMinimumCaptureBandwidthHz!,
        sampleCount: Math.min(64, profile.maxOneShotSamples ?? 64),
        sampleFormat: 'cf32le',
      });
      await expect(api.acquire(), profile.profileId).resolves.toMatchObject({
        kind: 'complex-iq',
        qualification: 'independently-verified-digital-baseband',
        payloadKind: 'native-canonical',
        profileReferenceCenterHz: profile.profileReferenceCenterHz,
        rfReferenceCenterHz: profile.profileReferenceCenterHz - profile.nativeCarrierOffsetHz,
        nativeCarrierOffsetHz: profile.nativeCarrierOffsetHz,
        outputCarrierOffsetHz: profile.nativeCarrierOffsetHz,
        rfTuneCenterHz: profile.profileReferenceCenterHz - profile.nativeCarrierOffsetHz,
      });
    }
    await api.disconnect();
  }, 30_000);

  it('keeps the Bluetooth BR packet signal at 2.410 GHz inside its 2.441 GHz native capture', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'bluetooth-classic-connected',
    });
    // BR sits at -31 MHz inside its 80 Msps artifact, so a symmetric capture
    // that keeps the carrier where it natively is costs 2 * 31 + 1 = 63 MHz.
    await api.configure({
      kind: 'complex-iq',
      centerHz: 2_410_000_000,
      sampleRateHz: 80_000_000,
      bandwidthHz: 63_000_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    await expect(api.acquire()).resolves.toMatchObject({
      kind: 'complex-iq',
      profileReferenceCenterHz: 2_410_000_000,
      rfReferenceCenterHz: 2_441_000_000,
      nativeCarrierOffsetHz: -31_000_000,
      outputCarrierOffsetHz: -31_000_000,
      rfTuneCenterHz: 2_441_000_000,
      qualification: 'independently-verified-digital-baseband',
      payloadKind: 'native-canonical',
    });
    await api.disconnect();
  });

  it('serves a signal-wide but offset-narrow Bluetooth BR capture as translated derived bytes', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'bluetooth-classic-connected',
    });
    // 1 MHz still contains the whole 1 MHz signal, so the request is legal. It
    // just cannot hold the -31 MHz offset, so the producer must translate the
    // carrier to DC, emit the receipt operation, and stop claiming native bytes.
    await api.configure({
      kind: 'complex-iq',
      centerHz: 2_410_000_000,
      sampleRateHz: 80_000_000,
      bandwidthHz: 1_000_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    await expect(api.acquire()).resolves.toMatchObject({
      kind: 'complex-iq',
      nativeCarrierOffsetHz: -31_000_000,
      outputCarrierOffsetHz: 0,
      rfTuneCenterHz: 2_410_000_000,
      qualification: 'derived-from-independently-verified-digital-baseband',
      payloadKind: 'derived-hardware-ready',
      transformReceipt: {
        operations: expect.arrayContaining([
          expect.objectContaining({
            kind: 'frequency-translate',
            sourceCarrierOffsetHz: -31_000_000,
            outputCarrierOffsetHz: 0,
          }),
        ]),
      },
    });
    await api.disconnect();
  });

  it('derives Bluetooth one-shot output bounds from native duration', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'bluetooth-le-advertising',
    });
    // LE sits at -15 MHz, so its exact-native symmetric span is 31 MHz.
    await api.configure({
      kind: 'complex-iq',
      centerHz: 2_426_000_000,
      sampleRateHz: 80_000_000,
      bandwidthHz: 31_000_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    await expect(api.acquire()).resolves.toMatchObject({
      kind: 'complex-iq',
      profileReferenceCenterHz: 2_426_000_000,
      rfReferenceCenterHz: 2_441_000_000,
      nativeCarrierOffsetHz: -15_000_000,
      outputCarrierOffsetHz: -15_000_000,
      rfTuneCenterHz: 2_441_000_000,
      qualification: 'independently-verified-digital-baseband',
      payloadKind: 'native-canonical',
      transformReceipt: {
        sourceBoundaryPolicy: 'one-shot-zero-extended',
        sourcePeriodSamples: null,
        operations: [],
      },
    });
    await expect(api.configure({
      kind: 'complex-iq',
      centerHz: 2_426_000_000,
      sampleRateHz: 40_000_000,
      bandwidthHz: 1_000_000,
      sampleCount: 6_081,
      sampleFormat: 'cf32le',
    })).rejects.toThrow(/at most 6080 output samples/i);
    await api.configure({
      kind: 'complex-iq',
      centerHz: 2_426_000_000,
      sampleRateHz: 40_000_000,
      bandwidthHz: 1_000_000,
      sampleCount: 6_080,
      sampleFormat: 'cf32le',
    });
    await expect(api.acquire()).resolves.toMatchObject({
      kind: 'complex-iq',
      qualification: 'derived-from-independently-verified-digital-baseband',
      sampleCount: 6_080,
      profileReferenceCenterHz: 2_426_000_000,
      rfReferenceCenterHz: 2_441_000_000,
      nativeCarrierOffsetHz: -15_000_000,
      outputCarrierOffsetHz: 0,
      rfTuneCenterHz: 2_426_000_000,
      transformReceipt: {
        sourceBoundaryPolicy: 'one-shot-zero-extended',
        sourcePeriodSamples: null,
        sourceCarrierOffsetHz: -15_000_000,
        outputCarrierOffsetHz: 0,
        operations: expect.arrayContaining([
          expect.objectContaining({
            kind: 'frequency-translate',
            sourceCarrierOffsetHz: -15_000_000,
            outputCarrierOffsetHz: 0,
          }),
        ]),
      },
    });
    await api.disconnect();
  });

  it('admits a fixed profile returning to native rate at fractional native phase', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'nr-n78-tdd-100m',
    });
    await api.configure({
      kind: 'complex-iq',
      centerHz: 3_500_010_000,
      sampleRateHz: 120_000_000,
      bandwidthHz: 100_000_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    await api.acquire();
    await api.configure({
      kind: 'complex-iq',
      centerHz: 3_500_010_000,
      sampleRateHz: 122_880_000,
      bandwidthHz: 100_000_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    const returned = await api.acquire();
    expect(returned).toMatchObject({
      kind: 'complex-iq',
      sampleRateHz: 122_880_000,
      nativeSampleRateHz: 122_880_000,
      qualification: 'derived-from-independently-verified-digital-baseband',
      payloadKind: 'derived-hardware-ready',
      transformReceipt: {
        sourceSampleRateHz: 122_880_000,
        outputSampleRateHz: 122_880_000,
        sourceBoundaryPolicy: 'cyclic-modular',
        sourcePeriodSamples: 2_457_600,
        operations: [expect.objectContaining({
          kind: 'fractional-delay',
          sampleRateHz: 122_880_000,
        })],
      },
    });
    if (returned.kind !== 'complex-iq' || returned.transformReceipt === undefined) {
      throw new Error('Expected SignalLab v3 I/Q receipt');
    }
    expect(returned.transformReceipt.outputStartSourceSampleDenominator).not.toBe('1');
    await api.disconnect();
  });

  it('admits a flexible generator rate switch with same-rate fractional-delay lineage', async () => {
    const api = createBrowserInstrumentApi(new BrowserSignalLabWorkerDriver(() => new LoopbackSignalLabWorker()));
    await api.connect((await api.discover()).candidates[0]!);
    await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'cw',
    });
    await api.configure({
      kind: 'complex-iq',
      centerHz: 100_000_000,
      sampleRateHz: 3_000_000,
      bandwidthHz: 2_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    await api.acquire();
    await api.configure({
      kind: 'complex-iq',
      centerHz: 100_000_000,
      sampleRateHz: 2_000_000,
      bandwidthHz: 2_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    });
    const returned = await api.acquire();
    expect(returned).toMatchObject({
      kind: 'complex-iq',
      qualification: 'analytic-complex-baseband',
      payloadKind: 'generated-at-output-rate',
      canonicalArtifactSha256: null,
      transformReceipt: {
        sourceArtifactSha256: null,
        sourceSampleRateHz: 2_000_000,
        outputSampleRateHz: 2_000_000,
        sourceBoundaryPolicy: 'continuous-session-origin-zero-extended',
        sourcePeriodSamples: null,
        operations: [expect.objectContaining({
          kind: 'fractional-delay',
          sampleRateHz: 2_000_000,
        })],
      },
    });
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
      if (workers.length === 1) worker.failNextRequest('discover');
      return worker;
    }));

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

  it('times out a silent sessionless Worker, ignores its late reply, and lazily restarts discovery', async () => {
    vi.useFakeTimers();
    const workers: LoopbackSignalLabWorker[] = [];
    const driver = new BrowserSignalLabWorkerDriver(() => {
      const worker = new LoopbackSignalLabWorker();
      workers.push(worker);
      if (workers.length === 1) worker.silenceNextRequest('discover');
      return worker;
    });
    const first = driver.discover();
    const firstFailure = expect(first).rejects.toThrow(
      /SignalLab worker did not respond to discover within 15 seconds/i,
    );

    await vi.advanceTimersByTimeAsync(
      BROWSER_SIGNAL_LAB_WORKER_RESPONSE_TIMEOUT_MILLISECONDS - 1,
    );
    expect(workers[0]!.terminateCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await firstFailure;
    expect(workers[0]!.terminateCalls).toBe(1);

    workers[0]!.emitMessage({
      kind: 'response',
      requestId: 1,
      ok: true,
      result: { candidates: [], failures: [] },
    });
    const recovered = await driver.discover();
    expect(workers).toHaveLength(2);
    expect(recovered.candidates).toHaveLength(1);
  });

  it('rejects a synchronously failed postMessage and lazily restarts discovery', async () => {
    const workers: LoopbackSignalLabWorker[] = [];
    const driver = new BrowserSignalLabWorkerDriver(() => {
      const worker = new LoopbackSignalLabWorker();
      workers.push(worker);
      if (workers.length === 1) worker.throwNextRequest('discover');
      return worker;
    });

    await expect(driver.discover()).rejects.toThrow(
      /SignalLab postMessage failed during discover/i,
    );
    expect(workers[0]!.terminateCalls).toBe(1);

    const recovered = await driver.discover();
    expect(workers).toHaveLength(2);
    expect(recovered.candidates).toHaveLength(1);
  });

  it('does not restart a timed-out connected Worker until the dead session is safely disconnected', async () => {
    vi.useFakeTimers();
    const workers: LoopbackSignalLabWorker[] = [];
    const driver = new BrowserSignalLabWorkerDriver(() => {
      const worker = new LoopbackSignalLabWorker();
      workers.push(worker);
      return worker;
    });
    const api = createBrowserInstrumentApi(driver);
    const candidate = (await api.discover()).candidates[0]!;
    const session = await driver.connect(candidate);
    workers[0]!.silenceNextRequest('acquire');
    const acquire = session.acquire();
    const acquireFailure = expect(acquire).rejects.toThrow(
      /SignalLab worker did not respond to acquire within 15 seconds/i,
    );

    await vi.advanceTimersByTimeAsync(
      BROWSER_SIGNAL_LAB_WORKER_RESPONSE_TIMEOUT_MILLISECONDS,
    );
    await acquireFailure;
    await expect(driver.discover()).rejects.toThrow(
      /SignalLab worker did not respond to acquire within 15 seconds/i,
    );
    expect(workers).toHaveLength(1);

    await session.disconnect();
    expect(workers).toHaveLength(1);
    const recovered = await driver.discover();
    expect(workers).toHaveLength(2);
    expect(recovered.candidates).toHaveLength(1);
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
