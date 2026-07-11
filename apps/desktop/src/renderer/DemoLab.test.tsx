// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoLab } from './DemoLab.js';

afterEach(cleanup);
beforeEach(() => {
  window.demoLab = {
    status: vi.fn().mockResolvedValue({ available: true, active: true, profile: 'cw', profiles: ['cw', 'am', 'fm', 'lte'] }),
    select: vi.fn().mockImplementation(async (profile) => ({ available: true, active: true, profile, profiles: ['cw', 'am', 'fm', 'lte'] })),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  };
});

describe('Signal Lab window', () => {
  it('offers exactly the four requested synthesized profiles and switches the byte source', async () => {
    render(<DemoLab/>);
    await waitFor(() => expect(window.demoLab.status).toHaveBeenCalledOnce());
    for (const label of ['CW', 'AM', 'FM', 'LTE-like']) expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /LTE-like/i }));
    await waitFor(() => expect(window.demoLab.select).toHaveBeenCalledWith('lte'));
  });
});
