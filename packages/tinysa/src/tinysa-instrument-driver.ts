import { isDeepStrictEqual } from 'node:util';
import {
  deviceIdentitySchema,
  isSourceQualifiedZs407CustomReceiverFirmwareIdentity,
  isSupportedZs407FirmwareIdentity,
  isZs407FirmwareVersionRevisionPair,
  canonicalInstrumentSurfaceSchema,
  canonicalOperationParameterIntentsFor,
  canonicalOperationRequestSchema,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentConfigurationCapabilityBindingIssues,
  instrumentConfigurationCommandSchema,
  detectedPowerTimeseriesConfigurationSchema,
  instrumentFeatureCommandSchema,
  instrumentMeasurementSchema,
  instrumentReceiveOnlySafetyStateSchema,
  instrumentSessionEventSchema,
  portCandidateSchema,
  sweptSpectrumConfigurationSchema,
  type AnalyzerConfig,
  type CanonicalInstrumentSurface,
  type CanonicalInstrumentPresentation,
  type CanonicalOperationRequest,
  type CanonicalParameter,
  type CanonicalParameterIntent,
  type CanonicalParameterVerification,
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
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentReceiveOnlySafetyState,
  type ReceiveOnlySafetyReceipt,
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
import {
  canonicalBooleanParameter,
  canonicalEnumParameter,
  canonicalNumericParameter,
  canonicalOperationDefinition,
  canonicalRange,
  effectiveEnum,
  effectiveNumber,
  humanizeCanonicalOption,
  maximumReachableRangeValue,
  requiredCanonicalIntent as requireCanonicalIntent,
  resolveCanonicalEnumIntent as resolveCanonicalEnumIntentShared,
  resolveCanonicalNumberIntent as resolveCanonicalNumberIntentShared,
  resolveCanonicalRangedNumberIntent as resolveCanonicalRangedNumberIntentShared,
  type CanonicalEffective,
  type CanonicalNumericRange as NumericRange,
  type CanonicalOperationResolution,
  type InstrumentDriver,
  type InstrumentSession,
} from '@tinysa/instrument-runtime';
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
  setGeneratorOutput(enabled: boolean, outputOffReason?: ReceiveOnlySafetyReceipt['reason']): Promise<DeviceSnapshot>;
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
    const receiveOnlySafety = rfOutput === 'not-supported' && provenance.sourceKind === 'serial-port'
      ? requireReceiveOnlySafetyState(snapshot.receiveOnlySafety, snapshot.sessionId)
      : undefined;
    return new TinySaInstrumentSession(
      this.device,
      candidate,
      snapshot.sessionId,
      provenance,
      snapshot.identity,
      capabilities,
      rfOutput,
      receiveOnlySafety !== undefined,
      snapshot.generator?.commanded,
    );
  }
}

