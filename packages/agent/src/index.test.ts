import { describe, expect, it } from 'vitest';
import { TINYSA_API_V2_METHODS } from '@tinysa/contracts';
import { ATOM_AGENT_INSTRUCTIONS, ATOM_AGENT_MODEL, ATOM_AGENT_REASONING_EFFORT, ATOM_AGENT_TRANSCRIPTION_MODEL, ATOM_AGENT_VAD_THRESHOLD, ATOM_AGENT_VOICE, agentApiCoverage, agentControlBinding, agentControlBindings, agentSemanticControlIds, agentToolDefinitions, agentToolPolicies, createAtomRealtimeVoiceSessionConfig, realtimeToolDefinitions, validateAgentToolCall, verifyAtomRealtimeVoiceSession } from './index.js';

describe('Atom agent contracts',()=>{
  it('locks the requested model exactly',()=>expect(ATOM_AGENT_MODEL).toBe('gpt-realtime-2.1-mini'));
  it('locks Atom reasoning effort',()=>expect(ATOM_AGENT_REASONING_EFFORT).toBe('high'));
  it('locks Ballad and the explicit server VAD threshold',()=>{
    const session=createAtomRealtimeVoiceSessionConfig();
    expect(ATOM_AGENT_VOICE).toBe('ballad');expect(ATOM_AGENT_VAD_THRESHOLD).toBe(0.97);
    expect(session.audio.output.voice).toBe('ballad');expect(session.audio.input.turn_detection.threshold).toBe(0.97);
    expect(ATOM_AGENT_TRANSCRIPTION_MODEL).toBe('gpt-realtime-whisper');
    expect(session.audio.input.transcription).toEqual({model:'gpt-realtime-whisper'});
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
  it('gives every tool one closed concrete object input schema',()=>{
    expect(agentToolDefinitions).toHaveLength(53);
    for(const tool of agentToolDefinitions){
      expect(tool.parameters.type,tool.name).toBe('object');
      expect(tool.parameters.properties,tool.name).toBeTypeOf('object');
      expect(tool.parameters.required,tool.name).toBeInstanceOf(Array);
      expect(tool.parameters.additionalProperties,tool.name).toBe(false);
    }
  });
  it('locks Atom prompt behavior for state, patches, correction, provenance, and concise speech',()=>{
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('Read system topology and application state');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('configure_analyzer is an application-layer patch');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('correct a rejected schema request once');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('custom-unqualified');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('Every word must earn its place');
  });
  it('exposes the identical complete tool surface to text and voice',()=>{
    expect(realtimeToolDefinitions.map(tool=>tool.name)).toEqual(agentToolDefinitions.map(tool=>tool.name));
    expect(realtimeToolDefinitions.map(tool=>tool.name)).toEqual(expect.arrayContaining(['computer_screenshot','computer_click','computer_type','computer_key','computer_scroll']));
  });
  it('binds every semantic and patterned UI hook to exactly one existing typed tool contract',()=>{
    const tools=new Set(agentToolDefinitions.map(tool=>tool.name));
    expect(new Set(Object.keys(agentToolPolicies))).toEqual(tools);
    for(const controlId of agentSemanticControlIds){
      const binding=agentControlBinding(controlId);
      expect(tools.has(binding.preferredTool)).toBe(true);
      expect(binding.guarantee.length).toBeGreaterThan(20);
      expect(binding.risk).not.toBe('high-impact');
    }
    for(const binding of agentControlBindings)expect(tools.has(binding.preferredTool)).toBe(true);
    expect(agentControlBinding('classification.candidate.signal-12.select').preferredTool).toBe('select_classification_candidate');
    expect(()=>agentControlBinding('unknown.uncontracted-control')).toThrow(/0 contract bindings/);
  });
  it('has an evidence and failure disposition for every TinySaApiV2 method',()=>{
    expect(Object.keys(agentApiCoverage)).toEqual(TINYSA_API_V2_METHODS);
    const tools=new Set(agentToolDefinitions.map(tool=>tool.name));
    for(const coverage of Object.values(agentApiCoverage)){
      expect(coverage.tools.length).toBeGreaterThan(0);
      for(const tool of coverage.tools)expect(tools.has(tool)).toBe(true);
      expect(coverage.guarantee.length).toBeGreaterThan(20);
      expect(coverage.failure.length).toBeGreaterThan(20);
    }
  });
  it('rejects unknown tools and malformed arguments',()=>{
    expect(()=>validateAgentToolCall({callId:'1',name:'raw_serial',arguments:'{}'})).toThrow(/Unknown/);
    expect(()=>validateAgentToolCall({callId:'1',name:'configure_analyzer',arguments:'{"startHz":2,"stopHz":1,"points":450,"rbwKhz":null,"attenuationDb":"auto"}'})).toThrow();
  });
  it('accepts non-empty analyzer patches and rejects empty or invalid patches',()=>{
    expect(validateAgentToolCall({callId:'1',name:'configure_analyzer',arguments:'{"startHz":93000000,"stopHz":95000000}'}).args).toEqual({startHz:93000000,stopHz:95000000});
    expect(validateAgentToolCall({callId:'2',name:'configure_analyzer',arguments:'{"lna":"on"}'}).args).toEqual({lna:'on'});
    expect(()=>validateAgentToolCall({callId:'3',name:'configure_analyzer',arguments:'{}'})).toThrow(/at least one/i);
    expect(()=>validateAgentToolCall({callId:'4',name:'configure_analyzer',arguments:'{"lna":null}'})).toThrow();
  });
  it('marks RF output as high impact',()=>expect(validateAgentToolCall({callId:'1',name:'set_rf_output',arguments:'{"enabled":true}'}).policy.approval).toBe('at-action'));
  it('requires an opaque candidate ID for device connection',()=>{
    expect(validateAgentToolCall({callId:'1',name:'connect_device',arguments:'{"candidateId":"candidate-1"}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'1',name:'connect_device',arguments:'{"candidateId":"/dev/cu.usbmodem"}'})).toThrow();
  });
  it('gives Atom closed marker, trace, display, and channel operations',()=>{
    expect(validateAgentToolCall({callId:'0',name:'select_marker',arguments:'{"markerId":8}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'1',name:'configure_trace',arguments:'{"id":2,"mode":"max-hold","averageCount":8}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'1b',name:'select_trace',arguments:'{"traceId":4}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'2',name:'configure_marker',arguments:'{"id":1,"enabled":true,"traceId":2,"mode":"normal","frequencyHz":98000000,"tracking":"peak"}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'4',name:'reset_trace',arguments:'{"traceId":5}'})).toThrow();
    expect(validateAgentToolCall({callId:'5',name:'configure_marker_search',arguments:'{"minimumLevelDbm":-95,"minimumExcursionDb":8}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'6',name:'auto_scale_spectrum_display',arguments:'{}'}).policy.risk).toBe('operate');
  });
  it('gives Atom complete advanced-measurement hooks with closed evidence settings',()=>{
    expect(validateAgentToolCall({callId:'1',name:'set_measurement_view',arguments:'{"view":"waterfall"}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'2',name:'configure_waterfall',arguments:'{"historyDepth":35,"floorDbm":-120,"ceilingDbm":-20,"palette":"atomic"}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'3',name:'configure_channel_measurement',arguments:'{"centerHz":98000000,"mainBandwidthHz":200000,"adjacentBandwidthHz":200000,"channelSpacingHz":200000,"adjacentChannelCount":2,"occupiedPowerPercent":99,"obwNoiseCorrection":"none"}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'4',name:'configure_envelope_stft',arguments:'{"windowSize":64,"hopSize":16,"window":"hann","removeDc":true,"dynamicRangeDb":80}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'5',name:'get_channel_measurement_results',arguments:'{}'}).policy.risk).toBe('observe');
    expect(()=>validateAgentToolCall({callId:'6',name:'configure_envelope_stft',arguments:'{"windowSize":64,"hopSize":128,"window":"hann","removeDc":true,"dynamicRangeDb":80}'})).toThrow();
    expect(validateAgentToolCall({callId:'7',name:'select_classification_candidate',arguments:'{"detectionId":"signal-12"}'}).policy.risk).toBe('operate');
  });
});
