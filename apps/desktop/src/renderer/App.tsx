import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Download, LoaderCircle, Play, Repeat2, StopCircle } from 'lucide-react';
import {
  analyzerConfigPatchSchema,
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  generatorConfigSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  measurementViewIdSchema,
  OEM_ZS407_SELF_TEST_PROCEDURE,
  portCandidateSchema,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  traceConfigurationSchema,
  waterfallConfigurationSchema,
  zeroSpanConfigSchema,
  type AnalyzerConfig,
  type AnalyzerConfigPatch,
  type ChannelMeasurementConfiguration,
  type DeviceDiagnostics,
  type DeviceEvent,
  type DeviceSnapshot,
  type DetectedSignal,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
  type FirmwareTraceFrame,
  type FirmwareTraceId,
  type FirmwareTraceVisibility,
  type GeneratorConfig,
  type EnvelopeStftConfiguration,
  type MarkerConfiguration,
  type MarkerId,
  type MarkerSearchAction,
  type MarkerSearchConfiguration,
  type MeasurementViewId,
  type PortCandidate,
  type ScreenFrame,
  type ScreenPoint,
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
  firmwareTraceVisibilitySchema,
} from '@tinysa/contracts';
import {
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
import { FirmwareUpdateDialog } from './components/FirmwareUpdateDialog.js';
import { GeneratorWorkspace } from './components/GeneratorWorkspace.js';
import { MeasurementWorkspace } from './components/MeasurementWorkspace.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { assertWorkspaceTransition, DEFAULT_ANALYZER, DEFAULT_GENERATOR, DISCONNECTED_SNAPSHOT, type AcquisitionState, type WorkspaceId } from './ui-contracts.js';
import { agentDetectionResults } from './agent-detection-results.js';
import { useAtomAgent } from './useAtomAgent.js';

const DEFAULT_DETECTION: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const DEFAULT_ZERO_SPAN: ZeroSpanConfig = {
  frequencyHz: 433_920_000,
  points: 450,
  rbwKhz: 100,
  attenuationDb: 'auto',
  sweepTimeSeconds: 0.05,
  trigger: { mode: 'auto' },
};
// The Bayesian 2.4 GHz activity association retains up to 96 stable-geometry
// opportunities; keep enough complete sweeps to bind its latest eight positive
// looks and audit the full rolling opportunity provenance.
const HISTORY_LIMIT = 128;
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
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>(DISCONNECTED_SNAPSHOT);
  const [ports, setPorts] = useState<PortCandidate[]>([]);
  const [selectedPortId, setSelectedPortId] = useState<string>();
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
  const [diagnostics, setDiagnostics] = useState<DeviceDiagnostics>();
  const [screenFrame, setScreenFrame] = useState<ScreenFrame>();
  const [acquisition, setAcquisition] = useState<AcquisitionState>('idle');
  const [continuous, setContinuous] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [firmwareUpdate, setFirmwareUpdate] = useState<FirmwareUpdateState>();
  const [firmwareUpdateOpen, setFirmwareUpdateOpen] = useState(false);
  const [firmwareUpdateBusy, setFirmwareUpdateBusy] = useState(false);
  const [firmwarePreflight, setFirmwarePreflight] = useState<Partial<FirmwareUpdatePreflight>>({});

  const detector = useRef(new SignalDetector(detectionConfig));
  const tracker = useRef(new SignalTracker(detectionConfig));
  const classifier = useRef(new SignalLabBayesianClassifier());
  const traceAccumulator = useRef(new TraceAccumulator(traceConfiguration));
  const historyRef = useRef<readonly Sweep[]>([]);
  const detectionsRef = useRef<readonly DetectedSignal[]>([]);
  const zeroCaptureRef = useRef<ZeroSpanCapture | undefined>(undefined);
  const snapshotRef = useRef<DeviceSnapshot>(DISCONNECTED_SNAPSHOT);
  const analyzerRef = useRef<AnalyzerConfig>(analyzer);
  const analyzerRevision = useRef(0);
  const visibleFirmwareTraceIdsRef = useRef<FirmwareTraceVisibility>(visibleFirmwareTraceIds);
  const agentConnectionCandidates = useRef(new Map<string, PortCandidate>());
  const continuousRequested = useRef(false);
  const analyzerRetuneTask = useRef<Promise<void> | undefined>(undefined);
  const remoteGestureQueue = useRef<Promise<void>>(Promise.resolve());
  const remoteGesturePausedContinuous = useRef(false);
  const analysisSequence = useRef(0);
  const firmwareRevisionChecked = useRef<string | undefined>(undefined);
  const firmwareDfuPollBusy = useRef(false);

  const connected = snapshot.connection === 'ready';
  const transportBusy = snapshot.connection === 'connecting' || snapshot.connection === 'identifying' || snapshot.connection === 'disconnecting';
  const operationBusy = acquisition === 'configuring' || acquisition === 'retuning' || acquisition === 'acquiring' || acquisition === 'streaming';
  const busy = connectionBusy || transportBusy || operationBusy;
  const simulated = snapshot.identity?.execution === 'firmware-digital-twin' || snapshot.identity?.execution === 'protocol-test-double' || snapshot.pendingPort?.execution === 'firmware-digital-twin';
  const metrics = useMemo(() => sweep ? calculateSweepMetrics(sweep) : undefined, [sweep]);
  const markerReadings = useMemo(() => readMarkers(markers, traceFrames, sweep?.actualRbwHz ?? 10_000), [markers, traceFrames, sweep?.actualRbwHz]);

  useEffect(() => {
    const unsubscribe = window.tinySA.subscribe(handleDeviceEvent);
    void initialize();
    return () => {
      if (continuousRequested.current) {
        void window.tinySA.stopStreaming().catch((value) => {
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
    if (!selectedClassificationId || !detections.some((item) => item.id === selectedClassificationId)) setSelectedClassificationId(detections[0]?.id);
  }, [detections, selectedClassificationId]);
  useEffect(() => saveStored('envelope-stft', stftConfiguration), [stftConfiguration]);
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
  useEffect(() => {
    const identity = snapshot.identity;
    if (snapshot.connection !== 'ready' || identity?.execution !== 'physical' || !identity.usbIdentityVerified) return;
    const key = `${identity.port.id}:${identity.firmwareVersion}`;
    if (firmwareRevisionChecked.current === key) return;
    firmwareRevisionChecked.current = key;
    void inspectAndAutoDownloadFirmwareUpdate();
  }, [snapshot.connection, snapshot.identity?.firmwareVersion, snapshot.identity?.port.id]);
  useEffect(() => {
    if (firmwareUpdate?.phase !== 'awaiting-dfu') return;
    const poll = window.setInterval(() => {
      if (firmwareDfuPollBusy.current) return;
      firmwareDfuPollBusy.current = true;
      void window.tinySA.getFirmwareUpdateState()
        .then(async (state) => {
          setFirmwareUpdate(state);
          if (!state.dfuUtility.available) return;
          setFirmwareUpdate(await window.tinySA.detectDfuDevice());
        })
        .catch(async (value) => refreshFirmwareStateAfterFailure(`Automatic DFU detection failed: ${errorMessage(value)}`))
        .finally(() => { firmwareDfuPollBusy.current = false; });
    }, 1_500);
    return () => window.clearInterval(poll);
  }, [firmwareUpdate?.phase]);

  async function initialize(): Promise<void> {
    try {
      const [nextPorts, currentSnapshot] = await Promise.all([window.tinySA.listDevices(), window.tinySA.getSnapshot()]);
      setPorts(nextPorts);
      setSelectedPortId((current) => current && nextPorts.some((port) => port.id === current) ? current : nextPorts[0]?.id);
      acceptSnapshot(currentSnapshot);
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function inspectAndAutoDownloadFirmwareUpdate(): Promise<void> {
    try {
      let state = await window.tinySA.getFirmwareUpdateState();
      setFirmwareUpdate(state);
      if (!state.updateAvailable) return;
      setFirmwareUpdateOpen(true);
      if (state.phase === 'available') {
        setFirmwareUpdateBusy(true);
        state = await window.tinySA.downloadFirmwareUpdate();
        setFirmwareUpdate(state);
      }
    } catch (value) {
      await refreshFirmwareStateAfterFailure(`Firmware update inspection failed: ${errorMessage(value)}`);
    } finally { setFirmwareUpdateBusy(false); }
  }

  async function openFirmwareUpdate(): Promise<void> {
    setFirmwareUpdateOpen(true);
    try { setFirmwareUpdate(await window.tinySA.getFirmwareUpdateState()); }
    catch (value) { setError(`Firmware update status failed: ${errorMessage(value)}`); }
  }

  async function downloadFirmwareUpdate(): Promise<void> {
    setFirmwareUpdateBusy(true);
    try { setFirmwareUpdate(await window.tinySA.downloadFirmwareUpdate()); }
    catch (value) { await refreshFirmwareStateAfterFailure(errorMessage(value)); }
    finally { setFirmwareUpdateBusy(false); }
  }

  async function prepareFirmwareUpdate(): Promise<void> {
    if (firmwarePreflight.selfTestPassed !== true || firmwarePreflight.selfTestProcedure !== OEM_ZS407_SELF_TEST_PROCEDURE.id || firmwarePreflight.rfPortsDisconnected !== true || !firmwarePreflight.configurationDisposition) throw new Error('Firmware preflight attestations are incomplete or do not identify the ZS407 CAL-to-RF procedure');
    setFirmwareUpdateBusy(true);
    try {
      setFirmwareUpdate(await window.tinySA.prepareFirmwareUpdate(firmwarePreflight as FirmwareUpdatePreflight));
      acceptSnapshot(await window.tinySA.getSnapshot());
    } catch (value) { await refreshFirmwareStateAfterFailure(errorMessage(value)); }
    finally { setFirmwareUpdateBusy(false); }
  }

  async function detectDfuDevice(): Promise<void> {
    setFirmwareUpdateBusy(true);
    try { setFirmwareUpdate(await window.tinySA.detectDfuDevice()); }
    catch (value) { await refreshFirmwareStateAfterFailure(errorMessage(value)); }
    finally { setFirmwareUpdateBusy(false); }
  }

  async function refreshFirmwareStateAfterFailure(operationError: string): Promise<void> {
    try {
      setFirmwareUpdate(await window.tinySA.getFirmwareUpdateState());
      setError(operationError);
    } catch (refreshFailure) {
      setError(`${operationError}. Firmware state refresh also failed: ${errorMessage(refreshFailure)}`);
    }
  }

  async function flashFirmwareUpdate(): Promise<void> {
    const preparationId = firmwareUpdate?.preparation?.id;
    if (!preparationId) throw new Error('Firmware flash has no preparation record');
    setFirmwareUpdateBusy(true);
    let pollingActive = true;
    let pollInFlight = false;
    let pollFailureReported = false;
    const refreshProgress = async () => {
      if (!pollingActive || pollInFlight) return;
      pollInFlight = true;
      try {
        const state = await window.tinySA.getFirmwareUpdateState();
        if (pollingActive) setFirmwareUpdate(state);
      } catch (value) {
        if (pollingActive && !pollFailureReported) {
          pollFailureReported = true;
          setError(`Firmware progress channel failed. Do not disconnect the unit: ${errorMessage(value)}`);
        }
      } finally { pollInFlight = false; }
    };
    const poll = window.setInterval(() => void refreshProgress(), 200);
    void refreshProgress();
    try {
      const operation = window.tinySA.flashFirmwareUpdate({ preparationId, confirmation: 'FLASH VERIFIED OEM FIRMWARE' });
      const completed = await operation;
      pollingActive = false;
      setFirmwareUpdate(completed);
      acceptSnapshot(await window.tinySA.getSnapshot());
    } catch (value) {
      pollingActive = false;
      await refreshFirmwareStateAfterFailure(errorMessage(value));
    } finally {
      pollingActive = false;
      window.clearInterval(poll);
      setFirmwareUpdateBusy(false);
    }
  }

  function prepareFirmwareUpdateFromUi(event: React.MouseEvent<HTMLButtonElement>): void {
    if (!event.nativeEvent.isTrusted) { setError('Firmware preflight requires a direct local human action'); return; }
    void prepareFirmwareUpdate();
  }

  function flashFirmwareUpdateFromUi(event: React.MouseEvent<HTMLButtonElement>): void {
    if (!event.nativeEvent.isTrusted) { setError('Firmware flashing requires a direct local human action'); return; }
    void flashFirmwareUpdate();
  }

  function handleDeviceEvent(event: DeviceEvent): void {
    if (event.type === 'snapshot') acceptSnapshot(event.snapshot);
    else if (event.type === 'screen') setScreenFrame(event.frame);
    else if (event.type === 'diagnostics') setDiagnostics(event.diagnostics);
    else if (event.type === 'sweep' && continuousRequested.current) {
      void recordSweep(event.sweep).catch((value) => {
        continuousRequested.current = false;
        setContinuous(false);
        setAcquisition('failed');
        setError(`Sweep analysis failed: ${errorMessage(value)}`);
      });
    }
    else if (event.type === 'error') {
      continuousRequested.current = false;
      setContinuous(false);
      setAcquisition('failed');
      setError(`${event.error.code}: ${event.error.message}`);
    }
  }

  async function refreshPorts(): Promise<void> {
    setError(undefined);
    try {
      const next = await window.tinySA.listDevices();
      setPorts(next);
      setSelectedPortId((current) => current && next.some((port) => port.id === current) ? current : next[0]?.id);
    } catch (value) { setError(errorMessage(value)); }
  }

  async function connectPort(port: PortCandidate): Promise<DeviceSnapshot> {
    setConnectionBusy(true);
    setError(undefined);
    invalidateAcquiredEvidence();
    try {
      const next = await window.tinySA.connect(port);
      acceptSnapshot(next);
      setConnectionOpen(false);
      setNotice(next.identity?.firmwareWarning ?? `${next.identity?.model ?? 'Instrument'} connected and identified`);
      return next;
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    } finally { setConnectionBusy(false); }
  }

  async function connect(): Promise<void> {
    const port = ports.find((candidate) => candidate.id === selectedPortId);
    if (!port) { setError('Select an available device before connecting'); return; }
    try { await connectPort(port); } catch { /* Presented in the connection dialog. */ }
  }

  async function disconnectDevice(): Promise<void> {
    const execution = snapshot.identity?.execution;
    continuousRequested.current = false;
    setContinuous(false);
    setConnectionBusy(true);
    setError(undefined);
    try {
      await window.tinySA.disconnect();
      const next = await window.tinySA.getSnapshot();
      acceptSnapshot(next);
      invalidateAcquiredEvidence();
      setAcquisition('idle');
      setDiagnostics(undefined);
      setScreenFrame(undefined);
      setNotice(execution === 'physical' ? 'Physical instrument disconnected; RF state is no longer inferred' : execution === 'firmware-digital-twin' ? 'Executable twin disconnected and its Renode process terminated' : 'Instrument backend disconnected');
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    } finally { setConnectionBusy(false); }
  }

  async function disconnect(): Promise<void> { try { await disconnectDevice(); } catch { /* Presented in the connection dialog. */ } }

  function requireConnected(): void {
    if (snapshotRef.current.connection !== 'ready') throw new Error('Connect and identify the TinySA Ultra+ before running this operation');
  }

  function acceptSnapshot(next: DeviceSnapshot): void {
    snapshotRef.current = next;
    setSnapshot(next);
  }

  async function configureAnalyzer(config: AnalyzerConfig, operation: 'configuring' | 'retuning' = 'configuring'): Promise<DeviceSnapshot> {
    requireConnected();
    const validated = analyzerConfigSchema.parse(config);
    setError(undefined);
    setAcquisition(operation);
    const next = await window.tinySA.configureAnalyzer(validated);
    acceptSnapshot(next);
    return next;
  }

  function stageAnalyzerPatch(input: AnalyzerConfigPatch): { configuration: AnalyzerConfig; changed: boolean } {
    const patch = analyzerConfigPatchSchema.parse(input);
    const previous = analyzerRef.current;
    const next = analyzerConfigSchema.parse({ ...previous, ...patch });
    if (sameAnalyzerConfiguration(previous, next)) return { configuration: previous, changed: false };
    analyzerRef.current = next;
    analyzerRevision.current++;
    setAnalyzer(next);
    setChannelConfiguration((current) => fitChannelConfigurationToSpan(current, next.startHz, next.stopHz));
    invalidateAcquiredEvidence();
    return { configuration: next, changed: true };
  }

  function invalidateAcquiredEvidence(): void {
    analysisSequence.current++;
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
    zeroCaptureRef.current = undefined;
    setZeroCapture(undefined);
    setEnvelope(undefined);
  }

  function synchronizeContinuousAnalyzer(): Promise<void> {
    const active = analyzerRetuneTask.current;
    if (active) return active;
    if (!continuousRequested.current) return Promise.resolve();
    const task = retuneContinuousToLatest();
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
      await window.tinySA.stopStreaming();
      continuousRequested.current = false;
      setContinuous(false);
      while (true) {
        const targetRevision = analyzerRevision.current;
        await configureAnalyzer(analyzerRef.current, 'retuning');
        if (targetRevision !== analyzerRevision.current) continue;
        continuousRequested.current = true;
        setContinuous(true);
        await window.tinySA.startStreaming();
        if (targetRevision === analyzerRevision.current) break;
        await window.tinySA.stopStreaming();
        continuousRequested.current = false;
        setContinuous(false);
      }
      setAcquisition('streaming');
      setNotice('Continuous acquisition retuned');
    } catch (value) {
      continuousRequested.current = false;
      setContinuous(false);
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

  async function recordSweep(next: Sweep): Promise<boolean> {
    if (!sameAnalyzerConfiguration(next.requested, analyzerRef.current)) {
      console.warn('[Analyzer] rejected stale sweep for a superseded staged configuration', { sweepId: next.id, requested: next.requested, staged: analyzerRef.current });
      return false;
    }
    const sequence = ++analysisSequence.current;
    const nextHistory = [next, ...historyRef.current].slice(0, HISTORY_LIMIT);
    historyRef.current = nextHistory;
    setSweep(next);
    setHistory(nextHistory);
    setTraceFrames(traceAccumulator.current.update(next));
    setFirmwareTraceFrames(next.firmwareTraces ?? []);
    const candidates = detector.current.analyze(next);
    const tracked = tracker.current.update(next, candidates);
    detectionsRef.current = tracked;
    setDetections(tracked);
    const currentSignals = classificationRepresentatives(
      tracked.filter((item) => item.state === 'active'),
      zeroCaptureRef.current?.targetDetectionId,
    );
    const results = await Promise.all(currentSignals.map((item) => classifier.current.classify(item, { sweeps: nextHistory, zeroSpan: zeroCaptureRef.current })));
    if (sequence === analysisSequence.current) setClassifications(results);
    return true;
  }

  async function acquire(): Promise<Sweep> {
    try {
      await configureAnalyzer(analyzerRef.current);
      setAcquisition('acquiring');
      const next = await window.tinySA.acquireSweep();
      if (!await recordSweep(next)) throw new Error(`Sweep ${next.id} was acquired for a superseded analyzer configuration`);
      setAcquisition('complete');
      return next;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function acquireFromUi(): Promise<void> { try { await acquire(); } catch { /* Visible in the workspace alert. */ } }

  async function startContinuous(): Promise<void> {
    if (continuousRequested.current) throw new Error('Continuous acquisition is already running');
    try {
      await configureAnalyzer(analyzerRef.current);
      continuousRequested.current = true;
      setContinuous(true);
      setAcquisition('streaming');
      await window.tinySA.startStreaming();
    } catch (value) {
      continuousRequested.current = false;
      setContinuous(false);
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function stopContinuous(): Promise<void> {
    if (!continuousRequested.current) throw new Error('Continuous acquisition is not running');
    await window.tinySA.stopStreaming();
    continuousRequested.current = false;
    setContinuous(false);
    setAcquisition('complete');
  }

  async function startContinuousFromUi(): Promise<void> { try { await startContinuous(); } catch { /* Visible in the workspace alert. */ } }
  async function stopContinuousFromUi(): Promise<void> { try { await stopContinuous(); } catch (value) { setError(errorMessage(value)); } }

  async function acquireZeroSpan(): Promise<ZeroSpanCapture> {
    requireConnected();
    const validated = zeroSpanConfigSchema.parse(zeroConfig);
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const acquired = await window.tinySA.acquireZeroSpan(validated);
      const capture: ZeroSpanCapture = selectedClassificationId
        ? { ...acquired, targetDetectionId: selectedClassificationId }
        : acquired;
      zeroCaptureRef.current = capture;
      setZeroCapture(capture);
      setEnvelope(classifyZeroSpanEnvelope(capture));
      try {
        const restored = await window.tinySA.configureAnalyzer(analyzerRef.current);
        acceptSnapshot(restored);
      } catch (value) {
        throw new Error(`Zero-span capture ${capture.id} completed, but restoring the staged swept-analyzer configuration failed: ${errorMessage(value)}`);
      }
      const sequence = ++analysisSequence.current;
      const active = classificationRepresentatives(
        detectionsRef.current.filter((item) => item.state === 'active'),
        capture.targetDetectionId,
      );
      const results = await Promise.all(active.map((item) => classifier.current.classify(item, { sweeps: historyRef.current, zeroSpan: capture })));
      if (sequence === analysisSequence.current) setClassifications(results);
      setAcquisition('complete');
      return capture;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function acquireZeroSpanFromUi(): Promise<void> { try { await acquireZeroSpan(); } catch { /* Visible in the workspace alert. */ } }

  async function configureGeneratorWith(config: GeneratorConfig): Promise<DeviceSnapshot> {
    requireConnected();
    const validated = generatorConfigSchema.parse(config);
    setError(undefined);
    setAcquisition('configuring');
    try {
      const next = await window.tinySA.configureGenerator(validated);
      acceptSnapshot(next);
      setAcquisition('complete');
      return next;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function configureGeneratorFromUi(): Promise<void> { try { await configureGeneratorWith(generator); } catch { /* Visible in the workspace alert. */ } }

  async function setOutput(enabled: boolean): Promise<DeviceSnapshot> {
    requireConnected();
    setError(undefined);
    setAcquisition('configuring');
    try {
      if (snapshotRef.current.mode !== 'generator') acceptSnapshot(await window.tinySA.configureGenerator(generatorConfigSchema.parse(generator)));
      const next = await window.tinySA.setGeneratorOutput(enabled);
      acceptSnapshot(next);
      setAcquisition('complete');
      return next;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function setOutputFromUi(enabled: boolean): Promise<void> { try { await setOutput(enabled); } catch { /* Visible in the workspace alert. */ } }

  async function refreshDiagnostics(): Promise<DeviceDiagnostics> {
    requireConnected();
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const next = await window.tinySA.readDiagnostics();
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

  async function captureScreen(): Promise<ScreenFrame> {
    requireConnected();
    assertWorkspaceTransition(workspace, 'device', snapshotRef.current.generatorOutput);
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const frame = await window.tinySA.captureScreen();
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
  function queueRemoteGesture(gesture: 'press' | 'release', point?: ScreenPoint): Promise<void> {
    const task = remoteGestureQueue.current.then(() => performRemoteGesture(gesture, point));
    remoteGestureQueue.current = task.catch(() => undefined);
    return task;
  }

  async function performRemoteGesture(gesture: 'press' | 'release', point?: ScreenPoint): Promise<void> {
    requireConnected();
    try {
      if (gesture === 'press') {
        if (!point) throw new Error('Remote touch press requires a screen coordinate');
        if (continuousRequested.current) {
          setAcquisition('retuning');
          setNotice('Pausing continuous acquisition for remote screen gesture…');
          await window.tinySA.stopStreaming();
          continuousRequested.current = false;
          remoteGesturePausedContinuous.current = true;
          setContinuous(false);
        }
        await window.tinySA.touch(point);
        return;
      }
      await window.tinySA.releaseTouch(point);
      if (remoteGesturePausedContinuous.current) {
        await configureAnalyzer(analyzerRef.current, 'retuning');
        await window.tinySA.startStreaming();
        remoteGesturePausedContinuous.current = false;
        continuousRequested.current = true;
        setContinuous(true);
        setAcquisition('streaming');
        setNotice('Continuous acquisition resumed after remote screen gesture');
      }
    } catch (value) {
      setAcquisition('failed');
      setError(`Remote screen ${gesture} failed: ${errorMessage(value)}`);
      throw value;
    }
  }

  async function touchScreen(point: ScreenPoint): Promise<void> { try { await queueRemoteGesture('press', point); } catch { /* Visible in the workspace alert. */ } }
  async function releaseScreen(point?: ScreenPoint): Promise<void> { try { await queueRemoteGesture('release', point); } catch { /* Visible in the workspace alert. */ } }

  async function exportLatest(format: 'csv' | 'json'): Promise<unknown> {
    if (!sweep) throw new Error('Acquire a complete spectrum sweep before exporting');
    setError(undefined);
    try {
      const result = await window.tinySA.exportSweep({ sweep, format });
      if (result.status === 'saved') setNotice(`Saved ${result.bytesWritten.toLocaleString()} bytes to ${result.path}`);
      return result;
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    }
  }

  function applyWorkspace(next: WorkspaceId): void {
    assertWorkspaceTransition(workspace, next, snapshotRef.current.generatorOutput);
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
    return {
      atomizer: { owner: 'tinysa-atomizer', contractVersion: 3 },
      instrument: snapshot.identity ? { execution: snapshot.identity.execution, transport: snapshot.identity.port.transport, usbIdentityVerified: snapshot.identity.usbIdentityVerified } : null,
      firmwareTwin: { owner: 'tinysa-firmware', available: ports.some((port) => port.execution === 'firmware-digital-twin'), connected: snapshot.identity?.execution === 'firmware-digital-twin', integration: 'renode-monitor-v1', usbTransactionsModeled: false },
      signalLab: { owner: 'tinysa-signal-lab', integration: 'reserved-not-connected' },
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
      snapshot,
      analyzer,
      generator,
      detectionConfig,
      zeroSpanConfig: zeroConfig,
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
      firmwareUpdate: firmwareUpdate ?? null,
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
        connection: snapshot.connection,
        analyzer,
        generator,
        detection: detectionConfig,
        zeroSpan: zeroConfig,
        measurement: JSON.parse(applicationContext()).measurement,
        latestSweep: JSON.parse(applicationContext()).latestSweep,
        firmwareUpdate: firmwareUpdate ?? null,
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
      case 'get_instrument_state': return snapshot;
      case 'get_latest_sweep_summary': return JSON.parse(applicationContext()).latestSweep;
      case 'get_detection_results': return agentDetectionResults(detections);
      case 'get_classification_results': return { spectral: classifications, zeroSpan: zeroCapture ? { captureId: zeroCapture.id, envelope: envelope ?? null } : null };
      case 'read_device_diagnostics': return refreshDiagnostics();
      case 'get_firmware_update_status': { const state = await window.tinySA.getFirmwareUpdateState(); setFirmwareUpdate(state); return state; }
      case 'open_firmware_update': { const state = await window.tinySA.getFirmwareUpdateState(); setFirmwareUpdate(state); setFirmwareUpdateOpen(true); return { opened: true, state }; }
      case 'download_firmware_update': { const state = await window.tinySA.downloadFirmwareUpdate(); setFirmwareUpdate(state); setFirmwareUpdateOpen(true); return state; }
      case 'detect_firmware_dfu': { const state = await window.tinySA.detectDfuDevice(); setFirmwareUpdate(state); setFirmwareUpdateOpen(true); return state; }
      case 'list_connection_candidates': {
        const currentPorts = (await window.tinySA.listDevices()).map((port) => portCandidateSchema.parse(port));
        setPorts(currentPorts);
        setSelectedPortId((current) => current && currentPorts.some((port) => port.id === current) ? current : currentPorts[0]?.id);
        const candidates = currentPorts.map((port, index) => ({ candidateId: `candidate-${index + 1}`, manufacturer: port.manufacturer ?? null, product: port.product ?? null, usbMatch: port.usbMatch, execution: port.execution, transport: port.transport, simulated: port.execution !== 'physical', selected: port.id === selectedPortId }));
        agentConnectionCandidates.current = new Map(candidates.map((candidate, index) => [candidate.candidateId, currentPorts[index]!]));
        return candidates;
      }
      case 'connect_device': {
        const candidateId = (args as { candidateId: string }).candidateId;
        const issued = agentConnectionCandidates.current.get(candidateId);
        agentConnectionCandidates.current.clear();
        if (!issued) throw new Error(`Connection candidate ${candidateId} was not issued by the latest list_connection_candidates result`);
        const currentPorts = (await window.tinySA.listDevices()).map((port) => portCandidateSchema.parse(port));
        setPorts(currentPorts);
        const port = currentPorts.find((candidate) => candidate.id === issued.id);
        if (!port) throw new Error(`Connection candidate ${candidateId} is no longer available; list candidates again`);
        if (JSON.stringify(port) !== JSON.stringify(issued)) throw new Error(`Connection candidate ${candidateId} changed after it was listed; list candidates again`);
        setSelectedPortId(port.id);
        const next = await connectPort(port);
        if (!next.identity) throw new Error('Connected device did not provide an identity');
        return { connected: true, model: next.identity.model, hardwareVersion: next.identity.hardwareVersion, firmwareVersion: next.identity.firmwareVersion, firmwareQualification: next.identity.firmwareQualification, firmwareWarning: next.identity.firmwareWarning ?? null, simulated: next.identity.simulated, verification: next.verification };
      }
      case 'disconnect_device': await disconnectDevice(); return { disconnected: true, state: (await window.tinySA.getSnapshot()).connection };
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
        assertWorkspaceTransition(workspace, 'spectrum', snapshotRef.current.generatorOutput);
        const patch = analyzerConfigPatchSchema.parse(args);
        const next = await updateAnalyzer(patch);
        applyWorkspace('spectrum');
        return { patch, configuration: next, continuous: continuousRequested.current };
      }
      case 'acquire_sweep': { assertWorkspaceTransition(workspace, 'spectrum', snapshotRef.current.generatorOutput); const result = await acquire(); applyWorkspace('spectrum'); return { acquired: true, sweepId: result.id, sequence: result.sequence, points: result.frequencyHz.length, source: result.source }; }
      case 'start_continuous_sweeps': assertWorkspaceTransition(workspace, 'spectrum', snapshotRef.current.generatorOutput); await startContinuous(); applyWorkspace('spectrum'); return { streaming: true };
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
        assertWorkspaceTransition(workspace, 'spectrum', snapshotRef.current.generatorOutput);
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
        setSelectedClassificationId(detectionId);
        return { detectionId, selected: true, evidence: 'ui-only' };
      }
      case 'configure_zero_span': { const next = zeroSpanConfigSchema.parse(args); applyWorkspace('classification'); setZeroConfig(next); return next; }
      case 'acquire_zero_span': { assertWorkspaceTransition(workspace, 'classification', snapshotRef.current.generatorOutput); const result = await acquireZeroSpan(); applyWorkspace('classification'); return { acquired: true, captureId: result.id, samples: result.powerDbm.length, envelope: classifyZeroSpanEnvelope(result) }; }
      case 'configure_generator': { const next = generatorConfigSchema.parse(args); setGenerator(next); const configured = await configureGeneratorWith(next); applyWorkspace('generator'); return configured.generator; }
      case 'set_rf_output': { const enabled = (args as { enabled: boolean }).enabled; const next = await setOutput(enabled); return { enabled, verification: next.verification, execution: next.identity?.execution ?? 'unknown' }; }
      case 'capture_device_screen': { const frame = await captureScreen(); return { captured: true, width: frame.width, height: frame.height, format: frame.format, capturedAt: frame.capturedAt }; }
      case 'remote_device_touch': {
        const value = args as ScreenPoint & { gesture: 'tap' | 'press' | 'release' };
        const point = { x: value.x, y: value.y };
        if (value.gesture === 'tap') { await queueRemoteGesture('press', point); await queueRemoteGesture('release', point); }
        else if (value.gesture === 'press') await queueRemoteGesture('press', point);
        else await queueRemoteGesture('release', point);
        return { completed: value.gesture, point };
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
    <TopBar snapshot={snapshot} simulated={simulated} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)} firmwareUpdateAvailable={Boolean(firmwareUpdate?.updateAvailable)} onConnection={() => setConnectionOpen(true)} onFirmwareUpdate={() => void openFirmwareUpdate()} onAgent={() => setAgentOpen((value) => !value)}/>
    <Sidebar active={workspace} output={snapshot.generatorOutput} onSelect={changeWorkspace}/>
    <section className={`workspace-shell ${workspace === 'spectrum' ? 'spectrum-workspace' : ''} ${workspace === 'classification' ? 'classification-workspace' : ''}`}>
      {workspace !== 'spectrum' && acquisitionActions && <div className="workspace-command-row">{acquisitionActions}</div>}
      {error && <div className="global-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button data-agent-control="error.dismiss" onClick={() => setError(undefined)}>Dismiss</button></div>}
      {notice && <div className="global-notice" role="status"><span>{notice}</span><button data-agent-control="notice.dismiss" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
      {workspace === 'spectrum' && <MeasurementWorkspace
        acquisitionActions={acquisitionActions}
        view={measurementView} onView={changeMeasurementView}
        analyzer={analyzer} busy={busy} connected={connected} streaming={continuous} onAnalyzer={(configuration) => void updateAnalyzerFromUi(configuration)}
        sweep={sweep} history={history} detections={detections} acquisition={acquisition}
        traces={traceConfiguration} frames={traceFrames} firmwareFrames={firmwareTraceFrames} visibleFirmwareTraceIds={visibleFirmwareTraceIds} onFirmwareTraceVisibility={configureFirmwareTraceVisibility} activeTraceId={activeTraceId} onActiveTrace={setActiveTraceId} markers={markers} readings={markerReadings}
        activeMarkerId={activeMarkerId} markerSearch={markerSearchConfiguration} display={displayConfiguration}
        onTrace={configureTrace} onTraceReset={resetTrace} onMarker={configureMarker} onActiveMarker={setActiveMarkerId}
        onSearch={runMarkerSearch} onSearchConfiguration={configureMarkerSearch} onDisplay={configureDisplay}
        onAutoScale={autoScaleDisplay} onMarkerPlace={placeActiveMarker}
        waterfall={waterfallConfiguration} onWaterfall={configureWaterfall}
        channel={channelConfiguration} onChannel={configureChannelMeasurement}
        zeroConfig={zeroConfig} zeroCapture={zeroCapture} stft={stftConfiguration}
        onZeroConfig={setZeroConfig} onStft={configureEnvelopeStft} onAcquireZero={() => void acquireZeroSpanFromUi()}
      />}
      {workspace === 'detection' && <DetectionWorkspace sweep={sweep} detections={detections} busy={busy} config={detectionConfig} onConfig={setDetectionConfig}/>}
      {workspace === 'classification' && <ClassificationWorkspace sweep={sweep} detections={detections} classifications={classifications} selectedId={selectedClassificationId} onSelectedId={setSelectedClassificationId} zeroConfig={zeroConfig} zeroCapture={zeroCapture} envelope={envelope} busy={!connected || busy} onZeroConfig={setZeroConfig} onAcquireZero={() => void acquireZeroSpanFromUi()}/>}
      {workspace === 'generator' && <GeneratorWorkspace config={generator} snapshot={snapshot} busy={busy} onChange={setGenerator} onApply={() => void configureGeneratorFromUi()} onOutput={(enabled) => void setOutputFromUi(enabled)}/>}
      {workspace === 'device' && <DeviceWorkspace snapshot={snapshot} diagnostics={diagnostics} frame={screenFrame} busy={busy} onRefresh={() => void refreshDiagnosticsFromUi()} onCapture={() => void captureScreenFromUi()} onTouch={(point) => void touchScreen(point)} onRelease={(point) => void releaseScreen(point)}/>}
    </section>
    <AtomAgentPanel open={agentOpen} state={agent.state} status={agent.status} messages={agent.messages} approval={agent.approval} execution={snapshot.identity?.execution} microphoneMuted={agent.microphoneMuted} speakerMuted={agent.speakerMuted} usage={agent.usage} rateLimits={agent.rateLimits} onClose={() => setAgentOpen(false)} onSend={agent.sendText} onVoice={agent.startVoice} onMicrophoneMute={agent.setMicrophoneMute} onSpeakerMute={agent.setSpeakerMute} onApproval={agent.resolveApproval}/>
    {connectionOpen && <ConnectionDialog
      ports={ports}
      selectedId={selectedPortId}
      busy={connectionBusy}
      error={error}
      connected={connected}
      onSelect={setSelectedPortId}
      onRefresh={() => void refreshPorts()}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      onClose={() => setConnectionOpen(false)}
    />}
    {firmwareUpdateOpen && firmwareUpdate && <FirmwareUpdateDialog state={firmwareUpdate} busy={firmwareUpdateBusy} preflight={firmwarePreflight} onPreflight={setFirmwarePreflight} onDownload={() => void downloadFirmwareUpdate()} onPrepare={prepareFirmwareUpdateFromUi} onDetect={() => void detectDfuDevice()} onFlash={flashFirmwareUpdateFromUi} onClose={() => setFirmwareUpdateOpen(false)}/>}
  </main>;
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
