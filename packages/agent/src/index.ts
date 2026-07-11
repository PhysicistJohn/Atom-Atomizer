import { z } from 'zod';
import {
  ZS407_FIRMWARE_LIMITS,
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  generatorConfigSchema,
  markerConfigurationSchema,
  markerIdSchema,
  markerSearchActionSchema,
  measurementViewIdSchema,
  replayChannelConfigurationSchema,
  signalDetectionConfigSchema,
  spectrumDisplayConfigurationSchema,
  synthesizedSignalProfileSchema,
  traceConfigurationSchema,
  traceIdSchema,
  waterfallConfigurationSchema,
  zeroSpanConfigSchema,
} from '@tinysa/contracts';

export const ATOM_AGENT_MODEL = 'gpt-realtime-2.1-mini' as const;
export const ATOM_AGENT_VOICE = 'ballad' as const;
export const ATOM_AGENT_REASONING_EFFORT = 'high' as const;
export const ATOM_AGENT_VAD_THRESHOLD = 0.95 as const;
export const ATOM_AGENT_VERSION = 2 as const;

export type AgentConnectionState = 'unconfigured' | 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
export type AgentToolRisk = 'observe' | 'operate' | 'high-impact';
export type AgentToolName =
  | 'get_application_state' | 'get_instrument_state' | 'get_latest_sweep_summary'
  | 'get_detection_results' | 'get_classification_results' | 'read_device_diagnostics'
  | 'list_connection_candidates' | 'connect_device' | 'disconnect_device'
  | 'inspect_interface' | 'computer_action'
  | 'computer_screenshot' | 'computer_click' | 'computer_type' | 'computer_key' | 'computer_scroll'
  | 'navigate_workspace' | 'configure_analyzer' | 'acquire_sweep'
  | 'start_continuous_sweeps' | 'stop_continuous_sweeps'
  | 'get_measurement_state' | 'configure_marker' | 'search_marker' | 'configure_trace' | 'reset_trace' | 'configure_spectrum_display'
  | 'set_measurement_view' | 'configure_waterfall' | 'configure_channel_measurement' | 'get_channel_measurement_results'
  | 'configure_envelope_stft' | 'get_envelope_stft_results' | 'acquire_envelope_stft'
  | 'configure_signal_detector' | 'configure_zero_span' | 'acquire_zero_span'
  | 'configure_generator' | 'set_rf_output'
  | 'capture_device_screen' | 'remote_device_touch' | 'export_latest_sweep' | 'select_demo_signal' | 'configure_demo_channel';

export interface AgentToolDefinition {
  type: 'function';
  name: AgentToolName;
  description: string;
  parameters: Record<string, unknown>;
}
export interface AgentToolPolicy { name: AgentToolName; risk: AgentToolRisk; approval: 'never' | 'at-action'; }
export interface AgentToolCall { callId: string; name: string; arguments: string; }
export interface AgentToolResult { callId: string; name: AgentToolName; ok: boolean; output: unknown; }
export interface AgentApprovalRequest { id: string; call: AgentToolCall; tool: AgentToolName; summary: string; risk: AgentToolRisk; createdAt: string; }
export interface AgentMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; createdAt: string; status?: 'streaming' | 'complete' | 'failed'; }
export interface AgentStatus {
  configured: boolean;
  model: typeof ATOM_AGENT_MODEL;
  voice: typeof ATOM_AGENT_VOICE;
  reasoningEffort: typeof ATOM_AGENT_REASONING_EFFORT;
  textAgent: boolean;
  realtime: boolean;
  textTransport: 'realtime-websocket';
}
export interface AgentTurnRequest {
  prompt?: string;
  conversationId?: string;
  toolOutputs?: readonly { callId: string; output: string; imageDataUrl?: string }[];
  applicationContext: string;
}
export interface AgentTurnResult {
  conversationId: string;
  transport: 'realtime-websocket';
  text: string;
  toolCalls: readonly AgentToolCall[];
}

