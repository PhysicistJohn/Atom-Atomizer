import type {
  InstrumentCandidate,
  InstrumentDiscoveryFailure,
  InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import { sameInstrumentCandidateDescriptor } from './ui-contracts.js';

/**
 * `InstrumentManager` rejects `connect()` for any candidate that does not
 * exactly match its own latest completed discovery -- including a discovery
 * the caller never itself requested. Two independent startup paths each
 * running `discover()` is enough: whichever completes last invalidates the
 * other's candidates.
 *
 * A stale candidate is always structurally recoverable: the underlying device
 * did not change, only the opaque discovery revision did. Re-discovering and
 * matching the same device by its stable identity (everything but
 * `discoveryRevision` -- see `sameInstrumentCandidateDescriptor`) and retrying
 * once is strictly better than surfacing a confusing internal
 * revision-mismatch message an operator has no way to act on.
 *
 * Shared so every connect path gets the recovery, rather than only the ones
 * that remembered to implement it.
 */
export function isStaleCandidateMessage(value: unknown): boolean {
  const message = (value instanceof Error ? value.message : String(value)).toLowerCase();
  return message.includes('stale') && message.includes('discovery');
}

export interface InstrumentConnectIo {
  readonly connect: (candidate: InstrumentCandidate) => Promise<InstrumentSessionSnapshot>;
  readonly discover: () => Promise<{
    readonly candidates: readonly InstrumentCandidate[];
    readonly failures: readonly InstrumentDiscoveryFailure[];
  }>;
  /** Lets a caller that keeps candidate state adopt the retry's discovery. */
  readonly acceptDiscovery?: (
    candidates: readonly InstrumentCandidate[],
    failures: readonly InstrumentDiscoveryFailure[],
  ) => void;
}

/**
 * Connect, and on a stale-candidate rejection re-discover and retry exactly
 * once. This must never loop: a device that has genuinely disappeared, or a
 * second stale rejection, surfaces a real error instead of retrying forever.
 */
export async function connectWithStaleCandidateRetry(
  candidate: InstrumentCandidate,
  io: InstrumentConnectIo,
): Promise<InstrumentSessionSnapshot> {
  try {
    return await io.connect(candidate);
  } catch (value) {
    if (!isStaleCandidateMessage(value)) throw value;
    const fresh = await io.discover();
    io.acceptDiscovery?.(fresh.candidates, fresh.failures);
    const rematched = fresh.candidates.find(
      (current) => sameInstrumentCandidateDescriptor(current, candidate),
    );
    if (!rematched) {
      throw new Error(
        `${candidate.displayName} is no longer in the discovered instrument list -- it may have disappeared. Refresh and try again.`,
      );
    }
    return io.connect(rematched);
  }
}
