import {
  SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
  canonicalInstrumentSurfaceSchema,
  canonicalOperationParameterIntentsFor,
  canonicalOperationRequestSchema,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentSessionProvenanceSchema,
  signalLabMinimumDerivedSampleRateHz,
  signalLabOutputOneShotSampleLimit,
  type CanonicalInstrumentSurface,
  type CanonicalOperation,
  type CanonicalOperationRequest,
  type CanonicalParameter,
  type CanonicalParameterIntent,
  type CanonicalParameterManualDomain,
  type CanonicalParameterScalarValue,
  type InstrumentCandidate,
  type InstrumentCandidateDescriptor,
  type InstrumentCapabilities,
  type InstrumentConfiguration,
  type InstrumentConfigurationCommand,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentSessionEvent,
  type InstrumentSessionProvenance,
} from '@tinysa/contracts';
import {
  canonicalIntegerParameter,
  canonicalRangeValue,
  humanizeCanonicalOption,
  maximumReachableRangeValue,
  parseInstrumentConfigurationCommand,
  parseInstrumentFeatureCommand,
  parseInstrumentFeatureResult,
  parseInstrumentMeasurement,
  requireCanonicalRange,
  resolveCanonicalEnumIntent as resolveCanonicalEnumIntentShared,
  resolveCanonicalInteger,
  resolveCanonicalRangedNumberIntent,
  type CanonicalNumericRange as NumericRange,
  type CanonicalOperationResolution,
  type InstrumentDriver,
  type InstrumentSession,
} from '@tinysa/instrument-runtime';
import { AtomizerMeasurementService } from '../../../../../Atom-SignalLab/src/measurement-service.js';
import {
  customWaveformStandard,
  isCustomWaveformProfile,
  parsePinnedSelections,
  resolveCustomWaveform,
  sanitizeCustomWaveformSelections,
  type CustomWaveformSelections,
  type CustomWaveformStandard,
} from '../../../../../Atom-SignalLab/src/custom-waveform.js';
import {
  complexIqCapabilitySchema,
  complexIqMeasurementSchema,
  measurementBridgeContractDocumentSchema,
  type MeasurementSourceStatus,
} from '../../../../../Atom-SignalLab/src/measurement-contract.js';
import { base64ToBytes, sha256HexOfBytes } from '../../../../../Atom-SignalLab/src/platform-bytes.js';
import contractDocument from '../../../../../Atom-SignalLab/contracts/signal-lab-measurement-bridge-v3.json' with { type: 'json' };

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
 * bundling deterministically preserves member order.) The domain-separated
 * generator/contract binding below identifies the generator role admitted by
 * these contract bytes. It is explicitly not a hash of shipped implementation
 * bytes.
 */
export function admitInProcessSignalLabContractDocument(value: unknown): {
  readonly contractSha256: string;
  readonly generatorContractBindingSha256: string;
} {
  const admittedDocument = measurementBridgeContractDocumentSchema.parse(value);
  const contractSha256 = sha256HexOfBytes(JSON.stringify(admittedDocument));
  return Object.freeze({
    contractSha256,
    generatorContractBindingSha256: sha256HexOfBytes(
      `atomizer-in-process-generator\0${contractSha256}`,
    ),
  });
}