class TinySaInstrumentSession implements InstrumentSession {
  readonly driverId = TINYSA_ZS407_DRIVER_ID;
  readonly capabilities: InstrumentCapabilities;
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  readonly #unsubscribe: () => void;
  #configuration: InstrumentConfigurationCommand | undefined;
  #sourceConfiguration: GeneratorConfig | undefined;
  #sourceConfigurationIntents = new Map<string, CanonicalParameterIntent>();
  #sourceOutputIntent: CanonicalParameterIntent = { mode: 'auto' };
  #sourceOutputEnabled = false;
  #pendingCanonicalSourceOperation: PendingCanonicalSourceOperation | undefined;
  #canonicalSurfaceEpoch = 0;
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
    private readonly receiveOnlySafetyEnabled: boolean,
    initialSourceConfiguration?: GeneratorConfig,
  ) {
    this.capabilities = capabilities;
    this.#sourceConfiguration = initialSourceConfiguration;
    if (initialSourceConfiguration) this.#sourceConfigurationIntents = canonicalSourceConfigurationIntents(initialSourceConfiguration);
    this.#sourceOutputEnabled = rfOutput === 'on';
    this.#unsubscribe = device.subscribe((event) => this.#forwardDeviceEvent(event));
  }

  get receiveOnlySafety(): InstrumentReceiveOnlySafetyState | undefined {
    if (!this.receiveOnlySafetyEnabled) return undefined;
    return requireReceiveOnlySafetyState(this.device.snapshot().receiveOnlySafety, this.sessionId);
  }

  /** Driver-declared acquisition and source controls, with every Auto policy resolved here. */
  get canonicalSurface(): CanonicalInstrumentSurface | undefined {
    const receiver = receiverSweepCapability(this.capabilities);
    const power = receiverPowerCapability(this.capabilities);
    const source = rfGeneratorCapability(this.capabilities);
    if (!receiver && !power && !source) return undefined;
    const revision = `canonical:instrument:${this.#canonicalSurfaceEpoch}`;
    const presentation = canonicalReceiverSweepPresentation({
      candidate: this.candidate,
      provenance: this.provenance,
      identity: this.admittedDeviceIdentity,
      rfOutput: this.rfOutput,
      receiveOnlySafetyEnabled: this.receiveOnlySafetyEnabled,
    });
    const receiverSurface = receiver
      ? canonicalReceiverSweepControls({
          capability: receiver,
          configuration: this.#configuration,
          unavailable: this.#closed,
        })
      : undefined;
    const powerControls = power
      ? canonicalReceiverPowerControls({
          capability: power,
          configuration: this.#configuration,
          unavailable: this.#closed,
        })
      : undefined;
    const sourceControls = source
      ? canonicalSourceControls({
          capability: source,
          configuration: this.#sourceConfiguration,
          configurationIntents: this.#sourceConfigurationIntents,
          outputIntent: this.#sourceOutputIntent,
          outputEnabled: this.#sourceOutputEnabled,
          unavailable: this.#closed,
        })
      : undefined;
    return canonicalInstrumentSurfaceSchema.parse({
      schemaVersion: 1,
      revision,
      presentation,
      parameters: [
        ...(receiverSurface?.parameters ?? []),
        ...(powerControls?.parameters ?? []),
        ...(sourceControls?.parameters ?? []),
      ],
      operations: [
        ...(receiverSurface?.operations ?? []),
        ...(powerControls?.operations ?? []),
        ...(sourceControls?.operations ?? []),
      ],
    });
  }

  async resolveCanonicalOperation(requestValue: CanonicalOperationRequest): Promise<CanonicalOperationResolution> {
    this.#requireOpen();
    const request = canonicalOperationRequestSchema.parse(requestValue);
    this.#requireSession(request.sessionId);
    const surface = this.canonicalSurface;
    if (!surface) throw new Error('TinySA session does not advertise a canonical operation surface');
    if (request.operationId === CANONICAL_RECEIVER_SWEEP_OPERATION_ID) {
      const capability = receiverSweepCapability(this.capabilities);
      if (!capability) throw new Error('TinySA session does not advertise a canonical receiver sweep operation');
      const intents = canonicalOperationParameterIntentsFor(surface, CANONICAL_RECEIVER_SWEEP_OPERATION_ID, request);
      return {
        configuration: resolveCanonicalReceiverSweepConfiguration(
          this.capabilities,
          capability,
          currentReceiverSweepConfiguration(this.#configuration),
          intents,
        ),
      };
    }
    if (request.operationId === CANONICAL_RECEIVER_POWER_OPERATION_ID) {
      const capability = receiverPowerCapability(this.capabilities);
      if (!capability) throw new Error('TinySA session does not advertise a canonical power observation operation');
      const intents = canonicalOperationParameterIntentsFor(surface, CANONICAL_RECEIVER_POWER_OPERATION_ID, request);
      return {
        configuration: resolveCanonicalReceiverPowerConfiguration(
          this.capabilities,
          capability,
          currentReceiverPowerConfiguration(this.#configuration),
          intents,
        ),
      };
    }
    const source = rfGeneratorCapability(this.capabilities);
    if (!source) throw new Error(`TinySA session does not advertise canonical operation ${request.operationId}`);
    const operationId = request.operationId;
    if (operationId !== CANONICAL_SOURCE_CONFIGURATION_OPERATION_ID && operationId !== CANONICAL_SOURCE_OUTPUT_OPERATION_ID) {
      throw new Error(`TinySA session does not advertise canonical operation ${operationId}`);
    }
    const intents = canonicalOperationParameterIntentsFor(surface, operationId, request);
    const feature = operationId === CANONICAL_SOURCE_CONFIGURATION_OPERATION_ID
      ? resolveCanonicalSourceConfiguration(source, this.#sourceConfiguration, intents)
      : resolveCanonicalSourceOutput(intents);
    this.#pendingCanonicalSourceOperation = { operationId, feature, intents: new Map(intents) };
    return { feature };
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
    // A multi-command device transition is not atomic at the shell. Revoke the
    // prior binding before dispatch so a partial failure can never be followed
    // by acquisition under the old generic configuration revision.
    this.#clearConfiguration();
    if (command.configuration.kind === 'swept-spectrum') {
      await this.device.configureAnalyzer(tinySaAnalyzerConfiguration(command.configuration));
    } else if (command.configuration.kind === 'detected-power-timeseries') {
      await this.device.configureZeroSpan(tinySaDetectedPowerConfiguration(command.configuration));
    } else if (command.configuration.kind === 'complex-iq') {
      throw new Error('TinySA ZS407 does not support complex-I/Q acquisition');
    }
    this.#configuration = command;
    this.#canonicalSurfaceEpoch++;
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    const command = this.#configuration;
    if (!command) throw new Error('TinySA instrument session is not configured');
    const receiveOnlySafetyBefore = this.receiveOnlySafety;
    if (this.rfOutput === 'not-supported') {
      // A reduced custom firmware can safely omit generator configuration
      // from its public capabilities while the mandatory output-off command
      // still protects every acquisition at the device boundary.
      await this.device.setGeneratorOutput(false, 'pre-acquisition');
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
      const receiveOnlySafetyReceipt = this.#bindAcquisitionSafetyReceipt(
        sweep.receiveOnlySafetyReceipt,
        receiveOnlySafetyBefore,
      );
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
        ...(receiveOnlySafetyReceipt ? { receiveOnlySafetyReceipt } : {}),
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
      const receiveOnlySafetyReceipt = this.#bindAcquisitionSafetyReceipt(
        capture.receiveOnlySafetyReceipt,
        receiveOnlySafetyBefore,
      );
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
        ...(receiveOnlySafetyReceipt ? { receiveOnlySafetyReceipt } : {}),
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
      this.#requireFeature('rf-generator');
      if (command.action === 'configure') {
        this.#clearConfiguration();
        const configuration = defaultGeneratorConfiguration(command);
        try {
          await this.device.configureGenerator(configuration);
        } catch (error) {
          this.#discardPendingCanonicalSourceOperation(command);
          throw error;
        }
        this.#sourceConfiguration = configuration;
        this.#commitCanonicalSourceOperation(command);
        this.#canonicalSurfaceEpoch++;
        return { ...command };
      }
      try {
        await this.device.setGeneratorOutput(command.enabled);
      } catch (error) {
        this.#discardPendingCanonicalSourceOperation(command);
        throw error;
      }
      this.#sourceOutputEnabled = command.enabled;
      this.#commitCanonicalSourceOperation(command);
      this.#canonicalSurfaceEpoch++;
      return { ...command };
    }
    if (command.kind === 'screen') {
      this.#requireFeature('screen');
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
      this.#requireFeature('touch');
      this.#clearConfiguration();
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
        try { await this.device.setGeneratorOutput(false, 'post-interaction-recovery'); }
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
      this.#requireFeature('diagnostics');
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

  #bindAcquisitionSafetyReceipt(
    value: ReceiveOnlySafetyReceipt | undefined,
    before: InstrumentReceiveOnlySafetyState | undefined,
  ): ReceiveOnlySafetyReceipt | undefined {
    if (!this.receiveOnlySafetyEnabled) {
      if (value !== undefined && this.provenance.sourceKind !== 'serial-port') {
        throw new Error('Non-physical TinySA acquisition fabricated a receive-only safety receipt');
      }
      return undefined;
    }
    if (!before) throw new Error('TinySA receive-only session lost its pre-acquisition safety state');
    const current = this.receiveOnlySafety;
    if (!current || !value) throw new Error('TinySA physical acquisition omitted its receive-only safety receipt');
    if (value.reason !== 'pre-acquisition' || value.sessionId !== this.sessionId) {
      throw new Error('TinySA physical acquisition returned a wrong-session or wrong-reason safety receipt');
    }
    if (value.sequence <= before.currentReceipt.sequence) {
      throw new Error('TinySA physical acquisition returned a stale safety receipt');
    }
    if (!isDeepStrictEqual(value, current.currentReceipt)) {
      throw new Error('TinySA physical acquisition receipt does not match the current device acknowledgement');
    }
    return structuredClone(value);
  }

  #requireOpen(): void { if (this.#closed) throw new Error('TinySA instrument session is closed'); }
  #clearConfiguration(): void {
    this.#configuration = undefined;
    this.#canonicalSurfaceEpoch++;
  }
  #commitCanonicalSourceOperation(command: InstrumentFeatureCommand): void {
    const pending = this.#pendingCanonicalSourceOperation;
    if (!pending || !sameFeatureRequest(pending.feature, command)) {
      if (command.kind === 'rf-generator') {
        if (command.action === 'configure') this.#sourceConfigurationIntents = canonicalSourceConfigurationIntents(defaultGeneratorConfiguration(command));
        else this.#sourceOutputIntent = command.enabled ? { mode: 'manual', value: true } : { mode: 'auto' };
      }
      return;
    }
    this.#pendingCanonicalSourceOperation = undefined;
    if (pending.operationId === CANONICAL_SOURCE_CONFIGURATION_OPERATION_ID) {
      this.#sourceConfigurationIntents = new Map(pending.intents);
    } else {
      this.#sourceOutputIntent = pending.intents.get(CANONICAL_SOURCE_PARAMETER_IDS.output) ?? { mode: 'auto' };
    }
  }
  #discardPendingCanonicalSourceOperation(command: InstrumentFeatureCommand): void {
    if (this.#pendingCanonicalSourceOperation && sameFeatureRequest(this.#pendingCanonicalSourceOperation.feature, command)) {
      this.#pendingCanonicalSourceOperation = undefined;
    }
  }
  #requireSession(sessionId: string): void {
    if (sessionId !== this.sessionId) throw new Error('TinySA command session ID does not match the active session');
  }
  #requireFeature(kind: 'rf-generator' | 'screen' | 'touch' | 'diagnostics'): void {
    if (!this.capabilities.features.some((feature) => feature.kind === kind)) {
      throw new Error(`TinySA session does not advertise the ${kind} feature`);
    }
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

