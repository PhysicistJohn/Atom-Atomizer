import type { InstrumentSourceKind, InstrumentTransportKind, PortCandidate } from '@tinysa/contracts';

export type TransportEvent = { type: 'opened' } | { type: 'closed'; reason?: string } | { type: 'error'; error: Error };
export interface TransportAcquisitionMetadata {
  source: 'renode-executable-state';
  startHz: number;
  stopHz: number;
  points: number;
  actualRbwHz: number;
  actualAttenuationDb: number;
  evidence: string;
}
export interface TransportDiscoveryFailure {
  sourceKind: InstrumentSourceKind;
  transport: InstrumentTransportKind;
  code: 'enumeration-failed';
  message: string;
  recoverable: true;
}
export interface TransportDiscoveryResult {
  candidates: readonly PortCandidate[];
  failures: readonly TransportDiscoveryFailure[];
}
export interface ByteTransport {
  readonly kind: InstrumentTransportKind;
  list(): Promise<TransportDiscoveryResult>;
  open(candidate: PortCandidate): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onBytes(listener: (bytes: Uint8Array) => void): () => void;
  onEvent(listener: (event: TransportEvent) => void): () => void;
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined;
}
