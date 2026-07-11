import { analyzerConfigSchema, generatorConfigSchema, type AnalyzerConfig, type DeviceCapabilities, type DeviceEvent, type DeviceSnapshot, type GeneratorConfig, type PortCandidate, type Sweep } from '@tinysa/contracts';
import { CommandScheduler } from './scheduler.js';
import type { ByteTransport } from './transport.js';

export class TinySaDeviceService {
  #scheduler?: CommandScheduler;
  #snapshot: DeviceSnapshot = { connection: 'disconnected', mode: 'idle', generatorOutput: 'off', verification: 'stale' };
  #listeners = new Set<(event: DeviceEvent) => void>();
  #analyzer?: AnalyzerConfig;
  constructor(private readonly transport: ByteTransport) {}
  listDevices(): Promise<PortCandidate[]> { return this.transport.list(); }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  subscribe(listener: (event: DeviceEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  async connect(port: PortCandidate): Promise<DeviceSnapshot> {
    if (this.#snapshot.connection !== 'disconnected') throw new Error('Device is already active');
    this.#set({ ...this.#snapshot, connection: 'connecting', generatorOutput: 'off' });
    try {
      await this.transport.open(port); this.#scheduler = new CommandScheduler(this.transport);
      this.#set({ ...this.#snapshot, connection: 'identifying' });
      const [version, info, help] = await Promise.all([
        this.#scheduler.execute('version'), this.#scheduler.execute('info', 10_000), this.#scheduler.execute('help', 10_000)
      ]);
      const commands = help.split(/\s+/).filter(Boolean);
      const capabilities: DeviceCapabilities = {
        analyzerFrequency: { min: 100_000, max: 7_300_000_000, unit: 'Hz' }, maxSweepPoints: 450,
        screenCapture: commands.includes('capture'), remoteTouch: commands.includes('touch'), streaming: commands.includes('scan'),
        commands, evidence: 'documented'
      };
      const model=firstLine(info);const firmwareVersion=firstLine(version);
      if(!model||!firmwareVersion)throw new Error('Device identification response is incomplete');
      this.#set({ connection: 'ready', mode: 'idle', generatorOutput: 'off', verification: 'unknown', identity: { model, firmwareVersion, port }, capabilities });
      return this.snapshot();
    } catch (error) {
      let cleanupError: unknown;
      try { await this.transport.close(); } catch (value) { cleanupError=value; }
      this.#scheduler?.dispose(); this.#scheduler = undefined;
      this.#set({ connection: cleanupError?'faulted':'disconnected', mode: 'idle', generatorOutput: 'unknown', verification: 'stale' });
      if(cleanupError)throw new AggregateError([error,cleanupError],'Device connection failed and transport cleanup also failed');
      throw error;
    }
  }
  async disconnect(): Promise<void> {
    const failures:unknown[]=[];
    if(this.#snapshot.generatorOutput==='on')try{await this.#scheduler?.execute('output off');}catch(error){failures.push(error);}
    this.#scheduler?.dispose();this.#scheduler=undefined;
    try{await this.transport.close();}catch(error){failures.push(error);}
    this.#set({connection:failures.length?'faulted':'disconnected',mode:'idle',generatorOutput:'unknown',verification:'stale'});
    if(failures.length===1)throw failures[0];
    if(failures.length>1)throw new AggregateError(failures,'RF-off command and transport close both failed during disconnect');
  }
  async configureAnalyzer(input: AnalyzerConfig): Promise<DeviceSnapshot> {
    const config = analyzerConfigSchema.parse(input); const scheduler = this.#ready();
    await scheduler.execute('mode low input');
    await scheduler.execute(`sweep start ${config.startHz}`); await scheduler.execute(`sweep stop ${config.stopHz}`);
    if (config.rbwKhz !== undefined) await scheduler.execute(`rbw ${config.rbwKhz}`);
    await scheduler.execute(`attenuate ${config.attenuationDb}`); this.#analyzer = config;
    this.#set({ ...this.#snapshot, mode: 'analyzer', generatorOutput: 'off', verification: 'commanded' }); return this.snapshot();
  }
  async acquireSweep(): Promise<Sweep> {
    const scheduler = this.#ready(); const config = this.#analyzer;
    if (!config || this.#snapshot.mode !== 'analyzer' || !this.#snapshot.identity) throw new Error('Analyzer is not configured');
    const output = await scheduler.execute(`scan ${config.startHz} ${config.stopHz} ${config.points} 3`, 30_000);
    const rows = output.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter((v) => v.length >= 2 && v.every(Number.isFinite));
    if(rows.length!==config.points)throw new Error(`Sweep returned ${rows.length} valid points; expected ${config.points}`);
    const first=rows[0];const last=rows.at(-1);if(!first||!last)throw new Error('Sweep response contained no valid points');
    const sweep: Sweep = { id: crypto.randomUUID(), capturedAt: new Date().toISOString(), frequencyHz: rows.map((v) => v[0]!), powerDbm: rows.map((v) => v[1]!), requested: config, actualStartHz: first[0]!, actualStopHz: last[0]!, identity: this.#snapshot.identity };
    this.#emit({ type: 'sweep', sweep }); return sweep;
  }
  async configureGenerator(input: GeneratorConfig): Promise<DeviceSnapshot> {
    const config = generatorConfigSchema.parse(input); const scheduler = this.#ready();
    await scheduler.execute('output off'); await scheduler.execute('mode low output');
    await scheduler.execute(`freq ${config.frequencyHz}`); await scheduler.execute(`level ${config.levelDbm}`);
    this.#set({ ...this.#snapshot, mode: 'generator', generatorOutput: 'off', verification: 'commanded' }); return this.snapshot();
  }
  async setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot> {
    const scheduler = this.#ready(); if (this.#snapshot.mode !== 'generator') throw new Error('Generator mode is required');
    await scheduler.execute(`output ${enabled ? 'on' : 'off'}`);
    this.#set({ ...this.#snapshot, generatorOutput: enabled ? 'on' : 'off', verification: 'commanded' }); return this.snapshot();
  }
  #ready(): CommandScheduler { if (this.#snapshot.connection !== 'ready' || !this.#scheduler) throw new Error('Device is not connected'); return this.#scheduler; }
  #set(snapshot: DeviceSnapshot): void { this.#snapshot = snapshot; this.#emit({ type: 'snapshot', snapshot: this.snapshot() }); }
  #emit(event: DeviceEvent): void { for (const listener of this.#listeners) listener(event); }
}
function firstLine(value: string): string { return value.split('\n').map((v) => v.trim()).find(Boolean) ?? ''; }
