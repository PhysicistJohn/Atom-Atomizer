import type { InstrumentTransportKind, PortCandidate } from '@tinysa/contracts';

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
export interface ByteTransport {
  readonly kind: InstrumentTransportKind;
  list(): Promise<PortCandidate[]>;
  open(candidate: PortCandidate): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onBytes(listener: (bytes: Uint8Array) => void): () => void;
  onEvent(listener: (event: TransportEvent) => void): () => void;
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined;
}
