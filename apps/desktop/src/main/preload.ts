import { contextBridge, ipcRenderer } from 'electron';
import type {
  AtomizerFilesApiV1,
  AtomizerInstrumentApiV1,
  AtomizerInstrumentEvent,
  AtomizerInstrumentPreferenceSelection,
  InstrumentCandidate,
  InstrumentConfiguration,
  InstrumentFeatureRequest,
  SweepExportRequest,
} from '@tinysa/contracts';
import type { AgentTurnRequest } from '@tinysa/agent';
import {
  ATOMIZER_AI_IPC_CHANNELS,
  ATOMIZER_FILES_IPC_CHANNELS,
  ATOMIZER_FILES_IPC_VERSION,
  ATOMIZER_INSTRUMENT_IPC_CHANNELS,
  ATOMIZER_INSTRUMENT_IPC_VERSION,
} from './atomizer-ipc-channels.js';

// Sandboxed Electron preloads cannot resolve workspace runtime modules.
const atomizerInstrument = {
  version: ATOMIZER_INSTRUMENT_IPC_VERSION,
  getState: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.state),
  discover: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.discover),
  connect: (candidate: InstrumentCandidate) => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.connect, candidate),
  disconnect: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.disconnect),
  configure: (configuration: InstrumentConfiguration) => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.configure, configuration),
  acquire: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.acquire),
  startStreaming: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.startStreaming),
  stopStreaming: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.stopStreaming),
  executeFeature: (request: InstrumentFeatureRequest) => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.executeFeature, request),
  readPreference: () => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.readPreference),
  writePreference: (selection: AtomizerInstrumentPreferenceSelection) => ipcRenderer.invoke(ATOMIZER_INSTRUMENT_IPC_CHANNELS.writePreference, selection),
  subscribe: (listener: (event: AtomizerInstrumentEvent) => void) => {
    if (typeof listener !== 'function') throw new TypeError('Atomizer instrument event listener must be a function');
    const wrapped = (_event: Electron.IpcRendererEvent, value: AtomizerInstrumentEvent) => listener(value);
    ipcRenderer.on(ATOMIZER_INSTRUMENT_IPC_CHANNELS.event, wrapped);
    return () => ipcRenderer.removeListener(ATOMIZER_INSTRUMENT_IPC_CHANNELS.event, wrapped);
  },
} satisfies AtomizerInstrumentApiV1;

contextBridge.exposeInMainWorld('atomizerInstrument', atomizerInstrument);
const atomizerFiles = {
  version: ATOMIZER_FILES_IPC_VERSION,
  exportSweep: (request: SweepExportRequest) => ipcRenderer.invoke(ATOMIZER_FILES_IPC_CHANNELS.exportSweep, request),
} satisfies AtomizerFilesApiV1;
contextBridge.exposeInMainWorld('atomizerFiles', atomizerFiles);

contextBridge.exposeInMainWorld('atomAgent', {
  status: () => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.status),
  createRealtimeCall: (sdp: string) => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.realtimeCall, sdp),
  agentTurn: (request: AgentTurnRequest) => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.agentTurn, request),
  computerScreenshot: () => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.computerScreenshot),
  computerClick: (value: {screenshotId:string;x:number;y:number}) => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.computerClick, value),
  computerType: (value:{expectedTarget:string;text:string}) => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.computerType, value),
  computerKey: (value:{expectedTarget:string;key:string}) => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.computerKey, value),
  computerScroll: (value:{screenshotId:string;x:number;y:number;deltaX:number;deltaY:number}) => ipcRenderer.invoke(ATOMIZER_AI_IPC_CHANNELS.computerScroll, value)
});
