import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Mic, MicOff, RadioTower, ShieldAlert, Waves, X } from 'lucide-react';
import { ATOM_AGENT_MODEL, type AgentApprovalRequest, type AgentConnectionState, type AgentMessage, type AgentStatus } from '@tinysa/agent';
import { AtomicMark } from './AtomicMark.js';

export function AtomAgentPanel({open,state,status,messages,approval,onClose,onSend,onVoice,onApproval}:{
  open:boolean;state:AgentConnectionState;status?:AgentStatus;messages:readonly AgentMessage[];approval?:AgentApprovalRequest;
  onClose():void;onSend(text:string):void;onVoice():void;onApproval(approved:boolean):void;
}){
  const [input,setInput]=useState('');const end=useRef<HTMLDivElement>(null);useEffect(()=>{if(typeof end.current?.scrollIntoView==='function')end.current.scrollIntoView({block:'end'});},[messages,approval]);
  if(!open)return null;
  const voiceActive=['connecting','listening','thinking','speaking'].includes(state);
  function submit(){if(input.trim()){onSend(input);setInput('');}}
  return <aside className="atom-panel" aria-label="Atom AI copilot">
    <div className="atom-head"><div className="atom-identity"><div className="atom-mark"><AtomicMark size={29} active={voiceActive}/></div><span><strong>Atom</strong><small>Your RF intelligence</small></span></div><button className="icon-button" onClick={onClose} aria-label="Close Atom"><X size={17}/></button></div>
    <div className={`voice-stage ${voiceActive?'active':''}`}><div className="voice-ambient"><i/><i/><i/><button onClick={onVoice} disabled={!status?.configured} aria-label={voiceActive?'End voice session':'Start voice session'}>{voiceActive?<MicOff size={20}/>:<Mic size={20}/>}</button></div><div><small>VOICE LINK</small><strong>{voiceLabel(state)}</strong><span>{status?.configured?'Realtime · tools armed':'OPENAI_KEY required'}</span></div></div>
    <div className="atom-context"><span><RadioTower size={12}/>Instrument context</span><span className={status?.configured?'online':''}>{status?.configured?'LIVE':'OFFLINE'}</span></div>
    <div className="atom-messages">{messages.map(message=><div key={message.id} className={`atom-message ${message.role} ${message.status??''}`}><span>{message.role==='assistant'?<AtomicMark size={14}/>:message.role==='tool'?<Check size={12}/>:message.role==='system'?<ShieldAlert size={12}/>:null}</span><p>{message.text}</p></div>)}
      {approval&&<div className="approval-card"><div><ShieldAlert size={17}/><span><strong>Approval required</strong><small>PHYSICAL INSTRUMENT ACTION</small></span></div><p>{approval.summary}. {approval.tool==='set_rf_output'?'Confirm only after checking the connected load and attenuation.':'The physical firmware UI may expose RF-output controls; verify the screen state before proceeding.'}</p><div><button onClick={()=>onApproval(false)}>Deny</button><button data-agent-control="atom.approve-high-impact" data-agent-risk="high-impact" className="approve" onClick={()=>onApproval(true)}>Approve action</button></div></div>}
      <div ref={end}/>
    </div>
    {!messages.some(message=>message.role==='user')&&<div className="atom-prompts"><button onClick={()=>onSend('Set up an FM broadcast band sweep and explain what I should look for.')}><Waves size={14}/><span><strong>Survey the FM band</strong><small>Configure, sweep, and explain</small></span><ChevronRight size={14}/></button><button onClick={()=>onSend('Inspect the current instrument state and tell me if anything looks unsafe or inconsistent.')}><ShieldAlert size={14}/><span><strong>Run a safety check</strong><small>Review mode, limits, and RF state</small></span><ChevronRight size={14}/></button></div>}
    <div className="atom-composer"><textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit();}}} placeholder={status?.configured?'Ask Atom anything about this RF session…':'OPENAI_KEY required'} disabled={!status?.configured}/><button onClick={submit} disabled={!status?.configured||!input.trim()} aria-label="Send to Atom"><ArrowUp size={16}/></button></div>
    <div className="atom-foot"><span><i className={status?.configured?'online':''}/>{state.toUpperCase()}</span><span>{ATOM_AGENT_MODEL} · VOICE {status?.voice.toUpperCase()??'UNAVAILABLE'} · REASONING {status?.reasoningEffort?.toUpperCase()??'UNAVAILABLE'} · {transportLabel(status)}</span></div>
  </aside>;
}
function voiceLabel(state:AgentConnectionState){return state==='connecting'?'Opening secure voice…':state==='listening'?'Listening':state==='thinking'?'Working with your instrument':state==='speaking'?'Atom is speaking':state==='unconfigured'?'Atom is ready to configure':state==='error'?'Needs attention':'Talk to your spectrum';}
function transportLabel(status?:AgentStatus){return status?.configured?'REALTIME TEXT':'REALTIME';}
