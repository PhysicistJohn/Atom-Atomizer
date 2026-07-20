import {
  signalDetectionConfigSchema,
  type AnalyzerConfig,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentFeatureExecution,
  type DetectedPowerCaptureReceipt,
  type InstrumentCandidate,
  type InstrumentConfigurationState,
  type InstrumentFeatureRequest,
  type InstrumentSessionSnapshot,
  type SignalDetectionConfig,
  type SweptSpectrumConfiguration,
  type DetectedPowerTimeseriesConfiguration,
} from '@tinysa/contracts';
import { SignalDetector, SignalTracker, TraceAccumulator } from '@tinysa/analysis';
import { assertWorkspaceTransition, type GeneratorOutputState, type WorkspaceId } from '../ui-contracts.js';
import { RevisionGuard } from '../revision-guard.js';
import { RenderCommitGate } from '../render-commit.js';
import type { ComplexIqConfiguration } from '../complex-iq.js';
import {
  acquisitionModeForWorkspace,
  generatorOutputState,
  HISTORY_LIMIT,
  type AtomizerRendererState,
  type AtomizerStore,
  type ContinuousAcquisitionMode,
} from '../store.js';
import type { InstrumentEventsController } from './instrument-events.js';
import type { ConnectionController } from './connection.js';
import type { AcquisitionController } from './acquisition.js';
import type { MeasurementController } from './measurement.js';
import type { FeaturesController } from './features.js';
import type { AgentExecutor } from '../agent-executor.js';

// One immutable configuration per retained sweep, plus bounded room for the
// active mode, zero-span evidence, retune overlap, and admitted async work.
export const CONFIGURATION_REVISION_LIMIT = HISTORY_LIMIT + 32;
export const INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS = 2_000;
export const CONTINUOUS_IQ_TRANSACTION = 'continuous-complex-iq-buffer';

export type RendererConfigurationRevision =
  | { readonly kind: 'swept-spectrum'; readonly admitted: SweptSpectrumConfiguration }
  | { readonly kind: 'detected-power-timeseries'; readonly admitted: DetectedPowerTimeseriesConfiguration }
  | { readonly kind: 'complex-iq'; readonly admitted: ComplexIqConfiguration };

export interface ContinuousStreamOwnership {
  readonly generation: number;
  readonly sessionId: string;
  readonly configurationRevision: string;
}

export interface ContinuousIqConfigurationOwnership {
  readonly sessionId: string;
  readonly stagedRevision: number;
  readonly configuration: ComplexIqConfiguration;
  readonly configured: InstrumentConfigurationState;
}

export interface ContinuousMeasurementWork {
  readonly ownership: ContinuousStreamOwnership;
  readonly session: InstrumentSessionSnapshot;
  readonly measurement: Extract<AtomizerInstrumentEvent, { type: 'measurement' }>['measurement'];
}

export interface ContinuousMeasurementStopRequest {
  readonly ownership: ContinuousStreamOwnership;
  readonly message: string;
}

export interface OperatorContinuousStopRequest {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export type InvalidatingFeatureRequest =
  | Extract<InstrumentFeatureRequest, { kind: 'signal-lab-profile-selection' }>
  | Extract<InstrumentFeatureRequest, { kind: 'touch' }>
  | Extract<InstrumentFeatureRequest, { kind: 'rf-generator'; action: 'configure' }>;
export type FeatureResultEvent = Extract<AtomizerInstrumentEvent, { type: 'feature-result' }>;
export type ConfigurationInvalidatedEvent = Extract<AtomizerInstrumentEvent, { type: 'configuration-invalidated' }>;

export interface InvalidatingFeatureReceipt {
  readonly request: InvalidatingFeatureRequest;
  readonly sessionId: string;
  readonly reason: ConfigurationInvalidatedEvent['reason'];
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: number;
  execution?: AtomizerInstrumentFeatureExecution;
  featureResult?: FeatureResultEvent;
  invalidation?: ConfigurationInvalidatedEvent;
  settled: boolean;
}

export interface Ref<T> { current: T }
const ref = <T,>(current: T): Ref<T> => ({ current });

/**
 * Shared operational spine for the plain (non-React) controllers. Holds the
 * store, the render-commit gate, every non-reactive ref that used to live on
 * the App component instance, and late-bound references to the controllers so
 * their verbatim-moved bodies can keep calling one another.
 */
export class RendererKernel {
  readonly store: AtomizerStore;
  readonly renderCommit: RenderCommitGate;

