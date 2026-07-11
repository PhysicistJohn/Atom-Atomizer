import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Clock3, LoaderCircle, Play, RadioTower, Square, Zap } from 'lucide-react';
import type { AnalyzerConfig, DeviceSnapshot, GeneratorConfig, PortCandidate, SignalDetectionConfig, Sweep } from '@tinysa/contracts';
import { SignalDetector } from '@tinysa/analysis';
import { AnalyzerInspector } from './components/AnalyzerInspector.js';
import { ClassificationWorkspace } from './components/ClassificationWorkspace.js';
import { ConnectionDialog } from './components/ConnectionDialog.js';
import { DetectionWorkspace } from './components/DetectionWorkspace.js';
import { GeneratorWorkspace } from './components/GeneratorWorkspace.js';
import { Sidebar } from './components/Sidebar.js';
import { SpectrumPlot } from './components/SpectrumPlot.js';
import { TopBar } from './components/TopBar.js';
import { formatFrequency, formatLevel, median } from './format.js';
import { assertWorkspaceTransition, DEFAULT_ANALYZER, DEFAULT_GENERATOR, DISCONNECTED_SNAPSHOT, type AcquisitionState, type WorkspaceId, workspaceCopy } from './ui-contracts.js';
import { useAtomAgent } from './useAtomAgent.js';
import { AtomAgentPanel } from './components/AtomAgentPanel.js';
import type { AgentToolName } from '@tinysa/agent';

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceId>('spectrum');
  const [agentOpen,setAgentOpen]=useState(true);
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>(DISCONNECTED_SNAPSHOT);
  const [ports, setPorts] = useState<PortCandidate[]>([]); const [selectedPortId, setSelectedPortId] = useState<string>();
  const [connectionOpen, setConnectionOpen] = useState(false); const [connectionBusy, setConnectionBusy] = useState(false);
  const [analyzer, setAnalyzer] = useState<AnalyzerConfig>(DEFAULT_ANALYZER); const [generator, setGenerator] = useState<GeneratorConfig>(DEFAULT_GENERATOR);
  const [detectionConfig, setDetectionConfig] = useState<SignalDetectionConfig>({ threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumConsecutiveSweeps: 1 });
  const [sweep, setSweep] = useState<Sweep>(); const [acquisition, setAcquisition] = useState<AcquisitionState>('idle'); const [error, setError] = useState<string>();
  const detector = useMemo(() => new SignalDetector(detectionConfig), [detectionConfig]); const detections = useMemo(() => sweep ? detector.analyze(sweep) : [], [detector, sweep]);
  const connected = snapshot.connection === 'ready'; const busy = connectionBusy || acquisition === 'configuring' || acquisition === 'acquiring';
  const simulated = snapshot.identity?.port.path.startsWith('fake://') ?? ports.some((p)=>p.path.startsWith('fake://'));

  useEffect(() => { void refreshPorts(); }, []);
  async function refreshPorts() { try { const next=await window.tinySA.listDevices(); setPorts(next); setSelectedPortId((current)=>current&&next.some(p=>p.id===current)?current:next[0]?.id); } catch(e) { setError(errorMessage(e)); } }
  async function connectPort(port:PortCandidate):Promise<DeviceSnapshot> { setConnectionBusy(true);setError(undefined);try{const next=await window.tinySA.connect(port);setSnapshot(next);setConnectionOpen(false);return next;}catch(e){setError(errorMessage(e));throw e;}finally{setConnectionBusy(false);} }
  async function connect() { const port=ports.find(p=>p.id===selectedPortId);if(!port){setError('Select an available device before connecting');return;}try{await connectPort(port);}catch{/* Error is already visible in the connection UI. */} }
  async function disconnectDevice():Promise<void> { setConnectionBusy(true);setError(undefined);try{await window.tinySA.disconnect();setSnapshot(DISCONNECTED_SNAPSHOT);setAcquisition('idle');}catch(e){setError(errorMessage(e));throw e;}finally{setConnectionBusy(false);} }
  async function disconnect() { try{await disconnectDevice();}catch{/* Error is already visible in the connection UI. */} }
  async function acquire():Promise<Sweep> { setError(undefined);setAcquisition('configuring');try{setSnapshot(await window.tinySA.configureAnalyzer(analyzer));setAcquisition('acquiring');const next=await window.tinySA.acquireSweep();setSweep(next);setAcquisition('complete');return next;}catch(e){setAcquisition('failed');setError(errorMessage(e));throw e;} }
  async function acquireFromUi(){try{await acquire();}catch{/* Error is already visible in the workspace. */}}
  async function configureGeneratorFromUi(){try{await configureGeneratorWith(generator);}catch{/* Error is already visible in the workspace. */}}
  async function configureGeneratorWith(config:GeneratorConfig) { setError(undefined);setAcquisition('configuring');try{const next=await window.tinySA.configureGenerator(config);setSnapshot(next);setAcquisition('complete');return next;}catch(e){setAcquisition('failed');setError(errorMessage(e));throw e;} }
  async function setOutput(enabled:boolean) { setError(undefined);setAcquisition('configuring');try{if(snapshot.mode!=='generator')setSnapshot(await window.tinySA.configureGenerator(generator));setSnapshot(await window.tinySA.setGeneratorOutput(enabled));setAcquisition('complete');}catch(e){setAcquisition('failed');setError(errorMessage(e));throw e;} }
  async function setOutputFromUi(enabled:boolean){try{await setOutput(enabled);}catch{/* Error is already visible in the workspace. */}}
  function changeWorkspace(next:WorkspaceId){try{assertWorkspaceTransition(workspace,next,snapshot.generatorOutput);setWorkspace(next);setError(undefined);}catch(e){setError(errorMessage(e));}}
  function applicationContext(){
    const peak=sweep?Math.max(...sweep.powerDbm):undefined;const floor=sweep?median(sweep.powerDbm):undefined;
    return JSON.stringify({workspace,acquisition,simulated,snapshot,analyzer,generator,detectionConfig,latestSweep:sweep?{id:sweep.id,capturedAt:sweep.capturedAt,startHz:sweep.actualStartHz,stopHz:sweep.actualStopHz,points:sweep.frequencyHz.length,peakDbm:peak,noiseFloorDbm:floor,detections:detections.length}:null});
  }
  async function executeAgentTool(name:AgentToolName,args:unknown):Promise<unknown>{
    switch(name){
      case 'get_application_state':return {workspace,acquisition,simulated,error:error??null};
      case 'get_instrument_state':return snapshot;
      case 'get_latest_sweep_summary':return JSON.parse(applicationContext()).latestSweep;
      case 'list_connection_candidates':return ports.map((port,index)=>({candidateId:`candidate-${index+1}`,manufacturer:port.manufacturer??null,simulated:port.path.startsWith('fake://'),selected:port.id===selectedPortId}));
      case 'connect_device':{const candidateId=(args as {candidateId:string}).candidateId;const match=/^candidate-([1-9][0-9]*)$/.exec(candidateId);if(!match)throw new Error('Invalid connection candidate ID');const index=Number(match[1])-1;const port=ports[index];if(!port)throw new Error(`Connection candidate ${candidateId} is no longer available`);setSelectedPortId(port.id);const next=await connectPort(port);if(!next.identity)throw new Error('Connected device did not provide an identity');return {connected:true,model:next.identity.model,firmwareVersion:next.identity.firmwareVersion,simulated:port.path.startsWith('fake://'),verification:next.verification};}
      case 'disconnect_device':await disconnectDevice();return {disconnected:true,state:'disconnected'};
      case 'inspect_interface':return {activeWorkspace:workspace,controls:{'workspace.spectrum':true,'workspace.detection':true,'workspace.classification':true,'workspace.generator':snapshot.generatorOutput!=='on'||workspace==='generator','acquisition.single':connected&&!busy,'connection.open':!connectionBusy,'atom.close':agentOpen}};
      case 'computer_action':{const control=(args as {controlId:string}).controlId;if(control.startsWith('workspace.'))changeWorkspace(control.slice('workspace.'.length) as WorkspaceId);else if(control==='acquisition.single')await acquire();else if(control==='connection.open')setConnectionOpen(true);else if(control==='atom.close')setAgentOpen(false);return {activated:control};}
      case 'computer_screenshot':return window.atomAgent.computerScreenshot();
      case 'computer_click':return window.atomAgent.computerClick(args as {x:number;y:number});
      case 'computer_type':return window.atomAgent.computerType((args as {text:string}).text);
      case 'computer_key':return window.atomAgent.computerKey((args as {key:string}).key);
      case 'computer_scroll':return window.atomAgent.computerScroll(args as {x:number;y:number;deltaX:number;deltaY:number});
      case 'navigate_workspace':changeWorkspace((args as {workspace:WorkspaceId}).workspace);return {workspace:(args as {workspace:WorkspaceId}).workspace};
      case 'configure_analyzer':{const value=args as {startHz:number;stopHz:number;points:145|290|450;rbwKhz:number|null;attenuationDb:'auto'|number};const next={startHz:value.startHz,stopHz:value.stopHz,points:value.points,rbwKhz:value.rbwKhz??undefined,attenuationDb:value.attenuationDb};setAnalyzer(next);setWorkspace('spectrum');return next;}
      case 'acquire_sweep':{const result=await acquire();return {acquired:true,sweepId:result.id,points:result.frequencyHz.length};}
      case 'configure_signal_detector':{const value=args as {strategy:'noise-relative'|'absolute';value:number;minimumBandwidthHz:number};const next={threshold:value.strategy==='noise-relative'?{strategy:'noise-relative' as const,marginDb:value.value}:{strategy:'absolute' as const,levelDbm:value.value},minimumBandwidthHz:value.minimumBandwidthHz,minimumConsecutiveSweeps:1};setDetectionConfig(next);setWorkspace('detection');return next;}
      case 'configure_generator':{const next=args as GeneratorConfig;setGenerator(next);await configureGeneratorWith(next);setWorkspace('generator');return next;}
      case 'set_rf_output':{const enabled=(args as {enabled:boolean}).enabled;await setOutput(enabled);return {enabled};}
    }
  }
  const agent=useAtomAgent({applicationContext,execute:executeAgentTool});
  const copy=workspaceCopy[workspace];

  return <main className={`app-shell ${agentOpen?'ai-open':''}`}>
    <TopBar snapshot={snapshot} simulated={simulated} agentOpen={agentOpen} agentConfigured={Boolean(agent.status?.configured)} onConnection={()=>setConnectionOpen(true)} onAgent={()=>setAgentOpen(value=>!value)}/>
    <Sidebar active={workspace} output={snapshot.generatorOutput} onSelect={changeWorkspace}/>
    <section className="workspace-shell">
      <div className="workspace-header"><div><span className="workspace-kicker">{copy.eyebrow}</span><h1>{copy.title}</h1><p>{copy.description}</p></div>{workspace!=='generator'&&<div className="acquisition-actions"><button className="primary compact" disabled={!connected||busy} onClick={()=>void acquireFromUi()}>{busy?<LoaderCircle className="spin" size={14}/>:<Play size={14} fill="currentColor"/>}{acquisition==='acquiring'?'Acquiring…':'Single sweep'}</button></div>}</div>
      {error&&<div className="global-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button onClick={()=>setError(undefined)}>Dismiss</button></div>}
      {!connected&&<div className="connection-banner"><div><RadioTower size={17}/><span><strong>No instrument connected</strong><small>Connect a tinySA or use the simulator to enable controls.</small></span></div><button className="text-button" onClick={()=>setConnectionOpen(true)}>Choose device</button></div>}
      {workspace==='spectrum'&&<div className="spectrum-layout"><AnalyzerInspector config={analyzer} disabled={busy} onChange={setAnalyzer}/><div className="spectrum-main"><SpectrumPlot sweep={sweep} busy={busy}/><MetricStrip sweep={sweep} detections={detections.length} acquisition={acquisition}/></div></div>}
      {workspace==='detection'&&<DetectionWorkspace sweep={sweep} detections={detections} busy={busy} config={detectionConfig} onConfig={setDetectionConfig}/>}
      {workspace==='classification'&&<ClassificationWorkspace sweep={sweep} detections={detections}/>}
      {workspace==='generator'&&<GeneratorWorkspace config={generator} snapshot={snapshot} busy={busy} onChange={setGenerator} onApply={configureGeneratorFromUi} onOutput={setOutputFromUi}/>}
    </section>
    <footer className="statusbar"><div><span className={`footer-dot ${connected?'ready':''}`}/>{connected?`${snapshot.identity?.model} · ${snapshot.identity?.firmwareVersion}`:'DISCONNECTED'}</div><div><span>{sweep?`${sweep.frequencyHz.length} POINTS`:'NO TRACE'}</span><span>{snapshot.verification.toUpperCase()}</span><span>API V{window.tinySA.version}</span></div></footer>
    <AtomAgentPanel open={agentOpen} state={agent.state} status={agent.status} messages={agent.messages} approval={agent.approval} onClose={()=>setAgentOpen(false)} onSend={agent.sendText} onVoice={agent.startVoice} onApproval={agent.resolveApproval}/>
    {connectionOpen&&<ConnectionDialog ports={ports} selectedId={selectedPortId} busy={connectionBusy} error={error} connected={connected} onSelect={setSelectedPortId} onRefresh={refreshPorts} onConnect={connect} onDisconnect={disconnect} onClose={()=>setConnectionOpen(false)}/>}
  </main>;
}

