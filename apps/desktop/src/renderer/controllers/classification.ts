import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import {
  accumulateModulationConsensus,
  emptyModulationConsensus,
} from '../classification-consensus.js';
import { decodeComplexIqChannels, type ComplexIqMeasurement } from '../complex-iq.js';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import type { ClassificationWorkerRequest, ClassificationWorkerResponse } from '../classification-worker-protocol.js';
import type { RendererKernel } from './kernel.js';

// Atom-Classifier is trained and independently evaluated on contiguous 4K
// prefixes. Keep that model geometry separate from the larger recovery window.
const CLASSIFICATION_IQ_SAMPLES = 4_096;

export interface ClassificationExecutor {
  classifyIq(real: Float64Array, imaginary: Float64Array, bandwidthHz: number): Promise<ModulationClassification>;
  classifyScalar(
    powerDbm: readonly number[],
    frequencyHz: readonly number[],
    centerHz: number,
    bandwidthHz: number,
  ): Promise<ModulationClassification | undefined>;
  dispose(): void;
}

type ClassificationEvidence =
  | {
      readonly source: 'iq'; readonly key: string; readonly scope: string;
      readonly capture: ComplexIqMeasurement;
    }
  | {
      readonly source: 'scalar'; readonly key: string; readonly scope: string;
      readonly sweep: Sweep; readonly target: DetectedSignal;
    };

/**
 * Application-global classifier. Acquisition publishes evidence here once;
 * workspaces only render the shared projection. Every complete input is offered
 * for instantaneous classification, and every successful result is one sample.
 * One worker job runs at a time and one newest pending input replaces stale
 * queued work; successful posteriors are integrated over a timestamped trailing
 * 500 ms window.
 */
export class ClassificationController {
  private readonly executor: ClassificationExecutor;
  private latest: ClassificationEvidence | undefined;
  private inFlight = false;
  private inFlightKey: string | undefined;
  private inFlightGeneration: number | undefined;
  private lastCompletedKey: string | undefined;
  private activeScope: string | undefined;
  private generation = 0;
  private consensus = emptyModulationConsensus();
  private disposed = false;

  constructor(
    private readonly k: RendererKernel,
    executor: ClassificationExecutor = createClassificationExecutor(),
    private readonly nowMilliseconds: () => number = () => performance.now(),
  ) {
    this.executor = executor;
  }

  ingestIq(capture: ComplexIqMeasurement): void {
    const scope = JSON.stringify([
      capture.sessionId,
      'iq',
      capture.producerConfigurationEpoch ?? null,
      capture.centerHz,
      capture.sampleRateHz,
      capture.bandwidthHz,
      capture.sampleFormat,
      capture.sampleCount,
    ]);
    this.submit({
      source: 'iq',
      key: JSON.stringify([scope, capture.measurementId]),
      scope,
      capture,
    });
  }

  ingestScalar(sweep: Sweep, target: DetectedSignal): void {
    const scope = `${this.k.state.instrument.session?.sessionId ?? 'disconnected'}:scalar:${JSON.stringify(sweep.requested)}:${target.id}`;
    this.submit({
      source: 'scalar',
      key: JSON.stringify([scope, sweep.id, target.id]),
      scope,
      sweep,
      target,
    });
  }

