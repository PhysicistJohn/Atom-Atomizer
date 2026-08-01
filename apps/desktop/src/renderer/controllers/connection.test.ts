// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentCandidate, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { createRendererRuntime } from '../AppShell.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * A candidate exactly as `InstrumentManager.#discover()` produces one: an
 * opaque `discoveryRevision` is the only field that changes between two
 * discovery passes for the "same" device.
 */
function neptuneCandidate(discoveryRevision: string): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210:ip:10.0.0.250',
    displayName: 'NeptuneSDR P210',
    sourceKind: 'neptune-p210',
    neptuneP210: { endpoint: 'ip:10.0.0.250' },
    discoveryRevision,
  } as InstrumentCandidate;
}

function fakeSession(candidate: InstrumentCandidate): InstrumentSessionSnapshot {
  return {
    sessionId: 'session-1',
    driverId: candidate.driverId,
    candidate,
    provenance: { sourceKind: candidate.sourceKind } as InstrumentSessionSnapshot['provenance'],
    capabilities: { schemaVersion: 1, acquisitions: [], features: [] } as InstrumentSessionSnapshot['capabilities'],
    rfOutput: 'not-supported',
    rfOutputQualification: 'not-applicable',
  } as unknown as InstrumentSessionSnapshot;
}

const STALE_MESSAGE = 'Instrument candidate is stale or was not produced by the latest completed discovery';

describe('ConnectionController stale-candidate recovery', () => {
  it('re-discovers, matches the same device by stable identity, and retries connect() exactly once on success', async () => {
    const staleCandidate = neptuneCandidate('discovery:1');
    const freshCandidate = neptuneCandidate('discovery:2');
    const session = fakeSession(freshCandidate);

    const connect = vi.fn()
      .mockRejectedValueOnce(new Error(STALE_MESSAGE))
      .mockResolvedValueOnce(session);
    const discover = vi.fn().mockResolvedValue({ candidates: [freshCandidate], failures: [] });
    vi.stubGlobal('atomizerInstrument', { connect, discover, disconnect: vi.fn() });

    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    const result = await runtime.connection.connectCandidateOwned(staleCandidate);

    expect(result).toBe(session);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, staleCandidate);
    expect(connect).toHaveBeenNthCalledWith(2, freshCandidate);
    expect(discover).toHaveBeenCalledTimes(1);
    // The store's candidate list is refreshed from the recovery discovery too,
    // not just the eventually-successful session -- an operator reopening the
    // dialog immediately after must see the current, non-stale list.
    expect(runtime.store.get().candidates).toEqual([freshCandidate]);
    expect(runtime.store.get().error).toBeUndefined();
    expect(runtime.store.get().connectionOpen).toBe(false);
  });

  it('surfaces a clear, honest error and never retries when the device is no longer in the fresh discovery at all', async () => {
    const staleCandidate = neptuneCandidate('discovery:1');
    const connect = vi.fn().mockRejectedValueOnce(new Error(STALE_MESSAGE));
    const discover = vi.fn().mockResolvedValue({ candidates: [], failures: [] });
    vi.stubGlobal('atomizerInstrument', { connect, discover, disconnect: vi.fn() });

    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    await expect(runtime.connection.connectCandidateOwned(staleCandidate)).rejects.toThrow(/no longer in the discovered instrument list/i);

    expect(connect).toHaveBeenCalledTimes(1); // never retried against a device that isn't there
    expect(discover).toHaveBeenCalledTimes(1);
    expect(runtime.store.get().error).toMatch(/no longer in the discovered instrument list/i);
  });

  it('surfaces the real second failure plainly when the retried connect() also fails, without looping again', async () => {
    const staleCandidate = neptuneCandidate('discovery:1');
    const freshCandidate = neptuneCandidate('discovery:2');
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error(STALE_MESSAGE))
      .mockRejectedValueOnce(new Error('Neptune P210 connection-first probe failed: unreachable'));
    const discover = vi.fn().mockResolvedValue({ candidates: [freshCandidate], failures: [] });
    vi.stubGlobal('atomizerInstrument', { connect, discover, disconnect: vi.fn() });

    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    await expect(runtime.connection.connectCandidateOwned(staleCandidate)).rejects.toThrow(/unreachable/);

    expect(connect).toHaveBeenCalledTimes(2); // exactly one retry, never a second re-discovery loop
    expect(discover).toHaveBeenCalledTimes(1);
    expect(runtime.store.get().error).toMatch(/unreachable/);
  });

  it('never triggers the recovery dance for an ordinary (non-stale) connect failure', async () => {
    const candidate = neptuneCandidate('discovery:1');
    const connect = vi.fn().mockRejectedValueOnce(new Error('Neptune P210 connection-first probe failed: unreachable'));
    const discover = vi.fn();
    vi.stubGlobal('atomizerInstrument', { connect, discover, disconnect: vi.fn() });

    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    await expect(runtime.connection.connectCandidateOwned(candidate)).rejects.toThrow(/unreachable/);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
  });
});
