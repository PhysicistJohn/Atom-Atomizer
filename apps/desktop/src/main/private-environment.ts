import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { parse } from 'dotenv';

const MAX_PRIVATE_ENVIRONMENT_FILE_BYTES = 64 * 1024;

export interface PrivateEnvironmentLoadResult {
  path: string;
  loadedKeys: readonly string[];
}

interface PrivateEnvironmentOptions {
  currentUid?: number;
  environment?: NodeJS.ProcessEnv;
  /** Test seam; `false` can only make the loader fail more conservatively. */
  secureNoFollowOpen?: boolean;
}

/**
 * Loads the first existing candidate through the descriptor that was opened
 * with O_NOFOLLOW.  Metadata validation and content consumption therefore
 * apply to the same inode; replacing the pathname cannot redirect the read.
 * An explicitly configured first path is required, while implicit development
 * candidates may all be absent when credentials are supplied by the parent
 * environment instead.
 */
export async function loadPrivateEnvironmentFromCandidates(
  candidates: readonly string[],
  options: PrivateEnvironmentOptions & { explicitFirstCandidate?: boolean } = {},
): Promise<PrivateEnvironmentLoadResult | undefined> {
  const uniqueCandidates = [...new Set(candidates.filter((candidate) => candidate.trim().length > 0))];
  if (!hasSecureNoFollowOpen(options)) {
    if (options.explicitFirstCandidate && uniqueCandidates.length > 0) {
      throw unsupportedEnvironmentFilePlatform(uniqueCandidates[0]!);
    }
    for (const path of uniqueCandidates) {
      try {
        await lstat(path);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue;
        throw environmentFileError('could not be inspected', path, error);
      }
      // Never consume an implicitly discovered file on a platform where Node
      // cannot bind a non-following open to ownership and mode validation.
      throw unsupportedEnvironmentFilePlatform(path);
    }
    return undefined;
  }
  for (let index = 0; index < uniqueCandidates.length; index += 1) {
    const path = uniqueCandidates[index]!;
    try {
      return await loadPrivateEnvironmentFile(path, options);
    } catch (error) {
      if (isMissing(error) && !(options.explicitFirstCandidate && index === 0)) continue;
      throw error;
    }
  }
  return undefined;
}

export async function loadPrivateEnvironmentFile(
  path: string,
  options: PrivateEnvironmentOptions = {},
): Promise<PrivateEnvironmentLoadResult> {
  const noFollow = constants.O_NOFOLLOW;
  if (!hasSecureNoFollowOpen(options)) throw unsupportedEnvironmentFilePlatform(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow!);
  } catch (error) {
    if (isMissing(error)) {
      throw environmentFileError('is missing', path, error);
    }
    if (hasCode(error, 'ELOOP')) {
      throw environmentFileError('must be a regular non-symlink file', path, error);
    }
    throw environmentFileError('could not be opened securely', path, error);
  }

  try {
    const before = await handle.stat();
    validatePrivateMetadata(path, before, options.currentUid);
    const contents = await readBoundedUtf8(handle, path);
    const after = await handle.stat();
    if (!sameOpenedFileState(before, after)) {
      throw new Error(`TinySA Atomizer environment file changed while it was being read: ${path}`);
    }
    const parsed = parse(contents);
    const environment = options.environment ?? process.env;
    const loadedKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (environment[key] !== undefined) continue;
      environment[key] = value;
      loadedKeys.push(key);
    }
    return { path, loadedKeys: loadedKeys.sort() };
  } finally {
    await handle.close();
  }
}

async function readBoundedUtf8(handle: FileHandle, path: string): Promise<string> {
  // Do not let an in-place growth race turn a validated small file into an
  // unbounded read. One extra byte is sufficient to reject an oversized file.
  const buffer = Buffer.alloc(MAX_PRIVATE_ENVIRONMENT_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_PRIVATE_ENVIRONMENT_FILE_BYTES) {
    throw new Error(`TinySA Atomizer environment file grew beyond ${MAX_PRIVATE_ENVIRONMENT_FILE_BYTES} bytes while being read: ${path}`);
  }
  return buffer.subarray(0, offset).toString('utf8');
}

function hasSecureNoFollowOpen(options: PrivateEnvironmentOptions): boolean {
  return options.secureNoFollowOpen !== false
    && typeof process.getuid === 'function'
    && Number.isInteger(constants.O_NOFOLLOW)
    && constants.O_NOFOLLOW !== 0;
}

function unsupportedEnvironmentFilePlatform(path: string): Error {
  return new Error(
    `TinySA Atomizer cannot securely consume an environment file on this platform: ${path}. `
    + 'Supply private values through the inherited process environment instead.',
  );
}

function validatePrivateMetadata(path: string, metadata: Stats, configuredUid: number | undefined): void {
  if (!metadata.isFile()) {
    throw new Error(`TinySA Atomizer environment file must be a regular non-symlink file: ${path}`);
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_PRIVATE_ENVIRONMENT_FILE_BYTES) {
    throw new Error(
      `TinySA Atomizer environment file must not exceed ${MAX_PRIVATE_ENVIRONMENT_FILE_BYTES} bytes `
      + `(found ${metadata.size}): ${path}`,
    );
  }
  const currentUid = configuredUid
    ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (!Number.isSafeInteger(currentUid) || currentUid! < 0) {
    throw new Error(`TinySA Atomizer cannot verify ownership of its environment file on this platform: ${path}`);
  }
  if (metadata.uid !== currentUid) {
    throw new Error(`TinySA Atomizer environment file must be owned by the current user (expected UID ${currentUid}, found UID ${metadata.uid}): ${path}`);
  }
  const permissionBits = metadata.mode & 0o777;
  const displayedMode = `0${permissionBits.toString(8).padStart(3, '0')}`;
  if ((permissionBits & 0o077) !== 0) {
    throw new Error(`TinySA Atomizer environment file must grant no permissions to group or other users (found mode ${displayedMode}): ${path}`);
  }
  if ((permissionBits & 0o400) === 0) {
    throw new Error(`TinySA Atomizer environment file must be readable by its owner (found mode ${displayedMode}): ${path}`);
  }
}

function sameOpenedFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function environmentFileError(reason: string, path: string, cause: unknown): Error {
  return new Error(`TinySA Atomizer environment file ${reason}: ${path}`, { cause });
}

function isMissing(error: unknown): boolean {
  if (hasCode(error, 'ENOENT')) return true;
  return error instanceof Error && hasCode(error.cause, 'ENOENT');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
