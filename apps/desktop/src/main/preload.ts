import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnalyzerConfig,
  DeviceEvent,
  FirmwareFlashRequest,
  FirmwareUpdatePreflight,
  GeneratorConfig,
  PortCandidate,
  ScreenPoint,
  SweepExportRequest,
  ZeroSpanConfig,
} from '@tinysa/contracts';
import type { AgentTurnRequest } from '@tinysa/agent';

// Sandboxed Electron preloads cannot resolve workspace runtime modules.
const API_VERSION = 2 as const;

contextBridge.exposeInMainWorld('tinySA', {
  version: API_VERSION,
  listDevices: () => ipcRenderer.invoke('tinysa:list'),
  connect: (port: PortCandidate) => ipcRenderer.invoke('tinysa:connect', port),
  disconnect: () => ipcRenderer.invoke('tinysa:disconnect'),
  getSnapshot: () => ipcRenderer.invoke('tinysa:snapshot'),
  configureAnalyzer: (config: AnalyzerConfig) => ipcRenderer.invoke('tinysa:analyzer:configure', config),
  acquireSweep: () => ipcRenderer.invoke('tinysa:analyzer:acquire'),
  startStreaming: () => ipcRenderer.invoke('tinysa:analyzer:stream:start'),
  stopStreaming: () => ipcRenderer.invoke('tinysa:analyzer:stream:stop'),
  acquireZeroSpan: (config: ZeroSpanConfig) => ipcRenderer.invoke('tinysa:analyzer:zero-span', config),
  configureGenerator: (config: GeneratorConfig) => ipcRenderer.invoke('tinysa:generator:configure', config),
  setGeneratorOutput: (enabled: boolean) => ipcRenderer.invoke('tinysa:generator:output', enabled),
  readDiagnostics: () => ipcRenderer.invoke('tinysa:diagnostics'),
  captureScreen: () => ipcRenderer.invoke('tinysa:screen:capture'),
  touch: (point: ScreenPoint) => ipcRenderer.invoke('tinysa:screen:touch', point),
  releaseTouch: (point?: ScreenPoint) => ipcRenderer.invoke('tinysa:screen:release', point),
  exportSweep: (request: SweepExportRequest) => ipcRenderer.invoke('tinysa:sweep:export', request),
  getFirmwareUpdateState: () => ipcRenderer.invoke('tinysa:firmware:state'),
  downloadFirmwareUpdate: () => ipcRenderer.invoke('tinysa:firmware:download'),
  prepareFirmwareUpdate: (preflight: FirmwareUpdatePreflight) => ipcRenderer.invoke('tinysa:firmware:prepare', preflight),
  detectDfuDevice: () => ipcRenderer.invoke('tinysa:firmware:detect-dfu'),
  flashFirmwareUpdate: (request: FirmwareFlashRequest) => ipcRenderer.invoke('tinysa:firmware:flash', request),
  subscribe: (listener: (event: DeviceEvent) => void) => {
    const channel = `tinysa:event:v${API_VERSION}`;
    const wrapped = (_event: Electron.IpcRendererEvent, value: DeviceEvent) => listener(value);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
contextBridge.exposeInMainWorld('atomAgent', {
  status: () => ipcRenderer.invoke('ai:status'),
  createRealtimeCall: (sdp: string) => ipcRenderer.invoke('ai:realtime:call', sdp),
  agentTurn: (request: AgentTurnRequest) => ipcRenderer.invoke('ai:agent:turn', request),
  computerScreenshot: () => ipcRenderer.invoke('ai:computer:screenshot'),
  computerClick: (value: {screenshotId:string;x:number;y:number}) => ipcRenderer.invoke('ai:computer:click', value),
  computerType: (value:{expectedTarget:string;text:string}) => ipcRenderer.invoke('ai:computer:type', value),
  computerKey: (value:{expectedTarget:string;key:string}) => ipcRenderer.invoke('ai:computer:key', value),
  computerScroll: (value:{screenshotId:string;x:number;y:number;deltaX:number;deltaY:number}) => ipcRenderer.invoke('ai:computer:scroll', value)
});