const empty = { type: 'object', properties: {}, required: [], additionalProperties: false } as const;
const autoOrNumber = (minimum: number, maximum: number) => ({ anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'number', minimum, maximum }] });
const triggerParameters = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['auto', 'normal', 'single'] }, levelDbm: { type: 'number', minimum: -174, maximum: 30 } },
  required: ['mode'],
  additionalProperties: false,
};
const analyzerParameters = {
  type: 'object',
  properties: {
    startHz: { type: 'integer', minimum: 0, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    stopHz: { type: 'integer', minimum: 1, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    points: { type: 'integer', minimum: 20, maximum: 450 },
    acquisitionFormat: { type: 'string', enum: ['text', 'raw'] },
    rbwKhz: autoOrNumber(0.2, 850),
    attenuationDb: { anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer', minimum: 0, maximum: 31 }] },
    sweepTimeSeconds: autoOrNumber(0.003, 60),
    detector: { type: 'string', enum: ['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak'] },
    spurRejection: { type: 'string', enum: ['off', 'on', 'auto'] },
    lna: { type: 'string', enum: ['off', 'on'] },
    avoidSpurs: { type: 'string', enum: ['off', 'on', 'auto'] },
    trigger: triggerParameters,
  },
  required: ['startHz', 'stopHz', 'points', 'acquisitionFormat', 'rbwKhz', 'attenuationDb', 'sweepTimeSeconds', 'detector', 'spurRejection', 'lna', 'avoidSpurs', 'trigger'],
  additionalProperties: false,
} as const;
const detectionParameters = {
  type: 'object',
  properties: {
    threshold: {
      anyOf: [
        { type: 'object', properties: { strategy: { type: 'string', enum: ['absolute'] }, levelDbm: { type: 'number', minimum: -174, maximum: 30 } }, required: ['strategy', 'levelDbm'], additionalProperties: false },
        { type: 'object', properties: { strategy: { type: 'string', enum: ['noise-relative'] }, marginDb: { type: 'number', minimum: 0, maximum: 100 } }, required: ['strategy', 'marginDb'], additionalProperties: false },
      ],
    },
    minimumBandwidthHz: { type: 'integer', minimum: 0 },
    minimumConsecutiveSweeps: { type: 'integer', minimum: 1, maximum: 1_000 },
    releaseAfterMissedSweeps: { type: 'integer', minimum: 0, maximum: 100 },
  },
  required: ['threshold', 'minimumBandwidthHz', 'minimumConsecutiveSweeps', 'releaseAfterMissedSweeps'],
  additionalProperties: false,
} as const;
const zeroSpanParameters = {
  type: 'object',
  properties: {
    frequencyHz: { type: 'integer', minimum: 0, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    points: { type: 'integer', minimum: 20, maximum: 450 },
    rbwKhz: autoOrNumber(0.2, 850),
    attenuationDb: { anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer', minimum: 0, maximum: 31 }] },
    sweepTimeSeconds: { type: 'number', minimum: 0.003, maximum: 60 },
    trigger: triggerParameters,
  },
  required: ['frequencyHz', 'points', 'rbwKhz', 'attenuationDb', 'sweepTimeSeconds', 'trigger'],
  additionalProperties: false,
} as const;
const waterfallParameters = {
  type: 'object',
  properties: {
    historyDepth: { type: 'integer', minimum: 5, maximum: 50 },
    floorDbm: { type: 'number', minimum: -174, maximum: 29 },
    ceilingDbm: { type: 'number', minimum: -173, maximum: 30 },
    palette: { type: 'string', enum: ['atomic'] },
  },
  required: ['historyDepth', 'floorDbm', 'ceilingDbm', 'palette'],
  additionalProperties: false,
} as const;
const channelMeasurementParameters = {
  type: 'object',
  properties: {
    centerHz: { type: 'integer', minimum: 0, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    mainBandwidthHz: { type: 'integer', minimum: 1, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    adjacentBandwidthHz: { type: 'integer', minimum: 1, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    channelSpacingHz: { type: 'integer', minimum: 1, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
    adjacentChannelCount: { type: 'integer', minimum: 1, maximum: 3 },
    occupiedPowerPercent: { type: 'number', minimum: 10, maximum: 99.9 },
    obwNoiseCorrection: { type: 'string', enum: ['none', 'robust-floor'] },
  },
  required: ['centerHz', 'mainBandwidthHz', 'adjacentBandwidthHz', 'channelSpacingHz', 'adjacentChannelCount', 'occupiedPowerPercent', 'obwNoiseCorrection'],
  additionalProperties: false,
} as const;
const envelopeStftParameters = {
  type: 'object',
  properties: {
    windowSize: { type: 'integer', enum: [16, 32, 64, 128, 256] },
    hopSize: { type: 'integer', minimum: 1, maximum: 256 },
    window: { type: 'string', enum: ['hann'] },
    removeDc: { type: 'boolean' },
    dynamicRangeDb: { type: 'number', minimum: 20, maximum: 120 },
  },
  required: ['windowSize', 'hopSize', 'window', 'removeDc', 'dynamicRangeDb'],
  additionalProperties: false,
} as const;
const generatorParameters = {
  type: 'object',
  properties: {
    frequencyHz: { type: 'integer', minimum: 1, maximum: ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz },
    levelDbm: { type: 'number', minimum: -115, maximum: -18.5 },
    path: { type: 'string', enum: ['normal', 'mixer'] },
    modulation: { type: 'string', enum: ['off', 'am', 'fm'] },
    modulationFrequencyHz: { type: 'integer', minimum: 1, maximum: 10_000 },
    amDepthPercent: { type: 'integer', minimum: 0, maximum: 100 },
    fmDeviationHz: { type: 'integer', minimum: 1_000, maximum: 300_000 },
  },
  required: ['frequencyHz', 'levelDbm', 'path', 'modulation', 'modulationFrequencyHz', 'amDepthPercent', 'fmDeviationHz'],
  additionalProperties: false,
} as const;

export const agentToolDefinitions: readonly AgentToolDefinition[] = [
  { type: 'function', name: 'get_application_state', description: 'Read the current TinySA Atomizer workspace, operation state, simulation status, history count, and visible errors.', parameters: empty },
  { type: 'function', name: 'get_instrument_state', description: 'Read connected tinySA identity, firmware, mode, readback verification, capabilities, telemetry, and RF output state.', parameters: empty },
  { type: 'function', name: 'get_latest_sweep_summary', description: 'Read the latest spectrum sweep range, peak, robust noise floor, metrics, point count, age, and source.', parameters: empty },
  { type: 'function', name: 'get_detection_results', description: 'Read tracked signal candidates and active emissions with thresholds, persistence, missed sweeps, and provenance.', parameters: empty },
  { type: 'function', name: 'get_classification_results', description: 'Read deterministic spectral-morphology and zero-span envelope results. These are evidence labels, not protocol decoding or I/Q classification.', parameters: empty },
  { type: 'function', name: 'read_device_diagnostics', description: 'Refresh and return firmware identity, command catalog, analyzer readback, battery voltage, device ID, and sweep status.', parameters: empty },
  { type: 'function', name: 'list_connection_candidates', description: 'List current connection candidates using opaque IDs. Call before connect_device; raw OS paths and serials are withheld.', parameters: empty },
  { type: 'function', name: 'connect_device', description: 'Connect exactly one candidate returned by list_connection_candidates and verify a ZS407 identity. Never substitutes another candidate.', parameters: { type: 'object', properties: { candidateId: { type: 'string', pattern: '^candidate-[1-9][0-9]*$' } }, required: ['candidateId'], additionalProperties: false } },
  { type: 'function', name: 'disconnect_device', description: 'Disconnect the active instrument. Unknown RF state remains unknown after uncertain transport loss.', parameters: empty },
  { type: 'function', name: 'inspect_interface', description: 'Inspect the semantic TinySA Atomizer interface map and which app-scoped controls are enabled.', parameters: empty },
  { type: 'function', name: 'computer_action', description: 'Activate one allow-listed semantic control inside TinySA Atomizer. High-impact controls are excluded.', parameters: { type: 'object', properties: { controlId: { type: 'string', enum: ['workspace.spectrum', 'workspace.detection', 'workspace.classification', 'workspace.generator', 'workspace.device', 'measurement.view.spectrum', 'measurement.view.waterfall', 'measurement.view.channel', 'measurement.view.envelope-stft', 'acquisition.single', 'acquisition.continuous.start', 'acquisition.continuous.stop', 'connection.open', 'device.capture-screen', 'atom.close'] }, action: { type: 'string', enum: ['activate'] } }, required: ['controlId', 'action'], additionalProperties: false } },
  { type: 'function', name: 'computer_screenshot', description: 'Capture the current TinySA Atomizer application content only. Observe before coordinate actions and verify afterward.', parameters: empty },
  { type: 'function', name: 'computer_click', description: 'Click screenshot-relative coordinates inside TinySA Atomizer. High-impact targets are blocked by host hit-testing.', parameters: { type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 } }, required: ['x', 'y'], additionalProperties: false } },
  { type: 'function', name: 'computer_type', description: 'Type bounded text into the focused TinySA Atomizer control.', parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2_000 } }, required: ['text'], additionalProperties: false } },
  { type: 'function', name: 'computer_key', description: 'Send one allow-listed keyboard key or shortcut inside TinySA Atomizer.', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['ENTER', 'ESCAPE', 'TAB', 'ARROWUP', 'ARROWDOWN', 'ARROWLEFT', 'ARROWRIGHT', 'BACKSPACE', 'META+K', 'CTRL+K'] } }, required: ['key'], additionalProperties: false } },
  { type: 'function', name: 'computer_scroll', description: 'Scroll inside TinySA Atomizer at bounded screenshot-relative coordinates.', parameters: { type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, deltaX: { type: 'integer', minimum: -2_000, maximum: 2_000 }, deltaY: { type: 'integer', minimum: -2_000, maximum: 2_000 } }, required: ['x', 'y', 'deltaX', 'deltaY'], additionalProperties: false } },
  { type: 'function', name: 'navigate_workspace', description: 'Navigate to a first-class workspace through the same RF-output guard as the visual UI.', parameters: { type: 'object', properties: { workspace: { type: 'string', enum: ['spectrum', 'detection', 'classification', 'generator', 'device'] } }, required: ['workspace'], additionalProperties: false } },
  { type: 'function', name: 'configure_analyzer', description: 'Stage a complete firmware-derived analyzer configuration. This does not acquire.', parameters: analyzerParameters },
  { type: 'function', name: 'acquire_sweep', description: 'Apply the staged analyzer configuration and acquire exactly one complete sweep.', parameters: empty },
  { type: 'function', name: 'start_continuous_sweeps', description: 'Apply the staged analyzer configuration and acquire serialized sweeps until explicitly stopped or a failure occurs.', parameters: empty },
  { type: 'function', name: 'stop_continuous_sweeps', description: 'Stop continuous acquisition after the currently in-flight firmware command completes.', parameters: empty },
  { type: 'function', name: 'get_measurement_state', description: 'Read all four host-derived trace modes, eight marker configurations/readings, peak-search criteria, and amplitude display scale with evidence labels.', parameters: empty },
  { type: 'function', name: 'set_measurement_view', description: 'Select Spectrum, Waterfall, Channel, or detected-envelope STFT as the active bounded analysis view.', parameters: { type: 'object', properties: { view: { type: 'string', enum: ['spectrum', 'waterfall', 'channel', 'envelope-stft'] } }, required: ['view'], additionalProperties: false } },
  { type: 'function', name: 'configure_waterfall', description: 'Configure coherent sweep-history depth and the explicit dBm color scale for the host waterfall. Frequency-grid changes are excluded, never resampled silently.', parameters: waterfallParameters },
  { type: 'function', name: 'configure_channel_measurement', description: 'Configure main and adjacent integration bandwidths, channel spacing, adjacent pair count, percent-power OBW, and explicit OBW noise treatment.', parameters: channelMeasurementParameters },
  { type: 'function', name: 'get_channel_measurement_results', description: 'Calculate channel power, PSD, adjacent and alternate channel powers in dBm/dBc, and percent-power OBW from the latest complete scalar sweep. Fails if any configured window is outside the sweep.', parameters: empty },
  { type: 'function', name: 'configure_envelope_stft', description: 'Configure the Hann-windowed STFT of detected zero-span power, including window, hop, mean removal, and display range. This is not RF/IQ analysis.', parameters: envelopeStftParameters },
  { type: 'function', name: 'get_envelope_stft_results', description: 'Read the STFT of the latest complete zero-span detected-power envelope. Fails when no capture exists or the window exceeds the evidence.', parameters: empty },
  { type: 'function', name: 'acquire_envelope_stft', description: 'Acquire zero-span detected power using the staged zero-span configuration and return its envelope STFT without claiming I/Q, phase, EVM, or symbol recovery.', parameters: empty },
  { type: 'function', name: 'configure_marker', description: 'Configure one of eight host-derived markers, including trace assignment, fixed or peak tracking, normal, delta, or noise-density readout.', parameters: { type: 'object', properties: { id: { type: 'integer', minimum: 1, maximum: 8 }, enabled: { type: 'boolean' }, traceId: { type: 'integer', minimum: 1, maximum: 4 }, mode: { type: 'string', enum: ['normal', 'delta', 'noise-density'] }, frequencyHz: { type: 'integer', minimum: 0, maximum: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz }, tracking: { type: 'string', enum: ['fixed', 'peak'] }, referenceMarkerId: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['id', 'enabled', 'traceId', 'mode', 'frequencyHz', 'tracking'], additionalProperties: false } },
  { type: 'function', name: 'search_marker', description: 'Move a marker to the absolute peak, minimum, or next qualifying local peak left/right using the staged threshold and excursion criteria.', parameters: { type: 'object', properties: { markerId: { type: 'integer', minimum: 1, maximum: 8 }, action: { type: 'string', enum: ['peak', 'minimum', 'next-left', 'next-right'] } }, required: ['markerId', 'action'], additionalProperties: false } },
  { type: 'function', name: 'configure_trace', description: 'Configure one of four host-derived simultaneous traces as Clear/Write, Max Hold, Min Hold, Average, View, or Blank.', parameters: { type: 'object', properties: { id: { type: 'integer', minimum: 1, maximum: 4 }, mode: { type: 'string', enum: ['clear-write', 'max-hold', 'min-hold', 'average', 'view', 'blank'] }, averageCount: { type: 'integer', minimum: 2, maximum: 100 } }, required: ['id', 'mode', 'averageCount'], additionalProperties: false } },
  { type: 'function', name: 'reset_trace', description: 'Clear the accumulated memory for one host-derived trace.', parameters: { type: 'object', properties: { traceId: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['traceId'], additionalProperties: false } },
  { type: 'function', name: 'configure_spectrum_display', description: 'Configure the host spectrum amplitude axis reference level and dB per division. This does not claim firmware display readback.', parameters: { type: 'object', properties: { referenceLevelDbm: { type: 'number', minimum: -150, maximum: 30 }, decibelsPerDivision: { type: 'number', enum: [1, 2, 5, 10, 20] }, divisions: { type: 'integer', enum: [10] } }, required: ['referenceLevelDbm', 'decibelsPerDivision', 'divisions'], additionalProperties: false } },
  { type: 'function', name: 'configure_signal_detector', description: 'Configure threshold segmentation plus cross-sweep promotion and release behavior.', parameters: detectionParameters },
  { type: 'function', name: 'configure_zero_span', description: 'Stage a power-versus-time zero-span capture. Zero span is detected envelope data, never I/Q.', parameters: zeroSpanParameters },
  { type: 'function', name: 'acquire_zero_span', description: 'Acquire one zero-span envelope using the staged configuration and classify only its envelope behavior.', parameters: empty },
  { type: 'function', name: 'configure_generator', description: 'Configure the complete generator command surface while forcing RF output off. Values remain commanded because firmware lacks reliable readback.', parameters: generatorParameters },
  { type: 'function', name: 'set_rf_output', description: 'Enable or disable physical RF output. Enabling requires immediate human approval.', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false } },
  { type: 'function', name: 'capture_device_screen', description: 'Capture the physical tinySA LCD as an exact 480×320 RGB565 frame and display it in Device.', parameters: empty },
  { type: 'function', name: 'remote_device_touch', description: 'Send one physical-screen touch gesture. Because firmware UI touch may reach RF controls, every gesture requires immediate human approval.', parameters: { type: 'object', properties: { x: { type: 'integer', minimum: 0, maximum: 479 }, y: { type: 'integer', minimum: 0, maximum: 319 }, gesture: { type: 'string', enum: ['tap', 'press', 'release'] } }, required: ['x', 'y', 'gesture'], additionalProperties: false } },
  { type: 'function', name: 'export_latest_sweep', description: 'Open a native save dialog and export the latest complete sweep with measurement and device provenance.', parameters: { type: 'object', properties: { format: { type: 'string', enum: ['csv', 'json'] } }, required: ['format'], additionalProperties: false } },
  { type: 'function', name: 'select_demo_signal', description: 'Select one closed Signal Lab profile: visual CW/AM/FM; published GSM/EDGE normal-burst modulations; the complete in-scope Release 19 LTE E-TM/sE-TM/N-TM and NR-FR1/NR-N-TM/SBFD model catalog; or an IEEE 802.11ax HE PPDU format. Qualification and exact source clause are returned.', parameters: { type: 'object', properties: { profile: { type: 'string', enum: synthesizedSignalProfileSchema.options } }, required: ['profile'], additionalProperties: false } },
  { type: 'function', name: 'configure_demo_channel', description: 'Configure the seeded Signal Lab channel as complex-Gaussian AWGN or frequency-selective correlated Rayleigh fading plus AWGN.', parameters: { type: 'object', properties: { model: { type: 'string', enum: ['awgn', 'rayleigh'] }, noiseFloorDbm: { type: 'number', minimum: -150, maximum: -30 }, seed: { type: 'integer', minimum: 1, maximum: 0xffff_ffff }, fadingRateHz: { type: 'number', minimum: 0.1, maximum: 100 } }, required: ['model', 'noiseFloorDbm', 'seed', 'fadingRateHz'], additionalProperties: false } },
];

const observe = (name: AgentToolName): AgentToolPolicy => ({ name, risk: 'observe', approval: 'never' });
const operate = (name: AgentToolName): AgentToolPolicy => ({ name, risk: 'operate', approval: 'never' });
export const agentToolPolicies: Readonly<Record<AgentToolName, AgentToolPolicy>> = {
  get_application_state: observe('get_application_state'),
  get_instrument_state: observe('get_instrument_state'),
  get_latest_sweep_summary: observe('get_latest_sweep_summary'),
  get_detection_results: observe('get_detection_results'),
  get_classification_results: observe('get_classification_results'),
  read_device_diagnostics: observe('read_device_diagnostics'),
  list_connection_candidates: observe('list_connection_candidates'),
  connect_device: operate('connect_device'),
  disconnect_device: operate('disconnect_device'),
  inspect_interface: observe('inspect_interface'),
  computer_action: operate('computer_action'),
  computer_screenshot: observe('computer_screenshot'),
  computer_click: operate('computer_click'),
  computer_type: operate('computer_type'),
  computer_key: operate('computer_key'),
  computer_scroll: operate('computer_scroll'),
  navigate_workspace: operate('navigate_workspace'),
  configure_analyzer: operate('configure_analyzer'),
  acquire_sweep: operate('acquire_sweep'),
  start_continuous_sweeps: operate('start_continuous_sweeps'),
  stop_continuous_sweeps: operate('stop_continuous_sweeps'),
  get_measurement_state: observe('get_measurement_state'),
  set_measurement_view: operate('set_measurement_view'),
  configure_waterfall: operate('configure_waterfall'),
  configure_channel_measurement: operate('configure_channel_measurement'),
  get_channel_measurement_results: observe('get_channel_measurement_results'),
  configure_envelope_stft: operate('configure_envelope_stft'),
  get_envelope_stft_results: observe('get_envelope_stft_results'),
  acquire_envelope_stft: operate('acquire_envelope_stft'),
  configure_marker: operate('configure_marker'),
  search_marker: operate('search_marker'),
  configure_trace: operate('configure_trace'),
  reset_trace: operate('reset_trace'),
  configure_spectrum_display: operate('configure_spectrum_display'),
  configure_signal_detector: operate('configure_signal_detector'),
  configure_zero_span: operate('configure_zero_span'),
  acquire_zero_span: operate('acquire_zero_span'),
  configure_generator: operate('configure_generator'),
  set_rf_output: { name: 'set_rf_output', risk: 'high-impact', approval: 'at-action' },
  capture_device_screen: observe('capture_device_screen'),
  remote_device_touch: { name: 'remote_device_touch', risk: 'high-impact', approval: 'at-action' },
  export_latest_sweep: operate('export_latest_sweep'),
  select_demo_signal: operate('select_demo_signal'),
  configure_demo_channel: operate('configure_demo_channel'),
};

const schemas: Record<AgentToolName, z.ZodType> = {
  get_application_state: z.object({}).strict(),
  get_instrument_state: z.object({}).strict(),
  get_latest_sweep_summary: z.object({}).strict(),
  get_detection_results: z.object({}).strict(),
  get_classification_results: z.object({}).strict(),
  read_device_diagnostics: z.object({}).strict(),
  list_connection_candidates: z.object({}).strict(),
  connect_device: z.object({ candidateId: z.string().regex(/^candidate-[1-9][0-9]*$/) }).strict(),
  disconnect_device: z.object({}).strict(),
  inspect_interface: z.object({}).strict(),
  computer_action: z.object({ controlId: z.enum(['workspace.spectrum', 'workspace.detection', 'workspace.classification', 'workspace.generator', 'workspace.device', 'measurement.view.spectrum', 'measurement.view.waterfall', 'measurement.view.channel', 'measurement.view.envelope-stft', 'acquisition.single', 'acquisition.continuous.start', 'acquisition.continuous.stop', 'connection.open', 'device.capture-screen', 'atom.close']), action: z.literal('activate') }).strict(),
  computer_screenshot: z.object({}).strict(),
  computer_click: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }).strict(),
  computer_type: z.object({ text: z.string().min(1).max(2_000) }).strict(),
  computer_key: z.object({ key: z.enum(['ENTER', 'ESCAPE', 'TAB', 'ARROWUP', 'ARROWDOWN', 'ARROWLEFT', 'ARROWRIGHT', 'BACKSPACE', 'META+K', 'CTRL+K']) }).strict(),
  computer_scroll: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), deltaX: z.number().int().min(-2_000).max(2_000), deltaY: z.number().int().min(-2_000).max(2_000) }).strict(),
  navigate_workspace: z.object({ workspace: z.enum(['spectrum', 'detection', 'classification', 'generator', 'device']) }).strict(),
  configure_analyzer: analyzerConfigSchema,
  acquire_sweep: z.object({}).strict(),
  start_continuous_sweeps: z.object({}).strict(),
  stop_continuous_sweeps: z.object({}).strict(),
  get_measurement_state: z.object({}).strict(),
  set_measurement_view: z.object({ view: measurementViewIdSchema }).strict(),
  configure_waterfall: waterfallConfigurationSchema,
  configure_channel_measurement: channelMeasurementConfigurationSchema,
  get_channel_measurement_results: z.object({}).strict(),
  configure_envelope_stft: envelopeStftConfigurationSchema,
  get_envelope_stft_results: z.object({}).strict(),
  acquire_envelope_stft: z.object({}).strict(),
  configure_marker: markerConfigurationSchema,
  search_marker: z.object({ markerId: markerIdSchema, action: markerSearchActionSchema }).strict(),
  configure_trace: traceConfigurationSchema,
  reset_trace: z.object({ traceId: traceIdSchema }).strict(),
  configure_spectrum_display: spectrumDisplayConfigurationSchema,
  configure_signal_detector: signalDetectionConfigSchema,
  configure_zero_span: zeroSpanConfigSchema,
  acquire_zero_span: z.object({}).strict(),
  configure_generator: generatorConfigSchema,
  set_rf_output: z.object({ enabled: z.boolean() }).strict(),
  capture_device_screen: z.object({}).strict(),
  remote_device_touch: z.object({ x: z.number().int().min(0).max(479), y: z.number().int().min(0).max(319), gesture: z.enum(['tap', 'press', 'release']) }).strict(),
  export_latest_sweep: z.object({ format: z.enum(['csv', 'json']) }).strict(),
  select_demo_signal: z.object({ profile: synthesizedSignalProfileSchema }).strict(),
  configure_demo_channel: replayChannelConfigurationSchema,
};

