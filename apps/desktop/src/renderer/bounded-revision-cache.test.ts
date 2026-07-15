import { describe, expect, it } from 'vitest';
import { BoundedRevisionCache } from './bounded-revision-cache.js';

describe('BoundedRevisionCache', () => {
  it('evicts the least-recently-used unprotected revision and never exceeds its hard bound', () => {
    const cache = new BoundedRevisionCache<number>(3);
    cache.remember('a', 1);
    cache.remember('b', 2);
    cache.remember('c', 3);
    expect(cache.read('a')).toBe(1);

    cache.remember('d', 4);

    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('protects active, retained-evidence, and in-flight revisions during eviction', () => {
    const cache = new BoundedRevisionCache<number>(4);
    cache.remember('history', 1);
    cache.remember('active', 2);
    cache.remember('in-flight', 3);
    cache.remember('stale', 4);
    cache.setRetainedKeys(['history']);
    cache.setActive('active');
    const lease = cache.lease('in-flight');

    cache.remember('next', 5);

    expect(cache.size).toBe(4);
    expect(cache.has('history')).toBe(true);
    expect(cache.has('active')).toBe(true);
    expect(cache.has('in-flight')).toBe(true);
    expect(cache.has('stale')).toBe(false);
    expect(cache.has('next')).toBe(true);
    lease.release();
  });

  it('makes a released in-flight revision eligible for deterministic eviction', () => {
    const cache = new BoundedRevisionCache<number>(2);
    cache.remember('leased-oldest', 1);
    const lease = cache.lease('leased-oldest');
    cache.remember('stale', 2);
    cache.remember('replacement', 3);
    expect(cache.has('leased-oldest')).toBe(true);
    expect(cache.has('stale')).toBe(false);

    lease.release();
    cache.remember('after-release', 4);

    expect(cache.has('leased-oldest')).toBe(false);
    expect(cache.has('replacement')).toBe(true);
    expect(cache.has('after-release')).toBe(true);
  });

  it('does not disguise old evidence as recently used when its retention pin is released', () => {
    const cache = new BoundedRevisionCache<number>(2);
    cache.remember('old-history', 1);
    cache.remember('newer-unprotected', 2);
    cache.setRetainedKeys(['old-history']);
    cache.setRetainedKeys([]);

    cache.remember('replacement', 3);

    expect(cache.has('old-history')).toBe(false);
    expect(cache.has('newer-unprotected')).toBe(true);
    expect(cache.has('replacement')).toBe(true);
  });

  it('fails before external work when every bounded slot is protected', () => {
    const cache = new BoundedRevisionCache<number>(2);
    cache.remember('history', 1);
    cache.remember('active', 2);
    cache.setRetainedKeys(['history']);
    cache.setActive('active');

    expect(() => cache.reserve()).toThrow(/capacity 2 is exhausted/);
    expect(cache.size).toBe(2);
    expect(cache.reservedSlots).toBe(0);
  });

  it('reserves bounded capacity before async work and releases abandoned slots', () => {
    const cache = new BoundedRevisionCache<number>(1);
    const abandoned = cache.reserve();
    expect(cache.size).toBe(0);
    expect(cache.reservedSlots).toBe(1);
    expect(() => cache.reserve()).toThrow(/capacity 1 is exhausted/);

    abandoned.release();
    const admitted = cache.reserve();
    admitted.commit('configured', 7);

    expect(cache.reservedSlots).toBe(0);
    expect(cache.read('configured')).toBe(7);
  });

  it('invalidates late reservations and makes late lease release harmless after lifecycle clear', () => {
    const cache = new BoundedRevisionCache<number>(2);
    cache.remember('old-session', 1);
    const lease = cache.lease('old-session');
    const reservation = cache.reserve();

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.reservedSlots).toBe(0);
    cache.remember('reused-revision', 3);
    expect(() => reservation.commit('reused-revision', 2)).toThrow(/invalidated by lifecycle reset/);
    expect(() => lease.release()).not.toThrow();

    expect(cache.size).toBe(1);
    expect(cache.read('reused-revision')).toBe(3);
  });

  it('rejects revision aliasing instead of replacing immutable configuration evidence', () => {
    const cache = new BoundedRevisionCache<{ kind: string }>(2);
    cache.remember('revision-1', { kind: 'spectrum' });
    cache.remember('unrelated', { kind: 'screen' });

    expect(() => cache.remember('revision-1', { kind: 'detected-power' })).toThrow(/already retained/);
    expect(cache.size).toBe(2);
    expect(cache.read('revision-1')).toEqual({ kind: 'spectrum' });
    expect(cache.read('unrelated')).toEqual({ kind: 'screen' });
  });
});
