import {
  generatorConfigSchema,
  type GeneratorConfig,
  type InstrumentScreenFrame,
  type InstrumentSessionSnapshot,
  type SignalLabChannelState,
} from '@tinysa/contracts';
import { assertWorkspaceTransition } from '../ui-contracts.js';
import type { InstrumentScreenPoint } from '../components/DeviceWorkspace.js';
import { errorMessage, type RendererKernel } from './kernel.js';

export class FeaturesController {
  constructor(private readonly k: RendererKernel) {}

  /** Throwing profile-selection transaction shared by the UI and Atom paths.
   * Both run the same continuous-paused executeInstrumentFeature lifecycle, so
   * the profile-driven span restaging is identical for either caller. */
  selectSignalLabProfileCommanded(profileId: string) {
    const k = this.k;
    return k.acquisition.runInstrumentTransaction('select-signal-lab-profile', () => k.acquisition.runWithContinuousPaused(
      'SignalLab profile selection',
      () => k.events.executeInstrumentFeature({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId }),
    ));
  }

  async selectSignalLabProfile(profileId: string): Promise<void> {
    const k = this.k;
    try {
      await this.selectSignalLabProfileCommanded(profileId);
      k.set({ notice: `SignalLab profile selected: ${profileId}` });
    } catch (value) { k.set({ error: `SignalLab profile selection failed: ${errorMessage(value)}` }); }
  }

  async configureSignalLabChannel(channel: SignalLabChannelState): Promise<void> {
    const k = this.k;
    try {
      await k.acquisition.runInstrumentTransaction('configure-signal-lab-channel', () => k.acquisition.runWithContinuousPaused(
        'SignalLab channel configuration',
        () => k.events.executeInstrumentFeature({
          kind: 'signal-lab-profile-selection',
          action: 'configure-channel',
          channel,
        }),
      ));
      k.set({ notice: `SignalLab channel configured: ${channel.model.toUpperCase()}` });
    } catch (value) { k.set({ error: `SignalLab channel configuration failed: ${errorMessage(value)}` }); }
  }

  async configureSignalLabCustomWaveform(standard: 'lte' | 'nr' | 'wifi', selections: Readonly<Record<string, string>>): Promise<void> {
    const k = this.k;
    try {
      await k.acquisition.runInstrumentTransaction('configure-signal-lab-custom-waveform', () => k.acquisition.runWithContinuousPaused(
        'SignalLab custom waveform configuration',
        () => k.events.executeInstrumentFeature({
          kind: 'signal-lab-profile-selection',
          action: 'configure-custom-waveform',
          standard,
          selections,
        }),
      ));
      k.set({ notice: `Custom ${standard.toUpperCase()} waveform configured` });
    } catch (value) { k.set({ error: `Custom waveform configuration failed: ${errorMessage(value)}` }); }
  }

  configureGeneratorWith(config: GeneratorConfig) {
    return this.k.acquisition.runInstrumentTransaction('configure-rf-generator', () => this.k.acquisition.runWithContinuousPaused(
      'generator configuration',
      () => this.configureGeneratorOwned(config),
    ));
  }

  async configureGeneratorOwned(config: GeneratorConfig) {
    const k = this.k;
    k.requireConnected();
    const validated = generatorConfigSchema.parse(config);
    k.set({ error: undefined, acquisition: 'configuring' });
    try {
      const next = await k.events.executeInstrumentFeature({
        kind: 'rf-generator',
        action: 'configure',
        frequencyHz: validated.frequencyHz,
        levelDbm: validated.levelDbm,
        path: validated.path,
        modulation: validated.modulation === 'off'
          ? { mode: 'off' }
          : validated.modulation === 'am'
            ? { mode: 'am', modulationFrequencyHz: validated.modulationFrequencyHz, depthPercent: validated.amDepthPercent }
            : { mode: 'fm', modulationFrequencyHz: validated.modulationFrequencyHz, deviationHz: validated.fmDeviationHz },
      });
      k.events.acceptFeatureResult(next);
      k.set({ acquisition: 'complete' });
      return next;
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async configureGeneratorFromUi(): Promise<void> { try { await this.configureGeneratorWith(this.k.state.generator); } catch { /* Visible in the workspace alert. */ } }

  setOutput(enabled: boolean) {
    return this.k.acquisition.runInstrumentTransaction(enabled ? 'enable-rf-output' : 'disable-rf-output', () => this.k.acquisition.runWithContinuousPaused(
      enabled ? 'RF output enable' : 'RF output disable',
      () => this.setOutputOwned(enabled),
      () => !enabled,
    ));
  }

  async setOutputOwned(enabled: boolean) {
    const k = this.k;
    k.requireConnected();
    k.set({ error: undefined, acquisition: 'configuring' });
    try {
      await this.configureGeneratorOwned(generatorConfigSchema.parse(k.state.generator));
      const next = await k.events.executeInstrumentFeature({ kind: 'rf-generator', action: 'set-output', enabled });
      k.events.acceptFeatureResult(next);
      k.set({ acquisition: 'complete' });
      return next;
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async setOutputFromUi(enabled: boolean): Promise<void> { try { await this.setOutput(enabled); } catch { /* Visible in the workspace alert. */ } }

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
      if (resume && k.continuousRequested.current) {
        while (true) {
          if (!k.continuousRequested.current) break;
          this.requireRemoteGestureSession(sessionId);
          const targetRevision = k.analyzerRevision.current;
          const configured = await k.acquisition.configureAnalyzer(k.state.analyzer, 'retuning');
          if (!k.continuousRequested.current) break;
          if (targetRevision !== k.analyzerRevision.current) continue;
          this.requireRemoteGestureSession(sessionId);
          await k.acquisition.startStreamingWithConfiguration(configured.configurationRevision);
          if (!k.continuousRequested.current) {
            await k.acquisition.stopStreamingAndReleaseConfiguration();
            break;
          }
          if (targetRevision === k.analyzerRevision.current) break;
          await k.acquisition.stopStreamingAndReleaseConfiguration();
        }
        if (k.continuousRequested.current) {
          k.set({ acquisition: 'streaming', notice: 'Continuous acquisition resumed after remote screen tap' });
        } else {
          k.acquisition.completeContinuousStop('Continuous acquisition stopped after remote screen tap');
        }
      } else if (resume) {
        k.acquisition.completeContinuousStop('Continuous acquisition stopped after remote screen tap');
      }
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
}
