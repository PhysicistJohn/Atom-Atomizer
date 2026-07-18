import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { CircleAlert, Download } from 'lucide-react';
import {
  atomizerInstrumentEventSchema,
  atomizerInstrumentFeatureExecutionSchema,
  atomizerInstrumentPreferenceStateSchema,
  atomizerInstrumentStateSchema,
  atomizerInstrumentStreamingStateSchema,
  analyzerConfigPatchSchema,
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
  complexIqConfigurationSchema,
  envelopeStftConfigurationSchema,
  generatorConfigSchema,
  instrumentConfigurationStateSchema,
  instrumentDiscoveryResultSchema,
  instrumentMeasurementSchema,
  instrumentSessionSnapshotSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  measurementViewIdSchema,
  projectDetectedPowerTuneHz,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  traceConfigurationSchema,
  waterfallConfigurationSchema,
  zeroSpanConfigSchema,
  type AnalyzerConfig,
  type AnalyzerConfigPatch,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentFeatureExecution,
  type AtomizerInstrumentPreferenceSelection,
  type AtomizerInstrumentState,
  type ChannelMeasurementConfiguration,
  type DetectedPowerCaptureReceipt,
  type DetectedSignal,
  type FirmwareTraceFrame,
  type FirmwareTraceId,
  type FirmwareTraceVisibility,
  type GeneratorConfig,
  type InstrumentCandidate,
  type InstrumentConfiguration,
  type InstrumentConfigurationState,
  type SweptSpectrumConfiguration,
  type DetectedPowerTimeseriesConfiguration,
  type InstrumentDiscoveryFailure,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentScreenFrame,
  type InstrumentSessionSnapshot,
  type EnvelopeStftConfiguration,
  type MarkerConfiguration,
  type MarkerId,
  type MarkerSearchAction,
  type MarkerSearchConfiguration,
  type MeasurementViewId,
  type SignalDetectionConfig,
  type SignalLabChannelState,
  type SpectrumDisplayConfiguration,
  type Sweep,
  type TraceBankConfiguration,
  type TraceConfiguration,
  type TraceFrame,
  type TraceId,
  type WaterfallConfiguration,
  type WaveformClassification,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
  type ZeroSpanConfigPatch,
  firmwareTraceVisibilitySchema,
} from '@tinysa/contracts';
import {
  BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY,
  CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL,
  SignalDetector,
  SignalTracker,
  TraceAccumulator,
  autoScaleSpectrum,
  calculateSweepMetrics,
  classificationCaptureTargetRankEvidence,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  createDetectedPowerCaptureReceipt,
  extractObservableFeatures,
  measureChannel,
  ObservableEvidenceUnavailableError,
  observableAssociationEvidenceIsCurrentlyQualified,
  readMarkers,
  searchMarker,
  type ClassificationCaptureTargetProjection,
  type EnvelopeClassification,
  type WaveformEvidence,
} from '@tinysa/analysis';
import {
  ATOM_AGENT_MODEL,
  ATOM_AGENT_VERSION,
  ATOM_MAX_LOADED_TOOLS,
  ATOM_TOOL_LOADER_NAME,
  agentApiCoverage,
  agentControlBinding,
  agentControlBindings,
  agentToolDefinitions,
  agentToolPolicies,
  type AgentSemanticControlId,
  type AgentToolName,
} from '@tinysa/agent';
import { AtomAgentPanel } from './components/AtomAgentPanel.js';
import { ClassificationWorkspace } from './components/ClassificationWorkspace.js';
import { ConnectionDialog } from './components/ConnectionDialog.js';
import { DeviceWorkspace } from './components/DeviceWorkspace.js';
import { GeneratorWorkspace } from './components/GeneratorWorkspace.js';
import { IqWorkspace } from './components/IqWorkspace.js';
import { MeasurementWorkspace } from './components/MeasurementWorkspace.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import type { InstrumentScreenPoint } from './components/DeviceWorkspace.js';
import {
  assertWorkspaceTransition,
  DEFAULT_ANALYZER,
  DEFAULT_GENERATOR,
  INITIAL_INSTRUMENT_STATE,
  instrumentCandidateUiKey,
  sameInstrumentCandidateDescriptor,
  type AcquisitionState,
  type GeneratorOutputState,
  type WorkspaceId,
} from './ui-contracts.js';
import { projectDetectedPowerMeasurement, projectSpectrumMeasurement } from './instrument-measurement-projection.js';
import {
  resolveVisibleClassificationTargetSelection,
  sanitizeClassificationEvidenceDetections,
  visibleClassificationTargetProjectionAdmission,
  visibleClassificationTargetProjections,
  type ClassificationTargetSelection,
  type VisibleClassificationTargetProjectionAdmission,
} from './classification-target-selection.js';
import {
  exactClassificationEvidenceSweeps,
  selectVisibleClassificationRepresentative,
} from './classification-work-admission.js';
export {
  resolveClassificationTargetSelection,
  resolveVisibleClassificationTargetSelection,
} from './classification-target-selection.js';
import {
  detectedPowerConfigurationFor,
  reconcileAnalyzerConfiguration,
  reconcileDetectedPowerConfiguration,
  sameSweptSpectrumConfiguration,
  stageDetectedPowerConfigurationPatch,
  sweptSpectrumConfigurationFor,
} from './instrument-configuration.js';
import { agentClassificationResults, agentDetectionResults } from './agent-detection-results.js';
import { useAtomAgent } from './useAtomAgent.js';
import { BoundedRevisionCache, type RevisionCacheLease } from './bounded-revision-cache.js';
import {
  instrumentCandidateMatchesPreference,
  instrumentPreferenceSelectionForCandidate,
} from './instrument-preference.js';
import {
  createBayesianClassifierRuntime,
  type BayesianClassifierRuntime,
} from './bayesian-classifier-runtime.js';
import {
  DEFAULT_COMPLEX_IQ_CONFIGURATION,
  complexIqConfigurationFor,
  reconcileComplexIqConfiguration,
  sameComplexIqConfiguration,
  type ComplexIqConfiguration,
  type ComplexIqMeasurement,
} from './complex-iq.js';

const DEFAULT_DETECTION: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const DEFAULT_ZERO_SPAN: ZeroSpanConfig = {
  frequencyHz: 433_920_000,
  points: BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points,
  rbwKhz: 100,
  attenuationDb: 'auto',
  sweepTimeSeconds: BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds,
  trigger: { mode: 'auto' },
};

function visibleMeasurementView(value: unknown): MeasurementViewId {
  const view = measurementViewIdSchema.parse(value);
  // `envelope-stft` remains an API/analysis primitive for compatibility, but
  // it has no first-class renderer route. Old persisted values and explicit
  // agent requests land on the visible spectrum rather than reviving the
  // removed Time/STFT navigation or workspace.
  return view === 'envelope-stft' ? 'spectrum' : view;
}
// The Bayesian 2.4 GHz activity association retains up to 96 stable-geometry
// opportunities; keep enough complete sweeps to bind its latest eight positive
// looks and audit the full rolling opportunity provenance.
const HISTORY_LIMIT = 128;
// One immutable configuration per retained sweep, plus bounded room for the
// active mode, zero-span evidence, retune overlap, and admitted async work.
const CONFIGURATION_REVISION_LIMIT = HISTORY_LIMIT + 32;
const INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS = 2_000;
const CONTINUOUS_IQ_TRANSACTION = 'continuous-complex-iq-buffer';
type RendererConfigurationRevision =
  | { readonly kind: 'swept-spectrum'; readonly admitted: SweptSpectrumConfiguration }
  | { readonly kind: 'detected-power-timeseries'; readonly admitted: DetectedPowerTimeseriesConfiguration }
  | { readonly kind: 'complex-iq'; readonly admitted: ComplexIqConfiguration };
interface ContinuousStreamOwnership {
  readonly generation: number;
  readonly sessionId: string;
  readonly configurationRevision: string;
}
type ContinuousAcquisitionMode = 'spectrum' | 'complex-iq';
interface ContinuousIqConfigurationOwnership {
  readonly sessionId: string;
  readonly stagedRevision: number;
  readonly configuration: ComplexIqConfiguration;
  readonly configured: InstrumentConfigurationState;
  readonly lease: RevisionCacheLease<RendererConfigurationRevision>;
}
interface ContinuousMeasurementWork {
  readonly ownership: ContinuousStreamOwnership;
  readonly session: InstrumentSessionSnapshot;
  readonly measurement: InstrumentMeasurement;
}
interface ContinuousMeasurementStopRequest {
  readonly ownership: ContinuousStreamOwnership;
  readonly message: string;
}
interface OperatorContinuousStopRequest {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}
interface ClassificationWork {
  readonly revision: string;
  readonly sequence: number;
  readonly ownership?: ContinuousStreamOwnership;
  readonly visibleSweep: {
    readonly id: string;
    readonly sequence: number;
    readonly capturedAt: string;
  };
  readonly target: {
    readonly projectedRepresentativeId: string;
    readonly rawTargetId: string;
    readonly selectionOrigin: ClassificationTargetSelection['origin'];
  };
  readonly requests: readonly {
    readonly detection: DetectedSignal;
    readonly evidence: WaveformEvidence;
  }[];
}
interface ClassificationExecutionRecord {
  readonly work: ClassificationWork;
  readonly status: 'inference-pending' | 'ready' | 'failed';
  readonly results?: readonly WaveformClassification[];
  readonly error?: string;
}
interface DirectClassificationTaskRecord {
  readonly work: ClassificationWork;
  readonly promise: Promise<ClassificationExecutionRecord>;
  readonly abortController: AbortController;
}
interface FrozenAutomaticClassificationSnapshot {
  readonly visibleSweep?: Sweep;
  readonly detections: readonly DetectedSignal[];
  readonly history: readonly Sweep[];
  readonly analysisSequence: number;
  readonly rankingAdmission: VisibleClassificationTargetProjectionAdmission;
  readonly projections: readonly ClassificationCaptureTargetProjection[];
}
type AutomaticDetectedPowerStaging =
  | {
    readonly status: 'staged';
    readonly centerHz: number;
    readonly configuration: ZeroSpanConfig;
  }
  | {
    readonly status: 'unavailable';
    readonly reason: 'detected-power-capability-unavailable' | 'target-not-stageable';
    readonly error?: string;
    readonly centerHz: null;
    readonly configuration: null;
  }
  | {
    readonly status: 'not-requested';
    readonly reason: 'no-ranked-target';
    readonly centerHz: null;
    readonly configuration: null;
  };
interface AutomaticClassificationOperationRecord {
  readonly operationId: number;
  readonly snapshot: FrozenAutomaticClassificationSnapshot;
  readonly selection: ClassificationTargetSelection;
  readonly detectedPowerStaging: AutomaticDetectedPowerStaging;
  work?: ClassificationWork;
  execution?: ClassificationExecutionRecord;
  promise?: Promise<ClassificationExecutionRecord>;
  preferredSource?: Promise<ClassificationExecutionRecord>;
}
interface AutomaticClassificationDrainState {
  generation: number;
  abortController: AbortController;
  activeOperation: AutomaticClassificationOperationRecord;
  promise?: Promise<ClassificationExecutionRecord>;
}
type InvalidatingFeatureRequest =
  | Extract<InstrumentFeatureRequest, { kind: 'signal-lab-profile-selection' }>
  | Extract<InstrumentFeatureRequest, { kind: 'touch' }>
  | Extract<InstrumentFeatureRequest, { kind: 'rf-generator'; action: 'configure' }>;
type FeatureResultEvent = Extract<AtomizerInstrumentEvent, { type: 'feature-result' }>;
type ConfigurationInvalidatedEvent = Extract<AtomizerInstrumentEvent, { type: 'configuration-invalidated' }>;
interface InvalidatingFeatureReceipt {
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
interface RecordedSweep {
  readonly classification?: ClassificationWork;
}
const DEFAULT_TRACES: TraceBankConfiguration = traceBankConfigurationSchema.parse([
  { id: 1, mode: 'clear-write', averageCount: 8 },
  { id: 2, mode: 'blank', averageCount: 8 },
  { id: 3, mode: 'blank', averageCount: 8 },
  { id: 4, mode: 'blank', averageCount: 8 },
]);
const DEFAULT_MARKERS: readonly MarkerConfiguration[] = Array.from({ length: 8 }, (_, index) => markerConfigurationSchema.parse({
  id: index + 1,
  enabled: false,
  traceId: 1,
  mode: 'normal',
  frequencyHz: 98_000_000,
  tracking: 'fixed',
}));
const DEFAULT_MARKER_SEARCH: MarkerSearchConfiguration = { minimumLevelDbm: -90, minimumExcursionDb: 6 };
const DEFAULT_DISPLAY: SpectrumDisplayConfiguration = { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 };
const DEFAULT_WATERFALL: WaterfallConfiguration = { historyDepth: 35, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' };
const DEFAULT_CHANNEL: ChannelMeasurementConfiguration = {
  centerHz: 98_000_000,
  mainBandwidthHz: 200_000,
  adjacentBandwidthHz: 200_000,
  channelSpacingHz: 200_000,
  adjacentChannelCount: 2,
  occupiedPowerPercent: 99,
  obwNoiseCorrection: 'none',
};
const DEFAULT_STFT: EnvelopeStftConfiguration = { windowSize: 64, hopSize: 16, window: 'hann', removeDc: true, dynamicRangeDb: 80 };
const RENDER_COMMIT_TIMEOUT_MILLISECONDS = 2_000;

interface RenderCommitWaiter {
  targetRevision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
}

function useControllerState<T>(
  initialState: T | (() => T),
  markRenderMutation: () => void,
): [T, Dispatch<SetStateAction<T>>, MutableRefObject<T>] {
  const [value, setReactValue] = useState<T>(initialState);
  const valueRef = useRef(value);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    const previous = valueRef.current;
    const next = typeof update === 'function'
      ? (update as (current: T) => T)(previous)
      : update;
    if (Object.is(previous, next)) return;
    valueRef.current = next;
    markRenderMutation();
    setReactValue(next);
  }, [markRenderMutation]);
  return [value, setValue, valueRef];
}

export interface AppProps {
  /** Dependency seam for evidence-lifecycle tests; production uses the admitted bundled runtime. */
  readonly classifierRuntimeFactory?: () => BayesianClassifierRuntime;
  /** Optional launch workspace for browser deep links; desktop keeps the spectrum default. */
  readonly initialWorkspace?: WorkspaceId;
  /** Browser launch surfaces can start focused without opening the Atom agent panel. */
  readonly initialAgentOpen?: boolean;
}

