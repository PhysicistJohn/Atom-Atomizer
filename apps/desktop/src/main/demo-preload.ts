import { contextBridge, ipcRenderer } from 'electron';
import type { DemoLabStatus, SynthesizedSignalProfile } from '@tinysa/contracts';

contextBridge.exposeInMainWorld('demoLab', {
  status: () => ipcRenderer.invoke('demo:status'),
  select: (profile: SynthesizedSignalProfile) => ipcRenderer.invoke('demo:select', profile),
  subscribe: (listener: (status: DemoLabStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: DemoLabStatus) => listener(status);
    ipcRenderer.on('demo:status', wrapped);
    return () => ipcRenderer.removeListener('demo:status', wrapped);
  },
});
