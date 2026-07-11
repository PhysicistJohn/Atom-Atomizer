import { contextBridge, ipcRenderer } from 'electron';
import type { AnalyzerConfig, GeneratorConfig, PortCandidate } from '@tinysa/contracts';
import type { AgentTurnRequest } from '@tinysa/agent';

contextBridge.exposeInMainWorld('tinySA', {
  version: 1,
  listDevices: () => ipcRenderer.invoke('tinysa:list'),
  connect: (port: PortCandidate) => ipcRenderer.invoke('tinysa:connect', port),
  disconnect: () => ipcRenderer.invoke('tinysa:disconnect'),
  getSnapshot: () => ipcRenderer.invoke('tinysa:snapshot'),
  configureAnalyzer: (config: AnalyzerConfig) => ipcRenderer.invoke('tinysa:analyzer:configure', config),
  acquireSweep: () => ipcRenderer.invoke('tinysa:analyzer:acquire'),
  configureGenerator: (config: GeneratorConfig) => ipcRenderer.invoke('tinysa:generator:configure', config),
  setGeneratorOutput: (enabled: boolean) => ipcRenderer.invoke('tinysa:generator:output', enabled)
});
contextBridge.exposeInMainWorld('atomAgent', {
  status: () => ipcRenderer.invoke('ai:status'),
  createRealtimeCall: (sdp: string) => ipcRenderer.invoke('ai:realtime:call', sdp),
  agentTurn: (request: AgentTurnRequest) => ipcRenderer.invoke('ai:agent:turn', request),
  computerScreenshot: () => ipcRenderer.invoke('ai:computer:screenshot'),
  computerClick: (point: {x:number;y:number}) => ipcRenderer.invoke('ai:computer:click', point),
  computerType: (text:string) => ipcRenderer.invoke('ai:computer:type', text),
  computerKey: (key:string) => ipcRenderer.invoke('ai:computer:key', key),
  computerScroll: (value:{x:number;y:number;deltaX:number;deltaY:number}) => ipcRenderer.invoke('ai:computer:scroll', value)
});
