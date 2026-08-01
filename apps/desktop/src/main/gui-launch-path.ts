/**
 * macOS (and Linux desktop) GUI apps launched via Finder/Dock/`open` do not
 * inherit an interactive shell's PATH -- they get launchd's bare default
 * (typically just /usr/bin:/bin:/usr/sbin:/sbin), even on a machine whose
 * every Terminal window sees a much richer one. Any driver that shells out
 * to a CLI tool installed the normal way (Homebrew, a user-local
 * ~/.local/bin, a manual build) is invisible to Atomizer unless something
 * restores those directories explicitly -- confirmed directly against a
 * real install: `iio_attr was not found on PATH` never happens from a
 * terminal on the same machine, but happens every time from the installed
 * Dock app, because Electron's main process inherits launchd's PATH, not a
 * shell's.
 *
 * This is a general Electron/macOS problem, not specific to any one driver
 * -- fixing it once here benefits every current and future subprocess-
 * spawning driver (Neptune's iio_attr/iio_readdev today; potentially others
 * later), rather than working around it per-driver.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const COMMON_GUI_LAUNCH_BIN_DIRECTORIES = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
] as const;

/**
 * `currentPath` with any existing, not-already-present directory from
 * `candidateDirectories` prepended, in order, ahead of the original entries
 * (so a user-local tool intentionally shadows a system one of the same
 * name). Directories that don't exist, or are already present anywhere in
 * `currentPath`, are left out -- this never grows PATH with dead entries or
 * duplicates.
 */
export function augmentedGuiLaunchPath(
  currentPath: string | undefined,
  candidateDirectories: readonly string[] = COMMON_GUI_LAUNCH_BIN_DIRECTORIES,
  exists: (path: string) => boolean = existsSync,
): string {
  const entries = (currentPath ?? '').split(':').filter((entry) => entry.length > 0);
  const present = new Set(entries);
  const additions = candidateDirectories.filter((directory) => !present.has(directory) && exists(directory));
  return [...additions, ...entries].join(':');
}

/** Mutates `processEnv.PATH` in place; a no-op on platforms where this GUI-launch gap doesn't apply. */
export function restoreGuiLaunchPath(processEnv: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  processEnv.PATH = augmentedGuiLaunchPath(processEnv.PATH);
}
