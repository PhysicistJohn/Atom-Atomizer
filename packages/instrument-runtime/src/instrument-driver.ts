import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  MAX_INSTRUMENT_SOURCE_KINDS_V1,
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
  instrumentSessionProvenanceSchema,
  instrumentSessionEventSchema,
  instrumentSourceKindSchema,
  type InstrumentCandidate,
  type InstrumentCandidateDescriptor,
  type InstrumentCapabilities,
  type InstrumentConfigurationCommand,
  type InstrumentDriverId,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentRfOutputState,
  type InstrumentSessionProvenance,
  type InstrumentSessionEvent,
  type InstrumentSourceKind,
} from '@tinysa/contracts';

export interface InstrumentSession {
  readonly sessionId: string;
  readonly driverId: InstrumentDriverId;
  readonly candidate: InstrumentCandidate;
  readonly provenance: InstrumentSessionProvenance;
  readonly capabilities: InstrumentCapabilities;
  readonly rfOutput: InstrumentRfOutputState;
  /** Sends every complete admitted field or rejects it; drivers never normalize/drop fields, and report readback qualification separately. */
  configure(command: InstrumentConfigurationCommand): Promise<void>;
  acquire(): Promise<InstrumentMeasurement>;
  executeFeature(command: InstrumentFeatureCommand): Promise<InstrumentFeatureResult>;
  disconnect(): Promise<void>;
  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void;
}

export interface InstrumentDriver {
  readonly driverId: InstrumentDriverId;
  readonly sourceKinds: readonly InstrumentSourceKind[];
  discover(): Promise<InstrumentDriverDiscoveryResult>;
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

export function validateInstrumentDriver(driver: InstrumentDriver): InstrumentDriver {
  let driverId: InstrumentDriverId;
  let sourceKinds: readonly InstrumentSourceKind[];
  try {
    driverId = instrumentDriverIdSchema.parse(driver.driverId);
    sourceKinds = driverSourceKindsSchema.parse(driver.sourceKinds);
    if (typeof driver.discover !== 'function'
      || typeof driver.connect !== 'function'
      || typeof driver.cleanupPendingConnection !== 'function') {
      throw new TypeError('Driver must implement discover, connect, and pending-connection cleanup');
    }
  } catch (value) {
    throw new InstrumentDriverContractError(`Invalid instrument driver definition: ${message(value)}`, { cause: value });
  }
  return Object.freeze({
    driverId,
    sourceKinds: Object.freeze([...sourceKinds]),
    discover: () => driver.discover(),
    connect: (candidate: InstrumentCandidate) => driver.connect(candidate),
    cleanupPendingConnection: () => driver.cleanupPendingConnection(),
  });
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
  if (!isDeepStrictEqual(sessionCandidate, candidate)) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session for a different candidate`);
  }
  try { instrumentOpaqueIdSchema.parse(session.sessionId); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session without a valid opaque session ID`, { cause: error }); }
  let capabilities: InstrumentCapabilities;
  try { capabilities = instrumentCapabilitiesSchema.parse(session.capabilities); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session with invalid capabilities`, { cause: error }); }
  let provenance: InstrumentSessionProvenance;
  try { provenance = instrumentSessionProvenanceSchema.parse(session.provenance); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session with invalid provenance`, { cause: error }); }
  assertProvenanceBinding(candidate, provenance, driver.driverId);
  assertCapabilitySourceBinding(candidate, capabilities, driver.driverId);
  let rfOutput: InstrumentRfOutputState;
  try { rfOutput = instrumentRfOutputStateSchema.parse(session.rfOutput); }
  catch (error) { throw new InstrumentDriverContractError(`Driver ${driver.driverId} opened a session without valid RF output state`, { cause: error }); }
  const supportsRf = capabilities.features.some((feature) => feature.kind === 'rf-generator');
  if (supportsRf === (rfOutput === 'not-supported')) {
    throw new InstrumentDriverContractError(`Driver ${driver.driverId} RF output state does not match its advertised capability`);
  }
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
    capabilities,
    rfOutput,
    configure: (command: InstrumentConfigurationCommand) => session.configure(command),
    acquire: () => session.acquire(),
    executeFeature: (command: InstrumentFeatureCommand) => session.executeFeature(command),
    disconnect: () => session.disconnect(),
    subscribe: (listener: (event: InstrumentSessionEvent) => void) => session.subscribe(listener),
  });
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
      if (!isDeepStrictEqual(candidate.serialPort, provenance.serialPort)) {
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