  reset(clearResult = true): void {
    this.generation += 1;
    this.latest = undefined;
    this.lastCompletedKey = undefined;
    this.activeScope = undefined;
    this.consensus = emptyModulationConsensus();
    this.k.set({
      classification: {
        source: 'none',
        pending: false,
        sampleCount: 0,
        result: clearResult ? undefined : this.k.state.classification.result,
      },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset(true);
    this.disposed = true;
    this.executor.dispose();
  }

  private submit(evidence: ClassificationEvidence): void {
    if (this.disposed) return;
    if (evidence.scope !== this.activeScope) {
      this.generation += 1;
      this.activeScope = evidence.scope;
      this.consensus = emptyModulationConsensus();
      this.latest = undefined;
      this.lastCompletedKey = undefined;
      this.k.set({ classification: { source: evidence.source, pending: true, sampleCount: 0, result: undefined } });
    }
    if ((evidence.key === this.inFlightKey && this.inFlightGeneration === this.generation)
      || evidence.key === this.latest?.key
      || evidence.key === this.lastCompletedKey) return;
    this.latest = evidence;
    // Once this scope has a projection, subsequent samples update it without a
    // second busy-state write on every capture.
    if (!this.k.state.classification.result && !this.k.state.classification.pending) {
      this.k.set({ classification: { ...this.k.state.classification, source: evidence.source, pending: true } });
    }
    this.drain();
  }

  private drain(): void {
    if (this.disposed || this.inFlight || !this.latest) return;
    const evidence = this.latest;
    this.latest = undefined;
    const generation = this.generation;
    this.inFlight = true;
    this.inFlightKey = evidence.key;
    this.inFlightGeneration = generation;
    let classification: Promise<ModulationClassification | undefined>;
    try {
      classification = evidence.source === 'iq'
        ? this.classifyIq(evidence.capture)
        : this.executor.classifyScalar(
            evidence.sweep.powerDbm,
            evidence.sweep.frequencyHz,
            evidence.target.peakHz,
            evidence.target.bandwidthHz,
          );
    } catch (failure) {
      classification = Promise.reject(failure);
    }
    void classification.then(
      (result) => {
        if (this.disposed
          || generation !== this.generation
          || evidence.scope !== this.activeScope
          || !result) return;
        this.lastCompletedKey = evidence.key;
        const next = accumulateModulationConsensus(
          this.consensus,
          result,
          this.nowMilliseconds(),
        );
        this.consensus = next.state;
        this.k.set({
          classification: {
            source: evidence.source,
            pending: false,
            sampleCount: next.projection.sampleCount,
            result: next.projection.result,
          },
        });
      },
      (failure) => {
        if (!this.disposed && generation === this.generation && evidence.scope === this.activeScope) {
          console.error('[ATOMIZER-CLASSIFICATION-WORKER] Classification sample failed', failure);
        }
      },
    ).finally(() => {
      this.inFlight = false;
      this.inFlightKey = undefined;
      this.inFlightGeneration = undefined;
      if (generation === this.generation && !this.latest && this.k.state.classification.pending) {
        this.k.set({ classification: { ...this.k.state.classification, pending: false } });
      }
      this.drain();
    }).catch((failure) => {
      if (!this.disposed && generation === this.generation && evidence.scope === this.activeScope) {
        console.error('[ATOMIZER-CLASSIFICATION] Trend projection failed', failure);
      }
    });
  }

  private classifyIq(capture: ComplexIqMeasurement): Promise<ModulationClassification> {
    const { re, im } = decodeComplexIqChannels(capture, CLASSIFICATION_IQ_SAMPLES);
    return this.executor.classifyIq(re, im, capture.bandwidthHz);
  }
}

class BrowserClassificationExecutor implements ClassificationExecutor {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, {
    readonly resolve: (result: ModulationClassification | undefined) => void;
    readonly reject: (reason: unknown) => void;
  }>();

  classifyIq(real: Float64Array, imaginary: Float64Array, bandwidthHz: number): Promise<ModulationClassification> {
    return this.dispatch({ id: ++this.nextId, kind: 'iq', real, imaginary, bandwidthHz })
      .then((result) => {
        if (!result) throw new Error('I/Q classifier returned no result');
        return result;
      });
  }

  classifyScalar(
    powerDbm: readonly number[],
    frequencyHz: readonly number[],
    centerHz: number,
    bandwidthHz: number,
  ): Promise<ModulationClassification | undefined> {
    return this.dispatch({
      id: ++this.nextId,
      kind: 'scalar',
      powerDbm,
      frequencyHz,
      centerHz,
      bandwidthHz,
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const { reject } of this.pending.values()) reject(new Error('Classification worker disposed'));
    this.pending.clear();
  }

  private dispatch(request: ClassificationWorkerRequest): Promise<ModulationClassification | undefined> {
    const worker = this.requireWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      try {
        if (request.kind === 'iq') worker.postMessage(request, [request.real.buffer, request.imaginary.buffer]);
        else worker.postMessage(request);
      } catch (failure) {
        this.pending.delete(request.id);
        reject(failure);
      }
    });
  }

  private requireWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../classification-worker.ts', import.meta.url), {
      type: 'module',
      name: 'atomizer-classification',
    });
    worker.onmessage = (event: MessageEvent<ClassificationWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    worker.onerror = (event) => {
      const failure = new Error(event.message || 'Classification worker failed');
      for (const { reject } of this.pending.values()) reject(failure);
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
    };
    this.worker = worker;
    return worker;
  }
}

class InlineClassificationExecutor implements ClassificationExecutor {
  async classifyIq(real: Float64Array, imaginary: Float64Array, bandwidthHz: number): Promise<ModulationClassification> {
    const { classifyIqModulation } = await import('../embedding-classifier-runtime.js');
    return classifyIqModulation(real, imaginary, bandwidthHz);
  }

  async classifyScalar(
    powerDbm: readonly number[],
    frequencyHz: readonly number[],
    centerHz: number,
    bandwidthHz: number,
  ): Promise<ModulationClassification | undefined> {
    const { classifyScalarSweep } = await import('../embedding-classifier-runtime.js');
    return classifyScalarSweep(powerDbm, frequencyHz, centerHz, bandwidthHz);
  }

  dispose(): void {}
}

function createClassificationExecutor(): ClassificationExecutor {
  return typeof Worker === 'undefined'
    ? new InlineClassificationExecutor()
    : new BrowserClassificationExecutor();
}