export function isAgentToolName(value: string): value is AgentToolName { return Object.hasOwn(agentToolPolicies, value); }
export function validateAgentToolCall(call: AgentToolCall): { name: AgentToolName; args: unknown; policy: AgentToolPolicy } {
  if (!isAgentToolName(call.name)) throw new Error(`Unknown agent tool: ${call.name}`);
  let parsed: unknown;
  try { parsed = JSON.parse(call.arguments || '{}'); }
  catch { throw new Error(`Invalid JSON arguments for ${call.name}`); }
  return { name: call.name, args: schemas[call.name].parse(parsed), policy: agentToolPolicies[call.name] };
}
export function approvalSummary(name: AgentToolName, args: unknown): string {
  if (name === 'set_rf_output' && (args as { enabled: boolean }).enabled) return 'Enable physical RF output on the connected tinySA';
  if (name === 'remote_device_touch') {
    const value = args as { x: number; y: number; gesture: string };
    return `Send a ${value.gesture} gesture to the physical tinySA screen at ${value.x}, ${value.y}`;
  }
  return `Run ${name.replaceAll('_', ' ')}`;
}

export const ATOM_AGENT_INSTRUCTIONS = `You are Atom, the native AI copilot inside TinySA Atomizer. Help RF hobbyists learn and RF engineers move quickly without overstating certainty. Prefer typed application tools over clicks. Read state before making state-dependent claims. A dialog opening is not a connection; list candidates, connect one exact candidate, and verify ready. Explain units and tradeoffs clearly. Distinguish requested, commanded, verified, simulated, stale, unqualified, and unknown values. Spectrum, waterfall, channel power, ACP/ACLR, and OBW are host projections of complete scalar sweeps. Frequency-grid changes are excluded from the waterfall rather than resampled silently. Spectral morphology labels describe trace shape only; zero span is detected power versus time and never I/Q. Envelope STFT reveals detected-power modulation rates only and cannot establish carrier phase, symbols, EVM, or protocol identity. Never claim protocol decoding, regulatory-grade accuracy, or a hardware interlock. Never enable RF output unless explicitly requested. Physical-screen touch is high-impact because the firmware UI may expose RF controls. Never retry, reroute, substitute a model, or conceal a failed operation. Keep spoken answers concise, then offer deeper analysis. The active model is exactly gpt-realtime-2.1-mini.`;

