import { z } from 'zod';
import { structuralEqual } from './structural-equal.js';
import {
  MAX_INSTRUMENT_SOURCE_KINDS_V1,
  canonicalInstrumentSurfaceSchema,
  instrumentCandidateDescriptorSchema,
  instrumentCandidateSchema,
  instrumentCapabilitySourceBindingIssues,
  instrumentCapabilitiesSchema,
  instrumentConfigurationCommandSchema,
  instrumentDriverIdSchema,
  instrumentDriverDiscoveryResultSchema,
  instrumentFeatureCommandSchema,
  instrumentFeatureResultSchema,
  instrumentMeasurementSchema,
  instrumentOpaqueIdSchema,
  instrumentRfOutputStateSchema,
  instrumentReceiveOnlySafetyStateSchema,
  instrumentSessionProvenanceSchema,
  instrumentSessionEventSchema,
  instrumentSourceKindSchema,
  type InstrumentCandidate,
  type InstrumentCandidateDescriptor,
  type InstrumentCapabilities,
  type InstrumentConfiguration,
  type InstrumentConfigurationCommand,
  type InstrumentDriverId,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentRfOutputState,
  type InstrumentReceiveOnlySafetyState,
  type InstrumentSessionProvenance,
  type InstrumentSessionEvent,
  type InstrumentSourceKind,
  type CanonicalInstrumentSurface,
  type CanonicalOperationRequest,
} from '@tinysa/contracts';

/**
 * Driver-owned translation of one canonical operation.  Acquisition operations
 * resolve to the normal configuration lifecycle; state-changing source or
 * instrument operations resolve to an existing feature lifecycle.  The
 * renderer sees neither branch nor a native feature request: it receives the
 * refreshed canonical surface after the manager has serialized and admitted
 * the result.
 */
export type CanonicalOperationResolution =
  | { readonly configuration: InstrumentConfiguration; readonly feature?: never }
  | { readonly feature: InstrumentFeatureRequest; readonly configuration?: never };

/**
 * The one generic outcome for an operator-entered connection address.
 * Drivers may use any native discovery/probe protocol internally, but the
 * application only needs to know whether an address was admitted.
 */
export type InstrumentManualEndpointResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface InstrumentSession {
  readonly sessionId: string;
  readonly driverId: InstrumentDriverId;
  readonly candidate: InstrumentCandidate;
  readonly provenance: InstrumentSessionProvenance;
  readonly capabilities: InstrumentCapabilities;
  readonly rfOutput: InstrumentRfOutputState;
  /**
   * Optional while legacy drivers are being migrated.  A driver which exposes
   * this surface must also resolve it itself; the renderer never translates
   * device controls or chooses an Auto fallback.
   */
  readonly canonicalSurface?: CanonicalInstrumentSurface;
  /** Dynamic command-acknowledged receive-only state; never an RF measurement. */
  readonly receiveOnlySafety?: InstrumentReceiveOnlySafetyState;
  /** Sends every complete admitted field or rejects it; drivers never normalize/drop fields, and report readback qualification separately. */
  configure(command: InstrumentConfigurationCommand): Promise<void>;
  resolveCanonicalOperation?(request: CanonicalOperationRequest): Promise<CanonicalOperationResolution>;
  acquire(): Promise<InstrumentMeasurement>;
  executeFeature(command: InstrumentFeatureCommand): Promise<InstrumentFeatureResult>;
  disconnect(): Promise<void>;
  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void;
}

export interface InstrumentDriver {
  readonly driverId: InstrumentDriverId;
  readonly sourceKinds: readonly InstrumentSourceKind[];
  discover(): Promise<InstrumentDriverDiscoveryResult>;
  /**
   * Optional standard bootstrap for a manually entered address.  The driver
   * owns native address formats, discovery protocol, and remembered-device
   * policy; callers never choose a source kind or driver implementation.
   */
  addManualEndpoint?(endpoint: string): Promise<InstrumentManualEndpointResult>;
  connect(candidate: InstrumentCandidate): Promise<InstrumentSession>;
  /**
   * Cleans a connection/process retained when connect() failed before it could
   * return an InstrumentSession. Must be idempotent when no such lease exists.
   */
  cleanupPendingConnection(): Promise<void>;
}

export class InstrumentDriverContractError extends Error {
  override readonly name = 'InstrumentDriverContractError';
}

const driverSourceKindsSchema = z.array(instrumentSourceKindSchema)
  .min(1)
  .max(MAX_INSTRUMENT_SOURCE_KINDS_V1)
  .readonly()
  .superRefine((sourceKinds, context) => {
    if (new Set(sourceKinds).size !== sourceKinds.length) context.addIssue({ code: 'custom', message: 'Driver source kinds must be unique' });
  });

const instrumentManualEndpointResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), message: z.string().trim().min(1).max(512) }).strict(),
]);

export function validateInstrumentDriver(driver: InstrumentDriver): InstrumentDriver {
  let driverId: InstrumentDriverId;
  let sourceKinds: readonly InstrumentSourceKind[];
  // Drivers commonly implement this as a class method. Bind it once at the
  // validation boundary so registry dispatch never loses the driver instance
  // (and therefore never turns a valid address into a false negative).
  const addManualEndpoint = driver.addManualEndpoint?.bind(driver);
  try {
    driverId = instrumentDriverIdSchema.parse(driver.driverId);
    sourceKinds = driverSourceKindsSchema.parse(driver.sourceKinds);
    if (typeof driver.discover !== 'function'
      || typeof driver.connect !== 'function'
      || typeof driver.cleanupPendingConnection !== 'function') {
      throw new TypeError('Driver must implement discover, connect, and pending-connection cleanup');
    }
    if (addManualEndpoint !== undefined && typeof addManualEndpoint !== 'function') {
      throw new TypeError('Driver manual endpoint bootstrap must be a function when provided');
    }
  } catch (value) {
    throw new InstrumentDriverContractError(`Invalid instrument driver definition: ${message(value)}`, { cause: value });
  }
  return Object.freeze({
    driverId,
    sourceKinds: Object.freeze([...sourceKinds]),
    discover: () => driver.discover(),
    ...(addManualEndpoint === undefined ? {} : { addManualEndpoint: (endpoint: string) => addManualEndpoint(endpoint) }),
    connect: (candidate: InstrumentCandidate) => driver.connect(candidate),
    cleanupPendingConnection: () => driver.cleanupPendingConnection(),
  });
}

export function validateInstrumentManualEndpointResult(
  driver: InstrumentDriver,
  value: unknown,
): InstrumentManualEndpointResult {
  try { return instrumentManualEndpointResultSchema.parse(value); }
  catch (error) {
    throw new InstrumentDriverContractError(
      `Driver ${driver.driverId} returned an invalid manual-endpoint result: ${message(error)}`,
      { cause: error },
    );
  }
}

