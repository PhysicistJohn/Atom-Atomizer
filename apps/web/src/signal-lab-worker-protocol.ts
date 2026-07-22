import type {
  InstrumentCandidate,
  InstrumentCapabilities,
  InstrumentFeatureResult,
  InstrumentReceiveOnlySafetyState,
  InstrumentRfOutputState,
  InstrumentSessionEvent,
  InstrumentSessionProvenance,
} from '@tinysa/contracts';

export const BROWSER_SIGNAL_LAB_DRIVER_ID = 'signal-lab' as const;
export const BROWSER_SIGNAL_LAB_CANDIDATE_ID = 'signal-lab:default' as const;

export type SignalLabWorkerMethod =
  | 'discover'
  | 'connect'
  | 'configure'
  | 'acquire'
  | 'execute-feature'
  | 'disconnect'
  | 'cleanup-pending-connection';

export interface SignalLabWorkerRequest {
  readonly kind: 'request';
  readonly requestId: number;
  readonly method: SignalLabWorkerMethod;
  readonly payload?: unknown;
}

export interface SignalLabWorkerSessionDescriptor {
  readonly sessionId: string;
  readonly driverId: typeof BROWSER_SIGNAL_LAB_DRIVER_ID;
  readonly candidate: InstrumentCandidate;
  readonly provenance: InstrumentSessionProvenance;
  readonly capabilities: InstrumentCapabilities;
  readonly rfOutput: InstrumentRfOutputState;
  readonly receiveOnlySafety?: InstrumentReceiveOnlySafetyState;
}

export interface SignalLabWorkerFeatureExecution {
  readonly result: InstrumentFeatureResult;
  readonly session: SignalLabWorkerSessionDescriptor;
}

export interface SignalLabWorkerSerializedError {
  readonly name: string;
  readonly message: string;
}

export type SignalLabWorkerResponse =
  | { readonly kind: 'response'; readonly requestId: number; readonly ok: true; readonly result: unknown }
  | { readonly kind: 'response'; readonly requestId: number; readonly ok: false; readonly error: SignalLabWorkerSerializedError };

export interface SignalLabWorkerSessionEventMessage {
  readonly kind: 'session-event';
  readonly event: InstrumentSessionEvent;
}

export type SignalLabWorkerMessage = SignalLabWorkerResponse | SignalLabWorkerSessionEventMessage;
