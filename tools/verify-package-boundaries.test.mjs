import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const verifier = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-package-boundaries.mjs');

test('admits the independent runtime, SignalLab adapter, TinySA adapter, and desktop composition', async () => {
  await withFixture(async (root) => {
    const result = await verify(root);
    assert.match(result.stdout, /"signalLabDriver": "independent-no-serialport"/);
  });
});

for (const scenario of [
  {
    name: 'rejects a reverse runtime dependency on the TinySA adapter',
    failure: /imports undeclared production package @tinysa\/device|instrument-runtime.*illegally imports @tinysa\/device/s,
    mutate: (root) => append(root, 'packages/instrument-runtime/src/index.ts', "\nimport '@tinysa/device';\n"),
  },
  {
    name: 'rejects a reverse type dependency from runtime to the SignalLab adapter',
    failure: /imports undeclared production package @tinysa\/signal-lab-driver|instrument-runtime.*illegally imports @tinysa\/signal-lab-driver/s,
    mutate: (root) => append(
      root,
      'packages/instrument-runtime/src/index.ts',
      "\nimport type { SignalLabInstrumentDriver } from '@tinysa/signal-lab-driver';\nexport type ReverseAdapterLeak = SignalLabInstrumentDriver;\n",
    ),
  },
  {
    name: 'rejects a reverse adapter type reference injected only into runtime declarations',
    failure: /instrument-runtime dist or declarations illegally reference @tinysa\/signal-lab-driver/,
    mutate: (root) => append(
      root,
      'packages/instrument-runtime/dist/index.d.ts',
      "\nexport type { SignalLabInstrumentDriver } from '@tinysa/signal-lab-driver';\n",
    ),
  },
  {
    name: 'rejects serial coupling in the SignalLab adapter',
    failure: /signal-lab-driver production dependency whitelist/,
    mutate: async (root) => {
      const path = join(root, 'packages/signal-lab-driver/package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.dependencies.serialport = '13.0.0';
      await writeFile(path, JSON.stringify(manifest));
    },
  },
  {
    name: 'requires the SignalLab package build to externalize the generic runtime',
    failure: /SignalLab package external build boundary/,
    mutate: async (root) => {
      const path = join(root, 'packages/signal-lab-driver/package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.scripts.build = manifest.scripts.build.replace(' --external @tinysa/instrument-runtime', '');
      await writeFile(path, JSON.stringify(manifest));
    },
  },
  {
    name: 'rejects a bundled generic-runtime implementation in the SignalLab artifact',
    failure: /signal-lab-driver dist illegally bundles the generic-runtime measurement parser implementation/,
    mutate: (root) => append(
      root,
      'packages/signal-lab-driver/dist/index.js',
      '\nfunction parseInstrumentMeasurement(value) { return value; }\n',
    ),
  },
  {
    name: 'rejects a TinySA dependency on the independent SignalLab adapter',
    failure: /device production dependency whitelist/,
    mutate: async (root) => {
      const path = join(root, 'packages/tinysa/package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.dependencies['@tinysa/signal-lab-driver'] = '*';
      await writeFile(path, JSON.stringify(manifest));
    },
  },
  {
    name: 'rejects Electron as a TinySA production dependency even when source and artifact agree',
    failure: /device production dependency whitelist/,
    mutate: async (root) => {
      const path = join(root, 'packages/tinysa/package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.dependencies.electron = '43.1.0';
      await writeFile(path, JSON.stringify(manifest));
      await append(root, 'packages/tinysa/src/index.ts', "\nimport 'electron';\n");
      await append(root, 'packages/tinysa/dist/index.js', "\nimport 'electron';\n");
    },
  },
  {
    name: 'rejects an Electron import injected only into the TinySA built artifact',
    failure: /device artifact.*illegally imports electron/,
    mutate: (root) => append(root, 'packages/tinysa/dist/index.js', "\nimport 'electron';\n"),
  },
  {
    name: 'rejects re-exporting generic lifecycle ownership from the TinySA adapter',
    failure: /must not re-export @tinysa\/instrument-runtime/,
    mutate: (root) => append(root, 'packages/tinysa/src/index.ts', "\nexport * from '@tinysa/instrument-runtime';\n"),
  },
  {
    name: 'rejects aliasing a generic runtime value through the TinySA adapter',
    failure: /only through erased type imports/,
    mutate: (root) => append(
      root,
      'packages/tinysa/src/index.ts',
      "\nimport { InstrumentManager as GenericManager } from '@tinysa/instrument-runtime';\nexport { GenericManager };\n",
    ),
  },
  {
    name: 'rejects aliasing a generic lifecycle type through the TinySA adapter',
    failure: /non-interface compatibility binding/,
    mutate: (root) => append(
      root,
      'packages/tinysa/src/index.ts',
      "\nimport type { InstrumentManager as GenericManager } from '@tinysa/instrument-runtime';\nexport type { GenericManager };\n",
    ),
  },
  {
    name: 'rejects re-exporting even an admitted runtime interface under a local alias',
    failure: /locally re-exports a binding/,
    mutate: (root) => append(
      root,
      'packages/tinysa/src/index.ts',
      "\nimport type { InstrumentDriver as GenericDriver } from '@tinysa/instrument-runtime';\nexport type { GenericDriver };\n",
    ),
  },
  {
    name: 'rejects generic lifecycle ownership imported through the device facade',
    failure: /generic runtime ownership from the device compatibility facade/,
    mutate: async (root) => {
      const path = join(root, 'apps/desktop/src/main/main.ts');
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(
        "import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';",
        "import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/device';",
      ));
    },
  },
  {
    name: 'rejects a SignalLab implementation bundled in the TinySA artifact',
    failure: /device dist illegally bundles the separated SignalLab driver implementation/,
    mutate: (root) => append(root, 'packages/tinysa/dist/index.js', '\nclass SignalLabInstrumentDriver {}\n'),
  },
  {
    name: 'rejects SignalLab adapter imports through the TinySA package',
    failure: /imports SignalLab adapter ownership from the TinySA device package/,
    mutate: async (root) => {
      const path = join(root, 'apps/desktop/src/main/main.ts');
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(
        "import { SignalLabInstrumentDriver } from '@tinysa/signal-lab-driver';",
        "import { SignalLabInstrumentDriver } from '@tinysa/device';",
      ));
    },
  },
  {
    name: 'rejects a desktop production import listed only as a development dependency',
    failure: /imports undeclared production package fixture-dev-only/,
    mutate: async (root) => {
      const manifestPath = join(root, 'apps/desktop/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.devDependencies = { 'fixture-dev-only': '1.0.0' };
      await writeFile(manifestPath, JSON.stringify(manifest));
      await append(root, 'apps/desktop/src/main/main.ts', "\nimport 'fixture-dev-only';\n");
    },
  },
  {
    name: 'rejects renderer access to Electron runtime APIs',
    failure: /desktop renderer.*illegally imports electron/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport { ipcRenderer } from 'electron';\nvoid ipcRenderer;\n",
    ),
  },
  {
    name: 'rejects renderer coupling even through an erased Electron type import',
    failure: /desktop renderer.*illegally imports electron/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport type { IpcRenderer } from 'electron';\nexport type RendererEscape = IpcRenderer;\n",
    ),
  },
  {
    name: 'rejects renderer access to node:-qualified built-ins',
    failure: /desktop renderer.*illegally imports Node built-in node:fs\/promises/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport { readFile } from 'node:fs/promises';\nvoid readFile;\n",
    ),
  },
  {
    name: 'rejects renderer access to bare Node built-ins',
    failure: /desktop renderer.*illegally imports Node built-in fs\/promises/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport { readFile } from 'fs/promises';\nvoid readFile;\n",
    ),
  },
  {
    name: 'rejects renderer access to the TinySA device adapter',
    failure: /desktop renderer.*illegally imports @tinysa\/device/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport { TinySaDeviceService } from '@tinysa/device';\nvoid TinySaDeviceService;\n",
    ),
  },
  {
    name: 'rejects renderer access to generic instrument lifecycle ownership',
    failure: /desktop renderer.*illegally imports @tinysa\/instrument-runtime/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport { InstrumentManager } from '@tinysa/instrument-runtime';\nvoid InstrumentManager;\n",
    ),
  },
  {
    name: 'rejects renderer access to the SignalLab driver adapter',
    failure: /desktop renderer.*illegally imports @tinysa\/signal-lab-driver/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/renderer/instrument-preference.ts',
      "\nimport { SignalLabInstrumentDriver } from '@tinysa/signal-lab-driver';\nvoid SignalLabInstrumentDriver;\n",
    ),
  },
  {
    name: 'rejects preload access to the TinySA device adapter',
    failure: /desktop preload.*preload\.ts.*illegally imports runtime module @tinysa\/device/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/main/preload.ts',
      "\nimport { TinySaDeviceService } from '@tinysa/device';\nvoid TinySaDeviceService;\n",
    ),
  },
  {
    name: 'rejects preload access to node:-qualified built-ins',
    failure: /desktop preload.*illegally imports Node built-in node:fs\/promises/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/main/preload.ts',
      "\nimport { readFile } from 'node:fs/promises';\nvoid readFile;\n",
    ),
  },
  {
    name: 'rejects preload access to bare Node built-ins',
    failure: /desktop preload.*illegally imports Node built-in fs\/promises/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/main/preload.ts',
      "\nimport { readFile } from 'fs/promises';\nvoid readFile;\n",
    ),
  },
  {
    name: 'rejects runtime workspace modules from the sandboxed preload',
    failure: /desktop preload.*illegally imports runtime module @tinysa\/contracts/,
    mutate: async (root) => {
      const manifestPath = join(root, 'apps/desktop/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.dependencies['@tinysa/contracts'] = '*';
      await writeFile(manifestPath, JSON.stringify(manifest));
      await append(
        root,
        'apps/desktop/src/main/preload.ts',
        "\nimport { instrumentCandidateSchema } from '@tinysa/contracts';\nvoid instrumentCandidateSchema;\n",
      );
    },
  },
  {
    name: 'rejects unapproved main-process lifecycle ownership imports',
    failure: /lifecycle ownership.*unapproved-main\.ts.*illegally imports @tinysa\/instrument-runtime/,
    mutate: (root) => append(
      root,
      'apps/desktop/src/main/unapproved-main.ts',
      "\nimport type { InstrumentSession } from '@tinysa/instrument-runtime';\nexport type LeakedSession = InstrumentSession;\n",
    ),
  },
  {
    name: 'rejects converting an erased development-only type import into a runtime import',
    failure: /imports undeclared production package vite/,
    mutate: async (root) => {
      const path = join(root, 'apps/desktop/src/main/development-renderer-csp-vite.ts');
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace('import type', 'import'));
    },
  },
  {
    name: 'rejects a computed dynamic import that evades manifest attribution',
    failure: /non-literal dynamic import or require dependency/,
    mutate: (root) => append(root, 'apps/desktop/src/main/main.ts', "\nvoid import('vi' + 'te');\n"),
  },
  {
    name: 'rejects a computed require that evades manifest attribution',
    failure: /non-literal dynamic import or require dependency/,
    mutate: (root) => append(root, 'apps/desktop/src/main/main.ts', "\nvoid require('vi' + 'te');\n"),
  },
]) {
  test(scenario.name, async () => {
    await withFixture(async (root) => {
      await scenario.mutate(root);
      await assert.rejects(verify(root), (error) => scenario.failure.test(`${error.stderr ?? ''}\n${error.message}`));
    });
  });
}

