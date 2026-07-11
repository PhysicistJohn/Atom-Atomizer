import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { analyzerConfigSchema, generatorConfigSchema, portCandidateSchema } from '@tinysa/contracts';
import { TinySaDeviceService, NodeSerialTransport } from '@tinysa/device';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { OpenAiGateway } from './ai-gateway.js';
import type { AgentTurnRequest } from '@tinysa/agent';
import { AppComputerHarness } from './app-computer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
for(const candidate of [process.env.TINYSA_ENV_FILE,resolve(process.cwd(),'.env'),resolve(process.cwd(),'../../.env'),resolve(here,'../../../../.env')]){
  if(candidate&&existsSync(candidate)){loadEnv({path:candidate,quiet:true});break;}
}
const simulation = process.env.TINYSA_SIMULATOR === '1';
const transport = simulation ? new FakeTinySaTransport({ chunkSize: 7 }) : new NodeSerialTransport();
const device = new TinySaDeviceService(transport);
const ai = new OpenAiGateway();
const computer = new AppComputerHarness();
let mainWindow: BrowserWindow | undefined;
app.setName('TinySA Atomizer');

function registerIpc(): void {
  ipcMain.handle('tinysa:list', () => device.listDevices());
  ipcMain.handle('tinysa:connect', (_event, value: unknown) => device.connect(portCandidateSchema.parse(value)));
  ipcMain.handle('tinysa:disconnect', () => device.disconnect());
  ipcMain.handle('tinysa:snapshot', () => device.snapshot());
  ipcMain.handle('tinysa:analyzer:configure', (_event, value: unknown) => device.configureAnalyzer(analyzerConfigSchema.parse(value)));
  ipcMain.handle('tinysa:analyzer:acquire', () => device.acquireSweep());
  ipcMain.handle('tinysa:generator:configure', (_event, value: unknown) => device.configureGenerator(generatorConfigSchema.parse(value)));
  ipcMain.handle('tinysa:generator:output', (_event, enabled: unknown) => { if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean'); return device.setGeneratorOutput(enabled); });
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
  const win = new BrowserWindow({
    width: 1580, height: 980, minWidth: 1120, minHeight: 720, backgroundColor: '#070b0b',
    webPreferences: { preload: join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow=win;win.on('closed',()=>{mainWindow=undefined;});
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(here, '../renderer/index.html'));
}
registerIpc();
app.whenReady().then(createWindow);
app.on('before-quit', () => ai.close());
app.on('window-all-closed', () => {
  void device.disconnect().then(()=>app.quit()).catch(error=>{
    console.error('TinySA Atomizer shutdown failed while disconnecting the instrument',error);
    app.exit(1);
  });
});
