// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtomizerInstrumentPreferenceState, InstrumentCandidate } from '@tinysa/contracts';
import { instrumentCandidateUiKey } from '../ui-contracts.js';
import { ConnectionDialog } from './ConnectionDialog.js';

afterEach(cleanup);

describe('ConnectionDialog startup preference identity', () => {
  it('marks only the exact physical candidate as preferred', () => {
    const first = physicalCandidate('serial:/dev/tty.usbmodem407', '/dev/tty.usbmodem407', 'TinySA physical A');
    const second = physicalCandidate('serial:/dev/tty.usbmodem408', '/dev/tty.usbmodem408', 'TinySA physical B');
    const onMakeDefault = vi.fn();
    const preference: AtomizerInstrumentPreferenceState = {
      source: 'persisted',
      preference: {
        schemaVersion: 1,
        driverId: first.driverId,
        candidateKind: first.sourceKind,
        candidateId: first.candidateId,
        updatedAt: '2026-07-14T20:00:00.000Z',
      },
    };

    render(<ConnectionDialog
      candidates={[first, second]}
      selectedId={instrumentCandidateUiKey(second)}
      busy={false}
      failures={[]}
      preference={preference}
      connected={false}
      connectionCleanup={{ status: 'not-required' }}
      onSelect={vi.fn()}
      onRefresh={vi.fn()}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={onMakeDefault}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Connect' });
    expect(within(dialog).getByRole('button', { name: /TinySA physical A.*STARTUP DEFAULT/i })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /TinySA physical B/i }).textContent).not.toMatch(/STARTUP DEFAULT/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use at startup' }));
    expect(onMakeDefault).toHaveBeenCalledOnce();
  });
});

function physicalCandidate(candidateId: string, path: string, displayName: string): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId: 'tinysa-zs407',
    candidateId,
    displayName,
    sourceKind: 'serial-port',
    serialPort: { path, vendorId: '0483', productId: '5740' },
    discoveryRevision: 'discovery:1',
  };
}