const CANONICAL_RECEIVER_SWEEP_OPERATION_ID = 'receiver.sweep';
const CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS = {
  startHz: 'receiver.sweep.start-hz',
  stopHz: 'receiver.sweep.stop-hz',
  points: 'receiver.sweep.points',
  sweepTimeSeconds: 'receiver.sweep.time-seconds',
  acquisitionFormat: 'receiver.sweep.data-format',
  resolutionBandwidthKhz: 'receiver.sweep.resolution-bandwidth-khz',
  attenuationDb: 'receiver.sweep.attenuation-db',
  detector: 'receiver.sweep.detector',
  spurRejection: 'receiver.sweep.spur-rejection',
  lowNoiseAmplifier: 'receiver.sweep.low-noise-amplifier',
  avoidSpurs: 'receiver.sweep.avoid-spurs',
  triggerMode: 'receiver.sweep.trigger-mode',
  triggerLevelDbm: 'receiver.sweep.trigger-level-dbm',
} as const;
const CANONICAL_RECEIVER_POWER_OPERATION_ID = 'receiver.power';
const CANONICAL_RECEIVER_POWER_PARAMETER_IDS = {
  centerHz: 'receiver.power.center-hz',
  sampleCount: 'receiver.power.samples',
  sweepTimeSeconds: 'receiver.power.time-seconds',
  resolutionBandwidthKhz: 'receiver.power.resolution-bandwidth-khz',
  attenuationDb: 'receiver.power.attenuation-db',
  triggerMode: 'receiver.power.trigger-mode',
  triggerLevelDbm: 'receiver.power.trigger-level-dbm',
} as const;
const CANONICAL_SOURCE_CONFIGURATION_OPERATION_ID = 'source.configure';
const CANONICAL_SOURCE_OUTPUT_OPERATION_ID = 'source.set-output';
const CANONICAL_SOURCE_PARAMETER_IDS = {
  frequencyHz: 'source.frequency',
  levelDbm: 'source.level',
  path: 'source.path',
  modulation: 'source.modulation',
  modulationFrequencyHz: 'source.modulation-rate',
  amDepthPercent: 'source.am-depth',
  fmDeviationHz: 'source.fm-deviation',
  output: 'source.output',
} as const;
const TINYSA_CANONICAL_INTENT_CONTEXT = 'Canonical receiver sweep';
type SweptSpectrumCapability = Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'swept-spectrum' }>;
type ReceiverSweepCapability = SweptSpectrumCapability & {
  readonly controls: Extract<SweptSpectrumCapability['controls'], { model: 'receiver' }>;
};
type DetectedPowerCapability = Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'detected-power-timeseries' }>;
type ReceiverPowerCapability = DetectedPowerCapability & {
  readonly controls: Extract<DetectedPowerCapability['controls'], { model: 'receiver' }>;
};
type RfGeneratorCapability = Extract<InstrumentCapabilities['features'][number], { kind: 'rf-generator' }>;
interface PendingCanonicalSourceOperation {
  readonly operationId: string;
  readonly feature: InstrumentFeatureRequest;
  readonly intents: ReadonlyMap<string, CanonicalParameterIntent>;
}
interface CanonicalSourceControls {
  readonly parameters: readonly CanonicalParameter[];
  readonly operations: CanonicalInstrumentSurface['operations'];
}
type CanonicalReceiverTriggerEffectiveValues = Readonly<{
  triggerMode: CanonicalEffective<'auto' | 'normal' | 'single'>;
  triggerLevelDbm?: CanonicalEffective<number>;
}>;
type CanonicalReceiverParameterIds = Readonly<{
  resolutionBandwidthKhz: string;
  attenuationDb: string;
  triggerMode: string;
  triggerLevelDbm: string;
}>;
type CanonicalReceiverControls = ReceiverSweepCapability['controls'] | ReceiverPowerCapability['controls'];
type CanonicalReceiverCurrentControls = Extract<
  SweptSpectrumConfiguration['controls'] | DetectedPowerTimeseriesConfiguration['controls'],
  { model: 'receiver' }
>;

function preferredCanonicalOption<Value extends string>(options: readonly Value[], ...preferred: readonly Value[]): Value {
  for (const value of preferred) if (options.includes(value)) return value;
  const fallback = options[0];
  if (fallback === undefined) throw new Error('Canonical receiver sweep encountered an empty enum capability');
  return fallback;
}

function requiredCanonicalIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string,
): CanonicalParameterIntent {
  return requireCanonicalIntent(intents, parameterId, TINYSA_CANONICAL_INTENT_CONTEXT);
}

function resolveCanonicalNumberIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string, automaticValue: number, integer = false,
): number {
  return resolveCanonicalNumberIntentShared(intents, parameterId, automaticValue, integer, TINYSA_CANONICAL_INTENT_CONTEXT);
}

function resolveCanonicalRangedNumberIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string, automaticValue: number,
  range: NumericRange, outOfRangeMessage: string, integer = false,
): number {
  return resolveCanonicalRangedNumberIntentShared(
    intents, parameterId, automaticValue, range, outOfRangeMessage, integer, TINYSA_CANONICAL_INTENT_CONTEXT,
  );
}

function resolveCanonicalEnumIntent<Value extends string>(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string,
  options: readonly Value[], automaticValue: Value,
): Value {
  return resolveCanonicalEnumIntentShared(intents, parameterId, options, automaticValue, TINYSA_CANONICAL_INTENT_CONTEXT);
}