export const realtimeToolDefinitions = agentToolDefinitions.filter((tool) => !tool.name.startsWith('computer_'));

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
          interrupt_response: true,
        },
      },
      output: { voice: ATOM_AGENT_VOICE },
    },
    tools: realtimeToolDefinitions,
    tool_choice: 'auto' as const,
  };
}

export interface RealtimeSessionSettingCheck { path: string; sent: unknown; returned: unknown; matches: boolean; }
export interface RealtimeSessionServerSetting { path: string; value: unknown; }
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
  return { ok: checks.every((check) => check.matches), sent, returned, checks, serverOnly };
}

function compareSentSettings(sent: unknown, returned: unknown, path: string, checks: RealtimeSessionSettingCheck[]): void {
  if (Array.isArray(sent)) {
    const returnedArray = Array.isArray(returned) ? returned : undefined;
    checks.push({ path: `${path}.length`, sent: sent.length, returned: returnedArray?.length, matches: returnedArray?.length === sent.length });
    for (let index = 0; index < sent.length; index++) compareSentSettings(sent[index], returnedArray?.[index], `${path}[${index}]`, checks);
    return;
  }
  if (isRecord(sent)) {
    if (!isRecord(returned)) { checks.push({ path, sent, returned, matches: false }); return; }
    const entries = Object.entries(sent);
    if (!entries.length) checks.push({ path, sent, returned, matches: !Object.keys(returned).length });
    for (const [key, value] of entries) compareSentSettings(value, returned[key], `${path}.${key}`, checks);
    return;
  }
  checks.push({ path, sent, returned, matches: Object.is(sent, returned) });
}

function collectServerOnlySettings(sent: unknown, returned: unknown, path: string, serverOnly: RealtimeSessionServerSetting[]): void {
  if (Array.isArray(returned)) {
    if (!Array.isArray(sent)) { serverOnly.push({ path, value: returned }); return; }
    for (let index = 0; index < returned.length; index++) {
      if (index >= sent.length) serverOnly.push({ path: `${path}[${index}]`, value: returned[index] });
      else collectServerOnlySettings(sent[index], returned[index], `${path}[${index}]`, serverOnly);
    }
    return;
  }
  if (isRecord(returned)) {
    if (!isRecord(sent)) { serverOnly.push({ path, value: returned }); return; }
    for (const [key, value] of Object.entries(returned)) {
      if (!Object.hasOwn(sent, key)) serverOnly.push({ path: `${path}.${key}`, value });
      else collectServerOnlySettings(sent[key], value, `${path}.${key}`, serverOnly);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
