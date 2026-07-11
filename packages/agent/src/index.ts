import { z } from 'zod';

export const ATOM_AGENT_MODEL = 'gpt-realtime-2.1-mini' as const;
export const ATOM_AGENT_VOICE = 'ballad' as const;
export const ATOM_AGENT_REASONING_EFFORT = 'high' as const;
export const ATOM_AGENT_VAD_THRESHOLD = 0.95 as const;
export const ATOM_AGENT_VERSION = 1 as const;

export type AgentConnectionState = 'unconfigured' | 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
export type AgentToolRisk = 'observe' | 'operate' | 'high-impact';
export type AgentToolName =
  | 'get_application_state' | 'get_instrument_state' | 'get_latest_sweep_summary'
  | 'list_connection_candidates' | 'connect_device' | 'disconnect_device'
  | 'inspect_interface' | 'computer_action'
  | 'computer_screenshot' | 'computer_click' | 'computer_type' | 'computer_key' | 'computer_scroll'
  | 'navigate_workspace' | 'configure_analyzer' | 'acquire_sweep'
  | 'configure_signal_detector' | 'configure_generator' | 'set_rf_output';

export interface AgentToolDefinition {
  type: 'function'; name: AgentToolName; description: string;
  parameters: Record<string, unknown>;
}
export interface AgentToolPolicy { name: AgentToolName; risk: AgentToolRisk; approval: 'never' | 'at-action'; }
export interface AgentToolCall { callId: string; name: string; arguments: string; }
export interface AgentToolResult { callId: string; name: AgentToolName; ok: boolean; output: unknown; }
export interface AgentApprovalRequest { id: string; call: AgentToolCall; tool: AgentToolName; summary: string; risk: AgentToolRisk; createdAt: string; }
export interface AgentMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; createdAt: string; status?: 'streaming' | 'complete' | 'failed'; }
export interface AgentStatus {
  configured: boolean; model: typeof ATOM_AGENT_MODEL; voice: typeof ATOM_AGENT_VOICE;
  reasoningEffort: typeof ATOM_AGENT_REASONING_EFFORT;
  textAgent: boolean; realtime: boolean; textTransport: 'realtime-websocket';
}
export interface AgentTurnRequest {
  prompt?: string; conversationId?: string;
  toolOutputs?: readonly { callId: string; output: string; imageDataUrl?: string }[];
  applicationContext: string;
}
export interface AgentTurnResult {
  conversationId: string; transport: 'realtime-websocket';
  text: string; toolCalls: readonly AgentToolCall[];
}

