import { app, BrowserWindow, dialog, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import {
  NodeSerialTransport,
  PhysicalOrTwinTransport,
  RenodeDigitalTwinTransport,
  TinySaDeviceService,
  TinySaZs407InstrumentDriver,
} from '@tinysa/device';
import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';
import { SignalLabInstrumentDriver } from '@tinysa/signal-lab-driver';
import { OpenAiGateway } from './ai-gateway.js';
import { AppComputerHarness } from './app-computer.js';
import { defaultSweepFilename, serializeSweep } from './sweep-export.js';
import { AtomizerInstrumentHost } from './atomizer-instrument-host.js';
import { registerAtomizerInstrumentIpc } from './atomizer-instrument-ipc.js';
import { registerAtomizerAuxiliaryIpc } from './atomizer-auxiliary-ipc.js';
import { InstrumentPreferenceStore } from './instrument-preference.js';
import { SafeShutdownGate } from './safe-shutdown-gate.js';
import { BoundedPrivilegedIpcAdmission } from './privileged-ipc-admission.js';
import { loadPrivateEnvironmentFromCandidates, selectPrivateEnvironmentCandidates } from './private-environment.js';
import {
  assertTrustedRendererEvent,
  developmentRendererTrust,
  isTrustedMediaPermission,
  isTrustedRendererUrl,
  productionRendererTrust,
  selectDevelopmentServerUrl,
  type RendererTrust,
} from './renderer-trust.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const privateEnvironment = selectPrivateEnvironmentCandidates(process.env.TINYSA_ENV_FILE, [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(here, '../../../../.env'),
]);
await loadPrivateEnvironmentFromCandidates(privateEnvironment.candidates, {
  explicitFirstCandidate: privateEnvironment.explicitFirstCandidate,
});
const firmwareRepository = resolve(process.env.TINYSA_FIRMWARE_REPO?.trim() || resolve(here, '../../../../../Atom-Firmware'));
const atomizerRepository = resolve(process.env.ATOMIZER_REPOSITORY_ROOT?.trim() || resolve(here, '../../../..'));
const transport = new PhysicalOrTwinTransport(new NodeSerialTransport(), new RenodeDigitalTwinTransport(firmwareRepository));
const device = new TinySaDeviceService(transport);
const ai = new OpenAiGateway();
const computer = new AppComputerHarness((bounds) => screen.getDisplayMatching(bounds).scaleFactor);
let mainWindow: BrowserWindow | undefined;
let rendererTrust: RendererTrust | undefined;
const shutdownGate = new SafeShutdownGate();
const ipcAdmission = new BoundedPrivilegedIpcAdmission();
app.setName('Atomizer');
const instrumentManager = new InstrumentManager(new InstrumentDriverRegistry([
  new TinySaZs407InstrumentDriver(device),
  new SignalLabInstrumentDriver({
    atomizerRepositoryRoot: atomizerRepository,
    ...(app.isPackaged ? { packagedResourcesRoot: process.resourcesPath } : {}),
  }),
]));
const instrumentHost = new AtomizerInstrumentHost(
  instrumentManager,
  new InstrumentPreferenceStore(join(app.getPath('userData'), 'instrument')),
);
let unregisterIpc: (() => void) | undefined;

function registerIpc(): void {
  const removeInstrumentIpc = registerAtomizerInstrumentIpc(ipcMain, instrumentHost, (channel, event) => {
    if (!mainWindow || mainWindow.isDestroyed() || !isTrustedRendererUrl(mainWindow.webContents.mainFrame.url, rendererTrust)) return;
    mainWindow.webContents.send(channel, event);
  }, assertTrustedIpcEvent, ipcAdmission);
  try {
    const removeAuxiliaryIpc = registerAtomizerAuxiliaryIpc(ipcMain, {
      exportSweep: async (request) => {
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
      },
      aiStatus: () => ai.status(),
      createRealtimeCall: (sdp) => ai.createRealtimeCall(sdp),
      agentTurn: (request) => ai.agentTurn(request),
      computerScreenshot: () => computer.screenshot(requireWindow()),
      computerClick: (input) => computer.click(requireWindow(), input.screenshotId, input.x, input.y),
      computerType: (input) => computer.type(requireWindow(), input.expectedTarget, input.text),
      computerKey: (input) => computer.key(requireWindow(), input.expectedTarget, input.key),
      computerScroll: (input) => computer.scroll(requireWindow(), input.screenshotId, input.x, input.y, input.deltaX, input.deltaY),
    }, assertTrustedIpcEvent, ipcAdmission);
    unregisterIpc = () => {
      removeAuxiliaryIpc();
      removeInstrumentIpc();
    };
  } catch (error) {
    removeInstrumentIpc();
    throw error;
  }
}
function requireWindow():BrowserWindow{if(!mainWindow||mainWindow.isDestroyed())throw new Error('Atomizer window is unavailable');return mainWindow;}