function receiverSweepCapability(capabilities: InstrumentCapabilities): ReceiverSweepCapability | undefined {
  const sweep = capabilities.acquisitions.find(
    (candidate): candidate is SweptSpectrumCapability => candidate.kind === 'swept-spectrum',
  );
  if (!sweep || sweep.controls.model !== 'receiver') return undefined;
  return sweep as ReceiverSweepCapability;
}

function currentReceiverSweepConfiguration(
  command: InstrumentConfigurationCommand | undefined,
): SweptSpectrumConfiguration | undefined {
  if (command?.configuration.kind !== 'swept-spectrum' || command.configuration.controls.model !== 'receiver') {
    return undefined;
  }
  return command.configuration;
}

function receiverPowerCapability(capabilities: InstrumentCapabilities): ReceiverPowerCapability | undefined {
  const power = capabilities.acquisitions.find(
    (candidate): candidate is DetectedPowerCapability => candidate.kind === 'detected-power-timeseries',
  );
  if (!power || power.controls.model !== 'receiver') return undefined;
  return power as ReceiverPowerCapability;
}

function currentReceiverPowerConfiguration(
  command: InstrumentConfigurationCommand | undefined,
): DetectedPowerTimeseriesConfiguration | undefined {
  if (command?.configuration.kind !== 'detected-power-timeseries' || command.configuration.controls.model !== 'receiver') {
    return undefined;
  }
  return command.configuration;
}

function canonicalReceiverPowerControls(input: Readonly<{
  capability: ReceiverPowerCapability;
  configuration: InstrumentConfigurationCommand | undefined;
  unavailable: boolean;
}>): CanonicalSourceControls {
  const { capability } = input;
  const controls = capability.controls;
  const effective = canonicalReceiverPowerEffectiveValues(
    capability,
    currentReceiverPowerConfiguration(input.configuration),
  );
  const parameters: CanonicalParameter[] = [
    canonicalNumericParameter('integer', CANONICAL_RECEIVER_POWER_PARAMETER_IDS.centerHz, 'Center frequency', 'Power observation', 'Hz', capability.centerFrequencyHz, effective.centerHz),
    canonicalNumericParameter('integer', CANONICAL_RECEIVER_POWER_PARAMETER_IDS.sampleCount, 'Samples', 'Power observation', 'samples', capability.sampleCount, effective.sampleCount),
    canonicalNumericParameter('number', CANONICAL_RECEIVER_POWER_PARAMETER_IDS.sweepTimeSeconds, 'Duration', 'Power observation', 'seconds', capability.sweepTimeSeconds.manualSeconds, effective.sweepTimeSeconds),
  ];
  appendCanonicalReceiverControlParameters(parameters, CANONICAL_RECEIVER_POWER_PARAMETER_IDS, controls, effective);
  return {
    parameters,
    operations: [canonicalOperationDefinition({
      id: CANONICAL_RECEIVER_POWER_OPERATION_ID,
      label: 'Observe power',
      description: 'Configure one bounded receiver power time series.',
      scope: 'acquisition',
      acquisitionKind: 'detected-power-timeseries',
      parameters,
      outputs: ['Power time series'],
      unavailable: input.unavailable,
    })],
  };
}

function canonicalReceiverPowerEffectiveValues(
  capability: ReceiverPowerCapability,
  current: DetectedPowerTimeseriesConfiguration | undefined,
) {
  const controls = capability.controls;
  const currentControls = current?.controls.model === 'receiver' ? current.controls : undefined;
  return {
    centerHz: effectiveNumber(current?.centerHz, capability.centerFrequencyHz, capability.centerFrequencyHz.min),
    sampleCount: effectiveNumber(current?.sampleCount, capability.sampleCount, capability.sampleCount.min),
    sweepTimeSeconds: effectiveNumber(
      typeof current?.sweepTimeSeconds === 'number' ? current.sweepTimeSeconds : undefined,
      capability.sweepTimeSeconds.manualSeconds,
      capability.sweepTimeSeconds.manualSeconds.min,
    ),
    ...canonicalReceiverCommonEffectiveValues(controls, currentControls),
  };
}

function resolveCanonicalReceiverPowerConfiguration(
  capabilities: InstrumentCapabilities,
  capability: ReceiverPowerCapability,
  current: DetectedPowerTimeseriesConfiguration | undefined,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): DetectedPowerTimeseriesConfiguration {
  const effective = canonicalReceiverPowerEffectiveValues(capability, current);
  const controls = capability.controls;
  const centerHz = resolveCanonicalNumberIntent(intents, CANONICAL_RECEIVER_POWER_PARAMETER_IDS.centerHz, effective.centerHz.value, true);
  const sampleCount = resolveCanonicalNumberIntent(intents, CANONICAL_RECEIVER_POWER_PARAMETER_IDS.sampleCount, effective.sampleCount.value, true);
  const sweepTimeSeconds = resolveCanonicalNumberIntent(
    intents,
    CANONICAL_RECEIVER_POWER_PARAMETER_IDS.sweepTimeSeconds,
    effective.sweepTimeSeconds.value,
  );
  const receiverControls = resolveCanonicalReceiverControls(
    intents, CANONICAL_RECEIVER_POWER_PARAMETER_IDS, controls, effective,
  );
  const configuration = detectedPowerTimeseriesConfigurationSchema.parse({
    kind: 'detected-power-timeseries',
    centerHz,
    sampleCount,
    sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      ...receiverControls,
    },
  });
  assertCanonicalConfigurationWithinCapability(configuration, capabilities, 'receiver power observation');
  return configuration;
}

function rfGeneratorCapability(capabilities: InstrumentCapabilities): RfGeneratorCapability | undefined {
  return capabilities.features.find(
    (candidate): candidate is RfGeneratorCapability => candidate.kind === 'rf-generator',
  );
}

/**
 * Generic source contribution. The native feature protocol remains private to
 * this driver; Atomizer receives only source controls and Auto/manual intents.
 */
