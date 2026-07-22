import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import { accumulateModulationConsensus, emptyModulationConsensus } from '../classification-consensus.js';
import { decodeComplexIqChannels, type ComplexIqMeasurement } from '../complex-iq.js';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import type { ClassificationWorkerRequest, ClassificationWorkerResponse } from '../classification-worker-protocol.js';
import type { RendererKernel } from './kernel.js';

export const GLOBAL_CLASSIFICATION_INTERVAL_MS = 500;
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
  | { readonly source: 'iq'; readonly key: string; readonly scope: string; readonly capture: ComplexIqMeasurement }
  | { readonly source: 'scalar'; readonly key: string; readonly scope: string; readonly sweep: Sweep; readonly target: DetectedSignal };

/**
 * Application-global classifier. Acquisition publishes evidence here once;
 * workspaces only render the shared projection. The newest complete input is
 * sampled at 500 ms with one worker job in flight and an eight-look FIFO.
 */
export class ClassificationController {
  private readonly executor: ClassificationExecutor;
  private latest: ClassificationEvidence | undefined;
  private timer: number | undefined;
  private inFlight = false;
  private lastKey: string | undefined;
  private activeScope: string | undefined;
  private generation = 0;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private consensus = emptyModulationConsensus();

  constructor(private readonly k: RendererKernel, executor: ClassificationExecutor = createClassificationExecutor()) {
    this.executor = executor;
  }

  ingestIq(capture: ComplexIqMeasurement): void {
    const geometry = `${capture.centerHz}:${capture.sampleRateHz}:${capture.bandwidthHz}:${capture.sampleFormat}`;
    this.latest = {
      source: 'iq',
      key: `iq:${capture.measurementId}`,
      scope: `${capture.sessionId}:iq:${capture.producerConfigurationEpoch ?? geometry}`,
      capture,
    };
    this.schedule();
  }

  ingestScalar(sweep: Sweep, target: DetectedSignal): void {
    this.latest = {
      source: 'scalar',
      key: `scalar:${sweep.id}:${target.id}`,
      scope: `${this.k.state.instrument.session?.sessionId ?? 'disconnected'}:scalar:${JSON.stringify(sweep.requested)}:${target.id}`,
      sweep,
      target,
    };
    this.schedule();
  }

  reset(clearResult = true): void {
    this.generation += 1;
    this.latest = undefined;
    this.lastKey = undefined;
    this.activeScope = undefined;
    this.consensus = emptyModulationConsensus();
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.k.set({
      classification: {
        source: 'none',
        pending: false,
        evidenceLooks: 0,
        result: clearResult ? undefined : this.k.state.classification.result,
      },
    });
  }

  dispose(): void {
    this.reset(true);
    this.executor.dispose();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.inFlight || !this.latest) return;
    const delay = Math.max(0, GLOBAL_CLASSIFICATION_INTERVAL_MS - (performance.now() - this.lastStartedAt));
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.processLatest();
    }, delay);
  }

  private async processLatest(): Promise<void> {
    const evidence = this.latest;
    if (!evidence || evidence.key === this.lastKey || this.inFlight) return;
    if (evidence.scope !== this.activeScope) {
      this.activeScope = evidence.scope;
      this.consensus = emptyModulationConsensus();
      this.k.set({ classification: { source: evidence.source, pending: false, evidenceLooks: 0, result: undefined } });
    }
    const generation = this.generation;
    this.inFlight = true;
    this.lastKey = evidence.key;
    this.lastStartedAt = performance.now();
    this.k.set({ classification: { ...this.k.state.classification, source: evidence.source, pending: true } });
    try {
      const result = evidence.source === 'iq'
        ? await this.classifyIq(evidence.capture)
        : await this.executor.classifyScalar(
            evidence.sweep.powerDbm,
            evidence.sweep.frequencyHz,
            evidence.target.peakHz,
            evidence.target.bandwidthHz,
          );
      if (generation !== this.generation || evidence.scope !== this.activeScope || !result) return;
      const next = accumulateModulationConsensus(this.consensus, result);
      this.consensus = next.state;
      this.k.set({
        classification: {
          source: evidence.source,
          pending: false,
          evidenceLooks: next.projection.lookCount,
          result: next.projection.result,
        },
      });
    } catch (failure) {
      console.error('[ATOMIZER-CLASSIFICATION-WORKER] Classification look failed', failure);
    } finally {
      this.inFlight = false;
      if (generation === this.generation && this.k.state.classification.pending) {
        this.k.set({ classification: { ...this.k.state.classification, pending: false } });
      }
      if (this.latest?.key !== this.lastKey) this.schedule();
    }
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
      if (request.kind === 'iq') worker.postMessage(request, [request.real.buffer, request.imaginary.buffer]);
      else worker.postMessage(request);
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
