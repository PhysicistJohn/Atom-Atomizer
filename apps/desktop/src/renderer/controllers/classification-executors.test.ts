// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import type {
  ClassificationWorkerRequest,
  ClassificationWorkerResponse,
} from '../classification-worker-protocol.js';
import {
  classifyIqModulation,
  classifyScalarSweep,
} from '../embedding-classifier-runtime.js';
import {
  TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
  type TrustedIqGeometryContext,
} from '../iq-classification-geometry.js';
import { createClassificationExecutor } from './classification.js';

vi.mock('../embedding-classifier-runtime.js', () => ({
  classifyIqModulation: vi.fn(),
  classifyScalarSweep: vi.fn(),
}));

const stageOneRejection: ModulationClassification = {
  flavor: 'iq',
  modulation: 'unknown',
  family: 'unknown',
  confidence: 0,
  isUnknown: true,
  candidates: [],
  bwFraction: 1,
  rejection: {
    stage: 1,
    reason: 'noise',
    score: 0.99,
    threshold: 0.5,
  },
};

const nativeGeometry: TrustedIqGeometryContext = {
  kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
  sampleRateHz: 122_880_000,
  nativeSampleRateHz: 122_880_000,
};

const scaledGeometry: TrustedIqGeometryContext = {
  kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
  sampleRateHz: 61_440_000,
  nativeSampleRateHz: 122_880_000,
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  FakeWorker.instances.length = 0;
});

describe('classification executors', () => {
  it('keeps the inline path on the live classifier and preserves staged rejection metadata', async () => {
    vi.stubGlobal('Worker', undefined);
    vi.mocked(classifyIqModulation).mockResolvedValue(stageOneRejection);
    const executor = createClassificationExecutor();
    const real = new Float64Array([1, 2, 3]);
    const imaginary = new Float64Array([-1, -2, -3]);

    const result = await executor.classifyIq(
      real,
      imaginary,
      2_000_000,
      20_000_000,
      'current',
      nativeGeometry,
    );

    expect(classifyIqModulation).toHaveBeenCalledWith(
      real,
      imaginary,
      2_000_000,
      20_000_000,
      'current',
      nativeGeometry,
    );
    expect(classifyScalarSweep).not.toHaveBeenCalled();
    expect(result).toEqual(stageOneRejection);
    executor.dispose();
  });

  it('uses the worker path, transfers both I/Q buffers, and preserves the complete result', async () => {
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const executor = createClassificationExecutor();
    const real = new Float64Array([1, 2, 3]);
    const imaginary = new Float64Array([-1, -2, -3]);
    const pending = executor.classifyIq(
      real,
      imaginary,
      2_000_000,
      20_000_000,
      'historical',
      scaledGeometry,
    );
    const worker = FakeWorker.instances[0]!;

    expect(worker.url.toString()).toContain('classification-worker.ts');
    expect(worker.options).toMatchObject({ type: 'module', name: 'atomizer-classification' });
    expect(worker.lastMessage).toMatchObject({
      id: 1,
      kind: 'iq',
      real,
      imaginary,
      bandwidthHz: 2_000_000,
      sampleRateHz: 20_000_000,
      prototypeSource: 'historical',
      trustedGeometry: scaledGeometry,
    });
    expect(worker.lastTransfer).toEqual([real.buffer, imaginary.buffer]);

    worker.respond({ id: 1, ok: true, result: stageOneRejection });
    await expect(pending).resolves.toEqual(stageOneRejection);
    executor.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('fails every request on a silent worker, ignores late replies, and starts a fresh worker on retry', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    const executor = createClassificationExecutor();
    const first = executor.classifyIq(
      new Float64Array([1, 2, 3]),
      new Float64Array([-1, -2, -3]),
      2_000_000,
      20_000_000,
      'current',
      nativeGeometry,
    );
    const second = executor.classifyIq(
      new Float64Array([4, 5, 6]),
      new Float64Array([-4, -5, -6]),
      2_000_000,
      20_000_000,
      'historical',
    );
    const silentWorker = FakeWorker.instances[0]!;
    const failuresPromise = Promise.allSettled([first, second]);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(silentWorker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const failures = await failuresPromise;
    expect(failures).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringMatching(
            /Classification worker did not respond within 15 seconds/i,
          ),
        }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringMatching(
            /Classification worker did not respond within 15 seconds/i,
          ),
        }),
      }),
    ]);
    expect(silentWorker.terminate).toHaveBeenCalledOnce();
    // The timed-out queue is empty: a tardy result from the poisoned worker
    // cannot resolve a later request or resurrect that worker.
    silentWorker.respond({ id: 1, ok: true, result: stageOneRejection });
    silentWorker.respond({ id: 2, ok: true, result: stageOneRejection });

    const retry = executor.classifyIq(
      new Float64Array([7, 8, 9]),
      new Float64Array([-7, -8, -9]),
      2_000_000,
      20_000_000,
      'current',
      nativeGeometry,
    );
    const replacement = FakeWorker.instances[1]!;
    expect(replacement).not.toBe(silentWorker);
    replacement.respond({ id: 3, ok: true, result: stageOneRejection });
    await expect(retry).resolves.toEqual(stageOneRejection);
    executor.dispose();
  });
});

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<ClassificationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  lastMessage: ClassificationWorkerRequest | undefined;
  lastTransfer: readonly Transferable[] | undefined;
  readonly terminate = vi.fn();

  constructor(
    readonly url: URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: ClassificationWorkerRequest, transfer: readonly Transferable[]): void {
    this.lastMessage = message;
    this.lastTransfer = transfer;
  }

  respond(response: ClassificationWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }));
  }
}
