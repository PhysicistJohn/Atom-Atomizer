/**
 * Bounded revision→configuration retention for the renderer's stale-drop
 * checks. Replaces the leased `BoundedRevisionCache`: admitted configurations
 * are committed once on configure-acknowledgement and read by measurement
 * admission; there are no reservations, leases, or retained-key sets. The map
 * stays bounded by delete-oldest at `limit`, and `clear()` drops every entry
 * when a session change or lifecycle invalidation retires all acquired
 * configurations at once.
 */
export class RevisionGuard<T> {
  readonly #limit: number;
  readonly #entries = new Map<string, T>();

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Revision guard limit must be a positive integer, received ${limit}`);
    }
    this.#limit = limit;
  }

  /** Record an admitted configuration under its host-issued revision. */
  commit(revision: string, value: T): void {
    if (this.#entries.has(revision)) this.#entries.delete(revision);
    this.#entries.set(revision, value);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  read(revision: string): T | undefined {
    return this.#entries.get(revision);
  }

  has(revision: string): boolean {
    return this.#entries.has(revision);
  }

  clear(): void {
    this.#entries.clear();
  }
}