function assertTrustedIpcEvent(event: IpcMainInvokeEvent): void {
  const webContents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
  assertTrustedRendererEvent(event, webContents, rendererTrust);
}

async function createWindow(): Promise<void> {
  const rendererPath = join(here, '../renderer/index.html');
  const developmentUrl = selectDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL, app.isPackaged);
  const trust = developmentUrl ? developmentRendererTrust(developmentUrl) : productionRendererTrust(rendererPath);
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  // Exact no-scroll content floor: Device + Atom needs
  // 104 + 36 + 438 + 420 + 14 + 520 = 1532 CSS px, while the embedded
  // SignalLab dense profile needs 72 + 22 + 709 + 18 = 821 CSS px.
  const startupWidth = Math.min(1532, workArea.width);
  const startupHeight = Math.min(821, workArea.height);
  const win = new BrowserWindow({
    width: startupWidth, height: startupHeight,
    minWidth: Math.min(1532, startupWidth), minHeight: Math.min(821, startupHeight),
    useContentSize: true, backgroundColor: '#070b0b',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    }
  });
  mainWindow = win;
  rendererTrust = trust;
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = undefined;
      rendererTrust = undefined;
    }
  });
  win.webContents.session.setPermissionCheckHandler((webContents, permission, origin, details) => (
    isTrustedMediaPermission(webContents, permission, details, origin, win.webContents, trust)
  ));
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const securityOrigin = 'securityOrigin' in details && typeof details.securityOrigin === 'string'
      ? details.securityOrigin
      : undefined;
    callback(isTrustedMediaPermission(webContents, permission, details, securityOrigin, win.webContents, trust));
  });
  win.webContents.on('console-message', (_details, level, message, line, sourceId) => {
    const rendered = `[RENDERER:${level}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`;
    if (level >= 3) console.error(rendered);
    else if (level === 2) console.warn(rendered);
    else console.info(rendered);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url, trust)) event.preventDefault();
  };
  win.webContents.on('will-navigate', preventUntrustedNavigation);
  win.webContents.on('will-redirect', preventUntrustedNavigation);
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    void disconnectAfterRendererFailure(details.reason).catch((error) => {
      console.error('Atomizer could not present renderer-failure instrument recovery', error);
    });
  });
  if (developmentUrl) await win.loadURL(developmentUrl.href);
  else await win.loadFile(rendererPath);
}

async function disconnectAfterRendererFailure(reason: string): Promise<void> {
  while (true) {
    try {
      await instrumentHost.disconnect();
      return;
    } catch (error) {
      console.error(`Instrument session did not reach RF-safe disconnect after renderer process ${reason}`, error);
      const result = await dialog.showMessageBox({
        type: 'error',
        title: 'Instrument disconnect needs attention',
        message: 'RF output-off or instrument disconnect could not be confirmed after the app display failed.',
        detail: `The app remains open. Inspect the instrument, then retry the safe disconnect.\n\n${error instanceof Error ? error.message : String(error)}`.slice(0, 4_096),
        buttons: ['Retry disconnect', 'Keep app open'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response !== 0) return;
      // A retry occurs only after this explicit local operator action.
    }
  }
}

async function connectDefaultInstrument(): Promise<void> {
  const state = await instrumentHost.startPreferredInstrument();
  if (state.startup.status === 'failed') {
    console.error(`Default instrument ${state.startup.stage} failed: ${state.startup.message}`);
  }
}

registerIpc();
app.whenReady().then(async () => {
  await createWindow();
  await connectDefaultInstrument();
}).catch((error) => {
  console.error('Atomizer startup failed', error);
  process.exitCode = 1;
  // Route startup failure through the same RF-safe shutdown gate. A partially
  // admitted instrument session must never be abandoned by an immediate exit.
  app.quit();
});
app.on('before-quit', (event) => {
  const decision = shutdownGate.intercept(event);
  if (decision !== 'start') return;
  void instrumentHost.shutdown().then(() => {
    shutdownGate.complete();
    try { ai.close(); } catch (error) { console.error('Atomizer AI cleanup failed after safe instrument shutdown', error); }
    try { device.dispose(); } catch (error) { console.error('Atomizer device cleanup failed after safe instrument shutdown', error); }
    try { unregisterIpc?.(); } catch (error) { console.error('Atomizer IPC cleanup failed after safe instrument shutdown', error); }
    unregisterIpc = undefined;
    app.quit();
  }, (error) => {
    console.error('Atomizer shutdown failed while commanding RF off and disconnecting the instrument', error);
    shutdownGate.retry();
    void (async () => {
      if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
      await dialog.showMessageBox({
        type: 'error',
        title: 'Atomizer remains open',
        message: 'RF output-off or instrument disconnect could not be confirmed.',
        detail: 'The app did not quit. Inspect the instrument, then quit again to retry the safe shutdown.',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      });
    })().catch((restoreError) => console.error('Atomizer could not restore its shutdown-failure window', restoreError));
  });
});
app.on('window-all-closed', () => app.quit());