const {
  contractSha256: CONTRACT_SHA256,
  generatorContractBindingSha256: GENERATOR_CONTRACT_BINDING_SHA256,
} = admitInProcessSignalLabContractDocument(contractDocument);

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
      generatorContractBindingSha256: GENERATOR_CONTRACT_BINDING_SHA256,
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
  /**
   * The synthetic service owns effective source state.  This small ledger only
   * records the last generic Auto/manual intent so the next canonical surface
   * can truthfully distinguish a driver-selected value from an explicit one.
   */
  #canonicalSourceIntents = new Map<string, CanonicalParameterIntent>();
  #pendingCanonicalSourceOperation: {
    readonly action: 'select-profile' | 'configure-channel' | 'configure-custom-waveform';
    readonly intents: ReadonlyMap<string, CanonicalParameterIntent>;
  } | undefined;
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

  /**
   * Driver-owned, source-neutral acquisition surface.  The synthetic service's
   * profile, exact timing, and output encoding remain implementation details:
   * Atomizer receives only the operations, valid manual domains, and the
   * driver-selected result of an Auto request.
   */
  get canonicalSurface(): CanonicalInstrumentSurface {
    return signalLabCanonicalSurface({
      sessionId: this.sessionId,
      provenance: this.#provenance,
      capabilities: this.#capabilities,
      status: this.#status,
      configuration: this.#configuration?.command.configuration,
      configurationRevision: this.#configuration?.command.configurationRevision,
      sourceIntents: this.#canonicalSourceIntents,
      closed: this.#closed,
    });
  }

  async resolveCanonicalOperation(requestValue: CanonicalOperationRequest): Promise<CanonicalOperationResolution> {
    this.#requireOpen();
    const request = canonicalOperationRequestSchema.parse(requestValue);
    if (request.sessionId !== this.sessionId) {
      throw new Error('Canonical SignalLab operation names a different session');
    }
    switch (request.operationId) {
      case CANONICAL_SIGNAL_LAB_OPERATIONS.spectrum:
        return {
          configuration: resolveCanonicalSignalLabSpectrum(
            canonicalSignalLabSpectrumCapability(this.#capabilities),
            this.#status,
            this.#canonicalOperationIntents(request.operationId, request),
          ),
        };
      case CANONICAL_SIGNAL_LAB_OPERATIONS.power:
        return {
          configuration: resolveCanonicalSignalLabPowerObservation(
            canonicalSignalLabPowerCapability(this.#capabilities),
            this.#status,
            this.#canonicalOperationIntents(request.operationId, request),
          ),
        };
      case CANONICAL_SIGNAL_LAB_OPERATIONS.capture:
        return {
          configuration: resolveCanonicalSignalLabCapture(
            canonicalSignalLabCaptureCapability(this.#capabilities),
            canonicalSignalLabSelectedIqProfile(this.#capabilities),
            this.#canonicalOperationIntents(request.operationId, request),
          ),
        };
      case CANONICAL_SIGNAL_LAB_OPERATIONS.sourceProfile:
        return this.#resolveCanonicalSourceProfile(request);
      case CANONICAL_SIGNAL_LAB_OPERATIONS.sourceChannel:
        return this.#resolveCanonicalSourceChannel(request);
      case CANONICAL_SIGNAL_LAB_OPERATIONS.sourceWaveform:
        return this.#resolveCanonicalSourceWaveform(request);
      default:
        throw new RangeError(`SignalLab does not advertise canonical operation ${request.operationId}`);
    }
  }

  #canonicalOperationIntents(
    operationId: string,
    request: CanonicalOperationRequest,
  ): ReadonlyMap<string, CanonicalParameterIntent> {
    return canonicalOperationParameterIntentsFor(this.canonicalSurface, operationId, request);
  }

  #resolveCanonicalSourceProfile(
    request: CanonicalOperationRequest,
  ): CanonicalOperationResolution {
    const intents = this.#canonicalOperationIntents(
      CANONICAL_SIGNAL_LAB_OPERATIONS.sourceProfile,
      request,
    );
    const source = canonicalSignalLabSourceCapability(this.#capabilities);
    const profileId = resolveCanonicalEnumIntent(
      intents,
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceProfile,
      this.#status.profile,
      source.profiles.map((profile) => profile.profileId),
      'Operating selection',
    );
    this.#stageCanonicalSourceOperation('select-profile', intents);
    return {
      feature: {
        kind: 'signal-lab-profile-selection',
        action: 'select-profile',
        profileId,
      },
    };
  }

  #resolveCanonicalSourceChannel(
    request: CanonicalOperationRequest,
  ): CanonicalOperationResolution {
    const intents = this.#canonicalOperationIntents(
      CANONICAL_SIGNAL_LAB_OPERATIONS.sourceChannel,
      request,
    );
    const automatic = this.#status.channel;
    const channel = {
      model: resolveCanonicalEnumIntent(
        intents,
        CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelModel,
        automatic.model,
        CANONICAL_SOURCE_CHANNEL_MODE_VALUES,
        'Channel model',
      ) as typeof automatic.model,
      receiverImpairment: resolveCanonicalEnumIntent(
        intents,
        CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelReceiverImpairment,
        automatic.receiverImpairment,
        CANONICAL_RECEIVER_IMPAIRMENT_VALUES,
        'Receiver impairment',
      ) as typeof automatic.receiverImpairment,
      noiseFloorDbm: resolveCanonicalNumberIntent(
        intents,
        CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelNoiseFloorDbm,
        automatic.noiseFloorDbm,
        CANONICAL_SOURCE_CHANNEL_NOISE_FLOOR_RANGE,
        'Noise floor',
      ),
      seed: resolveCanonicalIntegerIntent(
        intents,
        CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelSeed,
        automatic.seed,
        CANONICAL_SOURCE_CHANNEL_SEED_RANGE,
        'Deterministic seed',
      ),
      fadingRateHz: resolveCanonicalNumberIntent(
        intents,
        CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelFadingRateHz,
        automatic.fadingRateHz,
        CANONICAL_SOURCE_CHANNEL_FADING_RATE_RANGE,
        'Fading rate',
      ),
    };
    this.#stageCanonicalSourceOperation('configure-channel', intents);
    return {
      feature: {
        kind: 'signal-lab-profile-selection',
        action: 'configure-channel',
        channel,
      },
    };
  }

  #resolveCanonicalSourceWaveform(
    request: CanonicalOperationRequest,
  ): CanonicalOperationResolution {
    const selected = this.#status.profile;
    if (!isCustomWaveformProfile(selected)) {
      throw new RangeError('The connected source has no active customizable waveform');
    }
    const intents = this.#canonicalOperationIntents(
      CANONICAL_SIGNAL_LAB_OPERATIONS.sourceWaveform,
      request,
    );
    const standard = customWaveformStandard(selected);
    const current = parsePinnedSelections(this.#status.waveform.model);
    const selections = resolveCanonicalCustomWaveformSelections(standard, current, intents);
    const admittedIntents = canonicalCustomWaveformIntents(standard, selections);
    this.#stageCanonicalSourceOperation('configure-custom-waveform', admittedIntents);
    return {
      feature: {
        kind: 'signal-lab-profile-selection',
        action: 'configure-custom-waveform',
        standard,
        selections,
      },
    };
  }

  #stageCanonicalSourceOperation(
    action: 'select-profile' | 'configure-channel' | 'configure-custom-waveform',
    intents: ReadonlyMap<string, CanonicalParameterIntent>,
  ): void {
    this.#pendingCanonicalSourceOperation = {
      action,
      intents: new Map(intents),
    };
  }

  #commitCanonicalSourceOperation(command: Extract<InstrumentFeatureCommand, { kind: 'signal-lab-profile-selection' }>): void {
    const pending = this.#pendingCanonicalSourceOperation;
    this.#pendingCanonicalSourceOperation = undefined;
    if (pending?.action === command.action) {
      this.#canonicalSourceIntents = new Map(pending.intents);
      return;
    }
    if (command.action === 'select-profile') {
      this.#canonicalSourceIntents = new Map([
        [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceProfile, { mode: 'manual', value: command.profileId }],
      ]);
      return;
    }
    if (command.action === 'configure-channel') {
      this.#canonicalSourceIntents = new Map([
        [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelModel, { mode: 'manual', value: command.channel.model }],
        [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelReceiverImpairment, { mode: 'manual', value: command.channel.receiverImpairment }],
        [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelNoiseFloorDbm, { mode: 'manual', value: command.channel.noiseFloorDbm }],
        [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelSeed, { mode: 'manual', value: command.channel.seed }],
        [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelFadingRateHz, { mode: 'manual', value: command.channel.fadingRateHz }],
      ]);
      return;
    }
    this.#canonicalSourceIntents = new Map(canonicalCustomWaveformIntents(command.standard, command.selections));
  }

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
      const profile = sourceState.iqProfiles.find((candidate) => candidate.profileId === this.#status.profile);
      if (!profile) throw new RangeError(`SignalLab profile ${this.#status.profile} has no admitted complex-I/Q transport`);
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
      if (profile) {
        if (configuration.sampleRateHz < profile.signalBandwidthHz) {
          throw new RangeError(
            `SignalLab output rate cannot represent the ${profile.signalBandwidthHz} Hz profile signal bandwidth`,
          );
        }
        if (configuration.bandwidthHz < profile.signalBandwidthHz) {
          throw new RangeError(
            `SignalLab capture bandwidth cannot exclude part of the ${profile.signalBandwidthHz} Hz profile signal support`,
          );
        }
        if (profile.nativeSampleRateHz !== null
          && configuration.sampleRateHz !== profile.nativeSampleRateHz
          && !profile.derivedTransportSupported) {
          throw new RangeError(`SignalLab profile ${profile.profileId} does not support derived I/Q transport`);
        }
        if (profile.nativeSampleRateHz !== null
          && configuration.sampleRateHz !== profile.nativeSampleRateHz
          && configuration.sampleRateHz < profile.nativeSampleRateHz
          && configuration.sampleRateHz < signalLabMinimumDerivedSampleRateHz(profile.signalBandwidthHz)) {
          throw new RangeError(
            `SignalLab derived output rate must be at least ${signalLabMinimumDerivedSampleRateHz(profile.signalBandwidthHz)} samples/s to preserve anti-alias support`,
          );
        }
        const outputLimit = signalLabOutputOneShotSampleLimit(profile, configuration.sampleRateHz);
        if (outputLimit !== undefined && configuration.sampleCount > outputLimit) {
          throw new RangeError(
            `SignalLab profile ${profile.profileId} permits at most ${outputLimit} output samples at ${configuration.sampleRateHz} samples/s`,
          );
        }
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
      let status: MeasurementSourceStatus;
      try {
        status = command.action === 'select-profile'
          ? this.#service.selectProfile({ profile: command.profileId })
          : command.action === 'configure-channel'
            ? this.#service.configureChannel({ channel: command.channel })
            : this.#service.configureCustomWaveform({ standard: command.standard, selections: command.selections });
      } catch (error) {
        if (this.#pendingCanonicalSourceOperation?.action === command.action) {
          this.#pendingCanonicalSourceOperation = undefined;
        }
        throw error;
      }
      if (command.action === 'select-profile' && status.profile !== command.profileId) {
        throw new Error('SignalLab did not acknowledge the selected profile');
      }
      if (status.configurationRevision === previousEpoch) {
        throw new Error('SignalLab source mutation did not advance the producer configuration epoch');
      }
      this.#status = status;
      this.#provenance = this.#buildProvenance();
      this.#capabilities = this.#buildCapabilities();
      this.#commitCanonicalSourceOperation(command);
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
    this.#service.shutdown();
    this.#listeners.clear();
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #acquireConfigured(binding: ConfigurationBinding): InstrumentMeasurement {
    const configuration = binding.command.configuration;
    if (configuration.kind === 'complex-iq') {
      const source = complexIqMeasurementSchema.parse(this.#service.acquireIq({
        centerHz: configuration.centerHz,
        sampleRateHz: configuration.sampleRateHz,
        captureBandwidthHz: configuration.bandwidthHz,
        sampleCount: configuration.sampleCount,
        sampleFormat: configuration.sampleFormat,
      }));
      const samples = base64ToBytes(source.samplesBase64);
      if (source.centerHz !== configuration.centerHz
        || source.sampleRateHz !== configuration.sampleRateHz
        || source.captureBandwidthHz !== configuration.bandwidthHz
        || source.sampleCount !== configuration.sampleCount
        || samples.byteLength !== configuration.sampleCount * 8) {
        throw new Error('SignalLab complex-I/Q result geometry does not match the admitted configuration');
      }
      this.#acceptSourceSequence(source.sequence);
      return parseInstrumentMeasurement({
        ...this.#measurementBase(binding, source),
        kind: 'complex-iq',
        centerHz: source.centerHz,
        profileReferenceCenterHz: source.profileReferenceCenterHz,
        rfReferenceCenterHz: source.rfReferenceCenterHz,
        nativeCarrierOffsetHz: source.nativeCarrierOffsetHz,
        rfPlacement: source.rfPlacement,
        outputCarrierOffsetHz: source.outputCarrierOffsetHz,
        rfTuneCenterHz: source.rfTuneCenterHz,
        sampleRateHz: source.sampleRateHz,
        bandwidthHz: source.captureBandwidthHz,
        signalBandwidthHz: source.signalBandwidthHz,
        nativeSampleRateHz: source.nativeSampleRateHz,
        sampleFormat: source.sampleFormat,
        sampleCount: source.sampleCount,
        payloadKind: source.payloadKind,
        canonicalArtifactSha256: source.canonicalArtifactSha256,
        transformReceipt: source.transformReceipt,
        representation: source.representation,
        normalization: source.normalization,
        receiverImpairment: source.receiverImpairment,
        channelApplication: source.channelApplication,
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
      generatorContractBindingSha256: identity.generatorContractBindingSha256,
      claims: identity.claims,
    });
  }

  #buildCapabilities(): InstrumentCapabilities {
    const spectrum = this.#spectrumCapability();
    const detected = this.#detectedPowerCapability();
    const iq = complexIqCapabilitySchema.parse(
      this.#status.capabilities.find((capability) => capability.kind === 'complex-iq'),
    );
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
        governance: waveform.governance,
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
        iqProfiles: iq.iqProfiles,
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

