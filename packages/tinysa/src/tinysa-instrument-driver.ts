import { isDeepStrictEqual } from 'node:util';
import {
  deviceIdentitySchema,
  isSupportedZs407FirmwareIdentity,
  isZs407FirmwareVersionRevisionPair,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentConfigurationCommandSchema,
  instrumentFeatureCommandSchema,
  instrumentMeasurementSchema,
  instrumentSessionEventSchema,
  portCandidateSchema,
  type AnalyzerConfig,
  type DeviceDiagnostics,
  type DeviceCapabilities,
  type DeviceEvent,
  type DeviceIdentity,
  type DeviceSnapshot,
  type DetectedPowerTimeseriesConfiguration,
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
  type SweptSpectrumConfiguration,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import type { InstrumentDriver, InstrumentSession } from '@tinysa/instrument-runtime';
import type { TransportDiscoveryResult } from './transport.js';
import { tinySaAnalyzerConfiguration, tinySaDetectedPowerConfiguration } from './scalar-configuration.js';

export const TINYSA_ZS407_DRIVER_ID = 'tinysa-zs407' as const;

export interface TinySaInstrumentDevicePort {
  listDevices(): Promise<TransportDiscoveryResult>;
  snapshot(): DeviceSnapshot;
  connect(candidate: PortCandidate): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  cleanupPendingInstrumentConnection(): Promise<void>;
  configureAnalyzer(configuration: AnalyzerConfig): Promise<DeviceSnapshot>;
  configureZeroSpan(configuration: ZeroSpanConfig): Promise<DeviceSnapshot>;
  acquireSweep(): Promise<Sweep>;
  acquireZeroSpan(): Promise<ZeroSpanCapture>;
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
    const capabilities = tinySaCapabilities(snapshot.capabilities);
    const rfOutput = capabilities.features.some((feature) => feature.kind === 'rf-generator')
      ? snapshot.generatorOutput
      : 'not-supported';
    return new TinySaInstrumentSession(
      this.device,
      candidate,
      snapshot.sessionId,
      provenance,
      snapshot.identity,
      capabilities,
      rfOutput,
    );
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
    private readonly admittedDeviceIdentity: DeviceIdentity,
    capabilities: InstrumentCapabilities,
    readonly rfOutput: 'off' | 'on' | 'unknown' | 'not-supported',
  ) {
    this.capabilities = capabilities;
    this.#unsubscribe = device.subscribe((event) => this.#forwardDeviceEvent(event));
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    if (this.#closed) throw new Error('TinySA instrument session is closed');
    this.#listeners.add(listener);
    if (this.#terminalEvent) {
      try { listener(structuredClone(this.#terminalEvent)); } catch { /* Consumer isolation. */ }
    }
    return () => this.#listeners.delete(listener);
  }

  async configure(commandValue: InstrumentConfigurationCommand): Promise<void> {
    this.#requireOpen();
    const command = instrumentConfigurationCommandSchema.parse(commandValue);
    this.#requireSession(command.sessionId);
    if (command.configuration.kind === 'swept-spectrum') {
      await this.device.configureAnalyzer(tinySaAnalyzerConfiguration(command.configuration));
    } else if (command.configuration.kind === 'detected-power-timeseries') {
      await this.device.configureZeroSpan(tinySaDetectedPowerConfiguration(command.configuration));
    } else if (command.configuration.kind === 'complex-iq') {
      throw new Error('TinySA ZS407 does not support complex-I/Q acquisition');
    }
    this.#configuration = command;
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    const command = this.#configuration;
    if (!command) throw new Error('TinySA instrument session is not configured');
    if (this.rfOutput === 'not-supported') {
      // A reduced custom firmware can safely omit generator configuration
      // from its public capabilities while the mandatory output-off command
      // still protects every acquisition at the device boundary.
      await this.device.setGeneratorOutput(false);
    }
    let measurement: InstrumentMeasurement;
    if (command.configuration.kind === 'swept-spectrum') {
      const sweep = await this.device.acquireSweep();
      if (sweep.complete !== true) {
        throw new Error('TinySA device service returned an incomplete swept-spectrum acquisition');
      }
      if (!deviceAcquisitionIdentityMatches(this.admittedDeviceIdentity, sweep.identity)) {
        throw new Error('TinySA swept-spectrum acquisition identity does not match the admitted device session');
      }
      assertSweptAcquisitionEvidence(command.configuration, sweep);
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
      const capture = await this.device.acquireZeroSpan();
      if (capture.complete !== true) {
        throw new Error('TinySA device service returned an incomplete detected-power acquisition');
      }
      if (!deviceAcquisitionIdentityMatches(this.admittedDeviceIdentity, capture.identity)) {
        throw new Error('TinySA detected-power acquisition identity does not match the admitted device session');
      }
      assertDetectedPowerAcquisitionEvidence(command.configuration, capture);
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
      let touchFailure: unknown;
      try {
        await this.device.touch(point);
        try { await this.device.releaseTouch(point); }
        catch (cause) { throw new Error('TinySA touch was sent but release could not be confirmed', { cause }); }
      } catch (cause) {
        touchFailure = cause;
      }
      let rfOffFailure: unknown;
      if (this.rfOutput === 'not-supported') {
        // Touch can change the device's operating mode even when this custom
        // firmware has no safely advertisable generator configuration range.
        // Keep the public feature narrow while still returning only after the
        // mandatory non-emitting state has been acknowledged.
        try { await this.device.setGeneratorOutput(false); }
        catch (cause) { rfOffFailure = cause; }
      }
      if (touchFailure !== undefined && rfOffFailure !== undefined) {
        throw new AggregateError([touchFailure, rfOffFailure], 'TinySA touch failed and RF output-off recovery also failed');
      }
      if (touchFailure !== undefined) throw touchFailure;
      if (rfOffFailure !== undefined) throw new Error('TinySA touch completed but RF output-off recovery failed', { cause: rfOffFailure });
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
    for (const listener of [...this.#listeners]) {
      try { listener(structuredClone(event)); } catch { /* Consumer isolation. */ }
    }
  }
}

function tinySaSessionProvenance(
  candidate: InstrumentCandidate,
  identity: NonNullable<DeviceSnapshot['identity']>,
  verifiedAt: string,
): InstrumentSessionProvenance {
  if (!deviceIdentitySchema.safeParse(identity).success) {
    throw new Error('TinySA device service returned a contradictory device identity');
  }
  const identityPortResult = portCandidateSchema.safeParse(identity.port);
  if (!identityPortResult.success) {
    throw new Error('TinySA device identity contains invalid port provenance');
  }
  const identityPort = identityPortResult.data;
  if (candidate.sourceKind === 'serial-port') {
    if (identity.execution !== 'physical'
      || !sameDescriptor(candidate, descriptorFor(identityPort))
      || identityPort.usbMatch !== 'exact-zs407-cdc'
      || identityPort.vendorId?.toLowerCase() !== '0483'
      || identityPort.productId?.toLowerCase() !== '5740') {
      throw new Error('TinySA physical identity does not match the admitted serial candidate');
    }
    if (identity.firmwareQualification !== 'supported-oem'
      && identity.firmwareQualification !== 'custom-unqualified') {
      throw new Error(`TinySA physical identity has invalid firmware qualification ${identity.firmwareQualification}`);
    }
    if (!identity.usbIdentityVerified) {
      throw new Error('TinySA physical session requires verified ZS407 USB identity');
    }
    if (!identity.firmwareReportedRevision) {
      throw new Error('TinySA physical identity is missing its reported firmware revision');
    }
    if (!isZs407FirmwareVersionRevisionPair(identity.firmwareVersion, identity.firmwareReportedRevision)) {
      throw new Error('TinySA physical identity has contradictory firmware version and reported revision');
    }
    if (identity.firmwareQualification === 'supported-oem') {
      if (!identity.firmwareSourceCommit
        || !isSupportedZs407FirmwareIdentity(identity.firmwareVersion, identity.firmwareReportedRevision, identity.firmwareSourceCommit)
        || identity.firmwareWarning !== undefined) {
        throw new Error('TinySA supported OEM identity has contradictory firmware provenance');
      }
    } else if (identity.firmwareSourceCommit !== undefined
      || !identity.firmwareWarning
      || !identity.firmwareWarning.toLowerCase().includes(identity.firmwareReportedRevision.toLowerCase())) {
      throw new Error('TinySA custom identity has contradictory or incomplete firmware provenance');
    }
    const device = identity.firmwareQualification === 'supported-oem'
      ? {
        model: identity.model,
        hardwareVersion: identity.hardwareVersion,
        firmwareVersion: identity.firmwareVersion,
        firmwareReportedRevision: identity.firmwareReportedRevision,
        firmwareSourceCommit: identity.firmwareSourceCommit!,
        firmwareQualification: 'supported-oem' as const,
        usbIdentityVerified: true as const,
      }
      : {
        model: identity.model,
        hardwareVersion: identity.hardwareVersion,
        firmwareVersion: identity.firmwareVersion,
        firmwareReportedRevision: identity.firmwareReportedRevision,
        firmwareQualification: 'custom-unqualified' as const,
        firmwareWarning: identity.firmwareWarning!,
        usbIdentityVerified: true as const,
      };
    return {
      sourceKind: 'serial-port',
      execution: 'physical',
      transport: 'usb-cdc-acm',
      qualification: 'device-observed',
      verifiedAt,
      serialPort: candidate.serialPort,
      device,
    };
  }
  if (candidate.sourceKind === 'tinysa-firmware-twin') {
    if (identity.execution !== 'firmware-digital-twin'
      || !sameDescriptor(candidate, descriptorFor(identityPort))
      || !identity.digitalTwin
      || !identityPort.digitalTwin
      || !sameDigitalTwinProvenance(identity.digitalTwin, identityPort.digitalTwin)) {
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

function sameDigitalTwinProvenance(
  left: NonNullable<PortCandidate['digitalTwin']>,
  right: NonNullable<PortCandidate['digitalTwin']>,
): boolean {
  return left.contractVersion === right.contractVersion
    && left.bridge === right.bridge
    && left.firmwareRelease === right.firmwareRelease
    && left.repositoryCommit === right.repositoryCommit
    && left.firmwareBinarySha256 === right.firmwareBinarySha256
    && left.usbTransactionsModeled === right.usbTransactionsModeled
    && left.bootEvidence === right.bootEvidence;
}

function deviceAcquisitionIdentityMatches(
  admitted: DeviceIdentity,
  observed: Sweep['identity'] | ZeroSpanCapture['identity'],
): boolean {
  if ('kind' in observed) return false;
  const admittedResult = deviceIdentitySchema.safeParse(admitted);
  const observedResult = deviceIdentitySchema.safeParse(observed);
  if (!admittedResult.success || !observedResult.success) return false;
  return JSON.stringify(admittedResult.data) === JSON.stringify(observedResult.data);
}

function assertSweptAcquisitionEvidence(
  configuration: SweptSpectrumConfiguration,
  sweep: Sweep,
): void {
  if (!isDeepStrictEqual(sweep.requested, configuration)) {
    throw new Error('TinySA swept-spectrum acquisition requested controls do not match the admitted configuration');
  }
  if (sweep.actualStartHz !== configuration.startHz
    || sweep.actualStopHz !== configuration.stopHz
    || sweep.frequencyHz.length !== configuration.points
    || sweep.powerDbm.length !== configuration.points) {
    throw new Error('TinySA swept-spectrum acquisition geometry does not match the admitted configuration');
  }
  if (configuration.controls.model === 'receiver') {
    if (typeof configuration.controls.resolutionBandwidthKhz === 'number'
      && sweep.actualRbwHz !== configuration.controls.resolutionBandwidthKhz * 1_000) {
      throw new Error('TinySA swept-spectrum acquisition RBW does not match the admitted manual control');
    }
    if (typeof configuration.controls.attenuationDb === 'number'
      && sweep.actualAttenuationDb !== configuration.controls.attenuationDb) {
      throw new Error('TinySA swept-spectrum acquisition attenuation does not match the admitted manual control');
    }
  }
}

function assertDetectedPowerAcquisitionEvidence(
  configuration: DetectedPowerTimeseriesConfiguration,
  capture: ZeroSpanCapture,
): void {
  if (!isDeepStrictEqual(capture.requested, configuration)) {
    throw new Error('TinySA detected-power acquisition requested controls do not match the admitted configuration');
  }
  if (capture.frequencyHz !== configuration.centerHz
    || capture.powerDbm.length !== configuration.sampleCount) {
    throw new Error('TinySA detected-power acquisition geometry does not match the admitted configuration');
  }
  if (configuration.controls.model === 'receiver') {
    if (typeof configuration.controls.resolutionBandwidthKhz === 'number'
      && capture.actualRbwHz !== configuration.controls.resolutionBandwidthKhz * 1_000) {
      throw new Error('TinySA detected-power acquisition RBW does not match the admitted manual control');
    }
    if (typeof configuration.controls.attenuationDb === 'number'
      && capture.actualAttenuationDb !== configuration.controls.attenuationDb) {
      throw new Error('TinySA detected-power acquisition attenuation does not match the admitted manual control');
    }
  }
}

function tinySaCapabilities(device: DeviceCapabilities): InstrumentCapabilities {
  const scalar = device.scalarReceiver;
  const acquisitions: InstrumentCapabilities['acquisitions'][number][] = [];
  if (scalar.sweptSpectrum && device.analyzerFrequency.max > device.analyzerFrequency.min) {
    acquisitions.push({
      kind: 'swept-spectrum',
      frequencyHz: numericRange(device.analyzerFrequency),
      points: numericRange(device.sweepPoints),
      sweepTimeSeconds: {
        automatic: scalar.sweepTimeAutomatic,
        manualSeconds: numericRange(device.sweepSeconds),
      },
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormats: scalar.acquisitionFormats,
        resolutionBandwidthKhz: {
          automatic: scalar.resolutionBandwidthAutomatic,
          manual: numericRange(device.rbwKhz),
        },
        attenuationDb: {
          automatic: scalar.attenuationAutomatic,
          manual: numericRange(device.attenuationDb),
        },
        detectors: scalar.detectors,
        spurRejection: scalar.spurRejection,
        lowNoiseAmplifier: scalar.lowNoiseAmplifier,
        avoidSpurs: scalar.avoidSpurs,
        triggerModes: scalar.triggerModes,
        ...(scalar.triggerLevelDbm ? { triggerLevelDbm: numericRange(scalar.triggerLevelDbm) } : {}),
      },
      powerUnit: 'dBm',
    });
  }
  if (scalar.detectedPower) {
    acquisitions.push({
      kind: 'detected-power-timeseries',
      centerFrequencyHz: numericRange(device.analyzerFrequency),
      sampleCount: numericRange(device.sweepPoints),
      sweepTimeSeconds: {
        automatic: false,
        manualSeconds: numericRange(device.sweepSeconds),
      },
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        resolutionBandwidthKhz: {
          automatic: scalar.resolutionBandwidthAutomatic,
          manual: numericRange(device.rbwKhz),
        },
        attenuationDb: {
          automatic: scalar.attenuationAutomatic,
          manual: numericRange(device.attenuationDb),
        },
        triggerModes: scalar.triggerModes,
        ...(scalar.triggerLevelDbm ? { triggerLevelDbm: numericRange(scalar.triggerLevelDbm) } : {}),
      },
      powerUnit: 'dBm',
      timing: 'uniform',
    });
  }

  const features: InstrumentCapabilities['features'][number][] = [];
  if (device.generatorFrequency && device.generatorFundamentalMaximumHz !== undefined
    && device.generatorLevel && device.modulation.includes('off')) {
    features.push({
      kind: 'rf-generator',
      paths: [
        {
          path: 'normal',
          frequencyHz: { min: device.generatorFrequency.min, max: device.generatorFundamentalMaximumHz },
        },
        { path: 'mixer', frequencyHz: numericRange(device.generatorFrequency) },
      ],
      levelDbm: numericRange(device.generatorLevel),
      modulation: {
        off: true,
        ...(device.modulation.includes('am') ? {
          am: {
            modulationFrequencyHz: { min: 1, max: 10_000, step: 1 },
            depthPercent: { min: 0, max: 100, step: 1 },
          },
        } : {}),
        ...(device.modulation.includes('fm') ? {
          fm: {
            modulationFrequencyHz: { min: 1, max: 3_500, step: 1 },
            deviationHz: { min: 1_000, max: 300_000, step: 1 },
          },
        } : {}),
      },
    });
  }
  if (device.screenCapture) {
    features.push({ kind: 'screen', width: device.screen.width, height: device.screen.height, pixelFormat: device.screen.format });
  }
  if (device.remoteTouch) features.push({ kind: 'touch', width: device.screen.width, height: device.screen.height });
  if (device.rawSweepOffsetReadback) features.push({ kind: 'diagnostics', reports: ['identity', 'health', 'configuration'] });

  return instrumentCapabilitiesSchema.parse({
    schemaVersion: 1,
    acquisitions,
    features,
  });
}

function numericRange(range: { min: number; max: number; step?: number }): { min: number; max: number; step?: number } {
  return { min: range.min, max: range.max, ...(range.step === undefined ? {} : { step: range.step }) };
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