const empty = { type: 'object', properties: {}, required: [], additionalProperties: false } as const;
export const agentToolDefinitions: readonly AgentToolDefinition[] = [
  { type:'function',name:'get_application_state',description:'Read the current TinySA Atomizer workspace, acquisition state, simulation status, and visible UI state.',parameters:empty },
  { type:'function',name:'get_instrument_state',description:'Read connected tinySA identity, firmware, mode, verification, capabilities, and RF output state.',parameters:empty },
  { type:'function',name:'get_latest_sweep_summary',description:'Read the latest spectrum sweep range, peak, noise floor, point count, age, and detection count.',parameters:empty },
  { type:'function',name:'list_connection_candidates',description:'List the current TinySA Atomizer connection candidates using opaque candidate IDs. Call this before connect_device. Raw serial numbers and OS paths are not returned.',parameters:empty },
  { type:'function',name:'connect_device',description:'Connect exactly one candidate returned by list_connection_candidates. Opening the connection dialog is not a connection; verify instrument state is ready before configuring or acquiring.',parameters:{type:'object',properties:{candidateId:{type:'string',pattern:'^candidate-[1-9][0-9]*$'}},required:['candidateId'],additionalProperties:false} },
  { type:'function',name:'disconnect_device',description:'Disconnect the currently connected tinySA. This does not claim RF is off after an uncertain cable or transport failure.',parameters:empty },
  { type:'function',name:'inspect_interface',description:'Inspect the current semantic TinySA Atomizer interface map, including active workspace and which app-scoped controls are enabled. Use this before computer_action when UI state is uncertain.',parameters:empty },
  { type:'function',name:'computer_action',description:'Operate one allow-listed control inside the TinySA Atomizer window. This app-scoped computer tool cannot access the desktop, other applications, arbitrary coordinates, or raw device commands.',parameters:{type:'object',properties:{controlId:{type:'string',enum:['workspace.spectrum','workspace.detection','workspace.classification','workspace.generator','acquisition.single','connection.open','atom.close']},action:{type:'string',enum:['activate']}},required:['controlId','action'],additionalProperties:false} },
  { type:'function',name:'computer_screenshot',description:'Capture the current TinySA Atomizer application content only. Use this before coordinate actions and again after actions to verify the result. The host returns the image to the active trusted agent transport.',parameters:empty },
  { type:'function',name:'computer_click',description:'Click screenshot-relative coordinates inside TinySA Atomizer. The host hit-tests the target and blocks high-impact controls such as RF enable; use the typed high-impact tool instead.',parameters:{type:'object',properties:{x:{type:'integer',minimum:0},y:{type:'integer',minimum:0}},required:['x','y'],additionalProperties:false} },
  { type:'function',name:'computer_type',description:'Type text into the currently focused control inside TinySA Atomizer. Text is size-bounded and cannot target other applications.',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:2000}},required:['text'],additionalProperties:false} },
  { type:'function',name:'computer_key',description:'Send one allow-listed keyboard key or shortcut to TinySA Atomizer.',parameters:{type:'object',properties:{key:{type:'string',enum:['ENTER','ESCAPE','TAB','ARROWUP','ARROWDOWN','ARROWLEFT','ARROWRIGHT','BACKSPACE','META+K','CTRL+K']}},required:['key'],additionalProperties:false} },
  { type:'function',name:'computer_scroll',description:'Scroll inside TinySA Atomizer at screenshot-relative coordinates.',parameters:{type:'object',properties:{x:{type:'integer',minimum:0},y:{type:'integer',minimum:0},deltaX:{type:'integer',minimum:-2000,maximum:2000},deltaY:{type:'integer',minimum:-2000,maximum:2000}},required:['x','y','deltaX','deltaY'],additionalProperties:false} },
  { type:'function',name:'navigate_workspace',description:'Navigate the TinySA Atomizer to a first-class workspace. This cannot bypass the RF-output navigation guard.',parameters:{type:'object',properties:{workspace:{type:'string',enum:['spectrum','detection','classification','generator']}},required:['workspace'],additionalProperties:false} },
  { type:'function',name:'configure_analyzer',description:'Set the analyzer sweep range and acquisition settings. Does not start acquisition.',parameters:{type:'object',properties:{startHz:{type:'integer',minimum:0},stopHz:{type:'integer',minimum:1},points:{type:'integer',enum:[145,290,450]},rbwKhz:{type:['number','null'],minimum:0.2},attenuationDb:{anyOf:[{type:'string',enum:['auto']},{type:'number',minimum:0,maximum:31}]}},required:['startHz','stopHz','points','rbwKhz','attenuationDb'],additionalProperties:false} },
  { type:'function',name:'acquire_sweep',description:'Configure the current analyzer settings and acquire one spectrum sweep.',parameters:empty },
  { type:'function',name:'configure_signal_detector',description:'Configure adaptive or absolute signal detection for the current sweep.',parameters:{type:'object',properties:{strategy:{type:'string',enum:['noise-relative','absolute']},value:{type:'number',description:'Margin dB for noise-relative, or threshold dBm for absolute.'},minimumBandwidthHz:{type:'integer',minimum:0}},required:['strategy','value','minimumBandwidthHz'],additionalProperties:false} },
  { type:'function',name:'configure_generator',description:'Configure generator frequency, level and modulation while keeping RF output off.',parameters:{type:'object',properties:{frequencyHz:{type:'integer',minimum:1},levelDbm:{type:'number'},modulation:{type:'string',enum:['off','am','nfm','wfm']}},required:['frequencyHz','levelDbm','modulation'],additionalProperties:false} },
  { type:'function',name:'set_rf_output',description:'Enable or disable physical RF output. Enabling always requires immediate human approval. Disabling is safe and should execute immediately.',parameters:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled'],additionalProperties:false} }
];

