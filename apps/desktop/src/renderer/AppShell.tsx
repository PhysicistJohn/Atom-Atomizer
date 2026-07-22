import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CircleAlert } from 'lucide-react';
import { AtomAgentPanel } from './components/AtomAgentPanel.js';
import { useAtomAgent } from './useAtomAgent.js';
import { DEVELOPMENT_RENDERER } from './development.js';
import type { WorkspaceId } from './ui-contracts.js';
import {
  createInitialRendererState,
  selectGeneratorCapability,
  selectIqCapability,
  selectSignalLabProfileCapability,
  shallowEqual,
  useStore,
  AtomizerStore,
  type AtomizerRendererState,
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
import { SidebarContainer } from './containers/SidebarContainer.js';
import { TopBarContainer } from './containers/TopBarContainer.js';

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

const selectAppShellState = (state: AtomizerRendererState) => ({
  workspace: state.workspace,
  agentOpen: state.agentOpen,
  error: state.error,
  notice: state.notice,
  analyzerStartHz: state.analyzer.startHz,
  analyzerStopHz: state.analyzer.stopHz,
  hasSweep: state.sweep !== undefined,
  connected: state.instrument.session !== undefined,
  iqAvailable: selectIqCapability(state) !== undefined,
  generationAvailable: selectGeneratorCapability(state) !== undefined
    || selectSignalLabProfileCapability(state) !== undefined,
  sessionExecution: state.instrument.session?.provenance.execution,
});

/**
 * The controller gate must observe every store revision, including revisions
 * whose selected UI slice is unchanged. Keeping that subscription in a
 * zero-DOM leaf preserves commit-await semantics without invalidating App.
 */
export function RenderCommitPublisher({ runtime }: { runtime: RendererRuntime }) {
  const renderedRevision = useSyncExternalStore(
    runtime.store.subscribe,
    () => runtime.store.revision,
    () => runtime.store.revision,
  );
  useLayoutEffect(() => {
    runtime.kernel.renderCommit.publish(renderedRevision);
  }, [runtime, renderedRevision]);
  return null;
}

export function App({
  initialWorkspace = 'spectrum',
  initialAgentOpen = true,
}: AppProps = {}) {
  const [runtime] = useState(() => createRendererRuntime({ initialWorkspace, initialAgentOpen }));
  const { store, kernel } = runtime;
  const state = useStore(store, selectAppShellState, shallowEqual);
  const {
    workspace, agentOpen, error, notice, analyzerStartHz, analyzerStopHz,
    hasSweep, connected, iqAvailable, generationAvailable, sessionExecution,
  } = state;

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
    store.setKey('channelConfiguration', (current) => fitChannelConfigurationToSpan(current, analyzerStartHz, analyzerStopHz));
  }, [analyzerStartHz, analyzerStopHz]);
  useEffect(() => {
    if (connected && !generationAvailable && workspace === 'generator') store.set({ workspace: 'spectrum' });
  }, [connected, generationAvailable, workspace]);
  useEffect(() => {
    if (connected && !iqAvailable && workspace === 'iq') store.set({ workspace: 'spectrum' });
  }, [connected, iqAvailable, workspace]);
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
  const availableMeasurementActions = useMemo(() => <MeasurementActions runtime={runtime}/>, [runtime]);
  const measurementActions = hasSweep ? availableMeasurementActions : null;

  return <main className={`app-shell ${agentOpen ? 'ai-open' : ''}`}>
    <RenderCommitPublisher runtime={runtime}/>
    <TopBarContainer runtime={runtime} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)}/>
    <SidebarContainer runtime={runtime}/>
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
    <AtomAgentPanel open={agentOpen} state={agent.state} status={agent.status} messages={agent.messages} approval={agent.approval} execution={sessionExecution} microphoneMuted={agent.microphoneMuted} speakerMuted={agent.speakerMuted} usage={agent.usage} rateLimits={agent.rateLimits} onClose={() => store.set({ agentOpen: false })} onSend={agent.sendText} onVoice={agent.startVoice} onMicrophoneMute={agent.setMicrophoneMute} onSpeakerMute={agent.setSpeakerMute} onApproval={agent.resolveApproval}/>
    <ConnectionContainer runtime={runtime}/>
  </main>;
}
