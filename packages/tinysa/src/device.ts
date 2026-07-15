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
  type NumericRange,
  type PortCandidate,
  type ScreenFrame,
  type ScreenPoint,
  type SupportedZs407FirmwareRevision,
  type Sweep,
  type SweepStatus,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import { admittedTinySaDetectedPowerConfiguration, admittedTinySaSpectrumConfiguration } from './scalar-configuration.js';
import { CommandScheduler } from './scheduler.js';
import type { ByteTransport, TransportDiscoveryResult, TransportEvent } from './transport.js';

const REQUIRED_COMMANDS = [
  // These commands prove identity, a non-emitting state, teardown, and the
  // readback needed to describe even a conservative scalar receiver. Every
  // other command is optional and appears only in derived capabilities.
  'version', 'info', 'help', 'output', 'mode', 'sweep', 'rbw', 'attenuate', 'status', 'vbat', 'deviceid',
] as const;
const CUSTOM_RECEIVER_PROBES = [
  ['sweep', 'sweep ?'],
  // TinySA_Firmware cmd_scan treats one argument as a repeat count, including
  // `?`. Five arguments take the source-proved usage branch before any scan or
  // geometry mutation can occur.
  ['scan', 'scan ? ? ? ? ?'],
  ['scanraw', 'scanraw ?'],
  ['zero', 'zero ?'],
  ['trace', 'trace ?'],
  ['rbw', 'rbw ?'],
  ['attenuate', 'attenuate ?'],
  ['sweeptime', 'sweeptime ?'],
  ['calc', 'calc ?'],
  ['spur', 'spur ?'],
  ['avoid', 'avoid ?'],
  ['lna', 'lna ?'],
  ['trigger', 'trigger ?'],
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
  #zeroSpan?: { configuration: ZeroSpanConfig; readback: AnalyzerReadback };
  #versionResponse = '';
  #infoResponse = '';
  #commands: readonly string[] = [];
  #sequence = 0;
  #streaming = false;
  #streamTask?: Promise<void>;
  #closing = false;
  #rfOffAcknowledged = false;
  #teardownRfOffAcknowledged = false;
  #unsubscribeTransport: () => void;

  constructor(private readonly transport: ByteTransport) {
    this.#unsubscribeTransport = transport.onEvent((event) => this.#handleTransportEvent(event));
  }

  listDevices(): Promise<TransportDiscoveryResult> { return this.transport.list(); }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  get streaming(): boolean { return this.#streaming || this.#streamTask !== undefined; }
  subscribe(listener: (event: DeviceEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  async connect(input: PortCandidate): Promise<DeviceSnapshot> {
    const port = portCandidateSchema.parse(input);
    if (this.#snapshot.connection !== 'disconnected') throw new TinySaDeviceError('invalid-state', 'Device is already active', false);
    this.#rfOffAcknowledged = false;
    this.#teardownRfOffAcknowledged = false;
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
      let readback = await this.#readAnalyzerReadback();
      let capabilities: DeviceCapabilities;
      if (identity.firmwareQualification === 'custom-unqualified') {
        let probedCapabilities: DeviceCapabilities | undefined;
        let probeFailed = false;
        let probeFailure: unknown;
        try {
          probedCapabilities = await buildCapabilities(
            this.#commands,
            identity,
            readback,
            (command) => this.#ready().execute(command, 10_000),
          );
        } catch (error) {
          probeFailed = true;
          probeFailure = error;
        }
        // A custom shell's help probes are executable, untrusted commands. A
        // probe is not allowed to leave the device in an emitting mode or to
        // silently rewrite the acquisition geometry that was admitted. The
        // restoration attempt is mandatory even when parsing a probe failed.
        try {
          await this.#command('output off');
          await this.#command('mode input');
          const afterProbes = await this.#readAnalyzerReadback();
          assertSameProbeGeometry(readback, afterProbes);
          readback = afterProbes;
        } catch (restorationFailure) {
          if (probeFailed) {
            throw new AggregateError(
              [probeFailure, restorationFailure],
              'Custom firmware probing failed and receive-safe state could not be re-established',
            );
          }
          throw restorationFailure;
        }
        if (probeFailed) throw probeFailure;
        if (!probedCapabilities) throw new TinySaDeviceError('protocol', 'Custom firmware probing returned no capabilities', false);
        capabilities = probedCapabilities;
      } else {
        capabilities = await buildCapabilities(
          this.#commands,
          identity,
          readback,
          (command) => this.#ready().execute(command, 10_000),
        );
      }
      const telemetry = await this.#readTelemetry(readback.sweepStatus);
      const now = new Date().toISOString();
      this.#set({
        connection: 'ready',
        mode: 'idle',
        generatorOutput: 'off',
        verification: 'commanded',
        identity,
        capabilities,
        sessionId: crypto.randomUUID(),
        connectedAt: now,
        lastOperationAt: now,
        telemetry,
      });
      return this.snapshot();
    } catch (error) {
      const primary = asDeviceError(error, 'protocol', 'Device identification failed', false);
      const cleanupFailures: unknown[] = [];
      this.#closing = true;
      try { await this.transport.close(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      finally { this.#closing = false; }
      if (!cleanupFailures.length) {
        this.#scheduler?.dispose();
        this.#scheduler = undefined;
        this.#rfOffAcknowledged = false;
        this.#teardownRfOffAcknowledged = false;
      }
      this.#analyzer = undefined;
      this.#set({
        ...(cleanupFailures.length ? this.#snapshot : disconnectedSnapshot()),
        connection: cleanupFailures.length ? 'faulted' : 'disconnected',
        generatorOutput: cleanupFailures.length && this.#rfOffAcknowledged ? 'off' : 'unknown',
        verification: cleanupFailures.length && this.#rfOffAcknowledged ? 'commanded' : 'stale',
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
    this.#streaming = false;
    if (this.#streamTask) await this.#streamTask;
    if (!this.#teardownRfOffAcknowledged) {
      if (!this.#rfOffAcknowledged) {
        try { await this.#command('output off'); }
        catch (value) {
          const error = asDeviceError(value, 'protocol', 'RF output-off could not be acknowledged during disconnect', true);
          this.#rfOffAcknowledged = false;
          this.#teardownRfOffAcknowledged = false;
          this.#analyzer = undefined;
          this.#zeroSpan = undefined;
          this.#set({
            ...this.#snapshot,
            connection: 'faulted',
            generatorOutput: 'unknown',
            verification: 'unknown',
            fault: faultFrom(error),
          });
          throw error;
        }
      }
      this.#teardownRfOffAcknowledged = true;
    }
    this.#closing = true;
    try { await this.transport.close(); }
    catch (value) {
      const error = asDeviceError(value, 'transport', 'Transport close could not be confirmed during disconnect', true);
      this.#analyzer = undefined;
      this.#zeroSpan = undefined;
      this.#set({
        ...this.#snapshot,
        connection: 'faulted',
        generatorOutput: 'off',
        verification: 'commanded',
        fault: faultFrom(error),
      });
      throw error;
    }
    finally { this.#closing = false; }
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.#analyzer = undefined;
    this.#zeroSpan = undefined;
    this.#rfOffAcknowledged = false;
    this.#teardownRfOffAcknowledged = false;
    this.#set(disconnectedSnapshot());
  }

  /**
   * Retries cleanup of a transport retained when connect() failed before an
   * InstrumentSession could be admitted. The application calls this only
   * after InstrumentManager has completed teardown of any admitted session.
   */
  async cleanupPendingInstrumentConnection(): Promise<void> {
    if (this.#snapshot.connection === 'disconnected') return;
    await this.disconnect();
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
      // Firmware `cmd_sweeptime` accepts numeric seconds and
      // `set_sweep_time_us(0)` is the documented automatic/minimum reset.
      await this.#command(`sweeptime ${config.sweepTimeSeconds === 'auto' ? '0' : formatDecimal(config.sweepTimeSeconds)}`);
      await this.#command(`calc ${DETECTOR_COMMAND[config.detector]}`);
      await this.#command(`spur ${config.spurRejection}`);
      await this.#command(`avoid ${config.avoidSpurs}`);
      await this.#command(`lna ${config.lna}`);
      await this.#configureTrigger(config.trigger);
      const readback = await this.#readAnalyzerReadback();
      assertAnalyzerReadback(config, readback);
      this.#analyzer = config;
      this.#zeroSpan = undefined;
      const now = new Date().toISOString();
      this.#set({
        ...this.#snapshot,
        connection: 'ready',
        mode: 'analyzer',
        generatorOutput: 'off',
        // Geometry/RBW/attenuation are observed below; the remaining shell
        // controls have command acknowledgement but no truthful query API.
        verification: 'commanded',
        lastOperationAt: now,
        analyzer: { requested: config, readback, verification: 'commanded' },
        generator: undefined,
        fault: undefined,
      });
      return this.snapshot();
    } catch (error) {
      this.#analyzer = undefined;
      this.#zeroSpan = undefined;
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
        requested: admittedTinySaSpectrumConfiguration(config),
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
      this.#set({ ...this.#snapshot, lastOperationAt: sweep.capturedAt, verification: 'commanded' });
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

  async configureZeroSpan(input: ZeroSpanConfig): Promise<DeviceSnapshot> {
    this.#assertNotStreaming('Zero-span configuration');
    const config = zeroSpanConfigSchema.parse(input);
    this.#assertFrequency(config.frequencyHz, 'analyzer');
    this.#ready();
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
      assertZeroSpanReadback(config, readback);
      this.#analyzer = undefined;
      this.#zeroSpan = { configuration: config, readback };
      const now = new Date().toISOString();
      this.#set({
        ...this.#snapshot,
        connection: 'ready',
        mode: 'analyzer',
        generatorOutput: 'off',
        verification: 'commanded',
        analyzer: undefined,
        generator: undefined,
        lastOperationAt: now,
        fault: undefined,
      });
      return this.snapshot();
    } catch (error) {
      this.#analyzer = undefined;
      this.#zeroSpan = undefined;
      throw this.#operationFailure(error, 'Zero-span configuration failed');
    }
  }

  async acquireZeroSpan(): Promise<ZeroSpanCapture> {
    this.#assertNotStreaming('Zero-span acquisition');
    const prepared = this.#zeroSpan;
    if (!prepared || this.#snapshot.mode !== 'analyzer') {
      throw new TinySaDeviceError('invalid-state', 'Zero-span must be configured before acquisition', false);
    }
    const { configuration: config, readback } = prepared;
    const scheduler = this.#ready();
    const identity = this.#snapshot.identity;
    if (!identity) throw new TinySaDeviceError('invalid-state', 'Connected device identity is unavailable', false);
    try {
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
        timingQualification: 'wall-clock-derived',
        powerDbm: rows.powerDbm,
        requested: admittedTinySaDetectedPowerConfiguration(config),
        actualRbwHz: transportEvidence?.actualRbwHz ?? readback.actualRbwHz,
        actualAttenuationDb: transportEvidence?.actualAttenuationDb ?? readback.attenuationDb,
        source: transportEvidence?.source ?? 'scan-text',
        complete: true,
        identity,
      };
      this.#analyzer = undefined;
      this.#set({ ...this.#snapshot, mode: 'analyzer', generatorOutput: 'off', verification: 'commanded', analyzer: undefined, generator: undefined, lastOperationAt: capturedAt });
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
      this.#zeroSpan = undefined;
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
    if (!enabled && this.#snapshot.connection === 'faulted' && this.#teardownRfOffAcknowledged) {
      return this.snapshot();
    }
    this.#ready();
    if (enabled && (this.#snapshot.mode !== 'generator' || !this.#snapshot.generator)) {
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
      this.#rfOffAcknowledged = false;
      this.#teardownRfOffAcknowledged = false;
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
    this.#rfOffAcknowledged = false;
    this.#teardownRfOffAcknowledged = false;
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
    if (!this.#snapshot.capabilities?.firmwareTraces) return [];
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
    if (trigger.mode !== 'auto') await this.#command(`trigger ${formatDecimal(trigger.levelDbm)}`);
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
    // An older acknowledgement cannot survive a fresh output-off attempt. If
    // the write executes but its reply is rejected or lost, teardown must send
    // output-off again instead of treating the earlier state as current.
    if (command === 'output off') this.#rfOffAcknowledged = false;
    let response: string;
    try {
      response = await this.#ready().execute(command, timeoutMs);
      assertFirmwareMutationAcknowledged(response, command);
    } catch (value) {
      if (command === 'output off' && this.#snapshot.connection !== 'disconnected') {
        const error = asDeviceError(value, 'protocol', 'RF output-off could not be acknowledged', true);
        this.#set({
          ...this.#snapshot,
          connection: 'faulted',
          generatorOutput: 'unknown',
          verification: 'unknown',
          fault: faultFrom(error),
        });
      }
      throw value;
    }
    if (command === 'output off') this.#rfOffAcknowledged = true;
    else if (command === 'output on') {
      this.#rfOffAcknowledged = false;
      this.#teardownRfOffAcknowledged = false;
    }
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
    if (!range) throw new TinySaDeviceError('unsupported', `${domain} frequency control is not advertised by this firmware`, false);
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
    this.#rfOffAcknowledged = false;
    this.#teardownRfOffAcknowledged = false;
    const deviceError = asDeviceError(error, 'protocol', 'Protocol session faulted', true);
    this.#set({
      ...this.#snapshot,
      connection: 'faulted',
      generatorOutput: 'unknown',
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
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.#analyzer = undefined;
    this.#zeroSpan = undefined;
    const retainedTeardownOff = this.#teardownRfOffAcknowledged;
    if (!retainedTeardownOff) this.#rfOffAcknowledged = false;
    this.#set({
      ...this.#snapshot,
      connection: 'faulted',
      mode: 'idle',
      generatorOutput: retainedTeardownOff ? 'off' : 'unknown',
      verification: retainedTeardownOff ? 'commanded' : 'unknown',
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

async function buildCapabilities(
  commands: readonly string[],
  identity: DeviceIdentity,
  readback: AnalyzerReadback,
  query: (command: string) => Promise<string>,
): Promise<DeviceCapabilities> {
  const twin = identity.execution === 'firmware-digital-twin';
  const testDouble = identity.execution === 'protocol-test-double';
  const sourceQualified = identity.firmwareQualification !== 'custom-unqualified';
  const observed = sourceQualified
    ? knownReceiverSurface(commands)
    : await customReceiverSurface(commands, query);
  const analyzerFrequency = sourceQualified
    ? { min: ZS407_FIRMWARE_LIMITS.analyzerMinimumHz, max: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz, unit: 'Hz' as const }
    : intersectQuantizedRange(
      {
        min: Math.min(readback.startHz, readback.stopHz),
        max: Math.max(readback.startHz, readback.stopHz),
        unit: 'Hz',
      },
      ZS407_FIRMWARE_LIMITS.analyzerMinimumHz,
      ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz,
      1,
      'analyzer frequency',
    );
  const sweepPoints = sourceQualified
    ? { min: ZS407_FIRMWARE_LIMITS.minimumSweepPoints, max: ZS407_FIRMWARE_LIMITS.maximumSweepPoints, step: 1, unit: 'points' as const }
    : intersectQuantizedRange(
      { min: readback.points, max: readback.points, unit: 'points' },
      ZS407_FIRMWARE_LIMITS.minimumSweepPoints,
      ZS407_FIRMWARE_LIMITS.maximumSweepPoints,
      1,
      'sweep point count',
    );
  const generatorAdvertised = sourceQualified
    && ['mode', 'output', 'freq', 'level', 'modulation'].every((command) => commands.includes(command));
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
    analyzerFrequency,
    ...(sourceQualified ? {
      analyzerNormalMaximumHz: ZS407_FIRMWARE_LIMITS.analyzerNormalMaximumHz,
      analyzerUltraTransitionHz: ZS407_FIRMWARE_LIMITS.analyzerUltraTransitionHz,
    } : {}),
    ...(generatorAdvertised ? {
      generatorFrequency: { min: 1, max: ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz, unit: 'Hz' as const },
      generatorFundamentalMaximumHz: ZS407_FIRMWARE_LIMITS.generatorFundamentalMaximumHz,
      generatorLevel: { min: ZS407_FIRMWARE_LIMITS.generatorMinimumDbm, max: ZS407_FIRMWARE_LIMITS.generatorMaximumDbm, unit: 'dBm' as const },
    } : {}),
    rbwKhz: observed.rbwKhz,
    attenuationDb: observed.attenuationDb,
    sweepPoints,
    sweepSeconds: observed.sweepSeconds,
    scalarReceiver: observed.scalarReceiver,
    maxSweepPoints: sweepPoints.max,
    screen: { width: 480, height: 320, format: 'rgb565le' },
    // Command-name presence is not behavioral proof for an unqualified
    // custom build. Capture and touch remain unavailable until a future safe,
    // exact probe can establish their wire contract.
    screenCapture: sourceQualified && commands.includes('capture'),
    remoteTouch: sourceQualified && commands.includes('touch') && commands.includes('release'),
    streaming: observed.scalarReceiver.sweptSpectrum,
    rawSweep: observed.scalarReceiver.acquisitionFormats.includes('raw'),
    rawSweepOffsetReadback: observed.rawSweepOffsetReadback,
    ...(sourceQualified ? { markerCount: 8 as const, traceCount: 4 as const } : {}),
    firmwareMarkers: sourceQualified && commands.includes('marker'),
    firmwareTraces: observed.firmwareTraceReadback,
    generatorReadback: false,
    modulation: generatorAdvertised ? ['off', 'am', 'fm'] : [],
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

interface ObservedReceiverSurface {
  readonly rbwKhz: DeviceCapabilities['rbwKhz'];
  readonly attenuationDb: DeviceCapabilities['attenuationDb'];
  readonly sweepSeconds: DeviceCapabilities['sweepSeconds'];
  readonly scalarReceiver: DeviceCapabilities['scalarReceiver'];
  readonly rawSweepOffsetReadback: boolean;
  readonly firmwareTraceReadback: boolean;
}

function knownReceiverSurface(commands: readonly string[]): ObservedReceiverSurface {
  const acquisitionFormats: ('text' | 'raw')[] = [];
  if (commands.includes('scan')) acquisitionFormats.push('text');
  if (commands.includes('scanraw') && commands.includes('zero')) acquisitionFormats.push('raw');
  const spectrumCommands = ['trace', 'sweeptime', 'calc', 'spur', 'avoid', 'lna', 'trigger'];
  const detectedPowerCommands = ['trace', 'sweeptime', 'trigger', 'scan'];
  return {
    rbwKhz: {
      min: ZS407_FIRMWARE_LIMITS.minimumRbwKhz,
      max: ZS407_FIRMWARE_LIMITS.maximumRbwKhz,
      step: 0.1,
      unit: 'kHz',
    },
    attenuationDb: { min: 0, max: 31, step: 1, unit: 'dB' },
    sweepSeconds: {
      min: ZS407_FIRMWARE_LIMITS.minimumSweepSeconds,
      max: ZS407_FIRMWARE_LIMITS.maximumSweepSeconds,
      step: 0.000_001,
      unit: 'seconds',
    },
    scalarReceiver: {
      sweptSpectrum: acquisitionFormats.length > 0 && spectrumCommands.every((command) => commands.includes(command)),
      detectedPower: detectedPowerCommands.every((command) => commands.includes(command)),
      acquisitionFormats,
      resolutionBandwidthAutomatic: true,
      attenuationAutomatic: true,
      sweepTimeAutomatic: true,
      detectors: ['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak'],
      spurRejection: ['off', 'on', 'auto'],
      lowNoiseAmplifier: ['off', 'on'],
      avoidSpurs: ['off', 'on', 'auto'],
      triggerModes: ['auto', 'normal', 'single'],
      triggerLevelDbm: { min: -174, max: 30, unit: 'dBm' },
    },
    rawSweepOffsetReadback: commands.includes('zero'),
    firmwareTraceReadback: commands.includes('trace'),
  };
}

function assertSameProbeGeometry(before: AnalyzerReadback, after: AnalyzerReadback): void {
  if (before.startHz === after.startHz && before.stopHz === after.stopHz && before.points === after.points) return;
  throw new TinySaDeviceError(
    'protocol',
    `Custom firmware capability probes changed analyzer geometry from ${before.startHz}..${before.stopHz}/${before.points} to ${after.startHz}..${after.stopHz}/${after.points}`,
    false,
  );
}

function intersectQuantizedRange(
  advertised: NumericRange,
  supportedMinimum: number,
  supportedMaximum: number,
  step: number,
  label: string,
): NumericRange {
  const lower = Math.max(advertised.min, supportedMinimum);
  const upper = Math.min(advertised.max, supportedMaximum);
  const tolerance = Math.max(1, Math.abs(lower), Math.abs(upper)) * Number.EPSILON * 16;
  const minimumTick = Math.ceil(lower / step - tolerance);
  const maximumTick = Math.floor(upper / step + tolerance);
  if (!Number.isSafeInteger(minimumTick) || !Number.isSafeInteger(maximumTick) || maximumTick < minimumTick) {
    throw new TinySaDeviceError(
      'unsupported',
      `Custom firmware ${label} range ${advertised.min}..${advertised.max} has no value in the supported ${supportedMinimum}..${supportedMaximum} range at step ${step}`,
      false,
    );
  }
  return {
    min: quantizedValue(minimumTick, step),
    max: quantizedValue(maximumTick, step),
    step,
    unit: advertised.unit,
  };
}

function quantizedValue(tick: number, step: number): number {
  // Multiplication by decimal steps otherwise leaks binary artifacts into the
  // public capability contract (for example 3 * 0.1).
  return Number((tick * step).toPrecision(15));
}

async function customReceiverSurface(
  commands: readonly string[],
  query: (command: string) => Promise<string>,
): Promise<ObservedReceiverSurface> {
  const usage = new Map<string, string>();
  for (const [command, probe] of CUSTOM_RECEIVER_PROBES) {
    if (!commands.includes(command)) continue;
    usage.set(command, await query(probe));
  }
  const advertisedRbw = parseAdvertisedRange(usage.get('rbw'), 'rbw', 'kHz');
  const advertisedAttenuation = parseAdvertisedRange(usage.get('attenuate'), 'attenuate', 'dB');
  const advertisedSweepSeconds = parseAdvertisedRange(usage.get('sweeptime'), 'sweeptime', 'seconds');
  if (!advertisedRbw || !advertisedAttenuation || !advertisedSweepSeconds) {
    throw new TinySaDeviceError(
      'unsupported',
      'Custom firmware did not advertise parseable RBW, attenuation, and sweep-time ranges',
      false,
    );
  }
  const rbw = {
    ...advertisedRbw,
    range: intersectQuantizedRange(
      advertisedRbw.range,
      ZS407_FIRMWARE_LIMITS.minimumRbwKhz,
      ZS407_FIRMWARE_LIMITS.maximumRbwKhz,
      0.1,
      'RBW',
    ),
  };
  const attenuation = {
    ...advertisedAttenuation,
    range: intersectQuantizedRange(advertisedAttenuation.range, 0, 31, 1, 'attenuation'),
  };
  const sweepSeconds = {
    ...advertisedSweepSeconds,
    range: intersectQuantizedRange(
      advertisedSweepSeconds.range,
      ZS407_FIRMWARE_LIMITS.minimumSweepSeconds,
      ZS407_FIRMWARE_LIMITS.maximumSweepSeconds,
      0.000_001,
      'sweep-time',
    ),
  };

  const trace = parseTraceUsage(usage.get('trace'));
  const rawSweepOffsetReadback = hasExactRawSweepOffsetUsage(usage.get('zero'));
  const sweepSyntax = hasExactSweepUsage(usage.get('sweep'));
  const traceDbm = trace?.options.includes('dBm') ?? false;
  const firmwareTraceReadback = traceDbm && (trace?.valueReadback ?? false);
  const detectors = advertisedDetectors(usage.get('calc'));
  const spurRejection = parseOptionUsage(usage.get('spur'), 'spur', ['off', 'on', 'auto'] as const);
  const avoidSpurs = parseOptionUsage(usage.get('avoid'), 'avoid', ['off', 'on', 'auto', 'dump'] as const)
    .filter((value): value is 'off' | 'on' | 'auto' => value !== 'dump');
  const lowNoiseAmplifier = parseOptionUsage(usage.get('lna'), 'lna', ['off', 'on'] as const);
  const advertisedTriggerModes = parseTriggerUsage(usage.get('trigger'));
  // The custom shell advertises trigger mode names but no threshold range.
  // Preserve only auto; leveled modes require a truthful numeric range.
  const triggerModes = advertisedTriggerModes.includes('auto') ? ['auto'] as const : [];
  const acquisitionFormats: ('text' | 'raw')[] = [];
  if (hasExactSingleLine(
    usage.get('scan'),
    /^usage: scan \{start\(Hz\)\} \{stop\(Hz\)\} \[points\] \[outmask\]$/,
  )) {
    acquisitionFormats.push('text');
  }
  if (rawSweepOffsetReadback
    && hasExactSingleLine(
      usage.get('scanraw'),
      /^usage: scanraw \{start\(Hz\)\} \{stop\(Hz\)\} \[points\] \[options\]$/,
    )) {
    acquisitionFormats.push('raw');
  }
  const commonReceiverSyntax = sweepSyntax && traceDbm && triggerModes.length > 0;
  return {
    rbwKhz: rbw.range,
    attenuationDb: attenuation.range,
    sweepSeconds: sweepSeconds.range,
    scalarReceiver: {
      sweptSpectrum: commonReceiverSyntax
        && acquisitionFormats.length > 0
        && detectors.length > 0
        && spurRejection.length > 0
        && avoidSpurs.length > 0
        && lowNoiseAmplifier.length > 0,
      detectedPower: commonReceiverSyntax && acquisitionFormats.includes('text'),
      acquisitionFormats,
      resolutionBandwidthAutomatic: rbw.automatic,
      attenuationAutomatic: attenuation.automatic,
      // Literal zero has qualified-source semantics; an unqualified custom
      // build receives only the numeric range it explicitly advertised.
      sweepTimeAutomatic: false,
      detectors,
      spurRejection,
      lowNoiseAmplifier,
      avoidSpurs,
      triggerModes,
    },
    rawSweepOffsetReadback,
    firmwareTraceReadback,
  };
}

function parseAdvertisedRange(
  response: string | undefined,
  command: string,
  unit: DeviceCapabilities['rbwKhz']['unit'],
): { readonly range: DeviceCapabilities['rbwKhz']; readonly automatic: boolean } | undefined {
  if (!response) return undefined;
  const lines = exactResponseLines(response);
  if (lines.length < 1 || lines.length > 2) return undefined;
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lines[0]?.match(new RegExp(`^usage: ${escaped} (-?\\d+(?:\\.\\d+)?)\\.\\.(-?\\d+(?:\\.\\d+)?)(\\|auto)?$`));
  if (!match || (lines[1] !== undefined && !isExactRangeReadback(command, lines[1]))) return undefined;
  const min = Number(match?.[1]);
  const max = Number(match?.[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return undefined;
  return { range: { min, max, unit }, automatic: match?.[3] !== undefined };
}

function isExactRangeReadback(command: string, line: string): boolean {
  // TinySA_Firmware 53850c4 emits a current-value line after each of these
  // usage declarations. Its uppercase `%F` formatter dispatches to ftoaS,
  // which inserts engineering prefixes. The advertised ZS407 ranges bound RBW
  // to no prefix or `k`, and sweep time to seconds or milliseconds.
  if (command === 'rbw') return /^\d+(?:\.\d+)?k?Hz$/.test(line);
  if (command === 'sweeptime') return /^\d+(?:\.\d+)?m?s$/.test(line);
  if (command === 'attenuate') return /^\d+(?:\.\d+)?$/.test(line);
  return false;
}

function advertisedDetectors(response: string | undefined): DeviceCapabilities['scalarReceiver']['detectors'] {
  const values: readonly [string, DeviceCapabilities['scalarReceiver']['detectors'][number]][] = [
    ['off', 'sample'], ['minh', 'minimum-hold'], ['maxh', 'maximum-hold'], ['maxd', 'maximum-decay'],
    ['aver4', 'average-4'], ['aver16', 'average-16'], ['aver', 'average'], ['quasi', 'quasi-peak'],
  ];
  const lines = exactResponseLines(response);
  if (lines.length < 1 || lines.length > 2) return [];
  if (lines[1] !== undefined && !['OFF', 'MINH', 'MAXH', 'MAXD', 'AVER4', 'A16', 'AVER', 'QUASI'].includes(lines[1])) return [];
  const advertised = parseOptionUsage(
    lines[0],
    'calc',
    ['off', 'minh', 'maxh', 'maxd', 'aver4', 'aver16', 'aver', 'quasi', 'log', 'lin'] as const,
    '[{trace#}] ',
  );
  return values.filter(([wire]) => advertised.includes(wire as typeof advertised[number])).map(([, value]) => value);
}

function parseOptionUsage<const Value extends string>(
  response: string | undefined,
  command: string,
  allowed: readonly Value[],
  exactPrefix = '',
): readonly Value[] {
  const lines = exactResponseLines(response);
  if (lines.length !== 1) return [];
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPrefix = exactPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lines[0]?.match(new RegExp(`^usage: ${escapedCommand} ${escapedPrefix}([a-z0-9|]+)$`));
  if (!match) return [];
  const options = match[1]!.split('|');
  if (!options.length || new Set(options).size !== options.length || options.some((value) => !allowed.includes(value as Value))) return [];
  return options as Value[];
}

function parseTraceUsage(response: string | undefined): {
  readonly options: readonly ('dBm' | 'dBmV' | 'dBuV' | 'RAW' | 'V' | 'Vpp' | 'W')[];
  readonly valueReadback: boolean;
} | undefined {
  const lines = exactResponseLines(response);
  if (lines.length < 1 || (lines.length > 2 && lines.length !== 4)) return undefined;
  const match = lines[0]?.match(/^(?:usage: )?trace \{(dBm(?:V)?|dBuV|RAW|V|Vpp|W)(?:\|(dBm(?:V)?|dBuV|RAW|V|Vpp|W))*\}$/);
  if (!match) return undefined;
  const opening = lines[0]!.indexOf('{');
  const options = lines[0]!.slice(opening + 1, -1).split('|') as ('dBm' | 'dBmV' | 'dBuV' | 'RAW' | 'V' | 'Vpp' | 'W')[];
  if (new Set(options).size !== options.length) return undefined;
  if (lines.length === 4) {
    if (lines[1] !== 'trace {scale|reflevel} auto|{value}'
      || lines[2] !== 'trace [{trace#}] value'
      || lines[3] !== 'trace [{trace#}] {copy|freeze|subtract|view|value} {trace#}|off|on|[{index} {value}]') return undefined;
    return { options, valueReadback: true };
  }
  if (lines[1] !== undefined && lines[1] !== 'trace [{trace#}] value') return undefined;
  return { options, valueReadback: lines.length === 2 };
}

function parseTriggerUsage(response: string | undefined): readonly ('auto' | 'normal' | 'single')[] {
  const lines = exactResponseLines(response);
  let optionsText: string | undefined;
  if (lines.length === 2 && lines[0] === 'trigger {value}') {
    optionsText = lines[1]?.match(/^trigger \{(auto(?:\|normal)?(?:\|single)?)\}$/)?.[1];
  } else if (lines.length === 1) {
    optionsText = lines[0]?.match(/^usage: trigger (auto(?:\|normal)?(?:\|single)?)$/)?.[1];
  }
  if (!optionsText) return [];
  const options = optionsText.split('|') as ('auto' | 'normal' | 'single')[];
  return new Set(options).size === options.length ? options : [];
}

function hasExactRawSweepOffsetUsage(response: string | undefined): boolean {
  const lines = exactResponseLines(response);
  if (lines.length !== 2 || lines[0] !== 'usage: zero {level}' || !/^-?\d+dBm$/.test(lines[1] ?? '')) return false;
  try {
    parseRawSweepOffset(lines[1]!);
    return true;
  } catch {
    return false;
  }
}

function hasExactSweepUsage(response: string | undefined): boolean {
  const lines = exactResponseLines(response);
  return lines.length === 3
    && lines[0] === 'usage: sweep {start(Hz)} [stop(Hz)] [points]'
    && lines[1] === 'sweep {normal|precise|fast|noise|go|abort}'
    && lines[2] === 'sweep {start|stop|center|span|cw} {freq(Hz)}';
}

function hasExactSingleLine(response: string | undefined, pattern: RegExp): boolean {
  const lines = exactResponseLines(response);
  return lines.length === 1 && pattern.test(lines[0]!);
}

function exactResponseLines(response: string | undefined): readonly string[] {
  if (!response) return [];
  return response.replaceAll('\r', '').split('\n').map((line) => line.trim()).filter(Boolean);
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
  const lines = exactResponseLines(response);
  if (lines.length !== 2) {
    throw new TinySaDeviceError('protocol', 'Malformed help catalog: expected exactly commands and Other commands lines', false);
  }
  const primary = parseHelpCatalogLine(lines[0]!, 'commands');
  const secondary = parseHelpCatalogLine(lines[1]!, 'Other commands');
  const commands = [...primary, ...secondary];
  if (!commands.length) throw new TinySaDeviceError('protocol', 'help response contained no command catalog', false);
  if (new Set(commands).size !== commands.length) {
    throw new TinySaDeviceError('protocol', 'Malformed help catalog: a command was declared more than once', false);
  }
  return commands.sort();
}

function parseHelpCatalogLine(line: string, header: 'commands' | 'Other commands'): readonly string[] {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(`^${escapedHeader}:((?: [a-z][a-z0-9_]*)*)$`));
  if (!match) throw new TinySaDeviceError('protocol', `Malformed help catalog ${header} line`, false);
  return match[1] ? match[1].slice(1).split(' ') : [];
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
  if (startHz > stopHz || points < 1) throw new TinySaDeviceError('protocol', `Invalid sweep readback geometry: ${response}`, false);
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

function assertZeroSpanReadback(config: ZeroSpanConfig, readback: AnalyzerReadback): void {
  if (readback.startHz !== config.frequencyHz || readback.stopHz !== config.frequencyHz || readback.points !== config.points) {
    throw new TinySaDeviceError('protocol', 'Zero-span readback does not match the requested frequency and point count', false);
  }
  if (config.attenuationDb !== 'auto' && Math.abs(readback.attenuationDb - config.attenuationDb) > 0.01) {
    throw new TinySaDeviceError('protocol', `Zero-span attenuation readback ${readback.attenuationDb} dB does not match ${config.attenuationDb} dB`, false);
  }
}

function assertFirmwareSuccess(response: string, command: string): void {
  const failure = response.match(/(?:Command timeout|frequency range is invalid|sweep points exceeds[^\r\n]*|Key unmatched\.|^usage:[^\r\n]*)/im)?.[0];
  if (failure) throw new TinySaDeviceError('protocol', `${command} failed: ${failure}`, false);
}

function assertFirmwareMutationAcknowledged(response: string, command: string): void {
  const reply = nonEmptyLines(response);
  if (!reply.length) return;
  const firstLine = reply[0]!.slice(0, 160);
  throw new TinySaDeviceError(
    'protocol',
    `Firmware rejected command ${command}: mutating commands require an empty reply, received ${JSON.stringify(firstLine)}`,
    false,
  );
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
