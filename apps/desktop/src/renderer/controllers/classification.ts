import type {
  DetectedSignal,
  InstrumentSessionSnapshot,
  Sweep,
} from '@tinysa/contracts';
import {
  accumulateModulationConsensus,
  emptyModulationConsensus,
} from '../classification-consensus.js';
import { decodeComplexIqChannels, type ComplexIqMeasurement } from '../complex-iq.js';
import type {
  IqClassifierPrototypeSource,
  ModulationClassification,
  TrustedIqGeometryContext,
} from '../embedding-classifier-runtime.js';
import {
  admitTrustedIqGeometryContext,
  TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
} from '../iq-classification-geometry.js';
import type { ClassificationWorkerRequest, ClassificationWorkerResponse } from '../classification-worker-protocol.js';
import type { RendererKernel } from './kernel.js';
import { prototypeSourceForAcquisitionV4 } from '../../../../../../Atom-Classifier/src/embedding/time-domain-profile-routing-v4.js';

// Frozen observation geometry. Prefixes are contiguous: no plotting-style
// subsampling is allowed at this boundary. The v4 gate buckets its own
// trained 4K / 8K / 16K prefixes internally, and the schema-5 classifier
// canonicalizes trusted-current observations to its effective first 4K. At
// the exact DACS sample rate the admitted prefix extends to the largest
// trained 20K / 50K / 200K dwell present in the capture for the exact-rate
// DACS v7 refinement.
const CLASSIFICATION_IQ_MIN_SAMPLES = 4_096;
const CLASSIFICATION_IQ_MEDIUM_SAMPLES = 8_192;
const CLASSIFICATION_IQ_LONG_SAMPLES = 16_384;
const CLASSIFICATION_IQ_DACS_SAMPLE_RATE_HZ = 20_000_000;
const CLASSIFICATION_IQ_DACS_SHORT_SAMPLES = 20_000;
const CLASSIFICATION_IQ_DACS_MEDIUM_SAMPLES = 50_000;
const CLASSIFICATION_IQ_DACS_LONG_SAMPLES = 200_000;
const CLASSIFICATION_IQ_UNAVAILABLE_MESSAGE =
  'Modulation classification requires at least 4,096 complex samples. Increase Complex samples to 4,096 or more, then capture again.';

type SignalLabProfileSelectionCapability = Extract<
  InstrumentSessionSnapshot['capabilities']['features'][number],
  { kind: 'signal-lab-profile-selection' }
>;

interface IqClassificationRoute {
  readonly prototypeSource: IqClassifierPrototypeSource;
  readonly trustedGeometry?: TrustedIqGeometryContext;
}

const FIXED_PROFILE_MEASUREMENT_QUALIFICATIONS = new Set([
  'independently-verified-digital-baseband',
  'derived-from-independently-verified-digital-baseband',
  'receiver-impaired-complex-baseband',
]);

function trustedCurrentGeometry(
  capture: ComplexIqMeasurement,
  feature: SignalLabProfileSelectionCapability,
): TrustedIqGeometryContext {
  const descriptor = feature.profiles.find(
    ({ profileId }) => profileId === feature.selectedProfileId,
  );
  const transport = feature.iqProfiles.find(
    ({ profileId }) => profileId === feature.selectedProfileId,
  );
  const nativeSampleRateHz = transport?.nativeSampleRateHz;
  const receipt = capture.transformReceipt;
  if (
    descriptor?.qualification !==
      'independently-verified-digital-baseband'
    || nativeSampleRateHz === null
    || nativeSampleRateHz === undefined
    || capture.nativeSampleRateHz !== nativeSampleRateHz
    || receipt === undefined
    || receipt.sourceSampleRateHz !== nativeSampleRateHz
    || receipt.outputSampleRateHz !== capture.sampleRateHz
    || !FIXED_PROFILE_MEASUREMENT_QUALIFICATIONS.has(capture.qualification)
  ) {
    throw new Error(
      'Current-route native geometry is unavailable or does not match the '
      + 'independently verified SignalLab fixed-profile capability',
    );
  }
  return admitTrustedIqGeometryContext({
    kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
    sampleRateHz: capture.sampleRateHz,
    nativeSampleRateHz,
  });
}

