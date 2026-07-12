import { useCallback, useEffect, useRef, useState } from 'react';
import { approvalSummary, createAtomRealtimeVoiceSessionConfig, validateAgentToolCall, verifyAtomRealtimeVoiceSession, type AgentApprovalRequest, type AgentConnectionState, type AgentMessage, type AgentStatus, type AgentToolName, type AtomRealtimeSessionVerification } from '@tinysa/agent';
import { RealtimeResponseLifecycle, buildRealtimeToolContinuation, type RealtimeToolDelivery } from './realtime-voice-lifecycle.js';

const ATOM_MICROPHONE_CONSTRAINTS: MediaTrackConstraints = { echoCancellation:true,noiseSuppression:true,autoGainControl:true };
const ACTIVE_VOICE_OWNER_KEY = Symbol.for('tinysa-atomizer.active-realtime-voice-owner');
const voiceRuntime = globalThis as typeof globalThis & Record<symbol, unknown>;

export interface AtomAgentHost {
  applicationContext(): string;
  execute(name: AgentToolName, args: unknown): Promise<unknown>;
}

export function useAtomAgent(host: AtomAgentHost) {
  const hostRef=useRef(host);hostRef.current=host;
  const [status,setStatus]=useState<AgentStatus>(); const [state,setState]=useState<AgentConnectionState>('idle');
  const [messages,setMessages]=useState<AgentMessage[]>([{id:'welcome',role:'assistant',text:'Ask about the trace or tell me what to measure.',createdAt:new Date().toISOString(),status:'complete'}]);
  const [microphoneMuted,setMicrophoneMuted]=useState(true);const [speakerMuted,setSpeakerMuted]=useState(false);
  const [approval,setApproval]=useState<AgentApprovalRequest>();
  const approvalResolver=useRef<((approved:boolean)=>void)|undefined>(undefined); const pc=useRef<RTCPeerConnection|undefined>(undefined); const dc=useRef<RTCDataChannel|undefined>(undefined); const media=useRef<MediaStream|undefined>(undefined); const remoteAudio=useRef<HTMLAudioElement|undefined>(undefined); const remoteAudioTrackIds=useRef(new Set<string>()); const voiceVerificationTimeout=useRef<ReturnType<typeof setTimeout>|undefined>(undefined); const voiceSessionVerified=useRef(false); const voiceStarting=useRef(false); const voiceStartToken=useRef<symbol|undefined>(undefined); const voiceOwner=useRef(Symbol('Atom Realtime voice owner')); const microphoneMutedRef=useRef(true); const speakerMutedRef=useRef(false); const autoVoiceAttempted=useRef(false); const assistantDraft=useRef(''); const assistantStreamId=useRef<string|undefined>(undefined); const userDraft=useRef(''); const userStreamId=useRef<string|undefined>(undefined); const textConversation=useRef<string|undefined>(undefined); const voiceToolCount=useRef(0); const voiceCallIds=useRef(new Set<string>()); const voiceResponseLifecycle=useRef(new RealtimeResponseLifecycle());

  const append=useCallback((role:AgentMessage['role'],text:string,statusValue:AgentMessage['status']='complete')=>setMessages(current=>[...current,{id:crypto.randomUUID(),role,text,createdAt:new Date().toISOString(),status:statusValue}]),[]);
  useEffect(()=>{void window.atomAgent.status().then(value=>{setStatus(value);setState(value.configured?'idle':'unconfigured');}).catch(error=>{append('system',`Atom configuration failed: ${error instanceof Error?error.message:String(error)}`,'failed');setState('error');});return()=>stopVoice();},[append]);

  async function requestApproval(call:{callId:string;name:string;arguments:string},name:AgentToolName,args:unknown):Promise<boolean>{
    const decision=new Promise<boolean>(resolve=>{approvalResolver.current=resolve;});
    setApproval({id:crypto.randomUUID(),call,tool:name,summary:approvalSummary(name,args),risk:'high-impact',createdAt:new Date().toISOString()});
    return decision;
  }
  function resolveApproval(approved:boolean){approvalResolver.current?.(approved);approvalResolver.current=undefined;setApproval(undefined);}
  function setMicrophoneMute(muted:boolean){microphoneMutedRef.current=muted;setMicrophoneMuted(muted);const track=media.current?.getAudioTracks()[0];if(track)track.enabled=voiceSessionVerified.current&&!muted;}
  function setSpeakerMute(muted:boolean){speakerMutedRef.current=muted;setSpeakerMuted(muted);if(remoteAudio.current)remoteAudio.current.muted=muted;}

  async function executeCall(call:{callId:string;name:string;arguments:string}){
    let validated:ReturnType<typeof validateAgentToolCall>;
    try{validated=validateAgentToolCall(call);}
    catch(error){
      const message=error instanceof Error?error.message:String(error);
      const label=call.name.replaceAll('_',' ');
      append('tool',`${label} rejected: ${message}`,'failed');
      return {ok:false,error:`Tool call rejected by Atomizer's concrete schema: ${message}`,recoverable:true};
    }
    const needsApproval=validated.policy.approval==='at-action'&&(
      validated.name!=='set_rf_output'||(validated.args as {enabled:boolean}).enabled
    );
    if(needsApproval&&!activeExecution(hostRef.current.applicationContext())){
      const error='No connected execution backend is available for high-impact approval';append('tool',`${validated.name.replaceAll('_',' ')} failed: ${error}`,'failed');return {ok:false,error};
    }
    if(needsApproval&&!await requestApproval(call,validated.name,validated.args))return {ok:false,error:'User denied the high-impact action'};
    try{const output=await hostRef.current.execute(validated.name,validated.args);append('tool',`${validated.name.replaceAll('_',' ')} completed`);return {ok:true,output};}
    catch(error){const message=error instanceof Error?error.message:String(error);append('tool',`${validated.name.replaceAll('_',' ')} failed: ${message}`,'failed');return {ok:false,error:message};}
  }

  const sendText=useCallback(async(prompt:string)=>{
    const text=prompt.trim();if(!text||state==='thinking')return;
    append('user',text);setState('thinking');
    try{
      let turn=await window.atomAgent.agentTurn({prompt:text,conversationId:textConversation.current,applicationContext:hostRef.current.applicationContext()});textConversation.current=turn.conversationId;setStatus(current=>current?{...current,textTransport:turn.transport}:current);let loops=0;
      while(true){
        if(turn.text)append('assistant',turn.text);
        if(!turn.toolCalls.length)break;
        if(++loops>8)throw new Error('Agent exceeded the bounded tool-call loop');
        const outputs=[];
        for(const call of turn.toolCalls){
          const execution=await executeCall(call);const value=execution as {ok:boolean;output?:unknown;error?:string};
          if(value.ok&&isScreenshot(value.output))outputs.push({callId:call.callId,output:JSON.stringify({ok:true,screenshot:{width:value.output.width,height:value.output.height,capturedAt:value.output.capturedAt}}),imageDataUrl:value.output.imageDataUrl});
          else outputs.push({callId:call.callId,output:JSON.stringify(execution)});
        }
        turn=await window.atomAgent.agentTurn({conversationId:turn.conversationId,toolOutputs:outputs,applicationContext:hostRef.current.applicationContext()});textConversation.current=turn.conversationId;setStatus(current=>current?{...current,textTransport:turn.transport}:current);
      }
      setState('idle');
    }catch(error){textConversation.current=undefined;append('system',error instanceof Error?error.message:String(error),'failed');setState(status?.configured?'error':'unconfigured');}
  },[append,state,status]);

  const startVoice=useCallback(async()=>{
    if(voiceStarting.current)return;
    if(pc.current||['connecting','listening','thinking','speaking'].includes(state)){stopVoice();return;}
    voiceStarting.current=true;
    const startToken=Symbol('Atom Realtime voice start');voiceStartToken.current=startToken;
    setState('connecting');
    let connection:RTCPeerConnection|undefined;
    try{
      const activeOwner=voiceRuntime[ACTIVE_VOICE_OWNER_KEY];
      if(activeOwner&&activeOwner!==voiceOwner.current)throw new Error('A second Atom Realtime voice session attempted to start in this renderer');
      voiceRuntime[ACTIVE_VOICE_OWNER_KEY]=voiceOwner.current;
      voiceToolCount.current=0;voiceCallIds.current.clear();
      const realtimeConnection=new RTCPeerConnection();connection=realtimeConnection;pc.current=realtimeConnection;remoteAudioTrackIds.current.clear();
      const audio=document.createElement('audio');audio.autoplay=true;audio.muted=speakerMutedRef.current;remoteAudio.current=audio;realtimeConnection.ontrack=event=>{const remoteStream=event.streams[0];if(event.track.kind!=='audio'||!remoteStream){append('system','Realtime voice response did not include exactly one audio stream','failed');stopVoice('error');return;}remoteAudioTrackIds.current.add(event.track.id);if(remoteAudioTrackIds.current.size!==1){append('system','Realtime voice returned more than one remote audio track','failed');stopVoice('error');return;}const current=audio.srcObject as MediaStream|null;if(current&&current.id!==remoteStream.id){append('system','Realtime voice returned more than one remote audio stream','failed');stopVoice('error');return;}if(!current){audio.srcObject=remoteStream;console.info('[Atom Realtime] single remote audio playback path attached',{streamId:remoteStream.id,trackId:event.track.id});}};
      const stream=await navigator.mediaDevices.getUserMedia({audio:ATOM_MICROPHONE_CONSTRAINTS});
      if(voiceStartToken.current!==startToken||pc.current!==connection){for(const capturedTrack of stream.getTracks())capturedTrack.stop();return;}media.current=stream;
      const track=stream.getAudioTracks()[0];if(!track)throw new Error('No microphone audio track is available');track.enabled=false;realtimeConnection.addTrack(track,stream);
      emitMicrophoneCaptureCheck(track);
      const channel=realtimeConnection.createDataChannel('oai-events');dc.current=channel;
      channel.onopen=()=>{voiceVerificationTimeout.current=setTimeout(()=>{append('system','Realtime voice session configuration was not acknowledged within 10 seconds','failed');stopVoice('error');},10_000);};channel.onclose=()=>setState('idle');channel.onerror=()=>{append('system','Realtime voice data channel failed','failed');setState('error');};channel.onmessage=event=>{void handleRealtimeEvent(event.data).catch(error=>{append('system',`Realtime voice orchestration failed: ${error instanceof Error?error.message:String(error)}`,'failed');stopVoice('error');});};
      realtimeConnection.onconnectionstatechange=()=>{if(realtimeConnection.connectionState==='failed'||realtimeConnection.connectionState==='disconnected'){append('system',`Realtime voice connection ${realtimeConnection.connectionState}`,'failed');stopVoice('error');}else if(realtimeConnection.connectionState==='closed')stopVoice();};
      const offer=await realtimeConnection.createOffer();await realtimeConnection.setLocalDescription(offer);if(voiceStartToken.current!==startToken||pc.current!==realtimeConnection)return;
      if(!offer.sdp)throw new Error('WebRTC did not produce an SDP offer');
      const answer=await window.atomAgent.createRealtimeCall(offer.sdp);if(voiceStartToken.current!==startToken||pc.current!==realtimeConnection)return;
      await realtimeConnection.setRemoteDescription({type:'answer',sdp:answer});if(voiceStartToken.current!==startToken||pc.current!==realtimeConnection)return;
      voiceStartToken.current=undefined;voiceStarting.current=false;
    }catch(error){if(voiceStartToken.current!==startToken&&pc.current!==connection)return;append('system',error instanceof Error?error.message:String(error),'failed');stopVoice(status?.configured?'error':'unconfigured');}
  },[append,state,status]);

  useEffect(()=>{
    if(!status?.configured||state!=='idle'||autoVoiceAttempted.current)return;
    autoVoiceAttempted.current=true;
    microphoneMutedRef.current=true;setMicrophoneMuted(true);
    void startVoice();
  },[startVoice,state,status?.configured]);

  async function handleRealtimeEvent(raw:string){
    let event:Record<string,unknown>;try{event=JSON.parse(raw) as Record<string,unknown>;}catch{append('system','OpenAI returned a malformed Realtime voice event','failed');stopVoice('error');return;}
    if(event.type==='session.created'){
      const verification=verifyAtomRealtimeVoiceSession(event.session);emitRealtimeSessionCheck('session.created',verification,'initial');
      const channel=dc.current;if(!channel||channel.readyState!=='open'){append('system','Realtime voice data channel closed before session configuration','failed');stopVoice('error');return;}
      channel.send(JSON.stringify({type:'session.update',session:createAtomRealtimeVoiceSessionConfig()}));return;
    }
    if(event.type==='session.updated'){
      const verification=verifyAtomRealtimeVoiceSession(event.session);emitRealtimeSessionCheck('session.updated',verification,'enforced');
      if(!verification.ok){const paths=verification.checks.filter(check=>!check.matches).map(check=>check.path);append('system',`Realtime session configuration mismatch: ${paths.slice(0,5).join(', ')}${paths.length>5?` and ${paths.length-5} more`:''}`,'failed');stopVoice('error');return;}
      if(voiceVerificationTimeout.current)clearTimeout(voiceVerificationTimeout.current);voiceVerificationTimeout.current=undefined;
      const track=media.current?.getAudioTracks()[0];if(!track){append('system','Microphone track disappeared before Realtime configuration completed','failed');stopVoice('error');return;}voiceSessionVerified.current=true;track.enabled=!microphoneMutedRef.current;setState('listening');return;
    }
    if(event.type==='input_audio_buffer.speech_started'){voiceToolCount.current=0;setState('listening');}
    if(event.type==='response.created'){voiceResponseLifecycle.current.begin(event);setState('thinking');}
    if(event.type==='response.output_audio_transcript.delta'||event.type==='response.audio_transcript.delta'){
      if(typeof event.delta==='string'){assistantDraft.current+=event.delta;upsertStreamingMessage('assistant',assistantStreamId,assistantDraft.current);setState('speaking');}
    }
    if(event.type==='response.output_audio_transcript.done'||event.type==='response.audio_transcript.done'){
      const transcript=typeof event.transcript==='string'?event.transcript:assistantDraft.current;finalizeStreamingMessage('assistant',assistantStreamId,transcript);assistantDraft.current='';setState('listening');
    }
    if(event.type==='conversation.item.input_audio_transcription.delta'&&typeof event.delta==='string'){userDraft.current+=event.delta;upsertStreamingMessage('user',userStreamId,userDraft.current);}
    if(event.type==='conversation.item.input_audio_transcription.completed'&&typeof event.transcript==='string'){finalizeStreamingMessage('user',userStreamId,event.transcript);userDraft.current='';}
    if(event.type==='conversation.item.input_audio_transcription.failed'){
      const transcriptionError=event.error as {message?:unknown}|undefined;
      const message=typeof transcriptionError?.message==='string'?transcriptionError.message:'OpenAI input transcription failed';
      finalizeStreamingMessage('user',userStreamId,userDraft.current);userDraft.current='';
      append('system',`Voice transcript failed: ${message}`,'failed');stopVoice('error');return;
    }
    if(event.type==='response.done'){
      const completed=voiceResponseLifecycle.current.complete(event);
      if(!completed.calls.length){setState('listening');return;}
      const track=media.current?.getAudioTracks()[0];if(!track)throw new Error('Microphone track disappeared during Realtime tool execution');
      track.enabled=false;setState('thinking');
      const deliveries:RealtimeToolDelivery[]=[];
      for(const call of completed.calls){
        if(voiceCallIds.current.has(call.callId))throw new Error(`Realtime repeated function call ${call.callId}`);
        voiceCallIds.current.add(call.callId);
        if(++voiceToolCount.current>8)throw new Error('Realtime voice exceeded the bounded eight-tool operation chain');
        const result=await executeCall(call);
        const value=result as {ok:boolean;output?:unknown;error?:string};
        const screenshot=value.ok&&isScreenshot(value.output)?value.output:undefined;
        deliveries.push({callId:call.callId,output:screenshot?{ok:true,screenshot:{width:screenshot.width,height:screenshot.height,capturedAt:screenshot.capturedAt}}:result,...(screenshot?{screenshot}: {})});
      }
      voiceResponseLifecycle.current.assertIdle();
      const channel=dc.current;if(!channel||channel.readyState!=='open')throw new Error('Realtime voice data channel closed before tool result delivery');
      for(const clientEvent of buildRealtimeToolContinuation(deliveries))channel.send(JSON.stringify(clientEvent));
      if(track.readyState!=='live')throw new Error('Microphone track ended during Realtime tool execution');
      track.enabled=!microphoneMutedRef.current;setState('thinking');
    }
    if(event.type==='error'){const error=event.error as {message?:unknown}|undefined;append('system',typeof error?.message==='string'?error.message:'Realtime session failed','failed');stopVoice('error');}
  }
  function upsertStreamingMessage(role:'assistant'|'user',idRef:{current:string|undefined},text:string){if(!text)return;const id=idRef.current??crypto.randomUUID();if(!idRef.current){idRef.current=id;setMessages(current=>[...current,{id,role,text,createdAt:new Date().toISOString(),status:'streaming'}]);}else setMessages(current=>current.map(message=>message.id===id?{...message,text,status:'streaming'}:message));}
  function finalizeStreamingMessage(role:'assistant'|'user',idRef:{current:string|undefined},text:string){const id=idRef.current;if(id)setMessages(current=>current.map(message=>message.id===id?{...message,text:text||message.text,status:'complete'}:message));else if(text)append(role,text);idRef.current=undefined;}
  function stopVoice(finalState?:AgentConnectionState){if(voiceVerificationTimeout.current)clearTimeout(voiceVerificationTimeout.current);voiceVerificationTimeout.current=undefined;voiceSessionVerified.current=false;voiceStarting.current=false;voiceStartToken.current=undefined;if(voiceRuntime[ACTIVE_VOICE_OWNER_KEY]===voiceOwner.current)delete voiceRuntime[ACTIVE_VOICE_OWNER_KEY];for(const track of media.current?.getTracks()??[])track.stop();media.current=undefined;const audio=remoteAudio.current;remoteAudio.current=undefined;if(audio){audio.pause();audio.srcObject=null;}remoteAudioTrackIds.current.clear();const channel=dc.current;dc.current=undefined;if(channel){channel.onclose=null;channel.onerror=null;channel.close();}const connection=pc.current;pc.current=undefined;if(connection){connection.ontrack=null;connection.onconnectionstatechange=null;connection.close();}finalizeStreamingMessage('assistant',assistantStreamId,assistantDraft.current);finalizeStreamingMessage('user',userStreamId,userDraft.current);assistantDraft.current='';userDraft.current='';voiceToolCount.current=0;voiceCallIds.current.clear();voiceResponseLifecycle.current.reset();setState(current=>finalState??(current==='unconfigured'?'unconfigured':'idle'));}
  return {status,state,messages,approval,microphoneMuted,speakerMuted,sendText,startVoice,stopVoice,setMicrophoneMute,setSpeakerMute,resolveApproval};
}
function isScreenshot(value:unknown):value is {kind:'tinysa-atomizer-screenshot';imageDataUrl:string;width:number;height:number;capturedAt:string}{return Boolean(value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='tinysa-atomizer-screenshot');}
function activeExecution(context:string):string|undefined{try{const value=JSON.parse(context) as {topology?:{instrument?:{execution?:unknown}|null}};return typeof value.topology?.instrument?.execution==='string'?value.topology.instrument.execution:undefined;}catch(error){throw new Error(`Atom application context is malformed: ${error instanceof Error?error.message:String(error)}`);}}

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
