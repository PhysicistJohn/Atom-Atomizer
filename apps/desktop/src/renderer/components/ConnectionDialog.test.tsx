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
      onAddManualEndpoint={vi.fn(async () => true)}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    expect(within(dialog).getByRole('button', { name: /TinySA physical A.*STARTUP DEFAULT/i })).toBeTruthy();
    const secondCandidate = within(dialog).getByRole('button', { name: /TinySA physical B/i });
    expect(secondCandidate.textContent).not.toMatch(/STARTUP DEFAULT/);
    expect(secondCandidate.textContent).toMatch(/Driver-provided connection candidate/i);
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
      onAddManualEndpoint={vi.fn(async () => true)}
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

describe('ConnectionDialog driver candidates', () => {
  it('renders distinct driver-provided candidates through one generic connection affordance', () => {
    const physical = neptuneP210Candidate();
    const twin = neptuneP210TwinCandidate();
    const onChoose = vi.fn();
    render(<ConnectionDialog
      candidates={[physical, twin]}
      busy={false}
      failures={[]}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={onChoose}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={vi.fn()}
      onAddManualEndpoint={vi.fn(async () => true)}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    const candidateButtons = within(dialog).getAllByRole('button', { name: /NeptuneSDR P210/i });
    const physicalButton = candidateButtons.find((button) => !/QEMU twin/i.test(button.textContent ?? ''));
    const twinButton = candidateButtons.find((button) => /QEMU twin/i.test(button.textContent ?? ''));
    if (!physicalButton || !twinButton) throw new Error('Expected both a physical and QEMU-twin Neptune candidate button');
    expect(physicalButton.textContent).toMatch(/Driver-provided connection candidate/i);
    expect(twinButton.textContent).toMatch(/Driver-provided connection candidate/i);

    fireEvent.click(physicalButton);
    expect(onChoose).toHaveBeenCalledWith(instrumentCandidateUiKey(physical));
  });

  it('reflects driver-reported discovery failures verbatim without exposing a renderer-selected driver name', () => {
    render(<ConnectionDialog
      candidates={[]}
      busy={false}
      failures={[{ driverId: 'neptune-p210', sourceKind: 'neptune-p210', code: 'source-unavailable', recoverable: true, message: 'NEPTUNE_P210_ENDPOINT probe failed: connection refused' }]}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={vi.fn()}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={vi.fn()}
      onAddManualEndpoint={vi.fn(async () => true)}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    expect(within(dialog).getByRole('status').textContent).toMatch(/NEPTUNE_P210_ENDPOINT probe failed: connection refused/);
  });

  it('describes generic discovery limits honestly when no candidates or failures were reported', () => {
    render(<ConnectionDialog
      candidates={[]}
      busy={false}
      failures={[]}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={vi.fn()}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={vi.fn()}
      onAddManualEndpoint={vi.fn(async () => true)}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    const emptyState = within(dialog).getByText('No instrument source found').closest('.no-ports');
    expect(emptyState?.textContent).toMatch(/rechecks remembered network addresses/i);
    expect(emptyState?.textContent).toMatch(/routed network/i);
    expect(emptyState?.textContent).not.toMatch(/no .*network .*found/i);
  });
});

describe('ConnectionDialog manual network endpoint entry', () => {
  it('is disabled until an address is typed, then submits it and clears on success', async () => {
    const onAddManualEndpoint = vi.fn(async () => true);
    render(<ConnectionDialog
      candidates={[]}
      busy={false}
      failures={[]}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={vi.fn()}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={vi.fn()}
      onAddManualEndpoint={onAddManualEndpoint}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    const input = within(dialog).getByLabelText('Connect by network address') as HTMLInputElement;
    const addButton = within(dialog).getByRole('button', { name: /^Add address$/i }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: ' ip:10.0.0.250 ' } });
    expect(addButton.disabled).toBe(false);
    fireEvent.click(addButton);
    expect(onAddManualEndpoint).toHaveBeenCalledWith(' ip:10.0.0.250 ');

    await vi.waitFor(() => expect(input.value).toBe(''));
  });

  it('keeps the typed address in the field when the add attempt fails, so the operator can see and fix it', async () => {
    const onAddManualEndpoint = vi.fn(async () => false);
    render(<ConnectionDialog
      candidates={[]}
      busy={false}
      failures={[]}
      error="Neptune P210 connection-first probe failed: unreachable"
      connectionCleanup={{ status: 'not-required' }}
      onChoose={vi.fn()}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={vi.fn()}
      onAddManualEndpoint={onAddManualEndpoint}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    const input = within(dialog).getByLabelText('Connect by network address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ip:10.0.0.251' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add address$/i }));

    await vi.waitFor(() => expect(onAddManualEndpoint).toHaveBeenCalled());
    expect(input.value).toBe('ip:10.0.0.251');
    expect(within(dialog).getByText(/unreachable/i)).toBeTruthy();
  });

  it('submits on Enter as well as clicking Add', async () => {
    const onAddManualEndpoint = vi.fn(async () => true);
    render(<ConnectionDialog
      candidates={[]}
      busy={false}
      failures={[]}
      connectionCleanup={{ status: 'not-required' }}
      onChoose={vi.fn()}
      onRefresh={vi.fn()}
      onDisconnect={vi.fn()}
      onMakeDefault={vi.fn()}
      onAddManualEndpoint={onAddManualEndpoint}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    const input = within(dialog).getByLabelText('Connect by network address');
    fireEvent.change(input, { target: { value: 'ip:10.0.0.250' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(onAddManualEndpoint).toHaveBeenCalledWith('ip:10.0.0.250'));
  });
});

function neptuneP210Candidate(): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210:ip:10.0.0.250',
    displayName: 'NeptuneSDR P210',
    sourceKind: 'neptune-p210',
    neptuneP210: { endpoint: 'ip:10.0.0.250' },
    discoveryRevision: 'discovery:1',
  };
}

function neptuneP210TwinCandidate(): InstrumentCandidate {
  return {
    schemaVersion: 1,
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210-twin:ip:127.0.0.1',
    displayName: 'NeptuneSDR P210 QEMU twin',
    sourceKind: 'neptune-p210-twin',
    neptuneP210Twin: { endpoint: 'ip:127.0.0.1', profile: 'qemu-development', physicalRfModeled: false },
    discoveryRevision: 'discovery:1',
  };
}

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
