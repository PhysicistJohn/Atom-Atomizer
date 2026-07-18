import { describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';
import type { WaveformEvidence } from '@tinysa/analysis';
import {
  BAYESIAN_WORKER_RESPONSE_TIMEOUT_MILLISECONDS,
  createBayesianClassifierRuntime,
  type BayesianClassificationEngine,
  WorkerBayesianClassifier,
} from './bayesian-classifier-runtime.js';

const detection = {
  id: 'signal-0001',
  peakHz: 100_000_000,
  bandwidthHz: 20_000,
  peakDbm: -48,
  sweepIds: ['sweep-1'],
} as unknown as DetectedSignal;
const evidence = { sweeps: [] } as unknown as WaveformEvidence;

function admittedResult(modelId = 'admitted-model'): WaveformClassification {
  return {
    detectionId: detection.id,
    label: 'unknown',
    confidence: 0,
    candidates: [],
    modelId,
    qualification: 'bayesian-observable-equivalence',
    scoreKind: 'none',
    decisionLevel: 'unknown',
    classifiedAt: '2026-07-16T00:00:00.000Z',
    unknownReason: 'insufficient-evidence',
    evidence: {
      centerHz: detection.peakHz,
      bandwidthHz: detection.bandwidthHz,
      peakDbm: detection.peakDbm,
      sweepIds: detection.sweepIds,
    },
  };
}

type WorkerListener = EventListenerOrEventListenerObject;

class FakeWorker {
  readonly listeners = new Map<string, Set<WorkerListener>>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WorkerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'message' | 'error' | 'messageerror', event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === 'function') listener(event as Event);
      else listener.handleEvent(event as Event);
    }
  }

  asWorker(): Worker { return this as unknown as Worker; }
}