function canonicalSourceControls(input: Readonly<{
  capability: RfGeneratorCapability;
  configuration: GeneratorConfig | undefined;
  configurationIntents: ReadonlyMap<string, CanonicalParameterIntent>;
  outputIntent: CanonicalParameterIntent;
  outputEnabled: boolean;
  unavailable: boolean;
}>): CanonicalSourceControls {
  const { capability, configuration, configurationIntents } = input;
  const automatic = automaticSourceConfiguration(capability);
  const effective = configuration ?? automatic;
  const verification: CanonicalParameterVerification = configuration ? 'driver-commanded' : 'driver-selected';
  const frequencyRange = sourceFrequencyRange(capability);
  const modulationOptions = sourceModulationOptions(capability);
  const parameters: CanonicalParameter[] = [
    canonicalNumericParameter('integer',
      CANONICAL_SOURCE_PARAMETER_IDS.frequencyHz, 'Frequency', 'Source', 'Hz', frequencyRange,
      { value: effective.frequencyHz, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.frequencyHz),
    ),
    canonicalNumericParameter('number',
      CANONICAL_SOURCE_PARAMETER_IDS.levelDbm, 'Level', 'Source', 'dBm', capability.levelDbm,
      { value: effective.levelDbm, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.levelDbm),
    ),
    canonicalEnumParameter(
      CANONICAL_SOURCE_PARAMETER_IDS.path, 'Frequency range', 'Source', capability.paths.map((path) => path.path),
      { value: effective.path, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.path),
    ),
    canonicalEnumParameter(
      CANONICAL_SOURCE_PARAMETER_IDS.modulation, 'Modulation', 'Source', modulationOptions,
      { value: effective.modulation, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.modulation),
    ),
  ];
  const modulationRate = sourceModulationRateRange(capability);
  if (modulationRate) {
    parameters.push(canonicalNumericParameter('integer',
      CANONICAL_SOURCE_PARAMETER_IDS.modulationFrequencyHz, 'Modulation rate', 'Source', 'Hz', modulationRate,
      { value: effective.modulationFrequencyHz, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.modulationFrequencyHz),
    ));
  }
  if (capability.modulation.am) {
    parameters.push(canonicalNumericParameter('integer',
      CANONICAL_SOURCE_PARAMETER_IDS.amDepthPercent, 'AM depth', 'Source', '%', capability.modulation.am.depthPercent,
      { value: effective.amDepthPercent, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.amDepthPercent),
    ));
  }
  if (capability.modulation.fm) {
    parameters.push(canonicalNumericParameter('integer',
      CANONICAL_SOURCE_PARAMETER_IDS.fmDeviationHz, 'FM deviation', 'Source', 'Hz', capability.modulation.fm.deviationHz,
      { value: effective.fmDeviationHz, verification }, sourceIntent(configurationIntents, CANONICAL_SOURCE_PARAMETER_IDS.fmDeviationHz),
    ));
  }
  const output = canonicalBooleanParameter(
    CANONICAL_SOURCE_PARAMETER_IDS.output, 'Output', 'Source',
    {
      value: input.outputEnabled,
      verification: input.outputIntent.mode === 'manual' ? 'driver-commanded' : 'driver-selected',
    },
    input.outputIntent,
  );
  return {
    parameters: [...parameters, output],
    operations: [
      canonicalOperationDefinition({
        id: CANONICAL_SOURCE_CONFIGURATION_OPERATION_ID,
        label: 'Configure source',
        description: 'Set the driver-declared signal definition. Output remains off after configuration.',
        scope: 'source',
        parameters,
        outputs: ['Configured source'],
        unavailable: input.unavailable,
      }),
      canonicalOperationDefinition({
        id: CANONICAL_SOURCE_OUTPUT_OPERATION_ID,
        label: 'Set source output',
        description: 'Set the connected source output state using the driver-declared safety path.',
        scope: 'source',
        parameters: [output],
        outputs: ['Source output state'],
        unavailable: input.unavailable,
        confirmation: 'high-impact',
      }),
    ],
  };
}

function automaticSourceConfiguration(capability: RfGeneratorCapability): GeneratorConfig {
  const path = preferredCanonicalOption(capability.paths.map((candidate) => candidate.path), 'normal', 'mixer');
  const frequencyHz = sourceFrequencyRangeForPath(capability, path).min;
  const modulationFrequencyHz = sourceModulationRateRange(capability)?.min ?? 1_000;
  return {
    frequencyHz,
    levelDbm: capability.levelDbm.min,
    path,
    modulation: 'off',
    modulationFrequencyHz,
    amDepthPercent: capability.modulation.am?.depthPercent.min ?? 0,
    fmDeviationHz: capability.modulation.fm?.deviationHz.min ?? 1_000,
  };
}

function sourceFrequencyRange(capability: RfGeneratorCapability): NumericRange {
  return {
    min: Math.min(...capability.paths.map((path) => path.frequencyHz.min)),
    max: Math.max(...capability.paths.map((path) => path.frequencyHz.max)),
    step: 1,
  };
}

function sourceFrequencyRangeForPath(
  capability: RfGeneratorCapability,
  path: GeneratorConfig['path'],
): NumericRange {
  const value = capability.paths.find((candidate) => candidate.path === path)?.frequencyHz;
  if (!value) throw new RangeError(`Source frequency range ${path} is not advertised`);
  return value;
}

function sourceModulationOptions(capability: RfGeneratorCapability): readonly GeneratorConfig['modulation'][] {
  return [
    'off',
    ...(capability.modulation.am ? ['am' as const] : []),
    ...(capability.modulation.fm ? ['fm' as const] : []),
  ];
}

function sourceModulationRateRange(capability: RfGeneratorCapability): NumericRange | undefined {
  const ranges = [capability.modulation.am?.modulationFrequencyHz, capability.modulation.fm?.modulationFrequencyHz]
    .filter((range): range is NumericRange => range !== undefined);
  if (ranges.length === 0) return undefined;
  return {
    min: Math.min(...ranges.map((range) => range.min)),
    max: Math.max(...ranges.map((range) => range.max)),
    step: 1,
  };
}

function sourceModulationRateRangeForMode(
  capability: RfGeneratorCapability,
  modulation: GeneratorConfig['modulation'],
): NumericRange | undefined {
  return modulation === 'am'
    ? capability.modulation.am?.modulationFrequencyHz
    : modulation === 'fm'
      ? capability.modulation.fm?.modulationFrequencyHz
      : sourceModulationRateRange(capability);
}

function sourceIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  parameterId: string,
): CanonicalParameterIntent {
  return intents.get(parameterId) ?? { mode: 'auto' };
}

function resolveCanonicalSourceConfiguration(
  capability: RfGeneratorCapability,
  current: GeneratorConfig | undefined,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): Extract<InstrumentFeatureRequest, { kind: 'rf-generator'; action: 'configure' }> {
  const automatic = automaticSourceConfiguration(capability);
  const path = resolveCanonicalEnumIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.path, capability.paths.map((candidate) => candidate.path), current?.path ?? automatic.path);
  const frequencyRange = sourceFrequencyRangeForPath(capability, path);
  const frequencyHz = resolveCanonicalRangedNumberIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.frequencyHz, current?.frequencyHz ?? frequencyRange.min, frequencyRange, `Source frequency is outside the selected ${path} range`, true);
  const levelDbm = resolveCanonicalRangedNumberIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.levelDbm, current?.levelDbm ?? automatic.levelDbm, capability.levelDbm, 'Source level is outside the advertised range');
  const modulation = resolveCanonicalEnumIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.modulation, sourceModulationOptions(capability), current?.modulation ?? automatic.modulation);
  const modulationRateRange = sourceModulationRateRangeForMode(capability, modulation);
  const modulationFrequencyHz = modulationRateRange
    ? resolveCanonicalRangedNumberIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.modulationFrequencyHz, current?.modulationFrequencyHz ?? modulationRateRange.min, modulationRateRange, `Source modulation rate is outside the selected ${modulation} range`, true)
    : automatic.modulationFrequencyHz;
  const amDepthPercent = capability.modulation.am
    ? resolveCanonicalRangedNumberIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.amDepthPercent, current?.amDepthPercent ?? automatic.amDepthPercent, capability.modulation.am.depthPercent, 'Source AM depth is outside the advertised range', true)
    : automatic.amDepthPercent;
  const fmDeviationHz = capability.modulation.fm
    ? resolveCanonicalRangedNumberIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.fmDeviationHz, current?.fmDeviationHz ?? automatic.fmDeviationHz, capability.modulation.fm.deviationHz, 'Source FM deviation is outside the advertised range', true)
    : automatic.fmDeviationHz;
  return {
    kind: 'rf-generator',
    action: 'configure',
    frequencyHz,
    levelDbm,
    path,
    modulation: modulation === 'off'
      ? { mode: 'off' }
      : modulation === 'am'
        ? { mode: 'am', modulationFrequencyHz, depthPercent: amDepthPercent }
        : { mode: 'fm', modulationFrequencyHz, deviationHz: fmDeviationHz },
  };
}

