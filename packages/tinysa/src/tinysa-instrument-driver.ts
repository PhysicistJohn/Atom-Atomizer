import {
  ZS407_FIRMWARE_LIMITS,
  instrumentCandidateSchema,
  instrumentConfigurationCommandSchema,
  instrumentFeatureCommandSchema,
  instrumentMeasurementSchema,
  instrumentSessionEventSchema,
  type AnalyzerConfig,
  type DeviceDiagnostics,
  type DeviceEvent,
  type DeviceSnapshot,
  type GeneratorConfig,
  type InstrumentCandidate,
  type InstrumentCandidateDescriptor,
  type InstrumentCapabilities,
  type InstrumentConfigurationCommand,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentSessionProvenance,
  type InstrumentSessionEvent,
  type PortCandidate,
  type ScreenFrame,
  type ScreenPoint,
  type Sweep,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import type { InstrumentDriver, InstrumentSession } from './instrument-driver.js';
import type { TransportDiscoveryResult } from './transport.js';

export const TINYSA_ZS407_DRIVER_ID = 'tinysa-zs407' as const;

export interface TinySaInstrumentDevicePort {
  listDevices(): Promise<TransportDiscoveryResult>;
  snapshot(): DeviceSnapshot;
  connect(candidate: PortCandidate): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  cleanupPendingInstrumentConnection(): Promise<void>;
  configureAnalyzer(configuration: AnalyzerConfig): Promise<DeviceSnapshot>;
  acquireSweep(): Promise<Sweep>;
  acquireZeroSpan(configuration: ZeroSpanConfig): Promise<ZeroSpanCapture>;
  configureGenerator(configuration: GeneratorConfig): Promise<DeviceSnapshot>;
  setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot>;
  readDiagnostics(): Promise<DeviceDiagnostics>;
  captureScreen(): Promise<ScreenFrame>;
  touch(point: ScreenPoint): Promise<void>;
  releaseTouch(point?: ScreenPoint): Promise<void>;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}

/** Adapter retaining all TinySA protocol knowledge inside the TinySA driver. */
export class TinySaZs407InstrumentDriver implements InstrumentDriver {
  readonly driverId = TINYSA_ZS407_DRIVER_ID;
  readonly sourceKinds = ['serial-port', 'tinysa-firmware-twin'] as const;
  #candidates = new Map<string, PortCandidate>();

  constructor(private readonly device: TinySaInstrumentDevicePort) {}

  cleanupPendingConnection(): Promise<void> {
    return this.device.cleanupPendingInstrumentConnection();
  }

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    const discovery = await this.device.listDevices();
    const mapped: InstrumentCandidateDescriptor[] = [];
    const originals = new Map<string, PortCandidate>();
    for (const candidate of discovery.candidates) {
      const descriptor = descriptorFor(candidate);
      if (!descriptor) continue;
      if (originals.has(descriptor.candidateId)) throw new Error(`TinySA discovery returned duplicate candidate ${descriptor.candidateId}`);
      originals.set(descriptor.candidateId, candidate);
      mapped.push(descriptor);
    }
    this.#candidates = originals;
    return {
      candidates: mapped,
      failures: discovery.failures.map((failure) => ({
        sourceKind: failure.sourceKind,
        code: 'source-unavailable',
        recoverable: failure.recoverable,
        message: failure.message,
      })),
    };
  }

  async connect(candidateValue: InstrumentCandidate): Promise<InstrumentSession> {
    const candidate = instrumentCandidateSchema.parse(candidateValue);
    if (candidate.driverId !== this.driverId || !this.sourceKinds.includes(candidate.sourceKind as never)) {
      throw new Error('TinySA driver received a candidate owned by another driver or source kind');
    }
    const original = this.#candidates.get(candidate.candidateId);
    if (!original || !sameDescriptor(candidate, descriptorFor(original))) {
      throw new Error('TinySA candidate no longer matches the latest driver discovery');
    }
    const snapshot = await this.device.connect(original);
    if (snapshot.connection !== 'ready' || !snapshot.sessionId || !snapshot.capabilities
      || !snapshot.identity || !snapshot.connectedAt) {
      throw new Error('TinySA device service did not return one ready identified session');
    }
    const provenance = tinySaSessionProvenance(candidate, snapshot.identity, snapshot.connectedAt);
    return new TinySaInstrumentSession(this.device, candidate, snapshot.sessionId, provenance, snapshot.generatorOutput);
  }
}