describe('Bayesian classifier renderer boundary', () => {
  it('keeps the renderer available when no classifier assets were bundled', async () => {
    const runtime = createBayesianClassifierRuntime(() => {
      throw new Error('Bayesian classifier model assets are not bundled');
    });

    expect(runtime).toMatchObject({
      status: 'unavailable',
      issue: 'Bayesian classifier model assets are not bundled',
      classifier: { modelId: 'bayesian-observable-model-unavailable' },
    });
    await expect(runtime.classifier.classify(detection, evidence)).resolves.toMatchObject({
      qualification: 'unavailable',
      unknownReason: 'model-unavailable',
    });
  });

  it('admits the model eagerly but starts the module worker only on first inference', async () => {
    const worker = new FakeWorker();
    const inThreadClassify = vi.fn(async () => admittedResult());
    const disposeAdmission = vi.fn();
    const workerFactory = vi.fn(() => worker.asWorker());
    const runtime = createBayesianClassifierRuntime(
      () => ({ modelId: 'admitted-model', classify: inThreadClassify, dispose: disposeAdmission }),
      workerFactory,
    );

    expect(runtime).toMatchObject({ status: 'ready', classifier: { modelId: 'admitted-model' } });
    expect(disposeAdmission).toHaveBeenCalledOnce();
    expect(workerFactory).not.toHaveBeenCalled();
    const classified = runtime.classifier.classify(detection, evidence);
    expect(workerFactory).toHaveBeenCalledOnce();
    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: admittedResult() } });
    await expect(classified).resolves.toEqual(admittedResult());
    expect(inThreadClassify).not.toHaveBeenCalled();
  });

  it('uses an admitted module worker without invoking the renderer-thread classifier', async () => {
    const worker = new FakeWorker();
    const inThreadClassify = vi.fn(async () => admittedResult());
    const runtime = createBayesianClassifierRuntime(
      () => ({ modelId: 'admitted-model', classify: inThreadClassify }),
      () => worker.asWorker(),
    );

    const classified = runtime.classifier.classify(detection, evidence);
    expect(inThreadClassify).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'classify', requestId: 1, detection, evidence,
    }));
    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: admittedResult() } });

    await expect(classified).resolves.toEqual(admittedResult());
    expect(runtime).toMatchObject({ status: 'ready', classifier: { modelId: 'admitted-model' } });
  });

  it('makes Worker construction failure capability-local without invoking renderer-thread inference', async () => {
    const inThreadClassify = vi.fn(async () => admittedResult());
    const runtime = createBayesianClassifierRuntime(
      () => ({ modelId: 'admitted-model', classify: inThreadClassify }),
      () => { throw new Error('module worker refused to start'); },
    );

    await expect(runtime.classifier.classify(detection, evidence))
      .rejects.toThrow(/worker is unavailable: module worker refused to start/i);
    await expect(runtime.classifier.classify(detection, evidence))
      .rejects.toThrow(/worker is unavailable/i);
    expect(inThreadClassify).not.toHaveBeenCalled();
  });

  it('terminates and rejects a silent worker after the bounded response deadline', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
      const pending = classifier.classify(detection, evidence);
      const rejected = expect(pending).rejects.toThrow(/did not answer request 1/i);

      await vi.advanceTimersByTimeAsync(BAYESIAN_WORKER_RESPONSE_TIMEOUT_MILLISECONDS);

      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
      await expect(classifier.classify(detection, evidence)).rejects.toThrow(/did not answer request 1/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and terminates on a structurally incomplete classification object', async () => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    const pending = classifier.classify(detection, evidence);
    const { scoreKind: _omitted, ...incomplete } = admittedResult();

    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: incomplete } });

    await expect(pending).rejects.toThrow(/invalid classification/i);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    ['confidence just above one', { ...admittedResult(), confidence: 1 + Number.EPSILON }],
    ['negative candidate probability', {
      ...admittedResult(),
      candidates: [{ label: 'hostile', confidence: -Number.EPSILON }],
    }],
    ['non-finite candidate probability', {
      ...admittedResult(),
      candidates: [{ label: 'hostile', confidence: Number.NaN }],
    }],
    ['decision support just above one', {
      ...admittedResult(),
      decisionSupport: { kind: 'model-posterior' as const, value: 1 + Number.EPSILON },
    }],
    ['negative decision threshold', {
      ...admittedResult(),
      decisionSupport: { kind: 'synthetic-support-rank' as const, value: 0.01, threshold: -0.01 },
    }],
  ])('rejects and terminates on %s from the worker', async (_case, result) => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    const pending = classifier.classify(detection, evidence);

    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result } });

    await expect(pending).rejects.toThrow(/invalid classification/i);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(classifier.classify(detection, evidence)).rejects.toThrow(/invalid classification/i);
  });

  it('rejects every pending request and terminates on a malformed worker response', async () => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    const first = classifier.classify(detection, evidence);
    const second = classifier.classify({ ...detection, id: 'signal-0002' }, evidence);

    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: null } });

    await expect(first).rejects.toThrow(/malformed response/);
    await expect(second).rejects.toThrow(/malformed response/);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect([...worker.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await expect(classifier.classify(detection, evidence)).rejects.toThrow(/malformed response/);
  });

  it.each([
    ['error', { message: 'worker boot failed' }, /worker crashed: worker boot failed/],
    ['messageerror', {}, /uncloneable response/],
  ] as const)('contains %s failures, drains pending work, and terminates', async (type, event, expected) => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    const pending = classifier.classify(detection, evidence);

    worker.emit(type, event);

    await expect(pending).rejects.toThrow(expected);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(classifier.classify(detection, evidence)).rejects.toThrow(expected);
  });

  it('removes an aborted request while leaving the worker available for later evidence', async () => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    const controller = new AbortController();
    const aborted = classifier.classify(detection, evidence, controller.signal);

    controller.abort(new Error('superseded evidence'));
    await expect(aborted).rejects.toThrow(/superseded evidence/);
    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: admittedResult() } });

    const current = classifier.classify(detection, evidence);
    worker.emit('message', { data: { type: 'classification', requestId: 2, ok: true, result: admittedResult() } });
    await expect(current).resolves.toEqual(admittedResult());
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('ignores unknown and late response IDs without settling current work', async () => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    let settled = false;
    const current = classifier.classify(detection, evidence).finally(() => { settled = true; });

    worker.emit('message', { data: { type: 'classification', requestId: 999, ok: true, result: admittedResult() } });
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: admittedResult() } });
    await expect(current).resolves.toEqual(admittedResult());
    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: false, error: 'late duplicate' } });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('terminates on dispose, rejects pending work, and ignores late responses', async () => {
    const worker = new FakeWorker();
    const classifier = new WorkerBayesianClassifier('admitted-model', worker.asWorker());
    const pending = classifier.classify(detection, evidence);

    classifier.dispose();
    classifier.dispose();

    await expect(pending).rejects.toThrow(/terminated/);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect([...worker.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    worker.emit('message', { data: { type: 'classification', requestId: 1, ok: true, result: admittedResult() } });
    await expect(classifier.classify(detection, evidence)).rejects.toThrow(/disposed/);
  });

  it('keeps the renderer available while making rejected-model inference explicitly unavailable', async () => {
    const runtime = createBayesianClassifierRuntime(() => {
      throw new Error('Observable model asset does not match the v8 production admission contract');
    });

    expect(runtime).toMatchObject({
      status: 'unavailable',
      issue: 'Observable model asset does not match the v8 production admission contract',
      classifier: { modelId: 'bayesian-observable-model-unavailable' },
    });
    await expect(runtime.classifier.classify(detection, evidence)).resolves.toMatchObject({
      detectionId: detection.id,
      label: 'unknown',
      confidence: 0,
      candidates: [],
      modelId: 'bayesian-observable-model-unavailable',
      qualification: 'unavailable',
      scoreKind: 'none',
      decisionLevel: 'unknown',
      unknownReason: 'model-unavailable',
      evidence: {
        centerHz: detection.peakHz,
        sweepIds: detection.sweepIds,
        limitations: ['bayesian-model-contract-unavailable'],
      },
    });
  });
});