/**
 * These identifiers describe acquisition semantics, not a source protocol or
 * profile vocabulary.  They are deliberately stable across any driver which
 * can honestly expose the same measurement operation.
 */
const CANONICAL_SIGNAL_LAB_OPERATIONS = {
  spectrum: 'spectrum.sweep',
  power: 'power.observe',
  capture: 'capture',
  sourceProfile: 'source.select-profile',
  sourceChannel: 'source.configure-channel',
  sourceWaveform: 'source.configure-waveform',
} as const;

const CANONICAL_SIGNAL_LAB_PARAMETERS = {
  spectrumStartHz: 'spectrum.start-hz',
  spectrumStopHz: 'spectrum.stop-hz',
  spectrumPoints: 'spectrum.points',
  powerCenterHz: 'power.center-hz',
  powerSamples: 'power.samples',
  captureCenterHz: 'capture.tune',
  captureSampleRateHz: 'capture.sample-rate',
  captureBandwidthHz: 'capture.bandwidth',
  captureSamples: 'capture.samples',
  sourceProfile: 'source.profile',
  sourceChannelModel: 'source.channel.model',
  sourceChannelReceiverImpairment: 'source.channel.receiver-impairment',
  sourceChannelNoiseFloorDbm: 'source.channel.noise-floor',
  sourceChannelSeed: 'source.channel.seed',
  sourceChannelFadingRateHz: 'source.channel.fading-rate',
} as const;

