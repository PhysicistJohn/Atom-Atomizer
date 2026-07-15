import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentSessionProvenanceSchema,
  type InstrumentCandidate,
  type InstrumentCapabilities,
  type InstrumentConfigurationCommand,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentSessionProvenance,
  type InstrumentSessionEvent,
} from '@tinysa/contracts';
import {
  parseInstrumentConfigurationCommand,
  parseInstrumentFeatureCommand,
  parseInstrumentFeatureResult,
  parseInstrumentMeasurement,
  type InstrumentDriver,
  type InstrumentSession,
} from './instrument-driver.js';
import {
  SignalLabBridgeClient,
  SignalLabBridgeTerminalError,
  resolveSignalLabBridgeLocation,
  type SignalLabBridgeClientOptions,
  type SignalLabBridgeIdentity,
  type SignalLabBridgeLocation,
  type SignalLabPendingConnectionCleanup,
  type SignalLabBridgeResolverOptions,
  type SignalLabBridgeStatus,
} from './signal-lab-bridge-client.js';

export const SIGNAL_LAB_INSTRUMENT_DRIVER_ID = 'signal-lab' as const;
export const SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID = 'signal-lab:default' as const;
export const SIGNAL_LAB_INSTRUMENT_SOURCE_ID = 'default' as const;

const MAX_FREQUENCY_HZ = 17_922_600_000;
const MAX_SPECTRUM_POINTS = 4_096;
const MAX_DETECTED_POWER_POINTS = 4_096;
const MIN_SAMPLE_PERIOD_SECONDS = 0.000_001;
const MAX_SAMPLE_PERIOD_SECONDS = 10;
const SIGNAL_LAB_CONTRACT_FILE = 'signal-lab-measurement-bridge-v1.json';
const SIGNAL_LAB_GENERATOR_ARTIFACTS = Object.freeze([
  'atomizer-bridge.js',
  'catalog.js',
  'contracts.js',
  'measurement-bridge.js',
  'measurement-contract.js',
  'measurement-service.js',
  'waveforms.js',
] as const);

export interface SignalLabInstrumentDriverOptions extends SignalLabBridgeResolverOptions {
  readonly bridge?: SignalLabBridgeClientOptions;
  /** Injectable only at the composition/test boundary; production uses the static launcher. */
  readonly launchBridgeClient?: typeof SignalLabBridgeClient.launch;
  readonly now?: () => Date;
}

interface SignalLabArtifactEvidence {
  readonly contractSha256: string;
  readonly generatorSha256: string;
}

interface DiscoveredSignalLabSource {
  readonly location: SignalLabBridgeLocation;
  readonly artifacts: SignalLabArtifactEvidence;
}

interface AdmittedSignalLabEvidence extends SignalLabArtifactEvidence {
  readonly catalogSha256: string;
  readonly verifiedAt: string;
}

/**
 * Atomizer's high-level SignalLab adapter. It intentionally implements no
 * ByteTransport and advertises no USB, firmware, RF-generator, screen, touch,
 * diagnostics, or complex-I/Q capability.
 */
export class SignalLabInstrumentDriver implements InstrumentDriver {
  readonly driverId = SIGNAL_LAB_INSTRUMENT_DRIVER_ID;
  readonly sourceKinds = Object.freeze(['signal-lab'] as const);
  readonly #options: SignalLabInstrumentDriverOptions;
  #lastDiscoveredSource: DiscoveredSignalLabSource | undefined;
  #pendingConnection: SignalLabPendingConnectionCleanup | undefined;

  constructor(options: SignalLabInstrumentDriverOptions = {}) {
    this.#options = options;
  }

