import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import {
  API_VERSION,
  analyzerConfigSchema,
  firmwareFlashRequestSchema,
  firmwareUpdatePreflightSchema,
  generatorConfigSchema,
  portCandidateSchema,
  screenPointSchema,
  sweepExportRequestSchema,
  zeroSpanConfigSchema,
  type DeviceEvent,
} from '@tinysa/contracts';
import { TinySaDeviceService, NodeSerialTransport, PhysicalOrTwinTransport, RenodeDigitalTwinTransport } from '@tinysa/device';
import { OpenAiGateway } from './ai-gateway.js';
import type { AgentTurnRequest } from '@tinysa/agent';
import { AppComputerHarness } from './app-computer.js';
import { defaultSweepFilename, serializeSweep } from './sweep-export.js';
import { selectStartupInstrument } from './startup-admission.js';
import { FirmwareUpdater } from './firmware-updater.js';
import { isAllowedOfficialReference } from './official-references.js';

const here = fileURLToPath(new URL('.', import.meta.url));
for(const candidate of [process.env.TINYSA_ENV_FILE,resolve(process.cwd(),'.env'),resolve(process.cwd(),'../../.env'),resolve(here,'../../../../.env')]){
  if(candidate&&existsSync(candidate)){loadEnv({path:candidate,quiet:true});break;}
}
const firmwareRepository = resolve(process.env.TINYSA_FIRMWARE_REPO?.trim() || resolve(here, '../../../../../TinySA_Firmware'));
const transport = new PhysicalOrTwinTransport(new NodeSerialTransport(), new RenodeDigitalTwinTransport(firmwareRepository));
const device = new TinySaDeviceService(transport);
const ai = new OpenAiGateway();
const computer = new AppComputerHarness();
let mainWindow: BrowserWindow | undefined;
let shutdownStarted = false;
app.setName('TinySA Atomizer');
const firmwareUpdater = new FirmwareUpdater(join(app.getPath('userData'), 'firmware'), device);

function registerIpc(): void {
  ipcMain.handle('tinysa:list', () => device.listDevices());
  ipcMain.handle('tinysa:connect', async (_event, value: unknown) => {
    const snapshot = await device.connect(portCandidateSchema.parse(value));
    return snapshot;
  });
  ipcMain.handle('tinysa:disconnect', () => device.disconnect());
  ipcMain.handle('tinysa:snapshot', () => device.snapshot());
  ipcMain.handle('tinysa:analyzer:configure', (_event, value: unknown) => device.configureAnalyzer(analyzerConfigSchema.parse(value)));
  ipcMain.handle('tinysa:analyzer:acquire', () => device.acquireSweep());
  ipcMain.handle('tinysa:analyzer:stream:start', () => device.startStreaming());
  ipcMain.handle('tinysa:analyzer:stream:stop', () => device.stopStreaming());
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
  ipcMain.handle('tinysa:firmware:state', () => firmwareUpdater.state());
  ipcMain.handle('tinysa:firmware:download', () => firmwareUpdater.download());
  ipcMain.handle('tinysa:firmware:prepare', (_event, value: unknown) => firmwareUpdater.prepare(firmwareUpdatePreflightSchema.parse(value)));
  ipcMain.handle('tinysa:firmware:detect-dfu', () => firmwareUpdater.detectDfu());
  ipcMain.handle('tinysa:firmware:flash', (_event, value: unknown) => firmwareUpdater.flash(firmwareFlashRequestSchema.parse(value)));
  ipcMain.handle('ai:status', () => ai.status());
  ipcMain.handle('ai:realtime:call', (_event, sdp: unknown) => { if(typeof sdp!=='string')throw new TypeError('sdp must be a string');return ai.createRealtimeCall(sdp); });
  ipcMain.handle('ai:agent:turn', (_event, request: unknown) => ai.agentTurn(validateAgentTurnRequest(request)));
  ipcMain.handle('ai:computer:screenshot', () => computer.screenshot(requireWindow()));
  ipcMain.handle('ai:computer:click', (_event,point:unknown) => {const {x,y}=validatePoint(point);return computer.click(requireWindow(),x,y);});
  ipcMain.handle('ai:computer:type', (_event,text:unknown) => {if(typeof text!=='string')throw new TypeError('text must be a string');return computer.type(requireWindow(),text);});
  ipcMain.handle('ai:computer:key', (_event,key:unknown) => {if(typeof key!=='string')throw new TypeError('key must be a string');return computer.key(requireWindow(),key);});
  ipcMain.handle('ai:computer:scroll', (_event,value:unknown) => {if(!value||typeof value!=='object')throw new TypeError('scroll must be an object');const input=value as Record<string,unknown>;for(const key of ['x','y','deltaX','deltaY'])if(!Number.isInteger(input[key]))throw new TypeError(`${key} must be an integer`);return computer.scroll(requireWindow(),input.x as number,input.y as number,input.deltaX as number,input.deltaY as number);});
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
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const startupWidth = Math.min(1720, workArea.width);
  const startupHeight = Math.min(1040, workArea.height);
  const win = new BrowserWindow({
    width: startupWidth, height: startupHeight, minWidth: Math.min(1280, startupWidth), minHeight: Math.min(800, startupHeight), backgroundColor: '#070b0b',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } } : {}),
    webPreferences: { preload: join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow=win;win.on('closed',()=>{mainWindow=undefined;});
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOfficialReference(url)) {
      void shell.openExternal(url).catch((error) => {
        const message = `Opening the allow-listed OEM reference failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(message, error);
        win.webContents.send(`tinysa:event:v${API_VERSION}`, { type: 'error', error: { code: 'unsupported', message, recoverable: true } } satisfies DeviceEvent);
      });
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!device.streaming) return;
    void device.stopStreaming()
      .then(() => undefined)
      .catch((error) => {
        console.error(`Continuous acquisition did not stop after renderer process ${details.reason}`, error);
      });
  });
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(here, '../renderer/index.html'));
}

async function connectDefaultInstrument(): Promise<void> {
  try {
    const candidates = await device.listDevices();
    const candidate = selectStartupInstrument(candidates);
    if (!candidate) return;
    await device.connect(candidate);
  }
  catch (error) {
    const message = `Default instrument admission failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message, error);
    mainWindow?.webContents.send(`tinysa:event:v${API_VERSION}`, { type: 'error', error: { code: 'transport', message, recoverable: false } } satisfies DeviceEvent);
  }
}

registerIpc();
device.subscribe((event: DeviceEvent) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`tinysa:event:v${API_VERSION}`, event);
});
app.whenReady().then(async () => {
  await createWindow();
  void connectDefaultInstrument();
}).catch((error) => {
  console.error('TinySA Atomizer startup failed', error);
  app.exit(1);
});
app.on('before-quit', (event) => {
  ai.close();
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (device.snapshot().connection === 'disconnected') {
    device.dispose();
    return;
  }
  event.preventDefault();
  void device.disconnect().then(() => {
    device.dispose();
    app.quit();
  }).catch((error) => {
    console.error('TinySA Atomizer shutdown failed while commanding RF off and disconnecting the instrument', error);
    app.exit(1);
  });
});
app.on('window-all-closed', () => app.quit());