  events!: InstrumentEventsController;
  connection!: ConnectionController;
  acquisition!: AcquisitionController;
  measurement!: MeasurementController;
  features!: FeaturesController;
  agent!: AgentExecutor;

  readonly detector: Ref<SignalDetector>;
  readonly tracker: Ref<SignalTracker>;
  readonly traceAccumulator: Ref<TraceAccumulator>;
  readonly zeroCaptureReceiptRef = ref<DetectedPowerCaptureReceipt | undefined>(undefined);
  readonly analyzerRevision = ref(0);
  readonly agentConnectionCandidates = ref(new Map<string, InstrumentCandidate>());
  readonly configurationRevisions = ref(new RevisionGuard<RendererConfigurationRevision>(CONFIGURATION_REVISION_LIMIT));
  readonly continuousRequested = ref(false);
  readonly continuousStreamGeneration = ref(0);
  readonly continuousStreamOwnership = ref<ContinuousStreamOwnership | undefined>(undefined);
  readonly continuousIqTask = ref<Promise<void> | undefined>(undefined);
  readonly continuousIqGeneration = ref(0);
  readonly continuousIqBufferTask = ref<Promise<unknown> | undefined>(undefined);
  readonly continuousIqPauseDepth = ref(0);
  readonly continuousIqResumeWaiters = ref(new Set<() => void>());
  readonly continuousIqConfigurationOwnership = ref<ContinuousIqConfigurationOwnership | undefined>(undefined);
  readonly iqConfigurationRevision = ref(0);
  readonly pendingInvalidatingFeatureReceipt = ref<InvalidatingFeatureReceipt | undefined>(undefined);
  readonly continuousMeasurementStopRequest = ref<ContinuousMeasurementStopRequest | undefined>(undefined);
  readonly continuousMeasurementStopTask = ref<Promise<void> | undefined>(undefined);
  readonly failedContinuousMeasurementStopGeneration = ref<number | undefined>(undefined);
  readonly operatorContinuousStopRequest = ref<OperatorContinuousStopRequest | undefined>(undefined);
  readonly operatorContinuousStopTask = ref<Promise<void> | undefined>(undefined);
  readonly analyzerRetuneTask = ref<Promise<void> | undefined>(undefined);
  readonly instrumentTransactionOwner = ref<string | undefined>(undefined);
  readonly remoteGestureTask = ref<Promise<void> | undefined>(undefined);
  readonly analysisSequence = ref(0);
  readonly instrumentStateEventSequence = ref(0);
  readonly instrumentDiscoveryEventSequence = ref(0);
  readonly initializationGeneration = ref(0);

  constructor(store: AtomizerStore) {
    this.store = store;
    this.renderCommit = new RenderCommitGate(store);
    const state = store.get();
    this.detector = ref(new SignalDetector(state.detectionConfig));
    this.tracker = ref(new SignalTracker(state.detectionConfig));
    this.traceAccumulator = ref(new TraceAccumulator(state.traceConfiguration));
  }

  get rendererMounted(): Ref<boolean> { return this.renderCommit.mounted; }
  get state(): AtomizerRendererState { return this.store.get(); }
  set(patch: Partial<AtomizerRendererState>): void { this.store.set(patch); }
  setKey: AtomizerStore['setKey'] = (key, value) => this.store.setKey(key, value);

  requireConnected(): InstrumentSessionSnapshot {
    const active = this.state.instrument.session;
    if (!active) throw new Error('Connect an instrument source before running this operation');
    return active;
  }

  /** Reconfigure the shared signal detector/tracker and clear stale detections
   * plus any detected-power envelope bound to the previous criteria. */
  applyDetectionConfiguration(input: SignalDetectionConfig): SignalDetectionConfig {
    const next = signalDetectionConfigSchema.parse(input);
    if (JSON.stringify(next) === JSON.stringify(this.state.detectionConfig)) return this.state.detectionConfig;
    this.detector.current.configure(next);
    this.tracker.current.configure(next);
    this.analysisSequence.current++;
    this.set({ detectionConfig: next, detections: [] });
    this.clearZeroSpanCapture();
    return next;
  }

  /** Drop the retained detected-power (zero-span) capture and its envelope. */
  clearZeroSpanCapture(): void {
    this.zeroCaptureReceiptRef.current = undefined;
    this.set({ zeroCapture: undefined, envelope: undefined });
  }