function resolveCanonicalSourceOutput(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): Extract<InstrumentFeatureRequest, { kind: 'rf-generator'; action: 'set-output' }> {
  const intent = requiredCanonicalIntent(intents, CANONICAL_SOURCE_PARAMETER_IDS.output);
  if (intent.mode === 'auto') return { kind: 'rf-generator', action: 'set-output', enabled: false };
  if (typeof intent.value !== 'boolean') throw new TypeError('Canonical source output requires a boolean manual value');
  return { kind: 'rf-generator', action: 'set-output', enabled: intent.value };
}

function canonicalSourceConfigurationIntents(
  configuration: GeneratorConfig,
): Map<string, CanonicalParameterIntent> {
  return new Map([
    [CANONICAL_SOURCE_PARAMETER_IDS.frequencyHz, { mode: 'manual', value: configuration.frequencyHz }],
    [CANONICAL_SOURCE_PARAMETER_IDS.levelDbm, { mode: 'manual', value: configuration.levelDbm }],
    [CANONICAL_SOURCE_PARAMETER_IDS.path, { mode: 'manual', value: configuration.path }],
    [CANONICAL_SOURCE_PARAMETER_IDS.modulation, { mode: 'manual', value: configuration.modulation }],
    [CANONICAL_SOURCE_PARAMETER_IDS.modulationFrequencyHz, { mode: 'manual', value: configuration.modulationFrequencyHz }],
    [CANONICAL_SOURCE_PARAMETER_IDS.amDepthPercent, { mode: 'manual', value: configuration.amDepthPercent }],
    [CANONICAL_SOURCE_PARAMETER_IDS.fmDeviationHz, { mode: 'manual', value: configuration.fmDeviationHz }],
  ]);
}

function sameFeatureRequest(feature: InstrumentFeatureRequest, command: InstrumentFeatureCommand): boolean {
  const { sessionId: _sessionId, ...request } = command;
  return isDeepStrictEqual(feature, request);
}

function canonicalReceiverSweepControls(input: Readonly<{
  capability: ReceiverSweepCapability;
  configuration: InstrumentConfigurationCommand | undefined;
  unavailable: boolean;
}>): CanonicalSourceControls {
  const { capability, configuration } = input;
  const controls = capability.controls;
  const effective = canonicalReceiverSweepEffectiveValues(
    capability,
    currentReceiverSweepConfiguration(configuration),
  );
  const parameters: CanonicalParameter[] = [
    canonicalNumericParameter('integer', CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.startHz, 'Start frequency', 'Sweep', 'Hz', capability.frequencyHz, effective.startHz),
    canonicalNumericParameter('integer', CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.stopHz, 'Stop frequency', 'Sweep', 'Hz', capability.frequencyHz, effective.stopHz),
    canonicalNumericParameter('integer', CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.points, 'Points', 'Sweep', 'points', capability.points, effective.points),
    canonicalNumericParameter('number', CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.sweepTimeSeconds, 'Sweep time', 'Sweep', 'seconds', capability.sweepTimeSeconds.manualSeconds, effective.sweepTimeSeconds),
    canonicalEnumParameter(CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.acquisitionFormat, 'Data format', 'Sweep', controls.acquisitionFormats, effective.acquisitionFormat),
    canonicalEnumParameter(CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.detector, 'Detector', 'Receiver', controls.detectors, effective.detector),
    canonicalEnumParameter(CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.spurRejection, 'Spur rejection', 'Receiver', controls.spurRejection, effective.spurRejection),
    canonicalEnumParameter(CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.lowNoiseAmplifier, 'Low-noise amplifier', 'Receiver', controls.lowNoiseAmplifier, effective.lowNoiseAmplifier),
    canonicalEnumParameter(CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.avoidSpurs, 'Avoid spurs', 'Receiver', controls.avoidSpurs, effective.avoidSpurs),
  ];
  appendCanonicalReceiverControlParameters(parameters, CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS, controls, effective);
  return {
    parameters,
    operations: [canonicalOperationDefinition({
      id: CANONICAL_RECEIVER_SWEEP_OPERATION_ID,
      label: 'Sweep',
      description: 'Configure the receiver and acquire one scalar spectrum.',
      scope: 'acquisition',
      acquisitionKind: 'swept-spectrum',
      parameters,
      outputs: ['Spectrum'],
      unavailable: input.unavailable,
      primary: true,
    })],
  };
}

/**
 * Driver-owned, schema-standard presentation facts.  The renderer receives
 * only the generic fact records; firmware and transport details never become
 * Atomizer branches or controls.
 */
function canonicalReceiverSweepPresentation(input: Readonly<{
  candidate: InstrumentCandidate;
  provenance: InstrumentSessionProvenance;
  identity: DeviceIdentity;
  rfOutput: 'off' | 'on' | 'unknown' | 'not-supported';
  receiveOnlySafetyEnabled: boolean;
}>): CanonicalInstrumentPresentation {
  const facts = [
    {
      label: 'Execution',
      value: input.provenance.execution === 'physical' ? 'Physical instrument' : 'Virtual instrument',
    },
    {
      label: 'Transport',
      value: humanizeCanonicalOption(input.provenance.transport),
    },
    {
      label: 'Output control',
      value: input.rfOutput === 'not-supported' ? 'Unavailable' : 'Available',
    },
    ...(input.receiveOnlySafetyEnabled ? [{
      label: 'Safety state',
      value: 'Receive-only',
      detail: 'The driver verified an output-off acknowledgement; this is not an independent RF power measurement.',
    }] : []),
    ...(input.identity.firmwareWarning ? [{
      label: 'Driver advisory',
      value: 'Compatibility notice',
      detail: input.identity.firmwareWarning,
    }] : []),
  ];
  return {
    title: input.candidate.displayName,
    subtitle: 'Connected instrument',
    qualification: humanizeCanonicalOption(input.provenance.qualification),
    facts,
  };
}

