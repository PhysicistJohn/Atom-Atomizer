import {
  DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
  FIRMWARE_SOURCE_COMMIT,
  SUPPORTED_ZS407_FIRMWARE_REVISIONS,
  TINYSA_SHELL_PROMPT,
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  ZS407_FIRMWARE_LIMITS,
  analyzerConfigSchema,
  generatorConfigSchema,
  portCandidateSchema,
  screenPointSchema,
  zeroSpanConfigSchema,
  type AnalyzerConfig,
  type AnalyzerReadback,
  type DeviceCapabilities,
  type DeviceDiagnostics,
  type DeviceErrorCode,
  type DeviceEvent,
  type DeviceIdentity,
  type DeviceSnapshot,
  type DeviceTelemetry,
  type FirmwareTraceFrame,
  type GeneratorConfig,
  type PortCandidate,
  type ScreenFrame,
  type ScreenPoint,
  type SupportedZs407FirmwareRevision,
  type Sweep,
  type SweepStatus,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import { CommandScheduler } from './scheduler.js';
import type { ByteTransport, TransportEvent } from './transport.js';

const REQUIRED_COMMANDS = [
  'version', 'info', 'help', 'status', 'pause', 'resume', 'abort',
  'mode', 'sweep', 'scan', 'scanraw', 'zero', 'rbw', 'attenuate', 'sweeptime', 'spur', 'avoid', 'lna', 'trigger', 'calc', 'trace', 'marker',
  'freq', 'level', 'modulation', 'output', 'vbat', 'deviceid', 'capture', 'touch', 'release',
] as const;
const SCREEN_BYTES = ZS407_FIRMWARE_LIMITS.screenWidth * ZS407_FIRMWARE_LIMITS.screenHeight * 2;
const DETECTOR_COMMAND: Record<AnalyzerConfig['detector'], string> = {
  sample: 'off',
  'minimum-hold': 'minh',
  'maximum-hold': 'maxh',
  'maximum-decay': 'maxd',
  'average-4': 'aver4',
  'average-16': 'aver16',
  average: 'aver',
  'quasi-peak': 'quasi',
};

export class TinySaDeviceError extends Error {
  override readonly name = 'TinySaDeviceError';
  constructor(readonly code: DeviceErrorCode, message: string, readonly recoverable: boolean, options?: ErrorOptions) {
    super(message, options);
  }
}

export class TinySaDeviceService {
  #scheduler?: CommandScheduler;
  #snapshot: DeviceSnapshot = disconnectedSnapshot();
  #listeners = new Set<(event: DeviceEvent) => void>();
  #analyzer?: AnalyzerConfig;
  #versionResponse = '';
  #infoResponse = '';
  #commands: readonly string[] = [];
  #sequence = 0;
  #streaming = false;
  #streamTask?: Promise<void>;
  #closing = false;
  #unsubscribeTransport: () => void;

  constructor(private readonly transport: ByteTransport) {
    this.#unsubscribeTransport = transport.onEvent((event) => this.#handleTransportEvent(event));
  }

  listDevices(): Promise<PortCandidate[]> { return this.transport.list(); }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  get streaming(): boolean { return this.#streaming || this.#streamTask !== undefined; }
  subscribe(listener: (event: DeviceEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  async connect(input: PortCandidate): Promise<DeviceSnapshot> {
    const port = portCandidateSchema.parse(input);
    if (this.#snapshot.connection !== 'disconnected') throw new TinySaDeviceError('invalid-state', 'Device is already active', false);
    this.#set({ ...disconnectedSnapshot(), connection: 'connecting', generatorOutput: 'unknown', pendingPort: port });
    try {
      await this.transport.open(port);
      this.#scheduler = new CommandScheduler(this.transport, { onFault: (error) => this.#handleSchedulerFault(error) });
      this.#set({ ...this.#snapshot, connection: 'identifying' });

      await this.#command('output off');
      this.#versionResponse = await this.#scheduler.execute('version', 10_000);
      this.#infoResponse = await this.#scheduler.execute('info', 10_000);
      const help = await this.#scheduler.execute('help', 10_000);
      const identity = parseIdentity(this.#versionResponse, this.#infoResponse, port);
      this.#commands = parseHelpCommands(help);
      requireCommands(this.#commands);

      await this.#command('output off');
      await this.#command('mode input');
      const readback = await this.#readAnalyzerReadback();
      const telemetry = await this.#readTelemetry(readback.sweepStatus);
      const now = new Date().toISOString();
      this.#set({
        connection: 'ready',
        mode: 'idle',
        generatorOutput: 'off',
        verification: 'commanded',
        identity,
        capabilities: buildCapabilities(this.#commands, identity),
        sessionId: crypto.randomUUID(),
        connectedAt: now,
        lastOperationAt: now,
        telemetry,
      });
      return this.snapshot();
    } catch (error) {
      const primary = asDeviceError(error, 'protocol', 'Device identification failed', false);
      const cleanupFailures: unknown[] = [];
      this.#scheduler?.dispose();
      this.#scheduler = undefined;
      this.#closing = true;
      try { await this.transport.close(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      finally { this.#closing = false; }
      this.#analyzer = undefined;
      this.#set({
        ...disconnectedSnapshot(),
        connection: cleanupFailures.length ? 'faulted' : 'disconnected',
        generatorOutput: 'unknown',
        fault: faultFrom(primary),
      });
      if (cleanupFailures.length) throw new AggregateError([primary, ...cleanupFailures], 'Device connection failed and transport cleanup also failed');
      throw primary;
    }
  }

  async disconnect(): Promise<void> {
    if (this.#snapshot.connection === 'disconnected') throw new TinySaDeviceError('not-connected', 'Device is not connected', false);
    if (this.#snapshot.connection === 'disconnecting') throw new TinySaDeviceError('invalid-state', 'Device disconnect is already in progress', false);
    this.#set({ ...this.#snapshot, connection: 'disconnecting' });
    const failures: unknown[] = [];
    this.#streaming = false;
    if (this.#streamTask) await this.#streamTask;
    if (this.#scheduler && !this.#scheduler.fault) {
      try { await this.#command('output off'); } catch (error) { failures.push(error); }
    }
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.#closing = true;
    try { await this.transport.close(); } catch (error) { failures.push(error); }
    finally { this.#closing = false; }
    this.#analyzer = undefined;
    this.#set({
      ...disconnectedSnapshot(),
      connection: failures.length ? 'faulted' : 'disconnected',
      generatorOutput: 'unknown',
      ...(failures.length ? { fault: faultFrom(asDeviceError(failures[0], 'transport', 'Device disconnect failed', true)) } : {}),
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'RF-off command and transport close both failed during disconnect');
  }

  async configureAnalyzer(input: AnalyzerConfig): Promise<DeviceSnapshot> {
    this.#assertNotStreaming('Analyzer configuration');
    const config = analyzerConfigSchema.parse(input);
    this.#assertFrequency(config.stopHz, 'analyzer');
    this.#ready();
    try {
      await this.#command('output off');
      await this.#command('mode input');
      await this.#command('trace dBm');
      await this.#command(`sweep ${config.startHz} ${config.stopHz} ${config.points}`);
      await this.#command(`rbw ${config.rbwKhz}`);
      await this.#command(`attenuate ${config.attenuationDb}`);
      if (config.sweepTimeSeconds !== 'auto') await this.#command(`sweeptime ${formatDecimal(config.sweepTimeSeconds)}`);
      await this.#command(`calc ${DETECTOR_COMMAND[config.detector]}`);
      await this.#command(`spur ${config.spurRejection}`);
      await this.#command(`avoid ${config.avoidSpurs}`);
      await this.#command(`lna ${config.lna}`);
      await this.#configureTrigger(config.trigger);
      const readback = await this.#readAnalyzerReadback();
      assertAnalyzerReadback(config, readback);
      this.#analyzer = config;
      const now = new Date().toISOString();
      this.#set({
        ...this.#snapshot,
        connection: 'ready',
        mode: 'analyzer',
        generatorOutput: 'off',
        verification: 'verified',
        lastOperationAt: now,
        analyzer: { requested: config, readback, verification: 'verified' },
        generator: undefined,
        fault: undefined,
      });
      return this.snapshot();
    } catch (error) {
      throw this.#operationFailure(error, 'Analyzer configuration failed');
    }
  }

  async acquireSweep(): Promise<Sweep> {
    const scheduler = this.#ready();
    const config = this.#analyzer;
    const identity = this.#snapshot.identity;
    const analyzer = this.#snapshot.analyzer;
    if (!config || !identity || !analyzer || this.#snapshot.mode !== 'analyzer') {
      throw new TinySaDeviceError('invalid-state', 'Analyzer is not configured', false);
    }
    const timeoutMs = sweepTimeout(config.sweepTimeSeconds);
    const started = performance.now();
    try {
      let frequencyHz: number[];
      let powerDbm: readonly number[];
      let source: Sweep['source'];
      let rawSweepOffsetDb: number | undefined;
      if (config.acquisitionFormat === 'raw') {
        rawSweepOffsetDb = parseRawSweepOffset(await scheduler.execute('zero', 10_000));
        const command = `scanraw ${config.startHz} ${config.stopHz} ${config.points} 0`;
        const offsetValues = await scheduler.executeRawSweep(command, config.points, timeoutMs);
        powerDbm = offsetValues.map((value) => value - rawSweepOffsetDb!);
        frequencyHz = rawSweepFrequencies(config.startHz, config.stopHz, config.points);
        source = 'scanraw-binary';
      } else {
        const output = await scheduler.execute(`scan ${config.startHz} ${config.stopHz} ${config.points} 3`, timeoutMs);
        assertFirmwareSuccess(output, 'scan');
        ({ frequencyHz, powerDbm } = parseTextSweep(output, config.points));
        source = 'scan-text';
      }
      const transportEvidence = this.transport.consumeAcquisitionMetadata();
      assertTransportEvidence(identity, config.startHz, config.stopHz, config.points, transportEvidence);
      if (transportEvidence) source = transportEvidence.source;
      const first = frequencyHz[0];
      const last = frequencyHz.at(-1);
      if (first === undefined || last === undefined) throw new TinySaDeviceError('protocol', 'Sweep response contained no points', false);
      const sweepId = crypto.randomUUID();
      const capturedAt = new Date().toISOString();
      const firmwareTraces = await this.#readFirmwareTraceFrames(frequencyHz, powerDbm, sweepId, capturedAt, timeoutMs);
      const elapsedMilliseconds = performance.now() - started;
      const sweep: Sweep = {
        kind: 'spectrum',
        id: sweepId,
        sequence: ++this.#sequence,
        capturedAt,
        elapsedMilliseconds,
        frequencyHz,
        powerDbm,
        requested: config,
        actualStartHz: first,
        actualStopHz: last,
        actualRbwHz: transportEvidence?.actualRbwHz ?? analyzer.readback.actualRbwHz,
        actualAttenuationDb: transportEvidence?.actualAttenuationDb ?? analyzer.readback.attenuationDb,
        source,
        ...(rawSweepOffsetDb === undefined ? {} : { rawSweepOffsetDb }),
        firmwareTraces,
        complete: true,
        identity,
      };
      this.#set({ ...this.#snapshot, lastOperationAt: sweep.capturedAt, verification: 'verified' });
      this.#emit({ type: 'sweep', sweep });
      return sweep;
    } catch (error) {
      throw this.#operationFailure(error, 'Sweep acquisition failed');
    }
  }

  async startStreaming(): Promise<void> {
    this.#ready();
    if (this.#streaming || this.#streamTask) throw new TinySaDeviceError('invalid-state', 'Continuous acquisition is already running', false);
    if (!this.#analyzer || !this.#snapshot.analyzer || this.#snapshot.mode !== 'analyzer') {
      throw new TinySaDeviceError('invalid-state', 'Analyzer must be configured before continuous acquisition', false);
    }
    this.#streaming = true;
    const task = this.#runStreaming();
    this.#streamTask = task;
  }

  async stopStreaming(): Promise<void> {
    if (!this.#streaming || !this.#streamTask) throw new TinySaDeviceError('invalid-state', 'Continuous acquisition is not running', false);
    this.#streaming = false;
    await this.#streamTask;
  }

  async acquireZeroSpan(input: ZeroSpanConfig): Promise<ZeroSpanCapture> {
    this.#assertNotStreaming('Zero-span acquisition');
    const config = zeroSpanConfigSchema.parse(input);
    this.#assertFrequency(config.frequencyHz, 'analyzer');
    const scheduler = this.#ready();
    const identity = this.#snapshot.identity;
    if (!identity) throw new TinySaDeviceError('invalid-state', 'Connected device identity is unavailable', false);
    try {
      await this.#command('output off');
      await this.#command('mode input');
      await this.#command('trace dBm');
      await this.#command(`sweep ${config.frequencyHz} ${config.frequencyHz} ${config.points}`);
      await this.#command(`rbw ${config.rbwKhz}`);
      await this.#command(`attenuate ${config.attenuationDb}`);
      await this.#command(`sweeptime ${formatDecimal(config.sweepTimeSeconds)}`);
      await this.#configureTrigger(config.trigger);
      const readback = await this.#readAnalyzerReadback();
      if (readback.startHz !== config.frequencyHz || readback.stopHz !== config.frequencyHz || readback.points !== config.points) {
        throw new TinySaDeviceError('protocol', 'Zero-span readback does not match the requested frequency and point count', false);
      }
      const started = performance.now();
      const output = await scheduler.execute(`scan ${config.frequencyHz} ${config.frequencyHz} ${config.points} 3`, sweepTimeout(config.sweepTimeSeconds));
      assertFirmwareSuccess(output, 'zero-span scan');
      const rows = parseTextSweep(output, config.points);
      const transportEvidence = this.transport.consumeAcquisitionMetadata();
      assertTransportEvidence(identity, config.frequencyHz, config.frequencyHz, config.points, transportEvidence);
      if (rows.frequencyHz.some((frequency) => frequency !== config.frequencyHz)) {
        throw new TinySaDeviceError('protocol', 'Zero-span response contained a different frequency', false);
      }
      const elapsedMilliseconds = performance.now() - started;
      const capturedAt = new Date().toISOString();
      const capture: ZeroSpanCapture = {
        kind: 'zero-span',
        id: crypto.randomUUID(),
        sequence: ++this.#sequence,
        capturedAt,
        elapsedMilliseconds,
        frequencyHz: config.frequencyHz,
        samplePeriodSeconds: elapsedMilliseconds / 1_000 / config.points,
        powerDbm: rows.powerDbm,
        requested: config,
        actualRbwHz: transportEvidence?.actualRbwHz ?? readback.actualRbwHz,
        actualAttenuationDb: transportEvidence?.actualAttenuationDb ?? readback.attenuationDb,
        source: transportEvidence?.source ?? 'scan-text',
        complete: true,
        identity,
      };
      this.#analyzer = undefined;
      this.#set({ ...this.#snapshot, mode: 'analyzer', generatorOutput: 'off', verification: 'verified', analyzer: undefined, generator: undefined, lastOperationAt: capturedAt });
      this.#emit({ type: 'zero-span', capture });
      return capture;
    } catch (error) {
      throw this.#operationFailure(error, 'Zero-span acquisition failed');
    }
  }

  async configureGenerator(input: GeneratorConfig): Promise<DeviceSnapshot> {
    this.#assertNotStreaming('Generator configuration');
    const config = generatorConfigSchema.parse(input);
    this.#assertFrequency(config.frequencyHz, 'generator');
    this.#ready();
    try {
      await this.#command('output off');
      await this.#command('mode output');
      await this.#command('output off');
      await this.#command(`output ${config.path}`);
      await this.#command(`freq ${config.frequencyHz}`);
      await this.#command(`level ${formatDecimal(config.levelDbm)}`);
      await this.#command('modulation off');
      await this.#command(`modulation freq ${config.modulationFrequencyHz}`);
      await this.#command(`modulation depth ${config.amDepthPercent}`);
      await this.#command(`modulation deviation ${config.fmDeviationHz}`);
      await this.#command(`modulation ${config.modulation}`);
      const now = new Date().toISOString();
      this.#analyzer = undefined;
      this.#set({
        ...this.#snapshot,
        connection: 'ready',
        mode: 'generator',
        generatorOutput: 'off',
        verification: 'commanded',
        lastOperationAt: now,
        analyzer: undefined,
        generator: { commanded: config, configuredAt: now, readbackAvailable: false, verification: 'commanded' },
        fault: undefined,
      });
      return this.snapshot();
    } catch (error) {
      throw this.#operationFailure(error, 'Generator configuration failed');
    }
  }

  async setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot> {
    this.#ready();
    if (this.#snapshot.mode !== 'generator' || !this.#snapshot.generator) {
      throw new TinySaDeviceError('invalid-state', 'Generator mode must be configured before changing RF output', false);
    }
    try {
      await this.#command(`output ${enabled ? 'on' : 'off'}`);
      this.#set({
        ...this.#snapshot,
        generatorOutput: enabled ? 'on' : 'off',
        verification: 'commanded',
        lastOperationAt: new Date().toISOString(),
      });
      return this.snapshot();
    } catch (error) {
      this.#set({ ...this.#snapshot, generatorOutput: 'unknown', verification: 'unknown', fault: faultFrom(asDeviceError(error, 'protocol', 'RF output command failed', true)) });
      throw error;
    }
  }

  async readDiagnostics(): Promise<DeviceDiagnostics> {
    this.#assertNotStreaming('Diagnostics refresh');
    this.#ready();
    const identity = this.#snapshot.identity;
    if (!identity) throw new TinySaDeviceError('invalid-state', 'Connected device identity is unavailable', false);
    try {
      const version = await this.#ready().execute('version', 10_000);
      const info = await this.#ready().execute('info', 10_000);
      const help = await this.#ready().execute('help', 10_000);
      const commands = parseHelpCommands(help);
      requireCommands(commands);
      const rawSweepOffsetDb = parseRawSweepOffset(await this.#ready().execute('zero', 10_000));
      const analyzerReadback = await this.#readAnalyzerReadback();
      const telemetry = await this.#readTelemetry(analyzerReadback.sweepStatus);
      const diagnostics: DeviceDiagnostics = {
        identity,
        firmwareVersionResponse: version,
        infoLines: nonEmptyLines(info),
        commands,
        rawSweepOffsetDb,
        analyzerReadback,
        telemetry,
        capturedAt: new Date().toISOString(),
      };
      this.#versionResponse = version;
      this.#infoResponse = info;
      this.#commands = commands;
      this.#set({ ...this.#snapshot, telemetry, lastOperationAt: diagnostics.capturedAt });
      this.#emit({ type: 'diagnostics', diagnostics });
      return diagnostics;
    } catch (error) {
      throw this.#operationFailure(error, 'Diagnostics refresh failed');
    }
  }

  async captureScreen(): Promise<ScreenFrame> {
    this.#assertNotStreaming('Device screen capture');
    const scheduler = this.#ready();
    this.#requireCapability('capture');
    try {
      const wirePixels = await scheduler.executeBinary('capture', SCREEN_BYTES, 20_000);
      // The ZS407 ST7796S returns canonical RGB565 in panel/wire order
      // (high byte first).  ScreenFrame deliberately exposes little-endian
      // host words; the executable twin already performs this conversion at
      // its bridge boundary.
      const pixels = this.transport.kind === 'usb-cdc-acm'
        ? rgb565BigEndianToLittleEndian(wirePixels)
        : wirePixels;
      const frame: ScreenFrame = {
        width: ZS407_FIRMWARE_LIMITS.screenWidth,
        height: ZS407_FIRMWARE_LIMITS.screenHeight,
        format: 'rgb565le',
        pixels,
        capturedAt: new Date().toISOString(),
      };
      this.#set({ ...this.#snapshot, lastOperationAt: frame.capturedAt });
      this.#emit({ type: 'screen', frame });
      return frame;
    } catch (error) {
      throw this.#operationFailure(error, 'Device screen capture failed');
    }
  }

  async touch(input: ScreenPoint): Promise<void> {
    this.#assertNotStreaming('Remote touch');
    const point = screenPointSchema.parse(input);
    this.#requireCapability('touch');
    try { await this.#command(`touch ${point.x} ${point.y}`); }
    catch (error) { throw this.#operationFailure(error, 'Remote touch failed'); }
  }

  async releaseTouch(input?: ScreenPoint): Promise<void> {
    this.#assertNotStreaming('Remote touch release');
    const point = input === undefined ? undefined : screenPointSchema.parse(input);
    this.#requireCapability('release');
    try { await this.#command(point ? `release ${point.x} ${point.y}` : 'release'); }
    catch (error) { throw this.#operationFailure(error, 'Remote touch release failed'); }
  }

  dispose(): void {
    this.#streaming = false;
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.#unsubscribeTransport();
  }

  async #readFirmwareTraceFrames(
    frequencyHz: readonly number[],
    measuredPowerDbm: readonly number[],
    sourceSweepId: string,
    capturedAt: string,
    timeoutMs: number,
  ): Promise<readonly FirmwareTraceFrame[]> {
    const scheduler = this.#ready();
    const metadata = parseFirmwareTraceMetadata(await scheduler.execute('trace', Math.max(10_000, timeoutMs)));
    const frames: FirmwareTraceFrame[] = [];
    for (const trace of metadata) {
      const powerDbm = trace.traceId === 1
        ? [...measuredPowerDbm]
        : parseFirmwareTraceValues(await scheduler.execute(`trace ${trace.traceId} value`, Math.max(20_000, timeoutMs)), trace.traceId, frequencyHz.length);
      frames.push({
        traceId: trace.traceId,
        role: trace.traceId === 1 ? 'measured' : trace.traceId === 4 ? 'raw' : 'stored',
        unit: 'dBm',
        frozen: trace.frozen,
        frequencyHz: [...frequencyHz],
        powerDbm,
        sourceSweepId,
        capturedAt,
        evidence: 'firmware-readback',
      });
    }
    return frames;
  }

  async #configureTrigger(trigger: AnalyzerConfig['trigger'] | ZeroSpanConfig['trigger']): Promise<void> {
    await this.#command(`trigger ${trigger.mode}`);
    if (trigger.levelDbm !== undefined) await this.#command(`trigger ${formatDecimal(trigger.levelDbm)}`);
  }

  async #runStreaming(): Promise<void> {
    try {
      while (this.#streaming) await this.acquireSweep();
    } catch (error) {
      if (this.#snapshot.connection !== 'faulted') {
        const value = asDeviceError(error, 'protocol', 'Continuous acquisition failed', true);
        this.#emit({ type: 'error', error: { code: value.code, message: value.message, recoverable: value.recoverable } });
      }
    } finally {
      this.#streaming = false;
      this.#streamTask = undefined;
    }
  }

  #assertNotStreaming(operation: string): void {
    if (this.#streaming || this.#streamTask) throw new TinySaDeviceError('invalid-state', `${operation} is unavailable during continuous acquisition`, false);
  }

  async #readAnalyzerReadback(): Promise<AnalyzerReadback> {
    const scheduler = this.#ready();
    const sweep = parseSweepReadback(await scheduler.execute('sweep'));
    const actualRbwHz = parseRbw(await scheduler.execute('rbw'));
    const attenuationDb = parseAttenuation(await scheduler.execute('attenuate'));
    const sweepStatus = parseStatus(await scheduler.execute('status'));
    return { ...sweep, actualRbwHz, attenuationDb, sweepStatus, readAt: new Date().toISOString() };
  }

  async #readTelemetry(sweepStatus: SweepStatus): Promise<DeviceTelemetry> {
    const scheduler = this.#ready();
    const batteryMillivolts = parseBattery(await scheduler.execute('vbat'));
    const deviceId = parseDeviceId(await scheduler.execute('deviceid'));
    return { batteryMillivolts, deviceId, sweepStatus, capturedAt: new Date().toISOString() };
  }

  async #command(command: string, timeoutMs = 10_000): Promise<string> {
    const response = await this.#ready().execute(command, timeoutMs);
    assertFirmwareSuccess(response, command);
    return response;
  }

  #ready(): CommandScheduler {
    if ((this.#snapshot.connection !== 'ready' && this.#snapshot.connection !== 'identifying' && this.#snapshot.connection !== 'disconnecting') || !this.#scheduler) {
      throw new TinySaDeviceError('not-connected', 'Device is not connected', false);
    }
    if (this.#scheduler.fault) throw this.#scheduler.fault;
    return this.#scheduler;
  }

  #assertFrequency(frequencyHz: number, domain: 'analyzer' | 'generator'): void {
    const capabilities = this.#snapshot.capabilities;
    if (!capabilities) throw new TinySaDeviceError('invalid-state', 'Device capabilities are unavailable', false);
    const range = domain === 'analyzer' ? capabilities.analyzerFrequency : capabilities.generatorFrequency;
    if (frequencyHz < range.min || frequencyHz > range.max) {
      throw new TinySaDeviceError('invalid-request', `${domain} frequency ${frequencyHz} Hz is outside ${range.min}..${range.max} Hz`, false);
    }
  }

  #requireCapability(command: string): void {
    this.#ready();
    if (!this.#commands.includes(command)) throw new TinySaDeviceError('unsupported', `Connected firmware does not expose ${command}`, false);
  }

  #operationFailure(value: unknown, context: string): Error {
    const error = asDeviceError(value, value instanceof TinySaDeviceError ? value.code : 'protocol', context, true);
    if (this.#scheduler?.fault) {
      this.#set({ ...this.#snapshot, connection: 'faulted', generatorOutput: this.#snapshot.mode === 'generator' ? 'unknown' : this.#snapshot.generatorOutput, verification: 'unknown', fault: faultFrom(error) });
    }
    return error;
  }

  #handleSchedulerFault(error: Error): void {
    if (this.#snapshot.connection === 'disconnected') return;
    const deviceError = asDeviceError(error, 'protocol', 'Protocol session faulted', true);
    this.#set({
      ...this.#snapshot,
      connection: 'faulted',
      generatorOutput: this.#snapshot.mode === 'generator' ? 'unknown' : this.#snapshot.generatorOutput,
      verification: 'unknown',
      fault: faultFrom(deviceError),
    });
    this.#emit({ type: 'error', error: { code: deviceError.code, message: deviceError.message, recoverable: deviceError.recoverable } });
  }

  #handleTransportEvent(event: TransportEvent): void {
    if (event.type === 'opened' || this.#closing || this.#snapshot.connection === 'disconnected') return;
    const reason = event.type === 'error' ? event.error.message : event.reason ?? 'USB transport closed unexpectedly';
    const error = new TinySaDeviceError('transport', reason, true, event.type === 'error' ? { cause: event.error } : undefined);
    this.#scheduler?.cancelAll(error);
    this.#scheduler = undefined;
    this.#analyzer = undefined;
    this.#set({
      ...this.#snapshot,
      connection: 'faulted',
      mode: 'idle',
      generatorOutput: 'unknown',
      verification: 'unknown',
      fault: faultFrom(error),
    });
    this.#emit({ type: 'error', error: { code: error.code, message: error.message, recoverable: error.recoverable } });
  }

  #set(snapshot: DeviceSnapshot): void {
    this.#snapshot = snapshot;
    this.#emit({ type: 'snapshot', snapshot: this.snapshot() });
  }

  #emit(event: DeviceEvent): void { for (const listener of this.#listeners) listener(event); }
}

function rgb565BigEndianToLittleEndian(wirePixels: Uint8Array): Uint8Array {
  if (wirePixels.length % 2 !== 0) throw new Error('RGB565 capture contained a partial pixel');
  const pixels = new Uint8Array(wirePixels.length);
  for (let offset = 0; offset < wirePixels.length; offset += 2) {
    pixels[offset] = wirePixels[offset + 1]!;
    pixels[offset + 1] = wirePixels[offset]!;
  }
  return pixels;
}

function disconnectedSnapshot(): DeviceSnapshot {
  return { connection: 'disconnected', mode: 'idle', generatorOutput: 'unknown', verification: 'stale' };
}

function buildCapabilities(commands: readonly string[], identity: DeviceIdentity): DeviceCapabilities {
  const twin = identity.execution === 'firmware-digital-twin';
  const testDouble = identity.execution === 'protocol-test-double';
  return {
    profile: 'tinySA4-zs407',
    protocol: {
      ...(identity.execution === 'physical' ? { vendorId: TINYSA_USB_VENDOR_ID, productId: TINYSA_USB_PRODUCT_ID } : {}),
      transport: identity.port.transport,
      prompt: TINYSA_SHELL_PROMPT,
      commandTerminator: '\r',
      echoesCommands: true,
      maximumCommandCharacters: 47,
      usbTransactionsModeled: identity.execution === 'physical',
      ...(twin ? { bridgeContractVersion: 1 as const } : {}),
    },
    analyzerFrequency: { min: ZS407_FIRMWARE_LIMITS.analyzerMinimumHz, max: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz, unit: 'Hz' },
    analyzerNormalMaximumHz: ZS407_FIRMWARE_LIMITS.analyzerNormalMaximumHz,
    analyzerUltraTransitionHz: ZS407_FIRMWARE_LIMITS.analyzerUltraTransitionHz,
    generatorFrequency: { min: 1, max: ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz, unit: 'Hz' },
    generatorFundamentalMaximumHz: ZS407_FIRMWARE_LIMITS.generatorFundamentalMaximumHz,
    generatorLevel: { min: ZS407_FIRMWARE_LIMITS.generatorMinimumDbm, max: ZS407_FIRMWARE_LIMITS.generatorMaximumDbm, unit: 'dBm' },
    rbwKhz: { min: ZS407_FIRMWARE_LIMITS.minimumRbwKhz, max: ZS407_FIRMWARE_LIMITS.maximumRbwKhz, unit: 'kHz' },
    attenuationDb: { min: 0, max: 31, step: 1, unit: 'dB' },
    sweepPoints: { min: ZS407_FIRMWARE_LIMITS.minimumSweepPoints, max: ZS407_FIRMWARE_LIMITS.maximumSweepPoints, step: 1, unit: 'points' },
    sweepSeconds: { min: ZS407_FIRMWARE_LIMITS.minimumSweepSeconds, max: ZS407_FIRMWARE_LIMITS.maximumSweepSeconds, unit: 'seconds' },
    maxSweepPoints: ZS407_FIRMWARE_LIMITS.maximumSweepPoints,
    screen: { width: 480, height: 320, format: 'rgb565le' },
    screenCapture: commands.includes('capture'),
    remoteTouch: commands.includes('touch') && commands.includes('release'),
    streaming: commands.includes('scan'),
    rawSweep: commands.includes('scanraw'),
    rawSweepOffsetReadback: commands.includes('zero'),
    markerCount: 8,
    traceCount: 4,
    firmwareMarkers: commands.includes('marker'),
    firmwareTraces: commands.includes('trace'),
    generatorReadback: false,
    modulation: ['off', 'am', 'fm'],
    commands: [...commands],
    evidence: twin ? 'firmware-executed-twin' : testDouble ? 'protocol-test-double' : 'device-observed',
    ...(identity.firmwareSourceCommit ? { firmwareSourceCommit: identity.firmwareSourceCommit } : {}),
    hostContractSourceCommit: FIRMWARE_SOURCE_COMMIT,
    qualification: identity.firmwareQualification === 'custom-unqualified'
      ? 'custom-firmware-unqualified'
      : twin
        ? 'executable-twin-observed'
        : testDouble
          ? 'protocol-test-only'
          : 'device-observed-awaiting-rf-qualification',
  };
}

function parseIdentity(versionResponse: string, infoResponse: string, port: PortCandidate): DeviceIdentity {
  const versionLines = nonEmptyLines(versionResponse);
  const infoLines = nonEmptyLines(infoResponse);
  const firmwareVersion = versionLines[0];
  const hardwareLine = versionLines.find((line) => /^HW Version:/i.test(line));
  if (!firmwareVersion || !/^tinySA4_/i.test(firmwareVersion)) {
    throw new TinySaDeviceError('identity-mismatch', 'Connected serial device did not identify as tinySA4 firmware', false);
  }
  if (!infoLines.length || !infoLines.some((line) => /tinySA/i.test(line))) {
    throw new TinySaDeviceError('identity-mismatch', 'tinySA info response is incomplete', false);
  }
  const infoIdentifiesZs407 = infoLines.some((line) => /^tinySA\s+ULTRA\+\s+ZS407$/i.test(line));
  if (!hardwareLine || (!/ZS407/i.test(hardwareLine) && !infoIdentifiesZs407)) {
    throw new TinySaDeviceError('identity-mismatch', `Connected tinySA4 is not a ZS407: ${hardwareLine ?? 'hardware line missing'}`, false);
  }
  if (port.execution === 'physical' && port.usbMatch !== 'exact-zs407-cdc') {
    throw new TinySaDeviceError('identity-mismatch', 'Physical production sessions require exact 0483:5740 USB identity', false);
  }
  const hardwareVersion = hardwareLine.replace(/^HW Version:\s*/i, '').trim();
  if (port.execution === 'firmware-digital-twin' && !port.digitalTwin?.bootEvidence) {
    throw new TinySaDeviceError('identity-mismatch', 'Digital twin did not provide executable boot evidence', false);
  }
  const provenance = resolveFirmwareProvenance(firmwareVersion, port);
  const simulated = port.execution !== 'physical';
  return {
    model: 'tinySA Ultra+ ZS407',
    hardwareVersion,
    firmwareVersion,
    ...provenance,
    port,
    simulated,
    usbIdentityVerified: port.execution === 'physical' && port.usbMatch === 'exact-zs407-cdc',
    execution: port.execution,
    ...(port.digitalTwin ? { digitalTwin: port.digitalTwin } : {}),
  };
}

function resolveFirmwareProvenance(
  firmwareVersion: string,
  port: PortCandidate,
): Pick<DeviceIdentity, 'firmwareSourceCommit' | 'firmwareReportedRevision' | 'firmwareQualification' | 'firmwareWarning'> {
  if (port.execution === 'firmware-digital-twin') {
    if (port.digitalTwin?.repositoryCommit !== DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT) {
      throw new TinySaDeviceError('identity-mismatch', 'Digital twin firmware source does not match its contract', false);
    }
    return { firmwareSourceCommit: DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT, firmwareQualification: 'executable-twin' };
  }
  const revision = firmwareVersion.match(/-g([0-9a-f]{7,40})(?:\b|$)/i)?.[1]?.toLowerCase();
  if (!revision) throw new TinySaDeviceError('unsupported', `Firmware ${firmwareVersion} did not report a source revision`, false);
  const firmwareSourceCommit = SUPPORTED_ZS407_FIRMWARE_REVISIONS[revision as SupportedZs407FirmwareRevision];
  if (firmwareSourceCommit) {
    return {
      firmwareReportedRevision: revision,
      firmwareSourceCommit,
      firmwareQualification: port.execution === 'protocol-test-double' ? 'protocol-test' : 'supported-oem',
    };
  }
  return {
    firmwareReportedRevision: revision,
    firmwareQualification: 'custom-unqualified',
    firmwareWarning: `Custom firmware revision ${revision} is admitted without source qualification. Atomizer verified the ZS407 identity and required command surface, but has not qualified this firmware build.`,
  };
}

function assertTransportEvidence(
  identity: DeviceIdentity,
  startHz: number,
  stopHz: number,
  points: number,
  evidence: import('./transport.js').TransportAcquisitionMetadata | undefined,
): void {
  if (identity.execution === 'firmware-digital-twin' && !evidence) throw new TinySaDeviceError('protocol', 'Digital twin sweep omitted executable-state evidence', false);
  if (identity.execution !== 'firmware-digital-twin' && evidence) throw new TinySaDeviceError('protocol', 'Non-twin transport returned digital-twin evidence', false);
  if (!evidence) return;
  if (evidence.startHz !== startHz || evidence.stopHz !== stopHz || evidence.points !== points) {
    throw new TinySaDeviceError('protocol', `Digital twin evidence ${evidence.startHz}..${evidence.stopHz}/${evidence.points} does not match ${startHz}..${stopHz}/${points}`, false);
  }
  if (!Number.isFinite(evidence.actualRbwHz) || evidence.actualRbwHz <= 0 || !Number.isFinite(evidence.actualAttenuationDb)) {
    throw new TinySaDeviceError('protocol', 'Digital twin evidence contains invalid measurement metadata', false);
  }
}

function parseHelpCommands(response: string): readonly string[] {
  const commands = new Set<string>();
  for (const line of nonEmptyLines(response)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    for (const token of line.slice(colon + 1).trim().split(/\s+/)) {
      if (/^[a-z][a-z0-9_]*$/.test(token)) commands.add(token);
    }
  }
  if (!commands.size) throw new TinySaDeviceError('protocol', 'help response contained no command catalog', false);
  return [...commands].sort();
}

function requireCommands(commands: readonly string[]): void {
  const missing = REQUIRED_COMMANDS.filter((command) => !commands.includes(command));
  if (missing.length) throw new TinySaDeviceError('unsupported', `ZS407 firmware is missing required commands: ${missing.join(', ')}`, false);
}

function parseSweepReadback(response: string): Pick<AnalyzerReadback, 'startHz' | 'stopHz' | 'points'> {
  const line = nonEmptyLines(response)[0];
  const match = line?.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (!match) throw new TinySaDeviceError('protocol', `Malformed sweep readback: ${response}`, false);
  const startHz = Number(match[1]);
  const stopHz = Number(match[2]);
  const points = Number(match[3]);
  if (![startHz, stopHz, points].every(Number.isSafeInteger)) throw new TinySaDeviceError('protocol', 'Sweep readback exceeds safe integer range', false);
  return { startHz, stopHz, points };
}

function parseRbw(response: string): number {
  const matches = [...response.matchAll(/(-?\d+(?:\.\d+)?)\s*([kMGT]?)Hz/gi)];
  const match = matches.at(-1);
  const multiplier = match?.[2] === 'k' || match?.[2] === 'K' ? 1_000
    : match?.[2] === 'M' ? 1_000_000
      : match?.[2] === 'G' ? 1_000_000_000
        : match?.[2] === 'T' ? 1_000_000_000_000
          : 1;
  const value = Number(match?.[1]) * multiplier;
  if (!Number.isFinite(value) || value <= 0) throw new TinySaDeviceError('protocol', `Malformed RBW readback: ${response}`, false);
  return value;
}

function parseAttenuation(response: string): number {
  const lines = nonEmptyLines(response);
  const line = [...lines].reverse().find((candidate) => /^-?\d+(?:\.\d+)?$/.test(candidate));
  const value = Number(line);
  if (!Number.isFinite(value) || value < 0 || value > 31.5) throw new TinySaDeviceError('protocol', `Malformed attenuation readback: ${response}`, false);
  return value;
}

function parseRawSweepOffset(response: string): number {
  const line = [...nonEmptyLines(response)].reverse().find((candidate) => /^-?\d+\s*dBm$/i.test(candidate));
  const value = Number(line?.replace(/\s*dBm$/i, ''));
  if (!Number.isInteger(value) || value < -300 || value > 300) throw new TinySaDeviceError('protocol', `Malformed scanraw offset readback: ${response}`, false);
  return value;
}

function parseFirmwareTraceMetadata(response: string): readonly { traceId: 1 | 2 | 3 | 4; frozen: boolean | 'unknown' }[] {
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const pattern = new RegExp(`^([1-4]):\\s+dBm\\s+${number}\\s+${number}(?:\\s*,?\\s*(frozen))?\\s*$`, 'i');
  const traces = nonEmptyLines(response).map((line) => {
    const match = pattern.exec(line);
    if (!match) throw new TinySaDeviceError('protocol', `Malformed firmware trace summary line: ${line}`, false);
    return { traceId: Number(match[1]) as 1 | 2 | 3 | 4, frozen: match[2] ? true : 'unknown' as const };
  });
  if (!traces.length) throw new TinySaDeviceError('protocol', 'Firmware trace summary contained no enabled traces', false);
  if (new Set(traces.map((trace) => trace.traceId)).size !== traces.length) throw new TinySaDeviceError('protocol', 'Firmware trace summary repeated a trace identifier', false);
  return traces.sort((left, right) => left.traceId - right.traceId);
}

function parseFirmwareTraceValues(response: string, traceId: 1 | 2 | 3 | 4, expectedPoints: number): readonly number[] {
  const values = new Array<number>(expectedPoints);
  const seen = new Set<number>();
  for (const line of nonEmptyLines(response)) {
    const match = line.match(/^trace\s+([1-4])\s+value\s+(\d+)\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/i);
    if (!match || Number(match[1]) !== traceId) throw new TinySaDeviceError('protocol', `Malformed firmware trace ${traceId} value line: ${line}`, false);
    const index = Number(match[2]);
    const powerDbm = Number(match[3]);
    if (!Number.isInteger(index) || index < 0 || index >= expectedPoints || seen.has(index) || !Number.isFinite(powerDbm)) {
      throw new TinySaDeviceError('protocol', `Firmware trace ${traceId} contains an invalid or duplicate point`, false);
    }
    seen.add(index);
    values[index] = powerDbm;
  }
  if (seen.size !== expectedPoints || values.some((value) => !Number.isFinite(value))) {
    throw new TinySaDeviceError('protocol', `Firmware trace ${traceId} returned ${seen.size}/${expectedPoints} points`, false);
  }
  return values;
}

function parseStatus(response: string): SweepStatus {
  const value = response.trim().toLowerCase();
  if (value === 'paused') return 'paused';
  if (value === 'resumed') return 'resumed';
  throw new TinySaDeviceError('protocol', `Malformed sweep status: ${response}`, false);
}

function parseBattery(response: string): number {
  const match = response.trim().match(/^(\d+)\s*mV$/i);
  const value = Number(match?.[1]);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new TinySaDeviceError('protocol', `Malformed battery readback: ${response}`, false);
  return value;
}

function parseDeviceId(response: string): number {
  const match = response.trim().match(/^deviceid\s+(\d+)$/i);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new TinySaDeviceError('protocol', `Malformed device ID readback: ${response}`, false);
  return value;
}

function parseTextSweep(response: string, expectedPoints: number): { frequencyHz: number[]; powerDbm: number[] } {
  const lines = nonEmptyLines(response);
  if (lines.length !== expectedPoints) {
    throw new TinySaDeviceError('protocol', `Sweep returned ${lines.length} rows; expected exactly ${expectedPoints}`, false);
  }
  const frequencyHz: number[] = [];
  const powerDbm: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const fields = lines[index]!.split(/\s+/);
    if (fields.length !== 3) throw new TinySaDeviceError('protocol', `Sweep row ${index} must contain frequency, power and reserved value`, false);
    const frequency = Number(fields[0]);
    const power = Number(fields[1]);
    const reserved = Number(fields[2]);
    if (!Number.isSafeInteger(frequency) || !Number.isFinite(power) || !Number.isFinite(reserved)) {
      throw new TinySaDeviceError('protocol', `Sweep row ${index} contains an invalid numeric value`, false);
    }
    if (index > 0 && frequency < frequencyHz[index - 1]!) {
      throw new TinySaDeviceError('protocol', `Sweep frequency decreased at row ${index}`, false);
    }
    frequencyHz.push(frequency);
    powerDbm.push(power);
  }
  return { frequencyHz, powerDbm };
}