  currentGeneratorOutput(): GeneratorOutputState {
    return generatorOutputState(this.state.instrument.session);
  }

  applyWorkspace(next: WorkspaceId): void {
    const canonical = next === 'detection' ? 'classification' : next;
    assertWorkspaceTransition(this.state.workspace, canonical, this.currentGeneratorOutput());
    if (canonical === 'iq' && !this.state.instrument.session?.capabilities.acquisitions.some((capability) => capability.kind === 'complex-iq')) {
      throw new Error('The connected instrument does not advertise complex-I/Q acquisition');
    }
    this.set({ workspace: canonical, error: undefined });
    // Run follows the operator: entering or leaving the I/Q workspace during
    // continuous acquisition swaps the stream so the visible viewer is live.
    if (this.state.continuous
      && acquisitionModeForWorkspace(canonical, this.state.continuousMode) !== this.state.continuousMode) {
      void this.acquisition.retargetContinuousForWorkspace();
    }
  }

  changeWorkspace(next: WorkspaceId): void {
    try { this.applyWorkspace(next); }
    catch (value) { this.set({ error: errorMessage(value) }); }
  }

  invalidateAcquiredEvidence(clearInstrumentConfigurations = false): void {
    this.analysisSequence.current++;
    if (clearInstrumentConfigurations) {
      this.acquisition.releaseContinuousIqConfiguration();
      this.configurationRevisions.current.clear();
      this.set({ iqCapture: undefined });
    }
    this.traceAccumulator.current.reset();
    this.tracker.current.reset();
    this.set({
      sweep: undefined,
      history: [],
      traceFrames: this.traceAccumulator.current.frames(),
      firmwareTraceFrames: [],
      detections: [],
      explicitClassificationId: undefined,
      detectedPowerTargetStagingFailure: undefined,
    });
    this.clearZeroSpanCapture();
  }
}

// --- Shared plain helpers (moved verbatim from App.tsx) ---

export function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }

export function evaluateAnalysis<T>(operation: () => T): { ok: true; result: T } | { ok: false; error: string } {
  try { return { ok: true, result: operation() }; }
  catch (value) { return { ok: false, error: errorMessage(value) }; }
}

export function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function sameOptionalStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
}

export function sameStructuredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalStructuredValue(left)) === JSON.stringify(canonicalStructuredValue(right));
}

function canonicalStructuredValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(canonicalStructuredValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalStructuredValue(nested)]));
  }
  return value;
}

export function sameAnalyzerConfiguration(left: AnalyzerConfig, right: AnalyzerConfig): boolean {
  return left.startHz === right.startHz
    && left.stopHz === right.stopHz
    && left.points === right.points
    && left.acquisitionFormat === right.acquisitionFormat
    && left.rbwKhz === right.rbwKhz
    && left.attenuationDb === right.attenuationDb
    && left.sweepTimeSeconds === right.sweepTimeSeconds
    && left.detector === right.detector
    && left.spurRejection === right.spurRejection
    && left.lna === right.lna
    && left.avoidSpurs === right.avoidSpurs
    && left.trigger.mode === right.trigger.mode
    && (left.trigger.mode === 'auto' || (right.trigger.mode !== 'auto' && left.trigger.levelDbm === right.trigger.levelDbm));
}

export function invalidatingFeatureReason(
  request: InstrumentFeatureRequest,
): ConfigurationInvalidatedEvent['reason'] | undefined {
  if (request.kind === 'signal-lab-profile-selection') {
    return request.action === 'select-profile' ? 'source-profile-changed' : 'source-channel-changed';
  }
  if (request.kind === 'touch'
    || (request.kind === 'rf-generator' && request.action === 'configure')) {
    return 'instrument-mode-changed';
  }
  return undefined;
}

export function isInvalidatingFeatureRequest(request: InstrumentFeatureRequest): request is InvalidatingFeatureRequest {
  return request.kind === 'signal-lab-profile-selection'
    || request.kind === 'touch'
    || (request.kind === 'rf-generator' && request.action === 'configure');
}

export function featureResultAcknowledgesRequest(
  result: import('@tinysa/contracts').InstrumentFeatureResult,
  request: InvalidatingFeatureRequest,
): boolean {
  if (result.sessionId.trim().length === 0
    || result.kind !== request.kind
    || result.action !== request.action) return false;
  const resultRecord = result as unknown as Record<string, unknown>;
  return Object.entries(request).every(([key, value]) => sameStructuredValue(resultRecord[key], value));
}
