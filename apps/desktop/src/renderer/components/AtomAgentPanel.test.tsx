// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AtomAgentPanel } from './AtomAgentPanel.js';

const configuredStatus = {
  configured: true,
  model: 'gpt-realtime-2.1',
  voice: 'ballad',
  reasoningEffort: 'high',
  textAgent: true,
  realtime: true,
  textTransport: 'realtime-websocket',
} as const;

describe('AtomAgentPanel voice startup recovery', () => {
  it('keeps voice cancellation and text submission available while voice is connecting', () => {
    const onVoice = vi.fn();
    const onSend = vi.fn();
    render(<AtomAgentPanel
      open
      state="connecting"
      status={configuredStatus}
      messages={[]}
      microphoneMuted
      speakerMuted={false}
      onClose={vi.fn()}
      onSend={onSend}
      onVoice={onVoice}
      onMicrophoneMute={vi.fn()}
      onSpeakerMute={vi.fn()}
      onApproval={vi.fn()}
    />);

    const disconnect = screen.getByRole('button', { name: 'Disconnect' });
    expect((disconnect as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(disconnect);
    expect(onVoice).toHaveBeenCalledOnce();

    const composer = screen.getByPlaceholderText('Ask Atom anything about this RF session…');
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(composer, { target: { value: 'Inspect the current session.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Atom' }));
    expect(onSend).toHaveBeenCalledWith('Inspect the current session.');
  });
});
