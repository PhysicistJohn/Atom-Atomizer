import { useCallback, useEffect, useRef, useState } from 'react';
import { agentToolPolicies, approvalSummary, createAtomRealtimeVoiceSessionConfig, isAgentToolName, isAtomToolLoaderCall, parseAtomRealtimeRateLimits, parseAtomRealtimeUsage, validateAgentToolCall, validateAtomToolLoadCall, verifyAtomRealtimeVoiceSession, type AgentApprovalRequest, type AgentConnectionState, type AgentMessage, type AgentStatus, type AgentToolName, type AtomRealtimeRateLimit, type AtomRealtimeSessionVerification, type AtomRealtimeUsage } from '@tinysa/agent';
import {
  appendBoundedAtomDraft,
  ATOM_REALTIME_EVENT_CHARACTER_LIMIT,
  ATOM_REALTIME_TOOL_CALL_LIMIT,
  boundAtomUiMessageText,
  RealtimeCallIdLedger,
  retainRecentAtomMessages,
} from './atom-agent-retention.js';
import { RealtimeResponseLifecycle, buildRealtimeToolContinuation, type RealtimeToolDelivery } from './realtime-voice-lifecycle.js';

const ATOM_MICROPHONE_CONSTRAINTS: MediaTrackConstraints = { echoCancellation:true,noiseSuppression:true,autoGainControl:true };
const ACTIVE_VOICE_OWNER_KEY = Symbol.for('atomizer.active-realtime-voice-owner');
const VOICE_MODULE_GENERATION = Symbol('Atom Realtime module generation');
export const ATOM_REALTIME_STARTUP_TIMEOUT_MILLISECONDS = 15_000;
const voiceRuntime = globalThis as typeof globalThis & Record<symbol, unknown>;

interface ActiveVoiceLease {
  readonly owner: symbol;
  readonly moduleGeneration: symbol;
  readonly mounted: () => boolean;
  readonly stop: () => void;
}

export interface AtomAgentHost {
  applicationContext(): string;
  execute(name: AgentToolName, args: unknown): Promise<unknown>;
}

type AgentOperationOwner =
  | { readonly kind: 'text'; readonly token: symbol }
  | { readonly kind: 'voice'; readonly sessionGeneration: number; readonly operationGeneration: number };

interface PendingApproval {
  readonly owner: AgentOperationOwner;
  resolve(approved: boolean): void;
}

type ValidatedAgentToolCall = ReturnType<typeof validateAgentToolCall>;
type ToolCallExecution =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: string; readonly recoverable?: boolean; readonly skipped?: true; readonly skipReason?: 'preflight' | 'failed-prior'; readonly failedCallId?: string };

interface PreflightedToolCall {
  readonly call: { callId: string; name: string; arguments: string };
  readonly validated?: ValidatedAgentToolCall;
  readonly failure?: Extract<ToolCallExecution, { ok: false }>;
  readonly failureLabel?: 'rejected' | 'failed';
}

interface ActiveBackendIdentity {
  readonly sessionId: string;
  readonly driverId: string;
  readonly sourceKind: string;
  readonly execution: string;
}

