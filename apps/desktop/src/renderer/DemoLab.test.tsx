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
    expect(await screen.findByText('LIVE')).toBeTruthy();
    for (const label of ['CW carrier', 'AM', 'FM']) expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /LTE/i }));
    const lte = screen.getByLabelText(/LTE waveform model/i) as HTMLSelectElement;
    expect(lte.options).toHaveLength(25);
    await waitFor(() => expect(window.demoLab.select).toHaveBeenCalledWith('lte-etm1.1'));
    await waitFor(() => expect(lte.disabled).toBe(false));
    fireEvent.change(lte, { target: { value: 'lte-setm3.3-2' } });
    await waitFor(() => expect(window.demoLab.select).toHaveBeenCalledWith('lte-setm3.3-2'));
    fireEvent.click(screen.getByRole('button', { name: /5G NR/i }));
    const nr = screen.getByLabelText(/5G NR waveform model/i) as HTMLSelectElement;
    expect(nr.options).toHaveLength(41);
    await waitFor(() => expect(window.demoLab.select).toHaveBeenCalledWith('nr-fr1-tm1.1'));
    const rayleigh = screen.getByRole('button', { name: /Rayleigh/i }) as HTMLButtonElement;
    await waitFor(() => expect(rayleigh.disabled).toBe(false));
    fireEvent.click(rayleigh);
    await waitFor(() => expect(window.demoLab.configureChannel).toHaveBeenCalledWith(expect.objectContaining({ model: 'rayleigh' })));
  });
});
