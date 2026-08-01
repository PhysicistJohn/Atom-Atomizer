/**
 * Persisted memory of P210 devices this application has successfully
 * connected to, kept for a bounded retention window (7 days by default).
 *
 * This exists because a P210 is not reliably discoverable by network
 * scanning alone -- confirmed against a real device in this repository's
 * development environment, which sits on a routed network segment that
 * neither mDNS/Bonjour nor a local broadcast-domain subnet sweep can reach
 * (see NeptuneIioTransport.scanNetwork()'s doc comments in iio-transport.ts).
 * Remembering a device's endpoint after the first successful connection,
 * then re-probing it live on every discover() call, is what makes
 * rediscovery automatic on later app launches without ever asking an
 * operator to set an environment variable or edit a config file: one manual
 * "connect by address" the first time, never again after that.
 *
 * Every listed record is re-verified live by the driver before being
 * trusted; this store only ever provides a *candidate address to re-probe*,
 * never evidence treated as still true. A persistence failure here is
 * deliberately non-fatal to the caller (see `record()`): losing the
 * convenience of remembering a device must never break the live session the
 * operator just successfully started.
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const RECENT_P210_DEVICE_STORE_FILENAME = 'neptune-p210-recent-devices-v1.json';
export const RECENT_P210_DEVICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_STORE_BYTES = 64 * 1024;
const MAX_RECORDS = 32;

export interface RecentP210DeviceRecord {
  sourceKind: 'neptune-p210' | 'neptune-p210-twin';
  endpoint: string;
  contextDescription?: string;
  connectedAt: string;
}

export interface RecentP210DeviceStoreRuntime {
  now(): Date;
  randomId(): string;
}

const defaultRuntime: RecentP210DeviceStoreRuntime = Object.freeze({
  now: () => new Date(),
  randomId: () => Math.random().toString(36).slice(2),
});

export class RecentP210DeviceStore {
  readonly #path: string;

  constructor(
    private readonly directory: string,
    private readonly runtime: RecentP210DeviceStoreRuntime = defaultRuntime,
  ) {
    this.#path = join(directory, RECENT_P210_DEVICE_STORE_FILENAME);
  }

  get path(): string { return this.#path; }

  /**
   * Records or refreshes a successful connection. Best-effort: a disk error
   * here is swallowed rather than thrown, since it must never prevent the
   * live session the operator just established from proceeding.
   */
  async record(entry: {
    sourceKind: RecentP210DeviceRecord['sourceKind'];
    endpoint: string;
    contextDescription?: string;
  }): Promise<void> {
    try {
      const existing = await this.#readAll();
      const connectedAt = this.runtime.now().toISOString();
      const key = recordKey(entry.sourceKind, entry.endpoint);
      const next = existing.filter((record) => recordKey(record.sourceKind, record.endpoint) !== key);
      next.push({ ...entry, connectedAt });
      next.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
      await this.#writeAll(next.slice(0, MAX_RECORDS));
    } catch {
      // Intentionally swallowed -- see class doc comment.
    }
  }

  /**
   * Every record within `maxAgeMs` (default 7 days), most-recent first.
   * Never throws: a read/parse failure is treated as an empty list, not an
   * error, since this store is a rediscovery hint, never authoritative
   * state. Also prunes anything older on disk as a side effect.
   */
  async list(maxAgeMs: number = RECENT_P210_DEVICE_MAX_AGE_MS): Promise<readonly RecentP210DeviceRecord[]> {
    const all = await this.#readAll();
    const cutoff = this.runtime.now().getTime() - maxAgeMs;
    const fresh = all.filter((record) => {
      const connectedAtMs = Date.parse(record.connectedAt);
      return Number.isFinite(connectedAtMs) && connectedAtMs >= cutoff;
    });
    if (fresh.length !== all.length) {
      try { await this.#writeAll(fresh); } catch { /* pruning is best-effort */ }
    }
    return fresh;
  }

  async #readAll(): Promise<RecentP210DeviceRecord[]> {
    let handle;
    try {
      const metadata = await lstat(this.#path);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STORE_BYTES) return [];
      handle = await open(this.#path, constants.O_RDONLY | noFollowFlag());
      const bytes = await handle.readFile();
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidRecord);
    } catch {
      return [];
    } finally {
      try { await handle?.close(); } catch { /* ignore */ }
    }
  }

  async #writeAll(records: readonly RecentP210DeviceRecord[]): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8');
    if (bytes.byteLength > MAX_STORE_BYTES) return;
    await this.#ensureDirectory();
    const temporary = join(this.directory, `.${basename(this.#path)}.${this.runtime.randomId()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
      await handle.writeFile(bytes);
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
    } finally {
      try { await handle?.close(); } catch { /* ignore */ }
      try { await rm(temporary, { force: true }); } catch { /* ignore */ }
    }
  }

  async #ensureDirectory(): Promise<void> {
    try {
      const metadata = await lstat(this.directory);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) return;
    } catch {
      // Falls through to mkdir below.
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  }
}

function recordKey(sourceKind: string, endpoint: string): string {
  return `${sourceKind}\u0000${endpoint}`;
}

function isValidRecord(value: unknown): value is RecentP210DeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.sourceKind === 'neptune-p210' || record.sourceKind === 'neptune-p210-twin')
    && typeof record.endpoint === 'string' && record.endpoint.length > 0
    && typeof record.connectedAt === 'string' && Number.isFinite(Date.parse(record.connectedAt))
    && (record.contextDescription === undefined || typeof record.contextDescription === 'string')
  );
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
}
