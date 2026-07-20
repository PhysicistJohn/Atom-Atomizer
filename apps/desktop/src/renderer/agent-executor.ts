import {
  analyzerConfigPatchSchema,
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  generatorConfigSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  measurementViewIdSchema,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  traceConfigurationSchema,
  waterfallConfigurationSchema,
  type AnalyzerConfig,
  type FirmwareTraceId,
  type GeneratorConfig,
  type MarkerId,
  type MarkerSearchAction,
  type MeasurementViewId,
  type SignalDetectionConfig,
  type Sweep,
  type TraceId,
  type ZeroSpanConfig,
  type ZeroSpanConfigPatch,
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
import { classifyIqModulation, classifyScalarSweep, type ModulationClassification } from './embedding-classifier-runtime.js';
import { decodeComplexIqChannels } from './complex-iq.js';
import { stageDetectedPowerConfigurationPatch } from './instrument-configuration.js';
import type { InstrumentScreenPoint } from './components/DeviceWorkspace.js';
import { instrumentCandidateIsSimulated } from './controllers/connection.js';
import { coherentSweepCount } from './controllers/acquisition.js';
import {
  errorMessage,
  evaluateAnalysis,
  type RendererKernel,
} from './controllers/kernel.js';
import type { AcquisitionState } from './ui-contracts.js';
import { selectIqCapability, type ContinuousAcquisitionMode } from './store.js';

export class AgentExecutor {
  constructor(private readonly k: RendererKernel) {}

  systemTopology() {
    const k = this.k;
    const active = k.state.instrument.session;
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
      firmwareTwin: { owner: 'tinysa-firmware', available: k.state.candidates.some((candidate) => candidate.sourceKind === 'tinysa-firmware-twin'), connected: active?.provenance.sourceKind === 'tinysa-firmware-twin', integration: 'renode-monitor-v1', usbTransactionsModeled: false },
      signalLab: { owner: 'tinysa-signal-lab', available: k.state.candidates.some((candidate) => candidate.sourceKind === 'signal-lab'), connected: active?.provenance.sourceKind === 'signal-lab', integration: 'measurement-bridge-v1', claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
    } as const;
  }

  agentStagedConfiguration(
    stagedAnalyzer: AnalyzerConfig = this.k.state.analyzer,
    stagedDetectedPower: ZeroSpanConfig = this.k.state.zeroConfig,
  ) {
    const acquisitions = this.k.state.instrument.session?.capabilities.acquisitions ?? [];
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

  agentConfigurationContext(
    stagedAnalyzer: AnalyzerConfig = this.k.state.analyzer,
    stagedDetectedPower: ZeroSpanConfig = this.k.state.zeroConfig,
  ) {
    const active = this.k.state.instrument.session?.configuration;
    return {
      admitted: active ? {
        configurationRevision: active.configurationRevision,
        configuredAt: active.configuredAt,
        configuration: active.configuration,
      } : null,
      staged: this.agentStagedConfiguration(stagedAnalyzer, stagedDetectedPower),
    } as const;
  }


  agentLatestSweepSummary(
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

  agentSignalLabCatalog = (): { selectedProfileId: string | null; profiles: readonly { profileId: string; family?: string; label: string }[] } | null => {
    const capability = this.k.state.instrument.session?.capabilities.features
      .find((feature) => feature.kind === 'signal-lab-profile-selection');
    if (capability?.kind !== 'signal-lab-profile-selection') return null;
    return {
      selectedProfileId: capability.selectedProfileId ?? null,
      // Catalog entries are either full descriptors (with family/label) or
      // bare geometry; loose-name resolution wants the labels when present.
      profiles: capability.profiles.map((profile) => 'label' in profile
        ? { profileId: profile.profileId, family: profile.family, label: profile.label }
        : { profileId: profile.profileId, label: profile.profileId }),
    };
  };

  /**
   * Classify what is currently in the store through the embedding classifier
   * that drives the Detect panel: the complex-I/Q flavor when the connected
   * instrument advertises I/Q and a capture is present, otherwise the magnitude
   * flavor over the visible sweep's strongest live detection.
   */
  async classifyCurrentCapture() {
    const state = this.k.state;
    if (selectIqCapability(state) !== undefined && state.iqCapture) {
      const { re, im } = decodeComplexIqChannels(state.iqCapture);
      return projectModulationClassification(
        await classifyIqModulation(re, im, state.iqConfiguration.bandwidthHz),
      );
    }
    const sweep = state.sweep;
    const target = state.detections
      .filter((detection) => detection.state !== 'released')
      .reduce<(typeof state.detections)[number] | undefined>(
        (best, detection) => (best && best.peakDbm >= detection.peakDbm ? best : detection),
        undefined,
      );
    if (sweep && target) {
      const result = await classifyScalarSweep(sweep.powerDbm, sweep.frequencyHz, target.peakHz, target.bandwidthHz);
      if (result) return projectModulationClassification(result);
    }
    return { available: false as const, reason: 'no capture available to classify' } as const;
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
      simulated: currentInstrument.session !== undefined && currentInstrument.session.provenance.execution !== 'physical',
      topology: this.systemTopology(),
      visibleError: state.error ?? null,
      instrument: currentInstrument,
      generatorOutput: k.currentGeneratorOutput(),
      scalarConfiguration: this.agentConfigurationContext(),
      iq: {
        stagedConfiguration: state.iqConfiguration,
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
      generator: state.generator,
      detectionConfig: state.detectionConfig,
      historyCount: currentHistory.length,
      latestSweep: currentSweep && currentMetrics
        ? this.agentLatestSweepSummary(currentSweep, currentMetrics)
        : null,
      detections: agentDetectionResults(currentDetections),
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
        markers: { configurations: currentMarkers, readings: currentMarkerReadings },
        activeMarkerId: state.activeMarkerId,
        markerSearch: state.markerSearchConfiguration,
        display: state.displayConfiguration,
        waterfall: { configuration: state.waterfallConfiguration, coherentSweeps: coherentSweepCount(currentHistory, state.waterfallConfiguration.historyDepth) },
        channel: { configuration: state.channelConfiguration, analysis: channelMeasurement },
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
          continuous: boolean; continuousMode: ContinuousAcquisitionMode; simulated: boolean; visibleError: string | null; historyCount: number;
          topology: unknown; scalarConfiguration: unknown; generator: GeneratorConfig;
          detectionConfig: SignalDetectionConfig; measurement: unknown; latestSweep: unknown; iq: unknown;
        };
        return {
          workspace: context.workspace, measurementView: context.measurementView,
          acquisition: context.acquisition, continuous: context.continuous, continuousMode: context.continuousMode, simulated: context.simulated,
          error: context.visibleError, historyCount: context.historyCount, topology: context.topology,
          connection: k.state.instrument.session ? 'connected' : 'disconnected',
          signalLab: this.agentSignalLabCatalog(),
          scalarConfiguration: context.scalarConfiguration, generator: context.generator,
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
      case 'get_instrument_state': return { ...k.state.instrument, generatorOutput: k.currentGeneratorOutput(), scalarConfiguration: this.agentConfigurationContext() };
      case 'get_latest_sweep_summary': return JSON.parse(this.applicationContext()).latestSweep;
      case 'get_detection_results': return agentDetectionResults(k.state.detections);
      case 'get_classification_results': return this.classifyCurrentCapture();
      case 'read_device_diagnostics': return k.features.refreshDiagnostics();
      case 'list_connection_candidates': {
        const discovery = await k.acquisition.runInstrumentTransaction('list-connection-candidates', () => window.atomizerInstrument.discover());
        k.connection.acceptDiscovery(discovery.candidates, discovery.failures);
        const issued = discovery.candidates.map((candidate, index) => ({ candidateId: `candidate-${index + 1}`, driverId: candidate.driverId, displayName: candidate.displayName, sourceKind: candidate.sourceKind, simulated: instrumentCandidateIsSimulated(candidate), selected: instrumentCandidateUiKey(candidate) === k.state.selectedCandidateId }));
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
        if (activeSession
          && activeSession.candidate.driverId === issued.driverId
          && activeSession.candidate.sourceKind === issued.sourceKind
          && activeSession.candidate.candidateId === issued.candidateId) {
          return { connected: true, alreadyConnected: true, driverId: activeSession.driverId, sourceKind: activeSession.provenance.sourceKind, execution: activeSession.provenance.execution, qualification: activeSession.provenance.qualification, displayName: activeSession.candidate.displayName };
        }
        if (activeSession) await k.connection.disconnectDevice();
        const next = await k.acquisition.runInstrumentTransaction('connect-issued-instrument', async () => {
          const discovery = await window.atomizerInstrument.discover();
          k.connection.acceptDiscovery(discovery.candidates, discovery.failures);
          const candidate = discovery.candidates.find((current) => current.driverId === issued.driverId
            && current.sourceKind === issued.sourceKind
            && current.candidateId === issued.candidateId);
          if (!candidate) throw new Error(`Connection candidate ${candidateId} is no longer available; list candidates again`);
          if (!sameInstrumentCandidateDescriptor(candidate, issued)) throw new Error(`Connection candidate ${candidateId} changed after it was listed; list candidates again`);
          k.set({ selectedCandidateId: instrumentCandidateUiKey(candidate) });
          return k.connection.connectCandidateOwned(candidate);
        });
        return { connected: true, driverId: next.driverId, sourceKind: next.provenance.sourceKind, execution: next.provenance.execution, qualification: next.provenance.qualification, displayName: next.candidate.displayName };
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
      case 'configure_analyzer': {
        assertWorkspaceTransition(k.state.workspace, 'spectrum', k.currentGeneratorOutput());
        const patch = analyzerConfigPatchSchema.parse(args);
        const next = await k.acquisition.updateAnalyzer(patch);
        k.applyWorkspace('spectrum');
        return { patch, scalarConfiguration: this.agentConfigurationContext(next), continuous: k.continuousRequested.current };
      }
      case 'acquire_sweep': {
        if (k.state.workspace === 'iq') {
          assertWorkspaceTransition(k.state.workspace, 'iq', k.currentGeneratorOutput());
          const result = await k.acquisition.acquireIq();
          k.applyWorkspace('iq');
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
        assertWorkspaceTransition(k.state.workspace, 'spectrum', k.currentGeneratorOutput());
        const result = await k.acquisition.acquire();
        k.applyWorkspace('spectrum');
        return { acquired: true, acquisitionMode: 'swept-spectrum', sweepId: result.id, sequence: result.sequence, points: result.frequencyHz.length, source: result.source, identity: result.identity };
      }
      case 'start_continuous_sweeps': {
        if (k.state.workspace === 'iq') {
          assertWorkspaceTransition(k.state.workspace, 'iq', k.currentGeneratorOutput());
          await k.acquisition.startContinuousIq();
          k.applyWorkspace('iq');
        } else {
          assertWorkspaceTransition(k.state.workspace, 'spectrum', k.currentGeneratorOutput());
          await k.acquisition.runInstrumentTransaction('start-continuous-acquisition', () => k.acquisition.startContinuousOwned());
          k.applyWorkspace('spectrum');
        }
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
        return { configuration, retainedSweeps: coherentSweepCount(k.state.history, configuration.historyDepth), evidence: 'host-derived-scalar-sweep' };
      }
      case 'configure_channel_measurement': {
        const configuration = channelMeasurementConfigurationSchema.parse(args);
        k.measurement.applyMeasurementView('channel');
        k.measurement.applyChannelMeasurement(configuration);
        return configuration;
      }
      case 'get_channel_measurement_results': return k.measurement.requireChannelMeasurement();
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
        return { display, evidence: 'host-derived' };
      }
      case 'auto_scale_spectrum_display': {
        const latestSweep = k.state.sweep;
        if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before auto-scaling the display');
        k.applyWorkspace('spectrum');
        const display = autoScaleSpectrum(latestSweep);
        k.measurement.applyDisplay(display);
        return { display, sweepId: latestSweep.id, evidence: 'host-derived-complete-sweep' };
      }
      case 'configure_signal_detector': { const next = signalDetectionConfigSchema.parse(args); k.applyWorkspace('classification'); return k.applyDetectionConfiguration(next); }
      case 'configure_zero_span': {
        const capability = k.state.instrument.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
        const { patch, configuration: next } = stageDetectedPowerConfigurationPatch(
          capability?.kind === 'detected-power-timeseries' ? capability : undefined,
          k.state.zeroConfig,
          args as ZeroSpanConfigPatch,
        );
        k.applyWorkspace('classification');
        k.measurement.commitZeroSpanConfiguration(next);
        k.clearZeroSpanCapture();
        return { patch, scalarConfiguration: this.agentConfigurationContext(k.state.analyzer, next) };
      }
      case 'acquire_zero_span': { assertWorkspaceTransition(k.state.workspace, 'classification', k.currentGeneratorOutput()); const result = await k.acquisition.acquireZeroSpan(); k.applyWorkspace('classification'); return { acquired: true, captureId: result.id, samples: result.powerDbm.length, envelope: classifyZeroSpanEnvelope(result), identity: result.identity }; }
      case 'configure_generator': { const next = generatorConfigSchema.parse(args); k.applyWorkspace('generator'); k.set({ generator: next }); return k.features.configureGeneratorWith(next); }
      case 'set_rf_output': { const enabled = (args as { enabled: boolean }).enabled; k.applyWorkspace('generator'); await k.features.setOutput(enabled); return { enabled, sourceKind: k.state.instrument.session?.provenance.sourceKind ?? 'unknown', evidence: 'driver-commanded' }; }
      case 'select_signal_lab_profile': {
        const profileId = (args as { profileId: string }).profileId;
        const capability = k.state.instrument.session?.capabilities.features
          .find((feature) => feature.kind === 'signal-lab-profile-selection');
        if (capability?.kind !== 'signal-lab-profile-selection') throw new Error('Connected driver exposes no SignalLab profile-selection capability');
        const advertisedProfileIds = capability.profiles.map((profile) => profile.profileId);
        if (!advertisedProfileIds.includes(profileId)) {
          throw new Error(`SignalLab profile ${profileId} is not in the advertised catalog: ${advertisedProfileIds.join(', ')}`);
        }
        const previousProfileId = capability.selectedProfileId;
        // Same continuous-paused executeInstrumentFeature transaction as the
        // visual profile picker, including its profile-driven span restaging.
        await k.features.selectSignalLabProfileCommanded(profileId);
        const selected = k.state.instrument.session?.capabilities.features
          .find((feature) => feature.kind === 'signal-lab-profile-selection');
        if (selected?.kind !== 'signal-lab-profile-selection' || selected.selectedProfileId !== profileId) {
          throw new Error(`SignalLab did not report profile ${profileId} as selected after the commanded selection`);
        }
        return {
          selected: true,
          profileId,
          previousProfileId,
          evidence: 'driver-commanded',
          scalarConfiguration: this.agentConfigurationContext(),
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
    }
    const unreachable: never = name;
    return unreachable;
  };
}

export function semanticControlRequiresCoordinates(control: AgentSemanticControlId): boolean {
  return control === 'spectrum.marker-place';
}

/** Compact, prop-safe projection of an embedding modulation classification. */
function projectModulationClassification(result: ModulationClassification) {
  return {
    available: true as const,
    contract: 'capture-modulation-classification-v1' as const,
    flavor: result.flavor,
    family: result.family,
    modulation: result.modulation,
    confidence: result.confidence,
    isUnknown: result.isUnknown,
    candidates: result.candidates,
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
