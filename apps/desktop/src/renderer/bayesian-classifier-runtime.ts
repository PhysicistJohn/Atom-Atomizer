import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';
import type { WaveformEvidence } from '@tinysa/analysis';
import { z } from 'zod';
import {
  createBundledBayesianClassificationWorker,
  createBundledBayesianClassifier,
} from './bayesian-classifier-provider.js';

export interface BayesianClassificationEngine {
  readonly modelId: string;
  classify(
    detection: DetectedSignal,
    evidence: WaveformEvidence,
    signal?: AbortSignal,
  ): Promise<WaveformClassification>;
  dispose?(): void;
}

export type BayesianClassifierRuntime =
  | {
    readonly status: 'ready';
    readonly classifier: BayesianClassificationEngine;
  }
  | {
    readonly status: 'unavailable';
    readonly classifier: BayesianClassificationEngine;
    readonly issue: string;
  };

/**
 * Keep a rejected generated model local to the classification capability.
 *
 * The optional build provider imports the generated-model-dependent classifier
 * only when the complete generated pair exists. Its constructor then performs
 * the full asset admission audit. Either an absent provider or a constructor
 * rejection remains local: no classifier instance escapes and no Bayesian
 * score can be produced, while the rest of the renderer remains available.
 */
export function createBayesianClassifierRuntime(
  factory: () => BayesianClassificationEngine = createBundledBayesianClassifier,
  workerFactory: () => Worker = createBundledBayesianClassificationWorker,
): BayesianClassifierRuntime {
  try {
    const admitted = factory();
    const modelId = nonEmptyBoundedString.parse(admitted.modelId);
    // The constructor is the model-asset admission boundary. It is never an
    // inference fallback: renderer-thread scoring would make a failed Worker
    // boot look successful while reintroducing the paint-blocking hot path.
    admitted.dispose?.();
    return {
      status: 'ready',
      classifier: new LazyWorkerBayesianClassifier(modelId, workerFactory),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      classifier: new UnavailableBayesianClassifier(),
      issue: errorMessage(error),
    };
  }
}

interface PendingWorkerClassification {
  readonly detection: DetectedSignal;
  readonly evidence: WaveformEvidence;
  readonly resolve: (result: WaveformClassification) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly deadline: ReturnType<typeof setTimeout>;
}

type WorkerClassificationResponse =
  | { readonly type: 'classification'; readonly requestId: number; readonly ok: true; readonly result: WaveformClassification }
  | { readonly type: 'classification'; readonly requestId: number; readonly ok: false; readonly error: string };

// A generated observation is normally tens of milliseconds. This deadline is
// deliberately generous for slow development machines while still bounding a
// silent/dead worker lane and every Promise retained behind it.
export const BAYESIAN_WORKER_RESPONSE_TIMEOUT_MILLISECONDS = 5_000;

/** Worker construction happens on first inference, never during React render. */
class LazyWorkerBayesianClassifier implements BayesianClassificationEngine {
  #delegate: WorkerBayesianClassifier | undefined;
  #failure: Error | undefined;
  #disposed = false;

  constructor(
    readonly modelId: string,
    private readonly workerFactory: () => Worker,
  ) {}