class TinySaInstrumentSession implements InstrumentSession {
  readonly driverId = TINYSA_ZS407_DRIVER_ID;
  readonly capabilities: InstrumentCapabilities;
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  readonly #unsubscribe: () => void;
  #configuration: InstrumentConfigurationCommand | undefined;
  #terminalEvent: InstrumentSessionEvent | undefined;
  #closed = false;

  constructor(
    private readonly device: TinySaInstrumentDevicePort,
    readonly candidate: InstrumentCandidate,
    readonly sessionId: string,
    readonly provenance: InstrumentSessionProvenance,
    readonly rfOutput: 'off' | 'on' | 'unknown',
  ) {
    this.capabilities = tinySaCapabilities();
    this.#unsubscribe = device.subscribe((event) => this.#forwardDeviceEvent(event));
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    if (this.#closed) throw new Error('TinySA instrument session is closed');
    this.#listeners.add(listener);
    if (this.#terminalEvent) {
      try { listener(this.#terminalEvent); } catch { /* Consumer isolation. */ }
    }
    return () => this.#listeners.delete(listener);
  }

  async configure(commandValue: InstrumentConfigurationCommand): Promise<void> {
    this.#requireOpen();
    const command = instrumentConfigurationCommandSchema.parse(commandValue);
    this.#requireSession(command.sessionId);
    if (command.configuration.kind === 'swept-spectrum') {
      await this.device.configureAnalyzer(defaultAnalyzerConfiguration(command.configuration));
    } else if (command.configuration.kind === 'complex-iq') {
      throw new Error('TinySA ZS407 does not support complex-I/Q acquisition');
    }
    this.#configuration = command;
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    const command = this.#configuration;
    if (!command) throw new Error('TinySA instrument session is not configured');
    let measurement: InstrumentMeasurement;
    if (command.configuration.kind === 'swept-spectrum') {
      const sweep = await this.device.acquireSweep();
      measurement = {
        schemaVersion: 1,
        kind: 'swept-spectrum',
        measurementId: sweep.id,
        sessionId: this.sessionId,
        configurationRevision: command.configurationRevision,
        sequence: sweep.sequence,
        capturedAt: sweep.capturedAt,
        elapsedMilliseconds: sweep.elapsedMilliseconds,
        resolutionBandwidthHz: sweep.actualRbwHz,
        attenuationDb: sweep.actualAttenuationDb,
        qualification: this.provenance.qualification,
        complete: true,
        frequencyHz: sweep.frequencyHz,
        powerDbm: sweep.powerDbm,
      };
    } else if (command.configuration.kind === 'detected-power-timeseries') {
      const capture = await this.device.acquireZeroSpan(defaultZeroSpanConfiguration(command.configuration));
      measurement = {
        schemaVersion: 1,
        kind: 'detected-power-timeseries',
        measurementId: capture.id,
        sessionId: this.sessionId,
        configurationRevision: command.configurationRevision,
        sequence: capture.sequence,
        capturedAt: capture.capturedAt,
        elapsedMilliseconds: capture.elapsedMilliseconds,
        resolutionBandwidthHz: capture.actualRbwHz,
        attenuationDb: capture.actualAttenuationDb,
        qualification: this.provenance.qualification,
        complete: true,
        centerHz: capture.frequencyHz,
        sampleIntervalSeconds: capture.samplePeriodSeconds,
        timingQualification: capture.timingQualification ?? 'wall-clock-derived',
        powerDbm: capture.powerDbm,
      };
    } else {
      throw new Error('TinySA ZS407 does not support complex-I/Q acquisition');
    }
    return instrumentMeasurementSchema.parse(measurement);
  }

  async executeFeature(commandValue: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.#requireOpen();
    const command = instrumentFeatureCommandSchema.parse(commandValue);
    this.#requireSession(command.sessionId);
    if (command.kind === 'rf-generator') {
      if (command.action === 'configure') {
        await this.device.configureGenerator(defaultGeneratorConfiguration(command));
        return { ...command };
      }
      await this.device.setGeneratorOutput(command.enabled);
      return { ...command };
    }
    if (command.kind === 'screen') {
      const frame = await this.device.captureScreen();
      return {
        sessionId: this.sessionId,
        kind: 'screen',
        action: 'capture',
        frame: {
          width: frame.width,
          height: frame.height,
          pixelFormat: frame.format,
          pixels: new Uint8Array(frame.pixels),
          capturedAt: frame.capturedAt,
        },
      };
    }
    if (command.kind === 'touch') {
      const point = { x: command.x, y: command.y };
      await this.device.touch(point);
      try { await this.device.releaseTouch(point); }
      catch (cause) { throw new Error('TinySA touch was sent but release could not be confirmed', { cause }); }
      return { ...command, accepted: true };
    }
    if (command.kind === 'diagnostics') {
      const diagnostics = await this.device.readDiagnostics();
      return { ...command, lines: diagnosticLines(diagnostics, command.report) };
    }
    throw new Error('SignalLab profile selection is not a TinySA feature');
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    await this.device.disconnect();
    this.#closed = true;
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #requireOpen(): void { if (this.#closed) throw new Error('TinySA instrument session is closed'); }
  #requireSession(sessionId: string): void {
    if (sessionId !== this.sessionId) throw new Error('TinySA command session ID does not match the active session');
  }

  #forwardDeviceEvent(event: DeviceEvent): void {
    if (this.#closed) return;
    let forwarded: InstrumentSessionEvent | undefined;
    if (event.type === 'error') {
      forwarded = instrumentSessionEventSchema.parse({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'session-fault', message: event.error.message, recoverable: event.error.recoverable },
      });
    } else if (event.type === 'snapshot') {
      const status = event.snapshot.connection === 'faulted' ? 'faulted'
        : event.snapshot.connection === 'ready' ? 'ready' : 'busy';
      forwarded = instrumentSessionEventSchema.parse({ type: 'status', sessionId: this.sessionId, status });
    }
    if (!forwarded) return;
    if ((forwarded.type === 'status' && forwarded.status === 'faulted')
      || (forwarded.type === 'error' && !forwarded.error.recoverable)) {
      this.#terminalEvent ??= forwarded;
    }
    this.#emit(forwarded);
  }

  #emit(value: InstrumentSessionEvent): void {
    const event = instrumentSessionEventSchema.parse(value);
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* Consumer isolation. */ }
    }
  }
}

