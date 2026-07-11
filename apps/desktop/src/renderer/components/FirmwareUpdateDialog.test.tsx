// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { OEM_ZS407_FIRMWARE_RELEASE, ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT, type FirmwareUpdatePreflight, type FirmwareUpdateState } from '@tinysa/contracts';
import { agentControlBinding } from '@tinysa/agent';
import { FirmwareUpdateDialog } from './FirmwareUpdateDialog.js';

afterEach(cleanup);

describe('firmware update human boundary', () => {
  it('requires every physical preflight attestation before disconnect preparation', () => {
    const onPrepare = vi.fn();
    const { container } = render(<PreflightHarness onPrepare={onPrepare}/>);

    const prepare = screen.getByRole('button', { name: /Record preflight and disconnect/i });
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Pre-update self-test passed/i));
    fireEvent.click(screen.getByLabelText(/Both RF ports are disconnected/i));
    fireEvent.change(screen.getByLabelText(/Configuration disposition/i), { target: { value: 'new-device-unchanged' } });
    expect((prepare as HTMLButtonElement).disabled).toBe(false);
    expect(prepare.dataset.agentRisk).toBe('high-impact');
    expect(prepare.dataset.agentExclusion).toBe('human-firmware-preflight');
    expect(agentControlBinding('firmware.prepare').risk).toBe('high-impact');
    assertNoOrphans(container);
  });

  it('keeps the only firmware-write control local-human and high-impact', () => {
    const onFlash = vi.fn();
    const { container } = render(<FirmwareUpdateDialog state={{ ...verified, phase: 'ready-to-flash', dfuUtility: { available: true, version: '0.11' }, dfuDevice: { detected: true, count: 1 }, preparation }} busy={false} preflight={{}} onPreflight={vi.fn()} onDownload={vi.fn()} onPrepare={vi.fn()} onDetect={vi.fn()} onFlash={onFlash} onClose={vi.fn()}/>);
    const flash = screen.getByRole('button', { name: /Flash verified OEM firmware/i });
    expect(flash.dataset.agentRisk).toBe('high-impact');
    expect(flash.dataset.agentExclusion).toBe('human-flash-boundary');
    expect(agentControlBinding('firmware.flash').risk).toBe('high-impact');
    fireEvent.click(flash);
    expect(onFlash).toHaveBeenCalledOnce();
    assertNoOrphans(container);
  });
});

const preparation = {
  id: 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6', preparedAt: '2026-07-11T22:00:00.000Z', batteryMillivolts: 4211, deviceId: 0,
  screenSha256: '39174d17a08e3f6c09407bec2d2f8088a56232c5ec177056c8f3b5b37f53694a', selfTestPassed: true as const,
  configurationDisposition: 'new-device-unchanged' as const, rfPortsDisconnected: true as const,
};
const verified: FirmwareUpdateState = {
  phase: 'verified', target: OEM_ZS407_FIRMWARE_RELEASE, updateAvailable: true,
  current: { version: 'tinySA4_v1.4-217-gc5dd31f', revision: 'c5dd31f', sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT },
  artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes, sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256, verifiedAt: '2026-07-11T22:00:00.000Z' },
  dfuUtility: { available: true, version: '0.11' }, dfuDevice: { detected: false, count: 0 }, writeDisposition: 'not-started',
};

function assertNoOrphans(container: HTMLElement): void {
  for (const interactive of container.querySelectorAll<HTMLElement>('button,input,select,textarea,details')) {
    expect(interactive.closest('[data-agent-control],[data-agent-exclusion]'), interactive.outerHTML.slice(0, 160)).toBeTruthy();
  }
}

function PreflightHarness({ onPrepare }: { onPrepare(): void }) {
  const [preflight, setPreflight] = useState<Partial<FirmwareUpdatePreflight>>({});
  return <FirmwareUpdateDialog state={verified} busy={false} preflight={preflight} onPreflight={setPreflight} onDownload={vi.fn()} onPrepare={onPrepare} onDetect={vi.fn()} onFlash={vi.fn()} onClose={vi.fn()}/>;
}
