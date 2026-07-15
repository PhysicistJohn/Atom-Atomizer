import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  atomizerInstrumentPreferenceSchema,
  type AtomizerInstrumentPreference,
  type InstrumentDriverId,
  type InstrumentSourceKind,
} from '@tinysa/contracts';

export const SIGNAL_LAB_DRIVER_ID = 'signal-lab' as const;
export const INSTRUMENT_PREFERENCE_FILENAME = 'instrument-preference-v1.json' as const;

const MAX_PREFERENCE_BYTES = 16 * 1024;

export const instrumentPreferenceSchema = atomizerInstrumentPreferenceSchema;
export type InstrumentPreference = AtomizerInstrumentPreference;

export type LoadedInstrumentPreference =
  | { readonly source: 'factory-default'; readonly preference: InstrumentPreference }
  | { readonly source: 'persisted'; readonly preference: InstrumentPreference };

export class InstrumentPreferenceError extends Error {
  override readonly name = 'InstrumentPreferenceError';
}

export interface InstrumentPreferenceRuntime {
  now(): Date;
  randomUuid(): string;
}

const defaultRuntime: InstrumentPreferenceRuntime = Object.freeze({
  now: () => new Date(),
  randomUuid: () => randomUUID(),
});

/**
 * Main-process-owned startup selection. A corrupt or structurally unsafe file
 * is an explicit error: silently falling back could connect a different RF
 * instrument than the operator selected.
 */
export class InstrumentPreferenceStore {
  readonly #path: string;

  constructor(
    private readonly directory: string,
    private readonly runtime: InstrumentPreferenceRuntime = defaultRuntime,
  ) {
    this.#path = join(directory, INSTRUMENT_PREFERENCE_FILENAME);
  }

  get path(): string { return this.#path; }

  async load(): Promise<LoadedInstrumentPreference> {
    let handle: FileHandle;
    try { handle = await open(this.#path, constants.O_RDONLY | noFollowFlag()); }
    catch (value) {
      if (isMissing(value)) {
        return {
          source: 'factory-default',
          preference: instrumentPreferenceSchema.parse({
            schemaVersion: 1,
            driverId: SIGNAL_LAB_DRIVER_ID,
            updatedAt: new Date(0).toISOString(),
          }),
        };
      }
      if (isNodeError(value) && value.code === 'ELOOP') {
        throw new InstrumentPreferenceError('Instrument preference must be a regular, non-symbolic-link file', { cause: value });
      }
      throw new InstrumentPreferenceError(`Could not inspect the instrument preference: ${message(value)}`, { cause: value });
    }
    try {
      const before = await handle.stat({ bigint: true });
      validatePreferenceMetadata(before);
      const bytes = await readExactPreference(handle, Number(before.size));
      const after = await handle.stat({ bigint: true });
      validatePreferenceMetadata(after);
      if (!sameStableFile(before, after)) {
        throw new InstrumentPreferenceError('Instrument preference changed while it was being read');
      }
      return { source: 'persisted', preference: instrumentPreferenceSchema.parse(JSON.parse(bytes.toString('utf8'))) };
    } catch (value) {
      if (value instanceof InstrumentPreferenceError) throw value;
      throw new InstrumentPreferenceError(`Instrument preference is invalid: ${message(value)}`, { cause: value });
    } finally {
      await handle.close();
    }
  }

  async save(driverIdValue: InstrumentDriverId, candidateKind?: InstrumentSourceKind): Promise<InstrumentPreference> {
    const preference = instrumentPreferenceSchema.parse({
      schemaVersion: 1,
      driverId: driverIdValue,
      ...(candidateKind ? { candidateKind } : {}),
      updatedAt: this.runtime.now().toISOString(),
    });
    const bytes = Buffer.from(`${JSON.stringify(preference, null, 2)}\n`, 'utf8');
    if (bytes.byteLength > MAX_PREFERENCE_BYTES) throw new InstrumentPreferenceError('Instrument preference exceeds its storage bound');

    await this.#ensureDirectory();
    const temporary = join(this.directory, `.${basename(this.#path)}.${this.runtime.randomUuid()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
      await syncDirectory(dirname(this.#path));
    } catch (value) {
      try { await handle?.close(); } catch { /* Preserve the primary failure. */ }
      try { await rm(temporary, { force: true }); } catch { /* Preserve the primary failure. */ }
      throw new InstrumentPreferenceError(`Could not persist the instrument preference: ${message(value)}`, { cause: value });
    }
    return preference;
  }

  async #ensureDirectory(): Promise<void> {
    const parent = dirname(this.directory);
    const parentMetadata = await lstat(parent).catch((value: unknown) => {
      throw new InstrumentPreferenceError(`Instrument preference parent is unavailable: ${message(value)}`, { cause: value });
    });
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new InstrumentPreferenceError('Instrument preference parent must be a regular directory');
    }
    try {
      const directoryMetadata = await lstat(this.directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new InstrumentPreferenceError('Instrument preference location must be a regular directory');
      }
    } catch (value) {
      if (!isMissing(value)) throw value;
      const parentHandle = await open(parent, constants.O_RDONLY | noFollowFlag());
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(this.directory, { mode: 0o700 });
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    }
  }
}

function noFollowFlag(): number { return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW; }
function isMissing(value: unknown): boolean { return isNodeError(value) && value.code === 'ENOENT'; }
function isNodeError(value: unknown): value is NodeJS.ErrnoException { return value instanceof Error && 'code' in value; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try { await handle.sync(); } finally { await handle.close(); }
}

function validatePreferenceMetadata(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new InstrumentPreferenceError('Instrument preference must be a regular, non-symbolic-link file');
  }
  if (metadata.size <= 0n || metadata.size > BigInt(MAX_PREFERENCE_BYTES)) {
    throw new InstrumentPreferenceError('Instrument preference has an invalid byte length');
  }
  if (metadata.nlink !== 1n) {
    throw new InstrumentPreferenceError('Instrument preference must have exactly one filesystem link');
  }
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o077n) !== 0n) {
      throw new InstrumentPreferenceError('Instrument preference permissions must be owner-only');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid())) {
      throw new InstrumentPreferenceError('Instrument preference must be owned by the current account');
    }
  }
}

async function readExactPreference(handle: FileHandle, byteLength: number): Promise<Buffer> {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) throw new InstrumentPreferenceError('Instrument preference ended before its admitted byte length');
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
    throw new InstrumentPreferenceError('Instrument preference grew beyond its admitted byte length');
  }
  return bytes;
}

function sameStableFile(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.nlink === after.nlink
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}