function tinySaSessionProvenance(
  candidate: InstrumentCandidate,
  identity: NonNullable<DeviceSnapshot['identity']>,
  verifiedAt: string,
): InstrumentSessionProvenance {
  if (candidate.sourceKind === 'serial-port') {
    if (identity.execution !== 'physical' || identity.port.id !== candidate.candidateId) {
      throw new Error('TinySA physical identity does not match the admitted serial candidate');
    }
    if (identity.firmwareQualification !== 'supported-oem'
      && identity.firmwareQualification !== 'custom-unqualified') {
      throw new Error(`TinySA physical identity has invalid firmware qualification ${identity.firmwareQualification}`);
    }
    return {
      sourceKind: 'serial-port',
      execution: 'physical',
      transport: 'usb-cdc-acm',
      qualification: 'device-observed',
      verifiedAt,
      serialPort: candidate.serialPort,
      device: {
        model: identity.model,
        hardwareVersion: identity.hardwareVersion,
        firmwareVersion: identity.firmwareVersion,
        ...(identity.firmwareReportedRevision ? { firmwareReportedRevision: identity.firmwareReportedRevision } : {}),
        ...(identity.firmwareSourceCommit ? { firmwareSourceCommit: identity.firmwareSourceCommit } : {}),
        firmwareQualification: identity.firmwareQualification,
        usbIdentityVerified: identity.usbIdentityVerified,
      },
    };
  }
  if (candidate.sourceKind === 'tinysa-firmware-twin') {
    if (identity.execution !== 'firmware-digital-twin'
      || identity.port.id !== candidate.candidateId
      || !identity.digitalTwin) {
      throw new Error('TinySA executable identity does not match the admitted firmware-twin candidate');
    }
    return {
      sourceKind: 'tinysa-firmware-twin',
      execution: 'firmware-executed-twin',
      transport: 'renode-monitor-bridge',
      qualification: 'firmware-executed-twin',
      verifiedAt,
      bridge: candidate.firmwareTwin.bridge,
      repositoryCommit: candidate.firmwareTwin.repositoryCommit,
      firmwareBinarySha256: candidate.firmwareTwin.firmwareBinarySha256,
      usbTransactionsModeled: false,
      device: {
        model: identity.model,
        hardwareVersion: identity.hardwareVersion,
        firmwareVersion: identity.firmwareVersion,
      },
    };
  }
  throw new Error('TinySA driver cannot establish SignalLab session provenance');
}

