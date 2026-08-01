// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalInstrumentSurface, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { DeviceWorkspace } from './DeviceWorkspace.js';

afterEach(cleanup);

const session = {
  sessionId: 'session-generic-view',
  driverId: 'generic-driver',
  candidate: { displayName: 'Fallback instrument' },
  provenance: {
    execution: 'physical',
    transport: 'network-bridge',
    qualification: 'device-observed',
    verifiedAt: '2026-08-01T12:00:00.000Z',
  },
  capabilities: { acquisitions: [], features: [] },
} as unknown as InstrumentSessionSnapshot;

const canonicalSurface = {
  schemaVersion: 1,
  revision: 'surface-generic-view',
  presentation: {
    title: 'Driver-provided instrument title',
    subtitle: 'Driver-provided presentation summary',
    qualification: 'DRIVER VERIFIED',
    facts: [{ label: 'Connection', value: 'Driver-managed link', detail: 'Verified by the active driver' }],
  },
  parameters: [],
  operations: [{
    id: 'capture',
    label: 'Capture',
    parameterIds: [],
    outputs: [],
    availability: 'available',
    primary: true,
    confirmation: 'none',
  }],
} satisfies CanonicalInstrumentSurface;

function renderWorkspace(overrides: Partial<React.ComponentProps<typeof DeviceWorkspace>> = {}) {
  return render(<DeviceWorkspace
    session={session}
    diagnostics={[]}
    busy={false}
    touchBusy={false}
    onRefresh={vi.fn()}
    onCapture={vi.fn()}
    onTap={vi.fn()}
    {...overrides}
  />);
}

describe('DeviceWorkspace generic presentation', () => {
  it('uses the driver-emitted canonical presentation without inspecting a source identity', () => {
    renderWorkspace({ canonicalSurface });

    expect(screen.getByText('Driver-provided instrument title')).toBeTruthy();
    expect(screen.getByText('Driver-provided presentation summary')).toBeTruthy();
    expect(screen.getByText('DRIVER VERIFIED')).toBeTruthy();
    expect(screen.getByText('Driver-managed link')).toBeTruthy();
    expect(screen.getByText('Verified by the active driver')).toBeTruthy();
    expect(screen.queryByText('Fallback instrument')).toBeNull();
  });

  it('falls back to candidate and common provenance fields when no canonical presentation exists', () => {
    renderWorkspace();

    expect(screen.getByText('Fallback instrument')).toBeTruthy();
    expect(screen.getAllByText('Physical instrument')).not.toHaveLength(0);
    expect(screen.getByText('Network Bridge')).toBeTruthy();
    expect(screen.getByText('Device Observed')).toBeTruthy();
  });

  it('does not turn an arbitrary driver feature into a raw mutable selector', () => {
    const sessionWithLegacyOptions = {
      ...session,
      capabilities: {
        acquisitions: [],
        features: [{
          kind: 'driver-private-option-set',
          profiles: [{ profileId: 'profile-1', centerFrequencyHz: 100_000_000 }],
          selectedProfileId: 'profile-1',
        }],
      },
    } as unknown as InstrumentSessionSnapshot;

    renderWorkspace({ session: sessionWithLegacyOptions });

    expect(screen.queryByText('Operating profile')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