function iqClassificationRoute(
  capture: ComplexIqMeasurement,
  session: InstrumentSessionSnapshot | undefined,
): IqClassificationRoute {
  if (session?.sessionId !== capture.sessionId) {
    return {
      prototypeSource: prototypeSourceForAcquisitionV4('untagged'),
    };
  }
  if (session.provenance.sourceKind !== 'signal-lab') {
    return {
      prototypeSource: prototypeSourceForAcquisitionV4('physical-sdr'),
    };
  }
  if (
    capture.producerConfigurationEpoch === undefined
    || session.provenance.producerConfigurationEpoch
      !== capture.producerConfigurationEpoch
  ) {
    return {
      prototypeSource: prototypeSourceForAcquisitionV4('untagged'),
    };
  }
  const feature = session.capabilities.features.find(
    (candidate) => candidate.kind === 'signal-lab-profile-selection',
  );
  const prototypeSource = prototypeSourceForAcquisitionV4(
    'signal-lab',
    feature?.kind === 'signal-lab-profile-selection'
      ? feature.selectedProfileId
      : undefined,
  );
  if (prototypeSource === 'historical') return { prototypeSource };
  if (feature?.kind !== 'signal-lab-profile-selection') {
    throw new Error(
      'Current-route native geometry is unavailable because the SignalLab '
      + 'profile capability is missing',
    );
  }
  return {
    prototypeSource,
    trustedGeometry: trustedCurrentGeometry(capture, feature),
  };
}

/**
 * Select the admitted contiguous capture prefix for modulation classification.
 * Captures below the minimum independently tested geometry produce no sample.
 */
export function classificationIqPrefixLength(
  sampleCount: number,
  sampleRateHz?: number,
): number | undefined {
  if (!Number.isInteger(sampleCount) || sampleCount < CLASSIFICATION_IQ_MIN_SAMPLES) {
    return undefined;
  }
  if (sampleCount < CLASSIFICATION_IQ_MEDIUM_SAMPLES) return CLASSIFICATION_IQ_MIN_SAMPLES;
  if (sampleCount < CLASSIFICATION_IQ_LONG_SAMPLES) return CLASSIFICATION_IQ_MEDIUM_SAMPLES;
  if (sampleRateHz === CLASSIFICATION_IQ_DACS_SAMPLE_RATE_HZ) {
    if (sampleCount >= CLASSIFICATION_IQ_DACS_LONG_SAMPLES) return CLASSIFICATION_IQ_DACS_LONG_SAMPLES;
    if (sampleCount >= CLASSIFICATION_IQ_DACS_MEDIUM_SAMPLES) return CLASSIFICATION_IQ_DACS_MEDIUM_SAMPLES;
    if (sampleCount >= CLASSIFICATION_IQ_DACS_SHORT_SAMPLES) return CLASSIFICATION_IQ_DACS_SHORT_SAMPLES;
  }
  return CLASSIFICATION_IQ_LONG_SAMPLES;
}