async function withFixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'atomizer-boundaries-'));
  try {
    await createFixture(root);
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createFixture(root) {
  const files = {
    'package.json': JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'packages/instrument-runtime/package.json': JSON.stringify({
      name: '@tinysa/instrument-runtime',
      dependencies: { '@tinysa/contracts': '*', zod: '4.4.3' },
    }),
    'packages/instrument-runtime/src/index.ts': "import { z } from 'zod';\nimport '@tinysa/contracts';\nexport const runtime = z.string();\n",
    'packages/instrument-runtime/dist/index.js': 'export class InstrumentManager {}\n',
    'packages/instrument-runtime/dist/index.d.ts': 'export declare class InstrumentManager {}\n',
    'packages/signal-lab-driver/package.json': JSON.stringify({
      name: '@tinysa/signal-lab-driver',
      dependencies: { '@tinysa/contracts': '*', '@tinysa/instrument-runtime': '*' },
      scripts: { build: 'tsup src/index.ts --format esm --dts --clean --external @tinysa/instrument-runtime' },
    }),
    'packages/signal-lab-driver/src/index.ts': "import '@tinysa/contracts';\nimport '@tinysa/instrument-runtime';\nexport class SignalLabInstrumentDriver {}\n",
    'packages/signal-lab-driver/dist/index.js': "import '@tinysa/contracts';\nimport { parseInstrumentMeasurement } from \"@tinysa/instrument-runtime\";\nvoid parseInstrumentMeasurement;\nexport class SignalLabInstrumentDriver {}\n",
    'packages/signal-lab-driver/dist/index.d.ts': "import type { InstrumentDriver } from '@tinysa/instrument-runtime';\nexport declare class SignalLabInstrumentDriver implements InstrumentDriver {}\n",
    'packages/tinysa/package.json': JSON.stringify({
      name: '@tinysa/device',
      dependencies: { '@tinysa/contracts': '*', '@tinysa/instrument-runtime': '*', serialport: '13.0.0' },
      scripts: { build: 'tsup src/index.ts --format esm --dts --clean --external serialport --external @tinysa/instrument-runtime' },
    }),
    'packages/tinysa/src/index.ts': "import '@tinysa/contracts';\nimport 'serialport';\nexport class TinySaZs407InstrumentDriver {}\n",
    'packages/tinysa/dist/index.js': 'export class TinySaZs407InstrumentDriver {}\n',
    'packages/tinysa/dist/index.d.ts': 'export declare class TinySaZs407InstrumentDriver {}\n',
    'apps/desktop/package.json': JSON.stringify({
      name: '@tinysa/desktop',
      dependencies: {
        '@tinysa/device': '*',
        '@tinysa/instrument-runtime': '*',
        '@tinysa/signal-lab-driver': '*',
      },
      devDependencies: { vite: '7.0.0' },
    }),
    'apps/desktop/src/main/main.ts': [
      "import '@tinysa/device';",
      "import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';",
      "import { SignalLabInstrumentDriver } from '@tinysa/signal-lab-driver';",
      'void InstrumentDriverRegistry; void InstrumentManager; void SignalLabInstrumentDriver;',
      '',
    ].join('\n'),
    'apps/desktop/src/main/atomizer-instrument-host.ts': "import { fingerprintInstrumentMeasurement } from '@tinysa/instrument-runtime';\nvoid fingerprintInstrumentMeasurement;\n",
    'apps/desktop/src/main/development-renderer-csp-vite.ts': "import type { Plugin } from 'vite';\nexport type DevelopmentPlugin = Plugin;\n",
    'apps/desktop/src/main/preload.ts': "import { contextBridge } from 'electron';\nvoid contextBridge;\n",
    'apps/desktop/src/main/unapproved-main.ts': 'export const unapprovedMain = true;\n',
    'apps/desktop/src/renderer/instrument-preference.ts': 'export const rendererPreference = true;\n',
    'tools/dev-launcher/main.cjs': [
      "['tinysa', ['--external', 'serialport', '--external', '@tinysa/instrument-runtime']]",
      "['signal-lab-driver', ['--external', '@tinysa/instrument-runtime']]",
      '',
    ].join('\n'),
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function append(root, relativePath, contents) {
  const path = join(root, relativePath);
  await writeFile(path, `${await readFile(path, 'utf8')}${contents}`);
}

function verify(root) {
  return execute(process.execPath, [verifier], {
    cwd: root,
    env: { ...process.env, TINYSA_BOUNDARY_ROOT: root },
  });
}
