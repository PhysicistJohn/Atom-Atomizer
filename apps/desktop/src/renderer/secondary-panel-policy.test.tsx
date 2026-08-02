// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './AppShell.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 1,
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal('atomizerInstrument', {
    version: 1,
    getState: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      startup: { status: 'not-started' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
    }),
    discover: vi.fn().mockResolvedValue({
      discoveryRevision: 'empty-discovery',
      discoveredAt: '2026-08-01T00:00:00.000Z',
      candidates: [],
      failures: [],
    }),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  });
  vi.stubGlobal('atomAgent', {
    status: vi.fn().mockResolvedValue({
      configured: false,
      model: 'gpt-realtime-2.1',
      voice: 'ballad',
      reasoningEffort: 'high',
      textAgent: false,
      realtime: false,
      textTransport: 'realtime-websocket',
    }),
  });
});

describe('top-level secondary-panel policy', () => {
  it('keeps Atom, the measurement drawer, and the connection sheet mutually exclusive', async () => {
    render(<App initialAgentOpen/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());

    expect(screen.getByLabelText('Atom AI copilot')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Instrument setup' }));
    expect(screen.queryByLabelText('Atom AI copilot')).toBeNull();
    expect(screen.getByRole('region', { name: 'Instrument setup panel' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Atom AI copilot' }));
    expect(screen.queryByRole('region', { name: 'Instrument setup panel' })).toBeNull();
    expect(screen.getByLabelText('Atom AI copilot')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    expect(screen.queryByLabelText('Atom AI copilot')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Instrument source' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Atom AI copilot' }));
    expect(screen.queryByRole('dialog', { name: 'Instrument source' })).toBeNull();
    expect(screen.getByLabelText('Atom AI copilot')).toBeTruthy();
  });
});