function descriptorFor(candidate: PortCandidate): InstrumentCandidateDescriptor | undefined {
  if (candidate.execution === 'physical') {
    return {
      schemaVersion: 1,
      driverId: TINYSA_ZS407_DRIVER_ID,
      candidateId: candidate.id,
      displayName: candidate.product ?? candidate.manufacturer ?? 'TinySA serial candidate',
      sourceKind: 'serial-port',
      serialPort: {
        path: candidate.path,
        ...(candidate.manufacturer ? { manufacturer: candidate.manufacturer } : {}),
        ...(candidate.product ? { product: candidate.product } : {}),
        ...(candidate.serialNumber ? { serialNumber: candidate.serialNumber } : {}),
        ...(candidate.vendorId ? { vendorId: candidate.vendorId } : {}),
        ...(candidate.productId ? { productId: candidate.productId } : {}),
      },
    };
  }
  if (candidate.execution === 'firmware-digital-twin' && candidate.digitalTwin) {
    return {
      schemaVersion: 1,
      driverId: TINYSA_ZS407_DRIVER_ID,
      candidateId: candidate.id,
      displayName: candidate.product ?? 'TinySA ZS407 executable firmware twin',
      sourceKind: 'tinysa-firmware-twin',
      firmwareTwin: {
        bridge: candidate.digitalTwin.bridge,
        repositoryCommit: candidate.digitalTwin.repositoryCommit,
        firmwareBinarySha256: candidate.digitalTwin.firmwareBinarySha256,
        usbTransactionsModeled: false,
      },
    };
  }
  return undefined;
}

function sameDescriptor(candidate: InstrumentCandidate, descriptor: InstrumentCandidateDescriptor | undefined): boolean {
  if (!descriptor) return false;
  const { discoveryRevision: _revision, ...withoutRevision } = candidate;
  return JSON.stringify(withoutRevision) === JSON.stringify(descriptor);
}

