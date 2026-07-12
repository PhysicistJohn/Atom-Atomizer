import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TINYSA_API_V2_METHODS } from '@tinysa/contracts';
import { ATOM_AGENT_INSTRUCTIONS, ATOM_AGENT_MODEL, ATOM_AGENT_REASONING_EFFORT, ATOM_AGENT_TRANSCRIPTION_MODEL, ATOM_AGENT_VAD_THRESHOLD, ATOM_AGENT_VOICE, agentApiCoverage, agentComputerActionControlIds, agentControlBinding, agentControlBindings, agentSemanticControlIds, agentToolDefinitions, agentToolInputSchemas, agentToolPolicies, createAtomRealtimeCallBootstrapConfig, createAtomRealtimeVoiceSessionConfig, realtimeToolDefinitions, validateAgentToolCall, verifyAtomRealtimeVoiceSession, type AgentToolName } from './index.js';

const validToolArguments = {
  get_application_state: {}, get_system_topology: {}, get_agent_surface: {}, get_instrument_state: {}, get_latest_sweep_summary: {},
  get_detection_results: {}, get_classification_results: {}, read_device_diagnostics: {}, get_firmware_update_status: {}, open_firmware_update: {},
  download_firmware_update: {}, detect_firmware_dfu: {}, list_connection_candidates: {}, connect_device: { candidateId: 'candidate-1' }, disconnect_device: {},
  inspect_interface: {}, computer_action: { controlId: 'measurement.setup', action: 'activate' }, computer_screenshot: {}, computer_click: { screenshotId: '123e4567-e89b-42d3-a456-426614174000', x: 10, y: 20 },
  computer_type: { expectedTarget: 'analyzer.start', text: '98000000' }, computer_key: { expectedTarget: 'analyzer.start', key: 'ENTER' }, computer_scroll: { screenshotId: '123e4567-e89b-42d3-a456-426614174000', x: 10, y: 20, deltaX: 0, deltaY: 120 },
  navigate_workspace: { workspace: 'spectrum' }, configure_analyzer: { startHz: 93_000_000, stopHz: 95_000_000 }, acquire_sweep: {},
  start_continuous_sweeps: {}, stop_continuous_sweeps: {}, get_measurement_state: {}, select_marker: { markerId: 1 },
  configure_marker: { id: 1, enabled: true, traceId: 1, mode: 'normal', frequencyHz: 94_000_000, tracking: 'fixed' },
  configure_marker_search: { minimumLevelDbm: -95, minimumExcursionDb: 8 }, search_marker: { markerId: 1, action: 'peak' },
  select_trace: { traceId: 1 }, configure_trace: { id: 1, mode: 'clear-write', averageCount: 8 }, configure_firmware_trace_visibility: { traceId: 2, visible: false }, reset_trace: { traceId: 1 },
  configure_spectrum_display: { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }, auto_scale_spectrum_display: {},
  set_measurement_view: { view: 'spectrum' }, configure_waterfall: { historyDepth: 35, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' },
  configure_channel_measurement: { centerHz: 94_000_000, mainBandwidthHz: 200_000, adjacentBandwidthHz: 200_000, channelSpacingHz: 250_000, adjacentChannelCount: 2, occupiedPowerPercent: 99, obwNoiseCorrection: 'robust-floor' },
  get_channel_measurement_results: {}, configure_envelope_stft: { windowSize: 64, hopSize: 16, window: 'hann', removeDc: true, dynamicRangeDb: 80 },
  get_envelope_stft_results: {}, acquire_envelope_stft: {},
  configure_signal_detector: { threshold: { strategy: 'noise-relative', marginDb: 10 }, minimumBandwidthHz: 0, minimumProminenceDb: 6, minimumConsecutiveSweeps: 2, releaseAfterMissedSweeps: 2 },
  select_classification_candidate: { detectionId: 'signal-12' },
  configure_zero_span: { frequencyHz: 94_000_000, points: 290, rbwKhz: 100, attenuationDb: 'auto', sweepTimeSeconds: 0.1, trigger: { mode: 'auto' } },
  acquire_zero_span: {}, configure_generator: { frequencyHz: 100_000_000, levelDbm: -40, path: 'normal', modulation: 'off', modulationFrequencyHz: 1_000, amDepthPercent: 50, fmDeviationHz: 25_000 },
  set_rf_output: { enabled: false }, capture_device_screen: {}, remote_device_touch: { x: 120, y: 80, gesture: 'tap' }, export_latest_sweep: { format: 'csv' },
} as const satisfies Readonly<Record<AgentToolName, unknown>>;

describe('Atom agent contracts',()=>{
  it('locks the requested model exactly',()=>expect(ATOM_AGENT_MODEL).toBe('gpt-realtime-2.1-mini'));
  it('admits WebRTC with only the immutable exact model before enforcing the complete session',()=>expect(createAtomRealtimeCallBootstrapConfig()).toEqual({type:'realtime',model:'gpt-realtime-2.1-mini'}));
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
    expect(agentToolDefinitions).toHaveLength(54);
    for(const tool of agentToolDefinitions){
      expect(tool.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(tool.description.length).toBeGreaterThan(24);
      expect(tool.parameters.type,tool.name).toBe('object');
      expect(tool.parameters.properties,tool.name).toBeTypeOf('object');
      expect(tool.parameters.required,tool.name).toBeInstanceOf(Array);
      expect(tool.parameters.additionalProperties,tool.name).toBe(false);
      for(const forbidden of ['oneOf','anyOf','allOf','enum','const','not'])expect(Object.hasOwn(tool.parameters,forbidden),`${tool.name} top-level ${forbidden}`).toBe(false);
      assertClosedDescribedObjects(tool.name,tool.parameters);
    }
  });
  it('accepts one canonical call and rejects undeclared fields through both advertised and runtime schemas for all 54 tools',()=>{
    expect(Object.keys(validToolArguments).sort()).toEqual(agentToolDefinitions.map(tool=>tool.name).sort());
    expect(Object.keys(agentToolInputSchemas).sort()).toEqual(agentToolDefinitions.map(tool=>tool.name).sort());
    for(const tool of agentToolDefinitions){
      const sample=validToolArguments[tool.name];
      expect(agentToolInputSchemas[tool.name].safeParse(sample).success,`${tool.name} runtime canonical call`).toBe(true);
      const advertised=z.fromJSONSchema(tool.parameters as never);
      expect(advertised.safeParse(sample).success,`${tool.name} advertised canonical call`).toBe(true);
      const undeclared={...sample as Record<string,unknown>,__undeclared:true};
      expect(agentToolInputSchemas[tool.name].safeParse(undeclared).success,`${tool.name} runtime closure`).toBe(false);
      expect(advertised.safeParse(undeclared).success,`${tool.name} advertised closure`).toBe(false);
    }
    const analyzer=agentToolDefinitions.find(tool=>tool.name==='configure_analyzer')!;
    expect(analyzer.parameters.minProperties).toBe(1);
    expect(agentToolInputSchemas.configure_analyzer.safeParse({}).success).toBe(false);
  });
  it('locks Atom prompt behavior for state, patches, correction, provenance, and concise speech',()=>{
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('Read system topology and application state');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('configure_analyzer is a non-empty application-layer patch');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('A trigger patch is one complete discriminated object');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('Correct it once only when');
    expect(ATOM_AGENT_INSTRUCTIONS).toContain('including rbwKhz');
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
    expect(agentControlBinding('firmware-trace.2.visible').preferredTool).toBe('configure_firmware_trace_visibility');
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
    expect(validateAgentToolCall({callId:'5',name:'configure_analyzer',arguments:'{"trigger":{"mode":"auto"}}'}).args).toEqual({trigger:{mode:'auto'}});
    expect(validateAgentToolCall({callId:'6',name:'configure_analyzer',arguments:'{"trigger":{"mode":"normal","levelDbm":-60}}'}).args).toEqual({trigger:{mode:'normal',levelDbm:-60}});
    expect(()=>validateAgentToolCall({callId:'7',name:'configure_analyzer',arguments:'{"trigger":{"mode":"normal"}}'})).toThrow(/levelDbm/);
    expect(()=>validateAgentToolCall({callId:'8',name:'configure_analyzer',arguments:'{"trigger":{"mode":"auto","levelDbm":-60}}'})).toThrow();
    const parameters=agentToolDefinitions.find(tool=>tool.name==='configure_analyzer')!.parameters as {properties:Record<string,{oneOf?:readonly {required?:readonly string[]}[]}>};
    expect(parameters.properties.trigger?.oneOf?.map(branch=>branch.required)).toEqual([['mode'],['mode','levelDbm']]);
  });
  it('marks RF output as high impact',()=>expect(validateAgentToolCall({callId:'1',name:'set_rf_output',arguments:'{"enabled":true}'}).policy.approval).toBe('at-action'));
  it('requires an opaque candidate ID for device connection',()=>{
    expect(validateAgentToolCall({callId:'1',name:'connect_device',arguments:'{"candidateId":"candidate-1"}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'1',name:'connect_device',arguments:'{"candidateId":"/dev/cu.usbmodem"}'})).toThrow();
  });
  it('gives Atom closed marker, trace, display, and channel operations',()=>{
    expect(validateAgentToolCall({callId:'0',name:'select_marker',arguments:'{"markerId":8}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'1',name:'configure_trace',arguments:'{"id":2,"mode":"max-hold","averageCount":8}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'1a',name:'configure_firmware_trace_visibility',arguments:'{"traceId":2,"visible":false}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'1b',name:'select_trace',arguments:'{"traceId":4}'}).policy.risk).toBe('operate');
    expect(validateAgentToolCall({callId:'2',name:'configure_marker',arguments:'{"id":1,"enabled":true,"traceId":2,"mode":"normal","frequencyHz":98000000,"tracking":"peak"}'}).policy.risk).toBe('operate');
    expect(()=>validateAgentToolCall({callId:'3',name:'configure_marker',arguments:'{"id":1,"enabled":true,"traceId":2,"mode":"normal","frequencyHz":98000000,"tracking":"peak","referenceMarkerId":2}'})).toThrow();
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

function assertClosedDescribedObjects(toolName:string,schema:Record<string,unknown>,path:string=toolName):void{
  if(schema.type==='object'){
    expect(schema.additionalProperties,path).toBe(false);
    const properties=schema.properties as Record<string,unknown>|undefined;
    expect(properties,path).toBeTypeOf('object');
    for(const [name,value] of Object.entries(properties??{})){
      expect((value as {description?:unknown}).description,`${path}.${name} description`).toBeTypeOf('string');
      assertClosedDescribedObjects(toolName,value as Record<string,unknown>,`${path}.${name}`);
    }
  }
  for(const keyword of ['oneOf','anyOf','allOf'] as const){
    const branches=schema[keyword];
    if(Array.isArray(branches))branches.forEach((branch,index)=>assertClosedDescribedObjects(toolName,branch as Record<string,unknown>,`${path}.${keyword}[${index}]`));
  }
}