function MetricStrip({sweep,detections,acquisition}:{sweep?:Sweep;detections:number;acquisition:AcquisitionState}){
  const peak=sweep?Math.max(...sweep.powerDbm):Number.NaN;const floor=sweep?median(sweep.powerDbm):Number.NaN;
  return <section className="metric-strip"><div><span className="metric-icon mint"><Zap size={14}/></span><span><small>PEAK POWER</small><strong>{Number.isFinite(peak)?formatLevel(peak):'—'}</strong></span></div><div><span className="metric-icon"><Square size={13}/></span><span><small>NOISE FLOOR</small><strong>{Number.isFinite(floor)?formatLevel(floor):'—'}</strong></span></div><div><span className="metric-icon amber"><RadioTower size={14}/></span><span><small>DETECTIONS</small><strong>{String(detections).padStart(2,'0')}</strong></span></div><div><span className="metric-icon"><Clock3 size={14}/></span><span><small>LAST SWEEP</small><strong>{sweep?'JUST NOW':acquisition.toUpperCase()}</strong></span></div><div className="range-summary"><small>RANGE</small><strong>{sweep?`${formatFrequency(sweep.actualStartHz)} — ${formatFrequency(sweep.actualStopHz)}`:'—'}</strong></div></section>;
}
function errorMessage(value:unknown):string{return value instanceof Error?value.message:String(value)}
