import { z } from 'zod';
import {
  instrumentCandidateSchema,
  instrumentConfigurationSchema,
  instrumentConfigurationStateSchema,
  instrumentDiscoveryResultSchema,
  instrumentDriverIdSchema,
  instrumentFeatureRequestSchema,
  instrumentFeatureResultSchema,
  instrumentManagerEventSchema,
  instrumentMeasurementSchema,
  instrumentOpaqueIdSchema,
  instrumentSessionSnapshotSchema,
  instrumentSourceKindSchema,
  instrumentTimestampSchema,
  type InstrumentCandidate,
  type InstrumentConfiguration,
  type InstrumentConfigurationState,
  type InstrumentDiscoveryResult,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentSessionSnapshot,
} from './instrument.js';

export const ATOMIZER_INSTRUMENT_API_VERSION = 1 as const;

/**
 * Main-process-owned startup preference. It selects an already registered
 * driver/candidate tuple and never contains an executable path, transport
 * configuration, or other renderer-controlled composition data. `candidateId`
 * remains optional only so already-persisted v1 preferences can be read and
 * fail safely on ambiguity; every new selection must include it.
 */
export const atomizerInstrumentPreferenceSchema = z.object({
  schemaVersion: z.literal(ATOMIZER_INSTRUMENT_API_VERSION),
  driverId: instrumentDriverIdSchema,
  candidateKind: instrumentSourceKindSchema.optional(),
  candidateId: instrumentOpaqueIdSchema.optional(),
  updatedAt: instrumentTimestampSchema,
}).strict().superRefine((preference, context) => {
  if (preference.candidateId !== undefined && preference.candidateKind === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['candidateKind'],
      message: 'An exact startup candidate ID requires its source kind',
    });
  }
});
export type AtomizerInstrumentPreference = z.infer<typeof atomizerInstrumentPreferenceSchema>;

export const atomizerInstrumentPreferenceSelectionSchema = z.object({
  driverId: instrumentDriverIdSchema,
  candidateKind: instrumentSourceKindSchema,
  candidateId: instrumentOpaqueIdSchema,
}).strict();
export type AtomizerInstrumentPreferenceSelection = z.infer<typeof atomizerInstrumentPreferenceSelectionSchema>;

export const atomizerInstrumentPreferenceStateSchema = z.object({
  source: z.enum(['factory-default', 'persisted']),
  preference: atomizerInstrumentPreferenceSchema,
}).strict();
export type AtomizerInstrumentPreferenceState = z.infer<typeof atomizerInstrumentPreferenceStateSchema>;

export const atomizerInstrumentStartupStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-started') }).strict(),
  z.object({
    status: z.literal('connected'),
    connectedAt: instrumentTimestampSchema,
  }).strict(),
  z.object({
    status: z.literal('failed'),
    stage: z.enum(['preference-load', 'discovery', 'admission', 'connect']),
    message: z.string().trim().min(1).max(4_096),
    failedAt: instrumentTimestampSchema,
  }).strict(),
]);
export type AtomizerInstrumentStartupState = z.infer<typeof atomizerInstrumentStartupStateSchema>;

export const atomizerInstrumentStreamingStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('stopped') }).strict(),
  z.object({
    status: z.literal('running'),
    startedAt: instrumentTimestampSchema,
  }).strict(),
  z.object({
    status: z.literal('faulted'),
    message: z.string().trim().min(1).max(4_096),
    failedAt: instrumentTimestampSchema,
  }).strict(),
]);
export type AtomizerInstrumentStreamingState = z.infer<typeof atomizerInstrumentStreamingStateSchema>;

export const atomizerInstrumentConnectionCleanupStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-required') }).strict(),
  z.object({
    status: z.literal('required'),
    driverId: instrumentDriverIdSchema,
    phase: z.enum(['driver-pending', 'rejected-session']),
  }).strict(),
]);
export type AtomizerInstrumentConnectionCleanupState = z.infer<typeof atomizerInstrumentConnectionCleanupStateSchema>;

export const atomizerInstrumentStateSchema = z.object({
  schemaVersion: z.literal(ATOMIZER_INSTRUMENT_API_VERSION),
  startup: atomizerInstrumentStartupStateSchema,
  streaming: atomizerInstrumentStreamingStateSchema,
  connectionCleanup: atomizerInstrumentConnectionCleanupStateSchema,
  preference: atomizerInstrumentPreferenceStateSchema.optional(),
  session: instrumentSessionSnapshotSchema.optional(),
}).strict();
export type AtomizerInstrumentState = z.infer<typeof atomizerInstrumentStateSchema>;

/** Atomic feature acknowledgement plus the authoritative post-command session state. */
export const atomizerInstrumentFeatureExecutionSchema = z.object({
  result: instrumentFeatureResultSchema,
  session: instrumentSessionSnapshotSchema,
}).strict().superRefine((execution, context) => {
  if (execution.result.sessionId !== execution.session.sessionId) {
    context.addIssue({ code: 'custom', path: ['session'], message: 'Feature result and session snapshot must identify the same session' });
  }
});
export type AtomizerInstrumentFeatureExecution = z.infer<typeof atomizerInstrumentFeatureExecutionSchema>;

const atomizerInstrumentHostEventSchema = z.union([
  z.object({
    type: z.literal('preference'),
    preference: atomizerInstrumentPreferenceStateSchema,
  }).strict(),
  z.object({
    type: z.literal('startup'),
    startup: atomizerInstrumentStartupStateSchema,
  }).strict(),
  z.object({
    type: z.literal('streaming'),
    streaming: atomizerInstrumentStreamingStateSchema,
  }).strict(),
  z.object({
    type: z.literal('connection-cleanup'),
    connectionCleanup: atomizerInstrumentConnectionCleanupStateSchema,
  }).strict(),
]);

/** Manager events remain first-class at the renderer boundary. */
export const atomizerInstrumentEventSchema = z.union([
  instrumentManagerEventSchema,
  atomizerInstrumentHostEventSchema,
]);
export type AtomizerInstrumentEvent = z.infer<typeof atomizerInstrumentEventSchema>;

/** Public, versioned renderer API. Every mutating operation is main-owned. */
export interface AtomizerInstrumentApiV1 {
  readonly version: typeof ATOMIZER_INSTRUMENT_API_VERSION;
  getState(): Promise<AtomizerInstrumentState>;
  discover(): Promise<InstrumentDiscoveryResult>;
  connect(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot>;
  disconnect(): Promise<void>;
  configure(configuration: InstrumentConfiguration): Promise<InstrumentConfigurationState>;
  acquire(): Promise<InstrumentMeasurement>;
  startStreaming(): Promise<AtomizerInstrumentStreamingState>;
  stopStreaming(): Promise<AtomizerInstrumentStreamingState>;
  executeFeature(request: InstrumentFeatureRequest): Promise<AtomizerInstrumentFeatureExecution>;
  readPreference(): Promise<AtomizerInstrumentPreferenceState>;
  writePreference(selection: AtomizerInstrumentPreferenceSelection): Promise<AtomizerInstrumentPreferenceState>;
  subscribe(listener: (event: AtomizerInstrumentEvent) => void): () => void;
}

// Keep these schemas reachable from one contract module for IPC implementers.
export const atomizerInstrumentIpcRequestSchemas = Object.freeze({
  connect: instrumentCandidateSchema,
  configure: instrumentConfigurationSchema,
  executeFeature: instrumentFeatureRequestSchema,
  writePreference: atomizerInstrumentPreferenceSelectionSchema,
});