export interface ClassificationExecutor {
  classifyIq(
    real: Float64Array,
    imaginary: Float64Array,
    bandwidthHz: number,
    sampleRateHz: number,
    prototypeSource: IqClassifierPrototypeSource,
    trustedGeometry?: TrustedIqGeometryContext,
  ): Promise<ModulationClassification>;
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
 * queued work; admitted distributions and candid abstentions are integrated
 * over a timestamped trailing 500 ms window.
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
      capture.nativeSampleRateHz ?? null,
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
        issue: undefined,
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
      this.k.set({
        classification: {
          source: evidence.source,
          pending: true,
          sampleCount: 0,
          result: undefined,
          issue: undefined,
        },
      });
    }
    if ((evidence.key === this.inFlightKey && this.inFlightGeneration === this.generation)
      || evidence.key === this.latest?.key
      || evidence.key === this.lastCompletedKey) return;
    this.latest = evidence;
    // Once this scope has a projection, subsequent samples update it without a
    // second busy-state write on every capture. A distinct retry does clear a
    // terminal issue immediately so the UI never attributes the prior
    // attempt's failure to work that has just been admitted.
    const current = this.k.state.classification;
    const beginsFirstProjection = !current.result && !current.pending;
    if (beginsFirstProjection || current.issue !== undefined) {
      this.k.set({
        classification: {
          ...current,
          source: evidence.source,
          pending: beginsFirstProjection ? true : current.pending,
          issue: undefined,
        },
      });
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
          || evidence.scope !== this.activeScope) return;
        if (!result) {
          this.lastCompletedKey = evidence.key;
          const issue = evidence.source === 'iq'
            && classificationIqPrefixLength(evidence.capture.sampleCount) === undefined
            ? { kind: 'unavailable' as const, message: CLASSIFICATION_IQ_UNAVAILABLE_MESSAGE }
            : undefined;
          this.k.set({
            classification: {
              ...this.k.state.classification,
              source: evidence.source,
              issue,
            },
          });
          return;
        }
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
            issue: undefined,
          },
        });
      },
      (failure) => {
        if (!this.disposed && generation === this.generation && evidence.scope === this.activeScope) {
          console.error('[ATOMIZER-CLASSIFICATION-WORKER] Classification sample failed', failure);
          this.k.set({
            classification: {
              ...this.k.state.classification,
              source: evidence.source,
              issue: {
                kind: 'failure',
                message: classificationFailureMessage(failure),
              },
            },
          });
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

  private classifyIq(capture: ComplexIqMeasurement): Promise<ModulationClassification | undefined> {
    const prefixLength = classificationIqPrefixLength(
      capture.sampleCount,
      capture.sampleRateHz,
    );
    if (prefixLength === undefined) return Promise.resolve(undefined);
    const { re, im } = decodeComplexIqChannels(capture, prefixLength);
    const route = iqClassificationRoute(
      capture,
      this.k.state.instrument.session,
    );
    return this.executor.classifyIq(
      re,
      im,
      capture.bandwidthHz,
      capture.sampleRateHz,
      route.prototypeSource,
      route.trustedGeometry,
    );
  }
}

function classificationFailureMessage(failure: unknown): string {
  const detail = failure instanceof Error
    ? failure.message.trim()
    : typeof failure === 'string'
      ? failure.trim()
      : '';
  return detail
    ? `Modulation classification failed: ${detail}. Capture again; if the problem continues, restart Atomizer.`
    : 'Modulation classification failed. Capture again; if the problem continues, restart Atomizer.';
}

class BrowserClassificationExecutor implements ClassificationExecutor {
  static readonly responseTimeoutMilliseconds = 15_000;
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, {
    readonly resolve: (result: ModulationClassification | undefined) => void;
    readonly reject: (reason: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }>();

  classifyIq(
    real: Float64Array,
    imaginary: Float64Array,
    bandwidthHz: number,
    sampleRateHz: number,
    prototypeSource: IqClassifierPrototypeSource,
    trustedGeometry?: TrustedIqGeometryContext,
  ): Promise<ModulationClassification> {
    return this.dispatch({
      id: ++this.nextId,
      kind: 'iq',
      real,
      imaginary,
      bandwidthHz,
      sampleRateHz,
      prototypeSource,
      ...(trustedGeometry === undefined ? {} : { trustedGeometry }),
    })
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
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    this.rejectAll(new Error('Classification worker disposed'));
  }

  private dispatch(request: ClassificationWorkerRequest): Promise<ModulationClassification | undefined> {
    const worker = this.requireWorker();
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (!this.pending.has(request.id)) return;
        this.failWorker(
          worker,
          new Error(
            `Classification worker did not respond within ${BrowserClassificationExecutor.responseTimeoutMilliseconds / 1_000} seconds`,
          ),
        );
      }, BrowserClassificationExecutor.responseTimeoutMilliseconds);
      this.pending.set(request.id, { resolve, reject, timeout });
      try {
        if (request.kind === 'iq') worker.postMessage(request, [request.real.buffer, request.imaginary.buffer]);
        else worker.postMessage(request);
      } catch (failure) {
        globalThis.clearTimeout(timeout);
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
      globalThis.clearTimeout(pending.timeout);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    worker.onerror = (event) => {
      this.failWorker(
        worker,
        new Error(event.message || 'Classification worker failed'),
      );
    };
    this.worker = worker;
    return worker;
  }

  private failWorker(worker: Worker, failure: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    worker.terminate();
    this.rejectAll(failure);
  }

  private rejectAll(failure: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      globalThis.clearTimeout(request.timeout);
      request.reject(failure);
    }
  }
}

class InlineClassificationExecutor implements ClassificationExecutor {
  async classifyIq(
    real: Float64Array,
    imaginary: Float64Array,
    bandwidthHz: number,
    sampleRateHz: number,
    prototypeSource: IqClassifierPrototypeSource,
    trustedGeometry?: TrustedIqGeometryContext,
  ): Promise<ModulationClassification> {
    const { classifyIqModulation } = await import('../embedding-classifier-runtime.js');
    return classifyIqModulation(
      real,
      imaginary,
      bandwidthHz,
      sampleRateHz,
      prototypeSource,
      trustedGeometry,
    );
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

export function createClassificationExecutor(): ClassificationExecutor {
  return typeof Worker === 'undefined'
    ? new InlineClassificationExecutor()
    : new BrowserClassificationExecutor();
}