export function validateDriverCandidate(
  driver: InstrumentDriver,
  value: unknown,
): InstrumentCandidateDescriptor {
  let candidate: InstrumentCandidateDescriptor;
  try { candidate = instrumentCandidateDescriptorSchema.parse(value); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} returned an invalid candidate: ${message(error)}`, { cause: error }); }
  if (candidate.driverId !== driver.driverId) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} returned candidate ownership ${candidate.driverId}`);
  }
  if (!driver.sourceKinds.includes(candidate.sourceKind)) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} returned undeclared source kind ${candidate.sourceKind}`);
  }
  return candidate;
}

export function validateInstrumentDriverDiscoveryResult(
  driver: InstrumentDriver,
  value: unknown,
): InstrumentDriverDiscoveryResult {
  let result: InstrumentDriverDiscoveryResult;
  try { result = instrumentDriverDiscoveryResultSchema.parse(value); }
  catch (error) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} returned an invalid discovery result: ${message(error)}`, { cause: error });
  }
  const candidates = result.candidates.map((candidate) => validateDriverCandidate(driver, candidate));
  const identities = candidates.map((candidate) => `${candidate.driverId}\u0000${candidate.sourceKind}\u0000${candidate.candidateId}`);
  if (new Set(identities).size !== identities.length) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} returned duplicate candidate identities`);
  }
  for (const failure of result.failures) {
    if (failure.sourceKind !== undefined && !driver.sourceKinds.includes(failure.sourceKind)) {
      throw new InstrumentDriverContractError(`Driver ${driver.driverId} returned a failure for undeclared source kind ${failure.sourceKind}`);
    }
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    failures: Object.freeze([...result.failures]),
  });
}

export function validateInstrumentSession(
  driver: InstrumentDriver,
  candidateValue: InstrumentCandidate,
  sessionValue: unknown,
): InstrumentSession {
  const candidate = instrumentCandidateSchema.parse(candidateValue);
  if (!sessionValue || typeof sessionValue !== 'object') {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} did not return an instrument session object`);
  }
  const session = sessionValue as InstrumentSession;
  if (session.driverId !== driver.driverId) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened session owned by ${session.driverId}`);
  }
  let sessionCandidate: InstrumentCandidate;
  try { sessionCandidate = instrumentCandidateSchema.parse(session.candidate); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session with an invalid candidate`, { cause: error }); }
  if (!structuralEqual(sessionCandidate, candidate)) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session for a different candidate`);
  }
  try { instrumentOpaqueIdSchema.parse(session.sessionId); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session without a valid opaque session ID`, { cause: error }); }
  const capabilities = validateSessionCapabilities(
    driver,
    candidate,
    session.capabilities,
    'opened a session with invalid capabilities',
  );
  const canonicalSurface = validateCanonicalSurface(driver, session.canonicalSurface);
  if ((canonicalSurface === undefined) !== (session.resolveCanonicalOperation === undefined)) {
    throw new InstrumentDriverContractError(
      `Driver ${driver.driverId} must expose both canonicalSurface and resolveCanonicalOperation, or neither`,
    );
  }
  let provenance: InstrumentSessionProvenance;
  try { provenance = instrumentSessionProvenanceSchema.parse(session.provenance); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session with invalid provenance`, { cause: error }); }
  assertProvenanceBinding(candidate, provenance, driver.driverId);
  let rfOutput: InstrumentRfOutputState;
  try { rfOutput = instrumentRfOutputStateSchema.parse(session.rfOutput); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session without valid RF output state`, { cause: error }); }
  const supportsRf = capabilities.features.some((feature) => feature.kind === 'rf-generator');
  if (supportsRf === (rfOutput === 'not-supported')) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} RF output state does not match its advertised capability`);
  }
  validateReceiveOnlySafetyState(driver.driverId, session.sessionId, provenance, rfOutput, session.receiveOnlySafety);
  if (typeof session.configure !== 'function'
    || typeof session.acquire !== 'function'
    || typeof session.executeFeature !== 'function'
    || typeof session.disconnect !== 'function'
    || typeof session.subscribe !== 'function') {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session without the complete instrument lifecycle`);
  }
  return Object.freeze({
    sessionId: instrumentOpaqueIdSchema.parse(session.sessionId),
    driverId: session.driverId,
    candidate: sessionCandidate,
    provenance,
    get capabilities(): InstrumentCapabilities {
      return validateSessionCapabilities(
        driver,
        candidate,
        session.capabilities,
        'exposed invalid dynamic capabilities',
      );
    },
    get canonicalSurface(): CanonicalInstrumentSurface | undefined {
      return validateCanonicalSurface(driver, session.canonicalSurface);
    },
    rfOutput,
    get receiveOnlySafety(): InstrumentReceiveOnlySafetyState | undefined {
      return validateReceiveOnlySafetyState(
        driver.driverId,
        session.sessionId,
        provenance,
        rfOutput,
        session.receiveOnlySafety,
      );
    },
    configure: (command: InstrumentConfigurationCommand) => session.configure(command),
    resolveCanonicalOperation: session.resolveCanonicalOperation === undefined
      ? undefined
      : (request: CanonicalOperationRequest) => session.resolveCanonicalOperation!(request),
    acquire: () => session.acquire(),
    executeFeature: (command: InstrumentFeatureCommand) => session.executeFeature(command),
    disconnect: () => session.disconnect(),
    subscribe: (listener: (event: InstrumentSessionEvent) => void) => session.subscribe(listener),
  });
}

function validateCanonicalSurface(
  driver: InstrumentDriver,
  value: unknown,
): CanonicalInstrumentSurface | undefined {
  if (value === undefined) return undefined;
  try { return canonicalInstrumentSurfaceSchema.parse(value); }
  catch (error) {
    throw new InstrumentDriverContractError(
      `Driver ${driver.driverId} exposed an invalid canonical interaction surface: ${message(error)}`,
      { cause: error },
    );
  }
}

function validateSessionCapabilities(
  driver: InstrumentDriver,
  candidate: InstrumentCandidate,
  value: unknown,
  context: string,
): InstrumentCapabilities {
  let capabilities: InstrumentCapabilities;
  try { capabilities = instrumentCapabilitiesSchema.parse(value); }
  catch (error) {
    throw new InstrumentDriverContractError(
      `Driver ${driver.driverId} ${context}`,
      { cause: error },
    );
  }
  assertCapabilitySourceBinding(candidate, capabilities, driver.driverId);
  return capabilities;
}

function validateReceiveOnlySafetyState(
  driverId: InstrumentDriverId,
  sessionId: string,
  provenance: InstrumentSessionProvenance,
  rfOutput: InstrumentRfOutputState,
  value: unknown,
): InstrumentReceiveOnlySafetyState | undefined {
  if (value === undefined) return undefined;
  let state: InstrumentReceiveOnlySafetyState;
  try { state = instrumentReceiveOnlySafetyStateSchema.parse(value); }
  catch (error) {
    throw new InstrumentDriverContractError(
      `Driver ${driverId} exposed invalid receive-only safety state: ${message(error)}`,
      { cause: error },
    );
  }
  if (provenance.sourceKind !== 'serial-port' || provenance.execution !== 'physical') {
    throw new InstrumentDriverContractError(`Driver ${driverId} exposed receive-only safety state for a non-physical session`);
  }
  if (rfOutput !== 'not-supported') {
    throw new InstrumentDriverContractError(`Driver ${driverId} mixed receive-only safety state with advertised RF output control`);
  }
  if (state.connectionReceipt.sessionId !== sessionId || state.currentReceipt.sessionId !== sessionId) {
    throw new InstrumentDriverContractError(`Driver ${driverId} receive-only safety state belongs to another session`);
  }
  return state;
}