const CANONICAL_SOURCE_AUTO_DESCRIPTION = 'The connected driver resolves Auto from its current admitted source state.';
const CANONICAL_RECEIVER_IMPAIRMENT_VALUES = [
  'clean',
  'awgn',
  'multipath',
  'carrier-offset',
  'phase-noise',
  'iq-imbalance',
  'dc-offset',
  'pa-compression',
  'composite',
] as const;
const CANONICAL_SOURCE_CHANNEL_MODE_VALUES = ['awgn', 'rayleigh'] as const;
const CANONICAL_SOURCE_CHANNEL_NOISE_FLOOR_RANGE = { min: -150, max: -30 } as const;
const CANONICAL_SOURCE_CHANNEL_SEED_RANGE = { min: 1, max: 0xffff_ffff, step: 1 } as const;
const CANONICAL_SOURCE_CHANNEL_FADING_RATE_RANGE = { min: 0.1, max: 100 } as const;

type SignalLabSpectrumCapability = Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'swept-spectrum' }>;
type SignalLabPowerCapability = Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'detected-power-timeseries' }>;
type SignalLabCaptureCapability = Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'complex-iq' }>;
type SignalLabIqProfile = Extract<InstrumentCapabilities['features'][number], { kind: 'signal-lab-profile-selection' }>['iqProfiles'][number];
type SignalLabSpectrumConfiguration = Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }>;
type SignalLabPowerConfiguration = Extract<InstrumentConfiguration, { kind: 'detected-power-timeseries' }>;
type SignalLabCaptureConfiguration = Extract<InstrumentConfiguration, { kind: 'complex-iq' }>;
type CanonicalSourceParameterDefinition = readonly [
  id: string,
  label: string,
  group: string,
  manual: CanonicalParameterManualDomain,
  effectiveValue: CanonicalParameterScalarValue,
  unit?: string,
];
type CanonicalAcquisitionOperationDefinition = readonly [
  id: string,
  label: string,
  description: string,
  parameterIds: readonly string[],
  output: string,
  acquisitionKind: NonNullable<CanonicalOperation['acquisitionKind']>,
  primary?: boolean,
];
type CanonicalOperationDefinition = Readonly<{
  id: string;
  label: string;
  description: string;
  scope: NonNullable<CanonicalOperation['scope']>;
  parameterIds: readonly string[];
  outputs: readonly string[];
  acquisitionKind?: NonNullable<CanonicalOperation['acquisitionKind']>;
  primary?: boolean;
  confirmation?: CanonicalOperation['confirmation'];
}>;

const CANONICAL_ACQUISITION_OPERATIONS = [
  [CANONICAL_SIGNAL_LAB_OPERATIONS.spectrum, 'Sweep', 'Configure and acquire one scalar spectrum.', [CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumStartHz, CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumStopHz, CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumPoints], 'Spectrum', 'swept-spectrum', true],
  [CANONICAL_SIGNAL_LAB_OPERATIONS.power, 'Observe power', 'Configure and acquire one bounded power time series.', [CANONICAL_SIGNAL_LAB_PARAMETERS.powerCenterHz, CANONICAL_SIGNAL_LAB_PARAMETERS.powerSamples], 'Power time series', 'detected-power-timeseries'],
  [CANONICAL_SIGNAL_LAB_OPERATIONS.capture, 'Capture', 'Configure and prepare one bounded complex-sample capture.', [CANONICAL_SIGNAL_LAB_PARAMETERS.captureCenterHz, CANONICAL_SIGNAL_LAB_PARAMETERS.captureSampleRateHz, CANONICAL_SIGNAL_LAB_PARAMETERS.captureBandwidthHz, CANONICAL_SIGNAL_LAB_PARAMETERS.captureSamples], 'Complex I/Q', 'complex-iq'],
] as const satisfies readonly CanonicalAcquisitionOperationDefinition[];

