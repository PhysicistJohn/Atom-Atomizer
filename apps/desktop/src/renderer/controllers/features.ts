import {
  type InstrumentScreenFrame,
  type InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import { assertWorkspaceTransition } from '../ui-contracts.js';
import type { InstrumentScreenPoint } from '../components/DeviceWorkspace.js';
import { measurementIdentity } from '../instrument-measurement-projection.js';
import { errorMessage, type RendererKernel } from './kernel.js';

export class FeaturesController {
  constructor(private readonly k: RendererKernel) {}

  refreshDiagnostics(): Promise<readonly string[]> {
    return this.k.acquisition.runInstrumentTransaction('read-instrument-diagnostics', () => this.refreshDiagnosticsOwned());
  }

  async refreshDiagnosticsOwned(): Promise<readonly string[]> {
    const k = this.k;
    const active = k.requireConnected();
    k.set({ error: undefined, acquisition: 'acquiring' });
    try {
      const capability = active.capabilities.features.find((feature) => feature.kind === 'diagnostics');
      if (!capability) throw new Error('Connected driver exposes no diagnostics capability');
      const next: string[] = [];
      for (const report of capability.reports) {
        const result = await k.events.executeInstrumentFeature({ kind: 'diagnostics', action: 'read', report });
        if (result.kind !== 'diagnostics') throw new Error(`Expected diagnostics feature result, received ${result.kind}`);
        next.push(`[${report}]`, ...result.lines);
      }
      k.set({ diagnostics: next, acquisition: 'complete' });
      return next;
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async refreshDiagnosticsFromUi(): Promise<void> { try { await this.refreshDiagnostics(); } catch { /* Visible in the workspace alert. */ } }

  captureScreen(): Promise<InstrumentScreenFrame> {
    return this.k.acquisition.runInstrumentTransaction('capture-instrument-screen', () => this.captureScreenOwned());
  }

  async captureScreenOwned(): Promise<InstrumentScreenFrame> {
    const k = this.k;
    k.requireConnected();
    assertWorkspaceTransition(k.state.workspace, 'device', k.currentGeneratorOutput());
    k.set({ error: undefined, acquisition: 'acquiring' });
    try {
      const result = await k.events.executeInstrumentFeature({ kind: 'screen', action: 'capture' });
      if (result.kind !== 'screen') throw new Error(`Expected screen feature result, received ${result.kind}`);
      const frame = result.frame;
      k.set({ screenFrame: frame });
      k.applyWorkspace('device');
      k.set({ acquisition: 'complete' });
      return frame;
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async captureScreenFromUi(): Promise<void> { try { await this.captureScreen(); } catch { /* Visible in the workspace alert. */ } }

  queueRemoteTap(point: InstrumentScreenPoint): Promise<void> | undefined {
    const k = this.k;
    // Repeated pointer events are dropped without allocating a retained
    // Promise/closure for every stale gesture; the ref is the actual
    // one-slot admission gate.
    if (k.remoteGestureTask.current) return undefined;
    const sessionId = k.state.instrument.session?.sessionId;
    if (!sessionId) {
      k.set({ error: 'Remote screen tap requires a connected instrument' });
      return undefined;
    }
    const task = k.acquisition.runInstrumentTransaction('remote-screen-tap', async () => {
      this.requireRemoteGestureSession(sessionId);
      await this.performRemoteTap(point, sessionId);
    });
    k.remoteGestureTask.current = task;
    k.set({ remoteGestureActive: true });
    void task.then(
      () => this.finishRemoteGesture(task),
      (value) => {
        if (k.state.instrument.session?.sessionId === sessionId) {
          k.set({ error: `Remote screen tap failed: ${errorMessage(value)}` });
        }
        this.finishRemoteGesture(task);
      },
    );
    return task;
  }

  finishRemoteGesture(task: Promise<void>): void {
    const k = this.k;
    if (k.remoteGestureTask.current !== task) return;
    k.remoteGestureTask.current = undefined;
    k.set({ remoteGestureActive: false });
  }

  requireRemoteGestureSession(sessionId: string): InstrumentSessionSnapshot {
    const active = this.k.requireConnected();
    if (active.sessionId !== sessionId || active.fault) {
      throw new Error(`Remote screen tap was invalidated with instrument session ${sessionId}`);
    }
    return active;
  }

  async performRemoteTap(point: InstrumentScreenPoint, sessionId: string): Promise<void> {
    const k = this.k;
    this.requireRemoteGestureSession(sessionId);
    const resume = k.continuousRequested.current;
    try {
      if (resume) {
        k.set({ acquisition: 'retuning', notice: 'Pausing continuous acquisition for remote screen tap…' });
        await k.acquisition.stopStreamingAndReleaseConfiguration();
      }
      this.requireRemoteGestureSession(sessionId);
      await k.events.executeInstrumentFeature({ kind: 'touch', action: 'tap', x: point.x, y: point.y });
      // A remote tap invalidates the driver's admitted configuration. Do not
      // synthesize a replacement from renderer memory; the operator applies
      // the driver's generic controls again before starting a new stream.
      if (resume) k.acquisition.completeContinuousStop(
        'Continuous acquisition stopped after remote screen tap; apply driver controls to resume',
      );
    } catch (value) {
      k.set({ acquisition: 'failed', error: `Remote screen tap failed: ${errorMessage(value)}` });
      throw value;
    }
  }

  tapScreen(point: InstrumentScreenPoint): void { void this.queueRemoteTap(point); }

  async exportLatest(format: 'csv' | 'json'): Promise<unknown> {
    const k = this.k;
    const latestSweep = k.state.sweep;
    if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before exporting');
    k.set({ error: undefined });
    try {
      const result = await window.atomizerFiles.exportSweep({ sweep: latestSweep, format });
      if (result.status === 'saved') k.set({ notice: `Saved ${result.bytesWritten.toLocaleString()} provenance-bearing bytes to ${result.path}` });
      return result;
    } catch (value) {
      k.set({ error: errorMessage(value) });
      throw value;
    }
  }

  async exportLatestFromUi(format: 'csv' | 'json'): Promise<void> {
    try { await this.exportLatest(format); }
    catch { /* exportLatest already presents the boundary failure in the workspace. */ }
  }

  async exportLatestIq(): Promise<unknown> {
    const k = this.k;
    k.set({ error: undefined });
    try {
      const measurement = k.state.iqCapture;
      if (!measurement) throw new Error('Acquire a complete complex-I/Q capture before exporting');
      const session = k.requireConnected();
      if (measurement.sessionId !== session.sessionId) {
        throw new Error('The latest complex-I/Q capture does not belong to the active instrument session');
      }
      const result = await window.atomizerFiles.exportComplexIq({
        measurement,
        identity: measurementIdentity(session),
      });
      if (result.status === 'saved') {
        k.set({ notice: `Saved ${result.bytesWritten.toLocaleString()} byte-exact SigMF bytes to ${result.metaPath} and ${result.dataPath}` });
      }
      return result;
    } catch (value) {
      k.set({ error: errorMessage(value) });
      throw value;
    }
  }

  async exportLatestIqFromUi(): Promise<void> {
    try { await this.exportLatestIq(); }
    catch { /* exportLatestIq already presents the boundary failure in the workspace. */ }
  }
}
