import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Download, LoaderCircle, Play, Repeat2, StopCircle } from 'lucide-react';
import {
  atomizerInstrumentEventSchema,
  atomizerInstrumentFeatureExecutionSchema,
  atomizerInstrumentPreferenceStateSchema,
  atomizerInstrumentStateSchema,
  atomizerInstrumentStreamingStateSchema,
  analyzerConfigPatchSchema,
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
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
  type AtomizerInstrumentPreferenceSelection,
  type AtomizerInstrumentState,
  type ChannelMeasurementConfiguration,
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
  SignalDetector,
  SignalLabBayesianClassifier,
  SignalTracker,
  TraceAccumulator,
  autoScaleSpectrum,
  calculateSweepMetrics,
  classificationRepresentatives,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  measureChannel,
  readMarkers,
  searchMarker,
  type EnvelopeClassification,
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
import { DetectionWorkspace } from './components/DetectionWorkspace.js';
import { DeviceWorkspace } from './components/DeviceWorkspace.js';
import { GeneratorWorkspace } from './components/GeneratorWorkspace.js';
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
// The Bayesian 2.4 GHz activity association retains up to 96 stable-geometry
// opportunities; keep enough complete sweeps to bind its latest eight positive
// looks and audit the full rolling opportunity provenance.
const HISTORY_LIMIT = 128;
// One immutable configuration per retained sweep, plus bounded room for the
// active mode, zero-span evidence, retune overlap, and admitted async work.
const CONFIGURATION_REVISION_LIMIT = HISTORY_LIMIT + 32;
type RendererConfigurationRevision =
  | { readonly kind: 'swept-spectrum'; readonly admitted: SweptSpectrumConfiguration }
  | { readonly kind: 'detected-power-timeseries'; readonly admitted: DetectedPowerTimeseriesConfiguration };
interface ContinuousStreamOwnership {
  readonly generation: number;
  readonly sessionId: string;
  readonly configurationRevision: string;
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

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceId>('spectrum');
  const [measurementView, setMeasurementView] = useState<MeasurementViewId>(() => loadStored('measurement-view', measurementViewIdSchema.parse, 'spectrum'));
  const [agentOpen, setAgentOpen] = useState(true);
  const [instrument, setInstrument] = useState<AtomizerInstrumentState>(INITIAL_INSTRUMENT_STATE);
  const [candidates, setCandidates] = useState<InstrumentCandidate[]>([]);
  const [discoveryFailures, setDiscoveryFailures] = useState<InstrumentDiscoveryFailure[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [analyzer, setAnalyzer] = useState<AnalyzerConfig>(() => loadStored('analyzer', analyzerConfigSchema.parse, DEFAULT_ANALYZER));
  const [generator, setGenerator] = useState<GeneratorConfig>(() => loadStored('generator', generatorConfigSchema.parse, DEFAULT_GENERATOR));
  const [detectionConfig, setDetectionConfig] = useState<SignalDetectionConfig>(() => loadStored('detector', parseStoredDetection, DEFAULT_DETECTION));
  const [zeroConfig, setZeroConfig] = useState<ZeroSpanConfig>(() => loadStored('zero-span', zeroSpanConfigSchema.parse, DEFAULT_ZERO_SPAN));
  const [traceConfiguration, setTraceConfiguration] = useState<TraceBankConfiguration>(() => loadStored('traces', traceBankConfigurationSchema.parse, DEFAULT_TRACES));
  const [traceFrames, setTraceFrames] = useState<readonly TraceFrame[]>([]);
  const [firmwareTraceFrames, setFirmwareTraceFrames] = useState<readonly FirmwareTraceFrame[]>([]);
  const [visibleFirmwareTraceIds, setVisibleFirmwareTraceIds] = useState<FirmwareTraceVisibility>(() => loadStored('firmware-trace-visibility', firmwareTraceVisibilitySchema.parse, []));
  const [activeTraceId, setActiveTraceId] = useState<TraceId>(1);
  const [markers, setMarkers] = useState<readonly MarkerConfiguration[]>(() => loadStored('markers', parseMarkerBank, DEFAULT_MARKERS));
  const [activeMarkerId, setActiveMarkerId] = useState<MarkerId>(1);
  const [markerSearchConfiguration, setMarkerSearchConfiguration] = useState<MarkerSearchConfiguration>(() => loadStored('marker-search', markerSearchConfigurationSchema.parse, DEFAULT_MARKER_SEARCH));
  const [displayConfiguration, setDisplayConfiguration] = useState<SpectrumDisplayConfiguration>(() => loadStored('spectrum-display', spectrumDisplayConfigurationSchema.parse, DEFAULT_DISPLAY));
  const [waterfallConfiguration, setWaterfallConfiguration] = useState<WaterfallConfiguration>(() => loadStored('waterfall', waterfallConfigurationSchema.parse, DEFAULT_WATERFALL));
  const [channelConfiguration, setChannelConfiguration] = useState<ChannelMeasurementConfiguration>(() => loadStored('channel-measurement', channelMeasurementConfigurationSchema.parse, DEFAULT_CHANNEL));
  const [stftConfiguration, setStftConfiguration] = useState<EnvelopeStftConfiguration>(() => loadStored('envelope-stft', envelopeStftConfigurationSchema.parse, DEFAULT_STFT));
  const [sweep, setSweep] = useState<Sweep>();
  const [history, setHistory] = useState<readonly Sweep[]>([]);
  const [detections, setDetections] = useState<readonly DetectedSignal[]>([]);
  const [classifications, setClassifications] = useState<readonly WaveformClassification[]>([]);
  const [selectedClassificationId, setSelectedClassificationId] = useState<string>();
  const [zeroCapture, setZeroCapture] = useState<ZeroSpanCapture>();
  const [envelope, setEnvelope] = useState<EnvelopeClassification>();
  const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
  const [screenFrame, setScreenFrame] = useState<InstrumentScreenFrame>();
  const [selectedProfile, setSelectedProfile] = useState<string>();
  const [acquisition, setAcquisition] = useState<AcquisitionState>('idle');
  const [continuous, setContinuous] = useState(false);
  const [instrumentTransactionActive, setInstrumentTransactionActive] = useState(false);
  const [remoteGestureActive, setRemoteGestureActive] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const detector = useRef(new SignalDetector(detectionConfig));
  const tracker = useRef(new SignalTracker(detectionConfig));
  const classifier = useRef(new SignalLabBayesianClassifier());
  const traceAccumulator = useRef(new TraceAccumulator(traceConfiguration));
  const historyRef = useRef<readonly Sweep[]>([]);
  const detectionsRef = useRef<readonly DetectedSignal[]>([]);
  const zeroCaptureRef = useRef<ZeroSpanCapture | undefined>(undefined);
  const zeroCaptureSpectrumSweepIdsRef = useRef<readonly string[] | undefined>(undefined);
  const instrumentRef = useRef<AtomizerInstrumentState>(INITIAL_INSTRUMENT_STATE);
  const analyzerRef = useRef<AnalyzerConfig>(analyzer);
  const analyzerRevision = useRef(0);
  const visibleFirmwareTraceIdsRef = useRef<FirmwareTraceVisibility>(visibleFirmwareTraceIds);
  const agentConnectionCandidates = useRef(new Map<string, InstrumentCandidate>());
  const configurationRevisions = useRef(new BoundedRevisionCache<RendererConfigurationRevision>(CONFIGURATION_REVISION_LIMIT));
  const historyConfigurationRevisions = useRef<readonly string[]>([]);
  const zeroCaptureConfigurationRevision = useRef<string | undefined>(undefined);
  const streamingConfigurationLease = useRef<RevisionCacheLease<RendererConfigurationRevision> | undefined>(undefined);
  const continuousRequested = useRef(false);
  const continuousStreamGeneration = useRef(0);
  const continuousStreamOwnership = useRef<ContinuousStreamOwnership | undefined>(undefined);
  const continuousMeasurementTask = useRef<Promise<void> | undefined>(undefined);
  const pendingContinuousMeasurement = useRef<ContinuousMeasurementWork | undefined>(undefined);
  const continuousMeasurementStopRequest = useRef<ContinuousMeasurementStopRequest | undefined>(undefined);
  const continuousMeasurementStopTask = useRef<Promise<void> | undefined>(undefined);
  const failedContinuousMeasurementStopGeneration = useRef<number | undefined>(undefined);
  const analyzerRetuneTask = useRef<Promise<void> | undefined>(undefined);
  const instrumentTransactionOwner = useRef<string | undefined>(undefined);
  const remoteGestureTask = useRef<Promise<void> | undefined>(undefined);
  const analysisSequence = useRef(0);
  const instrumentStateEventSequence = useRef(0);

  const session = instrument.session;
  const generatorOutput = generatorOutputState(session);
  const connected = session !== undefined;
  const transportBusy = false;
  const operationBusy = acquisition === 'configuring' || acquisition === 'retuning' || acquisition === 'acquiring' || acquisition === 'streaming';
  const busy = connectionBusy || transportBusy || operationBusy || instrumentTransactionActive;
  // A running stream may be paused for one admitted remote tap. Every other
  // compound operation, and the tap itself, closes touch admission.
  const touchBusy = connectionBusy || transportBusy || instrumentTransactionActive || remoteGestureActive
    || acquisition === 'configuring' || acquisition === 'retuning' || acquisition === 'acquiring';
  const simulated = session !== undefined && session.provenance.execution !== 'physical';
  const spectrumCapability = session?.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
  const detectedPowerCapability = session?.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
  const generatorCapability = session?.capabilities.features.find((capability) => capability.kind === 'rf-generator');
  const metrics = useMemo(() => sweep ? calculateSweepMetrics(sweep) : undefined, [sweep]);
  const markerReadings = useMemo(() => readMarkers(markers, traceFrames, sweep?.actualRbwHz ?? 10_000), [markers, traceFrames, sweep?.actualRbwHz]);

  useEffect(() => {
    const unsubscribe = window.atomizerInstrument.subscribe(handleInstrumentEvent);
    void initialize();
    return () => {
      if (continuousRequested.current) {
        void stopInstrumentStreaming().catch((value) => {
          console.error('Continuous acquisition did not stop while the Atomizer renderer unmounted', value);
        });
      }
      continuousRequested.current = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => saveStored('analyzer', analyzer), [analyzer]);
  useEffect(() => {
    setChannelConfiguration((current) => fitChannelConfigurationToSpan(current, analyzer.startHz, analyzer.stopHz));
  }, [analyzer.startHz, analyzer.stopHz]);
  useEffect(() => saveStored('generator', generator), [generator]);
  useEffect(() => saveStored('detector', detectionConfig), [detectionConfig]);
  useEffect(() => saveStored('zero-span', zeroConfig), [zeroConfig]);
  useEffect(() => {
    traceAccumulator.current.configure(traceConfiguration);
    setTraceFrames(traceAccumulator.current.frames());
    saveStored('traces', traceConfiguration);
  }, [traceConfiguration]);
  useEffect(() => saveStored('firmware-trace-visibility', visibleFirmwareTraceIds), [visibleFirmwareTraceIds]);
  useEffect(() => saveStored('markers', markers), [markers]);
  useEffect(() => saveStored('marker-search', markerSearchConfiguration), [markerSearchConfiguration]);
  useEffect(() => saveStored('spectrum-display', displayConfiguration), [displayConfiguration]);
  useEffect(() => saveStored('measurement-view', measurementView), [measurementView]);
  useEffect(() => saveStored('waterfall', waterfallConfiguration), [waterfallConfiguration]);
  useEffect(() => saveStored('channel-measurement', channelConfiguration), [channelConfiguration]);
  useEffect(() => {
    if (!selectedClassificationId || !detections.some((item) => item.id === selectedClassificationId)) {
      selectClassificationCandidate(detections[0]?.id);
    }
  }, [detections, selectedClassificationId]);
  useEffect(() => saveStored('envelope-stft', stftConfiguration), [stftConfiguration]);
  useEffect(() => {
    if (session && !detectedPowerCapability && measurementView === 'envelope-stft') setMeasurementView('spectrum');
  }, [session, detectedPowerCapability, measurementView]);
  useEffect(() => {
    if (session && !generatorCapability && workspace === 'generator') setWorkspace('spectrum');
  }, [session, generatorCapability, workspace]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    detector.current.configure(detectionConfig);
    tracker.current.configure(detectionConfig);
    detectionsRef.current = [];
    setDetections([]);
    setClassifications([]);
    clearClassificationCapture();
  }, [detectionConfig]);

  async function initialize(): Promise<void> {
    try {
      const stateEventSequence = instrumentStateEventSequence.current;
      const state = await getInstrumentState();
      // A subscribed lifecycle event is newer than a state snapshot whose IPC
      // request was still in flight. Never let that older snapshot disconnect or
      // deconfigure the renderer after the event has already been accepted.
      if (instrumentStateEventSequence.current === stateEventSequence) acceptInstrumentState(state);
      const discovery = await discoverInstruments();
      acceptDiscovery(discovery.candidates, discovery.failures);
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  function handleInstrumentEvent(value: AtomizerInstrumentEvent): void {
    const event = atomizerInstrumentEventSchema.parse(value);
    if (event.type !== 'discovery' && event.type !== 'measurement') {
      instrumentStateEventSequence.current++;
    }
    if (event.type === 'discovery') acceptDiscovery(event.result.candidates, event.result.failures);
    else if (event.type === 'connected') acceptSession(event.session);
    else if (event.type === 'configured') acceptConfiguration(event.configuration);
    else if (event.type === 'configuration-invalidated') {
      if (instrumentRef.current.session?.sessionId === event.sessionId) {
        invalidateAcquiredEvidence(true);
        acceptInstrumentState({ ...instrumentRef.current, session: event.session }, true);
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
      acceptInstrumentState({ ...instrumentRef.current, session: undefined, streaming: { status: 'stopped' } });
      invalidateAcquiredEvidence();
    }
    else if (event.type === 'preference') acceptInstrumentState({ ...instrumentRef.current, preference: event.preference });
    else if (event.type === 'startup') acceptInstrumentState({ ...instrumentRef.current, startup: event.startup });
    else if (event.type === 'streaming') {
      acceptInstrumentState({ ...instrumentRef.current, streaming: event.streaming });
      if (event.streaming.status === 'stopped') {
        clearContinuousStreamOwnership();
        setAcquisition((current) => current === 'failed' ? current : 'complete');
      } else if (event.streaming.status === 'faulted') {
        clearContinuousStreamOwnership();
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
        setAcquisition('failed');
        invalidateAcquiredEvidence(true);
        setError(event.message ?? 'The active instrument session faulted');
      }
    }
    else if (event.type === 'error') {
      if (instrumentRef.current.session?.sessionId !== event.sessionId) return;
      if (!event.error.recoverable) {
        setAcquisition('failed');
        invalidateAcquiredEvidence(true);
      }
      setError(`${event.error.code}: ${event.error.message}`);
    }
  }

  function admitContinuousMeasurement(work: ContinuousMeasurementWork): void {
    // One active analysis plus one replaceable latest sample is the complete
    // renderer-side streaming budget. The main host acquires serially, but
    // classification can be slower than acquisition and must never turn an
    // event burst into an unbounded set of retained Promise continuations.
    if (continuousMeasurementTask.current) {
      pendingContinuousMeasurement.current = work;
      return;
    }
    const task = processContinuousMeasurements(work);
    continuousMeasurementTask.current = task;
    void task.then(
      () => finishContinuousMeasurementTask(task),
      (value) => {
        if (isCurrentContinuousWork(work)) {
          setAcquisition('failed');
          setError(`Continuous measurement processing failed: ${errorMessage(value)}`);
        }
        finishContinuousMeasurementTask(task);
      },
    );
  }

  async function processContinuousMeasurements(initial: ContinuousMeasurementWork): Promise<void> {
    let work: ContinuousMeasurementWork | undefined = initial;
    while (work) {
      await processContinuousMeasurement(work);
      work = pendingContinuousMeasurement.current;
      pendingContinuousMeasurement.current = undefined;
    }
  }

  async function processContinuousMeasurement(work: ContinuousMeasurementWork): Promise<void> {
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
      await recordSweep(
        projected,
        measurement.configurationRevision,
        () => isCurrentContinuousWork(work),
      );
    } catch (value) {
      if (!isCurrentContinuousWork(work)) return;
      const message = `Sweep analysis failed: ${errorMessage(value)}`;
      setAcquisition('failed');
      setError(message);
      requestContinuousMeasurementStop(work.ownership, message);
    }
  }

  function finishContinuousMeasurementTask(task: Promise<void>): void {
    if (continuousMeasurementTask.current !== task) return;
    continuousMeasurementTask.current = undefined;
    const pending = pendingContinuousMeasurement.current;
    pendingContinuousMeasurement.current = undefined;
    if (pending) admitContinuousMeasurement(pending);
  }

  function isCurrentContinuousWork(work: ContinuousMeasurementWork): boolean {
    const ownership = continuousStreamOwnership.current;
    return ownership === work.ownership
      && ownership.generation === work.ownership.generation
      && instrumentRef.current.session?.sessionId === work.ownership.sessionId
      && continuousRequested.current;
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
      try { await stopStreamingAndReleaseConfiguration(request.ownership); }
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
      const next = await discoverInstruments();
      acceptDiscovery(next.candidates, next.failures);
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
    const candidate = candidates.find((value) => instrumentCandidateUiKey(value) === selectedCandidateId);
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

  function currentGeneratorOutput(): GeneratorOutputState {
    return generatorOutputState(instrumentRef.current.session);
  }

  function acceptInstrumentState(next: AtomizerInstrumentState, initializeSelection = false): void {
    const previousSessionId = instrumentRef.current.session?.sessionId;
    if (next.session?.sessionId !== previousSessionId) invalidateAcquiredEvidence(true);
    instrumentRef.current = next;
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
      if (active) initializeSessionSelection(active, result.profileId);
    }
  }

  async function executeInstrumentFeature(request: InstrumentFeatureRequest): Promise<InstrumentFeatureResult> {
    const execution = await executeInstrumentFeatureBoundary(request);
    const currentSessionId = instrumentRef.current.session?.sessionId;
    if (!currentSessionId || execution.session.sessionId !== currentSessionId) {
      throw new Error('Instrument feature acknowledgement is stale for the active session');
    }
    acceptInstrumentState(
      { ...instrumentRef.current, session: execution.session },
      execution.result.kind === 'signal-lab-profile-selection',
    );
    if (request.kind === 'signal-lab-profile-selection'
      || request.kind === 'touch'
      || (request.kind === 'rf-generator' && request.action === 'configure')) {
      invalidateAcquiredEvidence(true);
    }
    acceptFeatureResult(execution.result);
    return execution.result;
  }

  function initializeSessionSelection(next: InstrumentSessionSnapshot, selectedProfileId?: string): void {
    const profileCapability = next.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    const profileId = selectedProfileId ?? profileCapability?.selectedProfileId;
    setSelectedProfile(profileId);
    const selectedProfileEntry = profileCapability?.profiles.find((profile) => profile.profileId === profileId);
    const detectedPower = next.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
    if (selectedProfileEntry) setZeroConfig((current) => {
      const staged = zeroSpanConfigSchema.parse({ ...current, frequencyHz: selectedProfileEntry.centerFrequencyHz });
      return detectedPower?.kind === 'detected-power-timeseries'
        ? reconcileDetectedPowerConfiguration(detectedPower, staged)
        : staged;
    });
    else if (detectedPower?.kind === 'detected-power-timeseries') {
      setZeroConfig((current) => reconcileDetectedPowerConfiguration(detectedPower, current));
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
        analyzerRef.current = reconciled;
        analyzerRevision.current++;
        setAnalyzer(reconciled);
      }
    }
  }

  async function selectSignalLabProfile(profileId: string): Promise<void> {
    try {
      const result = await runInstrumentTransaction('select-signal-lab-profile', () => executeInstrumentFeature({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId }));
      acceptFeatureResult(result);
      setNotice(`SignalLab profile selected: ${profileId}`);
    } catch (value) { setError(`SignalLab profile selection failed: ${errorMessage(value)}`); }
  }

  async function makeSelectedDefault(): Promise<void> {
    const candidate = candidates.find((value) => instrumentCandidateUiKey(value) === selectedCandidateId);
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
  function requireConfiguration(
    revision: string,
    kind: RendererConfigurationRevision['kind'],
    context: string,
  ): SweptSpectrumConfiguration | DetectedPowerTimeseriesConfiguration {
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
    pendingContinuousMeasurement.current = undefined;
    if (!expected || continuousMeasurementStopRequest.current?.ownership === expected) {
      continuousMeasurementStopRequest.current = undefined;
    }
    failedContinuousMeasurementStopGeneration.current = undefined;
    releaseStreamingConfiguration();
    continuousRequested.current = false;
    setContinuous(false);
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
    continuousRequested.current = true;
    setContinuous(true);
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
    const active = instrumentTransactionOwner.current;
    if (active) throw new Error(`Instrument operation ${active} is already active; ${name} was not admitted`);
    instrumentTransactionOwner.current = name;
    setInstrumentTransactionActive(true);
    try { return await operation(); }
    finally {
      if (instrumentTransactionOwner.current === name) {
        instrumentTransactionOwner.current = undefined;
        setInstrumentTransactionActive(false);
        drainContinuousMeasurementStop();
      }
    }
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
    analyzerRef.current = next;
    analyzerRevision.current++;
    setAnalyzer(next);
    setChannelConfiguration((current) => fitChannelConfigurationToSpan(current, next.startHz, next.stopHz));
    invalidateAcquiredEvidence();
    return { configuration: next, changed: true };
  }

  function invalidateAcquiredEvidence(clearInstrumentConfigurations = false): void {
    analysisSequence.current++;
    historyConfigurationRevisions.current = [];
    if (clearInstrumentConfigurations) {
      releaseStreamingConfiguration();
      zeroCaptureConfigurationRevision.current = undefined;
      configurationRevisions.current.clear();
    }
    historyRef.current = [];
    detectionsRef.current = [];
    traceAccumulator.current.reset();
    tracker.current.reset();
    setSweep(undefined);
    setHistory([]);
    setTraceFrames(traceAccumulator.current.frames());
    setFirmwareTraceFrames([]);
    setDetections([]);
    setClassifications([]);
    setSelectedClassificationId(undefined);
    clearClassificationCapture();
  }

  function clearClassificationCapture(): void {
    zeroCaptureConfigurationRevision.current = undefined;
    retainEvidenceConfigurationRevisions();
    zeroCaptureRef.current = undefined;
    zeroCaptureSpectrumSweepIdsRef.current = undefined;
    setZeroCapture(undefined);
    setEnvelope(undefined);
  }

  function selectClassificationCandidate(detectionId: string | undefined): number | undefined {
    const changed = detectionId !== selectedClassificationId;
    setSelectedClassificationId(detectionId);
    if (changed) clearClassificationCapture();
    if (!detectionId) return undefined;
    const detection = detectionsRef.current.find((candidate) => candidate.id === detectionId)
      ?? detections.find((candidate) => candidate.id === detectionId);
    const capability = instrumentRef.current.session?.capabilities.acquisitions
      .find((candidate) => candidate.kind === 'detected-power-timeseries');
    if (!detection || capability?.kind !== 'detected-power-timeseries') return undefined;
    const frequencyHz = projectDetectedPowerTuneHz(detection.peakHz, capability.centerFrequencyHz);
    setZeroConfig((current) => reconcileDetectedPowerConfiguration(
      capability,
      zeroSpanConfigSchema.parse({ ...current, frequencyHz }),
    ));
    return frequencyHz;
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
        const targetRevision = analyzerRevision.current;
        const configured = await configureAnalyzer(analyzerRef.current, 'retuning');
        if (targetRevision !== analyzerRevision.current) continue;
        await startStreamingWithConfiguration(configured.configurationRevision);
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

  function updateZeroSpanFromUi(input: ZeroSpanConfig): void {
    try {
      const next = zeroSpanConfigSchema.parse(input);
      const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
      if (!capability || capability.kind !== 'detected-power-timeseries') {
        throw new Error('Active instrument does not advertise detected-power acquisition');
      }
      detectedPowerConfigurationFor(capability, next);
      if (JSON.stringify(next) === JSON.stringify(zeroConfig)) return;
      setZeroConfig(next);
      clearClassificationCapture();
    } catch (value) {
      setError(`Detected-power configuration failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  async function recordSweep(
    next: Sweep,
    configurationRevision: string,
    stillCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    const currentAdmitted = capability?.kind === 'swept-spectrum'
      ? sweptSpectrumConfigurationFor(capability, analyzerRef.current)
      : undefined;
    if (!currentAdmitted || !sameSweptSpectrumConfiguration(next.requested, currentAdmitted)) {
      console.warn('[Analyzer] rejected stale sweep for a superseded staged configuration', { sweepId: next.id, requested: next.requested, staged: analyzerRef.current });
      return false;
    }
    const sequence = ++analysisSequence.current;
    const nextHistory = [next, ...historyRef.current].slice(0, HISTORY_LIMIT);
    const nextHistoryRevisions = [configurationRevision, ...historyConfigurationRevisions.current].slice(0, HISTORY_LIMIT);
    historyRef.current = nextHistory;
    historyConfigurationRevisions.current = nextHistoryRevisions;
    retainEvidenceConfigurationRevisions();
    setSweep(next);
    setHistory(nextHistory);
    setTraceFrames(traceAccumulator.current.update(next));
    setFirmwareTraceFrames(next.firmwareTraces ?? []);
    const candidates = detector.current.analyze(next);
    const tracked = tracker.current.update(next, candidates);
    detectionsRef.current = tracked;
    setDetections(tracked);
    let currentSignals = classificationRepresentatives(
      tracked.filter((item) => item.state === 'active'),
      zeroCaptureRef.current?.targetDetectionId,
    );
    const cachedCapture = zeroCaptureRef.current;
    const cachedSweepIds = zeroCaptureSpectrumSweepIdsRef.current;
    if (cachedCapture) {
      const target = currentSignals.find((item) => item.id === cachedCapture.targetDetectionId);
      const currentSweepIds = target ? classificationWindowSweepIds(target, nextHistory) : [];
      if (!cachedSweepIds
        || currentSweepIds.length !== cachedSweepIds.length
        || currentSweepIds.some((sweepId, index) => sweepId !== cachedSweepIds[index])) {
        clearClassificationCapture();
        currentSignals = classificationRepresentatives(tracked.filter((item) => item.state === 'active'));
      }
    }
    const results = await Promise.all(currentSignals.map((item) => classifier.current.classify(item, {
      sweeps: nextHistory,
      zeroSpan: zeroCaptureRef.current,
      ...(zeroCaptureSpectrumSweepIdsRef.current
        ? { zeroSpanSpectrumSweepIds: zeroCaptureSpectrumSweepIdsRef.current }
        : {}),
    })));
    if (sequence === analysisSequence.current && stillCurrent()) setClassifications(results);
    return true;
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
        if (!await recordSweep(next, measurement.configurationRevision)) throw new Error(`Sweep ${next.id} was acquired for a superseded analyzer configuration`);
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

  async function acquireFromUi(): Promise<void> { try { await acquire(); } catch { /* Visible in the workspace alert. */ } }

  function startContinuous(): Promise<void> { return runInstrumentTransaction('start-continuous-acquisition', () => startContinuousOwned()); }

  async function startContinuousOwned(): Promise<void> {
    if (continuousRequested.current) throw new Error('Continuous acquisition is already running');
    try {
      while (true) {
        const targetRevision = analyzerRevision.current;
        const configured = await configureAnalyzer(analyzerRef.current);
        if (targetRevision !== analyzerRevision.current) continue;
        setAcquisition('streaming');
        await startStreamingWithConfiguration(configured.configurationRevision);
        if (targetRevision === analyzerRevision.current) break;
        await stopStreamingAndReleaseConfiguration();
      }
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  function stopContinuous(): Promise<void> { return runInstrumentTransaction('stop-continuous-acquisition', () => stopContinuousOwned()); }

  async function stopContinuousOwned(): Promise<void> {
    if (!continuousRequested.current) throw new Error('Continuous acquisition is not running');
    await stopStreamingAndReleaseConfiguration();
    setAcquisition('complete');
  }

  async function startContinuousFromUi(): Promise<void> { try { await startContinuous(); } catch { /* Visible in the workspace alert. */ } }
  async function stopContinuousFromUi(): Promise<void> { try { await stopContinuous(); } catch (value) { setError(errorMessage(value)); } }

  function acquireZeroSpan(): Promise<ZeroSpanCapture> { return runInstrumentTransaction('acquire-detected-power', () => acquireZeroSpanOwned()); }

  async function acquireZeroSpanOwned(): Promise<ZeroSpanCapture> {
    const activeSession = requireConnected();
    const sessionId = activeSession.sessionId;
    const validated = zeroSpanConfigSchema.parse(zeroConfig);
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const reservation = configurationRevisions.current.reserve();
      let configuration: InstrumentConfigurationState;
      try {
        const capability = activeSession.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
        if (!capability || capability.kind !== 'detected-power-timeseries') {
          throw new Error('Active instrument does not advertise detected-power acquisition');
        }
        const requested = detectedPowerConfigurationFor(capability, validated);
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
        const capture = projectDetectedPowerMeasurement(measurement, activeSession, requested, selectedClassificationId);
        zeroCaptureConfigurationRevision.current = measurement.configurationRevision;
        retainEvidenceConfigurationRevisions();
        zeroCaptureRef.current = capture;
        setZeroCapture(capture);
        setEnvelope(classifyZeroSpanEnvelope(capture));
        try {
          await configureAnalyzer(analyzerRef.current);
        } catch (value) {
          throw new Error(`Zero-span capture ${capture.id} completed, but restoring the staged swept-analyzer configuration failed: ${errorMessage(value)}`);
        }
        const sequence = ++analysisSequence.current;
        const active = classificationRepresentatives(
          detectionsRef.current.filter((item) => item.state === 'active'),
          capture.targetDetectionId,
        );
        const target = active.find((item) => item.id === capture.targetDetectionId);
        const capturedSweepIds = target ? classificationWindowSweepIds(target, historyRef.current) : [];
        zeroCaptureSpectrumSweepIdsRef.current = capturedSweepIds.length === 8
          ? capturedSweepIds
          : undefined;
        const results = await Promise.all(active.map((item) => classifier.current.classify(item, {
          sweeps: historyRef.current,
          zeroSpan: capture,
          ...(zeroCaptureSpectrumSweepIdsRef.current
            ? { zeroSpanSpectrumSweepIds: zeroCaptureSpectrumSweepIdsRef.current }
            : {}),
        })));
        if (sequence === analysisSequence.current) setClassifications(results);
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
    return runInstrumentTransaction('configure-rf-generator', () => configureGeneratorOwned(config));
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

  async function configureGeneratorFromUi(): Promise<void> { try { await configureGeneratorWith(generator); } catch { /* Visible in the workspace alert. */ } }

  function setOutput(enabled: boolean) {
    return runInstrumentTransaction(enabled ? 'enable-rf-output' : 'disable-rf-output', () => setOutputOwned(enabled));
  }

  async function setOutputOwned(enabled: boolean) {
    requireConnected();
    setError(undefined);
    setAcquisition('configuring');
    try {
      await configureGeneratorOwned(generatorConfigSchema.parse(generator));
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
    assertWorkspaceTransition(workspace, 'device', currentGeneratorOutput());
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
      if (resume) {
        while (true) {
          requireRemoteGestureSession(sessionId);
          const targetRevision = analyzerRevision.current;
          const configured = await configureAnalyzer(analyzerRef.current, 'retuning');
          if (targetRevision !== analyzerRevision.current) continue;
          requireRemoteGestureSession(sessionId);
          await startStreamingWithConfiguration(configured.configurationRevision);
          if (targetRevision === analyzerRevision.current) break;
          await stopStreamingAndReleaseConfiguration();
        }
        setAcquisition('streaming');
        setNotice('Continuous acquisition resumed after remote screen tap');
      }
    } catch (value) {
      setAcquisition('failed');
      setError(`Remote screen tap failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  function tapScreen(point: InstrumentScreenPoint): void { void queueRemoteTap(point); }

  async function exportLatest(format: 'csv' | 'json'): Promise<unknown> {
    if (!sweep) throw new Error('Acquire a complete spectrum sweep before exporting');
    setError(undefined);
    try {
      const result = await window.atomizerFiles.exportSweep({ sweep, format });
      if (result.status === 'saved') setNotice(`Saved ${result.bytesWritten.toLocaleString()} provenance-bearing bytes to ${result.path}`);
      return result;
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    }
  }

  function applyWorkspace(next: WorkspaceId): void {
    assertWorkspaceTransition(workspace, next, currentGeneratorOutput());
    setWorkspace(next);
    setError(undefined);
  }

  function changeWorkspace(next: WorkspaceId): void {
    try { applyWorkspace(next); }
    catch (value) { setError(errorMessage(value)); }
  }

  function applyTrace(input: TraceConfiguration): TraceConfiguration {
    const trace = traceConfigurationSchema.parse(input);
    setTraceConfiguration((current) => traceBankConfigurationSchema.parse(current.map((item) => item.id === trace.id ? trace : item)));
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
      visibleFirmwareTraceIdsRef.current = next;
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
    setMarkers((current) => {
      const next = current.map((item) => item.id === marker.id ? marker : item);
      if (marker.mode === 'delta' && marker.referenceMarkerId !== undefined) {
        return next.map((item) => item.id === marker.referenceMarkerId && !item.enabled ? { ...item, enabled: true } : item);
      }
      return next;
    });
    setActiveMarkerId(marker.id);
    setError(undefined);
    return marker;
  }

  function configureMarker(input: MarkerConfiguration): void {
    try { applyMarker(input); }
    catch (value) { setError(`Marker configuration failed: ${errorMessage(value)}`); }
  }

  function placeActiveMarker(frequencyHz: number): void {
    const marker = markers.find((item) => item.id === activeMarkerId);
    if (!marker) { setError(`Active marker M${activeMarkerId} is unavailable`); return; }
    configureMarker({ ...marker, enabled: true, tracking: 'fixed', frequencyHz });
  }

  function runMarkerSearch(action: MarkerSearchAction, markerId: MarkerId = activeMarkerId): void {
    try {
      const marker = markers.find((item) => item.id === markerId);
      if (!marker) throw new Error(`Marker M${markerId} is unavailable`);
      const frame = traceFrames.find((item) => item.traceId === marker.traceId);
      if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
      const frequencyHz = searchMarker(frame, marker.frequencyHz, action, markerSearchConfiguration);
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
    const next = measurementViewIdSchema.parse(input);
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

  function configureEnvelopeStft(input: EnvelopeStftConfiguration): void {
    try { applyEnvelopeStft(input); }
    catch (value) { setError(`Envelope STFT configuration failed: ${errorMessage(value)}`); }
  }

  function requireChannelMeasurement() {
    if (!sweep) throw new Error('Acquire a complete spectrum sweep before reading channel measurements');
    return measureChannel(sweep, channelConfiguration);
  }

  function requireEnvelopeStft() {
    if (!zeroCapture) throw new Error('Acquire a complete zero-span capture before reading the envelope STFT');
    return computeEnvelopeStft(zeroCapture, stftConfiguration);
  }

  function autoScaleDisplay(): void {
    if (!sweep) { setError('Acquire a sweep before auto-scaling the display'); return; }
    configureDisplay(autoScaleSpectrum(sweep));
  }

  function systemTopology() {
    const active = instrumentRef.current.session;
    return {
      atomizer: { owner: 'tinysa-atomizer', instrumentApiVersion: window.atomizerInstrument.version, role: 'instrument-host' },
      instrument: active ? {
        driverId: active.driverId,
        sourceKind: active.provenance.sourceKind,
        execution: active.provenance.execution,
        transport: active.provenance.transport,
        qualification: active.provenance.qualification,
        usbIdentityVerified: active.provenance.sourceKind === 'serial-port' ? active.provenance.device.usbIdentityVerified : false,
        sessionId: active.sessionId,
      } : null,
      firmwareTwin: { owner: 'tinysa-firmware', available: candidates.some((candidate) => candidate.sourceKind === 'tinysa-firmware-twin'), connected: active?.provenance.sourceKind === 'tinysa-firmware-twin', integration: 'renode-monitor-v1', usbTransactionsModeled: false },
      signalLab: { owner: 'tinysa-signal-lab', available: candidates.some((candidate) => candidate.sourceKind === 'signal-lab'), connected: active?.provenance.sourceKind === 'signal-lab', integration: 'measurement-bridge-v1', claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
    } as const;
  }

  function agentStagedConfiguration(
    stagedAnalyzer: AnalyzerConfig = analyzer,
    stagedDetectedPower: ZeroSpanConfig = zeroConfig,
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
    stagedAnalyzer: AnalyzerConfig = analyzer,
    stagedDetectedPower: ZeroSpanConfig = zeroConfig,
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

  function applicationContext(): string {
    const channelMeasurement = evaluateAnalysis(() => requireChannelMeasurement());
    const envelopeStft = evaluateAnalysis(() => requireEnvelopeStft());
    return JSON.stringify({
      workspace,
      measurementView,
      acquisition,
      continuous,
      simulated,
      topology: systemTopology(),
      visibleError: error ?? null,
      instrument,
      generatorOutput,
      scalarConfiguration: agentConfigurationContext(),
      generator,
      detectionConfig,
      historyCount: history.length,
      latestSweep: sweep && metrics ? { id: sweep.id, sequence: sweep.sequence, capturedAt: sweep.capturedAt, rangeHz: [sweep.actualStartHz, sweep.actualStopHz], points: sweep.frequencyHz.length, source: sweep.source, elapsedMilliseconds: sweep.elapsedMilliseconds, metrics } : null,
      detections: agentDetectionResults(detections),
      classifications: classifications.map(({ detectionId, label, confidence, modelId, unknownReason }) => ({ detectionId, label, confidence, modelId, unknownReason })),
      selectedClassificationId: selectedClassificationId ?? null,
      zeroSpan: zeroCapture && envelope ? { frequencyHz: zeroCapture.frequencyHz, samples: zeroCapture.powerDbm.length, samplePeriodSeconds: zeroCapture.samplePeriodSeconds, envelope } : null,
      measurement: {
        activeView: measurementView,
        traces: traceConfiguration.map((trace) => ({ ...trace, sweepCount: traceFrames.find((frame) => frame.traceId === trace.id)?.sweepCount ?? 0 })),
        firmwareTraces: firmwareTraceFrames.map(({ traceId, role, unit, frozen, sourceSweepId, capturedAt }) => ({ traceId, role, unit, frozen, visible: visibleFirmwareTraceIds.includes(traceId), sourceSweepId, capturedAt, evidence: 'firmware-readback' })),
        activeTraceId,
        markers: { configurations: markers, readings: markerReadings },
        activeMarkerId,
        markerSearch: markerSearchConfiguration,
        display: displayConfiguration,
        waterfall: { configuration: waterfallConfiguration, coherentSweeps: coherentSweepCount(history, waterfallConfiguration.historyDepth) },
        channel: { configuration: channelConfiguration, analysis: channelMeasurement },
        envelopeStft: { configuration: stftConfiguration, analysis: envelopeStft },
        evidence: 'host-derived',
      },
    });
  }

  async function executeAgentTool(name: AgentToolName, args: unknown): Promise<unknown> {
    switch (name) {
      case 'get_application_state': return {
        workspace,
        measurementView,
        acquisition,
        continuous,
        simulated,
        error: error ?? null,
        historyCount: history.length,
        topology: systemTopology(),
        connection: instrument.session ? 'connected' : 'disconnected',
        scalarConfiguration: agentConfigurationContext(),
        generator,
        detection: detectionConfig,
        measurement: JSON.parse(applicationContext()).measurement,
        latestSweep: JSON.parse(applicationContext()).latestSweep,
        agentSurfaceVersion: ATOM_AGENT_VERSION,
      };
      case 'get_system_topology': return systemTopology();
      case 'get_agent_surface': return {
        version: ATOM_AGENT_VERSION,
        model: ATOM_AGENT_MODEL,
        loading: { startupTool: ATOM_TOOL_LOADER_NAME, maximumToolsPerResponse: ATOM_MAX_LOADED_TOOLS, fullToolCount: agentToolDefinitions.length, concreteSchemas: 'response-scoped' },
        tools: agentToolDefinitions.map((tool) => ({ name: tool.name, description: tool.description, policy: agentToolPolicies[tool.name] })),
        controlBindings: agentControlBindings.map((binding) => ({ pattern: binding.pattern.source, preferredTool: binding.preferredTool, risk: binding.risk, projection: binding.projection, guarantee: binding.guarantee })),
        apiCoverage: agentApiCoverage,
      };
      case 'get_instrument_state': return { ...instrument, generatorOutput, scalarConfiguration: agentConfigurationContext() };
      case 'get_latest_sweep_summary': return JSON.parse(applicationContext()).latestSweep;
      case 'get_detection_results': return agentDetectionResults(detections);
      case 'get_classification_results': return {
        contract: 'classification-results-with-association-lineage-v1',
        spectral: agentClassificationResults(detections, classifications),
        zeroSpan: zeroCapture ? { captureId: zeroCapture.id, envelope: envelope ?? null } : null,
      };
      case 'read_device_diagnostics': return refreshDiagnostics();
      case 'list_connection_candidates': {
        const discovery = await runInstrumentTransaction('list-connection-candidates', () => discoverInstruments());
        acceptDiscovery(discovery.candidates, discovery.failures);
        const issued = discovery.candidates.map((candidate, index) => ({ candidateId: `candidate-${index + 1}`, driverId: candidate.driverId, displayName: candidate.displayName, sourceKind: candidate.sourceKind, simulated: instrumentCandidateIsSimulated(candidate), selected: instrumentCandidateUiKey(candidate) === selectedCandidateId }));
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
        const rendered = inspectRenderedAgentControls();
        return { activeWorkspace: workspace, activeMeasurementView: measurementView, controls: Object.fromEntries(rendered.map((control) => [control.controlId, control.enabled])), rendered };
      }
      case 'computer_action': {
        const control = (args as { controlId: AgentSemanticControlId }).controlId;
        const binding = agentControlBinding(control);
        if (binding.risk === 'high-impact') throw new Error(`Semantic control ${control} is high-impact and requires its typed approval tool`);
        const targets = [...document.querySelectorAll<HTMLElement>('[data-agent-control]')].filter((element) => element.dataset.agentControl === control);
        if (targets.length !== 1) throw new Error(`Semantic control ${control} has ${targets.length} rendered targets; expected exactly one`);
        const target = targets[0]!;
        if (target.closest('[data-agent-exclusion]')) throw new Error(`Semantic control ${control} is a local human-only boundary`);
        if (isDisabledControl(target)) throw new Error(`Semantic control ${control} is disabled`);
        if (target instanceof HTMLDetailsElement) target.open = !target.open;
        else target.click();
        return { activated: control, preferredTool: binding.preferredTool, projection: binding.projection };
      }
      case 'computer_screenshot': return window.atomAgent.computerScreenshot();
      case 'computer_click': return requireComputerActionResult(await window.atomAgent.computerClick(args as { screenshotId: string; x: number; y: number }));
      case 'computer_type': return requireComputerActionResult(await window.atomAgent.computerType(args as { expectedTarget: string; text: string }));
      case 'computer_key': return requireComputerActionResult(await window.atomAgent.computerKey(args as { expectedTarget: string; key: string }));
      case 'computer_scroll': return requireComputerActionResult(await window.atomAgent.computerScroll(args as { screenshotId: string; x: number; y: number; deltaX: number; deltaY: number }));
      case 'navigate_workspace': applyWorkspace((args as { workspace: WorkspaceId }).workspace); return { workspace: (args as { workspace: WorkspaceId }).workspace };
      case 'configure_analyzer': {
        assertWorkspaceTransition(workspace, 'spectrum', currentGeneratorOutput());
        const patch = analyzerConfigPatchSchema.parse(args);
        const next = await updateAnalyzer(patch);
        applyWorkspace('spectrum');
        return { patch, scalarConfiguration: agentConfigurationContext(next), continuous: continuousRequested.current };
      }
      case 'acquire_sweep': { assertWorkspaceTransition(workspace, 'spectrum', currentGeneratorOutput()); const result = await acquire(); applyWorkspace('spectrum'); return { acquired: true, sweepId: result.id, sequence: result.sequence, points: result.frequencyHz.length, source: result.source, identity: result.identity }; }
      case 'start_continuous_sweeps': assertWorkspaceTransition(workspace, 'spectrum', currentGeneratorOutput()); await startContinuous(); applyWorkspace('spectrum'); return { streaming: true };
      case 'stop_continuous_sweeps': await stopContinuous(); return { streaming: false, sweepsRetained: history.length };
      case 'get_measurement_state': return JSON.parse(applicationContext()).measurement;
      case 'set_measurement_view': {
        const view = measurementViewIdSchema.parse((args as { view: MeasurementViewId }).view);
        applyMeasurementView(view);
        return { workspace: 'spectrum', view };
      }
      case 'configure_waterfall': {
        const configuration = waterfallConfigurationSchema.parse(args);
        applyMeasurementView('waterfall');
        applyWaterfall(configuration);
        return { configuration, retainedSweeps: coherentSweepCount(history, configuration.historyDepth), evidence: 'host-derived-scalar-sweep' };
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
        assertWorkspaceTransition(workspace, 'spectrum', currentGeneratorOutput());
        const capture = await acquireZeroSpan();
        const result = computeEnvelopeStft(capture, stftConfiguration);
        applyMeasurementView('envelope-stft');
        return result;
      }
      case 'select_marker': {
        const markerId = (args as { markerId: MarkerId }).markerId;
        if (!markers.some((marker) => marker.id === markerId)) throw new Error(`Marker M${markerId} is unavailable`);
        applyWorkspace('spectrum');
        setActiveMarkerId(markerId);
        return { markerId, selected: true, evidence: 'ui-only' };
      }
      case 'configure_marker': {
        const marker = markerConfigurationSchema.parse(args);
        applyWorkspace('spectrum');
        applyMarker(marker);
        return { marker, evidence: 'host-derived' };
      }
      case 'configure_marker_search': {
        const configuration = markerSearchConfigurationSchema.parse(args);
        applyWorkspace('spectrum');
        applyMarkerSearch(configuration);
        return { configuration, evidence: 'host-derived' };
      }
      case 'search_marker': {
        const value = args as { markerId: MarkerId; action: MarkerSearchAction };
        const marker = markers.find((item) => item.id === value.markerId);
        if (!marker) throw new Error(`Marker M${value.markerId} is unavailable`);
        const frame = traceFrames.find((item) => item.traceId === marker.traceId);
        if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
        applyWorkspace('spectrum');
        const frequencyHz = searchMarker(frame, marker.frequencyHz, value.action, markerSearchConfiguration);
        applyMarker({ ...marker, enabled: true, tracking: value.action === 'peak' ? 'peak' : 'fixed', frequencyHz });
        return { markerId: value.markerId, action: value.action, frequencyHz, evidence: 'host-derived' };
      }
      case 'select_trace': {
        const traceId = (args as { traceId: TraceId }).traceId;
        if (!traceConfiguration.some((trace) => trace.id === traceId)) throw new Error(`Trace ${traceId} is unavailable`);
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
        if (!sweep) throw new Error('Acquire a complete spectrum sweep before auto-scaling the display');
        applyWorkspace('spectrum');
        const display = autoScaleSpectrum(sweep);
        applyDisplay(display);
        return { display, sweepId: sweep.id, evidence: 'host-derived-complete-sweep' };
      }
      case 'configure_signal_detector': { const next = signalDetectionConfigSchema.parse(args); applyWorkspace('detection'); setDetectionConfig(next); return next; }
      case 'select_classification_candidate': {
        const detectionId = (args as { detectionId: string }).detectionId;
        if (!detections.some((item) => item.id === detectionId)) throw new Error(`Detection ${detectionId} is no longer available`);
        applyWorkspace('classification');
        const stagedDetectedPowerCenterHz = selectClassificationCandidate(detectionId);
        return { detectionId, selected: true, stagedDetectedPowerCenterHz: stagedDetectedPowerCenterHz ?? null, evidence: 'ui-staging' };
      }
      case 'configure_zero_span': {
        const capability = instrumentRef.current.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
        const { patch, configuration: next } = stageDetectedPowerConfigurationPatch(
          capability?.kind === 'detected-power-timeseries' ? capability : undefined,
          zeroConfig,
          args as ZeroSpanConfigPatch,
        );
        applyWorkspace('classification');
        setZeroConfig(next);
        return { patch, scalarConfiguration: agentConfigurationContext(analyzer, next) };
      }
      case 'acquire_zero_span': { assertWorkspaceTransition(workspace, 'classification', currentGeneratorOutput()); const result = await acquireZeroSpan(); applyWorkspace('classification'); return { acquired: true, captureId: result.id, samples: result.powerDbm.length, envelope: classifyZeroSpanEnvelope(result), identity: result.identity }; }
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
  const acquisitionActions = (continuous || (workspace !== 'generator' && workspace !== 'device')) ? <div className="acquisition-actions">
    {sweep && workspace !== 'generator' && workspace !== 'device' && <>
      <button data-agent-control="export.csv" className="secondary compact icon-only" aria-label="Export CSV" title="Export CSV" onClick={() => void exportLatest('csv')}><Download size={14}/><span>CSV</span></button>
      <button data-agent-control="export.json" className="secondary compact icon-only" aria-label="Export JSON" title="Export JSON" onClick={() => void exportLatest('json')}><span>{'{ }'}</span></button>
    </>}
    {continuous
      ? <button data-agent-control="acquisition.continuous.stop" className="secondary compact stop-acquisition" onClick={() => void stopContinuousFromUi()}><StopCircle size={14}/>Stop</button>
      : <>
        <button data-agent-control="acquisition.continuous.start" className="secondary compact" disabled={!connected || busy} onClick={() => void startContinuousFromUi()}><Repeat2 size={14}/>Run</button>
        <button data-agent-control="acquisition.single" className="primary compact" disabled={!connected || busy} onClick={() => void acquireFromUi()}>{busy ? <LoaderCircle className="spin" size={14}/> : <Play size={14} fill="currentColor"/>}{acquisition === 'acquiring' ? 'Acquiring…' : 'Single'}</button>
      </>}
  </div> : null;

  return <main className={`app-shell ${agentOpen ? 'ai-open' : ''}`}>
    <TopBar instrument={instrument} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)} onConnection={() => setConnectionOpen(true)} onAgent={() => setAgentOpen((value) => !value)}/>
    <Sidebar active={workspace} output={generatorOutput} generatorAvailable={generatorCapability !== undefined} onSelect={changeWorkspace}/>
    <section className={`workspace-shell ${workspace === 'spectrum' ? 'spectrum-workspace' : ''} ${workspace === 'classification' ? 'classification-workspace' : ''}`}>
      {workspace !== 'spectrum' && acquisitionActions && <div className="workspace-command-row">{acquisitionActions}</div>}
      {error && <div className="global-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button data-agent-control="error.dismiss" onClick={() => setError(undefined)}>Dismiss</button></div>}
      {notice && <div className="global-notice" role="status"><span>{notice}</span><button data-agent-control="notice.dismiss" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
      {workspace === 'spectrum' && <MeasurementWorkspace
        acquisitionActions={acquisitionActions}
        view={measurementView} onView={changeMeasurementView}
        analyzer={analyzer} spectrumCapability={spectrumCapability} detectedPowerCapability={detectedPowerCapability} busy={busy} connected={connected} streaming={continuous} onAnalyzer={(configuration) => void updateAnalyzerFromUi(configuration)}
        sweep={sweep} history={history} detections={detections} acquisition={acquisition}
        traces={traceConfiguration} frames={traceFrames} firmwareFrames={firmwareTraceFrames} visibleFirmwareTraceIds={visibleFirmwareTraceIds} onFirmwareTraceVisibility={configureFirmwareTraceVisibility} activeTraceId={activeTraceId} onActiveTrace={setActiveTraceId} markers={markers} readings={markerReadings}
        activeMarkerId={activeMarkerId} markerSearch={markerSearchConfiguration} display={displayConfiguration}
        onTrace={configureTrace} onTraceReset={resetTrace} onMarker={configureMarker} onActiveMarker={setActiveMarkerId}
        onSearch={runMarkerSearch} onSearchConfiguration={configureMarkerSearch} onDisplay={configureDisplay}
        onAutoScale={autoScaleDisplay} onMarkerPlace={placeActiveMarker}
        waterfall={waterfallConfiguration} onWaterfall={configureWaterfall}
        channel={channelConfiguration} onChannel={configureChannelMeasurement}
        zeroConfig={zeroConfig} zeroCapture={zeroCapture} stft={stftConfiguration}
        onZeroConfig={updateZeroSpanFromUi} onStft={configureEnvelopeStft} onAcquireZero={() => void acquireZeroSpanFromUi()}
      />}
      {workspace === 'detection' && <DetectionWorkspace sweep={sweep} detections={detections} busy={busy} config={detectionConfig} onConfig={setDetectionConfig}/>}
      {workspace === 'classification' && <ClassificationWorkspace
        sweep={sweep} detections={detections} classifications={classifications}
        selectedId={selectedClassificationId} onSelectedId={selectClassificationCandidate}
        zeroConfig={zeroConfig} zeroCapture={zeroCapture} envelope={envelope}
        capability={detectedPowerCapability} busy={!connected || busy}
        onZeroConfig={updateZeroSpanFromUi} onAcquireZero={() => void acquireZeroSpanFromUi()}
      />}
      {workspace === 'generator' && <GeneratorWorkspace config={generator} capability={generatorCapability} output={generatorOutput} busy={busy} onChange={setGenerator} onApply={() => void configureGeneratorFromUi()} onOutput={(enabled) => void setOutputFromUi(enabled)}/>}
      {workspace === 'device' && <DeviceWorkspace session={session} diagnostics={diagnostics} frame={screenFrame} busy={busy} touchBusy={touchBusy} selectedProfile={selectedProfile} onProfile={(profileId) => void selectSignalLabProfile(profileId)} onRefresh={() => void refreshDiagnosticsFromUi()} onCapture={() => void captureScreenFromUi()} onTap={tapScreen}/>}
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
  const raw = localStorage.getItem(`tinysa-atomizer:v2:${name}`);
  return raw === null ? structuredClone(initial) : parse(JSON.parse(raw));
}
function saveStored(name: string, value: unknown): void { localStorage.setItem(`tinysa-atomizer:v2:${name}`, JSON.stringify(value)); }
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
  return provenance.device.firmwareQualification === 'custom-unqualified'
    ? `${provenance.device.model} connected with custom, source-unqualified firmware`
    : `${provenance.device.model} connected and identified`;
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
