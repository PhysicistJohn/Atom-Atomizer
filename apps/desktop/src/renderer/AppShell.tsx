import { useEffect, useLayoutEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { AtomAgentPanel } from './components/AtomAgentPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { useAtomAgent } from './useAtomAgent.js';
import { DEVELOPMENT_RENDERER } from './development.js';
import type { WorkspaceId } from './ui-contracts.js';
import {
  acquisitionModeForSession,
  createInitialRendererState,
  generatorOutputState,
  selectAcquisitionDisabledReason,
  selectBusy,
  selectGeneratorCapability,
  selectIqCapability,
  selectSpectrumCapability,
  selectSignalLabProfileCapability,
  AtomizerStore,
} from './store.js';
import { RendererKernel } from './controllers/kernel.js';
import { InstrumentEventsController } from './controllers/instrument-events.js';
import { ConnectionController } from './controllers/connection.js';
import { AcquisitionController, fitChannelConfigurationToSpan } from './controllers/acquisition.js';
import { MeasurementController } from './controllers/measurement.js';
import { FeaturesController } from './controllers/features.js';
import { AgentExecutor } from './agent-executor.js';
import { ClassificationController } from './controllers/classification.js';
import { ConnectionContainer } from './containers/ConnectionContainer.js';
import { MeasurementActions, MeasurementContainer } from './containers/MeasurementContainer.js';
import { DetectContainer } from './containers/DetectContainer.js';
import { IqContainer } from './containers/IqContainer.js';
import { GeneratorContainer } from './containers/GeneratorContainer.js';
import { DeviceContainer } from './containers/DeviceContainer.js';

// Pinned-spec re-exports (formerly exported from App.tsx).
export { parseStoredDetection } from './store.js';
export { coherentSweepCount, fitChannelConfigurationToSpan } from './controllers/acquisition.js';
export { agentSelectedClassificationId, semanticControlRequiresCoordinates } from './agent-executor.js';
export {
  resolveClassificationTargetSelection,
  resolveVisibleClassificationTargetSelection,
} from './classification-target-selection.js';

export interface RendererRuntime {
  readonly store: AtomizerStore;
  readonly kernel: RendererKernel;
  readonly events: InstrumentEventsController;
  readonly connection: ConnectionController;
  readonly acquisition: AcquisitionController;
  readonly measurement: MeasurementController;
  readonly features: FeaturesController;
  readonly agent: AgentExecutor;
  readonly classification: ClassificationController;
}

export function createRendererRuntime(options: {
  readonly initialWorkspace: WorkspaceId;
  readonly initialAgentOpen: boolean;
}): RendererRuntime {
  const store = new AtomizerStore(createInitialRendererState(options));
  const kernel = new RendererKernel(store);
  kernel.events = new InstrumentEventsController(kernel);
  kernel.connection = new ConnectionController(kernel);
  kernel.acquisition = new AcquisitionController(kernel);
  kernel.measurement = new MeasurementController(kernel);
  kernel.features = new FeaturesController(kernel);
  kernel.agent = new AgentExecutor(kernel);
  kernel.classification = new ClassificationController(kernel);
  return {
    store,
    kernel,
    events: kernel.events,
    connection: kernel.connection,
    acquisition: kernel.acquisition,
    measurement: kernel.measurement,
    features: kernel.features,
    agent: kernel.agent,
    classification: kernel.classification,
  };
}

export interface AppProps {
  /** Optional launch workspace for browser deep links; desktop keeps the spectrum default. */
  readonly initialWorkspace?: WorkspaceId;
  /** Browser launch surfaces can start focused without opening the Atom agent panel. */
  readonly initialAgentOpen?: boolean;
}

export function App({
  initialWorkspace = 'spectrum',
  initialAgentOpen = true,
}: AppProps = {}) {
  const [runtime] = useState(() => createRendererRuntime({ initialWorkspace, initialAgentOpen }));
  const { store, kernel } = runtime;
  const state = useSyncExternalStore(store.subscribe, () => store.get());
  const {
    workspace, measurementView, agentOpen, instrument, acquisition,
    continuous, continuousMode, error, notice, sweep,
  } = state;

  const session = instrument.session;
  const generatorOutput = generatorOutputState(session);
  const connected = session !== undefined;
  const busy = selectBusy(state, kernel.instrumentTransactionOwner.current);
  const iqCapability = selectIqCapability(state);
  const generatorCapability = selectGeneratorCapability(state);
  const signalLabProfileCapability = selectSignalLabProfileCapability(state);

  const renderedControllerRevision = store.revision;
  useLayoutEffect(() => {
    kernel.renderCommit.publish(renderedControllerRevision);
  });

  useEffect(() => {
    kernel.rendererMounted.current = true;
    return () => {
      kernel.rendererMounted.current = false;
      kernel.renderCommit.rejectAllForUnmount();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.atomizerInstrument.subscribe(kernel.events.handleInstrumentEvent);
    const generation = ++kernel.initializationGeneration.current;
    void kernel.events.initialize(generation);
    return () => {
      kernel.initializationGeneration.current++;
      runtime.classification.dispose();
      if (kernel.continuousRequested.current && kernel.continuousStreamOwnership.current) {
        void window.atomizerInstrument.stopStreaming().catch((value) => {
          console.error('Continuous acquisition did not stop while the Atomizer renderer unmounted', value);
        });
      }
      kernel.continuousRequested.current = false;
      kernel.events.rejectInvalidatingFeatureReceipt(new Error('Atomizer renderer unmounted before the invalidating feature lifecycle settled'));
      unsubscribe();
    };
  }, []);
  // Mount-time persistence parity with the retired per-key effects: a
  // quarantined key's restored default is written back to storage.
  useEffect(() => { store.persistAll(); }, []);
  useEffect(() => {
    store.setKey('channelConfiguration', (current) => fitChannelConfigurationToSpan(current, state.analyzer.startHz, state.analyzer.stopHz));
  }, [state.analyzer.startHz, state.analyzer.stopHz]);
  useEffect(() => {
    if (session && !generatorCapability && !signalLabProfileCapability && workspace === 'generator') store.set({ workspace: 'spectrum' });
  }, [session, generatorCapability, signalLabProfileCapability, workspace]);
  useEffect(() => {
    if (session && !iqCapability && workspace === 'iq') store.set({ workspace: 'spectrum' });
  }, [session, iqCapability, workspace]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => store.set({ notice: undefined }), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    // React's development build emits one user-timing measure per component
    // per commit; at 20 sweeps/s the retained entries alone exhaust the dev
    // renderer heap within a minute of streaming. Sweep the timeline
    // periodically — development only; the production build emits none.
    if (!DEVELOPMENT_RENDERER || typeof performance.clearMeasures !== 'function') return;
    const interval = window.setInterval(() => {
      performance.clearMeasures();
      performance.clearMarks();
      performance.clearResourceTimings?.();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, []);

  const agent = useAtomAgent({ applicationContext: runtime.agent.applicationContext, execute: runtime.agent.executeAgentTool });
  const contextualAcquisitionMode = acquisitionModeForSession(iqCapability !== undefined);
  const acquisitionDisabledReason = selectAcquisitionDisabledReason(state, busy);
  const measurementActions = sweep ? <MeasurementActions runtime={runtime}/> : null;

  return <main className={`app-shell ${agentOpen ? 'ai-open' : ''}`}>
    <TopBar instrument={instrument} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)} onConnection={() => store.set({ connectionOpen: true })} onAgent={() => store.setKey('agentOpen', (value) => !value)}/>
    <Sidebar
      active={workspace}
      measurementView={measurementView}
      output={generatorOutput}
      generationAvailable={generatorCapability !== undefined || signalLabProfileCapability !== undefined}
      iqAvailable={iqCapability !== undefined}
      spectrumAvailable={selectSpectrumCapability(state) !== undefined}
      connected={connected}
      acquisition={acquisition}
      continuous={continuous}
      acquisitionMode={continuous ? continuousMode : contextualAcquisitionMode}
      acquisitionBusy={busy}
      acquisitionDisabled={acquisitionDisabledReason !== undefined}
      acquisitionDisabledReason={acquisitionDisabledReason}
      latestSweep={sweep ? { id: sweep.id, sequence: sweep.sequence } : undefined}
      onSelect={(next) => kernel.changeWorkspace(next)}
      onMeasurementView={(view) => runtime.measurement.changeMeasurementView(view)}
      onRun={() => void runtime.acquisition.startContinuousFromUi()}
      onSingle={() => void runtime.acquisition.acquireFromUi()}
      onStop={() => void runtime.acquisition.stopContinuousFromUi()}
    />
    <section className={`workspace-shell ${workspace === 'spectrum' ? 'spectrum-workspace' : ''} ${workspace === 'classification' || workspace === 'detection' ? 'classification-workspace' : ''}`}>
      {(workspace === 'classification' || workspace === 'detection') && measurementActions && <div className="workspace-command-row">{measurementActions}</div>}
      {error && <div className="global-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button data-agent-control="error.dismiss" onClick={() => store.set({ error: undefined })}>Dismiss</button></div>}
      {notice && <div className="global-notice" role="status"><span>{notice}</span><button data-agent-control="notice.dismiss" onClick={() => store.set({ notice: undefined })}>Dismiss</button></div>}
      {workspace === 'spectrum' && <MeasurementContainer runtime={runtime} measurementActions={measurementActions}/>}
      {(workspace === 'detection' || workspace === 'classification') && <DetectContainer runtime={runtime}/>}
      {workspace === 'iq' && <IqContainer runtime={runtime}/>}
      {workspace === 'generator' && <GeneratorContainer runtime={runtime}/>}
      {workspace === 'device' && <DeviceContainer runtime={runtime}/>}
    </section>
    <AtomAgentPanel open={agentOpen} state={agent.state} status={agent.status} messages={agent.messages} approval={agent.approval} execution={session?.provenance.execution} microphoneMuted={agent.microphoneMuted} speakerMuted={agent.speakerMuted} usage={agent.usage} rateLimits={agent.rateLimits} onClose={() => store.set({ agentOpen: false })} onSend={agent.sendText} onVoice={agent.startVoice} onMicrophoneMute={agent.setMicrophoneMute} onSpeakerMute={agent.setSpeakerMute} onApproval={agent.resolveApproval}/>
    <ConnectionContainer runtime={runtime}/>
  </main>;
}
