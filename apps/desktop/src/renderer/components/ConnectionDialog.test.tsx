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

    const onChoose = vi.fn();
    render(<ConnectionDialog
      candidates={[first, second]}
      selectedId={instrumentCandidateUiKey(second)}
      busy={false}
      failures={[]}
      preference={preference}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={onChoose}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={onMakeDefault}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    expect(within(dialog).getByRole('button', { name: /TinySA physical A.*STARTUP DEFAULT/i })).toBeTruthy();
    const secondCandidate = within(dialog).getByRole('button', { name: /TinySA physical B/i });
    expect(secondCandidate.textContent).not.toMatch(/STARTUP DEFAULT/);
    expect(secondCandidate.textContent).toMatch(/exclusive CDC; finish any Flasher session first/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use at startup' }));
    expect(onMakeDefault).toHaveBeenCalledOnce();
  });

  it('connects by selecting a source and marks the connected one', () => {
    const lab = signalLabCandidate();
    const phys = physicalCandidate('serial:/dev/tty.usbmodem407', '/dev/tty.usbmodem407', 'TinySA physical A');
    const onChoose = vi.fn();
    const onDisconnect = vi.fn();
    const session = {
      candidate: { driverId: phys.driverId, sourceKind: phys.sourceKind, candidateId: phys.candidateId },
    };
    render(<ConnectionDialog
      candidates={[lab, phys]}
      selectedId={instrumentCandidateUiKey(phys)}
      connectedId={instrumentCandidateUiKey(phys)}
      busy={false}
      failures={[]}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={onChoose}
      onRefresh={vi.fn()}
      onDisconnect={onDisconnect}
      onMakeDefault={vi.fn()}
      onClose={vi.fn()}
    />);
    void session;
    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    // No separate Connect button; picking a source is the connect action.
    expect(within(dialog).queryByRole('button', { name: /^Connect$/i })).toBeNull();
    const connected = within(dialog).getByRole('button', { name: /TinySA physical A/i });
    expect(connected.getAttribute('aria-pressed')).toBe('true');
    expect(connected.textContent).toMatch(/CONNECTED/);
    fireEvent.click(within(dialog).getByRole('button', { name: /SignalLab/i }));
    expect(onChoose).toHaveBeenCalledWith(instrumentCandidateUiKey(lab));
    fireEvent.click(within(dialog).getByRole('button', { name: /Disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});

function signalLabCandidate(): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId: 'tinysa-signal-lab',
    candidateId: 'signal-lab:default',
    displayName: 'SignalLab synthetic measurement source',
    sourceKind: 'signal-lab',
    signalLab: { sourceId: 'default' },
    discoveryRevision: 'discovery:1',
  };
}

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
