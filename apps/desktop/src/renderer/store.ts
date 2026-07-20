import { useSyncExternalStore } from 'react';
import {
  channelMeasurementConfigurationSchema,
  analyzerConfigSchema,
  complexIqConfigurationSchema,
  envelopeStftConfigurationSchema,
  firmwareTraceVisibilitySchema,
  generatorConfigSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  measurementViewIdSchema,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  waterfallConfigurationSchema,
  zeroSpanConfigSchema,
  type AnalyzerConfig,
  type AtomizerInstrumentState,
  type ChannelMeasurementConfiguration,
  type DetectedSignal,
  type EnvelopeStftConfiguration,
  type FirmwareTraceFrame,
  type FirmwareTraceVisibility,
  type GeneratorConfig,
  type InstrumentCandidate,
  type InstrumentDiscoveryFailure,
  type InstrumentScreenFrame,
  type InstrumentSessionSnapshot,
  type MarkerConfiguration,
  type MarkerId,
  type MarkerSearchConfiguration,
  type MeasurementViewId,
  type SignalDetectionConfig,
  type SignalLabChannelState,
  type SpectrumDisplayConfiguration,
  type Sweep,
  type TraceBankConfiguration,
  type TraceFrame,
  type TraceId,
  type WaterfallConfiguration,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import { BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY, type EnvelopeClassification } from '@tinysa/analysis';
import {
  DEFAULT_ANALYZER,
  DEFAULT_GENERATOR,
  INITIAL_INSTRUMENT_STATE,
  type AcquisitionState,
  type GeneratorOutputState,
  type WorkspaceId,
} from './ui-contracts.js';
import { DEFAULT_COMPLEX_IQ_CONFIGURATION, type ComplexIqConfiguration, type ComplexIqMeasurement } from './complex-iq.js';

export const DEFAULT_DETECTION: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
export const DEFAULT_ZERO_SPAN: ZeroSpanConfig = {
  frequencyHz: 433_920_000,
  points: BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points,
  rbwKhz: 100,
  attenuationDb: 'auto',
  sweepTimeSeconds: BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds,
  trigger: { mode: 'auto' },
};
export const DEFAULT_TRACES: TraceBankConfiguration = traceBankConfigurationSchema.parse([
  { id: 1, mode: 'clear-write', averageCount: 8 },
  { id: 2, mode: 'blank', averageCount: 8 },
  { id: 3, mode: 'blank', averageCount: 8 },
  { id: 4, mode: 'blank', averageCount: 8 },
]);
export const DEFAULT_MARKERS: readonly MarkerConfiguration[] = Array.from({ length: 8 }, (_, index) => markerConfigurationSchema.parse({
  id: index + 1,
  enabled: false,
  traceId: 1,
  mode: 'normal',
  frequencyHz: 98_000_000,
  tracking: 'fixed',
}));
export const DEFAULT_MARKER_SEARCH: MarkerSearchConfiguration = { minimumLevelDbm: -90, minimumExcursionDb: 6 };
export const DEFAULT_DISPLAY: SpectrumDisplayConfiguration = { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 };
export const DEFAULT_WATERFALL: WaterfallConfiguration = { historyDepth: 35, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' };
export const DEFAULT_CHANNEL: ChannelMeasurementConfiguration = {
  centerHz: 98_000_000,
  mainBandwidthHz: 200_000,
  adjacentBandwidthHz: 200_000,
  channelSpacingHz: 200_000,
  adjacentChannelCount: 2,
  occupiedPowerPercent: 99,
  obwNoiseCorrection: 'none',
};
export const DEFAULT_STFT: EnvelopeStftConfiguration = { windowSize: 64, hopSize: 16, window: 'hann', removeDc: true, dynamicRangeDb: 80 };

// The Bayesian 2.4 GHz activity association retains up to 96 stable-geometry
// opportunities; keep enough complete sweeps to bind its latest eight positive
// looks and audit the full rolling opportunity provenance.
export const HISTORY_LIMIT = 128;

export function visibleMeasurementView(value: unknown): MeasurementViewId {
  const view = measurementViewIdSchema.parse(value);
  // `envelope-stft` remains an API/analysis primitive for compatibility, but
  // it has no first-class renderer route. Old persisted values and explicit
  // agent requests land on the visible spectrum rather than reviving the
  // removed Time/STFT navigation or workspace.
  return view === 'envelope-stft' ? 'spectrum' : view;
}

export type ContinuousAcquisitionMode = 'spectrum' | 'complex-iq';

/** The complete reactive renderer state. One frozen record, replaced whole. */
export interface AtomizerRendererState {
  readonly workspace: WorkspaceId;
  readonly measurementView: MeasurementViewId;
  readonly agentOpen: boolean;
  readonly instrument: AtomizerInstrumentState;
  readonly candidates: InstrumentCandidate[];
  readonly discoveryFailures: InstrumentDiscoveryFailure[];
  readonly selectedCandidateId: string | undefined;
  readonly connectionOpen: boolean;
  readonly connectionBusy: boolean;
  readonly analyzer: AnalyzerConfig;
  readonly generator: GeneratorConfig;
  readonly iqConfiguration: ComplexIqConfiguration;
  readonly detectionConfig: SignalDetectionConfig;
  readonly zeroConfig: ZeroSpanConfig;
  readonly traceConfiguration: TraceBankConfiguration;
  readonly traceFrames: readonly TraceFrame[];
  readonly firmwareTraceFrames: readonly FirmwareTraceFrame[];
  readonly visibleFirmwareTraceIds: FirmwareTraceVisibility;
  readonly activeTraceId: TraceId;
  readonly markers: readonly MarkerConfiguration[];
  readonly activeMarkerId: MarkerId;
  readonly markerSearchConfiguration: MarkerSearchConfiguration;
  readonly displayConfiguration: SpectrumDisplayConfiguration;
  readonly waterfallConfiguration: WaterfallConfiguration;
  readonly channelConfiguration: ChannelMeasurementConfiguration;
  readonly stftConfiguration: EnvelopeStftConfiguration;
  readonly sweep: Sweep | undefined;
  readonly history: readonly Sweep[];
  readonly detections: readonly DetectedSignal[];
  readonly explicitClassificationId: string | undefined;
  readonly zeroCapture: ZeroSpanCapture | undefined;
  readonly envelope: EnvelopeClassification | undefined;
  readonly diagnostics: readonly string[];
  readonly screenFrame: InstrumentScreenFrame | undefined;
  readonly iqCapture: ComplexIqMeasurement | undefined;
  readonly selectedProfile: string | undefined;
  readonly selectedSignalLabChannel: SignalLabChannelState | undefined;
  readonly acquisition: AcquisitionState;
  readonly continuous: boolean;
  readonly continuousMode: ContinuousAcquisitionMode;
  readonly instrumentTransactionActive: boolean;
  readonly remoteGestureActive: boolean;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  readonly detectedPowerTargetStagingFailure: string | undefined;
}

/** localStorage-persisted keys (`atomizer:v2:<name>`), written through on change. */
const PERSISTED_KEYS = {
  measurementView: 'measurement-view',
  analyzer: 'analyzer',
  generator: 'generator',
  iqConfiguration: 'complex-iq',
  detectionConfig: 'detector',
  zeroConfig: 'zero-span',
  traceConfiguration: 'traces',
  visibleFirmwareTraceIds: 'firmware-trace-visibility',
  markers: 'markers',
  markerSearchConfiguration: 'marker-search',
  displayConfiguration: 'spectrum-display',
  waterfallConfiguration: 'waterfall',
  channelConfiguration: 'channel-measurement',
  stftConfiguration: 'envelope-stft',
} as const satisfies Partial<Record<keyof AtomizerRendererState, string>>;
type PersistedKey = keyof typeof PERSISTED_KEYS;

/**
 * One plain store: a single frozen state record, `Object.is` per-key change
 * admission, a monotonically increasing `revision` bumped on every accepted
 * `set`, and write-through persistence for the preference keys. Controllers
 * read `get()` directly — it is always current; React binds via `useStore`.
 */
export class AtomizerStore {
  #state: AtomizerRendererState;
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  constructor(initial: AtomizerRendererState) {
    this.#state = Object.freeze({ ...initial });
  }

  get(): AtomizerRendererState { return this.#state; }
  get revision(): number { return this.#revision; }

  /** Apply a partial patch; keys whose value is `Object.is`-equal are ignored.
   * If nothing changed, neither `revision` nor subscribers are touched. */
  set(patch: Partial<AtomizerRendererState>): void {
    let next: Record<string, unknown> | undefined;
    const changed: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (Object.is(this.#state[key as keyof AtomizerRendererState], value)) continue;
      next ??= { ...this.#state };
      next[key] = value;
      changed.push(key);
    }
    if (!next) return;
    this.#state = Object.freeze(next) as unknown as AtomizerRendererState;
    this.#revision++;
    for (const key of changed) {
      if (key in PERSISTED_KEYS) saveStored(PERSISTED_KEYS[key as PersistedKey], this.#state[key as PersistedKey]);
    }
    for (const listener of [...this.#listeners]) listener();
  }

  update(mutate: (current: AtomizerRendererState) => Partial<AtomizerRendererState>): void {
    this.set(mutate(this.#state));
  }

  /** Functional single-key setter mirroring `Dispatch<SetStateAction<T>>`. */
  setKey<K extends keyof AtomizerRendererState>(
    key: K,
    value: AtomizerRendererState[K] | ((current: AtomizerRendererState[K]) => AtomizerRendererState[K]),
  ): void {
    const next = typeof value === 'function'
      ? (value as (current: AtomizerRendererState[K]) => AtomizerRendererState[K])(this.#state[key])
      : value;
    this.set({ [key]: next } as unknown as Partial<AtomizerRendererState>);
  }

  /** Persist every preference key once (mount parity with the former
   * per-key persistence effects, which also ran at mount and restored a
   * quarantined key's default back into storage). */
  persistAll(): void {
    for (const [key, name] of Object.entries(PERSISTED_KEYS)) {
      saveStored(name, this.#state[key as PersistedKey]);
    }
  }
}

export function createInitialRendererState(options: {
  readonly initialWorkspace: WorkspaceId;
  readonly initialAgentOpen: boolean;
}): AtomizerRendererState {
  return {
    workspace: options.initialWorkspace,
    measurementView: loadStored('measurement-view', visibleMeasurementView, 'spectrum'),
    agentOpen: options.initialAgentOpen,
    instrument: INITIAL_INSTRUMENT_STATE,
    candidates: [],
    discoveryFailures: [],
    selectedCandidateId: undefined,
    connectionOpen: false,
    connectionBusy: false,
    analyzer: loadStored('analyzer', analyzerConfigSchema.parse, DEFAULT_ANALYZER),
    generator: loadStored('generator', generatorConfigSchema.parse, DEFAULT_GENERATOR),
    iqConfiguration: loadStored('complex-iq', complexIqConfigurationSchema.parse, DEFAULT_COMPLEX_IQ_CONFIGURATION),
    detectionConfig: loadStored('detector', parseStoredDetection, DEFAULT_DETECTION),
    zeroConfig: loadStored('zero-span', zeroSpanConfigSchema.parse, DEFAULT_ZERO_SPAN),
    traceConfiguration: loadStored('traces', traceBankConfigurationSchema.parse, DEFAULT_TRACES),
    traceFrames: [],
    firmwareTraceFrames: [],
    visibleFirmwareTraceIds: loadStored('firmware-trace-visibility', firmwareTraceVisibilitySchema.parse, []),
    activeTraceId: 1,
    markers: loadStored('markers', parseMarkerBank, DEFAULT_MARKERS),
    activeMarkerId: 1,
    markerSearchConfiguration: loadStored('marker-search', markerSearchConfigurationSchema.parse, DEFAULT_MARKER_SEARCH),
    displayConfiguration: loadStored('spectrum-display', spectrumDisplayConfigurationSchema.parse, DEFAULT_DISPLAY),
    waterfallConfiguration: loadStored('waterfall', waterfallConfigurationSchema.parse, DEFAULT_WATERFALL),
    channelConfiguration: loadStored('channel-measurement', channelMeasurementConfigurationSchema.parse, DEFAULT_CHANNEL),
    stftConfiguration: loadStored('envelope-stft', envelopeStftConfigurationSchema.parse, DEFAULT_STFT),
    sweep: undefined,
    history: [],
    detections: [],
    explicitClassificationId: undefined,
    zeroCapture: undefined,
    envelope: undefined,
    diagnostics: [],
    screenFrame: undefined,
    iqCapture: undefined,
    selectedProfile: undefined,
    selectedSignalLabChannel: undefined,
    acquisition: 'idle',
    continuous: false,
    continuousMode: 'spectrum',
    instrumentTransactionActive: false,
    remoteGestureActive: false,
    error: undefined,
    notice: undefined,
    detectedPowerTargetStagingFailure: undefined,
  };
}

export function useStore<T>(store: AtomizerStore, selector: (state: AtomizerRendererState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

function loadStored<T>(name: string, parse: (value: unknown) => T, initial: T): T {
  const key = `atomizer:v2:${name}`;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? structuredClone(initial) : parse(JSON.parse(raw));
  } catch (failure) {
    // UI preferences are never evidence authority. A stale/corrupt value must
    // not make an otherwise healthy instrument renderer unrecoverable after a
    // reload; quarantine only the bad key and retain an explicit diagnostic.
    console.warn(`[Preferences] quarantined invalid ${name} state and restored its default`, failure);
    try { localStorage.removeItem(key); }
    catch (cleanupFailure) {
      console.warn(`[Preferences] could not remove invalid ${name} state`, cleanupFailure);
    }
    return structuredClone(initial);
  }
}

function saveStored(name: string, value: unknown): void {
  try { localStorage.setItem(`atomizer:v2:${name}`, JSON.stringify(value)); }
  catch (failure) {
    // Persistence failure must remain non-fatal; the in-memory controller
    // state is still authoritative for the current renderer lifetime.
    console.warn(`[Preferences] could not persist ${name} state`, failure);
  }
}

export function parseStoredDetection(value: unknown): SignalDetectionConfig {
  if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'minimumProminenceDb')) {
    return signalDetectionConfigSchema.parse({ ...value, minimumProminenceDb: DEFAULT_DETECTION.minimumProminenceDb });
  }
  return signalDetectionConfigSchema.parse(value);
}

export function parseMarkerBank(value: unknown): readonly MarkerConfiguration[] {
  if (!Array.isArray(value) || value.length !== 8) throw new Error('Marker bank must contain exactly eight markers');
  const markers = value.map((marker) => markerConfigurationSchema.parse(marker));
  if (new Set(markers.map((marker) => marker.id)).size !== 8) throw new Error('Marker bank must contain markers 1 through 8 exactly once');
  const legacyUntouchedDefault = markers.every((marker, index) => marker.id === index + 1
    && marker.enabled === (index === 0)
    && marker.traceId === 1
    && marker.mode === 'normal'
    && marker.frequencyHz === 98_000_000
    && marker.tracking === (index === 0 ? 'peak' : 'fixed')
    && marker.referenceMarkerId === undefined);
  if (legacyUntouchedDefault) return structuredClone(DEFAULT_MARKERS);
  return markers;
}

// --- Pure selectors (derived values; computed where consumed) ---

export function generatorOutputState(session: InstrumentSessionSnapshot | undefined): GeneratorOutputState {
  if (session?.rfOutput === 'on') return 'on';
  if (session?.rfOutput === 'unknown') return 'unknown';
  return 'off';
}

export function acquisitionModeForWorkspace(
  workspace: WorkspaceId,
  fallback: ContinuousAcquisitionMode,
): ContinuousAcquisitionMode {
  if (workspace === 'iq') return 'complex-iq';
  if (workspace === 'spectrum' || workspace === 'classification' || workspace === 'detection') return 'spectrum';
  return fallback;
}

export function selectSpectrumCapability(state: AtomizerRendererState) {
  return state.instrument.session?.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
}
export function selectDetectedPowerCapability(state: AtomizerRendererState) {
  return state.instrument.session?.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
}
export function selectIqCapability(state: AtomizerRendererState) {
  return state.instrument.session?.capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq');
}
export function selectGeneratorCapability(state: AtomizerRendererState) {
  return state.instrument.session?.capabilities.features.find((capability) => capability.kind === 'rf-generator');
}
export function selectSignalLabProfileCapability(state: AtomizerRendererState) {
  return state.instrument.session?.capabilities.features.find((capability) => capability.kind === 'signal-lab-profile-selection');
}
export function selectIqCaptureUnavailableReason(state: AtomizerRendererState): string | undefined {
  const signalLabProfileCapability = selectSignalLabProfileCapability(state);
  return signalLabProfileCapability?.iqProfileIds !== undefined
    && (state.selectedProfile === undefined || !signalLabProfileCapability.iqProfileIds.includes(state.selectedProfile))
    ? 'The selected SignalLab profile is not present in the source\'s admitted I/Q registry.'
    : undefined;
}

/** Streaming is background collection, not a global UI lock; see App shell. */
export function selectBusy(state: AtomizerRendererState, instrumentTransactionOwner: string | undefined): boolean {
  const backgroundIqBufferActive = state.continuous
    && state.continuousMode === 'complex-iq'
    && instrumentTransactionOwner === 'continuous-complex-iq-buffer';
  const operationBusy = state.acquisition === 'configuring' || state.acquisition === 'retuning'
    || state.acquisition === 'acquiring' || state.acquisition === 'stopping';
  return state.connectionBusy
    || (operationBusy && !backgroundIqBufferActive)
    || (state.instrumentTransactionActive && !backgroundIqBufferActive);
}

/** A running stream may be paused for one admitted remote tap. Every other
 * compound operation, and the tap itself, closes touch admission. */
export function selectTouchBusy(state: AtomizerRendererState): boolean {
  return state.connectionBusy || state.instrumentTransactionActive || state.remoteGestureActive
    || state.acquisition === 'configuring' || state.acquisition === 'retuning' || state.acquisition === 'acquiring';
}

export function selectAcquisitionDisabledReason(
  state: AtomizerRendererState,
  busy: boolean,
): string | undefined {
  const connected = state.instrument.session !== undefined;
  const contextualAcquisitionMode = acquisitionModeForWorkspace(state.workspace, state.continuousMode);
  const iqCapability = selectIqCapability(state);
  const spectrumCapability = selectSpectrumCapability(state);
  const iqCaptureUnavailableReason = selectIqCaptureUnavailableReason(state);
  const generatorOutput = generatorOutputState(state.instrument.session);
  return !connected
    ? `Connect an instrument source to acquire ${contextualAcquisitionMode === 'complex-iq' ? 'complex-I/Q' : 'spectrum'} data`
    : contextualAcquisitionMode === 'complex-iq' && iqCapability === undefined
      ? 'The connected instrument does not advertise complex-I/Q acquisition'
      : contextualAcquisitionMode === 'complex-iq' && iqCaptureUnavailableReason
        ? iqCaptureUnavailableReason
        : contextualAcquisitionMode === 'spectrum' && spectrumCapability === undefined
          ? 'The connected instrument does not advertise swept-spectrum acquisition'
      : generatorOutput !== 'off'
        ? generatorOutput === 'on'
          ? 'Disable RF output before acquiring spectrum data'
          : 'RF output state must be known off before acquiring spectrum data'
        : busy
          ? 'Another instrument operation is active'
          : undefined;
}
