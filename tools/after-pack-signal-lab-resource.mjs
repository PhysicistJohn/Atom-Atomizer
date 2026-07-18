import { resolve } from 'node:path';
import { cp, stat } from 'node:fs/promises';
import { DEFAULT_SIGNAL_LAB_PACKAGED_RESOURCE_ROOT, verifySignalLabPackagedResource } from './stage-signal-lab-packaged-resource.mjs';

/**
 * Electron Builder hook: prove the actual packaged resource copy before signing.
 *
 * electron-builder's extraResources copier silently drops any directory
 * literally named `node_modules` anywhere in the copied tree -- an
 * optimization meant for its own app-dependency packaging that also applies
 * to plain extraResources copies. The staged signal-lab resource ships its
 * own `node_modules/zod`, so it never survives that copy; this restores it
 * from the staged source before the manifest-driven verification below.
 */
export async function afterPack(context) {
  const productFilename = context.packager?.appInfo?.productFilename;
  if (typeof productFilename !== 'string'
    || productFilename.length < 1
    || productFilename.length > 160
    || /[\\/\0]/u.test(productFilename)) {
    throw new Error('Atomizer did not receive a safe packaged product filename');
  }
  const resourceRoot = context.electronPlatformName === 'darwin'
    ? resolve(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources', 'signal-lab')
    : resolve(context.appOutDir, 'resources', 'signal-lab');
  const stagedResourceRoot = resolve(context.stagedResourceRoot ?? DEFAULT_SIGNAL_LAB_PACKAGED_RESOURCE_ROOT);
  await restoreDroppedNodeModules(stagedResourceRoot, resourceRoot);
  await verifySignalLabPackagedResource(resourceRoot, { normalizeModes: true });
}

async function restoreDroppedNodeModules(stagedResourceRoot, resourceRoot) {
  const stagedNodeModules = resolve(stagedResourceRoot, 'node_modules');
  if (!(await isDirectory(stagedNodeModules))) return;
  await cp(stagedNodeModules, resolve(resourceRoot, 'node_modules'), { recursive: true, verbatimSymlinks: false });
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export default afterPack;
