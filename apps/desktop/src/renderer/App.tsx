import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Download, LoaderCircle, Play, Repeat2, StopCircle } from 'lucide-react';
import {
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  generatorConfigSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  measurementViewIdSchema,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  traceConfigurationSchema,
  waterfallConfigurationSchema,
  zeroSpanConfigSchema,
  type AnalyzerConfig,
  type ChannelMeasurementConfiguration,
  type DeviceDiagnostics,
  type DeviceEvent,
  type DeviceSnapshot,
  type DetectedSignal,
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
} from '@tinysa/contracts';
import {
  SignalDetector,
  SignalTracker,
  SpectralMorphologyClassifier,
  TraceAccumulator,
  autoScaleSpectrum,
  calculateSweepMetrics,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  measureChannel,
  readMarkers,
  searchMarker,
  type EnvelopeClassification,
} from '@tinysa/analysis';
import type { AgentToolName } from '@tinysa/agent';
import { AtomAgentPanel } from './components/AtomAgentPanel.js';
import { ClassificationWorkspace } from './components/ClassificationWorkspace.js';
import { ConnectionDialog } from './components/ConnectionDialog.js';
import { DetectionWorkspace } from './components/DetectionWorkspace.js';
import { DeviceWorkspace } from './components/DeviceWorkspace.js';
import { GeneratorWorkspace } from './components/GeneratorWorkspace.js';
import { MeasurementWorkspace } from './components/MeasurementWorkspace.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { assertWorkspaceTransition, DEFAULT_ANALYZER, DEFAULT_GENERATOR, DISCONNECTED_SNAPSHOT, type AcquisitionState, type WorkspaceId } from './ui-contracts.js';
import { useAtomAgent } from './useAtomAgent.js';