export const agentToolPolicies: Readonly<Record<AgentToolName, AgentToolPolicy>> = {
  get_application_state:{name:'get_application_state',risk:'observe',approval:'never'},
  get_instrument_state:{name:'get_instrument_state',risk:'observe',approval:'never'},
  get_latest_sweep_summary:{name:'get_latest_sweep_summary',risk:'observe',approval:'never'},
  list_connection_candidates:{name:'list_connection_candidates',risk:'observe',approval:'never'},
  connect_device:{name:'connect_device',risk:'operate',approval:'never'},
  disconnect_device:{name:'disconnect_device',risk:'operate',approval:'never'},
  inspect_interface:{name:'inspect_interface',risk:'observe',approval:'never'},
  computer_action:{name:'computer_action',risk:'operate',approval:'never'},
  computer_screenshot:{name:'computer_screenshot',risk:'observe',approval:'never'},
  computer_click:{name:'computer_click',risk:'operate',approval:'never'},
  computer_type:{name:'computer_type',risk:'operate',approval:'never'},
  computer_key:{name:'computer_key',risk:'operate',approval:'never'},
  computer_scroll:{name:'computer_scroll',risk:'operate',approval:'never'},
  navigate_workspace:{name:'navigate_workspace',risk:'operate',approval:'never'},
  configure_analyzer:{name:'configure_analyzer',risk:'operate',approval:'never'},
  acquire_sweep:{name:'acquire_sweep',risk:'operate',approval:'never'},
  configure_signal_detector:{name:'configure_signal_detector',risk:'operate',approval:'never'},
  configure_generator:{name:'configure_generator',risk:'operate',approval:'never'},
  set_rf_output:{name:'set_rf_output',risk:'high-impact',approval:'at-action'}
};

const schemas: Record<AgentToolName, z.ZodType> = {
  get_application_state:z.object({}).strict(), get_instrument_state:z.object({}).strict(), get_latest_sweep_summary:z.object({}).strict(),
  list_connection_candidates:z.object({}).strict(),connect_device:z.object({candidateId:z.string().regex(/^candidate-[1-9][0-9]*$/)}).strict(),disconnect_device:z.object({}).strict(),
  inspect_interface:z.object({}).strict(), computer_action:z.object({controlId:z.enum(['workspace.spectrum','workspace.detection','workspace.classification','workspace.generator','acquisition.single','connection.open','atom.close']),action:z.literal('activate')}).strict(),
  computer_screenshot:z.object({}).strict(),computer_click:z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative()}).strict(),
  computer_type:z.object({text:z.string().min(1).max(2000)}).strict(),computer_key:z.object({key:z.enum(['ENTER','ESCAPE','TAB','ARROWUP','ARROWDOWN','ARROWLEFT','ARROWRIGHT','BACKSPACE','META+K','CTRL+K'])}).strict(),
  computer_scroll:z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),deltaX:z.number().int().min(-2000).max(2000),deltaY:z.number().int().min(-2000).max(2000)}).strict(),
  navigate_workspace:z.object({workspace:z.enum(['spectrum','detection','classification','generator'])}).strict(),
  configure_analyzer:z.object({startHz:z.number().int().nonnegative(),stopHz:z.number().int().positive(),points:z.union([z.literal(145),z.literal(290),z.literal(450)]),rbwKhz:z.number().positive().nullable(),attenuationDb:z.union([z.literal('auto'),z.number().min(0).max(31)])}).strict().refine(v=>v.stopHz>v.startHz,{message:'stopHz must exceed startHz'}),
  acquire_sweep:z.object({}).strict(),
  configure_signal_detector:z.object({strategy:z.enum(['noise-relative','absolute']),value:z.number().finite(),minimumBandwidthHz:z.number().int().nonnegative()}).strict(),
  configure_generator:z.object({frequencyHz:z.number().int().positive(),levelDbm:z.number().finite(),modulation:z.enum(['off','am','nfm','wfm'])}).strict(),
  set_rf_output:z.object({enabled:z.boolean()}).strict()
};

export function isAgentToolName(value: string): value is AgentToolName { return Object.hasOwn(agentToolPolicies, value); }
export function validateAgentToolCall(call: AgentToolCall): { name: AgentToolName; args: unknown; policy: AgentToolPolicy } {
  if (!isAgentToolName(call.name)) throw new Error(`Unknown agent tool: ${call.name}`);
  let parsed: unknown; try { parsed=JSON.parse(call.arguments || '{}'); } catch { throw new Error(`Invalid JSON arguments for ${call.name}`); }
  return { name:call.name,args:schemas[call.name].parse(parsed),policy:agentToolPolicies[call.name] };
}
export function approvalSummary(name: AgentToolName, args: unknown): string {
  if(name==='set_rf_output'&&(args as {enabled:boolean}).enabled)return 'Enable physical RF output on the connected tinySA';
  return `Run ${name.replaceAll('_',' ')}`;
}