  async cleanupPendingConnection(): Promise<void> {
    const lease = this.#pendingConnection;
    if (!lease) return;
    await lease.cleanupPendingConnection();
    if (!lease.cleanupConfirmed) {
      throw new Error('SignalLab pending connection cleanup resolved without confirming child-process exit');
    }
    if (this.#pendingConnection === lease) this.#pendingConnection = undefined;
  }

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    this.#lastDiscoveredSource = undefined;
    let location: SignalLabBridgeLocation;
    try {
      location = await resolveSignalLabBridgeLocation({
        atomizerRepositoryRoot: this.#options.atomizerRepositoryRoot,
        packagedResourcesRoot: this.#options.packagedResourcesRoot,
        environment: this.#options.environment,
      });
    } catch (value) {
      return Object.freeze({
        candidates: Object.freeze([]),
        failures: Object.freeze([Object.freeze({
          sourceKind: 'signal-lab' as const,
          code: 'source-unavailable' as const,
          recoverable: true,
          message: boundedMessage(value),
        })]),
      });
    }
    let artifacts: SignalLabArtifactEvidence;
    try { artifacts = await verifySignalLabArtifacts(location); }
    catch (value) {
      return Object.freeze({
        candidates: Object.freeze([]),
        failures: Object.freeze([Object.freeze({
          sourceKind: 'signal-lab' as const,
          code: 'driver-failure' as const,
          recoverable: false,
          message: boundedMessage(value),
        })]),
      });
    }
    this.#lastDiscoveredSource = Object.freeze({ location, artifacts });
    return Object.freeze({
      candidates: Object.freeze([Object.freeze({
        schemaVersion: 1 as const,
        driverId: SIGNAL_LAB_INSTRUMENT_DRIVER_ID,
        candidateId: SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID,
        displayName: 'SignalLab synthetic measurement source',
        sourceKind: 'signal-lab' as const,
        signalLab: Object.freeze({ sourceId: SIGNAL_LAB_INSTRUMENT_SOURCE_ID }),
      })]),
      failures: Object.freeze([]),
    });
  }

