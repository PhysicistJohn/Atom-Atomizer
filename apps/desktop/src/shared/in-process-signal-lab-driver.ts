import {
  SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentSessionProvenanceSchema,
  type InstrumentCandidate,
  type InstrumentCandidateDescriptor,
  type InstrumentCapabilities,
  type InstrumentConfigurationCommand,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentSessionEvent,
  type InstrumentSessionProvenance,
} from '@tinysa/contracts';
import {
  parseInstrumentConfigurationCommand,
  parseInstrumentFeatureCommand,
  parseInstrumentFeatureResult,
  parseInstrumentMeasurement,
  type InstrumentDriver,
  type InstrumentSession,
} from '@tinysa/instrument-runtime';
import { AtomizerMeasurementService } from '../../../../../Atom-SignalLab/src/measurement-service.js';
import { type MeasurementSourceStatus } from '../../../../../Atom-SignalLab/src/measurement-contract.js';
import { base64ToBytes, sha256HexOfBytes } from '../../../../../Atom-SignalLab/src/platform-bytes.js';
import contractDocument from '../../../../../Atom-SignalLab/contracts/signal-lab-measurement-bridge-v1.json' with { type: 'json' };

export const SIGNAL_LAB_INSTRUMENT_DRIVER_ID = 'signal-lab' as const;
export const SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID = 'signal-lab:default' as const;
export const SIGNAL_LAB_INSTRUMENT_SOURCE_ID = 'default' as const;

/** Canonical synthetic scalar-view duration admitted by the measurement service. */
export const SIGNAL_LAB_EXACT_SWEEP_SECONDS = 0.05 as const;

const SYNTHETIC_CONTROLS = {
  schemaVersion: 1,
  model: 'synthetic-scalar',
  timingQualification: 'simulation-exact',
} as const;

/**
 * Both editions bundle the same contract JSON document, so hashing its
 * canonical serialization identifies the admitted contract content
 * byte-identically on desktop and web. (This is a hash of the parsed
 * document's JSON serialization, not of the on-disk file bytes: with the
 * bridge subprocess gone, nothing independently re-reads the file, and JSON
 * bundling deterministically preserves member order.) The generator IS the
 * app bundle itself, so its hash is a deterministic domain-separated
 * derivation that identifies "the in-process generator admitted for this
 * contract" without claiming any shipped-artifact identity.
 */
const CONTRACT_SHA256 = sha256HexOfBytes(JSON.stringify(contractDocument));
const IN_PROCESS_GENERATOR_SHA256 = sha256HexOfBytes(`atomizer-in-process-generator\0${CONTRACT_SHA256}`);

const CANDIDATE_DESCRIPTOR: InstrumentCandidateDescriptor = {
  schemaVersion: 1,
  driverId: SIGNAL_LAB_INSTRUMENT_DRIVER_ID,
  candidateId: SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID,
  displayName: 'SignalLab synthetic measurement source',
  sourceKind: 'signal-lab',
  signalLab: { sourceId: SIGNAL_LAB_INSTRUMENT_SOURCE_ID },
};

function requireInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a safe integer from ${min} through ${max}`);
  }
}

/**
 * In-process SignalLab driver shared by both editions. Desktop main and the
 * browser page construct this same driver over the same in-process
 * AtomizerMeasurementService and plug it into the same
 * InstrumentManager/AtomizerInstrumentHost stack, so the two editions share
 * one instrument code path end to end.
 */
export class InProcessSignalLabDriver implements InstrumentDriver {
  readonly driverId = SIGNAL_LAB_INSTRUMENT_DRIVER_ID;
  readonly sourceKinds = Object.freeze(['signal-lab'] as const);

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    return { candidates: [CANDIDATE_DESCRIPTOR], failures: [] };
  }

  async connect(candidateValue: InstrumentCandidate): Promise<InstrumentSession> {
    const candidate = instrumentCandidateSchema.parse(candidateValue);
    if (candidate.driverId !== this.driverId
      || candidate.sourceKind !== 'signal-lab'
      || candidate.candidateId !== SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID
      || candidate.signalLab.sourceId !== SIGNAL_LAB_INSTRUMENT_SOURCE_ID) {
      throw new Error('SignalLab only admits its in-process measurement source');
    }
    const service = new AtomizerMeasurementService({
      contractSha256: CONTRACT_SHA256,
      generatorSha256: IN_PROCESS_GENERATOR_SHA256,
    });
    return new InProcessSignalLabSession(candidate, service);
  }

  async cleanupPendingConnection(): Promise<void> {
    // The in-process service holds no process, port, or file lease to release.
  }
}

interface ConfigurationBinding {
  readonly command: InstrumentConfigurationCommand;
  readonly producerConfigurationEpoch: string;
}

class InProcessSignalLabSession implements InstrumentSession {
  readonly driverId = SIGNAL_LAB_INSTRUMENT_DRIVER_ID;
  readonly rfOutput = 'not-supported' as const;
  readonly sessionId: string;
  readonly candidate: InstrumentCandidate;
  readonly #service: AtomizerMeasurementService;
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  #status: MeasurementSourceStatus;
  #capabilities: InstrumentCapabilities;
  #provenance: InstrumentSessionProvenance;
  #configuration: ConfigurationBinding | undefined;
  #lastSourceSequence = 0;
  #closed = false;

  constructor(candidate: InstrumentCandidate, service: AtomizerMeasurementService) {
    this.candidate = candidate;
    this.#service = service;
    this.#status = service.status();
    this.sessionId = this.#status.sessionId;
    this.#provenance = this.#buildProvenance();
    this.#capabilities = this.#buildCapabilities();
  }

  get capabilities(): InstrumentCapabilities { return this.#capabilities; }
  get provenance(): InstrumentSessionProvenance { return this.#provenance; }

  async configure(commandValue: InstrumentConfigurationCommand): Promise<void> {
    this.#requireOpen();
    const command = parseInstrumentConfigurationCommand(commandValue);
    if (command.sessionId !== this.sessionId) throw new Error('SignalLab configuration names a different session');
    const configuration = command.configuration;
    if (configuration.kind === 'complex-iq') {
      const iqCapability = this.#capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq');
      const sourceState = this.#capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
      if (iqCapability?.kind !== 'complex-iq' || sourceState?.kind !== 'signal-lab-profile-selection') {
        throw new Error('SignalLab complex-I/Q capability disappeared');
      }
      if (!sourceState.iqProfileIds?.includes(this.#status.profile)) {
        throw new RangeError(`SignalLab profile ${this.#status.profile} has no admitted complex-I/Q generator`);
      }
      requireInteger(configuration.centerHz, iqCapability.centerFrequencyHz.min, iqCapability.centerFrequencyHz.max, 'SignalLab I/Q center');
      requireInteger(configuration.sampleRateHz, iqCapability.sampleRateHz.min, iqCapability.sampleRateHz.max, 'SignalLab I/Q sample rate');
      requireInteger(configuration.bandwidthHz, iqCapability.bandwidthHz.min, iqCapability.bandwidthHz.max, 'SignalLab I/Q bandwidth');
      if (configuration.bandwidthHz > configuration.sampleRateHz) {
        throw new RangeError('SignalLab complex-I/Q bandwidth cannot exceed sample rate');
      }
      requireInteger(configuration.sampleCount, iqCapability.sampleCount.min, iqCapability.sampleCount.max, 'SignalLab I/Q samples');
      if (configuration.sampleFormat !== iqCapability.sampleFormat) {
        throw new RangeError(`SignalLab I/Q sample format must be ${iqCapability.sampleFormat}`);
      }
    } else {
      if (configuration.controls.model !== 'synthetic-scalar'
        || configuration.controls.timingQualification !== 'simulation-exact'
        || configuration.sweepTimeSeconds !== SIGNAL_LAB_EXACT_SWEEP_SECONDS) {
        throw new RangeError(`SignalLab admits only exact ${SIGNAL_LAB_EXACT_SWEEP_SECONDS}s synthetic scalar timing and no receiver controls`);
      }
      if (configuration.kind === 'swept-spectrum') {
        requireInteger(configuration.startHz, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1.min, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1.max, 'SignalLab sweep start');
        requireInteger(configuration.stopHz, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1.min, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1.max, 'SignalLab sweep stop');
        if (configuration.stopHz <= configuration.startHz) throw new RangeError('SignalLab sweep stop must exceed start');
        requireInteger(configuration.points, 2, this.#spectrumCapability().maximumPoints, 'SignalLab sweep points');
      } else {
        requireInteger(configuration.centerHz, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1.min, SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1.max, 'SignalLab detected-power center');
        requireInteger(configuration.sampleCount, 1, this.#detectedPowerCapability().maximumPoints, 'SignalLab detected-power samples');
      }
    }
    this.#configuration = Object.freeze({
      command: structuredClone(command),
      producerConfigurationEpoch: this.#status.configurationRevision,
    });
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    const binding = this.#configuration;
    if (!binding) throw new Error('SignalLab session is not configured');
    if (binding.producerConfigurationEpoch !== this.#status.configurationRevision) {
      throw new Error('SignalLab producer configuration changed after local configuration admission');
    }
    this.#emit({ type: 'status', sessionId: this.sessionId, status: 'busy' });
    try {
      const measurement = this.#acquireConfigured(binding);
      this.#emit({ type: 'status', sessionId: this.sessionId, status: 'ready' });
      return measurement;
    } catch (value) {
      this.#emit({
        type: 'error', sessionId: this.sessionId,
        error: { code: 'driver-failure', message: value instanceof Error ? value.message : String(value), recoverable: true },
      });
      throw value;
    }
  }

  async executeFeature(commandValue: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.#requireOpen();
    const command = parseInstrumentFeatureCommand(commandValue);
    if (command.sessionId !== this.sessionId) throw new Error('SignalLab feature names a different session');
    if (command.kind === 'signal-lab-profile-selection') {
      // A source-state mutation invalidates any prior acquisition binding
      // before dispatch, in both editions identically.
      this.#configuration = undefined;
      const previousEpoch = this.#status.configurationRevision;
      const status = command.action === 'select-profile'
        ? this.#service.selectProfile({ profile: command.profileId })
        : command.action === 'configure-channel'
          ? this.#service.configureChannel({ channel: command.channel })
          : this.#service.configureCustomWaveform({ standard: command.standard, selections: command.selections });
      if (command.action === 'select-profile' && status.profile !== command.profileId) {
        throw new Error('SignalLab did not acknowledge the selected profile');
      }
      if (status.configurationRevision === previousEpoch) {
        throw new Error('SignalLab source mutation did not advance the producer configuration epoch');
      }
      this.#status = status;
      this.#provenance = this.#buildProvenance();
      this.#capabilities = this.#buildCapabilities();
      if (command.action === 'select-profile') {
        return parseInstrumentFeatureResult({
          sessionId: this.sessionId,
          kind: 'signal-lab-profile-selection',
          action: 'select-profile',
          profileId: command.profileId,
          producerConfigurationEpoch: status.configurationRevision,
        });
      }
      if (command.action === 'configure-channel') {
        return parseInstrumentFeatureResult({
          sessionId: this.sessionId,
          kind: 'signal-lab-profile-selection',
          action: 'configure-channel',
          channel: command.channel,
          producerConfigurationEpoch: status.configurationRevision,
        });
      }
      return parseInstrumentFeatureResult({
        sessionId: this.sessionId,
        kind: 'signal-lab-profile-selection',
        action: 'configure-custom-waveform',
        standard: command.standard,
        selections: command.selections,
        producerConfigurationEpoch: status.configurationRevision,
      });
    }
    // Defensive teardown callers may ask every instrument to make RF safe.
    // SignalLab has no RF path, so an explicit off request is a safe no-op.
    if (command.kind === 'rf-generator' && command.action === 'set-output' && command.enabled === false) {
      return parseInstrumentFeatureResult({
        sessionId: this.sessionId,
        kind: 'rf-generator',
        action: 'set-output',
        enabled: false,
      });
    }
    throw new Error(`SignalLab does not implement feature ${command.kind}`);
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#service.dispatch({
      type: 'request',
      contractVersion: 1,
      requestId: 'in-process-session-shutdown',
      method: 'shutdown',
      params: {},
    });
    this.#listeners.clear();
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #acquireConfigured(binding: ConfigurationBinding): InstrumentMeasurement {
    const configuration = binding.command.configuration;
    if (configuration.kind === 'complex-iq') {
      const source = this.#service.acquireIq({
        centerHz: configuration.centerHz,
        sampleRateHz: configuration.sampleRateHz,
        bandwidthHz: configuration.bandwidthHz,
        sampleCount: configuration.sampleCount,
        sampleFormat: configuration.sampleFormat,
      });
      const samples = base64ToBytes(source.samplesBase64);
      if (source.centerHz !== configuration.centerHz
        || source.sampleRateHz !== configuration.sampleRateHz
        || source.bandwidthHz !== configuration.bandwidthHz
        || source.sampleCount !== configuration.sampleCount
        || samples.byteLength !== configuration.sampleCount * 8) {
        throw new Error('SignalLab complex-I/Q result geometry does not match the admitted configuration');
      }
      this.#acceptSourceSequence(source.sequence);
      return parseInstrumentMeasurement({
        ...this.#measurementBase(binding, source),
        kind: 'complex-iq',
        centerHz: source.centerHz,
        sampleRateHz: source.sampleRateHz,
        bandwidthHz: source.bandwidthHz,
        sampleFormat: source.sampleFormat,
        sampleCount: source.sampleCount,
        samples,
      });
    }
    if (configuration.kind === 'swept-spectrum') {
      const source = this.#service.acquireSpectrum({
        startHz: configuration.startHz,
        stopHz: configuration.stopHz,
        points: configuration.points,
      });
      if (source.frequencyHz.length !== configuration.points || source.powerDbm.length !== configuration.points) {
        throw new Error('SignalLab spectrum result geometry does not match the admitted configuration');
      }
      this.#acceptSourceSequence(source.sequence);
      return parseInstrumentMeasurement({
        ...this.#measurementBase(binding, source),
        kind: 'swept-spectrum',
        frequencyHz: source.frequencyHz,
        powerDbm: source.powerDbm,
      });
    }
    const samplePeriodSeconds = configuration.sweepTimeSeconds / configuration.sampleCount;
    const source = this.#service.acquireDetectedPower({
      centerFrequencyHz: configuration.centerHz,
      points: configuration.sampleCount,
      samplePeriodSeconds,
    });
    if (source.powerDbm.length !== configuration.sampleCount) {
      throw new Error('SignalLab detected-power result geometry does not match the admitted configuration');
    }
    this.#acceptSourceSequence(source.sequence);
    return parseInstrumentMeasurement({
      ...this.#measurementBase(binding, source),
      kind: 'detected-power-timeseries',
      centerHz: source.centerFrequencyHz,
      sampleIntervalSeconds: source.samplePeriodSeconds,
      timingQualification: 'simulation-exact',
      powerDbm: source.powerDbm,
    });
  }

  #measurementBase(
    binding: ConfigurationBinding,
    source: { measurementId: string; sequence: number; capturedAt: string; elapsedSeconds: number; configurationRevision: string; qualification: string },
  ) {
    if (source.configurationRevision !== binding.producerConfigurationEpoch) {
      throw new Error('SignalLab measurement names a superseded producer configuration epoch');
    }
    return {
      schemaVersion: 1,
      measurementId: source.measurementId,
      sessionId: this.sessionId,
      configurationRevision: binding.command.configurationRevision,
      producerConfigurationEpoch: source.configurationRevision,
      sequence: source.sequence,
      capturedAt: source.capturedAt,
      elapsedMilliseconds: source.elapsedSeconds * 1_000,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: source.qualification,
      complete: true,
    };
  }

  #buildProvenance(): InstrumentSessionProvenance {
    if (this.candidate.sourceKind !== 'signal-lab') throw new Error('SignalLab session candidate lost its source kind');
    const identity = this.#status.identity;
    return instrumentSessionProvenanceSchema.parse({
      sourceKind: 'signal-lab',
      sourceId: this.candidate.signalLab.sourceId,
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      verifiedAt: this.#status.updatedAt,
      producerConfigurationEpoch: this.#status.configurationRevision,
      contractId: identity.contractId,
      contractVersion: identity.contractVersion,
      contractSha256: identity.contractSha256,
      catalogSha256: identity.catalogSha256,
      generatorSha256: identity.generatorSha256,
      claims: identity.claims,
    });
  }

  #buildCapabilities(): InstrumentCapabilities {
    const spectrum = this.#spectrumCapability();
    const detected = this.#detectedPowerCapability();
    const iq = this.#status.capabilities.find((capability) => capability.kind === 'complex-iq');
    if (iq?.kind !== 'complex-iq') throw new Error('SignalLab status omitted its admitted complex-I/Q capability');
    const profileCapabilities = this.#status.profiles.map((profileId) => {
      const waveform = this.#status.catalog.find((entry) => entry.id === profileId);
      if (!waveform) throw new Error(`SignalLab status omitted catalog evidence for profile ${profileId}`);
      return {
        profileId,
        label: waveform.label,
        family: waveform.family,
        model: waveform.model,
        qualification: waveform.qualification,
        centerFrequencyHz: waveform.centerHz,
        occupiedBandwidthHz: waveform.occupiedBandwidthHz,
        recommendedSpanHz: waveform.recommendedSpanHz,
        projection: waveform.projection,
        source: waveform.source,
        disclosure: waveform.disclosure,
        ...(waveform.assetSha256 === undefined ? {} : { assetSha256: waveform.assetSha256 }),
      };
    });
    return instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [
        {
          kind: 'swept-spectrum',
          frequencyHz: { min: spectrum.minimumFrequencyHz, max: spectrum.maximumFrequencyHz, step: 1 },
          points: { min: spectrum.minimumPoints, max: spectrum.maximumPoints, step: 1 },
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: SIGNAL_LAB_EXACT_SWEEP_SECONDS, max: SIGNAL_LAB_EXACT_SWEEP_SECONDS } },
          controls: SYNTHETIC_CONTROLS,
          powerUnit: 'dBm',
        },
        {
          kind: 'detected-power-timeseries',
          centerFrequencyHz: { min: detected.minimumFrequencyHz, max: detected.maximumFrequencyHz, step: detected.frequencyStepHz },
          sampleCount: { min: detected.minimumPoints, max: detected.maximumPoints, step: 1 },
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: SIGNAL_LAB_EXACT_SWEEP_SECONDS, max: SIGNAL_LAB_EXACT_SWEEP_SECONDS } },
          controls: SYNTHETIC_CONTROLS,
          powerUnit: 'dBm',
          timing: 'uniform',
        },
        {
          kind: 'complex-iq',
          centerFrequencyHz: { min: iq.minimumCenterFrequencyHz, max: iq.maximumCenterFrequencyHz, step: iq.frequencyStepHz },
          sampleRateHz: { min: iq.minimumSampleRateHz, max: iq.maximumSampleRateHz },
          bandwidthHz: { min: iq.minimumBandwidthHz, max: iq.maximumBandwidthHz },
          bandwidthMode: iq.bandwidthMode,
          sampleCount: { min: iq.minimumSamples, max: iq.maximumSamples, step: 1 },
          sampleFormat: iq.sampleFormat,
        },
      ],
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: profileCapabilities,
        selectedProfileId: this.#status.profile,
        channel: this.#status.channel,
        iqProfileIds: iq.profiles,
      }],
    });
  }

  #spectrumCapability() {
    const capability = this.#status.capabilities.find((entry) => entry.kind === 'swept-spectrum');
    if (capability?.kind !== 'swept-spectrum') throw new Error('SignalLab status omitted its swept-spectrum capability');
    return capability;
  }

  #detectedPowerCapability() {
    const capability = this.#status.capabilities.find((entry) => entry.kind === 'detected-power-timeseries');
    if (capability?.kind !== 'detected-power-timeseries') throw new Error('SignalLab status omitted its detected-power capability');
    return capability;
  }

  #acceptSourceSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence <= this.#lastSourceSequence) {
      throw new Error('SignalLab measurement sequence did not advance');
    }
    this.#lastSourceSequence = sequence;
  }

  #emit(event: InstrumentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('SignalLab session is closed');
  }
}
