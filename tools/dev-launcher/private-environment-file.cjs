'use strict';

const { lstatSync } = require('node:fs');

const MAX_PRIVATE_ENVIRONMENT_FILE_BYTES = 64 * 1024;

function shellQuotedPath(path) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function correctiveCommand(path) {
  return `chmod 600 ${shellQuotedPath(path)}`;
}

function requirePrivateEnvironmentFile(path, options = {}) {
  const inspectMetadata = options.lstatSync ?? lstatSync;
  let metadata;
  try {
    metadata = inspectMetadata(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        `TinySA Atomizer environment file is missing: ${path}. `
        + `Create a regular file at that exact path, then run: ${correctiveCommand(path)}`,
        { cause: error },
      );
    }
    throw new Error(
      `TinySA Atomizer environment file metadata could not be inspected: ${path}. `
      + `Make the path accessible to your account, verify it is a regular file, then run: ${correctiveCommand(path)}`,
      { cause: error },
    );
  }

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `TinySA Atomizer environment file must be a regular non-symlink file: ${path}. `
      + `Replace the symlink or special entry with a file at that exact path, then run: ${correctiveCommand(path)}`,
    );
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_PRIVATE_ENVIRONMENT_FILE_BYTES) {
    throw new Error(
      `TinySA Atomizer environment file must not exceed ${MAX_PRIVATE_ENVIRONMENT_FILE_BYTES} bytes `
      + `(found ${metadata.size}): ${path}.`,
    );
  }

  const currentUid = options.currentUid
    ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (!Number.isSafeInteger(currentUid) || currentUid < 0) {
    throw new Error(
      `TinySA Atomizer cannot verify ownership of its environment file on this platform: ${path}. `
      + 'The development launcher fails closed when current-user ownership cannot be established.',
    );
  }
  if (metadata.uid !== currentUid) {
    throw new Error(
      `TinySA Atomizer environment file must be owned by the current user `
      + `(expected UID ${currentUid}, found UID ${metadata.uid}): ${path}. `
      + `Run: sudo chown "$(id -un)" ${shellQuotedPath(path)} && ${correctiveCommand(path)}`,
    );
  }

  const permissionBits = metadata.mode & 0o777;
  const displayedMode = `0${permissionBits.toString(8).padStart(3, '0')}`;
  if ((permissionBits & 0o077) !== 0) {
    throw new Error(
      `TinySA Atomizer environment file must grant no permissions to group or other users `
      + `(found mode ${displayedMode}): ${path}. Run: ${correctiveCommand(path)}`,
    );
  }
  if ((permissionBits & 0o400) === 0) {
    throw new Error(
      `TinySA Atomizer environment file must be readable by its owner `
      + `(found mode ${displayedMode}): ${path}. Run: ${correctiveCommand(path)}`,
    );
  }

  return metadata;
}

module.exports = { requirePrivateEnvironmentFile };
