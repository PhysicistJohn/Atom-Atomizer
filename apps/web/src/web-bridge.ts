import {
  ATOMIZER_FILES_API_VERSION,
  ATOMIZER_INSTRUMENT_API_VERSION,
  type AtomizerFilesApiV1,
  type AtomizerInstrumentApiV1,
  type SweepExportRequest,
} from '@tinysa/contracts';
import { createBrowserAtomAgent } from './atom-realtime-client.js';
import { InstrumentDriverRegistry, InstrumentManager, type InstrumentDriver } from '@tinysa/instrument-runtime';
import {
  AtomizerInstrumentHost,
  type AtomizerInstrumentPreferencePort,
} from '../../desktop/src/main/atomizer-instrument-host.js';
import type { LoadedInstrumentPreference } from '../../desktop/src/main/instrument-preference.js';
import {
  BrowserSignalLabWorkerDriver,
  BROWSER_SIGNAL_LAB_CANDIDATE_ID,
  BROWSER_SIGNAL_LAB_DRIVER_ID,
} from './browser-signal-lab-driver.js';

const PREF_KEY = 'atomizer:web:instrument-preference';

const FACTORY_PREFERENCE = {
  schemaVersion: 1,
  driverId: BROWSER_SIGNAL_LAB_DRIVER_ID,
  candidateKind: 'signal-lab',
  candidateId: BROWSER_SIGNAL_LAB_CANDIDATE_ID,
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

/**
 * localStorage-backed implementation of the same preference port the desktop
 * host satisfies with its audited on-disk store. The browser has exactly one
 * admissible source, so the persisted value only records that the operator
 * confirmed it as the startup default.
 */
const browserPreferencePort: AtomizerInstrumentPreferencePort = {
  async load(): Promise<LoadedInstrumentPreference> {
    try {
      const saved = localStorage.getItem(PREF_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { updatedAt?: unknown };
        if (typeof parsed.updatedAt === 'string') {
          return { source: 'persisted', preference: { ...FACTORY_PREFERENCE, updatedAt: parsed.updatedAt } };
        }
      }
    } catch {
      // Storage may be disabled; the in-browser default remains deterministic.
    }
    return { source: 'factory-default', preference: FACTORY_PREFERENCE };
  },
  async save(driverId, candidateKind, candidateId) {
    if (driverId !== FACTORY_PREFERENCE.driverId
      || candidateKind !== FACTORY_PREFERENCE.candidateKind
      || candidateId !== FACTORY_PREFERENCE.candidateId) {
      throw new Error('The selected instrument is not available in this browser.');
    }
    const preference = { ...FACTORY_PREFERENCE, updatedAt: new Date().toISOString() };
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(preference));
    } catch {
      // The selection still applies for this session when storage is unavailable.
    }
    return preference;
  },
};

/**
 * The browser edition runs the same InstrumentManager + AtomizerInstrumentHost
 * stack as the desktop main process. SignalLab itself lives in a dedicated
 * module worker so waveform generation, hashing, and I/Q decoding never block
 * the page; only this transport driver and thin window-API adapter differ.
 * Contract enforcement, streaming, event ordering, and measurement
 * reconciliation remain shared rather than reimplemented.
 */
function createBrowserInstrumentApi(
  driver: InstrumentDriver = new BrowserSignalLabWorkerDriver(),
): AtomizerInstrumentApiV1 {
  const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]));
  const host = new AtomizerInstrumentHost(manager, browserPreferencePort);
  return {
    version: ATOMIZER_INSTRUMENT_API_VERSION,
    getState: async () => host.state(),
    discover: () => host.discover(),
    connect: (candidate) => host.connect(candidate),
    disconnect: () => host.disconnect(),
    configure: (configuration) => host.configure(configuration),
    acquire: () => host.acquire(),
    startStreaming: () => host.startStreaming(),
    stopStreaming: () => host.stopStreaming(),
    executeFeature: (request) => host.executeFeature(request),
    readPreference: () => host.readPreference(),
    writePreference: (selection) => host.writePreference(selection),
    subscribe: (listener) => host.subscribe(listener),
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const files: AtomizerFilesApiV1 = {
  version: ATOMIZER_FILES_API_VERSION,
  async exportSweep(request: SweepExportRequest) {
    const content = request.format === 'json'
      ? `${JSON.stringify(request.sweep, null, 2)}\n`
      : [
          'frequency_hz,power_dbm',
          ...request.sweep.frequencyHz.map((frequency, index) => `${csvCell(frequency)},${csvCell(request.sweep.powerDbm[index])}`),
        ].join('\n') + '\n';
    const filename = `atomizer-${request.sweep.capturedAt.replace(/[:.]/g, '-')}.${request.format}`;
    const blob = new Blob([content], { type: request.format === 'json' ? 'application/json' : 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return { status: 'saved', path: filename, format: request.format, bytesWritten: new TextEncoder().encode(content).byteLength };
  },
};

let installed = false;

export function installWebBridge(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.atomizerInstrument = createBrowserInstrumentApi();
  window.atomizerFiles = files;
  // Atom runs in the browser against worker-minted ephemeral Realtime tokens;
  // status() reflects whether the deployment carries the OPENAI_KEY secret.
  window.atomAgent = createBrowserAtomAgent();
}

export { createBrowserInstrumentApi };
