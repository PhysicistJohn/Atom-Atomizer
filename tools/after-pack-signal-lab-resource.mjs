import { resolve } from 'node:path';
import { verifySignalLabPackagedResource } from './stage-signal-lab-packaged-resource.mjs';

/** Electron Builder hook: prove the actual .app resource copy before signing. */
export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    throw new Error('Atomizer currently publishes only the declared macOS package target');
  }
  const productFilename = context.packager?.appInfo?.productFilename;
  if (typeof productFilename !== 'string'
    || productFilename.length < 1
    || productFilename.length > 160
    || /[\\/\0]/u.test(productFilename)) {
    throw new Error('Electron Builder did not provide a safe Atomizer product filename');
  }
  const resourceRoot = resolve(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Resources',
    'signal-lab',
  );
  await verifySignalLabPackagedResource(resourceRoot, { normalizeModes: true });
}

export default afterPack;