export function useAtomAgent(host: AtomAgentHost) {
  const hostRef=useRef(host);hostRef.current=host;
  const [status,setStatus]=useState<AgentStatus>(); const [state,setState]=useState<AgentConnectionState>('idle');
  const [messages,setMessages]=useState<AgentMessage[]>([{id:'welcome',role:'assistant',text:'Ask about the trace or tell me what to measure.',createdAt:new Date().toISOString(),status:'complete'}]);
  const [microphoneMuted,setMicrophoneMuted]=useState(true);const [speakerMuted,setSpeakerMuted]=useState(false);
  const [approval,setApproval]=useState<AgentApprovalRequest>();
  const [usage,setUsage]=useState<AtomRealtimeUsage>();const [rateLimits,setRateLimits]=useState<readonly AtomRealtimeRateLimit[]>();
  const mounted=useRef(true); const pendingStreamTexts=useRef(new Map<string,string>()); const streamFlushHandle=useRef<number|undefined>(undefined); const pendingApproval=useRef<PendingApproval|undefined>(undefined); const pc=useRef<RTCPeerConnection|undefined>(undefined); const dc=useRef<RTCDataChannel|undefined>(undefined); const media=useRef<MediaStream|undefined>(undefined); const remoteAudio=useRef<HTMLAudioElement|undefined>(undefined); const remoteAudioTrackIds=useRef(new Set<string>()); const voiceStartupTimeout=useRef<ReturnType<typeof setTimeout>|undefined>(undefined); const voiceVerificationTimeout=useRef<ReturnType<typeof setTimeout>|undefined>(undefined); const voiceSessionVerified=useRef(false); const voiceStarting=useRef(false); const voiceSessionGeneration=useRef(0); const voiceOperationGeneration=useRef(0); const voiceResponseOperationGeneration=useRef<number|undefined>(undefined); const voiceContinuationOwner=useRef<AgentOperationOwner|undefined>(undefined); const voiceOwner=useRef(Symbol('Atom Realtime voice owner')); const microphoneMutedRef=useRef(true); const speakerMutedRef=useRef(false); const autoVoiceAttempted=useRef(false); const assistantDraft=useRef(''); const assistantStreamId=useRef<string|undefined>(undefined); const userDraft=useRef(''); const userStreamId=useRef<string|undefined>(undefined); const textConversation=useRef<string|undefined>(undefined); const textInFlight=useRef(false); const textOperationToken=useRef<symbol|undefined>(undefined); const textCallIds=useRef(new RealtimeCallIdLedger()); const voiceToolCount=useRef(0); const voiceCallIds=useRef(new RealtimeCallIdLedger()); const voiceLoadedToolNames=useRef<readonly AgentToolName[]>([]); const voiceResponseLifecycle=useRef(new RealtimeResponseLifecycle());

  const append=useCallback((role:AgentMessage['role'],text:string,statusValue:AgentMessage['status']='complete')=>{if(!mounted.current)return;const bounded=boundAtomUiMessageText(text);setMessages(current=>retainRecentAtomMessages([...current,{id:crypto.randomUUID(),role,text:bounded,createdAt:new Date().toISOString(),status:statusValue}]));},[]);
  useEffect(()=>{
    mounted.current=true;
    void window.atomAgent.status().then(value=>{if(!mounted.current)return;setStatus(value);setState(value.configured?'idle':'unconfigured');}).catch(error=>{if(!mounted.current)return;append('system',`Atom configuration failed: ${error instanceof Error?error.message:String(error)}`,'failed');setState('error');});
    return()=>{mounted.current=false;textOperationToken.current=undefined;textInFlight.current=false;cancelPendingApproval();stopVoice(undefined,undefined,false);};
  },[append]);

  async function requestApproval(call:{callId:string;name:string;arguments:string},name:AgentToolName,args:unknown,owner:AgentOperationOwner):Promise<boolean>{
    if(!operationIsActive(owner))return false;
    if(pendingApproval.current)throw new Error('Another Atom approval is already pending');
    const decision=new Promise<boolean>(resolve=>{pendingApproval.current={owner,resolve};});
    if(mounted.current)setApproval({id:crypto.randomUUID(),call,tool:name,summary:approvalSummary(name,args),risk:'high-impact',createdAt:new Date().toISOString()});
    const approved=await decision;
    return operationIsActive(owner)&&approved;
  }
  function resolveApproval(approved:boolean){const pending=pendingApproval.current;if(!pending)return;pendingApproval.current=undefined;if(mounted.current)setApproval(undefined);pending.resolve(approved);}
  function cancelPendingApproval(matches:(owner:AgentOperationOwner)=>boolean=()=>true){const pending=pendingApproval.current;if(!pending||!matches(pending.owner))return;pendingApproval.current=undefined;if(mounted.current)setApproval(undefined);pending.resolve(false);}
  function setMicrophoneMute(muted:boolean){microphoneMutedRef.current=muted;setMicrophoneMuted(muted);const track=media.current?.getAudioTracks()[0];if(track)track.enabled=voiceSessionVerified.current&&!muted;}
  function setSpeakerMute(muted:boolean){speakerMutedRef.current=muted;setSpeakerMuted(muted);if(remoteAudio.current)remoteAudio.current.muted=muted;}

  function operationIsActive(owner:AgentOperationOwner):boolean{
    return owner.kind==='text'
      ? textInFlight.current&&textOperationToken.current===owner.token
      : voiceSessionGeneration.current===owner.sessionGeneration&&voiceOperationGeneration.current===owner.operationGeneration&&pc.current!==undefined;
  }

  function preflightCall(call:{callId:string;name:string;arguments:string},authorizedToolNames:readonly AgentToolName[]):PreflightedToolCall{
    let validated:ValidatedAgentToolCall;
    try{validated=validateAgentToolCall(call);}
    catch(error){
      const message=error instanceof Error?error.message:String(error);
      return {call,failure:{ok:false,error:`Tool call rejected by Atomizer's concrete schema: ${message}`,recoverable:true},failureLabel:'rejected'};
    }
    if(!authorizedToolNames.includes(validated.name)){
      return {call,failure:{ok:false,error:`Tool ${validated.name} was not present in the exact response-scoped tool set`},failureLabel:'rejected'};
    }
    return {call,validated};
  }

  async function executePreflightedCall(entry:PreflightedToolCall,owner:AgentOperationOwner):Promise<ToolCallExecution|undefined>{
    const {call,validated}=entry;if(!validated||!operationIsActive(owner))return undefined;
    const needsApproval=validated.policy.approval==='at-action'&&(
      validated.name!=='set_rf_output'||(validated.args as {enabled:boolean}).enabled
    );
    if(needsApproval){
      let approvedIdentity:ActiveBackendIdentity;
      try{approvedIdentity=requireActiveBackendIdentity(hostRef.current.applicationContext());}
      catch(error){
        if(!operationIsActive(owner))return undefined;
        const message=error instanceof Error?error.message:String(error);append('tool',`${validated.name.replaceAll('_',' ')} failed: ${message}`,'failed');return {ok:false,error:message};
      }
      let approved:boolean;
      try{approved=await requestApproval(call,validated.name,validated.args,owner);}
      catch(error){
        if(!operationIsActive(owner))return undefined;
        const message=error instanceof Error?error.message:String(error);append('tool',`${validated.name.replaceAll('_',' ')} failed: ${message}`,'failed');return {ok:false,error:message};
      }
      if(!approved){if(!operationIsActive(owner))return undefined;const error='User denied the high-impact action';append('tool',`${validated.name.replaceAll('_',' ')} denied: ${error}`,'failed');return {ok:false,error};}
      let currentIdentity:ActiveBackendIdentity;
      try{currentIdentity=requireActiveBackendIdentity(hostRef.current.applicationContext());}
      catch(error){
        if(!operationIsActive(owner))return undefined;
        const message=error instanceof Error?error.message:String(error);append('tool',`${validated.name.replaceAll('_',' ')} failed: ${message}`,'failed');return {ok:false,error:message};
      }
      if(!sameBackendIdentity(approvedIdentity,currentIdentity)){
        const error='Active execution backend changed while high-impact approval was pending';append('tool',`${validated.name.replaceAll('_',' ')} failed: ${error}`,'failed');return {ok:false,error};
      }
    }
    if(!operationIsActive(owner))return undefined;
    if(validated.policy.risk==='high-impact'&&!needsApproval){
      try{requireActiveBackendIdentity(hostRef.current.applicationContext());}
      catch(error){
        const message=error instanceof Error?error.message:String(error);append('tool',`${validated.name.replaceAll('_',' ')} failed: ${message}`,'failed');return {ok:false,error:message};
      }
    }
    try{const output=await hostRef.current.execute(validated.name,validated.args);if(!operationIsActive(owner))return undefined;append('tool',`${validated.name.replaceAll('_',' ')} completed`);return {ok:true,output};}
    catch(error){if(!operationIsActive(owner))return undefined;const message=error instanceof Error?error.message:String(error);append('tool',`${validated.name.replaceAll('_',' ')} failed: ${message}`,'failed');return {ok:false,error:message};}
  }

  async function executeCallBatch(calls:readonly {callId:string;name:string;arguments:string}[],authorizedToolNames:readonly AgentToolName[],owner:AgentOperationOwner):Promise<readonly ToolCallExecution[]|undefined>{
    if(!operationIsActive(owner))return undefined;
    const preflighted=calls.map(call=>preflightCall(call,authorizedToolNames));
    const containsAction=preflighted.some(entry=>entry.validated
      ? entry.validated.policy.risk!=='observe'
      : isAgentToolName(entry.call.name)&&agentToolPolicies[entry.call.name].risk!=='observe');
    const firstPreflightFailure=preflighted.find(entry=>entry.failure);
    if(containsAction&&firstPreflightFailure){
      const results:ToolCallExecution[]=[];
      for(const entry of preflighted){
        if(!operationIsActive(owner))return undefined;
        if(entry.failure){
          append('tool',`${entry.call.name.replaceAll('_',' ')} ${entry.failureLabel??'rejected'}: ${entry.failure.error}`,'failed');
          results.push(entry.failure);
        }else if(isSafetyCleanup(entry)){
          const execution=await executePreflightedCall(entry,owner);if(execution===undefined)return undefined;
          results.push(execution);
        }else{
          const error=`Skipped because mutating tool batch preflight failed at ${firstPreflightFailure.call.callId}`;
          append('tool',`${entry.call.name.replaceAll('_',' ')} skipped: ${error}`,'failed');
          results.push({ok:false,error,recoverable:true,skipped:true,skipReason:'preflight',failedCallId:firstPreflightFailure.call.callId});
        }
      }
      return results;
    }
    const results:ToolCallExecution[]=[];let failedCallId:string|undefined;
    for(const entry of preflighted){
      if(!operationIsActive(owner))return undefined;
      if(failedCallId&&!isSafetyCleanup(entry)){
        const error=`Skipped because prior tool call ${failedCallId} did not succeed`;
        append('tool',`${entry.call.name.replaceAll('_',' ')} skipped: ${error}`,'failed');
        results.push({ok:false,error,recoverable:true,skipped:true,skipReason:'failed-prior',failedCallId});
        continue;
      }
      if(entry.failure){
        append('tool',`${entry.call.name.replaceAll('_',' ')} ${entry.failureLabel??'rejected'}: ${entry.failure.error}`,'failed');
        results.push(entry.failure);
        if(containsAction)failedCallId=entry.call.callId;
        continue;
      }
      const execution=await executePreflightedCall(entry,owner);if(execution===undefined)return undefined;
      results.push(execution);
      if(containsAction&&!execution.ok&&!failedCallId)failedCallId=entry.call.callId;
    }
    return results;
  }

  const sendText=useCallback(async(prompt:string)=>{
    const text=prompt.trim();if(!text||textInFlight.current)return;
    if(voiceStarting.current||pc.current)stopVoice();
    const token=Symbol('Atom text operation');const owner:AgentOperationOwner={kind:'text',token};textInFlight.current=true;textOperationToken.current=token;
    if(!textConversation.current)textCallIds.current.reset();
    append('user',text);setState('thinking');
    try{
      let loadedToolNames:readonly AgentToolName[]=[];let loaded=false;let toolCount=0;
      let turn=await window.atomAgent.agentTurn({prompt:text,conversationId:textConversation.current});if(!operationIsActive(owner))return;textConversation.current=turn.conversationId;applyTurnTelemetry(turn);setStatus(current=>current?{...current,textTransport:turn.transport}:current);
      while(operationIsActive(owner)){
        if(turn.text)append('assistant',turn.text);
        if(!turn.toolCalls.length)break;
        if(turn.toolCalls.length>ATOM_REALTIME_TOOL_CALL_LIMIT)throw new Error(`Agent exceeded the bounded ${ATOM_REALTIME_TOOL_CALL_LIMIT}-tool operation`);
        const outputs=[];
        const loaderCalls=turn.toolCalls.filter(isAtomToolLoaderCall);
        if(loaderCalls.length){
          if(turn.toolCalls.length!==1)throw new Error('load_atom_tools must be the only call in its Realtime response');
          if(loaded)throw new Error('load_atom_tools may appear only once in one Atom text operation');
          textCallIds.current.recordCalls(turn.toolCalls);
          loadedToolNames=validateAtomToolLoadCall(loaderCalls[0]!);
          loaded=true;
          append('tool',`Loaded ${loadedToolNames.join(', ')}`);
          outputs.push({callId:loaderCalls[0]!.callId,output:JSON.stringify({ok:true,loadedToolNames})});
        }else{
          if(!loadedToolNames.length)throw new Error('Realtime returned an application tool before an exact tool set was loaded');
          const nextToolCount=toolCount+turn.toolCalls.length;if(nextToolCount>ATOM_REALTIME_TOOL_CALL_LIMIT)throw new Error(`Agent exceeded the bounded ${ATOM_REALTIME_TOOL_CALL_LIMIT}-tool operation`);
          textCallIds.current.recordCalls(turn.toolCalls);toolCount=nextToolCount;
          const executions=await executeCallBatch(turn.toolCalls,loadedToolNames,owner);if(executions===undefined)return;
          for(let index=0;index<turn.toolCalls.length;index++){
            const call=turn.toolCalls[index]!;const execution=executions[index]!;const value=execution as {ok:boolean;output?:unknown;error?:string};
            if(value.ok&&isScreenshot(value.output))outputs.push({callId:call.callId,output:JSON.stringify({ok:true,screenshot:{screenshotId:value.output.screenshotId,width:value.output.width,height:value.output.height,capturedAt:value.output.capturedAt,focusedTarget:value.output.focusedTarget}}),imageDataUrl:value.output.imageDataUrl});
            else outputs.push({callId:call.callId,output:JSON.stringify(execution)});
          }
        }
        if(!operationIsActive(owner))return;
        turn=await window.atomAgent.agentTurn({conversationId:turn.conversationId,toolOutputs:outputs,loadedToolNames});if(!operationIsActive(owner))return;textConversation.current=turn.conversationId;applyTurnTelemetry(turn);setStatus(current=>current?{...current,textTransport:turn.transport}:current);
      }
      if(operationIsActive(owner))setState('idle');
    }catch(error){if(operationIsActive(owner)){textConversation.current=undefined;textCallIds.current.reset();append('system',error instanceof Error?error.message:String(error),'failed');setState(status?.configured?'error':'unconfigured');}}
    finally{if(textOperationToken.current===token){textOperationToken.current=undefined;textInFlight.current=false;}}
  },[append,status]);

  const startVoice=useCallback(async()=>{
    if(textInFlight.current)return;
    if(voiceStarting.current||pc.current){stopVoice();return;}
    voiceStarting.current=true;
    const generation=voiceSessionGeneration.current+1;voiceSessionGeneration.current=generation;voiceOperationGeneration.current=0;
    setState('connecting');
    try{
      const activeLease=readActiveVoiceLease();
      if(activeLease&&activeLease.owner!==voiceOwner.current){
        if(activeLease.moduleGeneration!==VOICE_MODULE_GENERATION||!activeLease.mounted())activeLease.stop();
        else throw new Error('A second Atom Realtime voice session attempted to start in this renderer');
      }
      voiceRuntime[ACTIVE_VOICE_OWNER_KEY]={owner:voiceOwner.current,moduleGeneration:VOICE_MODULE_GENERATION,mounted:()=>mounted.current,stop:()=>stopVoice(undefined,undefined,false)} satisfies ActiveVoiceLease;
      voiceToolCount.current=0;voiceCallIds.current.reset();voiceLoadedToolNames.current=[];
      const realtimeConnection=new RTCPeerConnection();pc.current=realtimeConnection;remoteAudioTrackIds.current.clear();
      voiceStartupTimeout.current=setTimeout(()=>{
        if(!voiceSessionIsActive(generation,realtimeConnection))return;
        append('system',`Realtime voice startup did not complete within ${ATOM_REALTIME_STARTUP_TIMEOUT_MILLISECONDS/1_000} seconds`,'failed');
        stopVoice('error',generation);
      },ATOM_REALTIME_STARTUP_TIMEOUT_MILLISECONDS);
      const audio=document.createElement('audio');audio.autoplay=true;audio.muted=speakerMutedRef.current;remoteAudio.current=audio;realtimeConnection.ontrack=event=>{if(!voiceSessionIsActive(generation,realtimeConnection))return;const remoteStream=event.streams[0];if(event.track.kind!=='audio'||!remoteStream){append('system','Realtime voice response did not include exactly one audio stream','failed');stopVoice('error',generation);return;}remoteAudioTrackIds.current.add(event.track.id);if(remoteAudioTrackIds.current.size!==1){append('system','Realtime voice returned more than one remote audio track','failed');stopVoice('error',generation);return;}const current=audio.srcObject as MediaStream|null;if(current&&current.id!==remoteStream.id){append('system','Realtime voice returned more than one remote audio stream','failed');stopVoice('error',generation);return;}if(!current){audio.srcObject=remoteStream;console.info('[Atom Realtime] single remote audio playback path attached',{streamId:remoteStream.id,trackId:event.track.id});}};
      const stream=await navigator.mediaDevices.getUserMedia({audio:ATOM_MICROPHONE_CONSTRAINTS});
      if(!voiceSessionIsActive(generation,realtimeConnection)){for(const capturedTrack of stream.getTracks())capturedTrack.stop();return;}media.current=stream;
      const track=stream.getAudioTracks()[0];if(!track)throw new Error('No microphone audio track is available');track.enabled=false;realtimeConnection.addTrack(track,stream);
      emitMicrophoneCaptureCheck(track);
      const channel=realtimeConnection.createDataChannel('oai-events');dc.current=channel;
      channel.onopen=()=>{if(!voiceSessionIsActive(generation,realtimeConnection)||dc.current!==channel)return;voiceVerificationTimeout.current=setTimeout(()=>{if(!voiceSessionIsActive(generation,realtimeConnection))return;append('system','Realtime voice session configuration was not acknowledged within 10 seconds','failed');stopVoice('error',generation);},10_000);};channel.onclose=()=>{if(voiceSessionIsActive(generation,realtimeConnection))stopVoice(undefined,generation);};channel.onerror=()=>{if(!voiceSessionIsActive(generation,realtimeConnection))return;append('system','Realtime voice data channel failed','failed');stopVoice('error',generation);};channel.onmessage=event=>{if(!voiceSessionIsActive(generation,realtimeConnection))return;void handleRealtimeEvent(event.data,generation).catch(error=>{if(!voiceSessionIsActive(generation,realtimeConnection))return;const message=error instanceof Error?error.message:String(error);console.error('[Atom Realtime] voice orchestration failed',message);append('system',`Realtime voice orchestration failed: ${message}`,'failed');stopVoice('error',generation);});};
      realtimeConnection.onconnectionstatechange=()=>{if(!voiceSessionIsActive(generation,realtimeConnection))return;if(realtimeConnection.connectionState==='failed'||realtimeConnection.connectionState==='disconnected'){append('system',`Realtime voice connection ${realtimeConnection.connectionState}`,'failed');stopVoice('error',generation);}else if(realtimeConnection.connectionState==='closed')stopVoice(undefined,generation);};
      const offer=await realtimeConnection.createOffer();await realtimeConnection.setLocalDescription(offer);if(!voiceSessionIsActive(generation,realtimeConnection))return;
      if(!offer.sdp)throw new Error('WebRTC did not produce an SDP offer');
      const answer=await window.atomAgent.createRealtimeCall(offer.sdp);if(!voiceSessionIsActive(generation,realtimeConnection))return;
      await realtimeConnection.setRemoteDescription({type:'answer',sdp:answer});if(!voiceSessionIsActive(generation,realtimeConnection))return;
      voiceStarting.current=false;
    }catch(error){if(voiceSessionGeneration.current!==generation)return;append('system',error instanceof Error?error.message:String(error),'failed');stopVoice(status?.configured?'error':'unconfigured',generation);}
  },[append,status]);

  useEffect(()=>{
    if(!status?.configured||state!=='idle'||autoVoiceAttempted.current)return;
    autoVoiceAttempted.current=true;
    microphoneMutedRef.current=true;setMicrophoneMuted(true);
    void startVoice();
  },[startVoice,state,status?.configured]);

  function voiceSessionIsActive(generation:number,connection?:RTCPeerConnection):boolean{return voiceSessionGeneration.current===generation&&pc.current!==undefined&&(connection===undefined||pc.current===connection);}

  async function handleRealtimeEvent(raw:unknown,sessionGeneration:number){
    if(!voiceSessionIsActive(sessionGeneration))return;
    if(typeof raw!=='string'||raw.length>ATOM_REALTIME_EVENT_CHARACTER_LIMIT)throw new Error(`Realtime voice event exceeded the bounded ${ATOM_REALTIME_EVENT_CHARACTER_LIMIT}-character limit or was not text`);
    let event:Record<string,unknown>;try{event=JSON.parse(raw) as Record<string,unknown>;}catch{append('system','OpenAI returned a malformed Realtime voice event','failed');stopVoice('error',sessionGeneration);return;}
    if(event.type==='session.created'){
      const verification=verifyAtomRealtimeVoiceSession(event.session);emitRealtimeSessionCheck('session.created',verification,'initial');
      const channel=dc.current;if(!channel||channel.readyState!=='open'){append('system','Realtime voice data channel closed before session configuration','failed');stopVoice('error',sessionGeneration);return;}
      channel.send(JSON.stringify({type:'session.update',session:createAtomRealtimeVoiceSessionConfig()}));return;
    }
    if(event.type==='session.updated'){
      const verification=verifyAtomRealtimeVoiceSession(event.session);emitRealtimeSessionCheck('session.updated',verification,'enforced');
      if(!verification.ok){const paths=verification.checks.filter(check=>!check.matches).map(check=>check.path);append('system',`Realtime session configuration mismatch: ${paths.slice(0,5).join(', ')}${paths.length>5?` and ${paths.length-5} more`:''}`,'failed');stopVoice('error',sessionGeneration);return;}
      if(voiceStartupTimeout.current)clearTimeout(voiceStartupTimeout.current);voiceStartupTimeout.current=undefined;
      if(voiceVerificationTimeout.current)clearTimeout(voiceVerificationTimeout.current);voiceVerificationTimeout.current=undefined;
      const track=media.current?.getAudioTracks()[0];if(!track){append('system','Microphone track disappeared before Realtime configuration completed','failed');stopVoice('error',sessionGeneration);return;}voiceSessionVerified.current=true;track.enabled=!microphoneMutedRef.current;setState('listening');return;
    }
    if(event.type==='rate_limits.updated'){
      const limits=parseAtomRealtimeRateLimits(event);setRateLimits(limits);emitRealtimeRateLimits(limits);return;
    }
    if(event.type==='error'){const error=event.error as {message?:unknown}|undefined;append('system',typeof error?.message==='string'?error.message:'Realtime session failed','failed');stopVoice('error',sessionGeneration);return;}
    if(!voiceSessionVerified.current)throw new Error(`Realtime voice event ${String(event.type)} arrived before exact session verification`);
    if(event.type==='input_audio_buffer.speech_started'){voiceOperationGeneration.current++;cancelPendingApproval(owner=>owner.kind==='voice'&&owner.sessionGeneration===sessionGeneration);voiceToolCount.current=0;voiceLoadedToolNames.current=[];setState('listening');}
    if(event.type==='response.created'){if(voiceContinuationOwner.current)throw new Error('Realtime response started before the prior tool continuation completed');voiceResponseLifecycle.current.begin(event);voiceResponseOperationGeneration.current=voiceOperationGeneration.current;setState('thinking');}
    if(event.type==='response.output_audio_transcript.delta'||event.type==='response.audio_transcript.delta'){
      if(typeof event.delta==='string'){assistantDraft.current=appendBoundedAtomDraft(assistantDraft.current,event.delta);upsertStreamingMessage('assistant',assistantStreamId,assistantDraft.current);setState('speaking');}
    }
    if(event.type==='response.output_audio_transcript.done'||event.type==='response.audio_transcript.done'){
      const transcript=typeof event.transcript==='string'?appendBoundedAtomDraft('',event.transcript):assistantDraft.current;finalizeStreamingMessage('assistant',assistantStreamId,transcript);assistantDraft.current='';setState('listening');
    }
    if(event.type==='conversation.item.input_audio_transcription.delta'&&typeof event.delta==='string'){userDraft.current=appendBoundedAtomDraft(userDraft.current,event.delta);upsertStreamingMessage('user',userStreamId,userDraft.current);}
    if(event.type==='conversation.item.input_audio_transcription.completed'&&typeof event.transcript==='string'){finalizeStreamingMessage('user',userStreamId,appendBoundedAtomDraft('',event.transcript));userDraft.current='';}
    if(event.type==='conversation.item.input_audio_transcription.failed'){
      const transcriptionError=event.error as {message?:unknown}|undefined;
      const message=typeof transcriptionError?.message==='string'?transcriptionError.message:'OpenAI input transcription failed';
      finalizeStreamingMessage('user',userStreamId,userDraft.current);userDraft.current='';
      append('system',`Voice transcript failed: ${message}`,'failed');stopVoice('error',sessionGeneration);return;
    }
    if(event.type==='response.done'){
      const response=event.response;
      const responseOperationGeneration=voiceResponseOperationGeneration.current;
      const completed=voiceResponseLifecycle.current.complete(event);
      voiceResponseOperationGeneration.current=undefined;
      if(responseOperationGeneration===undefined)throw new Error(`Realtime response ${completed.responseId} was not bound to a voice operation`);
      const owner:AgentOperationOwner={kind:'voice',sessionGeneration,operationGeneration:responseOperationGeneration};
      if(!operationIsActive(owner))return;
      const responseUsage=parseAtomRealtimeUsage(response);if(responseUsage){setUsage(responseUsage);console.info('[Atom Realtime] response usage',responseUsage);}
      if(!completed.calls.length){setState('listening');return;}
      const track=media.current?.getAudioTracks()[0];if(!track)throw new Error('Microphone track disappeared during Realtime tool execution');
      track.enabled=false;setState('thinking');
      voiceContinuationOwner.current=owner;
      try{
        const deliveries:RealtimeToolDelivery[]=[];
        const loaderCalls=completed.calls.filter(isAtomToolLoaderCall);
        if(loaderCalls.length){
          if(completed.calls.length!==1)throw new Error('load_atom_tools must be the only call in its Realtime response');
          if(voiceLoadedToolNames.current.length)throw new Error('load_atom_tools may appear only once in one Atom voice operation');
          const loader=loaderCalls[0]!;
          voiceCallIds.current.recordCalls([loader]);
          voiceLoadedToolNames.current=validateAtomToolLoadCall(loader);
          append('tool',`Loaded ${voiceLoadedToolNames.current.join(', ')}`);
          deliveries.push({callId:loader.callId,output:{ok:true,loadedToolNames:voiceLoadedToolNames.current}});
        }else{
          if(!voiceLoadedToolNames.current.length)throw new Error('Realtime returned an application tool before an exact tool set was loaded');
          const nextVoiceToolCount=voiceToolCount.current+completed.calls.length;
          if(nextVoiceToolCount>ATOM_REALTIME_TOOL_CALL_LIMIT)throw new Error(`Realtime voice exceeded the bounded ${ATOM_REALTIME_TOOL_CALL_LIMIT}-tool operation chain`);
          voiceCallIds.current.recordCalls(completed.calls);
          voiceToolCount.current=nextVoiceToolCount;
          const results=await executeCallBatch(completed.calls,voiceLoadedToolNames.current,owner);if(results===undefined)return;
          for(let index=0;index<completed.calls.length;index++){
            const call=completed.calls[index]!;const result=results[index]!;
            const value=result as {ok:boolean;output?:unknown;error?:string};
            const screenshot=value.ok&&isScreenshot(value.output)?value.output:undefined;
            deliveries.push({callId:call.callId,output:screenshot?{ok:true,screenshot:{screenshotId:screenshot.screenshotId,width:screenshot.width,height:screenshot.height,capturedAt:screenshot.capturedAt,focusedTarget:screenshot.focusedTarget}}:result,...(screenshot?{screenshot}: {})});
          }
        }
        if(!operationIsActive(owner))return;
        voiceResponseLifecycle.current.assertIdle();
        const channel=dc.current;if(!channel||channel.readyState!=='open')throw new Error('Realtime voice data channel closed before tool result delivery');
        for(const clientEvent of buildRealtimeToolContinuation(deliveries,voiceLoadedToolNames.current))channel.send(JSON.stringify(clientEvent));
        if(track.readyState!=='live')throw new Error('Microphone track ended during Realtime tool execution');
        track.enabled=!microphoneMutedRef.current;setState('thinking');
      }finally{
        if(voiceContinuationOwner.current===owner)voiceContinuationOwner.current=undefined;
      }
    }
  }
  // Streaming transcript deltas arrive many times per second; committing one
  // React render per delta lets the transcript queue behind plot work under
  // continuous acquisition (observed minutes of lag during an I/Q Run). The
  // update path is rAF-coalesced latest-wins: refs always hold the newest
  // draft and at most one setMessages lands per frame.
  function flushStreamingTexts(){streamFlushHandle.current=undefined;if(!mounted.current||pendingStreamTexts.current.size===0)return;const updates=pendingStreamTexts.current;pendingStreamTexts.current=new Map();setMessages(current=>retainRecentAtomMessages(current.map(message=>{const text=updates.get(message.id);return text===undefined?message:{...message,text,status:'streaming' as const};})));}
  function scheduleStreamingFlush(){if(streamFlushHandle.current!==undefined)return;streamFlushHandle.current=typeof requestAnimationFrame==='function'?requestAnimationFrame(flushStreamingTexts):setTimeout(flushStreamingTexts,16) as unknown as number;}
  function upsertStreamingMessage(role:'assistant'|'user',idRef:{current:string|undefined},text:string){if(!text||!mounted.current)return;const bounded=boundAtomUiMessageText(text);const id=idRef.current??crypto.randomUUID();if(!idRef.current){idRef.current=id;setMessages(current=>retainRecentAtomMessages([...current,{id,role,text:bounded,createdAt:new Date().toISOString(),status:'streaming'}]));}else{pendingStreamTexts.current.set(id,bounded);scheduleStreamingFlush();}}
  function finalizeStreamingMessage(role:'assistant'|'user',idRef:{current:string|undefined},text:string){const bounded=boundAtomUiMessageText(text);const id=idRef.current;if(id)pendingStreamTexts.current.delete(id);if(id&&mounted.current)setMessages(current=>retainRecentAtomMessages(current.map(message=>message.id===id?{...message,text:bounded||message.text,status:'complete'}:message)));else if(bounded)append(role,bounded);idRef.current=undefined;}
  function applyTurnTelemetry(turn:{usage?:AtomRealtimeUsage;rateLimits?:readonly AtomRealtimeRateLimit[]}){if(turn.usage)setUsage(turn.usage);if(turn.rateLimits)setRateLimits(turn.rateLimits);}
  function stopVoice(finalState?:AgentConnectionState,expectedGeneration?:number,updateState=true){if(expectedGeneration!==undefined&&voiceSessionGeneration.current!==expectedGeneration)return;const endingGeneration=voiceSessionGeneration.current;voiceSessionGeneration.current++;voiceOperationGeneration.current++;voiceResponseOperationGeneration.current=undefined;voiceContinuationOwner.current=undefined;cancelPendingApproval(owner=>owner.kind==='voice'&&owner.sessionGeneration===endingGeneration);if(voiceStartupTimeout.current)clearTimeout(voiceStartupTimeout.current);voiceStartupTimeout.current=undefined;if(voiceVerificationTimeout.current)clearTimeout(voiceVerificationTimeout.current);voiceVerificationTimeout.current=undefined;voiceSessionVerified.current=false;voiceStarting.current=false;if(readActiveVoiceLease()?.owner===voiceOwner.current)delete voiceRuntime[ACTIVE_VOICE_OWNER_KEY];for(const track of media.current?.getTracks()??[])track.stop();media.current=undefined;const audio=remoteAudio.current;remoteAudio.current=undefined;if(audio){audio.pause();audio.srcObject=null;}remoteAudioTrackIds.current.clear();const channel=dc.current;dc.current=undefined;if(channel){channel.onopen=null;channel.onclose=null;channel.onerror=null;channel.onmessage=null;channel.close();}const connection=pc.current;pc.current=undefined;if(connection){connection.ontrack=null;connection.onconnectionstatechange=null;connection.close();}finalizeStreamingMessage('assistant',assistantStreamId,assistantDraft.current);finalizeStreamingMessage('user',userStreamId,userDraft.current);assistantDraft.current='';userDraft.current='';voiceToolCount.current=0;voiceCallIds.current.reset();voiceLoadedToolNames.current=[];voiceResponseLifecycle.current.reset();if(updateState&&mounted.current)setState(current=>finalState??(current==='unconfigured'?'unconfigured':'idle'));}
  return {status,state,messages,approval,microphoneMuted,speakerMuted,usage,rateLimits,sendText,startVoice,stopVoice,setMicrophoneMute,setSpeakerMute,resolveApproval};
}
function readActiveVoiceLease():ActiveVoiceLease|undefined{const value=voiceRuntime[ACTIVE_VOICE_OWNER_KEY];if(!value||typeof value!=='object')return undefined;const candidate=value as Partial<ActiveVoiceLease>;return typeof candidate.owner==='symbol'&&typeof candidate.moduleGeneration==='symbol'&&typeof candidate.mounted==='function'&&typeof candidate.stop==='function'?candidate as ActiveVoiceLease:undefined;}
function isScreenshot(value:unknown):value is {kind:'atomizer-screenshot';screenshotId:string;imageDataUrl:string;width:number;height:number;capturedAt:string;focusedTarget:string}{return Boolean(value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='atomizer-screenshot');}
function isSafetyCleanup(entry:PreflightedToolCall):boolean{
  const validated=entry.validated;if(!validated)return false;
  return validated.name==='stop_continuous_sweeps'
    ||validated.name==='disconnect_device'
    ||(validated.name==='set_rf_output'&&!(validated.args as {enabled:boolean}).enabled);
}
function requireActiveBackendIdentity(context:string):ActiveBackendIdentity{
  let value:unknown;try{value=JSON.parse(context);}catch(error){throw new Error(`Atom application context is malformed: ${error instanceof Error?error.message:String(error)}`);}
  const instrument=value&&typeof value==='object'&&!Array.isArray(value)
    ?(value as {topology?:{instrument?:unknown}}).topology?.instrument
    :undefined;
  if(!instrument||typeof instrument!=='object'||Array.isArray(instrument))throw new Error('No complete active execution backend identity is available for high-impact action');
  const candidate=instrument as Partial<ActiveBackendIdentity>;
  for(const key of ['sessionId','driverId','sourceKind','execution'] as const){
    if(typeof candidate[key]!=='string'||!candidate[key]!.trim())throw new Error('No complete active execution backend identity is available for high-impact action');
  }
  return {sessionId:candidate.sessionId!,driverId:candidate.driverId!,sourceKind:candidate.sourceKind!,execution:candidate.execution!};
}
function sameBackendIdentity(left:ActiveBackendIdentity,right:ActiveBackendIdentity):boolean{return left.sessionId===right.sessionId&&left.driverId===right.driverId&&left.sourceKind===right.sourceKind&&left.execution===right.execution;}