function tinySaCapabilities(): InstrumentCapabilities {
  return {
    schemaVersion: 1,
    acquisitions: [
      {
        kind: 'swept-spectrum',
        frequencyHz: { min: ZS407_FIRMWARE_LIMITS.analyzerMinimumHz, max: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
        points: { min: ZS407_FIRMWARE_LIMITS.minimumSweepPoints, max: ZS407_FIRMWARE_LIMITS.maximumSweepPoints },
        powerUnit: 'dBm',
      },
      {
        kind: 'detected-power-timeseries',
        centerFrequencyHz: { min: ZS407_FIRMWARE_LIMITS.analyzerMinimumHz, max: ZS407_FIRMWARE_LIMITS.analyzerHarmonicMaximumHz },
        sampleCount: { min: ZS407_FIRMWARE_LIMITS.minimumSweepPoints, max: ZS407_FIRMWARE_LIMITS.maximumSweepPoints },
        // This conservative interval range keeps every advertised sample-count
        // combination inside the firmware's admitted total sweep duration.
        sampleIntervalSeconds: {
          min: ZS407_FIRMWARE_LIMITS.minimumSweepSeconds / ZS407_FIRMWARE_LIMITS.minimumSweepPoints,
          max: ZS407_FIRMWARE_LIMITS.maximumSweepSeconds / ZS407_FIRMWARE_LIMITS.maximumSweepPoints,
        },
        powerUnit: 'dBm',
        timing: 'uniform',
      },
    ],
    features: [
      {
        kind: 'rf-generator',
        paths: [
          { path: 'normal', frequencyHz: { min: 1, max: ZS407_FIRMWARE_LIMITS.generatorFundamentalMaximumHz } },
          { path: 'mixer', frequencyHz: { min: 1, max: ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz } },
        ],
        levelDbm: { min: ZS407_FIRMWARE_LIMITS.generatorMinimumDbm, max: ZS407_FIRMWARE_LIMITS.generatorMaximumDbm, step: 0.5 },
        modulation: {
          off: true,
          am: {
            modulationFrequencyHz: { min: 1, max: 10_000, step: 1 },
            depthPercent: { min: 0, max: 100, step: 1 },
          },
          fm: {
            modulationFrequencyHz: { min: 1, max: 3_500, step: 1 },
            deviationHz: { min: 1_000, max: 300_000, step: 1 },
          },
        },
      },
      { kind: 'screen', width: ZS407_FIRMWARE_LIMITS.screenWidth, height: ZS407_FIRMWARE_LIMITS.screenHeight, pixelFormat: 'rgb565le' },
      { kind: 'touch', width: ZS407_FIRMWARE_LIMITS.screenWidth, height: ZS407_FIRMWARE_LIMITS.screenHeight },
      { kind: 'diagnostics', reports: ['identity', 'health', 'configuration'] },
    ],
  };
}

function defaultAnalyzerConfiguration(configuration: Extract<InstrumentConfigurationCommand['configuration'], { kind: 'swept-spectrum' }>): AnalyzerConfig {
  return {
    startHz: configuration.startHz,
    stopHz: configuration.stopHz,
    points: configuration.points,
    acquisitionFormat: 'raw',
    rbwKhz: 'auto',
    attenuationDb: 'auto',
    sweepTimeSeconds: 'auto',
    detector: 'sample',
    spurRejection: 'auto',
    lna: 'off',
    avoidSpurs: 'auto',
    trigger: { mode: 'auto' },
  };
}

function defaultZeroSpanConfiguration(configuration: Extract<InstrumentConfigurationCommand['configuration'], { kind: 'detected-power-timeseries' }>): ZeroSpanConfig {
  return {
    frequencyHz: configuration.centerHz,
    points: configuration.sampleCount,
    rbwKhz: 'auto',
    attenuationDb: 'auto',
    sweepTimeSeconds: configuration.sampleCount * configuration.sampleIntervalSeconds,
    trigger: { mode: 'auto' },
  };
}

function defaultGeneratorConfiguration(
  command: Extract<InstrumentFeatureCommand, { kind: 'rf-generator'; action: 'configure' }>,
): GeneratorConfig {
  const modulation = command.modulation;
  return {
    frequencyHz: command.frequencyHz,
    levelDbm: command.levelDbm,
    path: command.path,
    modulation: modulation.mode,
    modulationFrequencyHz: modulation.mode === 'off' ? 1_000 : modulation.modulationFrequencyHz,
    amDepthPercent: modulation.mode === 'am' ? modulation.depthPercent : 50,
    fmDeviationHz: modulation.mode === 'fm' ? modulation.deviationHz : 25_000,
  };
}

function diagnosticLines(diagnostics: DeviceDiagnostics, report: 'identity' | 'health' | 'configuration'): readonly string[] {
  if (report === 'identity') return [
    `model=${diagnostics.identity.model}`,
    `hardware=${diagnostics.identity.hardwareVersion}`,
    `firmware=${diagnostics.identity.firmwareVersion}`,
  ];
  if (report === 'health') return [
    `batteryMillivolts=${diagnostics.telemetry.batteryMillivolts}`,
    `deviceId=${diagnostics.telemetry.deviceId}`,
    `sweepStatus=${diagnostics.telemetry.sweepStatus}`,
  ];
  return [
    `analyzerStartHz=${diagnostics.analyzerReadback.startHz}`,
    `analyzerStopHz=${diagnostics.analyzerReadback.stopHz}`,
    `analyzerPoints=${diagnostics.analyzerReadback.points}`,
  ];
}