  async connect(candidateValue: InstrumentCandidate): Promise<InstrumentSession> {
    if (this.#pendingConnection) {
      throw new Error('SignalLab retained a failed connection that must be cleaned before reconnecting');
    }
    const candidate = instrumentCandidateSchema.parse(candidateValue);
    if (candidate.driverId !== this.driverId
      || candidate.sourceKind !== 'signal-lab'
      || candidate.candidateId !== SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID
      || candidate.signalLab.sourceId !== SIGNAL_LAB_INSTRUMENT_SOURCE_ID) {
      throw new Error('SignalLab driver rejected a candidate it does not own');
    }
    const discovered = this.#lastDiscoveredSource;
    if (!discovered) throw new Error('SignalLab driver requires a successful discovery before connect');
    const prelaunchArtifacts = await verifySignalLabArtifacts(discovered.location);
    assertArtifactEvidence(prelaunchArtifacts, discovered.artifacts, 'SignalLab artifacts changed after discovery');

    let session: SignalLabInstrumentSession | undefined;
    let terminalBeforeSession: Error | undefined;
    const configuredTerminalObserver = this.#options.bridge?.onTerminalFailure;
    let client: SignalLabBridgeClient;
    try {
      client = await (this.#options.launchBridgeClient ?? SignalLabBridgeClient.launch)(discovered.location, {
        ...this.#options.bridge,
        diagnostics: this.#options.bridge?.diagnostics ?? defaultDiagnosticLogger,
        onTerminalFailure: (error) => {
          terminalBeforeSession ??= error;
          try { configuredTerminalObserver?.(error); } catch { /* Observational only. */ }
          session?.acceptTerminalFailure(error);
        },
      }, (lease) => { this.#pendingConnection = lease; });
      // A test/composition launcher may omit the early boot callback, but once
      // a client exists the driver can still establish explicit ownership.
      this.#pendingConnection = client;
    } catch (value) {
      const pending = this.#currentPendingConnection();
      if (pending?.cleanupConfirmed && this.#pendingConnection === pending) this.#pendingConnection = undefined;
      throw value;
    }
    try {
      const status = await client.status();
      const postlaunchArtifacts = await verifySignalLabArtifacts(discovered.location);
      assertArtifactEvidence(postlaunchArtifacts, prelaunchArtifacts, 'SignalLab artifacts changed while the bridge was starting');
      const catalogSha256 = sha256Hex(Buffer.from(JSON.stringify(status.catalog), 'utf8'));
      assertBridgeIdentity(client.ready.identity, postlaunchArtifacts, catalogSha256);
      session = new SignalLabInstrumentSession(candidate, client, status, {
        ...postlaunchArtifacts,
        catalogSha256,
        verifiedAt: localTimestamp(this.#options.now ?? (() => new Date())),
      });
      if (terminalBeforeSession) session.acceptTerminalFailure(terminalBeforeSession);
      if (this.#pendingConnection === client) this.#pendingConnection = undefined;
      return session;
    } catch (value) {
      try { await this.cleanupPendingConnection(); }
      catch (cleanup) {
        throw new AggregateError([value, cleanup], 'SignalLab composition failed and child-process teardown could not be confirmed');
      }
      throw value;
    }
  }

  #currentPendingConnection(): SignalLabPendingConnectionCleanup | undefined {
    return this.#pendingConnection;
  }
}

class SignalLabInstrumentSession implements InstrumentSession {
  readonly rfOutput = 'not-supported' as const;
  readonly sessionId: string;
  readonly driverId = SIGNAL_LAB_INSTRUMENT_DRIVER_ID;
  readonly candidate: InstrumentCandidate;
  readonly capabilities: InstrumentCapabilities;
  readonly #client: SignalLabBridgeClient;
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  #status: SignalLabBridgeStatus;
  #provenance: InstrumentSessionProvenance;
  #configuration: Readonly<{
    command: InstrumentConfigurationCommand;
    producerConfigurationEpoch: string;
  }> | undefined;
  #terminalError: Error | undefined;
  #closing = false;
  #closed = false;

  constructor(
    candidate: InstrumentCandidate,
    client: SignalLabBridgeClient,
    status: SignalLabBridgeStatus,
    evidence: AdmittedSignalLabEvidence,
  ) {
    this.candidate = candidate;
    this.#client = client;
    this.#status = status;
    this.sessionId = client.ready.sessionId;
    const profileCapabilities = status.profiles.map((profileId) => {
      const waveform = status.catalog.find((candidate) => candidate.id === profileId);
      if (!waveform) throw new Error(`SignalLab status omitted catalog evidence for profile ${profileId}`);
      return {
        profileId,
        centerFrequencyHz: waveform.centerHz,
        recommendedSpanHz: waveform.recommendedSpanHz,
      };
    });
    this.#provenance = instrumentSessionProvenanceSchema.parse({
      sourceKind: 'signal-lab',
      sourceId: candidate.sourceKind === 'signal-lab' ? candidate.signalLab.sourceId : '',
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      verifiedAt: evidence.verifiedAt,
      producerConfigurationEpoch: status.configurationRevision,
      contractId: client.ready.identity.contractId,
      contractVersion: client.ready.identity.contractVersion,
      contractSha256: evidence.contractSha256,
      catalogSha256: evidence.catalogSha256,
      generatorSha256: evidence.generatorSha256,
      claims: client.ready.identity.claims,
    });
    this.capabilities = instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [
        {
          kind: 'swept-spectrum',
          frequencyHz: { min: 1, max: MAX_FREQUENCY_HZ, step: 1 },
          points: { min: 2, max: MAX_SPECTRUM_POINTS, step: 1 },
          powerUnit: 'dBm',
        },
        {
          kind: 'detected-power-timeseries',
          centerFrequencyHz: { min: 1, max: MAX_FREQUENCY_HZ, step: 1 },
          sampleCount: { min: 1, max: MAX_DETECTED_POWER_POINTS, step: 1 },
          sampleIntervalSeconds: { min: MIN_SAMPLE_PERIOD_SECONDS, max: MAX_SAMPLE_PERIOD_SECONDS },
          powerUnit: 'dBm',
          timing: 'uniform',
        },
      ],
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: profileCapabilities,
        selectedProfileId: status.profile,
      }],
    });
  }

  get provenance(): InstrumentSessionProvenance { return this.#provenance; }

  async configure(commandValue: InstrumentConfigurationCommand): Promise<void> {
    this.#requireAvailable();
    const command = parseInstrumentConfigurationCommand(commandValue);
    this.#requireSession(command.sessionId);
    const configuration = command.configuration;
    if (configuration.kind === 'complex-iq') throw new Error('SignalLab does not provide complex I/Q');
    if (configuration.kind === 'swept-spectrum') {
      requireInteger(configuration.startHz, 1, MAX_FREQUENCY_HZ, 'SignalLab sweep start');
      requireInteger(configuration.stopHz, 1, MAX_FREQUENCY_HZ, 'SignalLab sweep stop');
      if (configuration.stopHz <= configuration.startHz) throw new RangeError('SignalLab sweep stop must exceed start');
      requireInteger(configuration.points, 2, MAX_SPECTRUM_POINTS, 'SignalLab sweep points');
    } else {
      requireInteger(configuration.centerHz, 1, MAX_FREQUENCY_HZ, 'SignalLab detected-power center');
      requireInteger(configuration.sampleCount, 1, MAX_DETECTED_POWER_POINTS, 'SignalLab detected-power samples');
      requireFinite(configuration.sampleIntervalSeconds, MIN_SAMPLE_PERIOD_SECONDS, MAX_SAMPLE_PERIOD_SECONDS, 'SignalLab sample interval');
      if (configuration.centerHz !== this.#status.waveform.centerHz) {
        throw new RangeError(`SignalLab profile ${this.#status.profile} is centered at ${this.#status.waveform.centerHz} Hz, not ${configuration.centerHz} Hz`);
      }
    }
    this.#configuration = Object.freeze({
      command: structuredClone(command),
      producerConfigurationEpoch: this.#status.configurationRevision,
    });
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireAvailable();
    const binding = this.#configuration;
    if (!binding) throw new Error('SignalLab session is not configured');
    if (binding.producerConfigurationEpoch !== this.#status.configurationRevision) {
      throw this.#terminalProtocolFailure('SignalLab producer configuration changed after local configuration admission');
    }
    const { command } = binding;
    this.#emit({ type: 'status', sessionId: this.sessionId, status: 'busy' });
    try {
      const configuration = command.configuration;
      if (configuration.kind === 'complex-iq') throw new Error('SignalLab does not provide complex I/Q');
      if (configuration.kind === 'swept-spectrum') {
        const source = await this.#client.acquireSpectrum({
          startHz: configuration.startHz,
          stopHz: configuration.stopHz,
          points: configuration.points,
        });
        this.#requireMeasurementEpoch(source.configurationRevision, binding.producerConfigurationEpoch);
        const measurement = parseInstrumentMeasurement({
          schemaVersion: 1,
          measurementId: source.measurementId,
          sessionId: this.sessionId,
          configurationRevision: command.configurationRevision,
          producerConfigurationEpoch: source.configurationRevision,
          sequence: source.sequence,
          capturedAt: source.capturedAt,
          elapsedMilliseconds: source.elapsedSeconds * 1_000,
          resolutionBandwidthHz: null,
          attenuationDb: null,
          qualification: 'synthetic-visual-projection',
          complete: true,
          kind: 'swept-spectrum',
          frequencyHz: source.frequencyHz,
          powerDbm: source.powerDbm,
        });
        this.#emit({ type: 'status', sessionId: this.sessionId, status: 'ready' });
        return measurement;
      }
      if (configuration.centerHz !== this.#status.waveform.centerHz) {
        throw new Error(`SignalLab profile changed center; reconfigure detected power for ${this.#status.waveform.centerHz} Hz`);
      }
      const source = await this.#client.acquireDetectedPower({
        points: configuration.sampleCount,
        samplePeriodSeconds: configuration.sampleIntervalSeconds,
      });
      this.#requireMeasurementEpoch(source.configurationRevision, binding.producerConfigurationEpoch);
      if (source.centerFrequencyHz !== configuration.centerHz) {
        throw new Error('SignalLab detected-power result center does not match the admitted configuration');
      }
      const measurement = parseInstrumentMeasurement({
        schemaVersion: 1,
        measurementId: source.measurementId,
        sessionId: this.sessionId,
        configurationRevision: command.configurationRevision,
        producerConfigurationEpoch: source.configurationRevision,
        sequence: source.sequence,
        capturedAt: source.capturedAt,
        elapsedMilliseconds: source.elapsedSeconds * 1_000,
        resolutionBandwidthHz: null,
        attenuationDb: null,
        qualification: 'synthetic-visual-projection',
        complete: true,
        kind: 'detected-power-timeseries',
        centerHz: source.centerFrequencyHz,
        sampleIntervalSeconds: source.samplePeriodSeconds,
        timingQualification: 'simulation-exact',
        powerDbm: source.powerDbm,
      });
      this.#emit({ type: 'status', sessionId: this.sessionId, status: 'ready' });
      return measurement;
    } catch (value) {
      if (!this.#terminalError) this.#emit({
        type: 'error', sessionId: this.sessionId,
        error: { code: 'driver-failure', message: boundedMessage(value), recoverable: false },
      });
      throw value;
    }
  }

  async executeFeature(commandValue: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.#requireAvailable();
    const command = parseInstrumentFeatureCommand(commandValue);
    this.#requireSession(command.sessionId);
    if (command.kind === 'signal-lab-profile-selection') {
      const capability = this.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
      if (capability?.kind !== 'signal-lab-profile-selection'
        || !capability.profiles.some((profile) => profile.profileId === command.profileId)) {
        throw new RangeError(`SignalLab profile ${command.profileId} is not advertised`);
      }
      const previousEpoch = this.#status.configurationRevision;
      // Selection mutates the producer before its response can be trusted. A
      // prior acquisition binding is therefore invalid before dispatch.
      this.#configuration = undefined;
      try {
        const status = await this.#client.selectProfile(command.profileId);
        if (status.profile !== command.profileId) throw new Error('SignalLab did not acknowledge the selected profile');
        if (status.configurationRevision === previousEpoch) {
          throw new Error('SignalLab profile mutation did not advance the producer configuration epoch');
        }
        const catalogSha256 = sha256Hex(Buffer.from(JSON.stringify(status.catalog), 'utf8'));
        if (this.#provenance.sourceKind !== 'signal-lab'
          || catalogSha256 !== this.#provenance.catalogSha256) {
          throw new Error('SignalLab catalog changed after session admission');
        }
        const profile = capability.profiles.find((candidate) => candidate.profileId === command.profileId);
        if (!profile
          || status.waveform.centerHz !== profile.centerFrequencyHz
          || status.waveform.recommendedSpanHz !== profile.recommendedSpanHz) {
          throw new Error('SignalLab selected profile geometry no longer matches admitted catalog evidence');
        }
        this.#status = status;
        this.#provenance = instrumentSessionProvenanceSchema.parse({
          ...this.#provenance,
          producerConfigurationEpoch: status.configurationRevision,
        });
        return parseInstrumentFeatureResult({
          sessionId: this.sessionId,
          kind: 'signal-lab-profile-selection',
          action: 'select-profile',
          profileId: command.profileId,
          producerConfigurationEpoch: status.configurationRevision,
        });
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        this.acceptTerminalFailure(error);
        throw error;
      }
    }
    // Defensive teardown callers may ask every instrument to make RF safe.
    // SignalLab has no RF path and advertises no generator capability, so an
    // explicit off request is a safe no-op. On/configuration requests fail.
    if (command.kind === 'rf-generator' && command.action === 'set-output' && command.enabled === false) {
      return parseInstrumentFeatureResult({
        sessionId: this.sessionId,
        kind: 'rf-generator',
        action: 'set-output',
        enabled: false,
      });
    }
    throw new Error(`SignalLab does not support ${command.kind}/${command.action}`);
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    if (this.#closing) throw new Error('SignalLab disconnect is already in progress');
    this.#closing = true;
    try {
      try { await this.#client.close(); }
      catch (value) {
        // A terminally faulted synthetic source has no RF state to make safe.
        // The client rethrows that exact terminal object only after it has
        // killed and joined its child. A distinct/AggregateError is a teardown
        // failure and must keep the session active for another cleanup attempt.
        if (!this.#terminalError || value !== this.#terminalError) throw value;
      }
      this.#closed = true;
      this.#configuration = undefined;
      this.#listeners.clear();
    } finally {
      this.#closing = false;
    }
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    if (this.#closed) throw new Error('SignalLab session is closed');
    this.#listeners.add(listener);
    if (this.#terminalError) {
      for (const event of signalLabTerminalEvents(this.sessionId, this.#terminalError)) {
        try { listener(event); } catch { /* Consumer isolation. */ }
      }
    }
    return () => this.#listeners.delete(listener);
  }

  acceptTerminalFailure(error: Error): void {
    if (this.#terminalError || this.#closed) return;
    this.#terminalError = error;
    this.#configuration = undefined;
    for (const event of signalLabTerminalEvents(this.sessionId, error)) this.#emit(event);
  }

  #requireAvailable(): void {
    if (this.#closed || this.#closing) throw new SignalLabBridgeTerminalError('SignalLab session is closed');
    if (this.#terminalError) throw this.#terminalError;
  }

  #requireSession(sessionId: string): void {
    if (sessionId !== this.sessionId) throw new Error('SignalLab command is bound to a different session');
  }

  #requireMeasurementEpoch(actual: string, expected: string): void {
    if (actual !== expected || actual !== this.#status.configurationRevision) {
      throw this.#terminalProtocolFailure('SignalLab measurement producer configuration epoch is stale or mismatched');
    }
  }

  #terminalProtocolFailure(message: string): Error {
    const error = new SignalLabBridgeTerminalError(message);
    this.acceptTerminalFailure(error);
    return error;
  }

  #emit(event: InstrumentSessionEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* Consumers cannot change session state. */ }
    }
  }
}

