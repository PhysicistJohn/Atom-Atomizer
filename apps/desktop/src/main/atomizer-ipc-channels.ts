/** Dependency-free channel catalog shared by Electron main and sandbox preload. */
export const ATOMIZER_INSTRUMENT_IPC_VERSION = 1 as const;
const INSTRUMENT_PREFIX = `atomizer-instrument:v${ATOMIZER_INSTRUMENT_IPC_VERSION}` as const;

export const ATOMIZER_INSTRUMENT_IPC_CHANNELS = Object.freeze({
  event: `${INSTRUMENT_PREFIX}:event`,
  state: `${INSTRUMENT_PREFIX}:state`,
  discover: `${INSTRUMENT_PREFIX}:discover`,
  connect: `${INSTRUMENT_PREFIX}:connect`,
  disconnect: `${INSTRUMENT_PREFIX}:disconnect`,
  configure: `${INSTRUMENT_PREFIX}:configure`,
  acquire: `${INSTRUMENT_PREFIX}:acquire`,
  startStreaming: `${INSTRUMENT_PREFIX}:stream:start`,
  stopStreaming: `${INSTRUMENT_PREFIX}:stream:stop`,
  executeFeature: `${INSTRUMENT_PREFIX}:feature`,
  readPreference: `${INSTRUMENT_PREFIX}:preference:read`,
  writePreference: `${INSTRUMENT_PREFIX}:preference:write`,
} as const);

export const ATOMIZER_FILES_IPC_VERSION = 1 as const;
export const ATOMIZER_FILES_IPC_CHANNELS = Object.freeze({
  exportSweep: `atomizer-files:v${ATOMIZER_FILES_IPC_VERSION}:sweep:export`,
} as const);

export const ATOMIZER_AI_IPC_CHANNELS = Object.freeze({
  status: 'ai:status',
  realtimeCall: 'ai:realtime:call',
  agentTurn: 'ai:agent:turn',
  computerScreenshot: 'ai:computer:screenshot',
  computerClick: 'ai:computer:click',
  computerType: 'ai:computer:type',
  computerKey: 'ai:computer:key',
  computerScroll: 'ai:computer:scroll',
} as const);

export const ATOMIZER_AUXILIARY_IPC_CHANNELS = Object.freeze([
  ...Object.values(ATOMIZER_FILES_IPC_CHANNELS),
  ...Object.values(ATOMIZER_AI_IPC_CHANNELS),
] as const);