function emitRealtimeSessionCheck(eventType:string,verification:AtomRealtimeSessionVerification,phase:'initial'|'enforced'):void{
  const outcome=verification.ok?'VERIFIED':phase==='initial'?'DIFFERS — ENFORCING WITH session.update':'MISMATCH';
  const title=`[Atom Realtime] ${eventType} configuration ${outcome}`;
  console.groupCollapsed(title);
  console.table(verification.checks);
  console.info('[Atom Realtime] sent session configuration',verification.sent);
  console.info('[Atom Realtime] API-returned session configuration',verification.returned);
  console.info('[Atom Realtime] API-supplied settings and defaults',verification.serverOnly);
  if(verification.ok)console.info(title);else if(phase==='initial')console.warn(title,verification.checks.filter(check=>!check.matches));else console.error(title,verification.checks.filter(check=>!check.matches));
  console.groupEnd();
}

function emitRealtimeRateLimits(rateLimits:readonly AtomRealtimeRateLimit[]):void{
  console.groupCollapsed('[Atom Realtime] API rate limits');
  console.table(rateLimits);
  console.groupEnd();
}

function emitMicrophoneCaptureCheck(track:MediaStreamTrack):void{
  const applied=track.getSettings();
  const checks=Object.entries(ATOM_MICROPHONE_CONSTRAINTS).map(([setting,requested])=>({setting,requested,applied:applied[setting as keyof MediaTrackSettings],matches:applied[setting as keyof MediaTrackSettings]===requested}));
  console.groupCollapsed('[Atom Realtime] microphone capture settings');
  console.table(checks);
  console.info('[Atom Realtime] requested microphone constraints',ATOM_MICROPHONE_CONSTRAINTS);
  console.info('[Atom Realtime] applied microphone settings',applied);
  if(checks.every(check=>check.matches))console.info('[Atom Realtime] microphone processing settings VERIFIED');else console.warn('[Atom Realtime] browser did not report every requested microphone processing setting as applied',checks.filter(check=>!check.matches));
  console.groupEnd();
  const mismatches=checks.filter(check=>!check.matches);
  if(mismatches.length)throw new Error(`Microphone processing configuration mismatch: ${mismatches.map(check=>check.setting).join(', ')}`);
}