function signalLabCanonicalSurface(input: Readonly<{
  sessionId: string;
  provenance: InstrumentSessionProvenance;
  capabilities: InstrumentCapabilities;
  status: MeasurementSourceStatus;
  configuration: InstrumentConfiguration | undefined;
  configurationRevision: string | undefined;
  sourceIntents: ReadonlyMap<string, CanonicalParameterIntent>;
  closed: boolean;
}>): CanonicalInstrumentSurface {
  const spectrumCapability = canonicalSignalLabSpectrumCapability(input.capabilities);
  const powerCapability = canonicalSignalLabPowerCapability(input.capabilities);
  const captureCapability = canonicalSignalLabCaptureCapability(input.capabilities);
  const profile = canonicalSignalLabSelectedIqProfile(input.capabilities);
  const spectrumConfiguration = currentSignalLabConfiguration(input.configuration, 'swept-spectrum');
  const powerConfiguration = currentSignalLabConfiguration(input.configuration, 'detected-power-timeseries');
  const captureConfiguration = currentSignalLabConfiguration(input.configuration, 'complex-iq');
  const automaticSpectrum = automaticSignalLabSpectrumConfiguration(spectrumCapability, input.status);
  const automaticPower = automaticSignalLabPowerConfiguration(powerCapability, input.status);
  const automaticCapture = automaticSignalLabCaptureConfiguration(captureCapability, profile);
  const source = canonicalSourceSurface(input.capabilities, input.status, input.sourceIntents);
  const parameters: CanonicalParameter[] = [
    ...canonicalIntegerParameters([
      [CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumStartHz, 'Start frequency', 'Sweep', 'Hz', spectrumCapability.frequencyHz, spectrumConfiguration?.startHz, automaticSpectrum.startHz],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumStopHz, 'Stop frequency', 'Sweep', 'Hz', spectrumCapability.frequencyHz, spectrumConfiguration?.stopHz, automaticSpectrum.stopHz],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumPoints, 'Points', 'Sweep', 'points', spectrumCapability.points, spectrumConfiguration?.points, automaticSpectrum.points],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.powerCenterHz, 'Center frequency', 'Observation', 'Hz', powerCapability.centerFrequencyHz, powerConfiguration?.centerHz, automaticPower.centerHz],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.powerSamples, 'Samples', 'Observation', 'samples', powerCapability.sampleCount, powerConfiguration?.sampleCount, automaticPower.sampleCount],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.captureCenterHz, 'Tune', 'Capture', 'Hz', captureCapability.centerFrequencyHz, captureConfiguration?.centerHz, automaticCapture.centerHz],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.captureSampleRateHz, 'Sample rate', 'Capture', 'Hz', captureCapability.sampleRateHz, captureConfiguration?.sampleRateHz, automaticCapture.sampleRateHz],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.captureBandwidthHz, 'Bandwidth', 'Capture', 'Hz', captureCapability.bandwidthHz, captureConfiguration?.bandwidthHz, automaticCapture.bandwidthHz],
      [CANONICAL_SIGNAL_LAB_PARAMETERS.captureSamples, 'Samples', 'Capture', 'samples', captureCapability.sampleCount, captureConfiguration?.sampleCount, automaticCapture.sampleCount],
    ]),
    ...source.parameters,
  ];
  return canonicalInstrumentSurfaceSchema.parse({
    schemaVersion: 1,
    revision: [
      'canonical',
      input.sessionId,
      input.status.configurationRevision,
      input.configurationRevision ?? 'unconfigured',
    ].join(':'),
    presentation: {
      title: 'Measurement interface',
      subtitle: 'Connected source',
      qualification: humanizeCanonicalOption(input.provenance.qualification),
      facts: [
        {
          label: 'Scalar timing',
          value: `${SIGNAL_LAB_EXACT_SWEEP_SECONDS} seconds`,
          detail: 'Exact timing is supplied by the connected driver.',
        },
        {
          label: 'Complex sample format',
          value: captureCapability.sampleFormat.toUpperCase(),
          detail: 'The source declares one interleaved complex-sample encoding.',
        },
      ],
    },
    parameters,
    operations: [
      ...CANONICAL_ACQUISITION_OPERATIONS.map(([id, label, description, parameterIds, output, acquisitionKind, primary]) =>
        canonicalOperation({ id, label, description, scope: 'acquisition', acquisitionKind, parameterIds, outputs: [output], primary }, input.closed)),
      ...source.operations,
    ],
  });
}

function canonicalSourceSurface(
  capabilities: InstrumentCapabilities,
  status: MeasurementSourceStatus,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): { readonly parameters: readonly CanonicalParameter[]; readonly operations: readonly CanonicalOperation[] } {
  const capability = canonicalSignalLabSourceCapability(capabilities);
  const sourceParameters = canonicalSourceParameters(intents,
    [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceProfile, 'Operating selection', 'Source', { kind: 'enum', options: capability.profiles.map((profile) => ({ value: profile.profileId, label: profile.label })) }, status.profile],
    [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelModel, 'Channel model', 'Source channel', { kind: 'enum', options: CANONICAL_SOURCE_CHANNEL_MODE_VALUES.map((value) => ({ value, label: value.toUpperCase() })) }, status.channel.model],
    [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelReceiverImpairment, 'Receiver impairment', 'Source channel', { kind: 'enum', options: CANONICAL_RECEIVER_IMPAIRMENT_VALUES.map((value) => ({ value, label: humanizeCanonicalOption(value) })) }, status.channel.receiverImpairment],
    [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelNoiseFloorDbm, 'Noise floor', 'Source channel', { kind: 'number', range: CANONICAL_SOURCE_CHANNEL_NOISE_FLOOR_RANGE }, status.channel.noiseFloorDbm, 'dBm'],
    [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelSeed, 'Deterministic seed', 'Source channel', { kind: 'integer', range: CANONICAL_SOURCE_CHANNEL_SEED_RANGE }, status.channel.seed],
    [CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelFadingRateHz, 'Fading rate', 'Source channel', { kind: 'number', range: CANONICAL_SOURCE_CHANNEL_FADING_RATE_RANGE }, status.channel.fadingRateHz, 'Hz'],
  );
  const operations: CanonicalOperation[] = [
    sourceOperation(CANONICAL_SIGNAL_LAB_OPERATIONS.sourceProfile, 'Select source', 'Choose an admitted operating selection.', [
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceProfile,
    ]),
    sourceOperation(CANONICAL_SIGNAL_LAB_OPERATIONS.sourceChannel, 'Configure channel', 'Adjust the source channel under the driver-declared limits.', [
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelModel,
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelReceiverImpairment,
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelNoiseFloorDbm,
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelSeed,
      CANONICAL_SIGNAL_LAB_PARAMETERS.sourceChannelFadingRateHz,
    ]),
  ];
  if (isCustomWaveformProfile(status.profile)) {
    const standard = customWaveformStandard(status.profile);
    const resolved = resolveCustomWaveform(standard, parsePinnedSelections(status.waveform.model));
    sourceParameters.push(...resolved.map((parameter) => canonicalSourceParameter(
      canonicalCustomWaveformParameterId(parameter.key),
      parameter.label,
      'Waveform configuration',
      { kind: 'enum', options: boundedCanonicalOptions(parameter.options, parameter.value) },
      parameter.value,
      intents,
      undefined,
      parameter.pinned ? { mode: 'manual', value: parameter.value } : { mode: 'auto' },
    )));
    operations.push(sourceOperation(
      CANONICAL_SIGNAL_LAB_OPERATIONS.sourceWaveform,
      'Configure waveform',
      'Adjust the driver-declared waveform choices.',
      resolved.map((parameter) => canonicalCustomWaveformParameterId(parameter.key)),
    ));
  }
  return { parameters: sourceParameters, operations };
}

