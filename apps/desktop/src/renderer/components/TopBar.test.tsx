// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtomizerInstrumentState, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { TopBar } from './TopBar.js';

afterEach(cleanup);

const physicalSession = {
  sessionId: 'session-topbar-generic',
  candidate: { displayName: 'Fallback instrument' },
  provenance: { execution: 'physical', transport: 'network-bridge' },
  rfOutput: 'not-supported',
} as unknown as InstrumentSessionSnapshot;

function instrument(session: InstrumentSessionSnapshot): Pick<AtomizerInstrumentState, 'startup' | 'session'> {
  return {
    startup: { status: 'connected', connectedAt: '2026-08-01T12:00:00.000Z' },
    session,
  };
}

describe('TopBar generic session presentation', () => {
  it('uses a candidate name and shared execution/transport fields for a physical session', () => {
    render(<TopBar
      instrument={instrument(physicalSession)}
      agentOpen={false}
      agentConfigured={false}
      onConnection={vi.fn()}
      onAgent={vi.fn()}
    />);

    expect(screen.getByRole('button', { name: /Fallback instrument.*Physical Session.*Network Bridge/i })).toBeTruthy();
    expect(screen.queryByText('VIRTUAL INSTRUMENT')).toBeNull();
  });

  it('marks any non-physical session generically without inspecting its source identity', () => {
    const virtual = {
      ...physicalSession,
      candidate: { displayName: 'Virtual fallback instrument' },
      provenance: { execution: 'firmware-executed-twin', transport: 'virtual-bridge' },
    } as unknown as InstrumentSessionSnapshot;
    render(<TopBar
      instrument={instrument(virtual)}
      agentOpen={false}
      agentConfigured={false}
      onConnection={vi.fn()}
      onAgent={vi.fn()}
    />);

    expect(screen.getByText('VIRTUAL INSTRUMENT')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Virtual fallback instrument.*Virtual Session.*Virtual Bridge/i })).toBeTruthy();
  });
});
