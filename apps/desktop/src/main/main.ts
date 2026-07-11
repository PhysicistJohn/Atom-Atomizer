import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import {
  API_VERSION,
  analyzerConfigSchema,
  generatorConfigSchema,
  portCandidateSchema,
  replayChannelConfigurationSchema,
  screenPointSchema,
  synthesizedSignalProfileSchema,
  sweepExportRequestSchema,
  zeroSpanConfigSchema,
  type DeviceEvent,
} from '@tinysa/contracts';
import { TinySaDeviceService, NodeSerialTransport } from '@tinysa/device';
import { OpenAiGateway } from './ai-gateway.js';
import type { AgentTurnRequest } from '@tinysa/agent';
import { AppComputerHarness } from './app-computer.js';
import { defaultSweepFilename, serializeSweep } from './sweep-export.js';
import { AutoDemoTransport } from './demo-transport.js';

const here = fileURLToPath(new URL('.', import.meta.url));
for(const candidate of [process.env.TINYSA_ENV_FILE,resolve(process.cwd(),'.env'),resolve(process.cwd(),'../../.env'),resolve(here,'../../../../.env')]){
  if(candidate&&existsSync(candidate)){loadEnv({path:candidate,quiet:true});break;}
}
const simulation = process.env.TINYSA_SIMULATOR === '1';
const transport = new AutoDemoTransport(simulation ? undefined : new NodeSerialTransport(), simulation);
const device = new TinySaDeviceService(transport);
const ai = new OpenAiGateway();
const computer = new AppComputerHarness();
let mainWindow: BrowserWindow | undefined;
let demoWindow: BrowserWindow | undefined;
app.setName('TinySA Atomizer');