function sourceOperation(
  id: string,
  label: string,
  description: string,
  parameterIds: readonly string[],
): CanonicalOperation {
  return canonicalOperation({
    id,
    label,
    description,
    scope: 'source',
    parameterIds,
    outputs: ['Source state'],
  });
}

function canonicalOperation(
  definition: CanonicalOperationDefinition,
  unavailable = false,
): CanonicalOperation {
  return {
    ...definition,
    parameterIds: [...definition.parameterIds],
    outputs: [...definition.outputs],
    availability: unavailable ? 'unavailable' : 'available',
    primary: definition.primary ?? false,
    confirmation: definition.confirmation ?? 'none',
  };
}

function canonicalSourceParameter(
  id: string,
  label: string,
  group: string,
  manual: CanonicalParameterManualDomain,
  effectiveValue: CanonicalParameterScalarValue,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  unit?: string,
  fallback: CanonicalParameterIntent = { mode: 'auto' },
): CanonicalParameter {
  const requested = intents.get(id) ?? fallback;
  return {
    id,
    label,
    group,
    ...(unit === undefined ? {} : { unit }),
    manual,
    auto: { resolver: 'driver', description: CANONICAL_SOURCE_AUTO_DESCRIPTION },
    requested,
    effectiveValue,
    verification: requested.mode === 'auto' ? 'driver-selected' : 'driver-commanded',
  };
}

function canonicalSourceParameters(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  ...definitions: readonly CanonicalSourceParameterDefinition[]
): CanonicalParameter[] {
  return definitions.map(([id, label, group, manual, effectiveValue, unit]) =>
    canonicalSourceParameter(id, label, group, manual, effectiveValue, intents, unit));
}

function boundedCanonicalOptions(options: readonly string[], effectiveValue: string) {
  const values = options.slice(0, 63);
  if (!values.includes(effectiveValue)) values.push(effectiveValue);
  return values.map((value) => ({ value, label: value }));
}

function canonicalSignalLabSourceCapability(capabilities: InstrumentCapabilities) {
  const capability = capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
  if (capability?.kind !== 'signal-lab-profile-selection') throw new Error('SignalLab did not advertise source state');
  return capability;
}

function canonicalSignalLabSpectrumCapability(capabilities: InstrumentCapabilities): SignalLabSpectrumCapability {
  const capability = capabilities.acquisitions.find((entry) => entry.kind === 'swept-spectrum');
  if (capability?.kind !== 'swept-spectrum' || capability.controls.model !== 'synthetic-scalar') {
    throw new Error('SignalLab did not advertise a synthetic scalar spectrum capability');
  }
  return capability;
}

function canonicalSignalLabPowerCapability(capabilities: InstrumentCapabilities): SignalLabPowerCapability {
  const capability = capabilities.acquisitions.find((entry) => entry.kind === 'detected-power-timeseries');
  if (capability?.kind !== 'detected-power-timeseries' || capability.controls.model !== 'synthetic-scalar') {
    throw new Error('SignalLab did not advertise a synthetic scalar power-observation capability');
  }
  return capability;
}

function canonicalSignalLabCaptureCapability(capabilities: InstrumentCapabilities): SignalLabCaptureCapability {
  const capability = capabilities.acquisitions.find((entry) => entry.kind === 'complex-iq');
  if (capability?.kind !== 'complex-iq') {
    throw new Error('SignalLab did not advertise a complex-sample capture capability');
  }
  return capability;
}

function canonicalSignalLabSelectedIqProfile(capabilities: InstrumentCapabilities): SignalLabIqProfile {
  const feature = capabilities.features.find((entry) => entry.kind === 'signal-lab-profile-selection');
  if (feature?.kind !== 'signal-lab-profile-selection') {
    throw new Error('SignalLab did not advertise profile-selection state');
  }
  const profile = feature.iqProfiles.find((candidate) => candidate.profileId === feature.selectedProfileId);
  if (!profile) {
    throw new Error(`SignalLab profile ${feature.selectedProfileId} has no admitted complex-sample transport`);
  }
  return profile;
}

function currentSignalLabConfiguration(
  configuration: InstrumentConfiguration | undefined,
  kind: 'swept-spectrum',
): SignalLabSpectrumConfiguration | undefined;

