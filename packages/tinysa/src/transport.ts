import type { PortCandidate } from '@tinysa/contracts';

export type TransportEvent = { type: 'opened' } | { type: 'closed'; reason?: string } | { type: 'error'; error: Error };
export interface ByteTransport {
  list(): Promise<PortCandidate[]>;
  open(candidate: PortCandidate): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onBytes(listener: (bytes: Uint8Array) => void): () => void;
  onEvent(listener: (event: TransportEvent) => void): () => void;
}