function registerIpc(): void {
  ipcMain.handle('tinysa:list', () => device.listDevices());
  ipcMain.handle('tinysa:connect', async (_event, value: unknown) => {
    const snapshot = await device.connect(portCandidateSchema.parse(value));
    broadcastDemoStatus();
    return snapshot;
  });
  ipcMain.handle('tinysa:disconnect', async () => { await device.disconnect(); broadcastDemoStatus(); });
  ipcMain.handle('tinysa:snapshot', () => device.snapshot());
  ipcMain.handle('tinysa:analyzer:configure', (_event, value: unknown) => device.configureAnalyzer(analyzerConfigSchema.parse(value)));
  ipcMain.handle('tinysa:analyzer:acquire', () => device.acquireSweep());
  ipcMain.handle('tinysa:analyzer:stream:start', async () => {
    await device.startStreaming();
    broadcastDemoStatus(transport.setPlayback(true));
  });
  ipcMain.handle('tinysa:analyzer:stream:stop', async () => {
    await device.stopStreaming();
    broadcastDemoStatus(transport.setPlayback(false));
  });
  ipcMain.handle('tinysa:analyzer:zero-span', (_event, value: unknown) => device.acquireZeroSpan(zeroSpanConfigSchema.parse(value)));
  ipcMain.handle('tinysa:generator:configure', (_event, value: unknown) => device.configureGenerator(generatorConfigSchema.parse(value)));
  ipcMain.handle('tinysa:generator:output', (_event, enabled: unknown) => { if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean'); return device.setGeneratorOutput(enabled); });
  ipcMain.handle('tinysa:diagnostics', () => device.readDiagnostics());
  ipcMain.handle('tinysa:screen:capture', () => device.captureScreen());
  ipcMain.handle('tinysa:screen:touch', (_event, value: unknown) => device.touch(screenPointSchema.parse(value)));
  ipcMain.handle('tinysa:screen:release', (_event, value: unknown) => device.releaseTouch(value === undefined ? undefined : screenPointSchema.parse(value)));
  ipcMain.handle('tinysa:sweep:export', async (_event, value: unknown) => {
    const request = sweepExportRequestSchema.parse(value);
    const selection = await dialog.showSaveDialog(requireWindow(), {
      title: 'Export spectrum sweep',
      defaultPath: defaultSweepFilename(request.sweep, request.format),
      filters: [{ name: request.format === 'csv' ? 'CSV data' : 'JSON data', extensions: [request.format] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selection.canceled || !selection.filePath) return { status: 'cancelled' as const, format: request.format };
    const content = serializeSweep(request.sweep, request.format);
    await writeFile(selection.filePath, content, { encoding: 'utf8', flag: 'w' });
    return { status: 'saved' as const, path: selection.filePath, format: request.format, bytesWritten: Buffer.byteLength(content) };
  });
  ipcMain.handle('demo:status', () => transport.status());
  ipcMain.handle('demo:select', (_event, value: unknown) => {
    const status = transport.select(synthesizedSignalProfileSchema.parse(value));
    broadcastDemoStatus(status);
    return status;
  });
  ipcMain.handle('demo:channel', (_event, value: unknown) => {
    const status = transport.configureChannel(replayChannelConfigurationSchema.parse(value));
    broadcastDemoStatus(status);
    return status;
  });
  ipcMain.handle('ai:status', () => ai.status());
  ipcMain.handle('ai:realtime:call', (_event, sdp: unknown) => { if(typeof sdp!=='string')throw new TypeError('sdp must be a string');return ai.createRealtimeCall(sdp); });
  ipcMain.handle('ai:agent:turn', (_event, request: unknown) => ai.agentTurn(validateAgentTurnRequest(request)));
  ipcMain.handle('ai:computer:screenshot', () => computer.screenshot(requireWindow()));
  ipcMain.handle('ai:computer:click', (_event,point:unknown) => {const {x,y}=validatePoint(point);return computer.click(requireWindow(),x,y);});
  ipcMain.handle('ai:computer:type', (_event,text:unknown) => {if(typeof text!=='string')throw new TypeError('text must be a string');return computer.type(requireWindow(),text);});
  ipcMain.handle('ai:computer:key', (_event,key:unknown) => {if(typeof key!=='string')throw new TypeError('key must be a string');return computer.key(requireWindow(),key);});
  ipcMain.handle('ai:computer:scroll', (_event,value:unknown) => {if(!value||typeof value!=='object')throw new TypeError('scroll must be an object');const input=value as Record<string,unknown>;for(const key of ['x','y','deltaX','deltaY'])if(!Number.isInteger(input[key]))throw new TypeError(`${key} must be an integer`);return computer.scroll(requireWindow(),input.x as number,input.y as number,input.deltaX as number,input.deltaY as number);});
}
function broadcastDemoStatus(status = transport.status()): void {
  mainWindow?.webContents.send('demo:status', status);
  demoWindow?.webContents.send('demo:status', status);
}
function requireWindow():BrowserWindow{if(!mainWindow||mainWindow.isDestroyed())throw new Error('TinySA Atomizer window is unavailable');return mainWindow;}
function validatePoint(value:unknown):{x:number;y:number}{if(!value||typeof value!=='object')throw new TypeError('point must be an object');const point=value as Record<string,unknown>;if(!Number.isInteger(point.x)||!Number.isInteger(point.y))throw new TypeError('point coordinates must be integers');return {x:point.x as number,y:point.y as number};}

function validateAgentTurnRequest(value: unknown): AgentTurnRequest {
  if(!value||typeof value!=='object')throw new TypeError('Agent turn must be an object');
  const request=value as Partial<AgentTurnRequest>;
  if(typeof request.applicationContext!=='string')throw new TypeError('applicationContext must be a string');
  if(request.prompt!==undefined&&(typeof request.prompt!=='string'||request.prompt.length>20_000))throw new TypeError('prompt must be a bounded string');
  if(request.conversationId!==undefined&&(typeof request.conversationId!=='string'||request.conversationId.length>256))throw new TypeError('conversationId must be a bounded string');
  if(request.toolOutputs!==undefined&&(!Array.isArray(request.toolOutputs)||request.toolOutputs.length>16||request.toolOutputs.some(item=>!item||typeof item.callId!=='string'||item.callId.length>256||typeof item.output!=='string'||item.output.length>200_000||(item.imageDataUrl!==undefined&&(typeof item.imageDataUrl!=='string'||!/^data:image\/(png|jpeg);base64,/.test(item.imageDataUrl)||item.imageDataUrl.length>12_000_000)))))throw new TypeError('toolOutputs are invalid');
  const hasPrompt=Boolean(request.prompt?.trim());const hasOutputs=Boolean(request.toolOutputs?.length);
  if(hasPrompt===hasOutputs)throw new TypeError('Agent turn requires either a prompt or tool outputs');
  return request as AgentTurnRequest;
}

async function createWindow(): Promise<void> {
  const allowedOrigin=(url:string)=>url.startsWith('file://')||url.startsWith('http://localhost:5173');
  session.defaultSession.setPermissionCheckHandler((_webContents,permission,origin)=>permission==='media'&&allowedOrigin(origin));
  session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(permission==='media'&&allowedOrigin(webContents.getURL())));
  const win = new BrowserWindow({
    width: 1580, height: 980, minWidth: 1120, minHeight: 720, backgroundColor: '#070b0b',
    webPreferences: { preload: join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow=win;win.on('closed',()=>{mainWindow=undefined;if(demoWindow&&!demoWindow.isDestroyed())demoWindow.close();});
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!device.streaming) return;
    void device.stopStreaming()
      .then(() => broadcastDemoStatus(transport.setPlayback(false)))
      .catch((error) => {
        console.error(`Continuous acquisition did not stop after renderer process ${details.reason}`, error);
      });
  });
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(here, '../renderer/index.html'));
}

async function prepareStartupInstrument(): Promise<void> {
  const candidates = await device.listDevices();
  const status = transport.status();
  if (!status.available) return;
  const demo = candidates.find((candidate) => candidate.id === transport.demo.port.id);
  if (!demo) throw new Error('Signal Lab was activated without its synthesized ZS407 candidate');
  await device.connect(demo);
}

async function createDemoWindow(): Promise<void> {
  if (!transport.status().available) return;
  const win = new BrowserWindow({
    width: 520,
    height: 590,
    minWidth: 520,
    minHeight: 590,
    maxWidth: 520,
    maxHeight: 590,
    resizable: false,
    parent: mainWindow,
    title: 'Atom Signal Lab',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    show: false,
    webPreferences: { preload: join(here, 'demo-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  demoWindow = win;
  win.on('closed', () => { demoWindow = undefined; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(`${process.env.VITE_DEV_SERVER_URL}/demo.html`);
  else await win.loadFile(join(here, '../renderer/demo.html'));
}
registerIpc();
device.subscribe((event: DeviceEvent) => {
  if (event.type === 'error' && transport.status().playback) broadcastDemoStatus(transport.setPlayback(false));
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`tinysa:event:v${API_VERSION}`, event);
});
app.whenReady().then(async () => {
  await prepareStartupInstrument();
  await createWindow();
  await createDemoWindow();
}).catch((error) => {
  console.error('TinySA Atomizer startup failed', error);
  app.exit(1);
});
app.on('before-quit', () => ai.close());
app.on('window-all-closed', () => {
  if (device.snapshot().connection === 'disconnected') {
    device.dispose();
    app.quit();
    return;
  }
  void device.disconnect().then(()=>app.quit()).catch(error=>{
    console.error('TinySA Atomizer shutdown failed while disconnecting the instrument',error);
    app.exit(1);
  });
});