const DEFAULT_DETECTION: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const DEFAULT_ZERO_SPAN: ZeroSpanConfig = {
  frequencyHz: 433_920_000,
  points: 290,
  rbwKhz: 100,
  attenuationDb: 'auto',
  sweepTimeSeconds: 0.1,
  trigger: { mode: 'auto' },
};
const HISTORY_LIMIT = 50;
const DEFAULT_TRACES: TraceBankConfiguration = traceBankConfigurationSchema.parse([
  { id: 1, mode: 'clear-write', averageCount: 8 },
  { id: 2, mode: 'blank', averageCount: 8 },
  { id: 3, mode: 'blank', averageCount: 8 },
  { id: 4, mode: 'blank', averageCount: 8 },
]);
const DEFAULT_MARKERS: readonly MarkerConfiguration[] = Array.from({ length: 8 }, (_, index) => markerConfigurationSchema.parse({
  id: index + 1,
  enabled: index === 0,
  traceId: 1,
  mode: 'normal',
  frequencyHz: 98_000_000,
  tracking: index === 0 ? 'peak' : 'fixed',
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
  const [detectionConfig, setDetectionConfig] = useState<SignalDetectionConfig>(() => loadStored('detector', signalDetectionConfigSchema.parse, DEFAULT_DETECTION));
  const [zeroConfig, setZeroConfig] = useState<ZeroSpanConfig>(() => loadStored('zero-span', zeroSpanConfigSchema.parse, DEFAULT_ZERO_SPAN));
  const [traceConfiguration, setTraceConfiguration] = useState<TraceBankConfiguration>(() => loadStored('traces', traceBankConfigurationSchema.parse, DEFAULT_TRACES));
  const [traceFrames, setTraceFrames] = useState<readonly TraceFrame[]>([]);
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
  const [zeroCapture, setZeroCapture] = useState<ZeroSpanCapture>();
  const [envelope, setEnvelope] = useState<EnvelopeClassification>();
  const [diagnostics, setDiagnostics] = useState<DeviceDiagnostics>();
  const [screenFrame, setScreenFrame] = useState<ScreenFrame>();
  const [acquisition, setAcquisition] = useState<AcquisitionState>('idle');
  const [continuous, setContinuous] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const detector = useRef(new SignalDetector(detectionConfig));
  const tracker = useRef(new SignalTracker(detectionConfig));
  const classifier = useRef(new SpectralMorphologyClassifier());
  const traceAccumulator = useRef(new TraceAccumulator(traceConfiguration));
  const snapshotRef = useRef<DeviceSnapshot>(DISCONNECTED_SNAPSHOT);
  const analyzerRef = useRef<AnalyzerConfig>(analyzer);
  const continuousRequested = useRef(false);
  const analysisSequence = useRef(0);

  const connected = snapshot.connection === 'ready';
  const operationBusy = acquisition === 'configuring' || acquisition === 'acquiring' || acquisition === 'streaming';
  const busy = connectionBusy || operationBusy;
  const simulated = snapshot.identity?.simulated ?? ports.some((port) => port.path.startsWith('fake://'));
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
  useEffect(() => { analyzerRef.current = analyzer; saveStored('analyzer', analyzer); }, [analyzer]);
  useEffect(() => saveStored('generator', generator), [generator]);
  useEffect(() => saveStored('detector', detectionConfig), [detectionConfig]);
  useEffect(() => saveStored('zero-span', zeroConfig), [zeroConfig]);
  useEffect(() => {
    traceAccumulator.current.configure(traceConfiguration);
    setTraceFrames(traceAccumulator.current.frames());
    saveStored('traces', traceConfiguration);
  }, [traceConfiguration]);
  useEffect(() => saveStored('markers', markers), [markers]);
  useEffect(() => saveStored('marker-search', markerSearchConfiguration), [markerSearchConfiguration]);
  useEffect(() => saveStored('spectrum-display', displayConfiguration), [displayConfiguration]);
  useEffect(() => saveStored('measurement-view', measurementView), [measurementView]);
  useEffect(() => saveStored('waterfall', waterfallConfiguration), [waterfallConfiguration]);
  useEffect(() => saveStored('channel-measurement', channelConfiguration), [channelConfiguration]);
  useEffect(() => saveStored('envelope-stft', stftConfiguration), [stftConfiguration]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    detector.current.configure(detectionConfig);
    tracker.current.configure(detectionConfig);
    setDetections([]);
    setClassifications([]);
  }, [detectionConfig]);

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
    try {
      const next = await window.tinySA.connect(port);
      acceptSnapshot(next);
      setConnectionOpen(false);
      setNotice(`${next.identity?.model ?? 'Instrument'} connected and identified`);
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
    continuousRequested.current = false;
    setContinuous(false);
    setConnectionBusy(true);
    setError(undefined);
    try {
      await window.tinySA.disconnect();
      const next = await window.tinySA.getSnapshot();
      acceptSnapshot(next);
      setAcquisition('idle');
      setDiagnostics(undefined);
      setScreenFrame(undefined);
      setNotice('Instrument disconnected; physical RF state is no longer inferred');
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

  async function configureAnalyzer(config: AnalyzerConfig): Promise<DeviceSnapshot> {
    requireConnected();
    const validated = analyzerConfigSchema.parse(config);
    setError(undefined);
    setAcquisition('configuring');
    const next = await window.tinySA.configureAnalyzer(validated);
    acceptSnapshot(next);
    return next;
  }

  async function recordSweep(next: Sweep): Promise<void> {
    const sequence = ++analysisSequence.current;
    setSweep(next);
    setHistory((current) => [next, ...current].slice(0, HISTORY_LIMIT));
    setTraceFrames(traceAccumulator.current.update(next));
    const candidates = detector.current.analyze(next);
    const tracked = tracker.current.update(next, candidates);
    setDetections(tracked);
    const currentSignals = tracked.filter((item) => item.state !== 'released' && item.sweepIds.includes(next.id));
    const results = await Promise.all(currentSignals.map((item) => classifier.current.classify(item, next)));
    if (sequence === analysisSequence.current) setClassifications(results);
  }

  async function acquire(): Promise<Sweep> {
    try {
      await configureAnalyzer(analyzerRef.current);
      setAcquisition('acquiring');
      const next = await window.tinySA.acquireSweep();
      await recordSweep(next);
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
      const capture = await window.tinySA.acquireZeroSpan(validated);
      setZeroCapture(capture);
      setEnvelope(classifyZeroSpanEnvelope(capture));
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
    setError(undefined);
    setAcquisition('acquiring');
    try {
      const frame = await window.tinySA.captureScreen();
      setScreenFrame(frame);
      setWorkspace('device');
      setAcquisition('complete');
      return frame;
    } catch (value) {
      setAcquisition('failed');
      setError(errorMessage(value));
      throw value;
    }
  }

  async function captureScreenFromUi(): Promise<void> { try { await captureScreen(); } catch { /* Visible in the workspace alert. */ } }
  async function touchScreen(point: ScreenPoint): Promise<void> { try { await window.tinySA.touch(point); } catch (value) { setError(errorMessage(value)); } }
  async function releaseScreen(point?: ScreenPoint): Promise<void> { try { await window.tinySA.releaseTouch(point); } catch (value) { setError(errorMessage(value)); } }

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

  function changeWorkspace(next: WorkspaceId): void {
    try {
      assertWorkspaceTransition(workspace, next, snapshot.generatorOutput);
      setWorkspace(next);
      setError(undefined);
    } catch (value) { setError(errorMessage(value)); }
  }

  function configureTrace(input: TraceConfiguration): void {
    try {
      const trace = traceConfigurationSchema.parse(input);
      setTraceConfiguration((current) => traceBankConfigurationSchema.parse(current.map((item) => item.id === trace.id ? trace : item)));
      setError(undefined);
    } catch (value) { setError(`Trace configuration failed: ${errorMessage(value)}`); }
  }

  function resetTrace(traceId: TraceId): void {
    try {
      traceAccumulator.current.reset(traceId);
      setTraceFrames(traceAccumulator.current.frames());
      setNotice(`Trace ${traceId} memory cleared`);
    } catch (value) { setError(`Trace reset failed: ${errorMessage(value)}`); }
  }

  function configureMarker(input: MarkerConfiguration): void {
    try {
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
    } catch (value) { setError(`Marker configuration failed: ${errorMessage(value)}`); }
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
      configureMarker({ ...marker, enabled: true, tracking: action === 'peak' ? 'peak' : 'fixed', frequencyHz });
      setNotice(`M${marker.id} moved by ${action.replace('-', ' ')} search`);
    } catch (value) { setError(`Marker search failed: ${errorMessage(value)}`); }
  }

  function configureMarkerSearch(input: MarkerSearchConfiguration): void {
    try { setMarkerSearchConfiguration(markerSearchConfigurationSchema.parse(input)); setError(undefined); }
    catch (value) { setError(`Marker search criteria failed: ${errorMessage(value)}`); }
  }

  function configureDisplay(input: SpectrumDisplayConfiguration): void {
    try { setDisplayConfiguration(spectrumDisplayConfigurationSchema.parse(input)); setError(undefined); }
    catch (value) { setError(`Display configuration failed: ${errorMessage(value)}`); }
  }

  function changeMeasurementView(input: MeasurementViewId): void {
    try {
      const next = measurementViewIdSchema.parse(input);
      setMeasurementView(next);
      setWorkspace('spectrum');
      setError(undefined);
    } catch (value) { setError(`Measurement view failed: ${errorMessage(value)}`); }
  }

  function configureWaterfall(input: WaterfallConfiguration): void {
    try { setWaterfallConfiguration(waterfallConfigurationSchema.parse(input)); setError(undefined); }
    catch (value) { setError(`Waterfall configuration failed: ${errorMessage(value)}`); }
  }

  function configureChannelMeasurement(input: ChannelMeasurementConfiguration): void {
    try { setChannelConfiguration(channelMeasurementConfigurationSchema.parse(input)); setError(undefined); }
    catch (value) { setError(`Channel measurement configuration failed: ${errorMessage(value)}`); }
  }

  function configureEnvelopeStft(input: EnvelopeStftConfiguration): void {
    try { setStftConfiguration(envelopeStftConfigurationSchema.parse(input)); setError(undefined); }
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

  function applicationContext(): string {
    const channelMeasurement = evaluateAnalysis(() => requireChannelMeasurement());
    const envelopeStft = evaluateAnalysis(() => requireEnvelopeStft());
    return JSON.stringify({
      workspace,
      measurementView,
      acquisition,
      continuous,
      simulated,
      visibleError: error ?? null,
      snapshot,
      analyzer,
      generator,
      detectionConfig,
      zeroSpanConfig: zeroConfig,
      historyCount: history.length,
      latestSweep: sweep && metrics ? { id: sweep.id, sequence: sweep.sequence, capturedAt: sweep.capturedAt, rangeHz: [sweep.actualStartHz, sweep.actualStopHz], points: sweep.frequencyHz.length, source: sweep.source, elapsedMilliseconds: sweep.elapsedMilliseconds, metrics } : null,
      detections: detections.map(({ id, peakHz, peakDbm, bandwidthHz, state, persistenceSweeps, missedSweeps }) => ({ id, peakHz, peakDbm, bandwidthHz, state, persistenceSweeps, missedSweeps })),
      classifications: classifications.map(({ detectionId, label, confidence, modelId, unknownReason }) => ({ detectionId, label, confidence, modelId, unknownReason })),
      zeroSpan: zeroCapture && envelope ? { frequencyHz: zeroCapture.frequencyHz, samples: zeroCapture.powerDbm.length, samplePeriodSeconds: zeroCapture.samplePeriodSeconds, envelope } : null,
      measurement: {
        activeView: measurementView,
        traces: traceConfiguration.map((trace) => ({ ...trace, sweepCount: traceFrames.find((frame) => frame.traceId === trace.id)?.sweepCount ?? 0 })),
        markers: markerReadings,
        activeMarkerId,
        markerSearch: markerSearchConfiguration,
        display: displayConfiguration,
        waterfall: { configuration: waterfallConfiguration, coherentSweeps: history.length },
        channel: { configuration: channelConfiguration, analysis: channelMeasurement },
        envelopeStft: { configuration: stftConfiguration, analysis: envelopeStft },
        evidence: 'host-derived',
      },
    });
  }

  async function executeAgentTool(name: AgentToolName, args: unknown): Promise<unknown> {
    switch (name) {
      case 'get_application_state': return { workspace, measurementView, acquisition, continuous, simulated, error: error ?? null, historyCount: history.length };
      case 'get_instrument_state': return snapshot;
      case 'get_latest_sweep_summary': return JSON.parse(applicationContext()).latestSweep;
      case 'get_detection_results': return detections;
      case 'get_classification_results': return { spectral: classifications, zeroSpan: zeroCapture ? { captureId: zeroCapture.id, envelope: envelope ?? null } : null };
      case 'read_device_diagnostics': return refreshDiagnostics();
      case 'list_connection_candidates': return ports.map((port, index) => ({ candidateId: `candidate-${index + 1}`, manufacturer: port.manufacturer ?? null, product: port.product ?? null, usbMatch: port.usbMatch, simulated: port.path.startsWith('fake://'), selected: port.id === selectedPortId }));
      case 'connect_device': {
        const candidateId = (args as { candidateId: string }).candidateId;
        const match = /^candidate-([1-9][0-9]*)$/.exec(candidateId);
        if (!match) throw new Error('Invalid connection candidate ID');
        const port = ports[Number(match[1]) - 1];
        if (!port) throw new Error(`Connection candidate ${candidateId} is no longer available`);
        setSelectedPortId(port.id);
        const next = await connectPort(port);
        if (!next.identity) throw new Error('Connected device did not provide an identity');
        return { connected: true, model: next.identity.model, hardwareVersion: next.identity.hardwareVersion, firmwareVersion: next.identity.firmwareVersion, simulated: next.identity.simulated, verification: next.verification };
      }
      case 'disconnect_device': await disconnectDevice(); return { disconnected: true, state: (await window.tinySA.getSnapshot()).connection };
      case 'inspect_interface': return { activeWorkspace: workspace, activeMeasurementView: measurementView, controls: { 'workspace.spectrum': true, 'workspace.detection': true, 'workspace.classification': true, 'workspace.generator': snapshot.generatorOutput !== 'on' || workspace === 'generator', 'workspace.device': true, 'acquisition.single': connected && !busy, 'acquisition.continuous.start': connected && !busy, 'acquisition.continuous.stop': continuous, 'measurement.view.spectrum': workspace === 'spectrum', 'measurement.view.waterfall': workspace === 'spectrum', 'measurement.view.channel': workspace === 'spectrum', 'measurement.view.envelope-stft': workspace === 'spectrum', 'measurement.markers': workspace === 'spectrum', 'measurement.traces': workspace === 'spectrum', 'measurement.display': workspace === 'spectrum', 'connection.open': !connectionBusy, 'device.capture-screen': connected && !busy, 'atom.close': agentOpen } };
      case 'computer_action': {
        const control = (args as { controlId: string }).controlId;
        if (control.startsWith('workspace.')) changeWorkspace(control.slice('workspace.'.length) as WorkspaceId);
        else if (control.startsWith('measurement.view.')) changeMeasurementView(control.slice('measurement.view.'.length) as MeasurementViewId);
        else if (control === 'acquisition.single') await acquire();
        else if (control === 'acquisition.continuous.start') await startContinuous();
        else if (control === 'acquisition.continuous.stop') await stopContinuous();
        else if (control === 'connection.open') setConnectionOpen(true);
        else if (control === 'device.capture-screen') await captureScreen();
        else if (control === 'atom.close') setAgentOpen(false);
        else throw new Error(`Unknown semantic control ${control}`);
        return { activated: control };
      }
      case 'computer_screenshot': return window.atomAgent.computerScreenshot();
      case 'computer_click': return window.atomAgent.computerClick(args as { x: number; y: number });
      case 'computer_type': return window.atomAgent.computerType((args as { text: string }).text);
      case 'computer_key': return window.atomAgent.computerKey((args as { key: string }).key);
      case 'computer_scroll': return window.atomAgent.computerScroll(args as { x: number; y: number; deltaX: number; deltaY: number });
      case 'navigate_workspace': changeWorkspace((args as { workspace: WorkspaceId }).workspace); return { workspace: (args as { workspace: WorkspaceId }).workspace };
      case 'configure_analyzer': { const next = analyzerConfigSchema.parse(args); setAnalyzer(next); setWorkspace('spectrum'); return next; }
      case 'acquire_sweep': { const result = await acquire(); return { acquired: true, sweepId: result.id, sequence: result.sequence, points: result.frequencyHz.length, source: result.source }; }
      case 'start_continuous_sweeps': await startContinuous(); return { streaming: true };
      case 'stop_continuous_sweeps': await stopContinuous(); return { streaming: false, sweepsRetained: history.length };
      case 'get_measurement_state': return JSON.parse(applicationContext()).measurement;
      case 'set_measurement_view': {
        const view = measurementViewIdSchema.parse((args as { view: MeasurementViewId }).view);
        changeMeasurementView(view);
        return { workspace: 'spectrum', view };
      }
      case 'configure_waterfall': {
        const configuration = waterfallConfigurationSchema.parse(args);
        configureWaterfall(configuration);
        setWorkspace('spectrum');
        setMeasurementView('waterfall');
        return { configuration, retainedSweeps: history.length, evidence: 'host-derived-scalar-sweep' };
      }
      case 'configure_channel_measurement': {
        const configuration = channelMeasurementConfigurationSchema.parse(args);
        configureChannelMeasurement(configuration);
        setWorkspace('spectrum');
        setMeasurementView('channel');
        return configuration;
      }
      case 'get_channel_measurement_results': return requireChannelMeasurement();
      case 'configure_envelope_stft': {
        const configuration = envelopeStftConfigurationSchema.parse(args);
        configureEnvelopeStft(configuration);
        setWorkspace('spectrum');
        setMeasurementView('envelope-stft');
        return configuration;
      }
      case 'get_envelope_stft_results': return requireEnvelopeStft();
      case 'acquire_envelope_stft': {
        const capture = await acquireZeroSpan();
        const result = computeEnvelopeStft(capture, stftConfiguration);
        setWorkspace('spectrum');
        setMeasurementView('envelope-stft');
        return result;
      }
      case 'configure_marker': {
        const marker = markerConfigurationSchema.parse(args);
        configureMarker(marker);
        setWorkspace('spectrum');
        return { marker, evidence: 'host-derived' };
      }
      case 'search_marker': {
        const value = args as { markerId: MarkerId; action: MarkerSearchAction };
        const marker = markers.find((item) => item.id === value.markerId);
        if (!marker) throw new Error(`Marker M${value.markerId} is unavailable`);
        const frame = traceFrames.find((item) => item.traceId === marker.traceId);
        if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
        const frequencyHz = searchMarker(frame, marker.frequencyHz, value.action, markerSearchConfiguration);
        configureMarker({ ...marker, enabled: true, tracking: value.action === 'peak' ? 'peak' : 'fixed', frequencyHz });
        setWorkspace('spectrum');
        return { markerId: value.markerId, action: value.action, frequencyHz, evidence: 'host-derived' };
      }
      case 'configure_trace': {
        const trace = traceConfigurationSchema.parse(args);
        configureTrace(trace);
        setWorkspace('spectrum');
        return { trace, evidence: 'host-derived' };
      }
      case 'reset_trace': {
        const traceId = (args as { traceId: TraceId }).traceId;
        traceAccumulator.current.reset(traceId);
        setTraceFrames(traceAccumulator.current.frames());
        return { traceId, reset: true, evidence: 'host-derived' };
      }
      case 'configure_spectrum_display': {
        const display = spectrumDisplayConfigurationSchema.parse(args);
        configureDisplay(display);
        setWorkspace('spectrum');
        return { display, evidence: 'host-derived' };
      }
      case 'configure_signal_detector': { const next = signalDetectionConfigSchema.parse(args); setDetectionConfig(next); setWorkspace('detection'); return next; }
      case 'configure_zero_span': { const next = zeroSpanConfigSchema.parse(args); setZeroConfig(next); setWorkspace('classification'); return next; }
      case 'acquire_zero_span': { const result = await acquireZeroSpan(); setWorkspace('classification'); return { acquired: true, captureId: result.id, samples: result.powerDbm.length, envelope: classifyZeroSpanEnvelope(result) }; }
      case 'configure_generator': { const next = generatorConfigSchema.parse(args); setGenerator(next); const configured = await configureGeneratorWith(next); setWorkspace('generator'); return configured.generator; }
      case 'set_rf_output': { const enabled = (args as { enabled: boolean }).enabled; const next = await setOutput(enabled); return { enabled, verification: next.verification }; }
      case 'capture_device_screen': { const frame = await captureScreen(); return { captured: true, width: frame.width, height: frame.height, format: frame.format, capturedAt: frame.capturedAt }; }
      case 'remote_device_touch': {
        const value = args as ScreenPoint & { gesture: 'tap' | 'press' | 'release' };
        const point = { x: value.x, y: value.y };
        if (value.gesture === 'tap') { await window.tinySA.touch(point); await window.tinySA.releaseTouch(point); }
        else if (value.gesture === 'press') await window.tinySA.touch(point);
        else await window.tinySA.releaseTouch(point);
        return { completed: value.gesture, point };
      }
      case 'export_latest_sweep': return exportLatest((args as { format: 'csv' | 'json' }).format);
    }
  }

  const agent = useAtomAgent({ applicationContext, execute: executeAgentTool });
  const acquisitionActions = (continuous || (workspace !== 'generator' && workspace !== 'device')) ? <div className="acquisition-actions">
    {sweep && workspace !== 'generator' && workspace !== 'device' && <>
      <button className="secondary compact icon-only" aria-label="Export CSV" title="Export CSV" onClick={() => void exportLatest('csv')}><Download size={14}/><span>CSV</span></button>
      <button className="secondary compact icon-only" aria-label="Export JSON" title="Export JSON" onClick={() => void exportLatest('json')}><span>{'{ }'}</span></button>
    </>}
    {continuous
      ? <button data-agent-control="acquisition.continuous.stop" className="secondary compact stop-acquisition" onClick={() => void stopContinuousFromUi()}><StopCircle size={14}/>Stop</button>
      : <>
        <button data-agent-control="acquisition.continuous.start" className="secondary compact" disabled={!connected || busy} onClick={() => void startContinuousFromUi()}><Repeat2 size={14}/>Run</button>
        <button data-agent-control="acquisition.single" className="primary compact" disabled={!connected || busy} onClick={() => void acquireFromUi()}>{busy ? <LoaderCircle className="spin" size={14}/> : <Play size={14} fill="currentColor"/>}{acquisition === 'acquiring' ? 'Acquiring…' : 'Single'}</button>
      </>}
  </div> : null;

  return <main className={`app-shell ${agentOpen ? 'ai-open' : ''}`}>
    <TopBar snapshot={snapshot} simulated={simulated} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)} onConnection={() => setConnectionOpen(true)} onAgent={() => setAgentOpen((value) => !value)}/>
    <Sidebar active={workspace} output={snapshot.generatorOutput} onSelect={changeWorkspace}/>
    <section className={`workspace-shell ${workspace === 'spectrum' ? 'spectrum-workspace' : ''}`}>
      {workspace !== 'spectrum' && acquisitionActions && <div className="workspace-command-row">{acquisitionActions}</div>}
      {error && <div className="global-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button onClick={() => setError(undefined)}>Dismiss</button></div>}
      {notice && <div className="global-notice" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)}>Dismiss</button></div>}
      {workspace === 'spectrum' && <MeasurementWorkspace
        acquisitionActions={acquisitionActions}
        view={measurementView} onView={changeMeasurementView}
        analyzer={analyzer} busy={busy} connected={connected} streaming={continuous} onAnalyzer={setAnalyzer}
        sweep={sweep} history={history} detections={detections} acquisition={acquisition}
        traces={traceConfiguration} frames={traceFrames} markers={markers} readings={markerReadings}
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
      {workspace === 'classification' && <ClassificationWorkspace sweep={sweep} detections={detections} classifications={classifications} zeroConfig={zeroConfig} zeroCapture={zeroCapture} envelope={envelope} busy={!connected || busy} onZeroConfig={setZeroConfig} onAcquireZero={() => void acquireZeroSpanFromUi()}/>}
      {workspace === 'generator' && <GeneratorWorkspace config={generator} snapshot={snapshot} busy={busy} onChange={setGenerator} onApply={() => void configureGeneratorFromUi()} onOutput={(enabled) => void setOutputFromUi(enabled)}/>}
      {workspace === 'device' && <DeviceWorkspace snapshot={snapshot} diagnostics={diagnostics} frame={screenFrame} busy={busy} onRefresh={() => void refreshDiagnosticsFromUi()} onCapture={() => void captureScreenFromUi()} onTouch={(point) => void touchScreen(point)} onRelease={(point) => void releaseScreen(point)}/>}
    </section>
    <AtomAgentPanel open={agentOpen} state={agent.state} status={agent.status} messages={agent.messages} approval={agent.approval} onClose={() => setAgentOpen(false)} onSend={agent.sendText} onVoice={agent.startVoice} onApproval={agent.resolveApproval}/>
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
  </main>;
}

function loadStored<T>(name: string, parse: (value: unknown) => T, initial: T): T {
  const raw = localStorage.getItem(`tinysa-atomizer:v2:${name}`);
  return raw === null ? structuredClone(initial) : parse(JSON.parse(raw));
}
function saveStored(name: string, value: unknown): void { localStorage.setItem(`tinysa-atomizer:v2:${name}`, JSON.stringify(value)); }
function parseMarkerBank(value: unknown): readonly MarkerConfiguration[] {
  if (!Array.isArray(value) || value.length !== 8) throw new Error('Marker bank must contain exactly eight markers');
  const markers = value.map((marker) => markerConfigurationSchema.parse(marker));
  if (new Set(markers.map((marker) => marker.id)).size !== 8) throw new Error('Marker bank must contain markers 1 through 8 exactly once');
  return markers;
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function evaluateAnalysis<T>(operation: () => T): { ok: true; result: T } | { ok: false; error: string } {
  try { return { ok: true, result: operation() }; }
  catch (value) { return { ok: false, error: errorMessage(value) }; }
}
