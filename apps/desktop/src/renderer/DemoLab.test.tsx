// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoLab } from './DemoLab.js';
import { DEFAULT_REPLAY_CHANNEL, waveformCatalog, waveformDescriptor } from '@tinysa/waveforms';

const status = { available: true, active: true, playback: true, profile: 'cw' as const, profiles: waveformCatalog.map((entry) => entry.id), waveform: waveformDescriptor('cw'), catalog: waveformCatalog, channel: DEFAULT_REPLAY_CHANNEL };

afterEach(cleanup);
beforeEach(() => {
  window.demoLab = {
    status: vi.fn().mockResolvedValue(status),
    select: vi.fn().mockImplementation(async (profile) => ({ ...status, profile, waveform: waveformDescriptor(profile) })),
    configureChannel: vi.fn().mockImplementation(async (channel) => ({ ...status, channel })),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  };
});

describe('Signal Lab window', () => {
  it('offers visual and standards-derived profiles plus explicit channel models', async () => {
    render(<DemoLab/>);
    await waitFor(() => expect(window.demoLab.status).toHaveBeenCalledOnce());
    expect(await screen.findByText('SYNTHETIC REPLAY LIVE')).toBeTruthy();
    for (const label of ['CW', 'AM', 'FM', 'GSM', 'LTE E-TM1.1', '5G NR TM1.1', 'Wi-Fi 6 HE SU']) expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /LTE E-TM1.1/i }));
    await waitFor(() => expect(window.demoLab.select).toHaveBeenCalledWith('lte-etm1.1'));
    fireEvent.click(screen.getByRole('button', { name: /Rayleigh/i }));
    await waitFor(() => expect(window.demoLab.configureChannel).toHaveBeenCalledWith(expect.objectContaining({ model: 'rayleigh' })));
  });
});
