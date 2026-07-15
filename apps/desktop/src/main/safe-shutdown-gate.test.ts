import { describe, expect, it, vi } from 'vitest';
import { SafeShutdownGate } from './safe-shutdown-gate.js';

describe('SafeShutdownGate', () => {
  it('prevents every repeated quit request until the pending safe shutdown completes', () => {
    const gate = new SafeShutdownGate();
    const first = { preventDefault: vi.fn() };
    const repeated = { preventDefault: vi.fn() };
    const completed = { preventDefault: vi.fn() };

    expect(gate.intercept(first)).toBe('start');
    expect(gate.intercept(repeated)).toBe('wait');
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).toHaveBeenCalledOnce();

    gate.complete();
    expect(gate.intercept(completed)).toBe('allow');
    expect(completed.preventDefault).not.toHaveBeenCalled();
  });

  it('admits one fresh attempt after a failed shutdown becomes retryable', () => {
    const gate = new SafeShutdownGate();
    expect(gate.intercept({ preventDefault: vi.fn() })).toBe('start');
    gate.retry();
    expect(gate.intercept({ preventDefault: vi.fn() })).toBe('start');
  });
});