function signalLabTerminalEvents(sessionId: string, error: Error): readonly InstrumentSessionEvent[] {
  const message = boundedMessage(error);
  return [
    { type: 'status', sessionId, status: 'faulted', message },
    { type: 'error', sessionId, error: { code: 'session-fault', message, recoverable: false } },
  ];
}

function defaultDiagnosticLogger(line: string): void {
  process.stderr.write(`[SignalLab] ${line}\n`);
}

function requireInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is outside ${minimum}..${maximum}`);
}

function requireFinite(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} is outside ${minimum}..${maximum}`);
}

async function verifySignalLabArtifacts(location: SignalLabBridgeLocation): Promise<SignalLabArtifactEvidence> {
  const repositoryRoot = resolve(location.repositoryRoot);
  const contractPath = resolve(repositoryRoot, 'contracts', SIGNAL_LAB_CONTRACT_FILE);
  const contractBytes = await readAdmittedArtifact(contractPath, repositoryRoot, 'SignalLab measurement contract');
  let contractValue: unknown;
  try { contractValue = JSON.parse(contractBytes.toString('utf8')); }
  catch (cause) { throw new Error('SignalLab measurement contract is not valid JSON', { cause }); }
  verifySignalLabContractDocument(contractValue);

  const generator = createHash('sha256');
  for (const name of SIGNAL_LAB_GENERATOR_ARTIFACTS) {
    const artifactPath = resolve(repositoryRoot, 'dist', 'bridge', name);
    const bytes = await readAdmittedArtifact(artifactPath, repositoryRoot, `SignalLab generator artifact ${name}`);
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.byteLength));
    generator.update(name, 'utf8').update(Buffer.of(0)).update(size).update(bytes);
  }
  return Object.freeze({
    contractSha256: sha256Hex(contractBytes),
    generatorSha256: generator.digest('hex'),
  });
}

