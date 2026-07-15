export interface RevisionCacheLease<T> {
  readonly key: string;
  readonly value: T;
  release(): void;
}

export interface RevisionCacheReservation<T> {
  commit(key: string, value: T): void;
  release(): void;
}

interface RevisionCacheEntry<T> {
  readonly value: T;
  lastUsed: number;
  leases: number;
}

/**
 * A hard-bounded LRU cache with explicit protection for authoritative active
 * state, retained evidence, and asynchronous operations. Reservations claim a
 * slot before external I/O so a successful remote mutation is never followed
 * by an avoidable local-capacity failure.
 */
export class BoundedRevisionCache<T> {
  readonly #entries = new Map<string, RevisionCacheEntry<T>>();
  #retainedKeys = new Set<string>();
  #activeKey: string | undefined;
  #reservations = 0;
  #generation = 0;
  #clock = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Revision-cache capacity must be a positive safe integer');
    }
  }

  get size(): number { return this.#entries.size; }
  get reservedSlots(): number { return this.#reservations; }
  has(key: string): boolean { return this.#entries.has(key); }

  read(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#touch(entry);
    return entry.value;
  }

  remember(key: string, value: T): void {
    this.#validateKey(key);
    if (this.#entries.has(key)) throw new Error(`Configuration revision ${key} is already retained`);
    const reservation = this.reserve();
    try { reservation.commit(key, value); }
    catch (error) {
      reservation.release();
      throw error;
    }
  }

  reserve(): RevisionCacheReservation<T> {
    this.#makeRoomForReservation();
    this.#reservations++;
    const generation = this.#generation;
    let open = true;
    return {
      commit: (key, value) => {
        if (!open) throw new Error('Revision-cache reservation is already settled');
        open = false;
        if (generation !== this.#generation) {
          throw new Error('Revision-cache reservation was invalidated by lifecycle reset');
        }
        this.#reservations--;
        this.#validateKey(key);
        if (this.#entries.has(key)) throw new Error(`Configuration revision ${key} is already retained`);
        this.#entries.set(key, { value, lastUsed: ++this.#clock, leases: 0 });
      },
      release: () => {
        if (!open) return;
        open = false;
        if (generation === this.#generation) this.#reservations--;
      },
    };
  }

  lease(key: string): RevisionCacheLease<T> {
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Configuration revision ${key} is not retained`);
    entry.leases++;
    this.#touch(entry);
    let open = true;
    return {
      key,
      value: entry.value,
      release: () => {
        if (!open) return;
        open = false;
        if (this.#entries.get(key) === entry) entry.leases--;
      },
    };
  }

  setActive(key: string | undefined): void {
    if (key !== undefined) {
      const entry = this.#entries.get(key);
      if (!entry) throw new Error(`Active configuration revision ${key} is not retained`);
      this.#touch(entry);
    }
    this.#activeKey = key;
  }

  setRetainedKeys(keys: Iterable<string>): void {
    const retained = new Set(keys);
    for (const key of retained) {
      const entry = this.#entries.get(key);
      if (!entry) throw new Error(`Evidence references unretained configuration revision ${key}`);
    }
    this.#retainedKeys = retained;
  }

  clear(): void {
    this.#generation++;
    this.#entries.clear();
    this.#retainedKeys.clear();
    this.#activeKey = undefined;
    this.#reservations = 0;
  }

  #makeRoomForReservation(): void {
    while (this.#entries.size + this.#reservations >= this.capacity) {
      let victimKey: string | undefined;
      let victimAge = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#entries) {
        if (key === this.#activeKey || this.#retainedKeys.has(key) || entry.leases > 0) continue;
        if (entry.lastUsed < victimAge) {
          victimKey = key;
          victimAge = entry.lastUsed;
        }
      }
      if (victimKey === undefined) {
        throw new Error(`Revision-cache capacity ${this.capacity} is exhausted by active, retained, or in-flight configurations`);
      }
      this.#entries.delete(victimKey);
    }
  }

  #touch(entry: RevisionCacheEntry<T>): void { entry.lastUsed = ++this.#clock; }
  #validateKey(key: string): void {
    if (!key.trim()) throw new TypeError('Configuration revision must be a non-empty string');
  }
}
