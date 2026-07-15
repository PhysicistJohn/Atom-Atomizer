import { describe, expect, it, vi } from 'vitest';
import { BoundedPrivilegedIpcAdmission } from './privileged-ipc-admission.js';

describe('privileged IPC pending-work admission', () => {
  it('bounds unresolved work, rejects before invocation, and reopens after fulfillment', async () => {
    const admission = new BoundedPrivilegedIpcAdmission(2);
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const first = admission.run('first', () => new Promise<void>((resolve) => { resolveFirst = resolve; }));
    const second = admission.run('second', () => new Promise<void>((resolve) => { resolveSecond = resolve; }));
    const overflow = vi.fn();

    expect(admission.pending).toBe(2);
    expect(() => admission.run('overflow', overflow)).toThrow(/admission limit/i);
    expect(overflow).not.toHaveBeenCalled();

    resolveFirst();
    await first;
    expect(admission.pending).toBe(1);
    expect(admission.run('sync', () => 42)).toBe(42);
    expect(admission.pending).toBe(1);
    resolveSecond();
    await second;
    expect(admission.pending).toBe(0);
  });

  it('releases admission after synchronous throws and asynchronous rejection', async () => {
    const admission = new BoundedPrivilegedIpcAdmission(1);
    expect(() => admission.run('sync-failure', () => { throw new Error('failed'); })).toThrow('failed');
    expect(admission.pending).toBe(0);

    const rejected = admission.run('async-failure', async () => { throw new Error('rejected'); });
    expect(admission.pending).toBe(1);
    await expect(rejected).rejects.toThrow('rejected');
    expect(admission.pending).toBe(0);
  });

  it('rejects invalid limits', () => {
    expect(() => new BoundedPrivilegedIpcAdmission(0)).toThrow(/positive safe integer/);
    expect(() => new BoundedPrivilegedIpcAdmission(Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
  });

  it('releases admission when a hostile then accessor throws during classification', () => {
    const admission = new BoundedPrivilegedIpcAdmission(1);
    const hostile = Object.defineProperty({}, 'then', { get() { throw new Error('hostile then'); } });
    expect(() => admission.run('hostile', () => hostile)).toThrow('hostile then');
    expect(admission.pending).toBe(0);
  });

  it('reserves and coalesces one teardown independently of a full normal cap', async () => {
    const admission = new BoundedPrivilegedIpcAdmission(1);
    let releaseNormal!: () => void;
    let releaseTeardown!: () => void;
    const normal = admission.run('normal', () => new Promise<void>((resolve) => { releaseNormal = resolve; }));
    const invokeTeardown = vi.fn(() => new Promise<void>((resolve) => { releaseTeardown = resolve; }));

    const teardown = admission.runTeardown('disconnect', invokeTeardown);
    expect(admission.pending).toBe(1);
    expect(admission.teardownPending).toBe(true);
    expect(admission.runTeardown('disconnect', invokeTeardown)).toBe(teardown);
    expect(invokeTeardown).toHaveBeenCalledOnce();
    expect(() => admission.run('overflow', () => undefined)).toThrow(/admission limit/i);

    releaseTeardown();
    await teardown;
    expect(admission.teardownPending).toBe(false);
    releaseNormal();
    await normal;
  });
});
