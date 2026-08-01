import {
  type CanonicalInstrumentSurface,
  type CanonicalOperationParameterIntent,
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  measurementViewIdSchema,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  traceConfigurationSchema,
  waterfallConfigurationSchema,
  type FirmwareTraceId,
  type MarkerId,
  type MarkerSearchAction,
  type MeasurementViewId,
  type SignalDetectionConfig,
  type InstrumentSessionSnapshot,
  type Sweep,
  type TraceId,
} from '@tinysa/contracts';
import {
  autoScaleSpectrum,
  calculateSweepMetrics,
  classifyZeroSpanEnvelope,
  computeEnvelopeStft,
  readMarkers,
  searchMarker,
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
import { instrumentCandidateUiKey, sameInstrumentCandidateDescriptor, assertWorkspaceTransition, type WorkspaceId } from './ui-contracts.js';
import { agentDetectionResults } from './agent-detection-results.js';
import { DETECT_CONSENSUS_WINDOW_MS } from './classification-consensus.js';
import type { ModulationClassification } from './embedding-classifier-runtime.js';
import type { InstrumentScreenPoint } from './components/DeviceWorkspace.js';
import { coherentSweepCount } from './controllers/acquisition.js';
import {
  errorMessage,
  evaluateAnalysis,
  type RendererKernel,
} from './controllers/kernel.js';
import type { AcquisitionState } from './ui-contracts.js';
import type { ContinuousAcquisitionMode } from './store.js';

export class AgentExecutor {
  constructor(private readonly k: RendererKernel) {}

  /**
   * Approval follows the active driver's operation declaration.  Atom never
   * guesses from an operation name, source type, or device family.
   */
  requiresActionApproval = (name: AgentToolName, args: unknown): boolean => {
    if (name !== 'execute_canonical_operation'
      || args === null
      || typeof args !== 'object'
      || typeof (args as { operationId?: unknown }).operationId !== 'string') {
      return false;
    }
    const operationId = (args as { operationId: string }).operationId;
    return this.k.state.canonicalSurface?.operations.some((operation) => (
      operation.id === operationId && operation.confirmation === 'high-impact'
    )) ?? false;
  };

  /**
   * Atom is an application client of the same homogeneous interface as the
   * visible UI. It receives driver-declared capabilities and canonical
   * controls, never a device family, model-specific connection field, or
   * private driver configuration.
   */
  instrumentInterfaceState() {
    return genericInstrumentInterface(
      this.k.state.instrument.session,
      this.k.state.canonicalSurface,
    );
  }

  systemTopology() {
    const k = this.k;
    return {
      atomizer: { owner: 'atomizer', instrumentApiVersion: window.atomizerInstrument.version, role: 'instrument-host' },
      instrument: this.instrumentInterfaceState(),
    } as const;
  }

  agentLatestSweepSummary(
    currentSweep: Sweep,
    metrics: ReturnType<typeof calculateSweepMetrics>,
  ) {
    assertAgentSweepPowerEvidence(currentSweep);
    const physicalNativeReceiver = 'kind' in currentSweep.identity
      && currentSweep.identity.kind === 'instrument-session'
      && currentSweep.identity.provenance.execution === 'physical'
      && currentSweep.source !== 'host-derived-from-complex-iq';
    if (physicalNativeReceiver
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
      powerReference: agentPowerReference(currentSweep),
      powerUnit: currentSweep.powerReference === 'uncalibrated-dbfs-relative' ? 'dBFS-relative' : 'dBm',
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

  /** Read the application-global classifier projection without creating work. */
  async classifyCurrentCapture() {
    const { result, sampleCount } = this.k.state.classification;
    return result
      ? {
          ...projectModulationClassification(result),
          projection: 'rolling-posterior-trend' as const,
          windowMilliseconds: DETECT_CONSENSUS_WINDOW_MS,
          sampleCount,
        }
      : { available: false as const, reason: 'global classification has not produced a sample yet' } as const;
  }

  applicationContext = (): string => {
    const k = this.k;
    const state = k.state;
    const currentInstrument = state.instrument;
    const currentWorkspace = state.workspace;
    const currentMeasurementView = state.measurementView;
    const currentSweep = state.sweep;
    const currentHistory = state.history;
    const currentDetections = state.detections;
    const currentZeroCapture = state.zeroCapture;
    const currentZeroCaptureReceipt = k.zeroCaptureReceiptRef.current;
    const currentEnvelope = state.envelope;
    const currentIqCapture = state.iqCapture;
    const currentTraceFrames = state.traceFrames;
    const currentMarkers = state.markers;
    const currentMarkerReadings = readMarkers(
      currentMarkers,
      currentTraceFrames,
      currentDetections,
    );
    const currentMetrics = currentSweep ? calculateSweepMetrics(currentSweep) : undefined;
    const channelMeasurement = evaluateAnalysis(() => k.measurement.requireChannelMeasurement());
    const envelopeStft = evaluateAnalysis(() => k.measurement.requireEnvelopeStft());
    return JSON.stringify({
      workspace: currentWorkspace,
      measurementView: currentMeasurementView,
      acquisition: state.acquisition,
      continuous: state.continuous,
      continuousMode: state.continuousMode,
      virtual: currentInstrument.session !== undefined && currentInstrument.session.provenance.execution !== 'physical',
      topology: this.systemTopology(),
      visibleError: state.error ?? null,
      instrument: this.instrumentInterfaceState(),
      sourceOutput: k.currentGeneratorOutput(),
      iq: {
        activeConfiguration: currentInstrument.session?.configuration?.configuration.kind === 'complex-iq'
          ? currentInstrument.session.configuration.configuration
          : null,
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
          powerReference: currentIqCapture.powerReference ?? 'not-established',
          provenance: {
            sessionId: currentIqCapture.sessionId,
            configurationRevision: currentIqCapture.configurationRevision,
            producerConfigurationEpoch: currentIqCapture.producerConfigurationEpoch ?? null,
            qualification: currentIqCapture.qualification,
            execution: currentInstrument.session?.provenance.execution ?? null,
          },
        } : null,
      },
      detectionConfig: state.detectionConfig,
      historyCount: currentHistory.length,
      latestSweep: currentSweep && currentMetrics
        ? this.agentLatestSweepSummary(currentSweep, currentMetrics)
        : null,
      detections: {
        ...agentDetectionResults(currentDetections),
        powerReference: currentSweep ? agentPowerReference(currentSweep) : null,
      },
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
        traces: state.traceConfiguration.map((trace) => ({ ...trace, sweepCount: currentTraceFrames.find((frame) => frame.traceId === trace.id)?.sweepCount ?? 0 })),
        firmwareTraces: state.firmwareTraceFrames.map(({ traceId, role, unit, frozen, sourceSweepId, capturedAt }) => ({ traceId, role, unit, frozen, visible: state.visibleFirmwareTraceIds.includes(traceId), sourceSweepId, capturedAt, evidence: 'firmware-readback' })),
        activeTraceId: state.activeTraceId,
        markers: { configurations: currentMarkers, readings: currentMarkerReadings, powerReference: currentSweep ? agentPowerReference(currentSweep) : null },
        activeMarkerId: state.activeMarkerId,
        markerSearch: state.markerSearchConfiguration,
        display: state.displayConfiguration,
        waterfall: { configuration: state.waterfallConfiguration, coherentSweeps: coherentSweepCount(currentHistory, state.waterfallConfiguration.historyDepth), powerReference: currentSweep ? agentPowerReference(currentSweep) : null },
        channel: { configuration: state.channelConfiguration, analysis: channelMeasurement, powerReference: currentSweep ? agentPowerReference(currentSweep) : null },
        envelopeStft: { configuration: state.stftConfiguration, analysis: envelopeStft },
        evidence: 'host-derived',
      },
    });
  };

  executeAgentTool = async (name: AgentToolName, args: unknown): Promise<unknown> => {
    const k = this.k;
    switch (name) {
      case 'get_application_state': {
        const context = JSON.parse(this.applicationContext()) as {
          workspace: WorkspaceId; measurementView: MeasurementViewId; acquisition: AcquisitionState;
          continuous: boolean; continuousMode: ContinuousAcquisitionMode; virtual: boolean; visibleError: string | null; historyCount: number;
          topology: unknown; sourceOutput: unknown;
          detectionConfig: SignalDetectionConfig; measurement: unknown; latestSweep: unknown; iq: unknown;
        };
        return {
          workspace: context.workspace, measurementView: context.measurementView,
          acquisition: context.acquisition, continuous: context.continuous, continuousMode: context.continuousMode, virtual: context.virtual,
          error: context.visibleError, historyCount: context.historyCount, topology: context.topology,
          connection: k.state.instrument.session ? 'connected' : 'disconnected',
          instrument: this.instrumentInterfaceState(),
          sourceOutput: context.sourceOutput,
          detection: context.detectionConfig, measurement: context.measurement, iq: context.iq,
          latestSweep: context.latestSweep, agentSurfaceVersion: ATOM_AGENT_VERSION,
        };
      }
      case 'get_system_topology': return this.systemTopology();
      case 'get_agent_surface': return {
        version: ATOM_AGENT_VERSION,
        model: ATOM_AGENT_MODEL,
        loading: { startupTool: ATOM_TOOL_LOADER_NAME, maximumToolsPerResponse: ATOM_MAX_LOADED_TOOLS, fullToolCount: agentToolDefinitions.length, concreteSchemas: 'response-scoped' },
        tools: agentToolDefinitions.map((tool) => ({ name: tool.name, description: tool.description, policy: agentToolPolicies[tool.name] })),
        controlBindings: agentControlBindings.map((binding) => ({ pattern: binding.pattern.source, preferredTool: binding.preferredTool, risk: binding.risk, projection: binding.projection, guarantee: binding.guarantee })),
        apiCoverage: agentApiCoverage,
      };
      case 'get_instrument_state': return {
        instrument: this.instrumentInterfaceState(),
        sourceOutput: k.currentGeneratorOutput(),
      };
      case 'get_latest_sweep_summary': return JSON.parse(this.applicationContext()).latestSweep;
      case 'get_detection_results': return {
        ...agentDetectionResults(k.state.detections),
        powerReference: k.state.sweep ? agentPowerReference(k.state.sweep) : null,
      };
      case 'get_classification_results': return this.classifyCurrentCapture();
      case 'read_device_diagnostics': return k.features.refreshDiagnostics();
      case 'list_connection_candidates': {
        const discovery = await k.acquisition.runInstrumentTransaction('list-connection-candidates', () => window.atomizerInstrument.discover());
        k.connection.acceptDiscovery(discovery.candidates, discovery.failures);
        const issued = discovery.candidates.map((candidate, index) => ({
          candidateId: `candidate-${index + 1}`,
          displayName: candidate.displayName,
          selected: instrumentCandidateUiKey(candidate) === k.state.selectedCandidateId,
        }));
        k.agentConnectionCandidates.current = new Map(issued.map((candidate, index) => [candidate.candidateId, discovery.candidates[index]!]));
        return { candidates: issued, failures: discovery.failures };
      }
      case 'connect_device': {
        const candidateId = (args as { candidateId: string }).candidateId;
        const issued = k.agentConnectionCandidates.current.get(candidateId);
        k.agentConnectionCandidates.current.clear();
        if (!issued) throw new Error(`Connection candidate ${candidateId} was not issued by the latest list_connection_candidates result`);
        // Same selection-driven semantics as the visual chooser: connecting
        // while another session is active tears that session down first, and
        // connecting to the already-active source is an idempotent no-op.
        const activeSession = k.state.instrument.session;
        if (activeSession && sameInstrumentCandidateDescriptor(activeSession.candidate, issued)) {
          return { connected: true, alreadyConnected: true, instrument: this.instrumentInterfaceState() };
        }
        if (activeSession) await k.connection.disconnectDevice();
        await k.acquisition.runInstrumentTransaction('connect-issued-instrument', async () => {
          const discovery = await window.atomizerInstrument.discover();
          k.connection.acceptDiscovery(discovery.candidates, discovery.failures);
          const candidate = discovery.candidates.find((current) => sameInstrumentCandidateDescriptor(current, issued));
          if (!candidate) throw new Error(`Connection candidate ${candidateId} is no longer available; list candidates again`);
          if (!sameInstrumentCandidateDescriptor(candidate, issued)) throw new Error(`Connection candidate ${candidateId} changed after it was listed; list candidates again`);
          k.set({ selectedCandidateId: instrumentCandidateUiKey(candidate) });
          return k.connection.connectCandidateOwned(candidate);
        });
        return { connected: true, instrument: this.instrumentInterfaceState() };
      }
      case 'disconnect_device': await k.connection.disconnectDevice(); return { disconnected: true, state: 'disconnected' };
      case 'inspect_interface': {
        await k.renderCommit.await();
        const rendered = inspectRenderedAgentControls();
        return { activeWorkspace: k.state.workspace, activeMeasurementView: k.state.measurementView, controls: Object.fromEntries(rendered.map((control) => [control.controlId, control.enabled])), rendered };
      }
      case 'computer_action': {
        await k.renderCommit.await();
        const control = (args as { controlId: AgentSemanticControlId }).controlId;
        const binding = agentControlBinding(control);
        if (binding.risk === 'high-impact') throw new Error(`Semantic control ${control} is high-impact and requires its typed approval tool`);
        if (semanticControlRequiresCoordinates(control)) throw new Error(`Semantic control ${control} requires a coordinate-bearing computer_click or its typed ${binding.preferredTool} tool`);
        const targets = [...document.querySelectorAll<HTMLElement>('[data-agent-control]')].filter((element) => element.dataset.agentControl === control);
        if (targets.length !== 1) throw new Error(`Semantic control ${control} has ${targets.length} rendered targets; expected exactly one`);
        const target = targets[0]!;
        if (target.closest('[data-agent-exclusion]')) throw new Error(`Semantic control ${control} is a local human-only boundary`);
        if (isDisabledControl(target)) throw new Error(`Semantic control ${control} is disabled`);
        if (target instanceof HTMLDetailsElement) target.open = !target.open;
        else target.click();
        return { activated: control, preferredTool: binding.preferredTool, projection: binding.projection };
      }
      case 'computer_screenshot': await k.renderCommit.await(); return window.atomAgent.computerScreenshot();
      case 'computer_click': await k.renderCommit.await(); return requireComputerActionResult(await window.atomAgent.computerClick(args as { screenshotId: string; x: number; y: number }));
      case 'computer_type': await k.renderCommit.await(); return requireComputerActionResult(await window.atomAgent.computerType(args as { expectedTarget: string; text: string }));
      case 'computer_key': await k.renderCommit.await(); return requireComputerActionResult(await window.atomAgent.computerKey(args as { expectedTarget: string; key: string }));
      case 'computer_scroll': await k.renderCommit.await(); return requireComputerActionResult(await window.atomAgent.computerScroll(args as { screenshotId: string; x: number; y: number; deltaX: number; deltaY: number }));
      case 'navigate_workspace': k.applyWorkspace((args as { workspace: WorkspaceId }).workspace); return { workspace: k.state.workspace };
      case 'acquire_sweep': {
        assertWorkspaceTransition(k.state.workspace, 'spectrum', k.currentGeneratorOutput());
        const frame = await k.acquisition.acquireGlobalFrame();
        const sweep = frame.sweep ?? (frame.iq && k.state.sweep?.id === frame.iq.measurementId
          ? k.state.sweep
          : undefined);
        return {
          acquired: true,
          acquisitionMode: frame.iq ? 'complex-iq' : 'swept-spectrum',
          ...(frame.iq ? {
            captureId: frame.iq.measurementId,
            sequence: frame.iq.sequence,
            centerHz: frame.iq.centerHz,
            sampleCount: frame.iq.sampleCount,
            sampleRateHz: frame.iq.sampleRateHz,
            qualification: frame.iq.qualification,
            powerReference: frame.iq.powerReference ?? 'not-established',
          } : {}),
          ...(sweep ? {
            sweepId: sweep.id,
            sweepSequence: sweep.sequence,
            points: sweep.frequencyHz.length,
            source: sweep.source,
            powerReference: agentPowerReference(sweep),
            identity: sweep.identity,
          } : {}),
        };
      }
      case 'start_continuous_sweeps': {
        assertWorkspaceTransition(k.state.workspace, 'spectrum', k.currentGeneratorOutput());
        await k.acquisition.startContinuous();
        return { streaming: true, continuousMode: k.state.continuousMode, workspace: k.state.workspace };
      }
      case 'stop_continuous_sweeps': await k.acquisition.stopContinuous(); return { streaming: false, continuousMode: k.state.continuousMode, sweepsRetained: k.state.history.length };
      case 'get_measurement_state': return JSON.parse(this.applicationContext()).measurement;
      case 'set_measurement_view': {
        const view = measurementViewIdSchema.parse((args as { view: MeasurementViewId }).view);
        k.measurement.applyMeasurementView(view);
        return { workspace: 'spectrum', view: k.state.measurementView };
      }
      case 'configure_waterfall': {
        const configuration = waterfallConfigurationSchema.parse(args);
        k.measurement.applyMeasurementView('waterfall');
        k.measurement.applyWaterfall(configuration);
        return { configuration, retainedSweeps: coherentSweepCount(k.state.history, configuration.historyDepth), powerReference: k.state.sweep ? agentPowerReference(k.state.sweep) : null, evidence: 'host-derived-scalar-sweep' };
      }
      case 'configure_channel_measurement': {
        const configuration = channelMeasurementConfigurationSchema.parse(args);
        k.measurement.applyMeasurementView('channel');
        k.measurement.applyChannelMeasurement(configuration);
        return configuration;
      }
      case 'get_channel_measurement_results': {
        const sweep = k.state.sweep;
        if (!sweep) throw new Error('Acquire a complete spectrum sweep before reading channel measurements');
        return { ...k.measurement.requireChannelMeasurement(), powerReference: agentPowerReference(sweep) };
      }
      case 'configure_envelope_stft': {
        const configuration = envelopeStftConfigurationSchema.parse(args);
        k.measurement.applyMeasurementView('envelope-stft');
        k.measurement.applyEnvelopeStft(configuration);
        return configuration;
      }
      case 'get_envelope_stft_results': return k.measurement.requireEnvelopeStft();
      case 'acquire_envelope_stft': {
        assertWorkspaceTransition(k.state.workspace, 'spectrum', k.currentGeneratorOutput());
        const capture = await k.acquisition.acquireZeroSpan();
        const result = computeEnvelopeStft(capture, k.state.stftConfiguration);
        k.measurement.applyMeasurementView('envelope-stft');
        return result;
      }
      case 'select_marker': {
        const markerId = (args as { markerId: MarkerId }).markerId;
        if (!k.state.markers.some((marker) => marker.id === markerId)) throw new Error(`Marker M${markerId} is unavailable`);
        k.applyWorkspace('spectrum');
        k.set({ activeMarkerId: markerId });
        return { markerId, selected: true, evidence: 'ui-only' };
      }
      case 'configure_marker': {
        const marker = markerConfigurationSchema.parse(args);
        k.applyWorkspace('spectrum');
        k.measurement.applyMarker(marker);
        return { marker, reading: k.measurement.previewMarkerReading(marker) ?? null, evidence: 'host-derived' };
      }
      case 'configure_marker_search': {
        const configuration = markerSearchConfigurationSchema.parse(args);
        if (k.state.sweep?.powerReference === 'uncalibrated-dbfs-relative') {
          throw new Error('Marker minimumLevelDbm is an absolute dBm criterion and cannot be configured for an uncalibrated dBFS-relative sweep');
        }
        k.applyWorkspace('spectrum');
        k.measurement.applyMarkerSearch(configuration);
        return { configuration, evidence: 'host-derived' };
      }
      case 'search_marker': {
        const value = args as { markerId: MarkerId; action: MarkerSearchAction };
        const marker = k.state.markers.find((item) => item.id === value.markerId);
        if (!marker) throw new Error(`Marker M${value.markerId} is unavailable`);
        // One Atom operation may acquire and then search before React commits a
        // render. The accumulator is the synchronous source of truth at that
        // transaction boundary; traceFrames is its UI projection.
        const frame = k.traceAccumulator.current.frames().find((item) => item.traceId === marker.traceId);
        if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
        k.applyWorkspace('spectrum');
        const frequencyHz = searchMarker(frame, marker.frequencyHz, value.action, k.state.markerSearchConfiguration, k.state.detections);
        const nextMarker = { ...marker, enabled: true, tracking: value.action === 'peak' ? 'peak' as const : 'fixed' as const, frequencyHz };
        k.measurement.applyMarker(nextMarker);
        return { markerId: value.markerId, action: value.action, frequencyHz, reading: k.measurement.previewMarkerReading(nextMarker) ?? null, evidence: 'host-derived' };
      }
      case 'select_trace': {
        const traceId = (args as { traceId: TraceId }).traceId;
        if (!k.state.traceConfiguration.some((trace) => trace.id === traceId)) throw new Error(`Trace ${traceId} is unavailable`);
        k.applyWorkspace('spectrum');
        k.set({ activeTraceId: traceId });
        return { traceId, selected: true, evidence: 'ui-only' };
      }
      case 'configure_trace': {
        const trace = traceConfigurationSchema.parse(args);
        k.applyWorkspace('spectrum');
        k.measurement.applyTrace(trace);
        return { trace, evidence: 'host-derived' };
      }
      case 'configure_firmware_trace_visibility': {
        const value = args as { traceId: FirmwareTraceId; visible: boolean };
        k.applyWorkspace('spectrum');
        const visibleTraceIds = k.measurement.configureFirmwareTraceVisibility(value.traceId, value.visible);
        return { traceId: value.traceId, visible: value.visible, visibleTraceIds, evidence: 'firmware-readback-display-projection' };
      }
      case 'reset_trace': {
        k.applyWorkspace('spectrum');
        const traceId = (args as { traceId: TraceId }).traceId;
        k.traceAccumulator.current.reset(traceId);
        k.set({ traceFrames: k.traceAccumulator.current.frames() });
        return { traceId, reset: true, evidence: 'host-derived' };
      }
      case 'configure_spectrum_display': {
        const display = spectrumDisplayConfigurationSchema.parse(args);
        k.applyWorkspace('spectrum');
        k.measurement.applyDisplay(display);
        return { display, powerReference: k.state.sweep ? agentPowerReference(k.state.sweep) : null, evidence: 'host-derived' };
      }
      case 'auto_scale_spectrum_display': {
        const latestSweep = k.state.sweep;
        if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before auto-scaling the display');
        k.applyWorkspace('spectrum');
        const display = autoScaleSpectrum(latestSweep);
        k.measurement.applyDisplay(display);
        return { display, sweepId: latestSweep.id, powerReference: agentPowerReference(latestSweep), evidence: 'host-derived-complete-sweep' };
      }
      case 'configure_signal_detector': {
        const next = signalDetectionConfigSchema.parse(args);
        if (k.state.sweep?.powerReference === 'uncalibrated-dbfs-relative'
          && next.threshold.strategy === 'absolute') {
          throw new Error('Absolute dBm detection is unavailable for an uncalibrated dBFS-relative sweep; use a noise-relative threshold');
        }
        k.applyWorkspace('classification');
        return { ...k.applyDetectionConfiguration(next), powerReference: k.state.sweep ? agentPowerReference(k.state.sweep) : null };
      }
      case 'acquire_zero_span': { assertWorkspaceTransition(k.state.workspace, 'classification', k.currentGeneratorOutput()); const result = await k.acquisition.acquireZeroSpan(); k.applyWorkspace('classification'); return { acquired: true, captureId: result.id, samples: result.powerDbm.length, envelope: classifyZeroSpanEnvelope(result), identity: result.identity }; }
      case 'acquire_complex_iq': {
        // Source-agnostic: acquireIq() rejects cleanly (no complex-I/Q
        // capability, e.g. a scalar-only receiver) with a
        // thrown Error rather than crashing or silently returning nothing.
        assertWorkspaceTransition(k.state.workspace, 'iq', k.currentGeneratorOutput());
        const measurement = await k.acquisition.acquireIq();
        k.applyWorkspace('iq');
        return {
          acquired: true,
          captureId: measurement.measurementId,
          sequence: measurement.sequence,
          centerHz: measurement.centerHz,
          sampleCount: measurement.sampleCount,
          sampleRateHz: measurement.sampleRateHz,
          sampleFormat: measurement.sampleFormat,
          qualification: measurement.qualification,
          // A missing power reference is never an implicit calibrated-power
          // claim; the connected driver's completed measurement owns it.
          powerReference: measurement.powerReference ?? 'not-established',
          powerUnit: measurement.powerReference === 'uncalibrated-dbfs-relative' ? 'dBFS-relative' : 'not-established',
        };
      }
      case 'execute_canonical_operation': {
        const { operationId, parameters } = args as {
          operationId: string;
          parameters: readonly CanonicalOperationParameterIntent[];
        };
        const surface = k.state.canonicalSurface;
        if (!surface) throw new Error('Connected instrument has not published a canonical operation surface');
        const result = await k.events.executeCanonicalOperation(surface, operationId, parameters);
        return {
          applied: true,
          operationId: result.operationId,
          sessionId: result.sessionId,
          surface: result.surface,
          evidence: 'driver-commanded',
        };
      }
      case 'capture_device_screen': { const frame = await k.features.captureScreen(); return { captured: true, width: frame.width, height: frame.height, format: frame.pixelFormat, capturedAt: frame.capturedAt }; }
      case 'remote_device_touch': {
        const value = args as InstrumentScreenPoint & { gesture: 'tap' };
        const point = { x: value.x, y: value.y };
        const task = k.features.queueRemoteTap(point);
        if (!task) throw new Error('A remote screen gesture is already active or no instrument session is connected');
        await task;
        return { completed: 'tap', point };
      }
      case 'export_latest_sweep': return k.features.exportLatest((args as { format: 'csv' | 'json' }).format);
      case 'export_latest_iq': return k.features.exportLatestIq();
    }
    const unreachable: never = name;
    return unreachable;
  };
}

function genericInstrumentInterface(
  session: InstrumentSessionSnapshot | undefined,
  canonicalSurface: CanonicalInstrumentSurface | undefined,
) {
  return {
    connection: session ? 'connected' as const : 'disconnected' as const,
    ...(session === undefined ? {} : {
      displayName: session.candidate.displayName,
      execution: session.provenance.execution === 'physical' ? 'physical' as const : 'virtual' as const,
      transport: session.provenance.transport,
      qualification: session.provenance.qualification,
      sessionId: session.sessionId,
      rfOutput: session.rfOutput,
      capabilities: {
        acquisitions: session.capabilities.acquisitions.map((capability) => capability.kind),
        features: session.capabilities.features.length === 0 ? [] : ['driver-feature'],
      },
    }),
    canonicalSurface: canonicalSurface ?? null,
  };
}

export function semanticControlRequiresCoordinates(control: AgentSemanticControlId): boolean {
  return control === 'spectrum.marker-place';
}

/** Compact, prop-safe projection of an embedding modulation classification. */
function projectModulationClassification(result: ModulationClassification) {
  return {
    available: true as const,
    contract: 'rolling-modulation-classification-v1' as const,
    flavor: result.flavor,
    family: result.family,
    modulation: result.modulation,
    confidence: result.confidence,
    isUnknown: result.isUnknown,
    candidates: result.candidates,
    ...(result.rejection ? { rejection: result.rejection } : {}),
  };
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

function requireComputerActionResult<T extends { ok: boolean; action: string; target?: string; reason?: string }>(result: T): T {
  if (!result.ok) throw new Error(`App-scoped computer ${result.action} was rejected${result.target ? ` at ${result.target}` : ''}: ${result.reason ?? 'no rejection reason was returned'}`);
  return result;
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

function agentPowerReference(sweep: Sweep): 'calibrated-dbm' | 'uncalibrated-dbfs-relative' {
  return sweep.powerReference ?? 'calibrated-dbm';
}

/** Agent reads are an external evidence boundary: a host-derived FFT never
 * inherits native-receiver dBm assertions from the session that supplied IQ. */
export function assertAgentSweepPowerEvidence(sweep: Sweep): void {
  if (sweep.source === 'host-derived-from-complex-iq' && sweep.powerReference === undefined) {
    throw new Error('Host-derived complex-I/Q spectrum omitted its explicit power reference');
  }
  if (sweep.powerReference !== 'uncalibrated-dbfs-relative') {
    return;
  }
  if (sweep.source !== 'host-derived-from-complex-iq'
    || sweep.requested.controls.model !== 'host-derived-iq-projection'
    || sweep.resolutionBandwidthQualification !== 'host-derived-fft-bin') {
    throw new Error('Uncalibrated dBFS-relative sweep has contradictory host-derived FFT provenance');
  }
  if (!('kind' in sweep.identity) || sweep.identity.kind !== 'instrument-session') {
    throw new Error('Uncalibrated dBFS-relative sweep requires instrument-session provenance');
  }
  const execution = sweep.identity.provenance.execution;
  const expectedAttenuationQualification = sweep.actualAttenuationDb === null
    ? 'not-applicable'
    : execution === 'physical'
      ? 'device-observed'
      : execution === 'firmware-executed-twin'
        ? 'firmware-executed-twin'
        : undefined;
  if (expectedAttenuationQualification === undefined
    || sweep.attenuationQualification !== expectedAttenuationQualification) {
    throw new Error('Uncalibrated dBFS-relative sweep has contradictory attenuation evidence');
  }
}