function canonicalReceiverSweepEffectiveValues(
  capability: ReceiverSweepCapability,
  current: SweptSpectrumConfiguration | undefined,
) {
  const controls = capability.controls;
  const currentControls = current?.controls.model === 'receiver' ? current.controls : undefined;
  return {
    startHz: effectiveNumber(current?.startHz, capability.frequencyHz, capability.frequencyHz.min),
    stopHz: effectiveNumber(current?.stopHz, capability.frequencyHz, maximumReachableRangeValue(capability.frequencyHz)),
    points: effectiveNumber(current?.points, capability.points, capability.points.min),
    sweepTimeSeconds: effectiveNumber(
      typeof current?.sweepTimeSeconds === 'number' ? current.sweepTimeSeconds : undefined,
      capability.sweepTimeSeconds.manualSeconds,
      capability.sweepTimeSeconds.manualSeconds.min,
    ),
    acquisitionFormat: effectiveEnum(
      currentControls?.acquisitionFormat,
      controls.acquisitionFormats,
      preferredCanonicalOption(controls.acquisitionFormats, 'raw', 'text'),
    ),
    detector: effectiveEnum(
      currentControls?.detector,
      controls.detectors,
      preferredCanonicalOption(controls.detectors, 'sample'),
    ),
    spurRejection: effectiveEnum(
      currentControls?.spurRejection,
      controls.spurRejection,
      preferredCanonicalOption(controls.spurRejection, 'auto', 'off', 'on'),
    ),
    lowNoiseAmplifier: effectiveEnum(
      currentControls?.lowNoiseAmplifier,
      controls.lowNoiseAmplifier,
      preferredCanonicalOption(controls.lowNoiseAmplifier, 'off', 'on'),
    ),
    avoidSpurs: effectiveEnum(
      currentControls?.avoidSpurs,
      controls.avoidSpurs,
      preferredCanonicalOption(controls.avoidSpurs, 'auto', 'off', 'on'),
    ),
    ...canonicalReceiverCommonEffectiveValues(controls, currentControls),
  };
}

function resolveCanonicalReceiverSweepConfiguration(
  capabilities: InstrumentCapabilities,
  capability: ReceiverSweepCapability,
  current: SweptSpectrumConfiguration | undefined,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): SweptSpectrumConfiguration {
  const effective = canonicalReceiverSweepEffectiveValues(capability, current);
  const controls = capability.controls;
  const startHz = resolveCanonicalNumberIntent(intents, CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.startHz, effective.startHz.value, true);
  const stopHz = resolveCanonicalNumberIntent(intents, CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.stopHz, effective.stopHz.value, true);
  const points = resolveCanonicalNumberIntent(intents, CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.points, effective.points.value, true);
  const sweepTimeSeconds = resolveCanonicalNumberIntent(
    intents,
    CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.sweepTimeSeconds,
    effective.sweepTimeSeconds.value,
  );
  const acquisitionFormat = resolveCanonicalEnumIntent(
    intents,
    CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.acquisitionFormat,
    controls.acquisitionFormats,
    effective.acquisitionFormat.value,
  );
  const receiverControls = resolveCanonicalReceiverControls(
    intents, CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS, controls, effective,
  );
  const detector = resolveCanonicalEnumIntent(
    intents,
    CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.detector,
    controls.detectors,
    effective.detector.value,
  );
  const spurRejection = resolveCanonicalEnumIntent(
    intents,
    CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.spurRejection,
    controls.spurRejection,
    effective.spurRejection.value,
  );
  const lowNoiseAmplifier = resolveCanonicalEnumIntent(
    intents,
    CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.lowNoiseAmplifier,
    controls.lowNoiseAmplifier,
    effective.lowNoiseAmplifier.value,
  );
  const avoidSpurs = resolveCanonicalEnumIntent(
    intents,
    CANONICAL_RECEIVER_SWEEP_PARAMETER_IDS.avoidSpurs,
    controls.avoidSpurs,
    effective.avoidSpurs.value,
  );
  const configuration = sweptSpectrumConfigurationSchema.parse({
    kind: 'swept-spectrum',
    startHz,
    stopHz,
    points,
    sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      acquisitionFormat,
      detector,
      spurRejection,
      lowNoiseAmplifier,
      avoidSpurs,
      ...receiverControls,
    },
  });
  assertCanonicalConfigurationWithinCapability(configuration, capabilities, 'receiver sweep');
  return configuration;
}

function appendCanonicalReceiverControlParameters(
  parameters: CanonicalParameter[],
  parameterIds: CanonicalReceiverParameterIds,
  controls: CanonicalReceiverControls,
  effective: CanonicalReceiverTriggerEffectiveValues & Readonly<{
    resolutionBandwidthKhz: CanonicalEffective<number>;
    attenuationDb: CanonicalEffective<number>;
  }>,
): void {
  parameters.push(
    canonicalNumericParameter('number', parameterIds.resolutionBandwidthKhz, 'Resolution bandwidth', 'Receiver', 'kHz', controls.resolutionBandwidthKhz.manual, effective.resolutionBandwidthKhz),
    canonicalNumericParameter('number', parameterIds.attenuationDb, 'Attenuation', 'Receiver', 'dB', controls.attenuationDb.manual, effective.attenuationDb),
    canonicalEnumParameter(parameterIds.triggerMode, 'Trigger mode', 'Trigger', controls.triggerModes, effective.triggerMode),
  );
  if (controls.triggerLevelDbm && effective.triggerLevelDbm) {
    parameters.push(canonicalNumericParameter('number', parameterIds.triggerLevelDbm, 'Trigger level', 'Trigger', 'dBm', controls.triggerLevelDbm, effective.triggerLevelDbm));
  }
}

function canonicalReceiverCommonEffectiveValues(
  controls: CanonicalReceiverControls,
  current: CanonicalReceiverCurrentControls | undefined,
) {
  const triggerLevelDbm = controls.triggerLevelDbm
    ? effectiveNumber(
      current?.trigger.mode === 'normal' || current?.trigger.mode === 'single'
        ? current.trigger.levelDbm
        : undefined,
      controls.triggerLevelDbm,
      controls.triggerLevelDbm.min,
    )
    : undefined;
  return {
    resolutionBandwidthKhz: effectiveNumber(
      typeof current?.resolutionBandwidthKhz === 'number' ? current.resolutionBandwidthKhz : undefined,
      controls.resolutionBandwidthKhz.manual,
      maximumReachableRangeValue(controls.resolutionBandwidthKhz.manual),
    ),
    attenuationDb: effectiveNumber(
      typeof current?.attenuationDb === 'number' ? current.attenuationDb : undefined,
      controls.attenuationDb.manual,
      controls.attenuationDb.manual.min,
    ),
    triggerMode: effectiveEnum(
      current?.trigger.mode,
      controls.triggerModes,
      preferredCanonicalOption(controls.triggerModes, 'auto', 'normal', 'single'),
    ),
    ...(triggerLevelDbm ? { triggerLevelDbm } : {}),
  };
}