function currentSignalLabConfiguration(
  configuration: InstrumentConfiguration | undefined,
  kind: 'detected-power-timeseries',
): SignalLabPowerConfiguration | undefined;

function currentSignalLabConfiguration(
  configuration: InstrumentConfiguration | undefined,
  kind: 'complex-iq',
): SignalLabCaptureConfiguration | undefined;

function currentSignalLabConfiguration(
  configuration: InstrumentConfiguration | undefined,
  kind: InstrumentConfiguration['kind'],
): InstrumentConfiguration | undefined {
  if (configuration?.kind !== kind) return undefined;
  return kind === 'complex-iq' || ('controls' in configuration && configuration.controls.model === 'synthetic-scalar')
    ? configuration
    : undefined;
}

function automaticSignalLabSpectrumConfiguration(
  capability: SignalLabSpectrumCapability,
  status: MeasurementSourceStatus,
): SignalLabSpectrumConfiguration {
  const spanHz = Math.max(capability.frequencyHz.step ?? 1, status.waveform.recommendedSpanHz);
  let startHz = canonicalIntegerClosest(capability.frequencyHz, status.waveform.centerHz - spanHz / 2);
  let stopHz = canonicalIntegerClosest(capability.frequencyHz, status.waveform.centerHz + spanHz / 2);
  if (stopHz <= startHz) {
    startHz = canonicalIntegerClosest(capability.frequencyHz, capability.frequencyHz.min);
    stopHz = maximumReachableRangeValue(capability.frequencyHz);
  }
  if (stopHz <= startHz) throw new Error('SignalLab spectrum capability does not admit a nonzero span');
  return {
    kind: 'swept-spectrum',
    startHz,
    stopHz,
    points: canonicalIntegerClosest(capability.points, 401),
    sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
    controls: SYNTHETIC_CONTROLS,
  };
}

function automaticSignalLabPowerConfiguration(
  capability: SignalLabPowerCapability,
  status: MeasurementSourceStatus,
): SignalLabPowerConfiguration {
  return {
    kind: 'detected-power-timeseries',
    centerHz: canonicalIntegerClosest(capability.centerFrequencyHz, status.waveform.centerHz),
    sampleCount: canonicalIntegerClosest(capability.sampleCount, 256),
    sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
    controls: SYNTHETIC_CONTROLS,
  };
}

function automaticSignalLabCaptureConfiguration(
  capability: SignalLabCaptureCapability,
  profile: SignalLabIqProfile,
): SignalLabCaptureConfiguration {
  const minimumBandwidthHz = Math.max(
    capability.bandwidthHz.min,
    profile.signalBandwidthHz,
    profile.nativeMinimumCaptureBandwidthHz ?? 0,
  );
  const minimumRateHz = Math.max(
    capability.sampleRateHz.min,
    profile.nativeSampleRateHz ?? signalLabMinimumDerivedSampleRateHz(profile.signalBandwidthHz),
    minimumBandwidthHz,
  );
  const sampleRateHz = canonicalIntegerAtLeast(capability.sampleRateHz, minimumRateHz, 'Automatic capture sample rate');
  const bandwidthHz = canonicalIntegerAtLeast(capability.bandwidthHz, minimumBandwidthHz, 'Automatic capture bandwidth');
  if (bandwidthHz > sampleRateHz) {
    throw new RangeError('Automatic capture bandwidth cannot fit the selected sample rate');
  }
  const outputLimit = signalLabOutputOneShotSampleLimit(profile, sampleRateHz);
  const sampleCountMaximum = Math.min(capability.sampleCount.max, outputLimit ?? capability.sampleCount.max);
  const sampleCount = canonicalIntegerClosestWithin(
    capability.sampleCount,
    16_384,
    sampleCountMaximum,
    'Automatic capture samples',
  );
  return {
    kind: 'complex-iq',
    centerHz: canonicalIntegerClosest(capability.centerFrequencyHz, profile.profileReferenceCenterHz),
    sampleRateHz,
    bandwidthHz,
    sampleCount,
    sampleFormat: capability.sampleFormat,
  };
}

function resolveCanonicalSignalLabSpectrum(
  capability: SignalLabSpectrumCapability,
  status: MeasurementSourceStatus,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): SignalLabSpectrumConfiguration {
  const automatic = automaticSignalLabSpectrumConfiguration(capability, status);
  const startHz = resolveCanonicalIntegerIntent(
    intents,
    CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumStartHz,
    automatic.startHz,
    capability.frequencyHz,
    'Sweep start frequency',
  );
  const stopHz = resolveCanonicalIntegerIntent(
    intents,
    CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumStopHz,
    automatic.stopHz,
    capability.frequencyHz,
    'Sweep stop frequency',
  );
  if (stopHz <= startHz) throw new RangeError('Sweep stop frequency must exceed start frequency');
  return {
    kind: 'swept-spectrum',
    startHz,
    stopHz,
    points: resolveCanonicalIntegerIntent(
      intents,
      CANONICAL_SIGNAL_LAB_PARAMETERS.spectrumPoints,
      automatic.points,
      capability.points,
      'Sweep points',
    ),
    sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
    controls: SYNTHETIC_CONTROLS,
  };
}

function resolveCanonicalSignalLabPowerObservation(
  capability: SignalLabPowerCapability,
  status: MeasurementSourceStatus,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): SignalLabPowerConfiguration {
  const automatic = automaticSignalLabPowerConfiguration(capability, status);
  return {
    kind: 'detected-power-timeseries',
    centerHz: resolveCanonicalIntegerIntent(
      intents,
      CANONICAL_SIGNAL_LAB_PARAMETERS.powerCenterHz,
      automatic.centerHz,
      capability.centerFrequencyHz,
      'Power-observation center frequency',
    ),
    sampleCount: resolveCanonicalIntegerIntent(
      intents,
      CANONICAL_SIGNAL_LAB_PARAMETERS.powerSamples,
      automatic.sampleCount,
      capability.sampleCount,
      'Power-observation samples',
    ),
    sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
    controls: SYNTHETIC_CONTROLS,
  };
}