export const ATOM_AGENT_INSTRUCTIONS = `You are Atom, the native AI copilot inside TinySA Atomizer. Help RF hobbyists learn and help RF engineers move quickly without overstating measurement certainty. Prefer typed application tools over describing clicks. Read state before assuming it. A connection dialog opening is not a device connection: use the typed candidate/connect tools and verify the instrument reports ready before configuring or acquiring. Explain frequency, level, bandwidth, RBW, attenuation, noise floor, spurs, and confidence in clear RF language. Never claim software is a hardware interlock. Never enable RF output unless the user explicitly asks; the host will require confirmation at action time. Never invent waveform classifications: respect unknown and model-unavailable results. Never retry, reroute, substitute, or conceal a failed operation. Keep spoken answers concise, then offer deeper analysis. The active model is gpt-realtime-2.1-mini.`;

export const realtimeToolDefinitions = agentToolDefinitions.filter(tool=>!tool.name.startsWith('computer_'));

export function createAtomRealtimeVoiceSessionConfig() {
  return {
    type: 'realtime' as const,
    model: ATOM_AGENT_MODEL,
    instructions: ATOM_AGENT_INSTRUCTIONS,
    reasoning: { effort: ATOM_AGENT_REASONING_EFFORT },
    audio: {
      input: {
        turn_detection: {
          type: 'server_vad' as const,
          threshold: ATOM_AGENT_VAD_THRESHOLD,
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: ATOM_AGENT_VOICE }
    },
    tools: realtimeToolDefinitions,
    tool_choice: 'auto' as const
  };
}

export interface RealtimeSessionSettingCheck {
  path: string;
  sent: unknown;
  returned: unknown;
  matches: boolean;
}

export interface RealtimeSessionServerSetting {
  path: string;
  value: unknown;
}

export interface AtomRealtimeSessionVerification {
  ok: boolean;
  sent: ReturnType<typeof createAtomRealtimeVoiceSessionConfig>;
  returned: unknown;
  checks: readonly RealtimeSessionSettingCheck[];
  serverOnly: readonly RealtimeSessionServerSetting[];
}

export function verifyAtomRealtimeVoiceSession(returned: unknown): AtomRealtimeSessionVerification {
  const sent = createAtomRealtimeVoiceSessionConfig();
  const checks: RealtimeSessionSettingCheck[] = [];
  compareSentSettings(sent, returned, 'session', checks);
  const serverOnly: RealtimeSessionServerSetting[] = [];
  collectServerOnlySettings(sent, returned, 'session', serverOnly);
  return { ok: checks.every(check=>check.matches), sent, returned, checks, serverOnly };
}

function compareSentSettings(sent: unknown, returned: unknown, path: string, checks: RealtimeSessionSettingCheck[]): void {
  if (Array.isArray(sent)) {
    const returnedArray = Array.isArray(returned) ? returned : undefined;
    checks.push({ path:`${path}.length`,sent:sent.length,returned:returnedArray?.length,matches:returnedArray?.length===sent.length });
    for (let index=0;index<sent.length;index++) compareSentSettings(sent[index],returnedArray?.[index],`${path}[${index}]`,checks);
    return;
  }
  if (isRecord(sent)) {
    if (!isRecord(returned)) {
      checks.push({path,sent,returned,matches:false});
      return;
    }
    const entries=Object.entries(sent);
    if(entries.length===0)checks.push({path,sent,returned,matches:Object.keys(returned).length===0});
    for(const [key,value] of entries)compareSentSettings(value,returned[key],`${path}.${key}`,checks);
    return;
  }
  checks.push({path,sent,returned,matches:Object.is(sent,returned)});
}

function collectServerOnlySettings(sent: unknown, returned: unknown, path: string, serverOnly: RealtimeSessionServerSetting[]): void {
  if(Array.isArray(returned)){
    if(!Array.isArray(sent)){serverOnly.push({path,value:returned});return;}
    for(let index=0;index<returned.length;index++){
      if(index>=sent.length)serverOnly.push({path:`${path}[${index}]`,value:returned[index]});
      else collectServerOnlySettings(sent[index],returned[index],`${path}[${index}]`,serverOnly);
    }
    return;
  }
  if(isRecord(returned)){
    if(!isRecord(sent)){serverOnly.push({path,value:returned});return;}
    for(const [key,value] of Object.entries(returned)){
      if(!Object.hasOwn(sent,key))serverOnly.push({path:`${path}.${key}`,value});
      else collectServerOnlySettings(sent[key],value,`${path}.${key}`,serverOnly);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value&&typeof value==='object'&&!Array.isArray(value));
}