function resolveCanonicalReceiverTrigger(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  parameterIds: CanonicalReceiverParameterIds,
  controls: CanonicalReceiverControls,
  effective: CanonicalReceiverTriggerEffectiveValues,
): { mode: 'auto' } | { mode: 'normal' | 'single'; levelDbm: number } {
  const triggerMode = resolveCanonicalEnumIntent(
    intents,
    parameterIds.triggerMode,
    controls.triggerModes,
    effective.triggerMode.value,
  );
  if (triggerMode === 'auto') {
    if (controls.triggerLevelDbm) {
      const triggerLevelIntent = requiredCanonicalIntent(intents, parameterIds.triggerLevelDbm);
      if (triggerLevelIntent.mode === 'manual') {
        throw new RangeError('A manual trigger level requires normal or single trigger mode');
      }
    }
    return { mode: 'auto' };
  }
  if (!controls.triggerLevelDbm || !effective.triggerLevelDbm) {
    throw new Error(`TinySA ${triggerMode} trigger capability omitted its required trigger-level range`);
  }
  return {
    mode: triggerMode,
    levelDbm: resolveCanonicalNumberIntent(intents, parameterIds.triggerLevelDbm, effective.triggerLevelDbm.value),
  };
}

function resolveCanonicalReceiverControls(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  parameterIds: CanonicalReceiverParameterIds,
  controls: CanonicalReceiverControls,
  effective: CanonicalReceiverTriggerEffectiveValues & Readonly<{
    resolutionBandwidthKhz: CanonicalEffective<number>;
    attenuationDb: CanonicalEffective<number>;
  }>,
): Readonly<{
  resolutionBandwidthKhz: number;
  attenuationDb: number;
  trigger: { mode: 'auto' } | { mode: 'normal' | 'single'; levelDbm: number };
}> {
  return {
    resolutionBandwidthKhz: resolveCanonicalNumberIntent(
      intents, parameterIds.resolutionBandwidthKhz, effective.resolutionBandwidthKhz.value,
    ),
    attenuationDb: resolveCanonicalNumberIntent(
      intents, parameterIds.attenuationDb, effective.attenuationDb.value,
    ),
    trigger: resolveCanonicalReceiverTrigger(intents, parameterIds, controls, effective),
  };
}

function assertCanonicalConfigurationWithinCapability(
  configuration: Parameters<typeof instrumentConfigurationCapabilityBindingIssues>[0],
  capabilities: InstrumentCapabilities,
  operation: string,
): void {
  const bindingIssues = instrumentConfigurationCapabilityBindingIssues(configuration, capabilities);
  if (bindingIssues.length === 0) return;
  throw new RangeError(`Canonical ${operation} is outside the admitted capability: ${bindingIssues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  ).join('; ')}`);
}

function requireReceiveOnlySafetyState(
  value: unknown,
  sessionId: string,
): InstrumentReceiveOnlySafetyState {
  const state = instrumentReceiveOnlySafetyStateSchema.parse(value);
  if (state.connectionReceipt.sessionId !== sessionId || state.currentReceipt.sessionId !== sessionId) {
    throw new Error('TinySA receive-only safety state does not belong to the admitted device session');
  }
  return state;
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
      && identity.firmwareQualification !== 'custom-source-qualified-receive-only'
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
    } else if (identity.firmwareQualification === 'custom-source-qualified-receive-only') {
      if (!identity.firmwareSourceCommit
        || !identity.firmwareWarning
        || !isSourceQualifiedZs407CustomReceiverFirmwareIdentity(
          identity.firmwareVersion,
          identity.firmwareReportedRevision,
          identity.firmwareSourceCommit,
          identity.firmwareWarning,
        )) {
        throw new Error('TinySA source-qualified custom receive-only identity has contradictory firmware provenance');
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
      : identity.firmwareQualification === 'custom-source-qualified-receive-only'
        ? {
          model: identity.model,
          hardwareVersion: identity.hardwareVersion,
          firmwareVersion: identity.firmwareVersion,
          firmwareReportedRevision: identity.firmwareReportedRevision,
          firmwareSourceCommit: identity.firmwareSourceCommit!,
          firmwareQualification: 'custom-source-qualified-receive-only' as const,
          firmwareWarning: identity.firmwareWarning!,
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
      frequencyHz: canonicalRange(device.analyzerFrequency),
      points: canonicalRange(device.sweepPoints),
      sweepTimeSeconds: {
        automatic: scalar.sweepTimeAutomatic,
        manualSeconds: canonicalRange(device.sweepSeconds),
      },
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormats: scalar.acquisitionFormats,
        resolutionBandwidthKhz: {
          automatic: scalar.resolutionBandwidthAutomatic,
          manual: canonicalRange(device.rbwKhz),
        },
        attenuationDb: {
          automatic: scalar.attenuationAutomatic,
          manual: canonicalRange(device.attenuationDb),
        },
        detectors: scalar.detectors,
        spurRejection: scalar.spurRejection,
        lowNoiseAmplifier: scalar.lowNoiseAmplifier,
        avoidSpurs: scalar.avoidSpurs,
        triggerModes: scalar.triggerModes,
        ...(scalar.triggerLevelDbm ? { triggerLevelDbm: canonicalRange(scalar.triggerLevelDbm) } : {}),
      },
      powerUnit: 'dBm',
    });
  }
  if (scalar.detectedPower) {
    acquisitions.push({
      kind: 'detected-power-timeseries',
      centerFrequencyHz: canonicalRange(device.analyzerFrequency),
      sampleCount: canonicalRange(device.sweepPoints),
      sweepTimeSeconds: {
        automatic: false,
        manualSeconds: canonicalRange(device.sweepSeconds),
      },
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        resolutionBandwidthKhz: {
          automatic: scalar.resolutionBandwidthAutomatic,
          manual: canonicalRange(device.rbwKhz),
        },
        attenuationDb: {
          automatic: scalar.attenuationAutomatic,
          manual: canonicalRange(device.attenuationDb),
        },
        triggerModes: scalar.triggerModes,
        ...(scalar.triggerLevelDbm ? { triggerLevelDbm: canonicalRange(scalar.triggerLevelDbm) } : {}),
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
        { path: 'mixer', frequencyHz: canonicalRange(device.generatorFrequency) },
      ],
      levelDbm: canonicalRange(device.generatorLevel),
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