export function App({
  classifierRuntimeFactory = createBayesianClassifierRuntime,
  initialWorkspace = 'spectrum',
  initialAgentOpen = true,
}: AppProps = {}) {
  const renderMutationRevision = useRef(0);
  const committedRenderRevision = useRef(0);
  const renderCommitWaiters = useRef(new Map<symbol, RenderCommitWaiter>());
  const rendererMounted = useRef(true);
  const markRenderMutation = useCallback(() => { renderMutationRevision.current++; }, []);

  const [workspace, setWorkspace, workspaceRef] = useControllerState<WorkspaceId>(initialWorkspace, markRenderMutation);
  const [measurementView, setMeasurementView, measurementViewRef] = useControllerState<MeasurementViewId>(() => loadStored('measurement-view', visibleMeasurementView, 'spectrum'), markRenderMutation);
  const [agentOpen, setAgentOpen] = useControllerState(initialAgentOpen, markRenderMutation);
  const [instrument, setInstrument, instrumentRef] = useControllerState<AtomizerInstrumentState>(INITIAL_INSTRUMENT_STATE, markRenderMutation);
  const [candidates, setCandidates, candidatesRef] = useControllerState<InstrumentCandidate[]>([], markRenderMutation);
  const [discoveryFailures, setDiscoveryFailures, discoveryFailuresRef] = useControllerState<InstrumentDiscoveryFailure[]>([], markRenderMutation);
  const [selectedCandidateId, setSelectedCandidateId, selectedCandidateIdRef] = useControllerState<string | undefined>(undefined, markRenderMutation);
  const [connectionOpen, setConnectionOpen] = useControllerState(false, markRenderMutation);
  const [connectionBusy, setConnectionBusy] = useControllerState(false, markRenderMutation);
  const [analyzer, setAnalyzer, analyzerRef] = useControllerState<AnalyzerConfig>(() => loadStored('analyzer', analyzerConfigSchema.parse, DEFAULT_ANALYZER), markRenderMutation);
  const [generator, setGenerator, generatorRef] = useControllerState<GeneratorConfig>(() => loadStored('generator', generatorConfigSchema.parse, DEFAULT_GENERATOR), markRenderMutation);
  const [iqConfiguration, setIqConfiguration, iqConfigurationRef] = useControllerState<ComplexIqConfiguration>(() => loadStored('complex-iq', complexIqConfigurationSchema.parse, DEFAULT_COMPLEX_IQ_CONFIGURATION), markRenderMutation);
  const [detectionConfig, setDetectionConfig, detectionConfigRef] = useControllerState<SignalDetectionConfig>(() => loadStored('detector', parseStoredDetection, DEFAULT_DETECTION), markRenderMutation);
  const [zeroConfig, setZeroConfig, zeroConfigRef] = useControllerState<ZeroSpanConfig>(() => loadStored('zero-span', zeroSpanConfigSchema.parse, DEFAULT_ZERO_SPAN), markRenderMutation);
  const [traceConfiguration, setTraceConfiguration, traceConfigurationRef] = useControllerState<TraceBankConfiguration>(() => loadStored('traces', traceBankConfigurationSchema.parse, DEFAULT_TRACES), markRenderMutation);
  const [traceFrames, setTraceFrames, traceFramesRef] = useControllerState<readonly TraceFrame[]>([], markRenderMutation);
  const [firmwareTraceFrames, setFirmwareTraceFrames, firmwareTraceFramesRef] = useControllerState<readonly FirmwareTraceFrame[]>([], markRenderMutation);
  const [visibleFirmwareTraceIds, setVisibleFirmwareTraceIds, visibleFirmwareTraceIdsRef] = useControllerState<FirmwareTraceVisibility>(() => loadStored('firmware-trace-visibility', firmwareTraceVisibilitySchema.parse, []), markRenderMutation);
  const [activeTraceId, setActiveTraceId, activeTraceIdRef] = useControllerState<TraceId>(1, markRenderMutation);
  const [markers, setMarkers, markersRef] = useControllerState<readonly MarkerConfiguration[]>(() => loadStored('markers', parseMarkerBank, DEFAULT_MARKERS), markRenderMutation);
  const [activeMarkerId, setActiveMarkerId, activeMarkerIdRef] = useControllerState<MarkerId>(1, markRenderMutation);
  const [markerSearchConfiguration, setMarkerSearchConfiguration, markerSearchConfigurationRef] = useControllerState<MarkerSearchConfiguration>(() => loadStored('marker-search', markerSearchConfigurationSchema.parse, DEFAULT_MARKER_SEARCH), markRenderMutation);
  const [displayConfiguration, setDisplayConfiguration, displayConfigurationRef] = useControllerState<SpectrumDisplayConfiguration>(() => loadStored('spectrum-display', spectrumDisplayConfigurationSchema.parse, DEFAULT_DISPLAY), markRenderMutation);
  const [waterfallConfiguration, setWaterfallConfiguration, waterfallConfigurationRef] = useControllerState<WaterfallConfiguration>(() => loadStored('waterfall', waterfallConfigurationSchema.parse, DEFAULT_WATERFALL), markRenderMutation);
  const [channelConfiguration, setChannelConfiguration, channelConfigurationRef] = useControllerState<ChannelMeasurementConfiguration>(() => loadStored('channel-measurement', channelMeasurementConfigurationSchema.parse, DEFAULT_CHANNEL), markRenderMutation);
  const [stftConfiguration, setStftConfiguration, stftConfigurationRef] = useControllerState<EnvelopeStftConfiguration>(() => loadStored('envelope-stft', envelopeStftConfigurationSchema.parse, DEFAULT_STFT), markRenderMutation);
  const [sweep, setSweep, sweepRef] = useControllerState<Sweep | undefined>(undefined, markRenderMutation);
  const [history, setHistory, historyRef] = useControllerState<readonly Sweep[]>([], markRenderMutation);
  const [detections, setDetections, detectionsRef] = useControllerState<readonly DetectedSignal[]>([], markRenderMutation);
  const [classifications, setClassifications, classificationsRef] = useControllerState<readonly WaveformClassification[]>([], markRenderMutation);
  const [explicitClassificationId, setExplicitClassificationId, explicitClassificationIdRef] = useControllerState<string | undefined>(undefined, markRenderMutation);
  const classificationTargetSelection = useMemo(
    () => resolveVisibleClassificationTargetSelection(
      detections,
      sweep,
      explicitClassificationId,
    ),
    [detections, explicitClassificationId, sweep],
  );
  const selectedClassificationId = classificationTargetSelection.detectionId;
  const [zeroCapture, setZeroCapture, zeroCaptureRef] = useControllerState<ZeroSpanCapture | undefined>(undefined, markRenderMutation);
  const [envelope, setEnvelope, envelopeRef] = useControllerState<EnvelopeClassification | undefined>(undefined, markRenderMutation);
  const [diagnostics, setDiagnostics, diagnosticsRef] = useControllerState<readonly string[]>([], markRenderMutation);
  const [screenFrame, setScreenFrame, screenFrameRef] = useControllerState<InstrumentScreenFrame | undefined>(undefined, markRenderMutation);
  const [iqCapture, setIqCapture, iqCaptureRef] = useControllerState<ComplexIqMeasurement | undefined>(undefined, markRenderMutation);
  const [selectedProfile, setSelectedProfile, selectedProfileRef] = useControllerState<string | undefined>(undefined, markRenderMutation);
  const [selectedSignalLabChannel, setSelectedSignalLabChannel, selectedSignalLabChannelRef] = useControllerState<SignalLabChannelState | undefined>(undefined, markRenderMutation);
  const [acquisition, setAcquisition, acquisitionRef] = useControllerState<AcquisitionState>('idle', markRenderMutation);
  const [continuous, setContinuous, continuousRef] = useControllerState(false, markRenderMutation);
  const [continuousMode, setContinuousMode, continuousModeRef] = useControllerState<ContinuousAcquisitionMode>('spectrum', markRenderMutation);
  const [instrumentTransactionActive, setInstrumentTransactionActive] = useControllerState(false, markRenderMutation);
  const [remoteGestureActive, setRemoteGestureActive] = useControllerState(false, markRenderMutation);
  const [error, setError, errorRef] = useControllerState<string | undefined>(undefined, markRenderMutation);
  const [notice, setNotice] = useControllerState<string | undefined>(undefined, markRenderMutation);
  const [detectedPowerTargetStagingFailure, setDetectedPowerTargetStagingFailure] = useControllerState<string | undefined>(undefined, markRenderMutation);
  const [classifierAvailability, setClassifierAvailability] = useState<'ready' | 'unavailable'>('ready');

  const detector = useRef(new SignalDetector(detectionConfig));
  const tracker = useRef(new SignalTracker(detectionConfig));
  const traceAccumulator = useRef(new TraceAccumulator(traceConfiguration));
  const stagedClassificationTargetIdRef = useRef<string | undefined>(undefined);
  const classificationSelectionRevision = useRef(0);
  const zeroCaptureReceiptRef = useRef<DetectedPowerCaptureReceipt | undefined>(undefined);
  const zeroCaptureSpectrumSweepIdsRef = useRef<readonly string[] | undefined>(undefined);
  const analyzerRevision = useRef(0);
  const agentConnectionCandidates = useRef(new Map<string, InstrumentCandidate>());
  const configurationRevisions = useRef(new BoundedRevisionCache<RendererConfigurationRevision>(CONFIGURATION_REVISION_LIMIT));
  const historyConfigurationRevisions = useRef<readonly string[]>([]);
  const zeroCaptureConfigurationRevision = useRef<string | undefined>(undefined);
  const streamingConfigurationLease = useRef<RevisionCacheLease<RendererConfigurationRevision> | undefined>(undefined);
  const continuousRequested = useRef(false);
  const continuousStreamGeneration = useRef(0);
  const continuousStreamOwnership = useRef<ContinuousStreamOwnership | undefined>(undefined);
  const continuousIqTask = useRef<Promise<void> | undefined>(undefined);
  const continuousIqGeneration = useRef(0);
  const continuousIqBufferTask = useRef<Promise<unknown> | undefined>(undefined);
  const continuousIqPauseDepth = useRef(0);
  const continuousIqResumeWaiters = useRef(new Set<() => void>());
  const continuousIqConfigurationOwnership = useRef<ContinuousIqConfigurationOwnership | undefined>(undefined);
  const iqConfigurationRevision = useRef(0);
  const classificationTask = useRef<Promise<ClassificationExecutionRecord> | undefined>(undefined);
  const classificationTaskWork = useRef<ClassificationWork | undefined>(undefined);
  const classificationTaskAbortController = useRef<AbortController | undefined>(undefined);
  const directClassificationTask = useRef<DirectClassificationTaskRecord | undefined>(undefined);
  const pendingClassificationWork = useRef<ClassificationWork | undefined>(undefined);
  const classificationExecution = useRef<ClassificationExecutionRecord | undefined>(undefined);
  const lastAutomaticClassificationOperation = useRef<AutomaticClassificationOperationRecord | undefined>(undefined);
  const automaticClassificationDrain = useRef<AutomaticClassificationDrainState | undefined>(undefined);
  const automaticClassificationDrainGeneration = useRef(0);
  const automaticClassificationOperationSequence = useRef(0);
  const pinnedAutomaticClassificationRevisions = useRef(new Map<string, number>());
  const lastPublishedClassificationSequence = useRef(0);
  const classifierRuntime = useRef<BayesianClassifierRuntime | undefined>(undefined);
  const pendingInvalidatingFeatureReceipt = useRef<InvalidatingFeatureReceipt | undefined>(undefined);
  const continuousMeasurementStopRequest = useRef<ContinuousMeasurementStopRequest | undefined>(undefined);
  const continuousMeasurementStopTask = useRef<Promise<void> | undefined>(undefined);
  const failedContinuousMeasurementStopGeneration = useRef<number | undefined>(undefined);
  const operatorContinuousStopRequest = useRef<OperatorContinuousStopRequest | undefined>(undefined);
  const operatorContinuousStopTask = useRef<Promise<void> | undefined>(undefined);
  const analyzerRetuneTask = useRef<Promise<void> | undefined>(undefined);
  const instrumentTransactionOwner = useRef<string | undefined>(undefined);
  const remoteGestureTask = useRef<Promise<void> | undefined>(undefined);
  const analysisSequence = useRef(0);
  const instrumentStateEventSequence = useRef(0);
  const instrumentDiscoveryEventSequence = useRef(0);
  const initializationGeneration = useRef(0);

  const session = instrument.session;
  const generatorOutput = generatorOutputState(session);
  const connected = session !== undefined;
  const transportBusy = false;
  // Streaming is background collection, not a global UI lock. Conflicting
  // transport/configuration operations own the explicit transaction gate and
  // pause/configure/resume the stream; host-derived controls and navigation
  // remain live throughout collection.
  const backgroundIqBufferActive = continuous
    && continuousMode === 'complex-iq'
    && instrumentTransactionOwner.current === 'continuous-complex-iq-buffer';
  const operationBusy = acquisition === 'configuring' || acquisition === 'retuning' || acquisition === 'acquiring' || acquisition === 'stopping';
  const busy = connectionBusy || transportBusy
    || (operationBusy && !backgroundIqBufferActive)
    || (instrumentTransactionActive && !backgroundIqBufferActive);
  // A running stream may be paused for one admitted remote tap. Every other
  // compound operation, and the tap itself, closes touch admission.
  const touchBusy = connectionBusy || transportBusy || instrumentTransactionActive || remoteGestureActive
    || acquisition === 'configuring' || acquisition === 'retuning' || acquisition === 'acquiring';
  const simulated = session !== undefined && session.provenance.execution !== 'physical';
  const spectrumCapability = session?.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
  const detectedPowerCapability = session?.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
  const iqCapability = session?.capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq');
  const generatorCapability = session?.capabilities.features.find((capability) => capability.kind === 'rf-generator');
  const signalLabProfileCapability = session?.capabilities.features.find((capability) => capability.kind === 'signal-lab-profile-selection');
  const iqCaptureUnavailableReason = signalLabProfileCapability?.iqProfileIds !== undefined
    && (selectedProfile === undefined || !signalLabProfileCapability.iqProfileIds.includes(selectedProfile))
    ? 'The selected SignalLab profile is not present in the source\'s admitted I/Q registry.'
    : undefined;
  const metrics = useMemo(() => sweep ? calculateSweepMetrics(sweep) : undefined, [sweep]);
  const markerReadings = useMemo(
    () => readMarkers(markers, traceFrames, detections),
    [markers, traceFrames, detections],
  );

  const renderedControllerRevision = renderMutationRevision.current;
  useLayoutEffect(() => {
    committedRenderRevision.current = Math.max(committedRenderRevision.current, renderedControllerRevision);
    for (const [id, waiter] of renderCommitWaiters.current) {
      if (waiter.targetRevision > committedRenderRevision.current) continue;
      window.clearTimeout(waiter.timeout);
      renderCommitWaiters.current.delete(id);
      waiter.resolve();
    }
  });

  useEffect(() => {
    rendererMounted.current = true;
    return () => {
      rendererMounted.current = false;
      for (const waiter of renderCommitWaiters.current.values()) {
        window.clearTimeout(waiter.timeout);
        waiter.reject(new Error('Atomizer renderer unmounted before the requested controller state committed'));
      }
      renderCommitWaiters.current.clear();
    };
  }, []);

  function awaitControllerRenderCommit(): Promise<void> {
    const targetRevision = renderMutationRevision.current;
    if (committedRenderRevision.current >= targetRevision) return Promise.resolve();
    if (!rendererMounted.current) return Promise.reject(new Error('Atomizer renderer is unavailable'));
    return new Promise<void>((resolve, reject) => {
      const id = Symbol('renderer-commit-waiter');
      const timeout = window.setTimeout(() => {
        renderCommitWaiters.current.delete(id);
        reject(new Error('Atomizer renderer did not commit the staged controller state before the bounded computer-action deadline'));
      }, RENDER_COMMIT_TIMEOUT_MILLISECONDS);
      renderCommitWaiters.current.set(id, { targetRevision, resolve, reject, timeout });
    });
  }

  useEffect(() => {
    if (!classifierRuntime.current) {
      const runtime = classifierRuntimeFactory();
      classifierRuntime.current = runtime;
      setClassifierAvailability(runtime.status);
    }
    const unsubscribe = window.atomizerInstrument.subscribe(handleInstrumentEvent);
    const generation = ++initializationGeneration.current;
    void initialize(generation);
    return () => {
      initializationGeneration.current++;
      pendingClassificationWork.current = undefined;
      if (continuousRequested.current && continuousStreamOwnership.current) {
        void stopInstrumentStreaming().catch((value) => {
          console.error('Continuous acquisition did not stop while the Atomizer renderer unmounted', value);
        });
      }
      continuousRequested.current = false;
      rejectInvalidatingFeatureReceipt(new Error('Atomizer renderer unmounted before the invalidating feature lifecycle settled'));
      unsubscribe();
      // React StrictMode immediately remounts effects on the same component
      // instance. Defer disposal one microtask so that replay can restore the
      // mounted flag; a real unmount still terminates the model worker.
      queueMicrotask(() => {
        if (!rendererMounted.current) {
          classifierRuntime.current?.classifier.dispose?.();
          classifierRuntime.current = undefined;
        }
      });
    };
  }, []);
  useEffect(() => saveStored('analyzer', analyzer), [analyzer]);
  useEffect(() => {
    setChannelConfiguration((current) => fitChannelConfigurationToSpan(current, analyzer.startHz, analyzer.stopHz));
  }, [analyzer.startHz, analyzer.stopHz]);
  useEffect(() => saveStored('generator', generator), [generator]);
  useEffect(() => saveStored('complex-iq', iqConfiguration), [iqConfiguration]);
  useEffect(() => saveStored('detector', detectionConfig), [detectionConfig]);
  useEffect(() => saveStored('zero-span', zeroConfig), [zeroConfig]);
  useEffect(() => saveStored('traces', traceConfiguration), [traceConfiguration]);
  useEffect(() => saveStored('firmware-trace-visibility', visibleFirmwareTraceIds), [visibleFirmwareTraceIds]);
  useEffect(() => saveStored('markers', markers), [markers]);
  useEffect(() => saveStored('marker-search', markerSearchConfiguration), [markerSearchConfiguration]);
  useEffect(() => saveStored('spectrum-display', displayConfiguration), [displayConfiguration]);
  useEffect(() => saveStored('measurement-view', measurementView), [measurementView]);
  useEffect(() => saveStored('waterfall', waterfallConfiguration), [waterfallConfiguration]);
  useEffect(() => saveStored('channel-measurement', channelConfiguration), [channelConfiguration]);
  useEffect(() => {
    if (explicitClassificationId !== undefined
      && classificationTargetSelection.explicitDetectionId === undefined) {
      classificationSelectionRevision.current++;
      setExplicitClassificationId(undefined);
      clearClassificationCapture();
      setClassifications([]);
    }
    safelyStageClassificationCandidate(
      classificationTargetSelection.rawTargetId ?? selectedClassificationId,
    );
  }, [detections, explicitClassificationId, classificationTargetSelection.explicitDetectionId, classificationTargetSelection.rawTargetId, selectedClassificationId]);
  useEffect(() => saveStored('envelope-stft', stftConfiguration), [stftConfiguration]);
  useEffect(() => {
    if (session && !generatorCapability && !signalLabProfileCapability && workspace === 'generator') setWorkspace('spectrum');
  }, [session, generatorCapability, signalLabProfileCapability, workspace]);
  useEffect(() => {
    if (session && !iqCapability && workspace === 'iq') setWorkspace('spectrum');
  }, [session, iqCapability, workspace]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  async function initialize(generation: number): Promise<void> {
    try {
      const stateEventSequence = instrumentStateEventSequence.current;
      const state = await getInstrumentState();
      if (!rendererMounted.current || initializationGeneration.current !== generation) return;
      // A subscribed lifecycle event is newer than a state snapshot whose IPC
      // request was still in flight. Never let that older snapshot disconnect or
      // deconfigure the renderer after the event has already been accepted.
      if (instrumentStateEventSequence.current === stateEventSequence) acceptInstrumentState(state);
      const discoveryEventSequence = instrumentDiscoveryEventSequence.current;
      const discovery = await discoverInstruments();
      if (!rendererMounted.current || initializationGeneration.current !== generation) return;
      if (instrumentDiscoveryEventSequence.current === discoveryEventSequence) {
        acceptDiscovery(discovery.candidates, discovery.failures);
      }
    } catch (value) {
      if (rendererMounted.current && initializationGeneration.current === generation) {
        setError(errorMessage(value));
      }
    }
  }

  function handleInstrumentEvent(value: unknown): void {
    try {
      handleValidatedInstrumentEvent(atomizerInstrumentEventSchema.parse(value));
    } catch (failure) {
      const detail = errorMessage(failure).replace(/\s+/g, ' ').slice(0, 480);
      const message = `Instrument event rejected at the renderer boundary: ${detail}`;
      setError(message);
      const ownership = continuousStreamOwnership.current;
      if (continuousRequested.current && ownership) {
        setAcquisition('failed');
        requestContinuousMeasurementStop(ownership, message);
      }
    }
  }

  function handleValidatedInstrumentEvent(event: AtomizerInstrumentEvent): void {
    if (event.type !== 'discovery' && event.type !== 'measurement') {
      instrumentStateEventSequence.current++;
    }
    if (event.type === 'discovery') {
      instrumentDiscoveryEventSequence.current++;
      acceptDiscovery(event.result.candidates, event.result.failures);
    }
    else if (event.type === 'connected') acceptSession(event.session);
    else if (event.type === 'configured') acceptConfiguration(event.configuration);
    else if (event.type === 'configuration-invalidated') {
      if (instrumentRef.current.session?.sessionId === event.sessionId) {
        invalidateAcquiredEvidence(true);
        acceptInstrumentState({ ...instrumentRef.current, session: event.session }, true);
        observeInvalidatingFeatureLifecycle(event);
      }
    }
    else if (event.type === 'session-state') {
      if (instrumentRef.current.session?.sessionId === event.session.sessionId) {
        if (event.reason === 'session-faulted') invalidateAcquiredEvidence(true);
        acceptInstrumentState({ ...instrumentRef.current, session: event.session });
      }
    }
    else if (event.type === 'disconnected') {
      if (instrumentRef.current.session?.sessionId !== event.sessionId) return;
      clearContinuousStreamOwnership();
      continuousRequested.current = false;
      wakeContinuousIqAdmissionWaiters();
      setContinuous(false);
      acceptInstrumentState({ ...instrumentRef.current, session: undefined, streaming: { status: 'stopped' } });
      invalidateAcquiredEvidence();
    }
    else if (event.type === 'preference') acceptInstrumentState({ ...instrumentRef.current, preference: event.preference });
    else if (event.type === 'startup') acceptInstrumentState({ ...instrumentRef.current, startup: event.startup });
    else if (event.type === 'streaming') {
      acceptInstrumentState({ ...instrumentRef.current, streaming: event.streaming });
      if (event.streaming.status === 'stopped') {
        // Invoke acknowledgements own renderer stream generations. A stopped
        // event can cross the stop invoke response after a pause/resume has
        // already begun; it must never clear a replacement generation.
        if (!continuousRequested.current && !continuousStreamOwnership.current) {
          setAcquisition((current) => current === 'failed' || current === 'stopping' ? current : 'complete');
        }
      } else if (event.streaming.status === 'faulted') {
        clearContinuousStreamOwnership();
        continuousRequested.current = false;
        wakeContinuousIqAdmissionWaiters();
        setContinuous(false);
        setAcquisition('failed');
        invalidateAcquiredEvidence();
        setError(event.streaming.message);
      }
    }
    else if (event.type === 'connection-cleanup') {
      acceptInstrumentState({ ...instrumentRef.current, connectionCleanup: event.connectionCleanup });
    }
    else if (event.type === 'feature-result') {
      if (instrumentRef.current.session?.sessionId !== event.session.sessionId) return;
      acceptInstrumentState({ ...instrumentRef.current, session: event.session }, event.result.kind === 'signal-lab-profile-selection');
      acceptFeatureResult(event.result);
      observeInvalidatingFeatureLifecycle(event);
    }
    else if (event.type === 'measurement' && continuousRequested.current) {
      const currentSession = instrumentRef.current.session;
      const ownership = continuousStreamOwnership.current;
      if (!currentSession || !ownership || event.measurement.sessionId !== currentSession.sessionId) return;
      admitContinuousMeasurement({ ownership, session: currentSession, measurement: event.measurement });
    }
    else if (event.type === 'status') {
      if (instrumentRef.current.session?.sessionId !== event.sessionId) return;
      if (event.status === 'faulted') {
        continuousRequested.current = false;
        wakeContinuousIqAdmissionWaiters();
        setContinuous(false);
        setAcquisition('failed');
        invalidateAcquiredEvidence(true);
        setError(event.message ?? 'The active instrument session faulted');
      }
    }
    else if (event.type === 'error') {
      if (instrumentRef.current.session?.sessionId !== event.sessionId) return;
      if (!event.error.recoverable) {
        continuousRequested.current = false;
        wakeContinuousIqAdmissionWaiters();
        setContinuous(false);
        setAcquisition('failed');
        invalidateAcquiredEvidence(true);
      }
      setError(`${event.error.code}: ${event.error.message}`);
    }
  }

  function admitContinuousMeasurement(work: ContinuousMeasurementWork): void {
    // IPC events already arrive serially on the renderer event loop. Perform
    // the bounded projection/detection/tracking ingest synchronously for every
    // sweep so history evidence is never silently replaced by a slower
    // classifier. Only derived Bayesian projections use a latest-wins lane.
    processContinuousMeasurement(work);
  }

  function processContinuousMeasurement(work: ContinuousMeasurementWork): void {
    if (!isCurrentContinuousWork(work)) return;
    try {
      const { measurement, ownership } = work;
      if (measurement.kind !== 'swept-spectrum') {
        throw new Error(`Expected swept-spectrum streaming measurement, received ${measurement.kind}`);
      }
      const requested = requireConfiguration(measurement.configurationRevision, 'swept-spectrum', `Continuous measurement ${measurement.measurementId}`);
      if (measurement.configurationRevision !== ownership.configurationRevision) {
        throw new Error(`Continuous measurement ${measurement.measurementId} referenced ${measurement.configurationRevision}; active stream owns ${ownership.configurationRevision}`);
      }
      const projected = projectSpectrumMeasurement(measurement, work.session, requested);
      const recorded = recordSweepEvidence(
        projected,
        measurement.configurationRevision,
        ownership,
      );
      if (!recorded) throw new Error(`Sweep ${projected.id} was acquired for a superseded analyzer configuration`);
      if (recorded.classification) admitClassificationWork(recorded.classification);
    } catch (value) {
      if (!isCurrentContinuousWork(work)) return;
      const message = `Sweep analysis failed: ${errorMessage(value)}`;
      setAcquisition('failed');
      setError(message);
      requestContinuousMeasurementStop(work.ownership, message);
    }
  }

  function admitClassificationWork(work: ClassificationWork): void {
    if (work.requests.length === 0) return;
    // One active (or scheduled) inference plus one replaceable newest work
    // item is the complete queue. Every underlying sweep has already entered
    // history/tracking; superseding only avoids publishing obsolete derived
    // results and prevents unbounded Promise/worker-message growth.
    if (classificationTask.current) {
      pendingClassificationWork.current = work;
      return;
    }
    const abortController = new AbortController();
    const task = processClassificationWorkAfterPaint(work, abortController.signal);
    classificationTask.current = task;
    classificationTaskWork.current = work;
    classificationTaskAbortController.current = abortController;
    void task.finally(() => finishClassificationTask(task));
  }

  async function processClassificationWorkAfterPaint(
    work: ClassificationWork,
    signal: AbortSignal,
  ): Promise<ClassificationExecutionRecord> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal.aborted) {
      return { work, status: 'failed', error: errorMessage(signal.reason) };
    }
    if (!classificationWorkLifecycleIsCurrent(work)) {
      const failure = new Error('Classification evidence revision was superseded before inference');
      failClassificationExecution(work, failure);
      return { work, status: 'failed', error: failure.message };
    }
    try {
      const results = await waitForClassificationSource(
        Promise.all(work.requests.map(({ detection, evidence }) =>
          requireClassifierRuntime().classifier.classify(detection, evidence, signal))),
        signal,
      );
      publishClassificationResults(work, results);
      return { work, status: 'ready', results };
    } catch (value) {
      // The spectrum/detection evidence remains valid when the optional model
      // worker is unavailable or rejects an observation. Keep acquisition
      // running, clear the stale projection, and make the capability-local
      // failure visible.
      if (!signal.aborted && classificationWorkLifecycleIsCurrent(work)) {
        failClassificationExecution(work, value);
        setClassifications([]);
        setError(`Bayesian classification unavailable: ${errorMessage(value)}`);
      }
      return { work, status: 'failed', error: errorMessage(value) };
    }
  }

  function finishClassificationTask(task: Promise<ClassificationExecutionRecord>): void {
    if (classificationTask.current !== task) return;
    classificationTask.current = undefined;
    classificationTaskWork.current = undefined;
    classificationTaskAbortController.current = undefined;
    const pending = pendingClassificationWork.current;
    pendingClassificationWork.current = undefined;
    if (pending) admitClassificationWork(pending);
  }

  function classificationWorkIsCurrent(work: ClassificationWork): boolean {
    return classificationWorkLifecycleIsCurrent(work)
      && classificationWorkTargetIsCurrent(work)
      && (work.ownership !== undefined || work.sequence === analysisSequence.current);
  }

  function classificationWorkLifecycleIsCurrent(work: ClassificationWork): boolean {
    if (!rendererMounted.current) return false;
    return work.ownership ? isCurrentContinuousOwnership(work.ownership) : true;
  }

  function classificationWorkTargetIsCurrent(work: ClassificationWork): boolean {
    const currentSweep = sweepRef.current;
    if (!currentSweep) return false;
    const selection = resolveVisibleClassificationTargetSelection(
      detectionsRef.current,
      currentSweep,
      explicitClassificationIdRef.current,
    );
    return selection.origin === work.target.selectionOrigin
      && selection.detectionId === work.target.projectedRepresentativeId
      && (selection.rawTargetId ?? selection.detectionId) === work.target.rawTargetId;
  }

  function stageClassificationExecution(work: ClassificationWork): void {
    classificationExecution.current = { work, status: 'inference-pending' };
  }

  function completeClassificationExecution(
    work: ClassificationWork,
    results: readonly WaveformClassification[],
  ): void {
    if (classificationExecution.current?.work.revision !== work.revision) return;
    classificationExecution.current = { work, status: 'ready', results };
  }

  function failClassificationExecution(work: ClassificationWork, value: unknown): void {
    if (classificationExecution.current?.work.revision !== work.revision) return;
    classificationExecution.current = {
      work,
      status: 'failed',
      error: errorMessage(value),
    };
  }

  function publishClassificationResults(
    work: ClassificationWork,
    results: readonly WaveformClassification[],
  ): void {
    if (!classificationWorkLifecycleIsCurrent(work)
      || !classificationWorkTargetIsCurrent(work)) return;
    if (!work.ownership) {
      if (work.sequence === analysisSequence.current) {
        completeClassificationExecution(work, results);
        setClassifications(classificationResultsBoundToWork(work, results));
      }
      return;
    }
    if (pinnedAutomaticClassificationRevisions.current.has(work.revision)) {
      const currentSweep = sweepRef.current;
      if (!currentSweep
        || currentSweep.id !== work.visibleSweep.id
        || currentSweep.sequence !== work.visibleSweep.sequence
        || work.sequence !== analysisSequence.current) return;
    }
    if (work.sequence <= lastPublishedClassificationSequence.current) return;
    const currentId = currentSelectedClassificationRepresentative()?.id;
    const requestIds = new Set(work.requests.map(({ detection }) => detection.id));
    const admitted = results.filter((result) =>
      requestIds.has(result.detectionId) && result.detectionId === currentId);
    if (admitted.length === 0) return;
    lastPublishedClassificationSequence.current = work.sequence;
    completeClassificationExecution(work, admitted);
    setClassifications(classificationResultsBoundToWork(work, admitted));
  }

  function currentSelectedClassificationRepresentative(): DetectedSignal | undefined {
    const visibleSweep = sweepRef.current;
    if (!visibleSweep) return undefined;
    return selectVisibleClassificationRepresentative(
      detectionsRef.current,
      visibleSweep,
      explicitClassificationIdRef.current,
    )?.detection;
  }

  function isCurrentContinuousOwnership(ownership: ContinuousStreamOwnership): boolean {
    const current = continuousStreamOwnership.current;
    return current === ownership
      && current.generation === ownership.generation
      && instrumentRef.current.session?.sessionId === ownership.sessionId
      && continuousRequested.current;
  }

  function isCurrentContinuousWork(work: ContinuousMeasurementWork): boolean {
    return isCurrentContinuousOwnership(work.ownership);
  }

  function requestContinuousMeasurementStop(ownership: ContinuousStreamOwnership, message: string): void {
    if (continuousStreamOwnership.current !== ownership
      || failedContinuousMeasurementStopGeneration.current === ownership.generation) return;
    continuousMeasurementStopRequest.current = { ownership, message };
    drainContinuousMeasurementStop();
  }

  function drainContinuousMeasurementStop(): void {
    if (continuousMeasurementStopTask.current || instrumentTransactionOwner.current) return;
    const request = continuousMeasurementStopRequest.current;
    if (!request) return;
    continuousMeasurementStopRequest.current = undefined;
    const task = runInstrumentTransaction('stop-invalid-continuous-measurement', async () => {
      if (continuousStreamOwnership.current !== request.ownership) return;
      continuousRequested.current = false;
      try {
        await stopStreamingAndReleaseConfiguration(request.ownership);
        setContinuous(false);
      }
      catch (value) {
        failedContinuousMeasurementStopGeneration.current = request.ownership.generation;
        setError(`${request.message}. Stream stop also failed: ${errorMessage(value)}`);
        throw value;
      }
    });
    continuousMeasurementStopTask.current = task;
    void task.then(
      () => finishContinuousMeasurementStopTask(task),
      () => finishContinuousMeasurementStopTask(task),
    );
  }

  function finishContinuousMeasurementStopTask(task: Promise<void>): void {
    if (continuousMeasurementStopTask.current !== task) return;
    continuousMeasurementStopTask.current = undefined;
    drainContinuousMeasurementStop();
  }

  function acceptDiscovery(nextCandidates: readonly InstrumentCandidate[], failures: readonly InstrumentDiscoveryFailure[]): void {
    setCandidates([...nextCandidates]);
    setDiscoveryFailures([...failures]);
    setSelectedCandidateId((current) => {
      if (current && nextCandidates.some((candidate) => instrumentCandidateUiKey(candidate) === current)) return current;
      const preferred = preferredCandidate(nextCandidates, instrumentRef.current);
      const selected = preferred ?? nextCandidates[0];
      return selected ? instrumentCandidateUiKey(selected) : undefined;
    });
  }

  async function refreshCandidates(): Promise<void> {
    try { await runInstrumentTransaction('discover-instruments', () => refreshCandidatesOwned()); }
    catch (value) { setError(errorMessage(value)); }
  }

  async function refreshCandidatesOwned(): Promise<void> {
    setError(undefined);
    try {
      const discoveryEventSequence = instrumentDiscoveryEventSequence.current;
      const next = await discoverInstruments();
      if (instrumentDiscoveryEventSequence.current === discoveryEventSequence) {
        acceptDiscovery(next.candidates, next.failures);
      }
    } catch (value) { setError(errorMessage(value)); }
  }

  function connectCandidate(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    return runInstrumentTransaction('connect-instrument', () => connectCandidateOwned(candidate));
  }

  async function connectCandidateOwned(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    setConnectionBusy(true);
    setError(undefined);
    invalidateAcquiredEvidence();
    try {
      const next = await connectInstrument(candidate);
      acceptSession(next);
      setConnectionOpen(false);
      setNotice(connectionNotice(next));
      return next;
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    } finally { setConnectionBusy(false); }
  }

  async function connect(): Promise<void> {
    const candidate = candidatesRef.current.find((value) => instrumentCandidateUiKey(value) === selectedCandidateIdRef.current);
    if (!candidate) { setError('Select an available instrument source before connecting'); return; }
    try { await connectCandidate(candidate); } catch { /* Presented in the connection dialog. */ }
  }

  async function disconnectDevice(): Promise<void> {
    const sourceKind = instrumentRef.current.session?.provenance.sourceKind;
    setConnectionBusy(true);
    setError(undefined);
    try {
      await window.atomizerInstrument.disconnect();
      continuousRequested.current = false;
      wakeContinuousIqAdmissionWaiters();
      setContinuous(false);
      acceptInstrumentState({
        ...instrumentRef.current,
        session: undefined,
        streaming: { status: 'stopped' },
        connectionCleanup: { status: 'not-required' },
      });
      invalidateAcquiredEvidence();
      setAcquisition('idle');
      setDiagnostics([]);
      setScreenFrame(undefined);
      setNotice(sourceKind === 'serial-port' ? 'Physical instrument disconnected; RF state is no longer inferred' : sourceKind === 'tinysa-firmware-twin' ? 'Executable twin disconnected and its Renode process terminated' : 'Instrument source disconnected');
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    } finally { setConnectionBusy(false); }
  }

  async function disconnect(): Promise<void> { try { await disconnectDevice(); } catch { /* Presented in the connection dialog. */ } }

  function requireConnected(): InstrumentSessionSnapshot {
    const active = instrumentRef.current.session;
    if (!active) throw new Error('Connect an instrument source before running this operation');
    return active;
  }

  function requireClassifierRuntime(): BayesianClassifierRuntime {
    const runtime = classifierRuntime.current;
    if (!runtime) throw new Error('Bayesian classifier runtime has not completed renderer mount admission');
    return runtime;
  }

  function currentGeneratorOutput(): GeneratorOutputState {
    return generatorOutputState(instrumentRef.current.session);
  }

  function acceptInstrumentState(next: AtomizerInstrumentState, initializeSelection = false): void {
    const previousSessionId = instrumentRef.current.session?.sessionId;
    const admittedSession = next.session;
    const admittedProvenance = admittedSession?.provenance;
    if (admittedSession
      && admittedSession.sessionId !== previousSessionId
      && admittedProvenance?.sourceKind === 'signal-lab') {
      const provenance = admittedProvenance;
      console.info(`[ATOMIZER-SIGNAL-LAB-SESSION] ${JSON.stringify({
        schemaVersion: 1,
        event: 'admitted',
        sessionId: admittedSession.sessionId,
        driverId: admittedSession.driverId,
        provenance: {
          sourceKind: provenance.sourceKind,
          sourceId: provenance.sourceId,
          execution: provenance.execution,
          transport: provenance.transport,
          qualification: provenance.qualification,
          contractId: provenance.contractId,
          contractVersion: provenance.contractVersion,
          contractSha256: provenance.contractSha256,
          catalogSha256: provenance.catalogSha256,
          generatorSha256: provenance.generatorSha256,
          claims: provenance.claims,
        },
      })}`);
    }
    if (next.session?.sessionId !== previousSessionId) invalidateAcquiredEvidence(true);
    setInstrument(next);
    if (next.session && (initializeSelection || next.session.sessionId !== previousSessionId)) initializeSessionSelection(next.session);
  }

  function acceptSession(next: InstrumentSessionSnapshot): void {
    acceptInstrumentState({ ...instrumentRef.current, session: next }, true);
    setDiagnostics([]);
    setScreenFrame(undefined);
  }

  function acceptConfiguration(configuration: InstrumentConfigurationState): void {
    const active = instrumentRef.current.session;
    if (!active || active.sessionId !== configuration.sessionId) return;
    acceptInstrumentState({ ...instrumentRef.current, session: { ...active, configuration } });
  }

  function acceptFeatureResult(result: InstrumentFeatureResult): void {
    if (instrumentRef.current.session?.sessionId !== result.sessionId) return;
    if (result.kind === 'screen') setScreenFrame(result.frame);
    else if (result.kind === 'diagnostics') setDiagnostics(result.lines);
    else if (result.kind === 'signal-lab-profile-selection') {
      invalidateAcquiredEvidence(true);
      const active = instrumentRef.current.session;
      if (result.action === 'select-profile') {
        if (active) initializeSessionSelection(active, result.profileId, selectedSignalLabChannelRef.current);
      } else {
        setSelectedSignalLabChannel(result.channel);
      }
    }
  }

  async function executeInstrumentFeature(request: InstrumentFeatureRequest): Promise<InstrumentFeatureResult> {
    const receipt = beginInvalidatingFeatureReceipt(request);
    try {
      const execution = await executeInstrumentFeatureBoundary(request);
      const currentSessionId = instrumentRef.current.session?.sessionId;
      if (!currentSessionId || execution.session.sessionId !== currentSessionId) {
        throw new Error('Instrument feature acknowledgement is stale for the active session');
      }
      if (receipt) {
        receipt.execution = execution;
        reconcileInvalidatingFeatureReceipt(receipt);
        await receipt.promise;
        if (instrumentRef.current.session?.sessionId !== execution.session.sessionId) {
          throw new Error('Instrument feature lifecycle receipt was superseded before renderer admission');
        }
        // Both manager events have already crossed the renderer boundary and
        // synchronously applied their lifecycle invalidation. Only now may a
        // caller reserve/configure the replacement acquisition revision.
        return execution.result;
      }
      acceptInstrumentState(
        { ...instrumentRef.current, session: execution.session },
        execution.result.kind === 'signal-lab-profile-selection',
      );
      acceptFeatureResult(execution.result);
      return execution.result;
    } catch (value) {
      if (receipt && !receipt.settled) rejectInvalidatingFeatureReceipt(value, receipt);
      throw value;
    }
  }

  function beginInvalidatingFeatureReceipt(request: InstrumentFeatureRequest): InvalidatingFeatureReceipt | undefined {
    if (!isInvalidatingFeatureRequest(request)) return undefined;
    const reason = invalidatingFeatureReason(request);
    if (!reason) throw new Error('Invalidating feature request has no lifecycle invalidation reason');
    if (pendingInvalidatingFeatureReceipt.current) {
      throw new Error('Another invalidating feature lifecycle receipt is already pending');
    }
    const sessionId = requireConnected().sessionId;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    let receipt!: InvalidatingFeatureReceipt;
    const timeout = window.setTimeout(() => {
      rejectInvalidatingFeatureReceipt(new Error(
        `Instrument feature lifecycle did not deliver a matching feature-result and ${reason} invalidation within ${INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS} ms`,
      ), receipt);
    }, INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS);
    receipt = {
      request,
      sessionId,
      reason,
      promise,
      resolve,
      reject,
      timeout,
      settled: false,
    };
    // The event path can reject before the invoke path reaches `await`.
    // Retain the original Promise for the caller while suppressing a transient
    // unhandled-rejection report from that legitimate ordering.
    void promise.catch(() => undefined);
    pendingInvalidatingFeatureReceipt.current = receipt;
    return receipt;
  }

  function observeInvalidatingFeatureLifecycle(event: FeatureResultEvent | ConfigurationInvalidatedEvent): void {
    const receipt = pendingInvalidatingFeatureReceipt.current;
    if (!receipt || receipt.settled) return;
    const eventSessionId = event.type === 'feature-result'
      ? event.session.sessionId
      : event.sessionId;
    // Ignore a stale prior-session delivery. Active-session mismatches below
    // are fail-closed because the transaction gate permits only one such
    // mutation at a time.
    if (eventSessionId !== receipt.sessionId) return;
    if (event.type === 'feature-result') {
      if (!featureResultAcknowledgesRequest(event.result, receipt.request)) {
        rejectInvalidatingFeatureReceipt(new Error(
          `Invalidating feature lifecycle returned ${event.result.kind}/${event.result.action} for a different request`,
        ), receipt);
        return;
      }
      if (receipt.featureResult) {
        rejectInvalidatingFeatureReceipt(new Error('Invalidating feature lifecycle delivered a duplicate feature-result receipt'), receipt);
        return;
      }
      receipt.featureResult = event;
    } else {
      if (event.reason !== receipt.reason) {
        rejectInvalidatingFeatureReceipt(new Error(
          `Invalidating feature lifecycle delivered ${event.reason}; expected ${receipt.reason}`,
        ), receipt);
        return;
      }
      if (receipt.invalidation) {
        rejectInvalidatingFeatureReceipt(new Error('Invalidating feature lifecycle delivered a duplicate configuration-invalidated receipt'), receipt);
        return;
      }
      receipt.invalidation = event;
    }
    reconcileInvalidatingFeatureReceipt(receipt);
  }

  function reconcileInvalidatingFeatureReceipt(receipt: InvalidatingFeatureReceipt): void {
    if (receipt.settled || !receipt.execution || !receipt.featureResult || !receipt.invalidation) return;
    const execution = receipt.execution;
    if (!sameStructuredValue(receipt.featureResult.result, execution.result)
      || !sameStructuredValue(receipt.featureResult.session, execution.session)
      || !sameStructuredValue(receipt.invalidation.session, execution.session)) {
      rejectInvalidatingFeatureReceipt(new Error(
        'Instrument feature invoke acknowledgement did not match its ordered lifecycle event receipts',
      ), receipt);
      return;
    }
    receipt.settled = true;
    window.clearTimeout(receipt.timeout);
    if (pendingInvalidatingFeatureReceipt.current === receipt) pendingInvalidatingFeatureReceipt.current = undefined;
    receipt.resolve();
  }

  function rejectInvalidatingFeatureReceipt(reason: unknown, expected = pendingInvalidatingFeatureReceipt.current): void {
    if (!expected || expected.settled) return;
    expected.settled = true;
    window.clearTimeout(expected.timeout);
    if (pendingInvalidatingFeatureReceipt.current === expected) pendingInvalidatingFeatureReceipt.current = undefined;
    expected.reject(reason);
  }

  function initializeSessionSelection(next: InstrumentSessionSnapshot, selectedProfileId?: string, selectedChannel?: SignalLabChannelState): void {
    const profileCapability = next.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    const profileId = selectedProfileId ?? profileCapability?.selectedProfileId;
    setSelectedProfile(profileId);
    setSelectedSignalLabChannel(selectedChannel ?? profileCapability?.channel);
    const selectedProfileEntry = profileCapability?.profiles.find((profile) => profile.profileId === profileId);
    const detectedPower = next.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
    if (selectedProfileEntry) updateZeroSpanConfiguration((current) => {
      const staged = zeroSpanConfigSchema.parse({ ...current, frequencyHz: selectedProfileEntry.centerFrequencyHz });
      return detectedPower?.kind === 'detected-power-timeseries'
        ? reconcileDetectedPowerConfiguration(detectedPower, staged)
        : staged;
    });
    else if (detectedPower?.kind === 'detected-power-timeseries') {
      updateZeroSpanConfiguration((current) => reconcileDetectedPowerConfiguration(detectedPower, current));
    }
    const spectrum = next.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
    if (!spectrum) {
      invalidateAcquiredEvidence();
    } else {
      const current = analyzerRef.current;
      const maximumSpanHz = spectrum.frequencyHz.max - spectrum.frequencyHz.min;
      const profileSpanHz = selectedProfileEntry ? Math.min(selectedProfileEntry.recommendedSpanHz, maximumSpanHz) : undefined;
      const profileStartHz = selectedProfileEntry && profileSpanHz !== undefined
        ? Math.max(
          spectrum.frequencyHz.min,
          Math.min(Math.round(selectedProfileEntry.centerFrequencyHz - profileSpanHz / 2), spectrum.frequencyHz.max - profileSpanHz),
        )
        : undefined;
      const startHz = profileStartHz ?? Math.max(spectrum.frequencyHz.min, Math.min(current.startHz, spectrum.frequencyHz.max - 1));
      const stopHz = profileStartHz !== undefined && profileSpanHz !== undefined
        ? profileStartHz + profileSpanHz
        : Math.max(startHz + 1, Math.min(current.stopHz, spectrum.frequencyHz.max));
      const points = Math.max(spectrum.points.min, Math.min(current.points, spectrum.points.max));
      const staged = analyzerConfigSchema.parse({
        ...current,
        startHz,
        stopHz,
        points,
      });
      const reconciled = reconcileAnalyzerConfiguration(spectrum, staged);
      if (!sameAnalyzerConfiguration(current, reconciled)) {
        analyzerRevision.current++;
        setAnalyzer(reconciled);
      }
    }
    const iq = next.capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq');
    if (iq?.kind === 'complex-iq') {
      const staged = selectedProfileEntry
        ? { ...iqConfigurationRef.current, centerHz: selectedProfileEntry.centerFrequencyHz }
        : iqConfigurationRef.current;
      const reconciled = reconcileComplexIqConfiguration(iq, staged);
      if (!sameComplexIqConfiguration(reconciled, iqConfigurationRef.current)) {
        iqConfigurationRevision.current++;
        setIqConfiguration(reconciled);
      }
    } else {
      setIqCapture(undefined);
    }
  }

  async function selectSignalLabProfile(profileId: string): Promise<void> {
    try {
      await runInstrumentTransaction('select-signal-lab-profile', () => runWithContinuousPaused(
        'SignalLab profile selection',
        () => executeInstrumentFeature({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId }),
      ));
      setNotice(`SignalLab profile selected: ${profileId}`);
    } catch (value) { setError(`SignalLab profile selection failed: ${errorMessage(value)}`); }
  }

  async function configureSignalLabChannel(channel: SignalLabChannelState): Promise<void> {
    try {
      await runInstrumentTransaction('configure-signal-lab-channel', () => runWithContinuousPaused(
        'SignalLab channel configuration',
        () => executeInstrumentFeature({
          kind: 'signal-lab-profile-selection',
          action: 'configure-channel',
          channel,
        }),
      ));
      setNotice(`SignalLab channel configured: ${channel.model.toUpperCase()}`);
    } catch (value) { setError(`SignalLab channel configuration failed: ${errorMessage(value)}`); }
  }

  async function makeSelectedDefault(): Promise<void> {
    const candidate = candidatesRef.current.find((value) => instrumentCandidateUiKey(value) === selectedCandidateIdRef.current);
    if (!candidate) { setError('Select an instrument source before setting the startup default'); return; }
    try {
      const preference = await writeInstrumentPreference(instrumentPreferenceSelectionForCandidate(candidate));
      acceptInstrumentState({ ...instrumentRef.current, preference });
      setNotice(`${candidate.displayName} will be used at the next startup`);
    } catch (value) { setError(`Startup preference failed: ${errorMessage(value)}`); }
  }

  async function configureAnalyzer(config: AnalyzerConfig, operation: 'configuring' | 'retuning' = 'configuring'): Promise<InstrumentConfigurationState> {
    const session = requireConnected();
    const sessionId = session.sessionId;
    const validated = analyzerConfigSchema.parse(config);
    const capability = session.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    if (!capability || capability.kind !== 'swept-spectrum') throw new Error('Active instrument does not advertise swept-spectrum acquisition');
    const requested = sweptSpectrumConfigurationFor(capability, validated);
    const reservation = configurationRevisions.current.reserve();
    setError(undefined);
    setAcquisition(operation);
    try {
      const next = await configureInstrument(requested);
      if (next.sessionId !== sessionId || instrumentRef.current.session?.sessionId !== sessionId) {
        throw new Error(`Swept-spectrum configuration response was invalidated with instrument session ${sessionId}`);
      }
      if (next.configuration.kind !== 'swept-spectrum'
        || !sameSweptSpectrumConfiguration(next.configuration, requested)) {
        throw new Error('Instrument host returned a different swept-spectrum configuration than it admitted');
      }
      reservation.commit(next.configurationRevision, { kind: 'swept-spectrum', admitted: next.configuration });
      configurationRevisions.current.setActive(next.configurationRevision);
      acceptConfiguration(next);
      return next;
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  function requireConfiguration(revision: string, kind: 'swept-spectrum', context: string): SweptSpectrumConfiguration;
  function requireConfiguration(revision: string, kind: 'detected-power-timeseries', context: string): DetectedPowerTimeseriesConfiguration;
  function requireConfiguration(revision: string, kind: 'complex-iq', context: string): ComplexIqConfiguration;
  function requireConfiguration(
    revision: string,
    kind: RendererConfigurationRevision['kind'],
    context: string,
  ): SweptSpectrumConfiguration | DetectedPowerTimeseriesConfiguration | ComplexIqConfiguration {
    const retained = configurationRevisions.current.read(revision);
    if (!retained) throw new Error(`${context} referenced unknown configuration ${revision}`);
    if (retained.kind !== kind) throw new Error(`${context} referenced ${retained.kind} configuration ${revision}, expected ${kind}`);
    return retained.admitted;
  }

  function leaseConfiguration(revision: string, kind: RendererConfigurationRevision['kind']): RevisionCacheLease<RendererConfigurationRevision> {
    const lease = configurationRevisions.current.lease(revision);
    if (lease.value.kind !== kind) {
      lease.release();
      throw new Error(`Configuration revision ${revision} is ${lease.value.kind}, expected ${kind}`);
    }
    return lease;
  }

  function retainEvidenceConfigurationRevisions(): void {
    const revisions = new Set(historyConfigurationRevisions.current);
    if (zeroCaptureConfigurationRevision.current) revisions.add(zeroCaptureConfigurationRevision.current);
    configurationRevisions.current.setRetainedKeys(revisions);
  }

  function holdStreamingConfiguration(revision: string): void {
    const next = leaseConfiguration(revision, 'swept-spectrum');
    const previous = streamingConfigurationLease.current;
    streamingConfigurationLease.current = next;
    previous?.release();
  }

  function releaseStreamingConfiguration(): void {
    const lease = streamingConfigurationLease.current;
    streamingConfigurationLease.current = undefined;
    lease?.release();
  }

  function clearContinuousStreamOwnership(expected?: ContinuousStreamOwnership): void {
    if (expected && continuousStreamOwnership.current !== expected) return;
    continuousStreamOwnership.current = undefined;
    if (!expected || pendingClassificationWork.current?.ownership === expected) pendingClassificationWork.current = undefined;
    if (!expected || continuousMeasurementStopRequest.current?.ownership === expected) {
      continuousMeasurementStopRequest.current = undefined;
    }
    failedContinuousMeasurementStopGeneration.current = undefined;
    releaseStreamingConfiguration();
  }

  async function stopStreamingAndReleaseConfiguration(expected?: ContinuousStreamOwnership): Promise<void> {
    // A rejected stop leaves both the ownership flag and configuration lease
    // intact. The main process may still own a live acquisition run, so the
    // renderer must keep consuming its measurements and allow a later retry.
    const ownership = expected ?? continuousStreamOwnership.current;
    if (expected && continuousStreamOwnership.current !== expected) return;
    await stopInstrumentStreaming();
    // Every operational caller uses the renderer transaction gate. This
    // identity check additionally prevents delayed event-failure cleanup from
    // releasing the lease of a replacement stream generation.
    if (continuousStreamOwnership.current !== ownership) return;
    clearContinuousStreamOwnership(ownership);
  }

  async function startStreamingWithConfiguration(revision: string): Promise<void> {
    const sessionId = requireConnected().sessionId;
    if (continuousStreamOwnership.current) throw new Error('A continuous stream generation is already owned');
    holdStreamingConfiguration(revision);
    const ownership: ContinuousStreamOwnership = {
      generation: ++continuousStreamGeneration.current,
      sessionId,
      configurationRevision: revision,
    };
    continuousStreamOwnership.current = ownership;
    failedContinuousMeasurementStopGeneration.current = undefined;
    try {
      await startInstrumentStreaming();
      if (instrumentRef.current.session?.sessionId !== sessionId || continuousStreamOwnership.current !== ownership) {
        throw new Error(`Continuous acquisition start was invalidated with instrument session ${sessionId}`);
      }
    } catch (startFailure) {
      try {
        await stopStreamingAndReleaseConfiguration(ownership);
      } catch (stopFailure) {
        throw new AggregateError(
          [startFailure, stopFailure],
          `Continuous acquisition start was not acknowledged and compensating stop also failed: ${errorMessage(startFailure)}; ${errorMessage(stopFailure)}`,
        );
      }
      throw startFailure;
    }
  }

  async function runInstrumentTransaction<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const pauseIq = name !== CONTINUOUS_IQ_TRANSACTION
      && continuousRequested.current
      && continuousModeRef.current === 'complex-iq';
    if (pauseIq) continuousIqPauseDepth.current++;
    try {
      const active = instrumentTransactionOwner.current;
      if (active === CONTINUOUS_IQ_TRANSACTION && pauseIq) {
        const buffer = continuousIqBufferTask.current;
        if (!buffer) throw new Error('Continuous I/Q transaction has no owned bounded buffer task');
        try { await buffer; } catch { /* The pump reports its own capability-local failure. */ }
      }
      const admittedAfterPause = instrumentTransactionOwner.current;
      if (admittedAfterPause) {
        throw new Error(`Instrument operation ${admittedAfterPause} is already active; ${name} was not admitted`);
      }
      instrumentTransactionOwner.current = name;
      setInstrumentTransactionActive(true);
      try { return await operation(); }
      finally {
        if (instrumentTransactionOwner.current === name) {
          instrumentTransactionOwner.current = undefined;
          setInstrumentTransactionActive(false);
          drainContinuousMeasurementStop();
          drainOperatorContinuousStop();
        }
      }
    } finally {
      if (pauseIq) releaseContinuousIqPause();
    }
  }

  function releaseContinuousIqPause(): void {
    if (continuousIqPauseDepth.current < 1) return;
    continuousIqPauseDepth.current--;
    if (continuousIqPauseDepth.current !== 0) return;
    for (const resume of continuousIqResumeWaiters.current) resume();
    continuousIqResumeWaiters.current.clear();
  }

  async function waitForContinuousIqAdmission(): Promise<boolean> {
    while (continuousRequested.current
      && continuousModeRef.current === 'complex-iq'
      && continuousIqPauseDepth.current > 0) {
      await new Promise<void>((resolve) => continuousIqResumeWaiters.current.add(resolve));
    }
    return continuousRequested.current && continuousModeRef.current === 'complex-iq';
  }

  function wakeContinuousIqAdmissionWaiters(): void {
    for (const resume of continuousIqResumeWaiters.current) resume();
    continuousIqResumeWaiters.current.clear();
  }

  async function runWithContinuousPaused<T>(
    label: string,
    operation: () => Promise<T>,
    shouldResume: (result: T) => boolean = () => true,
  ): Promise<T> {
    const ownership = continuousStreamOwnership.current;
    if (!ownership
      && continuousRequested.current
      && continuousModeRef.current === 'complex-iq') {
      return runWithContinuousIqPaused(label, operation, shouldResume);
    }
    if (!continuousRequested.current || !ownership) return operation();
    try {
      const sessionId = ownership.sessionId;
      setAcquisition('retuning');
      setNotice(`Pausing continuous acquisition for ${label}…`);
      await stopStreamingAndReleaseConfiguration(ownership);
      const before = requireConnected();
      if (before.sessionId !== sessionId || before.fault) {
        throw new Error(`${label} was invalidated with instrument session ${sessionId}`);
      }

      const result = await operation();
      const after = requireConnected();
      if (after.sessionId !== sessionId || after.fault) {
        throw new Error(`${label} completed for a superseded instrument session ${sessionId}`);
      }
      if (!continuousRequested.current) {
        completeContinuousStop(`Continuous acquisition stopped after ${label}`);
        return result;
      }
      // Resume is admitted only after the conflicting operation and all of its
      // renderer-side acknowledgement checks succeed. RF-on intentionally
      // leaves collection stopped because acquisition is not safe in that state.
      if (!shouldResume(result)) {
        setAcquisition('complete');
        setNotice(`Continuous acquisition stopped after ${label}`);
        return result;
      }
      if (currentGeneratorOutput() !== 'off') {
        throw new Error(`Continuous acquisition cannot resume after ${label} while RF output is ${currentGeneratorOutput()}`);
      }
      const resumed = await resumeContinuousAfterConflict(sessionId, label);
      if (!resumed) completeContinuousStop(`Continuous acquisition stopped after ${label}`);
      return result;
    } catch (value) {
      continuousRequested.current = false;
      if (!continuousStreamOwnership.current) setContinuous(false);
      setAcquisition('failed');
      setNotice(undefined);
      setError(`${label} failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  async function runWithContinuousIqPaused<T>(
    label: string,
    operation: () => Promise<T>,
    shouldResume: (result: T) => boolean,
  ): Promise<T> {
    const sessionId = requireConnected().sessionId;
    const generation = continuousIqGeneration.current;
    try {
      setAcquisition('retuning');
      setNotice(`Pausing bounded I/Q acquisition for ${label}…`);
      const result = await operation();
      const after = requireConnected();
      if (after.sessionId !== sessionId || after.fault) {
        throw new Error(`${label} completed for a superseded instrument session ${sessionId}`);
      }
      if (!continuousRequested.current || generation !== continuousIqGeneration.current) {
        completeContinuousStop(`Continuous I/Q acquisition stopped after ${label}`);
        return result;
      }
      if (!shouldResume(result)) {
        completeContinuousStop(`Continuous I/Q acquisition stopped after ${label}`);
        return result;
      }
      if (currentGeneratorOutput() !== 'off') {
        throw new Error(`Continuous I/Q acquisition cannot resume after ${label} while RF output is ${currentGeneratorOutput()}`);
      }
      requireIqAcquisitionAdmission(after);
      setAcquisition('streaming');
      setNotice(`Continuous I/Q acquisition resumed after ${label}`);
      return result;
    } catch (value) {
      continuousRequested.current = false;
      wakeContinuousIqAdmissionWaiters();
      releaseContinuousIqConfiguration();
      setContinuous(false);
      setAcquisition('failed');
      setNotice(undefined);
      setError(`${label} failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  function requireIqAcquisitionAdmission(session: InstrumentSessionSnapshot): void {
    const iq = session.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (iq?.kind !== 'complex-iq') throw new Error('The active session no longer advertises complex-I/Q acquisition');
    const profile = session.capabilities.features.find((candidate) => candidate.kind === 'signal-lab-profile-selection');
    if (profile?.kind === 'signal-lab-profile-selection'
      && profile.iqProfileIds !== undefined
      && !profile.iqProfileIds.includes(profile.selectedProfileId)) {
      throw new Error(`SignalLab profile ${profile.selectedProfileId} is not admitted for complex-I/Q acquisition`);
    }
  }

  async function resumeContinuousAfterConflict(sessionId: string, label: string): Promise<boolean> {
    setAcquisition('retuning');
    while (true) {
      if (!continuousRequested.current) return false;
      const active = requireConnected();
      if (active.sessionId !== sessionId || active.fault) {
        throw new Error(`Continuous acquisition resume was invalidated with instrument session ${sessionId}`);
      }
      const targetRevision = analyzerRevision.current;
      const configured = await configureAnalyzer(analyzerRef.current, 'retuning');
      if (!continuousRequested.current) return false;
      if (configured.sessionId !== sessionId || targetRevision !== analyzerRevision.current) continue;
      await startStreamingWithConfiguration(configured.configurationRevision);
      if (!continuousRequested.current) {
        await stopStreamingAndReleaseConfiguration();
        return false;
      }
      if (instrumentRef.current.session?.sessionId === sessionId
        && targetRevision === analyzerRevision.current
        && continuousStreamOwnership.current?.configurationRevision === configured.configurationRevision) break;
      await stopStreamingAndReleaseConfiguration();
    }
    setAcquisition('streaming');
    setNotice(`Continuous acquisition resumed after ${label}`);
    return true;
  }

  function stageAnalyzerPatch(input: AnalyzerConfigPatch): { configuration: AnalyzerConfig; changed: boolean } {
    const patch = analyzerConfigPatchSchema.parse(input);
    const previous = analyzerRef.current;
    const next = analyzerConfigSchema.parse({ ...previous, ...patch });
    const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    if (capability?.kind === 'swept-spectrum') {
      if (capability.controls.model === 'synthetic-scalar') {
        const receiverOnly = [
          'acquisitionFormat', 'rbwKhz', 'attenuationDb', 'detector',
          'spurRejection', 'lna', 'avoidSpurs', 'trigger',
        ].find((key) => key in patch);
        if (receiverOnly) throw new Error(`${receiverOnly} is not applicable to synthetic scalar acquisition`);
      }
      sweptSpectrumConfigurationFor(capability, next);
    }
    if (sameAnalyzerConfiguration(previous, next)) return { configuration: previous, changed: false };
    analyzerRevision.current++;
    setAnalyzer(next);
    setChannelConfiguration((current) => fitChannelConfigurationToSpan(current, next.startHz, next.stopHz));
    invalidateAcquiredEvidence();
    return { configuration: next, changed: true };
  }

  function invalidateAcquiredEvidence(clearInstrumentConfigurations = false): void {
    analysisSequence.current++;
    classificationSelectionRevision.current++;
    historyConfigurationRevisions.current = [];
    if (clearInstrumentConfigurations) {
      releaseStreamingConfiguration();
      releaseContinuousIqConfiguration();
      zeroCaptureConfigurationRevision.current = undefined;
      configurationRevisions.current.clear();
      setIqCapture(undefined);
    }
    traceAccumulator.current.reset();
    tracker.current.reset();
    setSweep(undefined);
    setHistory([]);
    setTraceFrames(traceAccumulator.current.frames());
    setFirmwareTraceFrames([]);
    setDetections([]);
    setClassifications([]);
    classificationExecution.current = undefined;
    setExplicitClassificationId(undefined);
    stagedClassificationTargetIdRef.current = undefined;
    setDetectedPowerTargetStagingFailure(undefined);
    retireClassificationOperations('Classification evidence was invalidated');
    clearClassificationCapture();
  }

  function clearClassificationCapture(): void {
    zeroCaptureConfigurationRevision.current = undefined;
    retainEvidenceConfigurationRevisions();
    zeroCaptureReceiptRef.current = undefined;
    zeroCaptureSpectrumSweepIdsRef.current = undefined;
    setZeroCapture(undefined);
    setEnvelope(undefined);
  }

  function sameClassificationSelectionIdentity(
    left: ClassificationTargetSelection,
    right: ClassificationTargetSelection,
  ): boolean {
    return left.origin === right.origin
      && left.detectionId === right.detectionId
      && (left.rawTargetId ?? left.detectionId)
        === (right.rawTargetId ?? right.detectionId);
  }

  function supersedeClassificationSelectionIfChanged(
    previous: ClassificationTargetSelection,
    next: ClassificationTargetSelection,
  ): void {
    if (!sameClassificationSelectionIdentity(previous, next)) {
      classificationSelectionRevision.current++;
    }
  }

  function classificationSelectionStillOwns(
    revision: number,
    expected: ClassificationTargetSelection,
  ): boolean {
    if (classificationSelectionRevision.current !== revision) return false;
    const current = resolveVisibleClassificationTargetSelection(
      detectionsRef.current,
      sweepRef.current,
      explicitClassificationIdRef.current,
    );
    return sameClassificationSelectionIdentity(current, expected);
  }

  function stageClassificationCandidate(detectionId: string | undefined): number | undefined {
    const changed = detectionId !== stagedClassificationTargetIdRef.current;
    stagedClassificationTargetIdRef.current = detectionId;
    if (changed) {
      clearClassificationCapture();
      // Classifier output is owned by the selected target, not merely by a
      // still-visible detection ID. Never show or republish the prior target's
      // result while the next selected-target evidence revision is pending.
      setClassifications([]);
    }
    if (!detectionId) return undefined;
    const detection = detectionsRef.current.find((candidate) => candidate.id === detectionId);
    const capability = instrumentRef.current.session?.capabilities.acquisitions
      .find((candidate) => candidate.kind === 'detected-power-timeseries');
    if (!detection || capability?.kind !== 'detected-power-timeseries') return undefined;
    const frequencyHz = projectDetectedPowerTuneHz(detection.peakHz, capability.centerFrequencyHz);
    updateZeroSpanConfiguration((current) => reconcileDetectedPowerConfiguration(
      capability,
      zeroSpanConfigSchema.parse({
        ...current,
        ...BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY,
        frequencyHz,
      }),
    ));
    return frequencyHz;
  }

  function safelyStageClassificationCandidate(detectionId: string | undefined): {
    readonly centerHz?: number;
    readonly failure?: string;
  } {
    try {
      const centerHz = stageClassificationCandidate(detectionId);
      setDetectedPowerTargetStagingFailure(undefined);
      return centerHz === undefined ? {} : { centerHz };
    } catch (value) {
      const failure = errorMessage(value);
      setDetectedPowerTargetStagingFailure(failure);
      return { failure };
    }
  }

  function selectClassificationCandidate(detectionId: string | undefined): {
    readonly centerHz?: number;
    readonly failure?: string;
  } {
    const currentDetections = detectionsRef.current;
    const previousSelection = resolveVisibleClassificationTargetSelection(
      currentDetections,
      sweepRef.current,
      explicitClassificationIdRef.current,
    );
    const selection = resolveVisibleClassificationTargetSelection(
      currentDetections,
      sweepRef.current,
      detectionId,
    );
    const selectionConditionChanged = !sameClassificationSelectionIdentity(
      previousSelection,
      selection,
    );
    supersedeClassificationSelectionIfChanged(previousSelection, selection);
    setExplicitClassificationId(selection.explicitDetectionId);
    const staged = safelyStageClassificationCandidate(
      selection.rawTargetId ?? selection.detectionId,
    );
    // Automatic rank-zero and operator-preferred capture are different
    // statistical conditions even when they tune the same physical row.
    if (selectionConditionChanged) {
      if (zeroCaptureRef.current || zeroCaptureReceiptRef.current) {
        clearClassificationCapture();
      }
      setClassifications([]);
    }
    return staged;
  }

  function freezeAutomaticClassificationSnapshot(): FrozenAutomaticClassificationSnapshot {
    const visibleSweep = sweepRef.current;
    const detections = [...detectionsRef.current];
    const rankingAdmission = visibleClassificationTargetProjectionAdmission(
      detections,
      visibleSweep,
    );
    return {
      ...(visibleSweep ? { visibleSweep } : {}),
      detections,
      history: [...historyRef.current],
      analysisSequence: analysisSequence.current,
      rankingAdmission,
      projections: rankingAdmission.projections,
    };
  }

  function freezeAutomaticDetectedPowerStaging(
    winner: ClassificationCaptureTargetProjection | undefined,
    stagedCenterHz: number | undefined,
    stagingFailure?: string,
  ): AutomaticDetectedPowerStaging {
    if (!winner) {
      return {
        status: 'not-requested',
        reason: 'no-ranked-target',
        centerHz: null,
        configuration: null,
      };
    }
    if (stagedCenterHz !== undefined) {
      return {
        status: 'staged',
        centerHz: stagedCenterHz,
        configuration: structuredClone(zeroConfigRef.current),
      };
    }
    const capability = instrumentRef.current.session?.capabilities.acquisitions
      .find((candidate) => candidate.kind === 'detected-power-timeseries');
    return {
      status: 'unavailable',
      reason: capability?.kind === 'detected-power-timeseries'
        ? 'target-not-stageable'
        : 'detected-power-capability-unavailable',
      ...(stagingFailure ? { error: stagingFailure } : {}),
      centerHz: null,
      configuration: null,
    };
  }

  async function executeFrozenAutomaticClassification(
    work: ClassificationWork,
    signal?: AbortSignal,
  ): Promise<ClassificationExecutionRecord> {
    try {
      signal?.throwIfAborted();
      const results = await waitForClassificationSource(
        Promise.all(work.requests.map(({ detection, evidence }) =>
          requireClassifierRuntime().classifier.classify(detection, evidence, signal))),
        signal,
      );
      return { work, status: 'ready', results };
    } catch (value) {
      return { work, status: 'failed', error: errorMessage(value) };
    }
  }

  function waitForClassificationSource<T>(
    source: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return source;
    try { signal.throwIfAborted(); }
    catch (value) { return Promise.reject(value); }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        settle();
      };
      const abort = () => finish(() => reject(
        signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
      ));
      signal.addEventListener('abort', abort, { once: true });
      void source.then(
        (value) => finish(() => resolve(value)),
        (reason) => finish(() => reject(reason)),
      );
    });
  }

  function retireClassificationOperations(reason: string): void {
    lastAutomaticClassificationOperation.current = undefined;
    classificationExecution.current = undefined;
    pendingClassificationWork.current = undefined;
    const taskAbortController = classificationTaskAbortController.current;
    if (taskAbortController && !taskAbortController.signal.aborted) {
      taskAbortController.abort(new Error(reason));
    }
    const direct = directClassificationTask.current;
    if (direct && !direct.abortController.signal.aborted) {
      direct.abortController.abort(new Error(reason));
    }
    automaticClassificationDrainGeneration.current++;
    const drain = automaticClassificationDrain.current;
    if (drain && !drain.abortController.signal.aborted) {
      drain.abortController.abort(new Error(reason));
    }
  }

  function settleAutomaticClassificationOperation(
    operation: AutomaticClassificationOperationRecord,
    outcome: ClassificationExecutionRecord,
  ): void {
    operation.execution = outcome;
    if (lastAutomaticClassificationOperation.current !== operation) return;
    const work = operation.work;
    if (!work) return;
    if (outcome.status === 'ready' && outcome.results) {
      if (classificationExecution.current?.work.revision === work.revision) {
        completeClassificationExecution(work, outcome.results);
      }
      // A pinned operation is independently pollable, but it may affect the
      // visible cards only while its exact sweep and selection still own UI.
      if (classificationWorkIsCurrent(work)) {
        setClassifications(classificationResultsBoundToWork(work, outcome.results));
      }
    } else if (outcome.status === 'failed'
      && classificationExecution.current?.work.revision === work.revision) {
      failClassificationExecution(work, outcome.error ?? 'Bayesian classification failed');
    }
  }

  function exactInFlightClassificationPromise(
    work: ClassificationWork,
  ): Promise<ClassificationExecutionRecord> | undefined {
    if (classificationTaskWork.current?.revision === work.revision) {
      return classificationTask.current;
    }
    const direct = directClassificationTask.current;
    return direct?.work.revision === work.revision ? direct.promise : undefined;
  }

  async function executePinnedAutomaticClassification(
    operation: AutomaticClassificationOperationRecord,
    signal: AbortSignal,
    preferredSource?: Promise<ClassificationExecutionRecord>,
  ): Promise<ClassificationExecutionRecord> {
    const work = operation.work;
    if (!work) throw new Error('Automatic classification operation omitted frozen work');
    pinnedAutomaticClassificationRevisions.current.set(
      work.revision,
      (pinnedAutomaticClassificationRevisions.current.get(work.revision) ?? 0) + 1,
    );
    try {
      let outcome: ClassificationExecutionRecord;
      try {
        const source = preferredSource ?? exactInFlightClassificationPromise(work);
        outcome = source
          ? await waitForClassificationSource(source, signal)
          : await executeFrozenAutomaticClassification(work, signal);
      } catch (value) {
        outcome = { work, status: 'failed', error: errorMessage(value) };
      }
      // The normal classification lane may reject before inference when its
      // renderer lifecycle is superseded. Retry from the frozen evidence only
      // while this exact Auto operation remains the pollable owner. Stop does
      // not clear that owner; a newer Auto, device change, or span invalidation
      // does, and therefore must never trigger hidden work afterward.
      if (outcome.status === 'failed'
        && outcome.error === 'Classification evidence revision was superseded before inference'
        && !signal.aborted
        && lastAutomaticClassificationOperation.current === operation) {
        return executeFrozenAutomaticClassification(work, signal);
      }
      return outcome;
    } finally {
      const remaining = (pinnedAutomaticClassificationRevisions.current.get(work.revision) ?? 1) - 1;
      if (remaining > 0) pinnedAutomaticClassificationRevisions.current.set(work.revision, remaining);
      else pinnedAutomaticClassificationRevisions.current.delete(work.revision);
    }
  }

  function startAutomaticClassificationDrain(
    operation: AutomaticClassificationOperationRecord,
    preferredSource?: Promise<ClassificationExecutionRecord>,
  ): Promise<ClassificationExecutionRecord> {
    const state: AutomaticClassificationDrainState = {
      generation: automaticClassificationDrainGeneration.current,
      abortController: new AbortController(),
      activeOperation: operation,
    };
    const promise = (async (): Promise<ClassificationExecutionRecord> => {
      let activeOperation = operation;
      let source = preferredSource;
      let precedingOutcome: ClassificationExecutionRecord | undefined;
      while (true) {
        state.activeOperation = activeOperation;
        const activeWork = activeOperation.work;
        if (!activeWork) {
          throw new Error('Automatic classification drain omitted frozen work');
        }
        const outcome = precedingOutcome?.work.revision === activeWork.revision
          ? { ...precedingOutcome, work: activeWork }
          : await executePinnedAutomaticClassification(
            activeOperation,
            state.abortController.signal,
            source,
          );
        if (state.generation !== automaticClassificationDrainGeneration.current
          || state.abortController.signal.aborted) {
          // Invalidation aborts the active source but retains this one drain
          // slot until the abort settles. A synchronous post-invalidation
          // Auto can attach one replaceable latest operation to the same
          // promise; rotate its generation/controller only after the retired
          // work has released the slot. With no replacement, cleanup clears
          // the drain before the next browser event can start another one.
          const replacement = lastAutomaticClassificationOperation.current;
          if (!replacement?.work
            || replacement.execution?.status !== 'inference-pending'
            || replacement.promise !== state.promise) return outcome;
          activeOperation = replacement;
          state.generation = automaticClassificationDrainGeneration.current;
          state.abortController = new AbortController();
          source = replacement.preferredSource;
          precedingOutcome = undefined;
          continue;
        }
        settleAutomaticClassificationOperation(activeOperation, outcome);

        const latest = lastAutomaticClassificationOperation.current;
        if (!latest?.work
          || latest === activeOperation
          || latest.execution?.status !== 'inference-pending'
          || latest.promise !== state.promise) return outcome;
        activeOperation = latest;
        source = latest.preferredSource;
        precedingOutcome = outcome;
      }
    })();
    state.promise = promise;
    automaticClassificationDrain.current = state;
    operation.promise = promise;
    void promise.then(
      () => {
        if (automaticClassificationDrain.current === state) {
          automaticClassificationDrain.current = undefined;
        }
      },
      () => {
        if (automaticClassificationDrain.current === state) {
          automaticClassificationDrain.current = undefined;
        }
      },
    );
    return promise;
  }

  async function selectAutomaticClassificationCandidate() {
    // Freeze every authority input before changing selection. No awaited work
    // is allowed to move the visible target/rank window under this operation.
    const snapshot = freezeAutomaticClassificationSnapshot();
    const supersededOperation = lastAutomaticClassificationOperation.current;
    const winner = snapshot.projections[0];
    const previousSelection = resolveVisibleClassificationTargetSelection(
      snapshot.detections,
      snapshot.visibleSweep,
      explicitClassificationIdRef.current,
    );
    const automaticSelection: ClassificationTargetSelection = {
      ...(winner ? {
        detectionId: winner.projectedRepresentative.id,
        ...(winner.rawTarget.id === winner.projectedRepresentative.id
          ? {}
          : { rawTargetId: winner.rawTarget.id }),
      } : {}),
      origin: 'automatic',
    };
    const priorWasExplicit = explicitClassificationIdRef.current !== undefined;
    const hadSelectionConditionedCapture = zeroCaptureRef.current !== undefined
      || zeroCaptureReceiptRef.current !== undefined;
    if (priorWasExplicit
      && sameClassificationSelectionIdentity(previousSelection, automaticSelection)) {
      // The explicit intent ref itself owns an operator-conditioned capture,
      // even if a newly invalid rank can no longer resolve that ID.
      classificationSelectionRevision.current++;
    } else {
      supersedeClassificationSelectionIfChanged(
        previousSelection,
        automaticSelection,
      );
    }
    setExplicitClassificationId(undefined);
    // Detected-power tuning is an optional capability-local projection. A
    // range/lattice rejection must not suppress valid spectrum inference.
    const stagedDetectedPower = safelyStageClassificationCandidate(
      winner?.rawTarget.id,
    );
    // This exact staging object is part of the operation receipt. Never read
    // zeroConfigRef again after inference yields to another UI action.
    const detectedPowerStaging = freezeAutomaticDetectedPowerStaging(
      winner,
      stagedDetectedPower.centerHz,
      stagedDetectedPower.failure,
    );
    // A preferred-target receipt is a different statistical condition from
    // automatic rank zero even when both project to the same raw tune owner.
    if (priorWasExplicit) {
      if (hadSelectionConditionedCapture) clearClassificationCapture();
      setClassifications([]);
    }

    const operation: AutomaticClassificationOperationRecord = {
      operationId: ++automaticClassificationOperationSequence.current,
      snapshot,
      selection: automaticSelection,
      detectedPowerStaging,
    };
    // A newer Auto action is the only operation allowed to supersede this
    // poll target. Ordinary sweeps, stops, and manual retargets cannot.
    lastAutomaticClassificationOperation.current = operation;
    if (snapshot.visibleSweep && winner
      && snapshot.rankingAdmission.status === 'ready') {
      const evidenceSweeps = exactClassificationEvidenceSweeps(
        winner.projectedRepresentative,
        snapshot.history,
      );
      if (evidenceSweeps && evidenceSweeps.length > 0) {
        const evidence = classificationEvidenceForDetection(
          winner.projectedRepresentative,
          evidenceSweeps,
        );
        const work: ClassificationWork = {
          revision: classificationWorkRevision(
            snapshot.analysisSequence,
            snapshot.visibleSweep,
            automaticSelection,
            evidence,
          ),
          sequence: snapshot.analysisSequence,
          visibleSweep: {
            id: snapshot.visibleSweep.id,
            sequence: snapshot.visibleSweep.sequence,
            capturedAt: snapshot.visibleSweep.capturedAt,
          },
          target: {
            projectedRepresentativeId: winner.projectedRepresentative.id,
            rawTargetId: winner.rawTarget.id,
            selectionOrigin: 'automatic',
          },
          requests: [{ detection: winner.projectedRepresentative, evidence }],
        };
        operation.work = work;
        const activeAutomaticOperation = automaticClassificationDrain.current?.activeOperation;
        const reusableAutomaticOperation = [
          supersededOperation,
          activeAutomaticOperation,
        ].find((candidate) => candidate?.work?.revision === work.revision
          && (candidate.execution?.status === 'inference-pending'
            || candidate.execution?.status === 'ready'));
        if (reusableAutomaticOperation) {
          // Repeated Auto on the exact frozen revision reuses one receipt and
          // one promise. If it selects the currently active root, any queued
          // different revision is atomically discarded rather than chained.
          lastAutomaticClassificationOperation.current = reusableAutomaticOperation;
          if (reusableAutomaticOperation.execution?.status === 'ready'
            && reusableAutomaticOperation.execution.results) {
            setClassifications(classificationResultsBoundToWork(
              reusableAutomaticOperation.work!,
              reusableAutomaticOperation.execution.results,
            ));
          }
          return agentAutomaticClassificationSelection(
            reusableAutomaticOperation.snapshot,
            reusableAutomaticOperation.detectedPowerStaging,
            reusableAutomaticOperation.execution,
          );
        }
        const currentExecution = classificationExecution.current;
        if (currentExecution?.work.revision === work.revision
          && currentExecution.status === 'ready'
          && currentExecution.results) {
          operation.execution = currentExecution;
          setClassifications(currentExecution.results.filter((result) =>
            agentClassificationResultBinding(currentExecution.work, result).bound));
        } else {
          stageClassificationExecution(work);
          operation.execution = { work, status: 'inference-pending' };
          if (classifierRuntime.current?.status !== 'unavailable') {
            const existingDrain = automaticClassificationDrain.current;
            const canAwaitWithoutBlockingAnotherLane = !continuousRequested.current
              && !classificationTask.current
              && !directClassificationTask.current
              && !existingDrain;
            if (pendingClassificationWork.current?.revision === work.revision) {
              pendingClassificationWork.current = undefined;
            }
            const exactSource = exactInFlightClassificationPromise(work);
            const existingDrainPromise = existingDrain?.promise;
            if (existingDrainPromise && exactSource) {
              // The one replaceable latest operation retains its exact
              // normal/direct receipt even if that task settles before the
              // unrelated active Auto root releases the drain. Dropping this
              // source would cause a second inference for the same revision.
              operation.preferredSource = exactSource;
            }
            const promise = existingDrainPromise ?? startAutomaticClassificationDrain(
              operation,
              exactSource,
            );
            if (existingDrainPromise) operation.promise = existingDrainPromise;
            if (canAwaitWithoutBlockingAnotherLane) {
              await promise;
            }
          }
        }
      }
    }
    return agentAutomaticClassificationSelection(
      snapshot,
      detectedPowerStaging,
      operation.execution,
    );
  }

  function classificationEvidenceForDetection(
    detection: DetectedSignal,
    sweeps: readonly Sweep[],
  ) {
    const capture = zeroCaptureRef.current;
    const receipt = zeroCaptureReceiptRef.current;
    const spectrumSweepIds = zeroCaptureSpectrumSweepIdsRef.current;
    if (!capture
      || !receipt
      || !spectrumSweepIds
      || receipt.selection.projectedRepresentativeId !== detection.id
      || !captureReceiptRepresentativeMatches(receipt, detection)) {
      return { sweeps };
    }
    return {
      sweeps,
      zeroSpan: capture,
      zeroSpanSpectrumSweepIds: spectrumSweepIds,
      detectedPowerCaptureReceipt: receipt,
    };
  }

  function synchronizeContinuousAnalyzer(): Promise<void> {
    const active = analyzerRetuneTask.current;
    if (active) return active;
    if (!continuousRequested.current) return Promise.resolve();
    const task = runInstrumentTransaction('retune-continuous-analyzer', () => retuneContinuousToLatest());
    analyzerRetuneTask.current = task;
    void task.then(
      () => { if (analyzerRetuneTask.current === task) analyzerRetuneTask.current = undefined; },
      () => { if (analyzerRetuneTask.current === task) analyzerRetuneTask.current = undefined; },
    );
    return task;
  }

  async function retuneContinuousToLatest(): Promise<void> {
    try {
      setAcquisition('retuning');
      setNotice('Retuning continuous acquisition…');
      await stopStreamingAndReleaseConfiguration();
      while (true) {
        if (!continuousRequested.current) {
          completeContinuousStop();
          return;
        }
        const targetRevision = analyzerRevision.current;
        const configured = await configureAnalyzer(analyzerRef.current, 'retuning');
        if (!continuousRequested.current) {
          completeContinuousStop();
          return;
        }
        if (targetRevision !== analyzerRevision.current) continue;
        await startStreamingWithConfiguration(configured.configurationRevision);
        if (!continuousRequested.current) {
          await stopStreamingAndReleaseConfiguration();
          completeContinuousStop();
          return;
        }
        if (targetRevision === analyzerRevision.current) break;
        await stopStreamingAndReleaseConfiguration();
      }
      setAcquisition('streaming');
      setNotice('Continuous acquisition retuned');
    } catch (value) {
      setAcquisition('failed');
      setError(`Analyzer retune failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  async function updateAnalyzer(input: AnalyzerConfigPatch): Promise<AnalyzerConfig> {
    const staged = stageAnalyzerPatch(input);
    if (staged.changed && (continuousRequested.current || analyzerRetuneTask.current)) await synchronizeContinuousAnalyzer();
    return staged.configuration;
  }

  function updateAnalyzerFromUi(input: AnalyzerConfigPatch): void {
    try {
      const staged = stageAnalyzerPatch(input);
      if (staged.changed && (continuousRequested.current || analyzerRetuneTask.current)) void synchronizeContinuousAnalyzer().catch(() => undefined);
    } catch (value) {
      setError(`Analyzer configuration failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  function recordSweepEvidence(
    next: Sweep,
    configurationRevision: string,
    ownership?: ContinuousStreamOwnership,
  ): RecordedSweep | undefined {
    const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    const currentAdmitted = capability?.kind === 'swept-spectrum'
      ? sweptSpectrumConfigurationFor(capability, analyzerRef.current)
      : undefined;
    if (!currentAdmitted || !sameSweptSpectrumConfiguration(next.requested, currentAdmitted)) {
      console.warn('[Analyzer] rejected stale sweep for a superseded staged configuration', { sweepId: next.id, requested: next.requested, staged: analyzerRef.current });
      return undefined;
    }
    const sequence = ++analysisSequence.current;
    const nextHistory = [next, ...historyRef.current].slice(0, HISTORY_LIMIT);
    const nextHistoryRevisions = [configurationRevision, ...historyConfigurationRevisions.current].slice(0, HISTORY_LIMIT);
    historyConfigurationRevisions.current = nextHistoryRevisions;
    retainEvidenceConfigurationRevisions();
    setSweep(next);
    setHistory(nextHistory);
    setTraceFrames(traceAccumulator.current.update(next));
    setFirmwareTraceFrames(next.firmwareTraces ?? []);
    const candidates = detector.current.analyze(next);
    const trackerRows = tracker.current.update(next, candidates);
    const tracked = sanitizeClassificationEvidenceDetections(trackerRows);
    if (tracked.length !== trackerRows.length) {
      console.warn('[Classification] quarantined malformed tracker rows before ranking, rendering, or agent projection', {
        sweepId: next.id,
        quarantinedRows: trackerRows.length - tracked.length,
      });
    }
    setDetections(tracked);
    let selectedRepresentative = selectVisibleClassificationRepresentative(
      tracked,
      next,
      explicitClassificationIdRef.current,
    );
    let selectedSignal = selectedRepresentative?.detection;
    // Establish selected-target ownership before even a synchronous test
    // classifier can complete. The render effect is an eventual UI mirror;
    // it must never arrive later and erase a result for the target this exact
    // evidence revision already admitted.
    safelyStageClassificationCandidate(
      selectedRepresentative?.selection.rawTargetId ?? selectedSignal?.id,
    );
    const cachedCapture = zeroCaptureRef.current;
    const cachedReceipt = zeroCaptureReceiptRef.current;
    const cachedSweepIds = zeroCaptureSpectrumSweepIdsRef.current;
    if (cachedCapture) {
      const projectedDetectionId = cachedReceipt?.selection.projectedRepresentativeId
        ?? cachedCapture.targetDetectionId;
      const target = selectedSignal?.id === projectedDetectionId ? selectedSignal : undefined;
      const currentSweepIds = target ? classificationWindowSweepIds(target, nextHistory) : [];
      if (!cachedReceipt
        || !target
        || !captureReceiptRepresentativeMatches(cachedReceipt, target)
        || !cachedSweepIds
        || currentSweepIds.length !== cachedSweepIds.length
        || currentSweepIds.some((sweepId, index) => sweepId !== cachedSweepIds[index])) {
        clearClassificationCapture();
        selectedRepresentative = selectVisibleClassificationRepresentative(
          tracked,
          next,
          explicitClassificationIdRef.current,
        );
        selectedSignal = selectedRepresentative?.detection;
      }
    }
    const currentSignals = selectedSignal ? [selectedSignal] : [];
    const currentSignalIds = new Set(currentSignals.map(({ id }) => id));
    if (ownership) {
      // A continuous producer can advance while one selected-signal worker
      // request is in flight. Retain only that current target's completed
      // projection; the newest completed work replaces it monotonically.
      const retained = classificationsRef.current.filter(({ detectionId }) => currentSignalIds.has(detectionId));
      if (retained.length !== classificationsRef.current.length) setClassifications(retained);
    } else {
      // Single/capture operations retain the exact evidence-revision contract:
      // no preceding result is shown while the new revision is unresolved.
      setClassifications([]);
    }
    const requests = currentSignals.flatMap((detection) => {
      const evidenceSweeps = exactClassificationEvidenceSweeps(detection, nextHistory);
      if (!evidenceSweeps) {
        console.warn('[Classification] selected target omitted exact external sweep provenance', {
          sweepId: next.id,
          detectionId: detection.id,
        });
        return [];
      }
      return [{
        detection,
        evidence: classificationEvidenceForDetection(detection, evidenceSweeps),
      }];
    });
    if (requests.length === 0 || !selectedRepresentative) return {};
    const selection = selectedRepresentative.selection;
    const work: ClassificationWork = {
      revision: classificationWorkRevision(
        sequence,
        next,
        selection,
        requests[0]!.evidence,
      ),
      sequence,
      ...(ownership ? { ownership } : {}),
      visibleSweep: {
        id: next.id,
        sequence: next.sequence,
        capturedAt: next.capturedAt,
      },
      target: {
        projectedRepresentativeId: selectedRepresentative.detection.id,
        rawTargetId: selection.rawTargetId ?? selectedRepresentative.detection.id,
        selectionOrigin: selection.origin,
      },
      requests,
    };
    stageClassificationExecution(work);
    return { classification: work };
  }

  function drainPendingClassificationWorkIfIdle(): void {
    if (classificationTask.current || directClassificationTask.current) return;
    const pending = pendingClassificationWork.current;
    pendingClassificationWork.current = undefined;
    if (pending) admitClassificationWork(pending);
  }

  function registerDirectClassificationTask(
    work: ClassificationWork,
    promise: Promise<ClassificationExecutionRecord>,
    abortController: AbortController,
  ): DirectClassificationTaskRecord {
    const record = { work, promise, abortController } satisfies DirectClassificationTaskRecord;
    directClassificationTask.current = record;
    void promise.then(
      () => finishDirectClassificationTask(record),
      () => finishDirectClassificationTask(record),
    );
    return record;
  }

  function finishDirectClassificationTask(record: DirectClassificationTaskRecord): void {
    if (directClassificationTask.current !== record) return;
    directClassificationTask.current = undefined;
    drainPendingClassificationWorkIfIdle();
  }

  function classifyRecordedSweep(
    recorded: RecordedSweep,
  ): Promise<ClassificationExecutionRecord | undefined> {
    const work = recorded.classification;
    if (!work || work.requests.length === 0) return Promise.resolve(undefined);
    const abortController = new AbortController();
    const promise = executeRecordedSweepClassification(work, abortController.signal);
    registerDirectClassificationTask(work, promise, abortController);
    return promise;
  }

  async function executeRecordedSweepClassification(
    work: ClassificationWork,
    signal: AbortSignal,
  ): Promise<ClassificationExecutionRecord> {
    // Yield once so React can commit the newly ingested trace before even a
    // test/non-worker classifier begins. Production inference runs in the
    // module worker and therefore remains off the renderer thread.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal.aborted) {
      return { work, status: 'failed', error: errorMessage(signal.reason) };
    }
    if (!classificationWorkIsCurrent(work)) {
      const failure = new Error('Classification evidence revision was superseded before inference');
      failClassificationExecution(work, failure);
      return { work, status: 'failed', error: failure.message };
    }
    try {
      const results = await waitForClassificationSource(
        Promise.all(work.requests.map(({ detection, evidence }) =>
          requireClassifierRuntime().classifier.classify(detection, evidence, signal))),
        signal,
      );
      if (!signal.aborted && classificationWorkIsCurrent(work)) {
        completeClassificationExecution(work, results);
        setClassifications(classificationResultsBoundToWork(work, results));
      }
      // The operation receipt remains bound to its frozen work even if a
      // later human action owns the UI by publication time. In that case the
      // result is returned to the initiating action but is not published into
      // the newer UI selection.
      return { work, status: 'ready', results };
    } catch (value) {
      if (!signal.aborted && classificationWorkIsCurrent(work)) {
        failClassificationExecution(work, value);
        setClassifications([]);
        setError(errorMessage(value));
      }
      return { work, status: 'failed', error: errorMessage(value) };
    }
  }

  function acquire(): Promise<Sweep> { return runInstrumentTransaction('acquire-spectrum', () => acquireOwned()); }

  async function acquireOwned(): Promise<Sweep> {
    try {
      const sessionId = requireConnected().sessionId;
      const configured = await configureAnalyzer(analyzerRef.current);
      const configurationLease = leaseConfiguration(configured.configurationRevision, 'swept-spectrum');
      setAcquisition('acquiring');
      try {
        const measurement = await acquireInstrument();
        if (measurement.kind !== 'swept-spectrum') throw new Error(`Expected swept-spectrum measurement, received ${measurement.kind}`);
        if (measurement.sessionId !== sessionId || instrumentRef.current.session?.sessionId !== sessionId) {
          throw new Error(`Measurement ${measurement.measurementId} was invalidated with instrument session ${sessionId}`);
        }
        if (measurement.configurationRevision !== configured.configurationRevision) {
          throw new Error(`Measurement ${measurement.measurementId} referenced superseding configuration ${measurement.configurationRevision}; expected ${configured.configurationRevision}`);
        }
        const active = requireConnected();
        const requested = requireConfiguration(measurement.configurationRevision, 'swept-spectrum', `Measurement ${measurement.measurementId}`);
        const next = projectSpectrumMeasurement(measurement, active, requested);
        const recorded = recordSweepEvidence(next, measurement.configurationRevision);
        if (!recorded) throw new Error(`Sweep ${next.id} was acquired for a superseded analyzer configuration`);
        await classifyRecordedSweep(recorded);
        setAcquisition('complete');
        return next;
      } finally {
        configurationLease.release();
      }
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function acquireFromUi(): Promise<void> {
    try {
      if (acquisitionModeForWorkspace(workspaceRef.current, continuousModeRef.current) === 'complex-iq') {
        await acquireIq();
      } else {
        await acquire();
      }
    } catch { /* The owned acquisition path presents its boundary failure. */ }
  }

  function stageIqConfiguration(input: ComplexIqConfiguration): void {
    try {
      const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
      const next = capability?.kind === 'complex-iq'
        ? reconcileComplexIqConfiguration(capability, input)
        : complexIqConfigurationSchema.parse(input);
      if (sameComplexIqConfiguration(next, iqConfigurationRef.current)) return;
      iqConfigurationRevision.current++;
      setIqConfiguration(next);
      setError(undefined);
    } catch (value) {
      setError(`I/Q configuration failed: ${errorMessage(value)}`);
    }
  }

  function acquireIq(): Promise<ComplexIqMeasurement> {
    return runInstrumentTransaction('acquire-complex-iq', () => runWithContinuousPaused(
      'complex I/Q capture',
      () => acquireIqOwned(),
    ));
  }

  async function acquireIqOwned(options: {
    readonly configuration?: ComplexIqConfiguration;
    readonly publish?: () => boolean;
  } = {}): Promise<ComplexIqMeasurement> {
    const activeSession = requireConnected();
    requireIqAcquisitionAdmission(activeSession);
    const capability = activeSession.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (capability?.kind !== 'complex-iq') throw new Error('Active instrument does not advertise complex-I/Q acquisition');
    const requested = complexIqConfigurationFor(
      capability,
      options.configuration ?? iqConfigurationRef.current,
    );
    setError(undefined);
    setAcquisition('configuring');
    const configured = await configureIqOwned(requested, false);
    const configurationLease = leaseConfiguration(configured.configurationRevision, 'complex-iq');
    setAcquisition('acquiring');
    try {
      const measurement = await acquireConfiguredIq(configured, options.publish);
      setAcquisition('complete');
      return measurement;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    } finally {
      configurationLease.release();
    }
  }

  async function configureIqOwned(
    requested: ComplexIqConfiguration,
    background: boolean,
  ): Promise<InstrumentConfigurationState> {
    const sessionId = requireConnected().sessionId;
    const reservation = configurationRevisions.current.reserve();
    try {
      const configured = await configureInstrument(requested);
      if (configured.sessionId !== sessionId || instrumentRef.current.session?.sessionId !== sessionId) {
        throw new Error(`Complex-I/Q configuration response was invalidated with instrument session ${sessionId}`);
      }
      if (configured.configuration.kind !== 'complex-iq'
        || !sameComplexIqConfiguration(configured.configuration, requested)) {
        throw new Error('Instrument host returned a different complex-I/Q configuration than it admitted');
      }
      reservation.commit(configured.configurationRevision, { kind: 'complex-iq', admitted: configured.configuration });
      configurationRevisions.current.setActive(configured.configurationRevision);
      acceptConfiguration(configured);
      return configured;
    } catch (value) {
      reservation.release();
      if (!background) {
        setAcquisition('failed');
        setError(errorMessage(value));
      }
      throw value;
    }
  }

  async function acquireConfiguredIq(
    configured: InstrumentConfigurationState,
    publish?: () => boolean,
  ): Promise<ComplexIqMeasurement> {
    const sessionId = configured.sessionId;
    try {
      const measurement = await acquireInstrument();
      if (measurement.kind !== 'complex-iq') throw new Error(`Expected complex-iq measurement, received ${measurement.kind}`);
      if (measurement.sessionId !== sessionId || instrumentRef.current.session?.sessionId !== sessionId) {
        throw new Error(`Measurement ${measurement.measurementId} was invalidated with instrument session ${sessionId}`);
      }
      if (measurement.configurationRevision !== configured.configurationRevision) {
        throw new Error(`Measurement ${measurement.measurementId} referenced superseding configuration ${measurement.configurationRevision}; expected ${configured.configurationRevision}`);
      }
      const admitted = requireConfiguration(measurement.configurationRevision, 'complex-iq', `Measurement ${measurement.measurementId}`);
      if (measurement.centerHz !== admitted.centerHz
        || measurement.sampleRateHz !== admitted.sampleRateHz
        || measurement.bandwidthHz !== admitted.bandwidthHz
        || measurement.sampleCount !== admitted.sampleCount
        || measurement.sampleFormat !== admitted.sampleFormat) {
        throw new Error(`Measurement ${measurement.measurementId} geometry differs from its admitted complex-I/Q configuration`);
      }
      if (!publish || publish()) setIqCapture(measurement);
      return measurement;
    } catch (value) { throw value; }
  }

  function startContinuous(): Promise<void> {
    const mode = acquisitionModeForWorkspace(workspaceRef.current, continuousModeRef.current);
    return mode === 'complex-iq'
      ? startContinuousIq()
      : runInstrumentTransaction('start-continuous-acquisition', () => startContinuousOwned());
  }

  function startContinuousIq(): Promise<void> {
    if (continuousRequested.current || continuousRef.current) {
      return Promise.reject(new Error('Continuous acquisition is already running'));
    }
    const active = requireConnected();
    requireIqAcquisitionAdmission(active);
    const capability = active.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (capability?.kind !== 'complex-iq') {
      return Promise.reject(new Error('Active instrument does not advertise complex-I/Q acquisition'));
    }
    complexIqConfigurationFor(capability, iqConfigurationRef.current);
    continuousRequested.current = true;
    continuousIqGeneration.current++;
    setContinuous(true);
    setContinuousMode('complex-iq');
    setAcquisition('streaming');
    setError(undefined);
    setNotice('Continuous bounded I/Q capture started');
    const task = runContinuousIqLoop();
    continuousIqTask.current = task;
    void task.then(
      () => finishContinuousIqLoop(task),
      (value) => finishContinuousIqLoop(task, value),
    );
    return Promise.resolve();
  }

  async function runContinuousIqLoop(): Promise<void> {
    while (continuousRequested.current && continuousModeRef.current === 'complex-iq') {
      if (!await waitForContinuousIqAdmission()) break;
      const bufferTask = runInstrumentTransaction(CONTINUOUS_IQ_TRANSACTION, async () => {
        const ownership = await ensureContinuousIqConfiguration();
        return acquireConfiguredIq(ownership.configured, () =>
          continuousIqConfigurationOwnership.current === ownership
          && iqConfigurationRevision.current === ownership.stagedRevision
          && sameComplexIqConfiguration(iqConfigurationRef.current, ownership.configuration));
      });
      continuousIqBufferTask.current = bufferTask;
      try { await bufferTask; }
      finally {
        if (continuousIqBufferTask.current === bufferTask) continuousIqBufferTask.current = undefined;
      }
      if (!continuousRequested.current || continuousModeRef.current !== 'complex-iq') break;
      // Yield to pointer/keyboard/paint work between bounded driver buffers.
      // There is never more than one configure+acquire transaction in flight.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    releaseContinuousIqConfiguration();
  }

  async function ensureContinuousIqConfiguration(): Promise<ContinuousIqConfigurationOwnership> {
    const session = requireConnected();
    const stagedRevision = iqConfigurationRevision.current;
    const configuration = structuredClone(iqConfigurationRef.current);
    const existing = continuousIqConfigurationOwnership.current;
    if (existing
      && existing.sessionId === session.sessionId
      && existing.stagedRevision === stagedRevision
      && sameComplexIqConfiguration(existing.configuration, configuration)
      && configurationRevisions.current.has(existing.configured.configurationRevision)) {
      return existing;
    }
    releaseContinuousIqConfiguration();
    const capability = session.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (capability?.kind !== 'complex-iq') throw new Error('Active instrument does not advertise complex-I/Q acquisition');
    const requested = complexIqConfigurationFor(capability, configuration);
    const configured = await configureIqOwned(requested, true);
    const lease = leaseConfiguration(configured.configurationRevision, 'complex-iq');
    const ownership: ContinuousIqConfigurationOwnership = {
      sessionId: session.sessionId,
      stagedRevision,
      configuration: requested,
      configured,
      lease,
    };
    continuousIqConfigurationOwnership.current = ownership;
    return ownership;
  }

  function releaseContinuousIqConfiguration(): void {
    const ownership = continuousIqConfigurationOwnership.current;
    continuousIqConfigurationOwnership.current = undefined;
    ownership?.lease.release();
  }

  function finishContinuousIqLoop(task: Promise<void>, failure?: unknown): void {
    if (continuousIqTask.current !== task) return;
    continuousIqTask.current = undefined;
    releaseContinuousIqConfiguration();
    if (failure === undefined || !continuousRequested.current) return;
    continuousRequested.current = false;
    setContinuous(false);
    setAcquisition('failed');
    setNotice(undefined);
    setError(`Continuous I/Q acquisition failed: ${errorMessage(failure)}`);
  }

  async function startContinuousOwned(): Promise<void> {
    if (continuousRequested.current || continuousRef.current) throw new Error('Continuous acquisition is already running');
    continuousRequested.current = true;
    setContinuous(true);
    setContinuousMode('spectrum');
    try {
      while (true) {
        const targetRevision = analyzerRevision.current;
        const configured = await configureAnalyzer(analyzerRef.current);
        if (!continuousRequested.current) {
          completeContinuousStop();
          return;
        }
        if (targetRevision !== analyzerRevision.current) continue;
        setAcquisition('streaming');
        await startStreamingWithConfiguration(configured.configurationRevision);
        if (!continuousRequested.current) {
          await stopStreamingAndReleaseConfiguration();
          completeContinuousStop();
          return;
        }
        if (targetRevision === analyzerRevision.current) break;
        await stopStreamingAndReleaseConfiguration();
        if (!continuousRequested.current) {
          completeContinuousStop();
          return;
        }
      }
    } catch (value) {
      setAcquisition('failed');
      if (!continuousStreamOwnership.current) {
        continuousRequested.current = false;
        setContinuous(false);
      }
      setError(errorMessage(value));
      throw value;
    }
  }

  function stopContinuous(): Promise<void> {
    const existing = operatorContinuousStopRequest.current;
    if (existing) return existing.promise;
    if (!continuousRef.current && !continuousStreamOwnership.current && !continuousRequested.current) {
      return Promise.reject(new Error('Continuous acquisition is not running'));
    }
    // This intent flag is deliberately outside the transaction gate. Stop is
    // admitted even while a pause/configure/resume transaction owns the
    // instrument; every continuation observes it before starting another
    // host acquisition.
    continuousRequested.current = false;
    wakeContinuousIqAdmissionWaiters();
    setAcquisition('stopping');
    setNotice('Stopping continuous acquisition…');
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const request = { promise, resolve, reject };
    operatorContinuousStopRequest.current = request;
    void promise.catch(() => undefined);
    drainOperatorContinuousStop();
    return promise;
  }

  function drainOperatorContinuousStop(): void {
    const request = operatorContinuousStopRequest.current;
    if (!request || operatorContinuousStopTask.current || instrumentTransactionOwner.current) return;
    if (!continuousStreamOwnership.current) {
      completeContinuousStop();
      operatorContinuousStopRequest.current = undefined;
      request.resolve();
      return;
    }
    const task = runInstrumentTransaction('stop-continuous-acquisition', async () => {
      await stopStreamingAndReleaseConfiguration();
      completeContinuousStop();
    });
    operatorContinuousStopTask.current = task;
    void task.then(
      () => finishOperatorContinuousStop(task),
      (value) => finishOperatorContinuousStop(task, value),
    );
  }

  function finishOperatorContinuousStop(task: Promise<void>, failure?: unknown): void {
    if (operatorContinuousStopTask.current !== task) return;
    operatorContinuousStopTask.current = undefined;
    const request = operatorContinuousStopRequest.current;
    if (!request) return;
    operatorContinuousStopRequest.current = undefined;
    if (failure === undefined) {
      request.resolve();
      return;
    }
    setAcquisition('failed');
    setNotice(undefined);
    setError(`Continuous acquisition stop failed: ${errorMessage(failure)}`);
    request.reject(failure);
  }

  function completeContinuousStop(message = 'Continuous acquisition stopped'): void {
    continuousRequested.current = false;
    wakeContinuousIqAdmissionWaiters();
    releaseContinuousIqConfiguration();
    setContinuous(false);
    setAcquisition('complete');
    setNotice(message);
  }

  async function startContinuousFromUi(): Promise<void> { try { await startContinuous(); } catch { /* Visible in the workspace alert. */ } }
  async function stopContinuousFromUi(): Promise<void> { try { await stopContinuous(); } catch (value) { setError(errorMessage(value)); } }

  function acquireZeroSpan(): Promise<ZeroSpanCapture> {
    return runInstrumentTransaction('acquire-detected-power', () => runWithContinuousPaused(
      'detected-power capture',
      () => acquireZeroSpanOwned(),
    ));
  }

  async function acquireZeroSpanOwned(): Promise<ZeroSpanCapture> {
    const activeSession = requireConnected();
    const sessionId = activeSession.sessionId;
    const validated = zeroSpanConfigSchema.parse(zeroConfigRef.current);
    const preCaptureSignals = structuredClone(detectionsRef.current);
    const preCaptureHistory = [...historyRef.current];
    const preCaptureSweep = sweepRef.current;
    const requestedSelection = resolveVisibleClassificationTargetSelection(
      preCaptureSignals,
      preCaptureSweep,
      explicitClassificationIdRef.current !== undefined
        ? explicitClassificationIdRef.current
        : undefined,
    );
    const requestedSelectionRevision = classificationSelectionRevision.current;
    const requestedRawTargetId = requestedSelection.rawTargetId
      ?? requestedSelection.detectionId;
    const admittedTarget = resolveRuntimeAdmittedCaptureTarget(
      preCaptureSignals,
      preCaptureHistory,
      preCaptureSweep,
      requestedRawTargetId,
    );
    if (requestedRawTargetId !== undefined && admittedTarget === undefined) {
      const message = `Selected classification target ${requestedRawTargetId} is not available on an exact runtime-admitted eight-sweep window`;
      setError(message);
      throw new Error(message);
    }
    const preCaptureTarget = admittedTarget?.rawTarget;
    const preCaptureSweepIds = admittedTarget?.spectrumSweepIds ?? [];
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const reservation = configurationRevisions.current.reserve();
      let configuration: InstrumentConfigurationState;
      let admittedTargetTuneHz: number | undefined;
      try {
        const capability = activeSession.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
        if (!capability || capability.kind !== 'detected-power-timeseries') {
          throw new Error('Active instrument does not advertise detected-power acquisition');
        }
        const projectedTargetTuneHz = preCaptureTarget === undefined
          ? undefined
          : projectDetectedPowerTuneHz(
            preCaptureTarget.peakHz,
            capability.centerFrequencyHz,
          );
        admittedTargetTuneHz = admittedTarget === undefined
          ? undefined
          : projectedTargetTuneHz;
        const captureConfiguration = admittedTargetTuneHz === undefined
          ? validated
          : zeroSpanConfigSchema.parse({
            ...validated,
            frequencyHz: admittedTargetTuneHz,
          });
        const requested = detectedPowerConfigurationFor(
          capability,
          captureConfiguration,
        );
        if (admittedTargetTuneHz !== undefined) {
          commitZeroSpanConfiguration(captureConfiguration);
        }
        configuration = await configureInstrument(requested);
        if (configuration.sessionId !== sessionId || instrumentRef.current.session?.sessionId !== sessionId) {
          throw new Error(`Detected-power configuration response was invalidated with instrument session ${sessionId}`);
        }
        if (configuration.configuration.kind !== 'detected-power-timeseries'
          || JSON.stringify(configuration.configuration) !== JSON.stringify(requested)) {
          throw new Error('Instrument host returned a different detected-power configuration than it admitted');
        }
        reservation.commit(configuration.configurationRevision, { kind: 'detected-power-timeseries', admitted: configuration.configuration });
        configurationRevisions.current.setActive(configuration.configurationRevision);
      } catch (error) {
        reservation.release();
        throw error;
      }
      acceptConfiguration(configuration);
      const configurationLease = leaseConfiguration(configuration.configurationRevision, 'detected-power-timeseries');
      try {
        const measurement = await acquireInstrument();
        if (measurement.kind !== 'detected-power-timeseries') throw new Error(`Expected detected-power-timeseries measurement, received ${measurement.kind}`);
        if (measurement.sessionId !== sessionId || instrumentRef.current.session?.sessionId !== sessionId) {
          throw new Error(`Measurement ${measurement.measurementId} was invalidated with instrument session ${sessionId}`);
        }
        if (measurement.configurationRevision !== configuration.configurationRevision) {
          throw new Error(`Measurement ${measurement.measurementId} referenced superseding configuration ${measurement.configurationRevision}; expected ${configuration.configurationRevision}`);
        }
        const requested = requireConfiguration(measurement.configurationRevision, 'detected-power-timeseries', `Measurement ${measurement.measurementId}`);
        const capture = projectDetectedPowerMeasurement(
          measurement,
          activeSession,
          requested,
          preCaptureTarget?.id,
        );
        let captureReceipt: DetectedPowerCaptureReceipt | undefined;
        if (admittedTarget
          && preCaptureTarget
          && admittedTargetTuneHz === capture.frequencyHz
          && preCaptureSweepIds.length === 8) {
          try {
            captureReceipt = createDetectedPowerCaptureReceipt({
              activeSignals: preCaptureSignals,
              evidenceSweeps: preCaptureHistory,
              ...(requestedSelection.origin === 'explicit'
                ? { preferredDetectionId: preCaptureTarget.id }
                : {}),
              capture,
              admittedTargetTuneHz,
              spectrumSweepIds: preCaptureSweepIds,
            });
          } catch (value) {
            console.warn(
              '[Classification] detected-power capture remains unqualified',
              value,
            );
            setNotice(
              `Envelope captured without Bayesian qualification: ${errorMessage(value)}`,
            );
          }
        } else if (preCaptureTarget) {
          setNotice(
            'Envelope captured without Bayesian qualification: target was not admitted on the exact eight-sweep window and tune',
          );
        }
        try {
          await configureAnalyzer(analyzerRef.current);
        } catch (value) {
          throw new Error(`Zero-span capture ${capture.id} completed, but restoring the staged swept-analyzer configuration failed: ${errorMessage(value)}`);
        }
        if (!classificationSelectionStillOwns(
          requestedSelectionRevision,
          requestedSelection,
        )) {
          throw new Error(
            'Detected-power capture selection was superseded before evidence publication',
          );
        }
        zeroCaptureConfigurationRevision.current = measurement.configurationRevision;
        retainEvidenceConfigurationRevisions();
        zeroCaptureReceiptRef.current = captureReceipt;
        setZeroCapture(capture);
        setEnvelope(classifyZeroSpanEnvelope(capture));
        // The prior spectrum-only result is not a result for this newly
        // published detected-power evidence. Fail closed while the qualified
        // evidence revision is recomputed, including on classifier failure.
        setClassifications([]);
        const sequence = ++analysisSequence.current;
        zeroCaptureSpectrumSweepIdsRef.current = captureReceipt
          ? preCaptureSweepIds
          : undefined;
        const selected = admittedTarget?.detection;
        const evidenceSweeps = selected
          ? exactClassificationEvidenceSweeps(selected, preCaptureHistory)
          : undefined;
        if (captureReceipt
          && selected?.id !== captureReceipt.selection.projectedRepresentativeId) {
          throw new Error('Detected-power receipt no longer owns the selected classification representative');
        }
        if (selected && !evidenceSweeps) {
          throw new Error(`Selected classification target ${selected.id} omitted exact external sweep provenance`);
        }
        let results: readonly WaveformClassification[] = [];
        let completedWork: ClassificationWork | undefined;
        if (selected && evidenceSweeps && preCaptureSweep) {
          const evidence = classificationEvidenceForDetection(selected, evidenceSweeps);
          const work: ClassificationWork = {
            revision: classificationWorkRevision(
              sequence,
              preCaptureSweep,
              requestedSelection,
              evidence,
            ),
            sequence,
            visibleSweep: {
              id: preCaptureSweep.id,
              sequence: preCaptureSweep.sequence,
              capturedAt: preCaptureSweep.capturedAt,
            },
            target: {
              projectedRepresentativeId: selected.id,
              rawTargetId: admittedTarget.rawTarget.id,
              selectionOrigin: requestedSelection.origin,
            },
            requests: [{ detection: selected, evidence }],
          };
          completedWork = work;
          stageClassificationExecution(work);
          const directAbortController = new AbortController();
          const directPromise = (async (): Promise<ClassificationExecutionRecord> => {
            try {
              const directResults = [await waitForClassificationSource(
                requireClassifierRuntime().classifier.classify(
                  selected,
                  evidence,
                  directAbortController.signal,
                ),
                directAbortController.signal,
              )];
              if (sequence === analysisSequence.current
                && classificationWorkTargetIsCurrent(work)) {
                completeClassificationExecution(work, directResults);
              }
              return { work, status: 'ready', results: directResults };
            } catch (value) {
              if (!directAbortController.signal.aborted) {
                failClassificationExecution(work, value);
              }
              return { work, status: 'failed', error: errorMessage(value) };
            }
          })();
          registerDirectClassificationTask(work, directPromise, directAbortController);
          const directOutcome = await directPromise;
          if (directOutcome.status === 'failed') {
            throw new Error(directOutcome.error ?? 'Bayesian classification failed');
          }
          results = directOutcome.results ?? [];
        }
        if (sequence === analysisSequence.current
          && classificationSelectionStillOwns(
            requestedSelectionRevision,
            requestedSelection,
          )) setClassifications(completedWork
            ? classificationResultsBoundToWork(completedWork, results)
            : []);
        setAcquisition('complete');
        return capture;
      } finally {
        configurationLease.release();
      }
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function acquireZeroSpanFromUi(): Promise<void> { try { await acquireZeroSpan(); } catch { /* Visible in the workspace alert. */ } }

  function configureGeneratorWith(config: GeneratorConfig) {
    return runInstrumentTransaction('configure-rf-generator', () => runWithContinuousPaused(
      'generator configuration',
      () => configureGeneratorOwned(config),
    ));
  }

  async function configureGeneratorOwned(config: GeneratorConfig) {
    requireConnected();
    const validated = generatorConfigSchema.parse(config);
    setError(undefined);
    setAcquisition('configuring');
    try {
      const next = await executeInstrumentFeature({
        kind: 'rf-generator',
        action: 'configure',
        frequencyHz: validated.frequencyHz,
        levelDbm: validated.levelDbm,
        path: validated.path,
        modulation: validated.modulation === 'off'
          ? { mode: 'off' }
          : validated.modulation === 'am'
            ? { mode: 'am', modulationFrequencyHz: validated.modulationFrequencyHz, depthPercent: validated.amDepthPercent }
            : { mode: 'fm', modulationFrequencyHz: validated.modulationFrequencyHz, deviationHz: validated.fmDeviationHz },
      });
      acceptFeatureResult(next);
      setAcquisition('complete');
      return next;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function configureGeneratorFromUi(): Promise<void> { try { await configureGeneratorWith(generatorRef.current); } catch { /* Visible in the workspace alert. */ } }

  function setOutput(enabled: boolean) {
    return runInstrumentTransaction(enabled ? 'enable-rf-output' : 'disable-rf-output', () => runWithContinuousPaused(
      enabled ? 'RF output enable' : 'RF output disable',
      () => setOutputOwned(enabled),
      () => !enabled,
    ));
  }

  async function setOutputOwned(enabled: boolean) {
    requireConnected();
    setError(undefined);
    setAcquisition('configuring');
    try {
      await configureGeneratorOwned(generatorConfigSchema.parse(generatorRef.current));
      const next = await executeInstrumentFeature({ kind: 'rf-generator', action: 'set-output', enabled });
      acceptFeatureResult(next);
      setAcquisition('complete');
      return next;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function setOutputFromUi(enabled: boolean): Promise<void> { try { await setOutput(enabled); } catch { /* Visible in the workspace alert. */ } }

  function refreshDiagnostics(): Promise<readonly string[]> {
    return runInstrumentTransaction('read-instrument-diagnostics', () => refreshDiagnosticsOwned());
  }

  async function refreshDiagnosticsOwned(): Promise<readonly string[]> {
    const active = requireConnected();
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const capability = active.capabilities.features.find((feature) => feature.kind === 'diagnostics');
      if (!capability) throw new Error('Connected driver exposes no diagnostics capability');
      const next: string[] = [];
      for (const report of capability.reports) {
        const result = await executeInstrumentFeature({ kind: 'diagnostics', action: 'read', report });
        if (result.kind !== 'diagnostics') throw new Error(`Expected diagnostics feature result, received ${result.kind}`);
        next.push(`[${report}]`, ...result.lines);
      }
      setDiagnostics(next);
      setAcquisition('complete');
      return next;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function refreshDiagnosticsFromUi(): Promise<void> { try { await refreshDiagnostics(); } catch { /* Visible in the workspace alert. */ } }

  function captureScreen(): Promise<InstrumentScreenFrame> {
    return runInstrumentTransaction('capture-instrument-screen', () => captureScreenOwned());
  }

  async function captureScreenOwned(): Promise<InstrumentScreenFrame> {
    requireConnected();
    assertWorkspaceTransition(workspaceRef.current, 'device', currentGeneratorOutput());
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const result = await executeInstrumentFeature({ kind: 'screen', action: 'capture' });
      if (result.kind !== 'screen') throw new Error(`Expected screen feature result, received ${result.kind}`);
      const frame = result.frame;
      setScreenFrame(frame);
      applyWorkspace('device');
      setAcquisition('complete');
      return frame;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function captureScreenFromUi(): Promise<void> { try { await captureScreen(); } catch { /* Visible in the workspace alert. */ } }
  function queueRemoteTap(point: InstrumentScreenPoint): Promise<void> | undefined {
    // React state does not update synchronously, so the ref is the actual
    // one-slot admission gate. Repeated pointer events are dropped without
    // allocating a retained Promise/closure for every stale gesture.
    if (remoteGestureTask.current) return undefined;
    const sessionId = instrumentRef.current.session?.sessionId;
    if (!sessionId) {
      setError('Remote screen tap requires a connected instrument');
      return undefined;
    }
    const task = runInstrumentTransaction('remote-screen-tap', async () => {
      requireRemoteGestureSession(sessionId);
      await performRemoteTap(point, sessionId);
    });
    remoteGestureTask.current = task;
    setRemoteGestureActive(true);
    void task.then(
      () => finishRemoteGesture(task),
      (value) => {
        if (instrumentRef.current.session?.sessionId === sessionId) {
          setError(`Remote screen tap failed: ${errorMessage(value)}`);
        }
        finishRemoteGesture(task);
      },
    );
    return task;
  }

  function finishRemoteGesture(task: Promise<void>): void {
    if (remoteGestureTask.current !== task) return;
    remoteGestureTask.current = undefined;
    setRemoteGestureActive(false);
  }

  function requireRemoteGestureSession(sessionId: string): InstrumentSessionSnapshot {
    const active = requireConnected();
    if (active.sessionId !== sessionId || active.fault) {
      throw new Error(`Remote screen tap was invalidated with instrument session ${sessionId}`);
    }
    return active;
  }

  async function performRemoteTap(point: InstrumentScreenPoint, sessionId: string): Promise<void> {
    requireRemoteGestureSession(sessionId);
    const resume = continuousRequested.current;
    try {
      if (resume) {
        setAcquisition('retuning');
        setNotice('Pausing continuous acquisition for remote screen tap…');
        await stopStreamingAndReleaseConfiguration();
      }
      requireRemoteGestureSession(sessionId);
      await executeInstrumentFeature({ kind: 'touch', action: 'tap', x: point.x, y: point.y });
      if (resume && continuousRequested.current) {
        while (true) {
          if (!continuousRequested.current) break;
          requireRemoteGestureSession(sessionId);
          const targetRevision = analyzerRevision.current;
          const configured = await configureAnalyzer(analyzerRef.current, 'retuning');
          if (!continuousRequested.current) break;
          if (targetRevision !== analyzerRevision.current) continue;
          requireRemoteGestureSession(sessionId);
          await startStreamingWithConfiguration(configured.configurationRevision);
          if (!continuousRequested.current) {
            await stopStreamingAndReleaseConfiguration();
            break;
          }
          if (targetRevision === analyzerRevision.current) break;
          await stopStreamingAndReleaseConfiguration();
        }
        if (continuousRequested.current) {
          setAcquisition('streaming');
          setNotice('Continuous acquisition resumed after remote screen tap');
        } else {
          completeContinuousStop('Continuous acquisition stopped after remote screen tap');
        }
      } else if (resume) {
        completeContinuousStop('Continuous acquisition stopped after remote screen tap');
      }
    } catch (value) {
      setAcquisition('failed');
      setError(`Remote screen tap failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  function tapScreen(point: InstrumentScreenPoint): void { void queueRemoteTap(point); }

  async function exportLatest(format: 'csv' | 'json'): Promise<unknown> {
    const latestSweep = sweepRef.current;
    if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before exporting');
    setError(undefined);
    try {
      const result = await window.atomizerFiles.exportSweep({ sweep: latestSweep, format });
      if (result.status === 'saved') setNotice(`Saved ${result.bytesWritten.toLocaleString()} provenance-bearing bytes to ${result.path}`);
      return result;
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    }
  }

  async function exportLatestFromUi(format: 'csv' | 'json'): Promise<void> {
    try { await exportLatest(format); }
    catch { /* exportLatest already presents the boundary failure in the workspace. */ }
  }

  function applyWorkspace(next: WorkspaceId): void {
    const canonical = next === 'detection' ? 'classification' : next;
    assertWorkspaceTransition(workspaceRef.current, canonical, currentGeneratorOutput());
    if (canonical === 'iq' && !instrumentRef.current.session?.capabilities.acquisitions.some((capability) => capability.kind === 'complex-iq')) {
      throw new Error('The connected instrument does not advertise complex-I/Q acquisition');
    }
    setWorkspace(canonical);
    setError(undefined);
  }

  function changeWorkspace(next: WorkspaceId): void {
    try { applyWorkspace(next); }
    catch (value) { setError(errorMessage(value)); }
  }

  function applyDetectionConfiguration(input: SignalDetectionConfig): SignalDetectionConfig {
    const next = signalDetectionConfigSchema.parse(input);
    if (JSON.stringify(next) === JSON.stringify(detectionConfigRef.current)) return detectionConfigRef.current;
    detector.current.configure(next);
    tracker.current.configure(next);
    analysisSequence.current++;
    classificationSelectionRevision.current++;
    stagedClassificationTargetIdRef.current = undefined;
    setDetectionConfig(next);
    setDetections([]);
    setClassifications([]);
    setExplicitClassificationId(undefined);
    retireClassificationOperations('Classification detector configuration was invalidated');
    clearClassificationCapture();
    return next;
  }

  function commitZeroSpanConfiguration(input: ZeroSpanConfig): ZeroSpanConfig {
    const next = zeroSpanConfigSchema.parse(input);
    setZeroConfig(next);
    return next;
  }

  function updateZeroSpanConfiguration(update: (current: ZeroSpanConfig) => ZeroSpanConfig): ZeroSpanConfig {
    return commitZeroSpanConfiguration(update(zeroConfigRef.current));
  }

  function applyTrace(input: TraceConfiguration): TraceConfiguration {
    const trace = traceConfigurationSchema.parse(input);
    const next = traceBankConfigurationSchema.parse(traceConfigurationRef.current.map((item) => item.id === trace.id ? trace : item));
    traceAccumulator.current.configure(next);
    setTraceConfiguration(next);
    setTraceFrames(traceAccumulator.current.frames());
    setError(undefined);
    return trace;
  }

  function configureTrace(input: TraceConfiguration): void {
    try { applyTrace(input); }
    catch (value) { setError(`Trace configuration failed: ${errorMessage(value)}`); }
  }

  function resetTrace(traceId: TraceId): void {
    try {
      traceAccumulator.current.reset(traceId);
      setTraceFrames(traceAccumulator.current.frames());
      setNotice(`Trace ${traceId} memory cleared`);
    } catch (value) { setError(`Trace reset failed: ${errorMessage(value)}`); }
  }

  function configureFirmwareTraceVisibility(traceId: FirmwareTraceId, visible: boolean): FirmwareTraceVisibility {
    try {
      const current = visibleFirmwareTraceIdsRef.current;
      const next = firmwareTraceVisibilitySchema.parse(visible
        ? [...new Set([...current, traceId])].sort((left, right) => left - right)
        : current.filter((item) => item !== traceId));
      setVisibleFirmwareTraceIds(next);
      setError(undefined);
      return next;
    } catch (value) {
      setError(`Instrument trace visibility failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  function applyMarker(input: MarkerConfiguration): MarkerConfiguration {
    const marker = markerConfigurationSchema.parse(input);
    let next = markersRef.current.map((item) => item.id === marker.id ? marker : item);
    if (marker.mode === 'delta' && marker.referenceMarkerId !== undefined) {
      next = next.map((item) => item.id === marker.referenceMarkerId && !item.enabled ? { ...item, enabled: true } : item);
    }
    setMarkers(next);
    setActiveMarkerId(marker.id);
    setError(undefined);
    return marker;
  }

  function previewMarkerReading(marker: MarkerConfiguration) {
    let preview = markersRef.current.map((item) => item.id === marker.id ? marker : item);
    if (marker.mode === 'delta' && marker.referenceMarkerId !== undefined) {
      preview = preview.map((item) => item.id === marker.referenceMarkerId && !item.enabled
        ? { ...item, enabled: true }
        : item);
    }
    const frames = traceAccumulator.current.frames();
    return readMarkers(preview, frames, detectionsRef.current)
      .find((reading) => reading.markerId === marker.id);
  }

  function configureMarker(input: MarkerConfiguration): void {
    try { applyMarker(input); }
    catch (value) { setError(`Marker configuration failed: ${errorMessage(value)}`); }
  }

  function placeActiveMarker(frequencyHz: number): boolean {
    try {
      const markerId = activeMarkerIdRef.current;
      const marker = markersRef.current.find((item) => item.id === markerId);
      if (!marker) throw new Error(`Active marker M${markerId} is unavailable`);
      const applied = applyMarker({ ...marker, enabled: true, tracking: 'fixed', frequencyHz });
      const committed = markersRef.current.find((item) => item.id === markerId);
      return applied.frequencyHz === frequencyHz
        && committed?.enabled === true
        && committed.tracking === 'fixed'
        && committed.frequencyHz === frequencyHz;
    } catch (value) {
      setError(`Marker configuration failed: ${errorMessage(value)}`);
      return false;
    }
  }

  function runMarkerSearch(action: MarkerSearchAction, markerId: MarkerId = activeMarkerIdRef.current): void {
    try {
      const marker = markersRef.current.find((item) => item.id === markerId);
      if (!marker) throw new Error(`Marker M${markerId} is unavailable`);
      const frame = traceAccumulator.current.frames().find((item) => item.traceId === marker.traceId);
      if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
      const frequencyHz = searchMarker(frame, marker.frequencyHz, action, markerSearchConfigurationRef.current, detectionsRef.current);
      applyMarker({ ...marker, enabled: true, tracking: action === 'peak' ? 'peak' : 'fixed', frequencyHz });
      setNotice(`M${marker.id} moved by ${action.replace('-', ' ')} search`);
    } catch (value) { setError(`Marker search failed: ${errorMessage(value)}`); }
  }

  function applyMarkerSearch(input: MarkerSearchConfiguration): MarkerSearchConfiguration {
    const configuration = markerSearchConfigurationSchema.parse(input);
    setMarkerSearchConfiguration(configuration);
    setError(undefined);
    return configuration;
  }

  function configureMarkerSearch(input: MarkerSearchConfiguration): void {
    try { applyMarkerSearch(input); }
    catch (value) { setError(`Marker search criteria failed: ${errorMessage(value)}`); }
  }

  function applyDisplay(input: SpectrumDisplayConfiguration): SpectrumDisplayConfiguration {
    const configuration = spectrumDisplayConfigurationSchema.parse(input);
    setDisplayConfiguration(configuration);
    setError(undefined);
    return configuration;
  }

  function configureDisplay(input: SpectrumDisplayConfiguration): void {
    try { applyDisplay(input); }
    catch (value) { setError(`Display configuration failed: ${errorMessage(value)}`); }
  }

  function applyMeasurementView(input: MeasurementViewId): MeasurementViewId {
    const next = visibleMeasurementView(input);
    applyWorkspace('spectrum');
    setMeasurementView(next);
    return next;
  }

  function changeMeasurementView(input: MeasurementViewId): void {
    try { applyMeasurementView(input); }
    catch (value) { setError(`Measurement view failed: ${errorMessage(value)}`); }
  }

  function applyWaterfall(input: WaterfallConfiguration): WaterfallConfiguration {
    const configuration = waterfallConfigurationSchema.parse(input);
    setWaterfallConfiguration(configuration);
    setError(undefined);
    return configuration;
  }

  function configureWaterfall(input: WaterfallConfiguration): void {
    try { applyWaterfall(input); }
    catch (value) { setError(`Waterfall configuration failed: ${errorMessage(value)}`); }
  }

  function applyChannelMeasurement(input: ChannelMeasurementConfiguration): ChannelMeasurementConfiguration {
    const configuration = channelMeasurementConfigurationSchema.parse(input);
    setChannelConfiguration(configuration);
    setError(undefined);
    return configuration;
  }

  function configureChannelMeasurement(input: ChannelMeasurementConfiguration): void {
    try { applyChannelMeasurement(input); }
    catch (value) { setError(`Channel measurement configuration failed: ${errorMessage(value)}`); }
  }

  function applyEnvelopeStft(input: EnvelopeStftConfiguration): EnvelopeStftConfiguration {
    const configuration = envelopeStftConfigurationSchema.parse(input);
    setStftConfiguration(configuration);
    setError(undefined);
    return configuration;
  }

  function requireChannelMeasurement() {
    const latestSweep = sweepRef.current;
    if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before reading channel measurements');
    return measureChannel(latestSweep, channelConfigurationRef.current);
  }

  function requireEnvelopeStft() {
    const capture = zeroCaptureRef.current;
    if (!capture) throw new Error('Acquire a complete zero-span capture before reading the envelope STFT');
    return computeEnvelopeStft(capture, stftConfigurationRef.current);
  }

  function autoScaleDisplay(): void {
    const latestSweep = sweepRef.current;
    if (!latestSweep) { setError('Acquire a sweep before auto-scaling the display'); return; }
    configureDisplay(autoScaleSpectrum(latestSweep));
  }

  function systemTopology() {
    const active = instrumentRef.current.session;
    return {
      atomizer: { owner: 'atomizer', instrumentApiVersion: window.atomizerInstrument.version, role: 'instrument-host' },
      instrument: active ? {
        driverId: active.driverId,
        sourceKind: active.provenance.sourceKind,
        execution: active.provenance.execution,
        transport: active.provenance.transport,
        qualification: active.provenance.qualification,
        usbIdentityVerified: active.provenance.sourceKind === 'serial-port' ? active.provenance.device.usbIdentityVerified : false,
        sessionId: active.sessionId,
      } : null,
      firmwareTwin: { owner: 'tinysa-firmware', available: candidatesRef.current.some((candidate) => candidate.sourceKind === 'tinysa-firmware-twin'), connected: active?.provenance.sourceKind === 'tinysa-firmware-twin', integration: 'renode-monitor-v1', usbTransactionsModeled: false },
      signalLab: { owner: 'tinysa-signal-lab', available: candidatesRef.current.some((candidate) => candidate.sourceKind === 'signal-lab'), connected: active?.provenance.sourceKind === 'signal-lab', integration: 'measurement-bridge-v1', claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
    } as const;
  }

  function agentStagedConfiguration(
    stagedAnalyzer: AnalyzerConfig = analyzerRef.current,
    stagedDetectedPower: ZeroSpanConfig = zeroConfigRef.current,
  ) {
    const acquisitions = instrumentRef.current.session?.capabilities.acquisitions ?? [];
    const spectrum = acquisitions.find((capability) => capability.kind === 'swept-spectrum');
    const detectedPower = acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
    const spectrumModel = spectrum?.kind === 'swept-spectrum' ? spectrum.controls.model : null;
    const detectedPowerModel = detectedPower?.kind === 'detected-power-timeseries' ? detectedPower.controls.model : null;
    return {
      sweptSpectrum: {
        kind: 'swept-spectrum',
        applicability: spectrumModel === 'receiver'
          ? 'staged-receiver-intent'
          : spectrumModel === 'synthetic-scalar'
            ? 'staged-synthetic-geometry'
            : 'not-admitted-no-active-capability',
        controlModel: spectrumModel,
        startHz: stagedAnalyzer.startHz,
        stopHz: stagedAnalyzer.stopHz,
        points: stagedAnalyzer.points,
        sweepTimeSeconds: stagedAnalyzer.sweepTimeSeconds,
        ...(spectrumModel === 'receiver' ? {
          receiverControls: {
            applicability: 'staged-not-yet-admitted',
            acquisitionFormat: stagedAnalyzer.acquisitionFormat,
            resolutionBandwidthKhz: stagedAnalyzer.rbwKhz,
            attenuationDb: stagedAnalyzer.attenuationDb,
            detector: stagedAnalyzer.detector,
            spurRejection: stagedAnalyzer.spurRejection,
            lowNoiseAmplifier: stagedAnalyzer.lna,
            avoidSpurs: stagedAnalyzer.avoidSpurs,
            trigger: stagedAnalyzer.trigger,
          },
        } : { receiverControls: { applicability: 'not-applicable' } }),
      },
      detectedPower: {
        kind: 'detected-power-timeseries',
        applicability: detectedPowerModel === 'receiver'
          ? 'staged-receiver-intent'
          : detectedPowerModel === 'synthetic-scalar'
            ? 'staged-synthetic-geometry'
            : 'not-admitted-no-active-capability',
        controlModel: detectedPowerModel,
        centerHz: stagedDetectedPower.frequencyHz,
        sampleCount: stagedDetectedPower.points,
        sweepTimeSeconds: stagedDetectedPower.sweepTimeSeconds,
        ...(detectedPowerModel === 'receiver' ? {
          receiverControls: {
            applicability: 'staged-not-yet-admitted',
            resolutionBandwidthKhz: stagedDetectedPower.rbwKhz,
            attenuationDb: stagedDetectedPower.attenuationDb,
            trigger: stagedDetectedPower.trigger,
          },
        } : { receiverControls: { applicability: 'not-applicable' } }),
      },
    } as const;
  }

  function agentConfigurationContext(
    stagedAnalyzer: AnalyzerConfig = analyzerRef.current,
    stagedDetectedPower: ZeroSpanConfig = zeroConfigRef.current,
  ) {
    const active = instrumentRef.current.session?.configuration;
    return {
      admitted: active ? {
        configurationRevision: active.configurationRevision,
        configuredAt: active.configuredAt,
        configuration: active.configuration,
      } : null,
      staged: agentStagedConfiguration(stagedAnalyzer, stagedDetectedPower),
    } as const;
  }

  function agentAutomaticRankPopulation(
    snapshot: FrozenAutomaticClassificationSnapshot,
  ) {
    return snapshot.projections.map((projection, rank) => {
      const evidence = classificationCaptureTargetRankEvidence(projection.rawTarget);
      if (!evidence) {
        throw new Error(
          `Automatic classification rank ${rank} lost its frozen source-sweep evidence`,
        );
      }
      return {
        rank,
        rawTargetId: projection.rawTarget.id,
        projectedRepresentativeId: projection.projectedRepresentative.id,
        projectionKind: projection.projectionKind,
        rankEvidence: evidence,
      };
    });
  }

  function classificationInferenceRemainsPending(work: ClassificationWork): boolean {
    const pinned = lastAutomaticClassificationOperation.current;
    if (pinned?.work?.revision === work.revision
      && pinned.execution?.status === 'inference-pending'
      && pinned.promise !== undefined) return true;
    if (!classificationWorkLifecycleIsCurrent(work)
      || !classificationWorkTargetIsCurrent(work)) return false;
    return classificationTaskWork.current?.revision === work.revision
      || directClassificationTask.current?.work.revision === work.revision
      || pendingClassificationWork.current?.revision === work.revision;
  }

  function agentClassificationEvidenceWindow(work: ClassificationWork) {
    const request = work.requests[0];
    const externalSpectrumSweepIds = request?.evidence.sweeps.map((item) => item.id) ?? [];
    let spectrumSweepIds = externalSpectrumSweepIds;
    let modelEvidenceProjection:
      | { readonly status: 'ready' }
      | { readonly status: 'failed'; readonly error: string } = { status: 'ready' };
    if (request) {
      try {
        spectrumSweepIds = [...extractObservableFeatures(
          request.detection,
          request.evidence,
        ).sweepIds];
      } catch (value) {
        modelEvidenceProjection = {
          status: 'failed',
          error: errorMessage(value),
        };
      }
    }
    const zeroSpanSpectrumSweepIds = request?.evidence.zeroSpanSpectrumSweepIds ?? [];
    return {
      spectrumSweepIds,
      externalSpectrumSweepIds,
      modelEvidenceProjection,
      spectrumWindow: {
        order: 'newest-to-oldest' as const,
        count: spectrumSweepIds.length,
        newestSweepId: spectrumSweepIds[0] ?? null,
        oldestSweepId: spectrumSweepIds.at(-1) ?? null,
        maximumModelWindowSweeps: 8,
      },
      zeroSpanCaptureId: request?.evidence.zeroSpan?.id ?? null,
      zeroSpanSpectrumSweepIds,
    };
  }

  function agentClassificationResultBinding(
    work: ClassificationWork,
    result: WaveformClassification,
  ) {
    const request = work.requests[0];
    const evidence = agentClassificationEvidenceWindow(work);
    const receiptMode = request?.evidence.detectedPowerCaptureReceipt?.selection.mode;
    const receiptSelectionOriginMatches = receiptMode === undefined
      || (work.target.selectionOrigin === 'automatic'
        ? receiptMode === 'integrated-excess-current'
        : receiptMode === 'preferred-target');
    const expectedDetectedPowerSelectionCondition = receiptMode === undefined
      ? null
      : work.target.selectionOrigin === 'automatic'
        ? 'automatic-current-source-sweep-integrated-excess-rank-0'
        : 'operator-preferred-current-target';
    const targetMatches = result.detectionId === work.target.projectedRepresentativeId;
    const centerHzMatches = request !== undefined
      && result.evidence.centerHz === request.detection.peakHz;
    const bandwidthHzMatches = request !== undefined
      && result.evidence.bandwidthHz === request.detection.bandwidthHz;
    const peakDbmMatches = request !== undefined
      && result.evidence.peakDbm === request.detection.peakDbm;
    const spectrumSweepIdsMatch = sameStringArray(
      result.evidence.sweepIds,
      evidence.spectrumSweepIds,
    );
    const zeroSpanCaptureMatches = (result.evidence.zeroSpanCaptureId ?? null)
      === evidence.zeroSpanCaptureId;
    const selectionConditionMatches = (result.evidence.detectedPowerSelectionCondition ?? null)
      === expectedDetectedPowerSelectionCondition;
    const modelEvidenceProjectionMatches = evidence.modelEvidenceProjection.status === 'ready';
    return {
      bound: targetMatches
        && centerHzMatches
        && bandwidthHzMatches
        && peakDbmMatches
        && modelEvidenceProjectionMatches
        && spectrumSweepIdsMatch
        && zeroSpanCaptureMatches
        && selectionConditionMatches
        && receiptSelectionOriginMatches,
      targetMatches,
      centerHzMatches,
      bandwidthHzMatches,
      peakDbmMatches,
      modelEvidenceProjectionMatches,
      spectrumSweepIdsMatch,
      zeroSpanCaptureMatches,
      selectionConditionMatches,
      receiptSelectionOriginMatches,
      expected: {
        revision: work.revision,
        projectedRepresentativeId: work.target.projectedRepresentativeId,
        centerHz: request?.detection.peakHz ?? null,
        bandwidthHz: request?.detection.bandwidthHz ?? null,
        peakDbm: request?.detection.peakDbm ?? null,
        spectrumSweepIds: evidence.spectrumSweepIds,
        zeroSpanCaptureId: evidence.zeroSpanCaptureId,
        detectedPowerSelectionCondition: expectedDetectedPowerSelectionCondition,
      },
      result: {
        detectionId: result.detectionId,
        centerHz: result.evidence.centerHz,
        bandwidthHz: result.evidence.bandwidthHz,
        peakDbm: result.evidence.peakDbm,
        spectrumSweepIds: result.evidence.sweepIds,
        zeroSpanCaptureId: result.evidence.zeroSpanCaptureId ?? null,
        detectedPowerSelectionCondition:
          result.evidence.detectedPowerSelectionCondition ?? null,
      },
    };
  }

  function classificationResultsBoundToWork(
    work: ClassificationWork,
    results: readonly WaveformClassification[],
  ): readonly WaveformClassification[] {
    return results.filter((result) =>
      agentClassificationResultBinding(work, result).bound);
  }

  function agentClassificationReadiness(
    snapshot: FrozenAutomaticClassificationSnapshot,
    selection: ClassificationTargetSelection,
    executionOverride?: ClassificationExecutionRecord,
  ) {
    if (snapshot.rankingAdmission.status === 'ranking-admission-failed') {
      return {
        status: 'failed' as const,
        reason: 'ranking-admission-failed' as const,
        error: 'The complete visible target population lacks exact current-source-sweep rank evidence',
        revision: null,
        target: null,
        evidence: null,
        resultBinding: null,
        result: null,
        rankingAdmission: snapshot.rankingAdmission,
      };
    }
    const projectedRepresentativeId = selection.detectionId;
    const rawTargetId = selection.rawTargetId ?? projectedRepresentativeId;
    const target = projectedRepresentativeId === undefined
      ? undefined
      : snapshot.projections.find((projection) =>
        projection.projectedRepresentative.id === projectedRepresentativeId
        && projection.rawTarget.id === rawTargetId);
    if (!snapshot.visibleSweep || !target || !projectedRepresentativeId || !rawTargetId) {
      return {
        status: 'no-target' as const,
        revision: null,
        target: null,
        evidence: null,
        resultBinding: null,
        result: null,
      };
    }
    const execution = executionOverride ?? classificationExecution.current;
    const matchingExecution = execution
      && execution.work.visibleSweep.id === snapshot.visibleSweep.id
      && execution.work.visibleSweep.sequence === snapshot.visibleSweep.sequence
      && execution.work.sequence === snapshot.analysisSequence
      && execution.work.target.projectedRepresentativeId === projectedRepresentativeId
      && execution.work.target.rawTargetId === rawTargetId
      && execution.work.target.selectionOrigin === selection.origin
      ? execution
      : undefined;
    const targetReadback = {
      projectedRepresentativeId,
      rawTargetId,
      selectionOrigin: selection.origin,
      frozenVisibleSweepId: snapshot.visibleSweep.id,
      frozenVisibleSweepSequence: snapshot.visibleSweep.sequence,
    };
    if (classifierRuntime.current?.status === 'unavailable') {
      return {
        status: 'unavailable' as const,
        reason: 'classifier-runtime-unavailable' as const,
        revision: matchingExecution?.work.revision ?? null,
        target: targetReadback,
        evidence: matchingExecution
          ? agentClassificationEvidenceWindow(matchingExecution.work)
          : null,
        resultBinding: null,
        result: null,
      };
    }
    if (matchingExecution?.status === 'failed') {
      return {
        status: 'failed' as const,
        reason: 'inference-failed' as const,
        error: matchingExecution.error ?? 'Bayesian classification failed',
        revision: matchingExecution.work.revision,
        target: targetReadback,
        evidence: agentClassificationEvidenceWindow(matchingExecution.work),
        resultBinding: null,
        result: null,
      };
    }
    if (matchingExecution?.status === 'inference-pending') {
      if (!classificationInferenceRemainsPending(matchingExecution.work)) {
        return {
          status: 'failed' as const,
          reason: 'orphaned-inference-revision' as const,
          error: 'The target-bound inference revision is no longer executing or queued',
          revision: matchingExecution.work.revision,
          target: targetReadback,
          evidence: agentClassificationEvidenceWindow(matchingExecution.work),
          resultBinding: null,
          result: null,
        };
      }
      return {
        status: 'inference-pending' as const,
        revision: matchingExecution.work.revision,
        target: targetReadback,
        evidence: agentClassificationEvidenceWindow(matchingExecution.work),
        resultBinding: null,
        result: null,
      };
    }
    if (matchingExecution?.status === 'ready') {
      const result = matchingExecution.results?.find((candidate) =>
        candidate.detectionId === projectedRepresentativeId);
      if (!result) {
        return {
          status: 'failed' as const,
          reason: 'target-result-missing' as const,
          error: 'The completed inference returned no result for the frozen selected target',
          revision: matchingExecution.work.revision,
          target: targetReadback,
          evidence: agentClassificationEvidenceWindow(matchingExecution.work),
          resultBinding: null,
          result: null,
        };
      }
      const resultBinding = agentClassificationResultBinding(
        matchingExecution.work,
        result,
      );
      if (!resultBinding.bound) {
        return {
          status: 'failed' as const,
          reason: 'result-evidence-binding-mismatch' as const,
          error: 'The classifier result does not bind to the exact frozen target and evidence window',
          revision: matchingExecution.work.revision,
          target: targetReadback,
          evidence: agentClassificationEvidenceWindow(matchingExecution.work),
          resultBinding,
          result: null,
        };
      }
      if (result.qualification === 'unavailable') {
        return {
          status: 'unavailable' as const,
          reason: result.unknownReason ?? 'model-unavailable',
          revision: matchingExecution.work.revision,
          target: targetReadback,
          evidence: agentClassificationEvidenceWindow(matchingExecution.work),
          resultBinding,
          result,
        };
      }
      return {
        status: 'ready' as const,
        revision: matchingExecution.work.revision,
        target: targetReadback,
        evidence: agentClassificationEvidenceWindow(matchingExecution.work),
        resultBinding,
        result,
      };
    }
    let evidenceSweeps: readonly Sweep[] | undefined;
    try {
      evidenceSweeps = exactClassificationEvidenceSweeps(
        target.projectedRepresentative,
        snapshot.history,
      );
    } catch (value) {
      return {
        status: 'failed' as const,
        reason: 'evidence-window-invalid' as const,
        error: errorMessage(value),
        revision: null,
        target: targetReadback,
        evidence: null,
        resultBinding: null,
        result: null,
      };
    }
    return {
      status: 'collecting' as const,
      reason: evidenceSweeps?.length
        ? 'awaiting-target-bound-inference-revision' as const
        : 'exact-evidence-window-unavailable' as const,
      revision: null,
      target: targetReadback,
      evidence: evidenceSweeps?.length ? {
        spectrumSweepIds: evidenceSweeps.map((item) => item.id),
        spectrumWindow: {
          order: 'newest-to-oldest' as const,
          count: evidenceSweeps.length,
          newestSweepId: evidenceSweeps[0]?.id ?? null,
          oldestSweepId: evidenceSweeps.at(-1)?.id ?? null,
          maximumModelWindowSweeps: 8,
        },
        zeroSpanCaptureId: null,
        zeroSpanSpectrumSweepIds: [],
      } : null,
      resultBinding: null,
      result: null,
    };
  }

  function agentAutomaticClassificationSelection(
    snapshot: FrozenAutomaticClassificationSnapshot,
    detectedPowerStaging: AutomaticDetectedPowerStaging,
    operationExecution?: ClassificationExecutionRecord,
  ) {
    const rankPopulation = agentAutomaticRankPopulation(snapshot);
    const winner = snapshot.projections[0];
    const selection: ClassificationTargetSelection = {
      ...(winner ? {
        detectionId: winner.projectedRepresentative.id,
        ...(winner.rawTarget.id === winner.projectedRepresentative.id
          ? {}
          : { rawTargetId: winner.rawTarget.id }),
      } : {}),
      origin: 'automatic',
    };
    return {
      frozenVisibleSweep: snapshot.visibleSweep ? {
        id: snapshot.visibleSweep.id,
        sequence: snapshot.visibleSweep.sequence,
        capturedAt: snapshot.visibleSweep.capturedAt,
      } : null,
      selection: {
        origin: 'automatic' as const,
        selected: winner !== undefined,
        rank: winner ? 0 : null,
        rankPopulationSize: rankPopulation.length,
        rawTargetId: winner?.rawTarget.id ?? null,
        projectedRepresentativeId:
          winner?.projectedRepresentative.id ?? null,
        stagedDetectedPowerCenterHz:
          detectedPowerStaging.centerHz,
        stagedDetectedPowerConfiguration:
          detectedPowerStaging.configuration,
        detectedPowerStaging,
      },
      ranking: {
        model: CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL,
        tieBreakPolicy: CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL.tieBreakPolicy,
        admission: snapshot.rankingAdmission,
        population: rankPopulation,
      },
      classificationReadiness: agentClassificationReadiness(
        snapshot,
        selection,
        operationExecution,
      ),
    };
  }

  function agentAutomaticClassificationOperationState() {
    const pinned = lastAutomaticClassificationOperation.current;
    if (!pinned) return null;
    const snapshot = pinned.snapshot;
    const selection = pinned.selection;
    return {
      operationId: pinned.operationId,
      supersededBy: 'subsequent-auto-only' as const,
      frozenVisibleSweep: snapshot.visibleSweep ? {
        id: snapshot.visibleSweep.id,
        sequence: snapshot.visibleSweep.sequence,
        capturedAt: snapshot.visibleSweep.capturedAt,
      } : null,
      selection: {
        origin: selection.origin,
        projectedRepresentativeId: selection.detectionId ?? null,
        rawTargetId: selection.rawTargetId ?? selection.detectionId ?? null,
      },
      ranking: {
        model: CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL,
        admission: snapshot.rankingAdmission,
        population: agentAutomaticRankPopulation(snapshot),
      },
      detectedPowerStaging: pinned.detectedPowerStaging,
      readiness: agentClassificationReadiness(
        snapshot,
        selection,
        pinned.execution,
      ),
    };
  }

  function agentCurrentClassificationState() {
    const snapshot = freezeAutomaticClassificationSnapshot();
    const selection = resolveVisibleClassificationTargetSelection(
      snapshot.detections,
      snapshot.visibleSweep,
      explicitClassificationIdRef.current,
    );
    return {
      frozenVisibleSweep: snapshot.visibleSweep ? {
        id: snapshot.visibleSweep.id,
        sequence: snapshot.visibleSweep.sequence,
        capturedAt: snapshot.visibleSweep.capturedAt,
      } : null,
      selection: {
        origin: selection.origin,
        projectedRepresentativeId: selection.detectionId ?? null,
        rawTargetId: selection.rawTargetId ?? selection.detectionId ?? null,
      },
      automaticRanking: {
        model: CLASSIFICATION_CAPTURE_TARGET_RANKING_MODEL,
        admission: snapshot.rankingAdmission,
        population: agentAutomaticRankPopulation(snapshot),
      },
      automaticOperation: agentAutomaticClassificationOperationState(),
      readiness: agentClassificationReadiness(snapshot, selection),
    };
  }

  function agentLatestSweepSummary(
    currentSweep: Sweep,
    metrics: ReturnType<typeof calculateSweepMetrics>,
  ) {
    const physical = 'kind' in currentSweep.identity
      && currentSweep.identity.kind === 'instrument-session'
      && currentSweep.identity.provenance.execution === 'physical';
    if (physical
      && (currentSweep.resolutionBandwidthQualification !== 'device-observed'
        || currentSweep.attenuationQualification !== 'device-observed'
        || currentSweep.actualAttenuationDb === null)) {
      throw new Error('Physical latest-sweep receiver readback is not device-observed');
    }
    return {
      id: currentSweep.id,
      sequence: currentSweep.sequence,
      capturedAt: currentSweep.capturedAt,
      rangeHz: [currentSweep.actualStartHz, currentSweep.actualStopHz],
      points: currentSweep.frequencyHz.length,
      source: currentSweep.source,
      elapsedMilliseconds: currentSweep.elapsedMilliseconds,
      metrics,
      ...(currentSweep.resolutionBandwidthQualification === undefined ? {} : {
        actualRbwHz: currentSweep.actualRbwHz,
        resolutionBandwidthQualification: currentSweep.resolutionBandwidthQualification,
      }),
      ...(currentSweep.attenuationQualification === undefined ? {} : {
        actualAttenuationDb: currentSweep.actualAttenuationDb,
        attenuationQualification: currentSweep.attenuationQualification,
      }),
    };
  }

  function applicationContext(): string {
    const currentInstrument = instrumentRef.current;
    const currentWorkspace = workspaceRef.current;
    const currentMeasurementView = measurementViewRef.current;
    const currentSweep = sweepRef.current;
    const currentHistory = historyRef.current;
    const currentDetections = detectionsRef.current;
    const currentClassifications = classificationsRef.current;
    const currentZeroCapture = zeroCaptureRef.current;
    const currentZeroCaptureReceipt = zeroCaptureReceiptRef.current;
    const currentEnvelope = envelopeRef.current;
    const currentIqCapture = iqCaptureRef.current;
    const currentTraceFrames = traceFramesRef.current;
    const currentMarkers = markersRef.current;
    const currentMarkerReadings = readMarkers(
      currentMarkers,
      currentTraceFrames,
      currentDetections,
    );
    const currentMetrics = currentSweep ? calculateSweepMetrics(currentSweep) : undefined;
    const currentSelection = resolveVisibleClassificationTargetSelection(
      currentDetections,
      currentSweep,
      explicitClassificationIdRef.current,
    );
    const channelMeasurement = evaluateAnalysis(() => requireChannelMeasurement());
    const envelopeStft = evaluateAnalysis(() => requireEnvelopeStft());
    return JSON.stringify({
      workspace: currentWorkspace,
      measurementView: currentMeasurementView,
      acquisition: acquisitionRef.current,
      continuous: continuousRef.current,
      continuousMode: continuousModeRef.current,
      simulated: currentInstrument.session !== undefined && currentInstrument.session.provenance.execution !== 'physical',
      topology: systemTopology(),
      visibleError: errorRef.current ?? null,
      instrument: currentInstrument,
      generatorOutput: currentGeneratorOutput(),
      scalarConfiguration: agentConfigurationContext(),
      iq: {
        stagedConfiguration: iqConfigurationRef.current,
        latestCapture: currentIqCapture ? {
          id: currentIqCapture.measurementId,
          sequence: currentIqCapture.sequence,
          centerHz: currentIqCapture.centerHz,
          sampleCount: currentIqCapture.sampleCount,
          sampleRateHz: currentIqCapture.sampleRateHz,
          bandwidthHz: currentIqCapture.bandwidthHz,
          sampleFormat: currentIqCapture.sampleFormat,
          timing: {
            capturedAt: currentIqCapture.capturedAt,
            elapsedMilliseconds: currentIqCapture.elapsedMilliseconds,
            durationSeconds: currentIqCapture.sampleCount / currentIqCapture.sampleRateHz,
          },
          provenance: {
            sessionId: currentIqCapture.sessionId,
            configurationRevision: currentIqCapture.configurationRevision,
            producerConfigurationEpoch: currentIqCapture.producerConfigurationEpoch ?? null,
            qualification: currentIqCapture.qualification,
            sourceKind: currentInstrument.session?.provenance.sourceKind ?? null,
            execution: currentInstrument.session?.provenance.execution ?? null,
          },
        } : null,
      },
      generator: generatorRef.current,
      detectionConfig: detectionConfigRef.current,
      historyCount: currentHistory.length,
      latestSweep: currentSweep && currentMetrics
        ? agentLatestSweepSummary(currentSweep, currentMetrics)
        : null,
      detections: agentDetectionResults(currentDetections),
      classifications: currentClassifications.map(({ detectionId, label, confidence, modelId, unknownReason }) => ({ detectionId, label, confidence, modelId, unknownReason })),
      selectedClassificationId: agentSelectedClassificationId({
        receiptProjectedRepresentativeId:
          currentZeroCaptureReceipt?.selection.projectedRepresentativeId,
        captureRawTargetId: currentZeroCapture?.targetDetectionId,
        currentSelectionId: currentSelection.detectionId,
      }),
      zeroSpan: currentZeroCapture && currentEnvelope ? {
        frequencyHz: currentZeroCapture.frequencyHz,
        samples: currentZeroCapture.powerDbm.length,
        samplePeriodSeconds: currentZeroCapture.samplePeriodSeconds,
        rawTargetId: currentZeroCaptureReceipt?.selection.rawTargetId
          ?? currentZeroCapture.targetDetectionId
          ?? null,
        projectedRepresentativeId:
          currentZeroCaptureReceipt?.selection.projectedRepresentativeId ?? null,
        envelope: currentEnvelope,
      } : null,
      measurement: {
        activeView: currentMeasurementView,
        traces: traceConfigurationRef.current.map((trace) => ({ ...trace, sweepCount: currentTraceFrames.find((frame) => frame.traceId === trace.id)?.sweepCount ?? 0 })),
        firmwareTraces: firmwareTraceFramesRef.current.map(({ traceId, role, unit, frozen, sourceSweepId, capturedAt }) => ({ traceId, role, unit, frozen, visible: visibleFirmwareTraceIdsRef.current.includes(traceId), sourceSweepId, capturedAt, evidence: 'firmware-readback' })),
        activeTraceId: activeTraceIdRef.current,
        markers: { configurations: currentMarkers, readings: currentMarkerReadings },
        activeMarkerId: activeMarkerIdRef.current,
        markerSearch: markerSearchConfigurationRef.current,
        display: displayConfigurationRef.current,
        waterfall: { configuration: waterfallConfigurationRef.current, coherentSweeps: coherentSweepCount(currentHistory, waterfallConfigurationRef.current.historyDepth) },
        channel: { configuration: channelConfigurationRef.current, analysis: channelMeasurement },
        envelopeStft: { configuration: stftConfigurationRef.current, analysis: envelopeStft },
        evidence: 'host-derived',
      },
    });
  }

  async function executeAgentTool(name: AgentToolName, args: unknown): Promise<unknown> {
    switch (name) {
      case 'get_application_state': {
        const context = JSON.parse(applicationContext()) as {
          workspace: WorkspaceId; measurementView: MeasurementViewId; acquisition: AcquisitionState;
          continuous: boolean; continuousMode: ContinuousAcquisitionMode; simulated: boolean; visibleError: string | null; historyCount: number;
          topology: unknown; scalarConfiguration: unknown; generator: GeneratorConfig;
          detectionConfig: SignalDetectionConfig; measurement: unknown; latestSweep: unknown; iq: unknown;
        };
        return {
          workspace: context.workspace, measurementView: context.measurementView,
          acquisition: context.acquisition, continuous: context.continuous, continuousMode: context.continuousMode, simulated: context.simulated,
          error: context.visibleError, historyCount: context.historyCount, topology: context.topology,
          connection: instrumentRef.current.session ? 'connected' : 'disconnected',
          scalarConfiguration: context.scalarConfiguration, generator: context.generator,
          detection: context.detectionConfig, measurement: context.measurement, iq: context.iq,
          latestSweep: context.latestSweep, agentSurfaceVersion: ATOM_AGENT_VERSION,
        };
      }
      case 'get_system_topology': return systemTopology();
      case 'get_agent_surface': return {
        version: ATOM_AGENT_VERSION,
        model: ATOM_AGENT_MODEL,
        loading: { startupTool: ATOM_TOOL_LOADER_NAME, maximumToolsPerResponse: ATOM_MAX_LOADED_TOOLS, fullToolCount: agentToolDefinitions.length, concreteSchemas: 'response-scoped' },
        tools: agentToolDefinitions.map((tool) => ({ name: tool.name, description: tool.description, policy: agentToolPolicies[tool.name] })),
        controlBindings: agentControlBindings.map((binding) => ({ pattern: binding.pattern.source, preferredTool: binding.preferredTool, risk: binding.risk, projection: binding.projection, guarantee: binding.guarantee })),
        apiCoverage: agentApiCoverage,
      };
      case 'get_instrument_state': return { ...instrumentRef.current, generatorOutput: currentGeneratorOutput(), scalarConfiguration: agentConfigurationContext() };
      case 'get_latest_sweep_summary': return JSON.parse(applicationContext()).latestSweep;
      case 'get_detection_results': return {
        ...agentDetectionResults(detectionsRef.current),
        classificationTargeting: agentCurrentClassificationState(),
      };
      case 'get_classification_results': return {
        contract: 'classification-results-with-association-lineage-v1',
        ...agentCurrentClassificationState(),
        spectral: agentClassificationResults(detectionsRef.current, classificationsRef.current),
        zeroSpan: zeroCaptureRef.current ? { captureId: zeroCaptureRef.current.id, envelope: envelopeRef.current ?? null } : null,
      };
      case 'read_device_diagnostics': return refreshDiagnostics();
      case 'list_connection_candidates': {
        const discovery = await runInstrumentTransaction('list-connection-candidates', () => discoverInstruments());
        acceptDiscovery(discovery.candidates, discovery.failures);
        const issued = discovery.candidates.map((candidate, index) => ({ candidateId: `candidate-${index + 1}`, driverId: candidate.driverId, displayName: candidate.displayName, sourceKind: candidate.sourceKind, simulated: instrumentCandidateIsSimulated(candidate), selected: instrumentCandidateUiKey(candidate) === selectedCandidateIdRef.current }));
        agentConnectionCandidates.current = new Map(issued.map((candidate, index) => [candidate.candidateId, discovery.candidates[index]!]));
        return { candidates: issued, failures: discovery.failures };
      }
      case 'connect_device': {
        const candidateId = (args as { candidateId: string }).candidateId;
        const issued = agentConnectionCandidates.current.get(candidateId);
        agentConnectionCandidates.current.clear();
        if (!issued) throw new Error(`Connection candidate ${candidateId} was not issued by the latest list_connection_candidates result`);
        const next = await runInstrumentTransaction('connect-issued-instrument', async () => {
          const discovery = await discoverInstruments();
          acceptDiscovery(discovery.candidates, discovery.failures);
          const candidate = discovery.candidates.find((current) => current.driverId === issued.driverId
            && current.sourceKind === issued.sourceKind
            && current.candidateId === issued.candidateId);
          if (!candidate) throw new Error(`Connection candidate ${candidateId} is no longer available; list candidates again`);
          if (!sameInstrumentCandidateDescriptor(candidate, issued)) throw new Error(`Connection candidate ${candidateId} changed after it was listed; list candidates again`);
          setSelectedCandidateId(instrumentCandidateUiKey(candidate));
          return connectCandidateOwned(candidate);
        });
        return { connected: true, driverId: next.driverId, sourceKind: next.provenance.sourceKind, execution: next.provenance.execution, qualification: next.provenance.qualification, displayName: next.candidate.displayName };
      }
      case 'disconnect_device': await disconnectDevice(); return { disconnected: true, state: 'disconnected' };
      case 'inspect_interface': {
        await awaitControllerRenderCommit();
        const rendered = inspectRenderedAgentControls();
        return { activeWorkspace: workspaceRef.current, activeMeasurementView: measurementViewRef.current, controls: Object.fromEntries(rendered.map((control) => [control.controlId, control.enabled])), rendered };
      }
      case 'computer_action': {
        await awaitControllerRenderCommit();
        const control = (args as { controlId: AgentSemanticControlId }).controlId;
        const binding = agentControlBinding(control);
        if (binding.risk === 'high-impact') throw new Error(`Semantic control ${control} is high-impact and requires its typed approval tool`);
        if (semanticControlRequiresCoordinates(control)) throw new Error(`Semantic control ${control} requires a coordinate-bearing computer_click or its typed ${binding.preferredTool} tool`);
        const targets = [...document.querySelectorAll<HTMLElement>('[data-agent-control]')].filter((element) => element.dataset.agentControl === control);
        if (targets.length !== 1) throw new Error(`Semantic control ${control} has ${targets.length} rendered targets; expected exactly one`);
        const target = targets[0]!;
        if (target.closest('[data-agent-exclusion]')) throw new Error(`Semantic control ${control} is a local human-only boundary`);
        if (control === 'classification.auto-select') {
          const selection = await selectAutomaticClassificationCandidate();
          return {
            activated: control,
            preferredTool: binding.preferredTool,
            projection: binding.projection,
            ...selection,
          };
        }
        if (isDisabledControl(target)) throw new Error(`Semantic control ${control} is disabled`);
        if (target instanceof HTMLDetailsElement) target.open = !target.open;
        else target.click();
        return { activated: control, preferredTool: binding.preferredTool, projection: binding.projection };
      }
      case 'computer_screenshot': await awaitControllerRenderCommit(); return window.atomAgent.computerScreenshot();
      case 'computer_click': await awaitControllerRenderCommit(); return requireComputerActionResult(await window.atomAgent.computerClick(args as { screenshotId: string; x: number; y: number }));
      case 'computer_type': await awaitControllerRenderCommit(); return requireComputerActionResult(await window.atomAgent.computerType(args as { expectedTarget: string; text: string }));
      case 'computer_key': await awaitControllerRenderCommit(); return requireComputerActionResult(await window.atomAgent.computerKey(args as { expectedTarget: string; key: string }));
      case 'computer_scroll': await awaitControllerRenderCommit(); return requireComputerActionResult(await window.atomAgent.computerScroll(args as { screenshotId: string; x: number; y: number; deltaX: number; deltaY: number }));
      case 'navigate_workspace': applyWorkspace((args as { workspace: WorkspaceId }).workspace); return { workspace: workspaceRef.current };
      case 'configure_analyzer': {
        assertWorkspaceTransition(workspaceRef.current, 'spectrum', currentGeneratorOutput());
        const patch = analyzerConfigPatchSchema.parse(args);
        const next = await updateAnalyzer(patch);
        applyWorkspace('spectrum');
        return { patch, scalarConfiguration: agentConfigurationContext(next), continuous: continuousRequested.current };
      }
      case 'acquire_sweep': {
        if (workspaceRef.current === 'iq') {
          assertWorkspaceTransition(workspaceRef.current, 'iq', currentGeneratorOutput());
          const result = await acquireIq();
          applyWorkspace('iq');
          return {
            acquired: true,
            acquisitionMode: 'complex-iq',
            captureId: result.measurementId,
            sequence: result.sequence,
            centerHz: result.centerHz,
            sampleCount: result.sampleCount,
            sampleRateHz: result.sampleRateHz,
            qualification: result.qualification,
          };
        }
        assertWorkspaceTransition(workspaceRef.current, 'spectrum', currentGeneratorOutput());
        const result = await acquire();
        applyWorkspace('spectrum');
        return { acquired: true, acquisitionMode: 'swept-spectrum', sweepId: result.id, sequence: result.sequence, points: result.frequencyHz.length, source: result.source, identity: result.identity };
      }
      case 'start_continuous_sweeps': {
        if (workspaceRef.current === 'iq') {
          assertWorkspaceTransition(workspaceRef.current, 'iq', currentGeneratorOutput());
          await startContinuousIq();
          applyWorkspace('iq');
        } else {
          assertWorkspaceTransition(workspaceRef.current, 'spectrum', currentGeneratorOutput());
          await runInstrumentTransaction('start-continuous-acquisition', () => startContinuousOwned());
          applyWorkspace('spectrum');
        }
        return { streaming: true, continuousMode: continuousModeRef.current, workspace: workspaceRef.current };
      }
      case 'stop_continuous_sweeps': await stopContinuous(); return { streaming: false, continuousMode: continuousModeRef.current, sweepsRetained: historyRef.current.length };
      case 'get_measurement_state': return JSON.parse(applicationContext()).measurement;
      case 'set_measurement_view': {
        const view = measurementViewIdSchema.parse((args as { view: MeasurementViewId }).view);
        applyMeasurementView(view);
        return { workspace: 'spectrum', view: measurementViewRef.current };
      }
      case 'configure_waterfall': {
        const configuration = waterfallConfigurationSchema.parse(args);
        applyMeasurementView('waterfall');
        applyWaterfall(configuration);
        return { configuration, retainedSweeps: coherentSweepCount(historyRef.current, configuration.historyDepth), evidence: 'host-derived-scalar-sweep' };
      }
      case 'configure_channel_measurement': {
        const configuration = channelMeasurementConfigurationSchema.parse(args);
        applyMeasurementView('channel');
        applyChannelMeasurement(configuration);
        return configuration;
      }
      case 'get_channel_measurement_results': return requireChannelMeasurement();
      case 'configure_envelope_stft': {
        const configuration = envelopeStftConfigurationSchema.parse(args);
        applyMeasurementView('envelope-stft');
        applyEnvelopeStft(configuration);
        return configuration;
      }
      case 'get_envelope_stft_results': return requireEnvelopeStft();
      case 'acquire_envelope_stft': {
        assertWorkspaceTransition(workspaceRef.current, 'spectrum', currentGeneratorOutput());
        const capture = await acquireZeroSpan();
        const result = computeEnvelopeStft(capture, stftConfigurationRef.current);
        applyMeasurementView('envelope-stft');
        return result;
      }
      case 'select_marker': {
        const markerId = (args as { markerId: MarkerId }).markerId;
        if (!markersRef.current.some((marker) => marker.id === markerId)) throw new Error(`Marker M${markerId} is unavailable`);
        applyWorkspace('spectrum');
        setActiveMarkerId(markerId);
        return { markerId, selected: true, evidence: 'ui-only' };
      }
      case 'configure_marker': {
        const marker = markerConfigurationSchema.parse(args);
        applyWorkspace('spectrum');
        applyMarker(marker);
        return { marker, reading: previewMarkerReading(marker) ?? null, evidence: 'host-derived' };
      }
      case 'configure_marker_search': {
        const configuration = markerSearchConfigurationSchema.parse(args);
        applyWorkspace('spectrum');
        applyMarkerSearch(configuration);
        return { configuration, evidence: 'host-derived' };
      }
      case 'search_marker': {
        const value = args as { markerId: MarkerId; action: MarkerSearchAction };
        const marker = markersRef.current.find((item) => item.id === value.markerId);
        if (!marker) throw new Error(`Marker M${value.markerId} is unavailable`);
        // One Atom operation may acquire and then search before React commits a
        // render. The accumulator is the synchronous source of truth at that
        // transaction boundary; traceFrames is its UI projection.
        const frame = traceAccumulator.current.frames().find((item) => item.traceId === marker.traceId);
        if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
        applyWorkspace('spectrum');
        const frequencyHz = searchMarker(frame, marker.frequencyHz, value.action, markerSearchConfigurationRef.current, detectionsRef.current);
        const nextMarker = { ...marker, enabled: true, tracking: value.action === 'peak' ? 'peak' as const : 'fixed' as const, frequencyHz };
        applyMarker(nextMarker);
        return { markerId: value.markerId, action: value.action, frequencyHz, reading: previewMarkerReading(nextMarker) ?? null, evidence: 'host-derived' };
      }
      case 'select_trace': {
        const traceId = (args as { traceId: TraceId }).traceId;
        if (!traceConfigurationRef.current.some((trace) => trace.id === traceId)) throw new Error(`Trace ${traceId} is unavailable`);
        applyWorkspace('spectrum');
        setActiveTraceId(traceId);
        return { traceId, selected: true, evidence: 'ui-only' };
      }
      case 'configure_trace': {
        const trace = traceConfigurationSchema.parse(args);
        applyWorkspace('spectrum');
        applyTrace(trace);
        return { trace, evidence: 'host-derived' };
      }
      case 'configure_firmware_trace_visibility': {
        const value = args as { traceId: FirmwareTraceId; visible: boolean };
        applyWorkspace('spectrum');
        const visibleTraceIds = configureFirmwareTraceVisibility(value.traceId, value.visible);
        return { traceId: value.traceId, visible: value.visible, visibleTraceIds, evidence: 'firmware-readback-display-projection' };
      }
      case 'reset_trace': {
        applyWorkspace('spectrum');
        const traceId = (args as { traceId: TraceId }).traceId;
        traceAccumulator.current.reset(traceId);
        setTraceFrames(traceAccumulator.current.frames());
        return { traceId, reset: true, evidence: 'host-derived' };
      }
      case 'configure_spectrum_display': {
        const display = spectrumDisplayConfigurationSchema.parse(args);
        applyWorkspace('spectrum');
        applyDisplay(display);
        return { display, evidence: 'host-derived' };
      }
      case 'auto_scale_spectrum_display': {
        const latestSweep = sweepRef.current;
        if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before auto-scaling the display');
        applyWorkspace('spectrum');
        const display = autoScaleSpectrum(latestSweep);
        applyDisplay(display);
        return { display, sweepId: latestSweep.id, evidence: 'host-derived-complete-sweep' };
      }
      case 'configure_signal_detector': { const next = signalDetectionConfigSchema.parse(args); applyWorkspace('classification'); return applyDetectionConfiguration(next); }
      case 'select_classification_candidate': {
        const detectionId = (args as { detectionId: string }).detectionId;
        const requestedSelection = resolveVisibleClassificationTargetSelection(
          detectionsRef.current,
          sweepRef.current,
          detectionId,
        );
        if (requestedSelection.origin !== 'explicit'
          || requestedSelection.explicitDetectionId !== detectionId
          || requestedSelection.detectionId === undefined) {
          throw new Error(`Detection ${detectionId} is not an exact current physical or qualified agile-representative classification target`);
        }
        applyWorkspace('classification');
        const stagedDetectedPower = selectClassificationCandidate(detectionId);
        const stagedDetectionId = stagedClassificationTargetIdRef.current;
        const expectedRawTargetId = requestedSelection.rawTargetId
          ?? requestedSelection.detectionId;
        if (stagedDetectionId !== expectedRawTargetId) {
          throw new Error(`Detection ${detectionId} was not retained as the exact staged classification target`);
        }
        return {
          detectionId: requestedSelection.detectionId,
          rawTargetId: expectedRawTargetId,
          selected: true,
          stagedDetectedPowerCenterHz: stagedDetectedPower.centerHz ?? null,
          stagedDetectedPowerConfiguration: stagedDetectedPower.centerHz === undefined
            ? null
            : structuredClone(zeroConfigRef.current),
          detectedPowerStaging: stagedDetectedPower.centerHz === undefined ? {
            status: 'unavailable',
            reason: instrumentRef.current.session?.capabilities.acquisitions
              .some((candidate) => candidate.kind === 'detected-power-timeseries')
              ? 'target-not-stageable'
              : 'detected-power-capability-unavailable',
            ...(stagedDetectedPower.failure
              ? { error: stagedDetectedPower.failure }
              : {}),
          } : {
            status: 'staged',
            centerHz: stagedDetectedPower.centerHz,
            configuration: structuredClone(zeroConfigRef.current),
          },
          evidence: 'ui-staging',
        };
      }
      case 'configure_zero_span': {
        const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
        const { patch, configuration: next } = stageDetectedPowerConfigurationPatch(
          capability?.kind === 'detected-power-timeseries' ? capability : undefined,
          zeroConfigRef.current,
          args as ZeroSpanConfigPatch,
        );
        applyWorkspace('classification');
        commitZeroSpanConfiguration(next);
        clearClassificationCapture();
        return { patch, scalarConfiguration: agentConfigurationContext(analyzerRef.current, next) };
      }
      case 'acquire_zero_span': { assertWorkspaceTransition(workspaceRef.current, 'classification', currentGeneratorOutput()); const result = await acquireZeroSpan(); applyWorkspace('classification'); return { acquired: true, captureId: result.id, samples: result.powerDbm.length, envelope: classifyZeroSpanEnvelope(result), identity: result.identity }; }
      case 'configure_generator': { const next = generatorConfigSchema.parse(args); applyWorkspace('generator'); setGenerator(next); return configureGeneratorWith(next); }
      case 'set_rf_output': { const enabled = (args as { enabled: boolean }).enabled; applyWorkspace('generator'); await setOutput(enabled); return { enabled, sourceKind: instrumentRef.current.session?.provenance.sourceKind ?? 'unknown', evidence: 'driver-commanded' }; }
      case 'capture_device_screen': { const frame = await captureScreen(); return { captured: true, width: frame.width, height: frame.height, format: frame.pixelFormat, capturedAt: frame.capturedAt }; }
      case 'remote_device_touch': {
        const value = args as InstrumentScreenPoint & { gesture: 'tap' };
        const point = { x: value.x, y: value.y };
        const task = queueRemoteTap(point);
        if (!task) throw new Error('A remote screen gesture is already active or no instrument session is connected');
        await task;
        return { completed: 'tap', point };
      }
      case 'export_latest_sweep': return exportLatest((args as { format: 'csv' | 'json' }).format);
    }
    const unreachable: never = name;
    return unreachable;
  }

  const agent = useAtomAgent({ applicationContext, execute: executeAgentTool });
  const contextualAcquisitionMode = acquisitionModeForWorkspace(workspace, continuousMode);
  const acquisitionDisabledReason = !connected
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
  const measurementActions = sweep ? <div className="measurement-actions">
      <button data-agent-control="export.csv" className="secondary compact icon-only" aria-label="Export CSV" title="Export CSV" onClick={() => void exportLatestFromUi('csv')}><Download size={14}/><span>CSV</span></button>
      <button data-agent-control="export.json" className="secondary compact icon-only" aria-label="Export JSON" title="Export JSON" onClick={() => void exportLatestFromUi('json')}><span>{'{ }'}</span></button>
  </div> : null;

  return <main className={`app-shell ${agentOpen ? 'ai-open' : ''}`}>
    <TopBar instrument={instrument} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)} onConnection={() => setConnectionOpen(true)} onAgent={() => setAgentOpen((value) => !value)}/>
    <Sidebar
      active={workspace}
      measurementView={measurementView}
      output={generatorOutput}
      generationAvailable={generatorCapability !== undefined || signalLabProfileCapability !== undefined}
      iqAvailable={iqCapability !== undefined}
      connected={connected}
      acquisition={acquisition}
      continuous={continuous}
      acquisitionMode={continuous ? continuousMode : contextualAcquisitionMode}
      acquisitionBusy={busy}
      acquisitionDisabled={acquisitionDisabledReason !== undefined}
      acquisitionDisabledReason={acquisitionDisabledReason}
      latestSweep={sweep ? { id: sweep.id, sequence: sweep.sequence } : undefined}
      onSelect={changeWorkspace}
      onMeasurementView={changeMeasurementView}
      onRun={() => void startContinuousFromUi()}
      onSingle={() => void acquireFromUi()}
      onStop={() => void stopContinuousFromUi()}
    />
    <section className={`workspace-shell ${workspace === 'spectrum' ? 'spectrum-workspace' : ''} ${workspace === 'classification' || workspace === 'detection' ? 'classification-workspace' : ''}`}>
      {(workspace === 'classification' || workspace === 'detection') && measurementActions && <div className="workspace-command-row">{measurementActions}</div>}
      {error && <div className="global-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button data-agent-control="error.dismiss" onClick={() => setError(undefined)}>Dismiss</button></div>}
      {notice && <div className="global-notice" role="status"><span>{notice}</span><button data-agent-control="notice.dismiss" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
      {workspace === 'spectrum' && <MeasurementWorkspace
        measurementActions={measurementActions}
        view={measurementView}
        analyzer={analyzer} spectrumCapability={spectrumCapability} busy={busy} streaming={continuous} onAnalyzer={(configuration) => void updateAnalyzerFromUi(configuration)}
        sweep={sweep} history={history} detections={detections} acquisition={acquisition}
        traces={traceConfiguration} frames={traceFrames} firmwareFrames={firmwareTraceFrames} visibleFirmwareTraceIds={visibleFirmwareTraceIds} onFirmwareTraceVisibility={configureFirmwareTraceVisibility} activeTraceId={activeTraceId} onActiveTrace={setActiveTraceId} markers={markers} readings={markerReadings}
        activeMarkerId={activeMarkerId} markerSearch={markerSearchConfiguration} display={displayConfiguration}
        onTrace={configureTrace} onTraceReset={resetTrace} onMarker={configureMarker} onActiveMarker={setActiveMarkerId}
        onSearch={runMarkerSearch} onSearchConfiguration={configureMarkerSearch} onDisplay={configureDisplay}
        onAutoScale={autoScaleDisplay} onMarkerPlace={placeActiveMarker}
        waterfall={waterfallConfiguration} onWaterfall={configureWaterfall}
        channel={channelConfiguration} onChannel={configureChannelMeasurement}
      />}
      {(workspace === 'detection' || workspace === 'classification') && <ClassificationWorkspace
        sweep={sweep}
        traces={traceFrames} firmwareTraces={firmwareTraceFrames} visibleFirmwareTraceIds={visibleFirmwareTraceIds}
        activeTraceId={activeTraceId} markers={markerReadings} activeMarkerId={activeMarkerId}
        display={displayConfiguration} onMarkerPlace={placeActiveMarker}
        detections={detections} classifications={classifications}
        modelAvailability={classifierAvailability}
        selectedId={zeroCaptureReceiptRef.current?.selection.projectedRepresentativeId
          ?? selectedClassificationId}
        selectionOrigin={classificationTargetSelection.origin}
        onSelectedId={(detectionId) => {
          try { selectClassificationCandidate(detectionId); }
          catch (value) {
            const failure = errorMessage(value);
            setDetectedPowerTargetStagingFailure(failure);
            setNotice(`Detected-power target tune unavailable: ${failure}`);
          }
        }}
        onAutoSelect={() => { void selectAutomaticClassificationCandidate(); }}
        detectionConfig={detectionConfig} detectorBusy={busy} onDetectionConfig={applyDetectionConfiguration}
        zeroConfig={zeroConfig} zeroCapture={zeroCapture} envelope={envelope}
        capability={detectedPowerCapability}
        captureUnavailableReason={detectedPowerTargetStagingFailure}
        busy={!connected || busy}
        onAcquireZero={() => void acquireZeroSpanFromUi()}
      />}
      {workspace === 'iq' && <IqWorkspace
        configuration={iqConfiguration}
        capability={iqCapability}
        capture={iqCapture}
        busy={!connected || busy}
        captureUnavailableReason={iqCaptureUnavailableReason}
        onChange={stageIqConfiguration}
      />}
      {workspace === 'generator' && <GeneratorWorkspace
        config={generator} capability={generatorCapability}
        signalLabProfiles={signalLabProfileCapability} selectedSignalLabProfile={selectedProfile} selectedSignalLabChannel={selectedSignalLabChannel}
        output={generatorOutput} busy={busy} onChange={setGenerator}
        onApply={() => void configureGeneratorFromUi()} onOutput={(enabled) => void setOutputFromUi(enabled)}
        onSignalLabProfile={(profileId) => void selectSignalLabProfile(profileId)}
        onSignalLabChannel={(channel) => void configureSignalLabChannel(channel)}
      />}
      {workspace === 'device' && <DeviceWorkspace
        session={session}
        diagnostics={diagnostics}
        frame={screenFrame}
        busy={busy}
        touchBusy={touchBusy}
        selectedProfile={selectedProfile}
        onProfile={(profileId) => void selectSignalLabProfile(profileId)}
        onRefresh={() => void refreshDiagnosticsFromUi()}
        onCapture={() => void captureScreenFromUi()}
        onTap={tapScreen}
      />}
    </section>
    <AtomAgentPanel open={agentOpen} state={agent.state} status={agent.status} messages={agent.messages} approval={agent.approval} execution={session?.provenance.execution} microphoneMuted={agent.microphoneMuted} speakerMuted={agent.speakerMuted} usage={agent.usage} rateLimits={agent.rateLimits} onClose={() => setAgentOpen(false)} onSend={agent.sendText} onVoice={agent.startVoice} onMicrophoneMute={agent.setMicrophoneMute} onSpeakerMute={agent.setSpeakerMute} onApproval={agent.resolveApproval}/>
    {connectionOpen && <ConnectionDialog
      candidates={candidates}
      selectedId={selectedCandidateId}
      busy={connectionBusy}
      error={error}
      failures={discoveryFailures}
      preference={instrument.preference}
      connected={connected}
      connectionCleanup={instrument.connectionCleanup}
      onSelect={setSelectedCandidateId}
      onRefresh={() => void refreshCandidates()}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      onMakeDefault={() => void makeSelectedDefault()}
      onClose={() => setConnectionOpen(false)}
    />}
  </main>;
}

export function semanticControlRequiresCoordinates(control: AgentSemanticControlId): boolean {
  return control === 'spectrum.marker-place';
}

async function getInstrumentState() {
  return atomizerInstrumentStateSchema.parse(await window.atomizerInstrument.getState());
}

async function discoverInstruments() {
  return instrumentDiscoveryResultSchema.parse(await window.atomizerInstrument.discover());
}

async function connectInstrument(candidate: InstrumentCandidate) {
  return instrumentSessionSnapshotSchema.parse(await window.atomizerInstrument.connect(candidate));
}

async function configureInstrument(configuration: InstrumentConfiguration) {
  return instrumentConfigurationStateSchema.parse(await window.atomizerInstrument.configure(configuration));
}

async function acquireInstrument() {
  return instrumentMeasurementSchema.parse(await window.atomizerInstrument.acquire());
}

async function startInstrumentStreaming() {
  return atomizerInstrumentStreamingStateSchema.parse(await window.atomizerInstrument.startStreaming());
}

async function stopInstrumentStreaming() {
  return atomizerInstrumentStreamingStateSchema.parse(await window.atomizerInstrument.stopStreaming());
}

async function executeInstrumentFeatureBoundary(request: InstrumentFeatureRequest) {
  return atomizerInstrumentFeatureExecutionSchema.parse(await window.atomizerInstrument.executeFeature(request));
}

async function writeInstrumentPreference(selection: AtomizerInstrumentPreferenceSelection) {
  return atomizerInstrumentPreferenceStateSchema.parse(await window.atomizerInstrument.writePreference(selection));
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

function preferredCandidate(candidates: readonly InstrumentCandidate[], state: AtomizerInstrumentState): InstrumentCandidate | undefined {
  const preference = state.preference?.preference;
  if (!preference) return undefined;
  return candidates.find((candidate) => instrumentCandidateMatchesPreference(candidate, state.preference));
}

function instrumentCandidateIsSimulated(candidate: InstrumentCandidate): boolean {
  switch (candidate.sourceKind) {
    case 'serial-port': return false;
    case 'tinysa-firmware-twin':
    case 'signal-lab': return true;
    default: {
      const unhandledCandidate: never = candidate;
      throw new Error(`Instrument candidate simulation status is undefined for ${JSON.stringify(unhandledCandidate)}`);
    }
  }
}

function generatorOutputState(session: InstrumentSessionSnapshot | undefined): GeneratorOutputState {
  if (session?.rfOutput === 'on') return 'on';
  if (session?.rfOutput === 'unknown') return 'unknown';
  return 'off';
}

function connectionNotice(session: InstrumentSessionSnapshot): string {
  const provenance = session.provenance;
  if (provenance.sourceKind === 'signal-lab') return `${session.candidate.displayName} connected as a synthetic measurement source; USB, firmware execution, and RF emission are not claimed`;
  if (provenance.sourceKind === 'tinysa-firmware-twin') return `${provenance.device.model} executable firmware twin connected through ${provenance.bridge}`;
  if (provenance.device.firmwareQualification === 'custom-unqualified') {
    return `${provenance.device.model} connected with custom, source-unqualified firmware`;
  }
  if (provenance.device.firmwareQualification === 'custom-source-qualified-receive-only') {
    return `${provenance.device.model} connected with frozen-source-qualified custom receive-only firmware`;
  }
  return `${provenance.device.model} connected and identified`;
}
function parseMarkerBank(value: unknown): readonly MarkerConfiguration[] {
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
export function fitChannelConfigurationToSpan(input: ChannelMeasurementConfiguration, startHz: number, stopHz: number): ChannelMeasurementConfiguration {
  const current = channelMeasurementConfigurationSchema.parse(input);
  if (!Number.isInteger(startHz) || !Number.isInteger(stopHz) || stopHz <= startHz) throw new Error('Channel measurement reconciliation requires a valid analyzer span');
  const spanHz = stopHz - startHz;
  const extent = (configuration: ChannelMeasurementConfiguration) => Math.max(
    configuration.mainBandwidthHz / 2,
    configuration.adjacentChannelCount * configuration.channelSpacingHz + configuration.adjacentBandwidthHz / 2,
  );
  const requestedExtent = extent(current);
  const marginHz = spanHz * 0.01;
  if (current.centerHz - requestedExtent >= startHz + marginHz && current.centerHz + requestedExtent <= stopHz - marginHz) return current;

  const centerHz = Math.round((startHz + stopHz) / 2);
  if (requestedExtent <= spanHz * 0.45) return channelMeasurementConfigurationSchema.parse({ ...current, centerHz });
  if (spanHz < 16) return current;

  const unitHz = Math.max(1, Math.floor(spanHz / (3 * current.adjacentChannelCount + 4)));
  const mainBandwidthHz = Math.max(1, unitHz * 2);
  const adjacentBandwidthHz = unitHz;
  const channelSpacingHz = Math.max(1, Math.ceil((mainBandwidthHz + adjacentBandwidthHz) / 2));
  return channelMeasurementConfigurationSchema.parse({
    ...current,
    centerHz,
    mainBandwidthHz,
    adjacentBandwidthHz,
    channelSpacingHz,
  });
}
export function coherentSweepCount(history: readonly Sweep[], depth: number): number {
  const reference = history[0];
  if (!reference) return 0;
  return history.filter((candidate) => candidate.frequencyHz.length === reference.frequencyHz.length
    && candidate.frequencyHz.every((frequency, index) => frequency === reference.frequencyHz[index])).slice(0, depth).length;
}

function classificationWindowSweepIds(
  detection: DetectedSignal,
  history: readonly Sweep[],
): readonly string[] {
  const sourceIds = detection.associationMode !== undefined
      && detection.associationMode !== 'frequency-local'
      && detection.associationRegionSweepIds?.length
    ? detection.associationRegionSweepIds
    : detection.sweepIds;
  const admitted = new Set(sourceIds);
  return history
    .filter((candidate) => admitted.has(candidate.id))
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, 8)
    .map((candidate) => candidate.id);
}

function resolveRuntimeAdmittedCaptureTarget(
  signals: readonly DetectedSignal[],
  evidenceSweeps: readonly Sweep[],
  currentSweep: Sweep | undefined,
  preferredDetectionId: string | undefined,
): {
  readonly rawTarget: DetectedSignal;
  readonly detection: DetectedSignal;
  readonly spectrumSweepIds: readonly string[];
} | undefined {
  if (preferredDetectionId === undefined) return undefined;
  const projections = visibleClassificationTargetProjections(signals, currentSweep);
  for (const projection of projections.filter((candidate) =>
    candidate.rawTarget.id === preferredDetectionId)) {
    const detection = projection.projectedRepresentative;
    if (!observableAssociationEvidenceIsCurrentlyQualified(detection)) continue;
    try {
      const observation = extractObservableFeatures(detection, {
        sweeps: evidenceSweeps,
      });
      if (observation.sweepIds.length === 8) {
        return {
          rawTarget: projection.rawTarget,
          detection,
          spectrumSweepIds: observation.sweepIds,
        };
      }
    } catch (error) {
      if (error instanceof ObservableEvidenceUnavailableError) continue;
      throw error;
    }
  }
  return undefined;
}

function captureReceiptRepresentativeMatches(
  receipt: DetectedPowerCaptureReceipt,
  detection: DetectedSignal,
): boolean {
  const expected = receipt.projectedRepresentative;
  return expected.id === detection.id
    && expected.startHz === detection.startHz
    && expected.stopHz === detection.stopHz
    && expected.peakHz === detection.peakHz
    && expected.peakDbm === detection.peakDbm
    && expected.bandwidthHz === detection.bandwidthHz
    && expected.missedSweeps === detection.missedSweeps
    && expected.lastSeenAt === detection.lastSeenAt
    && expected.associationMode === detection.associationMode
    && expected.associationId === detection.associationId
    && expected.associationMissedSweeps === detection.associationMissedSweeps
    && sameOptionalStringArray(
      expected.associationMemberTrackIds,
      detection.associationMemberTrackIds,
    );
}

function classificationWorkRevision(
  sequence: number,
  visibleSweep: Sweep,
  selection: ClassificationTargetSelection,
  evidence: WaveformEvidence,
): string {
  return JSON.stringify({
    contract: 'classification-evidence-revision-v1',
    sequence,
    visibleSweepId: visibleSweep.id,
    visibleSweepSequence: visibleSweep.sequence,
    selectionOrigin: selection.origin,
    projectedRepresentativeId: selection.detectionId ?? null,
    rawTargetId: selection.rawTargetId ?? selection.detectionId ?? null,
    spectrumSweepIds: evidence.sweeps.map((item) => item.id),
    zeroSpanCaptureId: evidence.zeroSpan?.id ?? null,
    zeroSpanSpectrumSweepIds: evidence.zeroSpanSpectrumSweepIds ?? [],
  });
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameOptionalStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
}

function acquisitionModeForWorkspace(
  workspace: WorkspaceId,
  fallback: ContinuousAcquisitionMode,
): ContinuousAcquisitionMode {
  if (workspace === 'iq') return 'complex-iq';
  if (workspace === 'spectrum' || workspace === 'classification' || workspace === 'detection') return 'spectrum';
  return fallback;
}

function invalidatingFeatureReason(
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

function isInvalidatingFeatureRequest(request: InstrumentFeatureRequest): request is InvalidatingFeatureRequest {
  return request.kind === 'signal-lab-profile-selection'
    || request.kind === 'touch'
    || (request.kind === 'rf-generator' && request.action === 'configure');
}

function featureResultAcknowledgesRequest(
  result: InstrumentFeatureResult,
  request: InvalidatingFeatureRequest,
): boolean {
  if (result.sessionId.trim().length === 0
    || result.kind !== request.kind
    || result.action !== request.action) return false;
  const resultRecord = result as unknown as Record<string, unknown>;
  return Object.entries(request).every(([key, value]) => sameStructuredValue(resultRecord[key], value));
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
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

function requireComputerActionResult<T extends { ok: boolean; action: string; target?: string; reason?: string }>(result: T): T {
  if (!result.ok) throw new Error(`App-scoped computer ${result.action} was rejected${result.target ? ` at ${result.target}` : ''}: ${result.reason ?? 'no rejection reason was returned'}`);
  return result;
}
function sameAnalyzerConfiguration(left: AnalyzerConfig, right: AnalyzerConfig): boolean {
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

export function agentSelectedClassificationId({
  receiptProjectedRepresentativeId,
  captureRawTargetId,
  currentSelectionId,
}: {
  receiptProjectedRepresentativeId?: string;
  captureRawTargetId?: string;
  currentSelectionId?: string;
}): string | null {
  return receiptProjectedRepresentativeId
    ?? captureRawTargetId
    ?? currentSelectionId
    ?? null;
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function evaluateAnalysis<T>(operation: () => T): { ok: true; result: T } | { ok: false; error: string } {
  try { return { ok: true, result: operation() }; }
  catch (value) { return { ok: false, error: errorMessage(value) }; }
}

function isDisabledControl(element: HTMLElement): boolean {
  return element.getAttribute('aria-disabled') === 'true'
    || element.classList.contains('disabled')
    || element.matches(':disabled')
    || Boolean(element.querySelector(':disabled'));
}

function inspectRenderedAgentControls() {
  return [...document.querySelectorAll<HTMLElement>('[data-agent-control]')].map((element) => {
    const controlId = element.dataset.agentControl;
    if (!controlId) throw new Error('Rendered agent control is missing its control ID');
    const binding = agentControlBinding(controlId);
    const humanOnly = Boolean(element.closest('[data-agent-exclusion]'));
    return {
      controlId,
      enabled: !humanOnly && !isDisabledControl(element),
      humanOnly,
      risk: binding.risk,
      preferredTool: binding.preferredTool,
      projection: binding.projection,
      guarantee: binding.guarantee,
    };
  });
}
