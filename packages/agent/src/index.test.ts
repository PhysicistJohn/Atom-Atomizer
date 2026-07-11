import { describe, expect, it } from 'vitest';
import { ATOM_AGENT_MODEL, ATOM_AGENT_REASONING_EFFORT, ATOM_AGENT_VAD_THRESHOLD, ATOM_AGENT_VOICE, agentToolDefinitions, createAtomRealtimeVoiceSessionConfig, validateAgentToolCall, verifyAtomRealtimeVoiceSession } from './index.js';

describe('Atom agent contracts',()=>{
  it('locks the requested model exactly',()=>expect(ATOM_AGENT_MODEL).toBe('gpt-realtime-2.1-mini'));
  it('locks Atom reasoning effort',()=>expect(ATOM_AGENT_REASONING_EFFORT).toBe('high'));
  it('locks Ballad and the explicit server VAD threshold',()=>{
    const session=createAtomRealtimeVoiceSessionConfig();
    expect(ATOM_AGENT_VOICE).toBe('ballad');expect(ATOM_AGENT_VAD_THRESHOLD).toBe(0.95);
    expect(session.audio.output.voice).toBe('ballad');expect(session.audio.input.turn_detection.threshold).toBe(0.95);
  });
  it('verifies every sent Realtime setting while reporting server defaults',()=>{
    const returned=structuredClone(createAtomRealtimeVoiceSessionConfig()) as Record<string,unknown>;
    returned.id='sess_test';returned.object='realtime.session';
    const verification=verifyAtomRealtimeVoiceSession(returned);
    expect(verification.ok).toBe(true);
    expect(verification.checks.length).toBeGreaterThan(40);
    expect(verification.serverOnly).toEqual(expect.arrayContaining([{path:'session.id',value:'sess_test'},{path:'session.object',value:'realtime.session'}]));
  });
  it('reports an echoed Realtime setting mismatch',()=>{
    const returned=structuredClone(createAtomRealtimeVoiceSessionConfig());returned.audio.output.voice='marin' as 'ballad';
    const verification=verifyAtomRealtimeVoiceSession(returned);
    expect(verification.ok).toBe(false);
    expect(verification.checks).toEqual(expect.arrayContaining([expect.objectContaining({path:'session.audio.output.voice',sent:'ballad',returned:'marin',matches:false})]));
  });
  it('has unique, closed tool names',()=>expect(new Set(agentToolDefinitions.map(t=>t.name)).size).toBe(agentToolDefinitions.length));
  it('rejects unknown tools and malformed arguments',()=>{
    expect(()=>validateAgentToolCall({callId:'1',name:'raw_serial',arguments:'{}'})).toThrow(/Unknown/);
    expect(()=>validateAgentToolCall({callId:'1',name:'configure_analyzer',arguments:'{"startHz":2,"stopHz":1,"points":450,"rbwKhz":null,"attenuationDb":"auto"}'})).toThrow();
  });
  it('marks RF output as high impact',()=>expect(validateAgentToolCall({callId:'1',name:'set_rf_output',arguments:'{"enabled":true}'}).policy.approval).toBe('at-action'));
  it('requires an opaque candidate ID for device connection',()=>{
    expect(validateAgentToolCall({callId:'1',name:'connect_device',arguments:'{"candidateId":"candidate-1"}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'1',name:'connect_device',arguments:'{"candidateId":"/dev/cu.usbmodem"}'})).toThrow();
  });
  it('exposes the closed Signal Lab switch as a typed operation',()=>{
    expect(validateAgentToolCall({callId:'1',name:'select_demo_signal',arguments:'{"profile":"lte-etm1.1"}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'1',name:'select_demo_signal',arguments:'{"profile":"wifi"}'})).toThrow();
  });
  it('gives Atom closed marker, trace, display, and channel operations',()=>{
    expect(validateAgentToolCall({callId:'1',name:'configure_trace',arguments:'{"id":2,"mode":"max-hold","averageCount":8}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'2',name:'configure_marker',arguments:'{"id":1,"enabled":true,"traceId":2,"mode":"normal","frequencyHz":98000000,"tracking":"peak"}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'3',name:'configure_demo_channel',arguments:'{"model":"rayleigh","noiseFloorDbm":-108,"seed":407,"fadingRateHz":2}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'4',name:'reset_trace',arguments:'{"traceId":5}'})).toThrow();
  });
});
