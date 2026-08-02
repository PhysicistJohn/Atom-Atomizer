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

afterEach(() => {
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
    );

    expect(classifyIqModulation).toHaveBeenCalledWith(
      real,
      imaginary,
      2_000_000,
      20_000_000,
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
    });
    expect(worker.lastTransfer).toEqual([real.buffer, imaginary.buffer]);

    worker.respond({ id: 1, ok: true, result: stageOneRejection });
    await expect(pending).resolves.toEqual(stageOneRejection);
    executor.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
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
