// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentCandidate, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { createRendererRuntime } from '../AppShell.js';
import { candidateSessionIsVirtual, connectedCandidateKey } from './connection.js';
import { instrumentCandidateUiKey } from '../ui-contracts.js';

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
    expect(runtime.store.get().secondaryPanel).toBeUndefined();
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

describe('ConnectionController generic candidate identity', () => {
  it('matches the active session to a refreshed candidate through the driver-owned descriptor', () => {
    const connected = neptuneCandidate('discovery:1');
    const refreshed = neptuneCandidate('discovery:2');

    expect(connectedCandidateKey({
      instrument: {
        schemaVersion: 1,
        startup: { status: 'not-started' },
        streaming: { status: 'stopped' },
        connectionCleanup: { status: 'not-required' },
        session: fakeSession(connected),
      },
      candidates: [refreshed],
    })).toBe(instrumentCandidateUiKey(refreshed));
  });

  it('does not infer execution from a candidate family and reads it only from a matched session', () => {
    const candidate = neptuneCandidate('discovery:1');
    const physical = {
      candidate,
      provenance: { execution: 'physical' },
    } as Pick<InstrumentSessionSnapshot, 'candidate' | 'provenance'>;
    const virtual = {
      candidate,
      provenance: { execution: 'driver-virtual' },
    } as unknown as Pick<InstrumentSessionSnapshot, 'candidate' | 'provenance'>;

    expect(candidateSessionIsVirtual(candidate, undefined)).toBeUndefined();
    expect(candidateSessionIsVirtual(candidate, physical)).toBe(false);
    expect(candidateSessionIsVirtual(candidate, virtual)).toBe(true);
  });
});

describe('ConnectionController manual network endpoint', () => {
  it('uses the generic instrument boundary, then refreshes the regular candidate list after admission', async () => {
    const candidate = neptuneCandidate('discovery:1');
    const addManualEndpoint = vi.fn().mockResolvedValue({ ok: true });
    const discover = vi.fn().mockResolvedValue({ candidates: [candidate], failures: [] });
    vi.stubGlobal('atomizerInstrument', { addManualEndpoint, discover });

    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    await expect(runtime.connection.addManualEndpoint(' ip:10.0.0.250 ')).resolves.toBe(true);

    expect(addManualEndpoint).toHaveBeenCalledWith(' ip:10.0.0.250 ');
    expect(discover).toHaveBeenCalledOnce();
    expect(runtime.store.get().candidates).toEqual([candidate]);
  });

  it('surfaces an admission failure without refreshing candidates', async () => {
    const addManualEndpoint = vi.fn().mockResolvedValue({ ok: false, message: 'Address did not respond' });
    const discover = vi.fn();
    vi.stubGlobal('atomizerInstrument', { addManualEndpoint, discover });

    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    await expect(runtime.connection.addManualEndpoint('ip:10.0.0.251')).resolves.toBe(false);

    expect(discover).not.toHaveBeenCalled();
    expect(runtime.store.get().error).toBe('Address did not respond');
  });
});
