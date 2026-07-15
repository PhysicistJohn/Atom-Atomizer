import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_NAME = 'TinySA Atomizer Dev';
const BUNDLE_ID = 'org.tinysa.atomizer.dev';
const CONTRACT_VERSION = 3;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceApp = join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
const destination = join(homedir(), 'Applications', `${APP_NAME}.app`);
const plistBuddy = '/usr/libexec/PlistBuddy';
const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', ...options });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`${basename(command)} failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

function assertFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

function replacePlistValue(plist, key, value) {
  run(plistBuddy, ['-c', `Set :${key} "${value}"`, plist]);
}

function generateIcon(resources) {
  const sourceSvg = join(here, 'AtomizerDevIcon.svg');
  const temporary = mkdtempSync(join(tmpdir(), 'tinysa-atomizer-icon-'));
  try {
    run('/usr/bin/qlmanage', ['-t', '-s', '1024', '-o', temporary, sourceSvg]);
    const thumbnail = join(temporary, `${basename(sourceSvg)}.png`);
    assertFile(thumbnail, 'Rendered launcher icon');
    cpSync(thumbnail, join(resources, 'atomizer-dev.png'));
    const iconset = join(temporary, 'atomizer-dev.iconset');
    mkdirSync(iconset);
    const targets = [
      ['icon_16x16.png', 16],
      ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32],
      ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128],
      ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256],
      ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512],
      ['icon_512x512@2x.png', 1024],
    ];
    for (const [name, pixels] of targets) {
      run('/usr/bin/sips', ['-z', String(pixels), String(pixels), thumbnail, '--out', join(iconset, name)]);
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'atomizer-dev.icns')]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function signApplication(application) {
  const codeBundles = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) codeBundles.push(path);
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const executable = (statSync(path).mode & 0o111) !== 0;
      if (!executable && !entry.name.endsWith('.dylib') && !entry.name.endsWith('.node')) continue;
      if (run('/usr/bin/file', ['-b', path]).startsWith('Mach-O')) {
        run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
      }
    }
  }

  visit(join(application, 'Contents'));
  codeBundles.sort((left, right) => right.split('/').length - left.split('/').length);
  for (const bundle of codeBundles) run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
}

function installApplication() {
  assertFile(sourceApp, 'Electron development runtime');
  assertFile(join(repoRoot, '.env'), 'TinySA Atomizer environment file');
  assertFile(join(here, 'main.cjs'), 'Development launcher runtime');
  assertFile(join(here, 'package.json'), 'Development launcher package');
  assertFile(join(here, 'config.json'), 'Development runtime contract');

  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    const existingPlist = join(destination, 'Contents', 'Info.plist');
    const existingBundleId = existsSync(existingPlist)
      ? run(plistBuddy, ['-c', 'Print :CFBundleIdentifier', existingPlist]).trim()
      : '';
    if (existingBundleId !== BUNDLE_ID) {
      throw new Error(`Refusing to replace an application not owned by this launcher: ${destination}`);
    }
    rmSync(destination, { recursive: true, force: true });
  }

  run('/usr/bin/ditto', [sourceApp, destination]);
  const resources = join(destination, 'Contents', 'Resources');
  rmSync(join(resources, 'default_app.asar'), { recursive: true, force: true });
  const runtime = join(resources, 'app');
  mkdirSync(runtime);
  cpSync(join(here, 'main.cjs'), join(runtime, 'main.cjs'));
  cpSync(join(here, 'package.json'), join(runtime, 'package.json'));
  writeFileSync(join(runtime, 'launcher-config.json'), `${JSON.stringify({ contractVersion: CONTRACT_VERSION, repoRoot }, null, 2)}\n`, 'utf8');

  generateIcon(resources);
  const plist = join(destination, 'Contents', 'Info.plist');
  replacePlistValue(plist, 'CFBundleDisplayName', APP_NAME);
  replacePlistValue(plist, 'CFBundleName', APP_NAME);
  replacePlistValue(plist, 'CFBundleIdentifier', BUNDLE_ID);
  replacePlistValue(plist, 'CFBundleIconFile', 'atomizer-dev.icns');
  replacePlistValue(plist, 'NSMicrophoneUsageDescription', 'TinySA Atomizer uses the microphone for native voice interaction with Atom.');
  try {
    run(plistBuddy, ['-c', 'Delete :ElectronAsarIntegrity', plist]);
  } catch {
    throw new Error('The ElectronAsarIntegrity key was missing from the source runtime; its packaging contract changed');
  }

  run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', destination]);
  run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', join(repoRoot, 'node_modules')]);
  signApplication(destination);
  run('/usr/bin/touch', [destination]);
  run(launchServices, ['-f', destination]);
}

function addToDock() {
  const currentDock = run('/usr/bin/defaults', ['export', 'com.apple.dock', '-']);
  if (currentDock.includes(`${APP_NAME}.app`) || currentDock.includes(`<string>${APP_NAME}</string>`)) return false;
  const applicationUrl = `${pathToFileURL(destination).href}/`;
  const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${applicationUrl}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>${APP_NAME}</string></dict><key>tile-type</key><string>file-tile</string></dict>`;
  run('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile]);
  run('/usr/bin/killall', ['Dock']);
  return true;
}

installApplication();
const dockChanged = addToDock();
run('/usr/bin/open', ['-n', destination]);
process.stdout.write([
  `Installed ${APP_NAME} at ${destination}`,
  dockChanged ? 'Added it to the Dock.' : 'It was already present in the Dock.',
  `Bound launcher to ${repoRoot}`,
  `Runtime contract: ${readFileSync(join(here, 'config.json'), 'utf8').trim()}`,
  `Startup log: ${join(homedir(), 'Library', 'Logs', `${APP_NAME}.log`)}`,
  '',
].join('\n'));