async function readAdmittedArtifact(path: string, repositoryRoot: string, label: string): Promise<Buffer> {
  if (!path.startsWith(`${repositoryRoot}${sep}`)) throw new Error(`${label} escapes the SignalLab repository`);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (await realpath(path) !== path) throw new Error(`${label} path must not contain indirection`);
  if ((metadata.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid() && metadata.uid !== 0) {
    throw new Error(`${label} must be owned by the current user or root`);
  }
  return readFile(path);
}

function verifySignalLabContractDocument(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SignalLab measurement contract must be an object');
  }
  const contract = value as Record<string, unknown>;
  if (contract.documentType !== 'contract-manifest'
    || contract.contractId !== 'tinysa-signal-lab-atomizer-measurement'
    || contract.contractVersion !== 1
    || contract.status !== 'active') {
    throw new Error('SignalLab measurement contract identity is not the admitted active v1 contract');
  }
  const hashes = contract.identityHashes;
  if (typeof hashes !== 'object' || hashes === null || Array.isArray(hashes)
    || (hashes as Record<string, unknown>).contractSha256 !== 'sha256-of-the-exact-loaded-contract-json-bytes'
    || (hashes as Record<string, unknown>).catalogSha256 !== 'sha256-of-the-runtime-canonical-catalog-json'
    || (hashes as Record<string, unknown>).generatorSha256 !== 'sha256-length-framed-aggregate-of-every-shipped-runtime-javascript-artifact') {
    throw new Error('SignalLab measurement contract does not declare the admitted identity-hash semantics');
  }
}

function assertArtifactEvidence(
  actual: SignalLabArtifactEvidence,
  expected: SignalLabArtifactEvidence,
  label: string,
): void {
  if (actual.contractSha256 !== expected.contractSha256
    || actual.generatorSha256 !== expected.generatorSha256) throw new Error(label);
}

function assertBridgeIdentity(
  identity: SignalLabBridgeIdentity,
  artifacts: SignalLabArtifactEvidence,
  catalogSha256: string,
): void {
  if (identity.contractSha256 !== artifacts.contractSha256) {
    throw new Error('SignalLab bridge contract hash does not match independently loaded bytes');
  }
  if (identity.generatorSha256 !== artifacts.generatorSha256) {
    throw new Error('SignalLab bridge generator hash does not match independently loaded artifacts');
  }
  if (identity.catalogSha256 !== catalogSha256) {
    throw new Error('SignalLab bridge catalog hash does not match independently canonicalized catalog evidence');
  }
}

function localTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('SignalLab local verification clock returned an invalid Date');
  return value.toISOString();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return (raw.trim() || 'Unknown SignalLab failure').slice(0, 4_096);
}