function assertCapabilitySourceBinding(
  candidate: InstrumentCandidate,
  capabilities: InstrumentCapabilities,
  driverId: InstrumentDriverId,
): void {
  const issue = instrumentCapabilitySourceBindingIssues(candidate.sourceKind, capabilities)[0];
  if (issue) throw new InstrumentDriverContractError(`Driver ${driverId} ${issue.message}`);
}

function assertProvenanceBinding(
  candidate: InstrumentCandidate,
  provenance: InstrumentSessionProvenance,
  driverId: InstrumentDriverId,
): void {
  if (provenance.sourceKind !== candidate.sourceKind) {
    throw new InstrumentDriverContractError(`Driver ${driverId} session provenance does not match candidate source kind`);
  }
  switch (candidate.sourceKind) {
    case 'serial-port': {
      if (provenance.sourceKind !== 'serial-port') throw new InstrumentDriverContractError(`Driver ${driverId} session provenance narrowing failed`);
      if (!structuralEqual(candidate.serialPort, provenance.serialPort)) {
        throw new InstrumentDriverContractError(`Driver ${driverId} session serial provenance does not match the admitted endpoint`);
      }
      break;
    }
    case 'tinysa-firmware-twin': {
      if (provenance.sourceKind !== 'tinysa-firmware-twin') throw new InstrumentDriverContractError(`Driver ${driverId} session provenance narrowing failed`);
      if (candidate.firmwareTwin.bridge !== provenance.bridge
        || candidate.firmwareTwin.repositoryCommit !== provenance.repositoryCommit
        || candidate.firmwareTwin.firmwareBinarySha256 !== provenance.firmwareBinarySha256
        || candidate.firmwareTwin.usbTransactionsModeled !== provenance.usbTransactionsModeled) {
        throw new InstrumentDriverContractError(`Driver ${driverId} session firmware-twin provenance does not match discovery evidence`);
      }
      break;
    }
    case 'signal-lab': {
      if (provenance.sourceKind !== 'signal-lab') throw new InstrumentDriverContractError(`Driver ${driverId} session provenance narrowing failed`);
      if (candidate.signalLab.sourceId !== provenance.sourceId) {
        throw new InstrumentDriverContractError(`Driver ${driverId} session SignalLab provenance does not match the admitted source`);
      }
      break;
    }
    case 'neptune-p210': {
      if (provenance.sourceKind !== 'neptune-p210') throw new InstrumentDriverContractError(`Driver ${driverId} session provenance narrowing failed`);
      if (candidate.neptuneP210.endpoint !== provenance.endpoint
        || candidate.neptuneP210.contextDescription !== provenance.contextDescription) {
        throw new InstrumentDriverContractError(`Driver ${driverId} session Neptune P210 provenance does not match the admitted endpoint`);
      }
      break;
    }
    case 'neptune-p210-twin': {
      if (provenance.sourceKind !== 'neptune-p210-twin') throw new InstrumentDriverContractError(`Driver ${driverId} session provenance narrowing failed`);
      if (candidate.neptuneP210Twin.endpoint !== provenance.endpoint
        || candidate.neptuneP210Twin.profile !== provenance.profile
        || candidate.neptuneP210Twin.physicalRfModeled !== provenance.physicalRfModeled) {
        throw new InstrumentDriverContractError(`Driver ${driverId} session Neptune P210 twin provenance does not match discovery evidence`);
      }
      break;
    }
    default: {
      const unhandledCandidate: never = candidate;
      throw new InstrumentDriverContractError(`Driver ${driverId} has no provenance binding for ${JSON.stringify(unhandledCandidate)}`);
    }
  }
}

export function parseInstrumentSessionEvent(value: unknown): InstrumentSessionEvent {
  return instrumentSessionEventSchema.parse(value);
}

export function parseInstrumentMeasurement(value: unknown): InstrumentMeasurement {
  return instrumentMeasurementSchema.parse(value);
}

export function parseInstrumentConfigurationCommand(value: unknown): InstrumentConfigurationCommand {
  return instrumentConfigurationCommandSchema.parse(value);
}

export function parseInstrumentFeatureCommand(value: unknown): InstrumentFeatureCommand {
  return instrumentFeatureCommandSchema.parse(value);
}

export function parseInstrumentFeatureResult(value: unknown): InstrumentFeatureResult {
  return instrumentFeatureResultSchema.parse(value);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