function rawSweepFrequencies(startHz: number, stopHz: number, points: number): number[] {
  const step = (stopHz - startHz) / points;
  return Array.from({ length: points }, (_, index) => Math.trunc(startHz + step * index));
}

function assertAnalyzerReadback(config: AnalyzerConfig, readback: AnalyzerReadback): void {
  if (readback.startHz !== config.startHz || readback.stopHz !== config.stopHz || readback.points !== config.points) {
    throw new TinySaDeviceError('protocol', `Analyzer readback ${readback.startHz}..${readback.stopHz}/${readback.points} does not match request ${config.startHz}..${config.stopHz}/${config.points}`, false);
  }
  if (config.attenuationDb !== 'auto' && Math.abs(readback.attenuationDb - config.attenuationDb) > 0.01) {
    throw new TinySaDeviceError('protocol', `Attenuation readback ${readback.attenuationDb} dB does not match ${config.attenuationDb} dB`, false);
  }
}

function assertFirmwareSuccess(response: string, command: string): void {
  const failure = response.match(/(?:Command timeout|frequency range is invalid|sweep points exceeds[^\r\n]*|Key unmatched\.|^usage:[^\r\n]*)/im)?.[0];
  if (failure) throw new TinySaDeviceError('protocol', `${command} failed: ${failure}`, false);
  if (response.trim() === `${command}?`) throw new TinySaDeviceError('unsupported', `Firmware rejected command ${command}`, false);
}

function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Command numeric value must be finite');
  return Number.isInteger(value) ? String(value) : value.toString();
}

function sweepTimeout(value: AnalyzerConfig['sweepTimeSeconds'] | number): number {
  const seconds = value === 'auto' ? 20 : value;
  return Math.max(30_000, Math.ceil((seconds + 20) * 1_000));
}

function nonEmptyLines(value: string): string[] {
  return value.replaceAll('\r', '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function faultFrom(error: TinySaDeviceError) {
  return { code: error.code, message: error.message, occurredAt: new Date().toISOString(), recoverable: error.recoverable } as const;
}

function asDeviceError(value: unknown, code: DeviceErrorCode, context: string, recoverable: boolean): TinySaDeviceError {
  if (value instanceof TinySaDeviceError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new TinySaDeviceError(code, `${context}: ${message}`, recoverable, value instanceof Error ? { cause: value } : undefined);
}