  classify(
    detection: DetectedSignal,
    evidence: WaveformEvidence,
    signal?: AbortSignal,
  ): Promise<WaveformClassification> {
    if (this.#disposed) return Promise.reject(new Error('Bayesian classifier worker is disposed'));
    if (this.#failure) return Promise.reject(this.#failure);
    if (!this.#delegate) {
      try {
        this.#delegate = new WorkerBayesianClassifier(this.modelId, this.workerFactory());
      } catch (value) {
        this.#failure = new Error(`Bayesian classifier worker is unavailable: ${errorMessage(value)}`);
        return Promise.reject(this.#failure);
      }
    }
    return this.#delegate.classify(detection, evidence, signal);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#delegate?.dispose();
  }
}

/** One shared worker owns the generated model and keeps its CPU work off React's event loop. */
export class WorkerBayesianClassifier implements BayesianClassificationEngine {
  readonly #pending = new Map<number, PendingWorkerClassification>();
  #nextRequestId = 1;
  #disposed = false;
  #terminated = false;
  #failure: Error | undefined;

  constructor(readonly modelId: string, private readonly worker: Worker) {
    worker.addEventListener('message', this.#onMessage);
    worker.addEventListener('error', this.#onError);
    worker.addEventListener('messageerror', this.#onMessageError);
  }

  classify(
    detection: DetectedSignal,
    evidence: WaveformEvidence,
    signal?: AbortSignal,
  ): Promise<WaveformClassification> {
    if (this.#disposed) return Promise.reject(new Error('Bayesian classifier worker is disposed'));
    if (this.#failure) return Promise.reject(this.#failure);
    try { signal?.throwIfAborted(); }
    catch (value) { return Promise.reject(value); }
    const requestId = this.#nextRequestId++;
    if (!Number.isSafeInteger(this.#nextRequestId)) this.#nextRequestId = 1;
    return new Promise<WaveformClassification>((resolve, reject) => {
      const abort = signal ? () => {
        const pending = this.#settle(requestId);
        if (!pending) return;
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      } : undefined;
      const pending: PendingWorkerClassification = {
        detection,
        evidence,
        resolve,
        reject,
        deadline: setTimeout(() => {
          this.#failWorker(new Error(
            `Bayesian classifier worker did not answer request ${requestId} within ${BAYESIAN_WORKER_RESPONSE_TIMEOUT_MILLISECONDS} ms`,
          ));
        }, BAYESIAN_WORKER_RESPONSE_TIMEOUT_MILLISECONDS),
        ...(signal ? { signal } : {}),
        ...(abort ? { abort } : {}),
      };
      this.#pending.set(requestId, pending);
      signal?.addEventListener('abort', abort!, { once: true });
      try {
        this.worker.postMessage({ type: 'classify', requestId, detection, evidence });
      } catch (value) {
        this.#settle(requestId);
        reject(value);
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminateWorker();
    this.#rejectAll(new Error('Bayesian classifier worker was terminated'));
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const response = parseWorkerResponse(event.data);
    if (!response) {
      this.#failWorker(new Error('Bayesian classifier worker returned a malformed response'));
      return;
    }
    const pending = this.#settle(response.requestId);
    if (!pending) return;
    if (!response.ok) {
      pending.reject(new Error(`Bayesian classifier worker failed: ${response.error}`));
      return;
    }
    try {
      pending.resolve(requireWorkerClassification(response.result, pending.detection, this.modelId));
    } catch (value) {
      const failure = new Error(`Bayesian classifier worker returned an invalid classification: ${errorMessage(value)}`);
      pending.reject(failure);
      this.#failWorker(failure);
    }
  };

  readonly #onError = (event: ErrorEvent): void => {
    this.#failWorker(new Error(`Bayesian classifier worker crashed: ${event.message || 'unknown worker error'}`));
  };

  readonly #onMessageError = (): void => {
    this.#failWorker(new Error('Bayesian classifier worker returned an uncloneable response'));
  };

  #settle(requestId: number): PendingWorkerClassification | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    this.#pending.delete(requestId);
    clearTimeout(pending.deadline);
    if (pending.abort && pending.signal) pending.signal.removeEventListener('abort', pending.abort);
    return pending;
  }

  #rejectAll(error: Error): void {
    for (const requestId of [...this.#pending.keys()]) this.#settle(requestId)?.reject(error);
  }

  #failWorker(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#terminateWorker();
    this.#rejectAll(this.#failure);
  }

  #terminateWorker(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.worker.removeEventListener('message', this.#onMessage);
    this.worker.removeEventListener('error', this.#onError);
    this.worker.removeEventListener('messageerror', this.#onMessageError);
    this.worker.terminate();
  }
}

class UnavailableBayesianClassifier implements BayesianClassificationEngine {
  readonly modelId = 'bayesian-observable-model-unavailable';

  async classify(
    detection: DetectedSignal,
    _evidence: WaveformEvidence,
    signal?: AbortSignal,
  ): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    return {
      detectionId: detection.id,
      label: 'unknown',
      confidence: 0,
      candidates: [],
      modelId: this.modelId,
      qualification: 'unavailable',
      scoreKind: 'none',
      decisionLevel: 'unknown',
      classifiedAt: new Date().toISOString(),
      unknownReason: 'model-unavailable',
      evidence: {
        centerHz: detection.peakHz,
        bandwidthHz: detection.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: detection.sweepIds,
        limitations: ['bayesian-model-contract-unavailable'],
      },
    };
  }
}

function parseWorkerResponse(value: unknown): WorkerClassificationResponse | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const response = value as Record<string, unknown>;
  if (response.type !== 'classification'
    || !Number.isSafeInteger(response.requestId)
    || (response.requestId as number) < 1
    || typeof response.ok !== 'boolean') return undefined;
  if (response.ok) {
    if (typeof response.result !== 'object' || response.result === null) return undefined;
    return response as unknown as Extract<WorkerClassificationResponse, { ok: true }>;
  }
  if (typeof response.error !== 'string' || response.error.length < 1 || response.error.length > 1_024) return undefined;
  return response as unknown as Extract<WorkerClassificationResponse, { ok: false }>;
}

function requireWorkerClassification(
  value: WaveformClassification,
  detection: DetectedSignal,
  modelId: string,
): WaveformClassification {
  const admitted = waveformClassificationBoundarySchema.parse(value);
  if (admitted.detectionId !== detection.id) throw new Error('Bayesian classifier worker substituted a different detection');
  if (admitted.modelId !== modelId) throw new Error('Bayesian classifier worker substituted a different model');
  return structuredClone(admitted);
}

const nonEmptyBoundedString = z.string().trim().min(1).max(4_096);
const probability = z.number().finite().min(0).max(1);
const finiteNumber = z.number().finite();
const classificationCandidateBoundarySchema = z.object({
  label: nonEmptyBoundedString,
  confidence: probability,
  family: nonEmptyBoundedString.optional(),
}).strict();
const waveformClassificationBoundarySchema = z.object({
  detectionId: nonEmptyBoundedString,
  label: nonEmptyBoundedString,
  confidence: probability,
  candidates: z.array(classificationCandidateBoundarySchema).max(1_024),
  modelId: nonEmptyBoundedString,
  qualification: z.enum([
    'spectral-morphology',
    'signal-lab-synthetic-hypothesis',
    'bayesian-observable-equivalence',
    'unavailable',
  ]),
  scoreKind: z.enum(['relative-score', 'model-posterior', 'none']),
  decisionLevel: z.enum(['morphology', 'profile', 'family', 'equivalence-class', 'unknown']),
  decisionSupport: z.object({
    kind: z.enum(['model-posterior', 'synthetic-support-rank']),
    value: probability,
    threshold: probability.optional(),
  }).strict().optional(),
  modelProvenance: z.object({
    producer: z.literal('tinysa-signal-lab'),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
    corpusSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    preprocessing: nonEmptyBoundedString,
    modelAssetSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    priorId: nonEmptyBoundedString.optional(),
    calibrationId: nonEmptyBoundedString.optional(),
    decisionPolicyId: nonEmptyBoundedString.optional(),
  }).strict().optional(),
  classifiedAt: z.string().datetime(),
  unknownReason: z.enum([
    'model-unavailable',
    'low-confidence',
    'out-of-domain',
    'insufficient-evidence',
    'inference-failed',
  ]).optional(),
  evidence: z.object({
    centerHz: finiteNumber,
    bandwidthHz: finiteNumber.nonnegative(),
    peakDbm: finiteNumber,
    sweepIds: z.array(nonEmptyBoundedString).max(4_096),
    zeroSpanCaptureId: nonEmptyBoundedString.optional(),
    detectedPowerAcquisitionQualification: z.literal(
      'receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5',
    ).optional(),
    detectedPowerSelectionCondition: z.enum([
      'automatic-current-source-sweep-integrated-excess-rank-0',
      'operator-preferred-current-target',
    ]).optional(),
    views: z.array(z.enum(['scalar-spectrum', 'detected-power-envelope'])).max(2).optional(),
    features: z.record(z.string(), finiteNumber).optional(),
    limitations: z.array(nonEmptyBoundedString).max(1_024).optional(),
  }).strict().superRefine((evidence, context) => {
    if ((evidence.detectedPowerAcquisitionQualification === undefined)
      !== (evidence.detectedPowerSelectionCondition === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Detected-power qualification and selection condition must be present together',
      });
    }
    if (evidence.detectedPowerSelectionCondition === 'operator-preferred-current-target'
      && !evidence.limitations?.includes('zero-span-operator-preferred-target-selection')) {
      context.addIssue({
        code: 'custom',
        message: 'Operator-preferred detected power requires its explicit selection limitation',
      });
    }
  }),
}).strict();

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