function resolveCanonicalSignalLabCapture(
  capability: SignalLabCaptureCapability,
  profile: SignalLabIqProfile,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): SignalLabCaptureConfiguration {
  const automatic = automaticSignalLabCaptureConfiguration(capability, profile);
  const sampleRateHz = resolveCanonicalIntegerIntent(
    intents,
    CANONICAL_SIGNAL_LAB_PARAMETERS.captureSampleRateHz,
    automatic.sampleRateHz,
    capability.sampleRateHz,
    'Capture sample rate',
  );
  const bandwidthHz = resolveCanonicalIntegerIntent(
    intents,
    CANONICAL_SIGNAL_LAB_PARAMETERS.captureBandwidthHz,
    automatic.bandwidthHz,
    capability.bandwidthHz,
    'Capture bandwidth',
  );
  if (bandwidthHz > sampleRateHz) throw new RangeError('Capture bandwidth cannot exceed sample rate');
  return {
    kind: 'complex-iq',
    centerHz: resolveCanonicalIntegerIntent(
      intents,
      CANONICAL_SIGNAL_LAB_PARAMETERS.captureCenterHz,
      automatic.centerHz,
      capability.centerFrequencyHz,
      'Capture tune',
    ),
    sampleRateHz,
    bandwidthHz,
    sampleCount: resolveCanonicalIntegerIntent(
      intents,
      CANONICAL_SIGNAL_LAB_PARAMETERS.captureSamples,
      automatic.sampleCount,
      capability.sampleCount,
      'Capture samples',
    ),
    sampleFormat: capability.sampleFormat,
  };
}

type CanonicalIntegerParameterDefinition = readonly [
  id: string,
  label: string,
  group: string,
  unit: string,
  range: NumericRange,
  configuredValue: number | undefined,
  automaticValue: number,
];

function canonicalIntegerParameters(
  definitions: readonly CanonicalIntegerParameterDefinition[],
): CanonicalParameter[] {
  return definitions.map(([id, label, group, unit, range, configuredValue, automaticValue]) =>
    canonicalIntegerParameter(
      id,
      label,
      group,
      unit,
      range,
      configuredValue === undefined ? { mode: 'auto' } : { mode: 'manual', value: configuredValue },
      configuredValue ?? automaticValue,
      configuredValue === undefined ? 'driver-selected' : 'driver-commanded',
    ));
}

function resolveCanonicalIntegerIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  parameterId: string,
  automaticValue: number,
  range: NumericRange,
  label: string,
): number {
  return resolveCanonicalInteger(intents.get(parameterId), automaticValue, range, label);
}

function resolveCanonicalEnumIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  parameterId: string,
  automaticValue: string,
  allowed: readonly string[],
  label: string,
): string {
  return resolveCanonicalEnumIntentShared(intents, parameterId, allowed, automaticValue, label);
}

function resolveCanonicalNumberIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
  parameterId: string,
  automaticValue: number,
  range: NumericRange,
  label: string,
): number {
  return resolveCanonicalRangedNumberIntent(
    intents,
    parameterId,
    automaticValue,
    range,
    `${label} is outside the admitted setting range`,
    false,
    label,
  );
}

function canonicalCustomWaveformParameterId(key: string): string {
  return `source.waveform.${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

function resolveCanonicalCustomWaveformSelections(
  standard: CustomWaveformStandard,
  current: CustomWaveformSelections,
  intents: ReadonlyMap<string, CanonicalParameterIntent>,
): CustomWaveformSelections {
  const requested: Record<string, string> = {};
  for (const parameter of resolveCustomWaveform(standard, current)) {
    const intent = intents.get(canonicalCustomWaveformParameterId(parameter.key));
    if (!intent) throw new RangeError(`Waveform ${parameter.label} intent is missing`);
    if (intent.mode === 'manual') {
      if (typeof intent.value !== 'string' || !parameter.options.includes(intent.value)) {
        throw new RangeError(`${parameter.label} must be an advertised setting`);
      }
      requested[parameter.key] = intent.value;
    }
  }
  return sanitizeCustomWaveformSelections(standard, requested);
}

function canonicalCustomWaveformIntents(
  standard: CustomWaveformStandard,
  selections: CustomWaveformSelections,
): ReadonlyMap<string, CanonicalParameterIntent> {
  return new Map(resolveCustomWaveform(standard, selections).map((parameter) => [
    canonicalCustomWaveformParameterId(parameter.key),
    parameter.pinned ? { mode: 'manual', value: parameter.value } : { mode: 'auto' },
  ] as const));
}

function canonicalIntegerClosest(range: NumericRange, preferred: number): number {
  return canonicalRangeValue(range, preferred, 'Automatic selection is not a safe integer');
}

function canonicalIntegerClosestWithin(
  range: NumericRange,
  preferred: number,
  maximum: number,
  label: string,
): number {
  const admittedMaximum = Math.min(maximumReachableRangeValue(range), maximum);
  if (admittedMaximum < range.min) throw new RangeError(`${label} has no admitted values`);
  const value = canonicalRangeValue({ ...range, max: admittedMaximum }, preferred, `${label} is not a safe integer`);
  if (value > maximum) throw new RangeError(`${label} exceeds its source-specific output bound`);
  return value;
}

function canonicalIntegerAtLeast(range: NumericRange, required: number, label: string): number {
  const step = range.step ?? 1;
  const value = range.min + Math.max(0, Math.ceil((required - range.min) / step)) * step;
  if (!Number.isSafeInteger(value) || value > maximumReachableRangeValue(range) || value < required) {
    throw new RangeError(`${label} cannot satisfy the required ${required}`);
  }
  requireCanonicalRange(value, range, label);
  return value;
}
