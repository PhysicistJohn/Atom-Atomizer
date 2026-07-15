import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE,
  SIGNAL_LAB_PACKAGED_BRIDGE_RELATIVE_PATH,
  SignalLabBridgeClient,
  resolveSignalLabBridgeLocation,
} from './signal-lab-bridge-client.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SignalLab bridge resolver', () => {
  it('resolves only an explicit override, injected packaged resources, or the canonical sibling artifact', async () => {
    const fixture = await createFixture('valid');
    const overridden = await resolveSignalLabBridgeLocation({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      packagedResourcesRoot: fixture.packagedResourcesRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: fixture.executable },
    });
    expect(overridden).toEqual({
      executablePath: fixture.executable,
      repositoryRoot: fixture.signalLabRoot,
      source: 'environment',
    });

    const packaged = await resolveSignalLabBridgeLocation({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      packagedResourcesRoot: fixture.packagedResourcesRoot,
      environment: {},
    });
    expect(packaged).toEqual({
      executablePath: resolve(fixture.packagedResourcesRoot, SIGNAL_LAB_PACKAGED_BRIDGE_RELATIVE_PATH),
      repositoryRoot: resolve(fixture.packagedResourcesRoot, 'signal-lab'),
      source: 'packaged-resource',
    });

    const sibling = await resolveSignalLabBridgeLocation({ atomizerRepositoryRoot: fixture.atomizerRoot, environment: {} });
    expect(sibling).toEqual({
      executablePath: fixture.executable,
      repositoryRoot: fixture.signalLabRoot,
      source: 'sibling-development',
    });
    await expect(resolveSignalLabBridgeLocation({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: './bridge.js' },
    })).rejects.toThrow(/absolute path/);
    await expect(resolveSignalLabBridgeLocation({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      packagedResourcesRoot: './Resources',
      environment: {},
    })).rejects.toThrow(/packaged resources root must be an absolute path/);
  });

  it('rejects symlinks and writable executable artifacts before spawning', async () => {
    const fixture = await createFixture('valid');
    const link = resolve(fixture.root, 'bridge-link.js');
    await symlink(fixture.executable, link);
    await expect(resolveSignalLabBridgeLocation({
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: link },
    })).rejects.toThrow(/non-symlink/);
    await chmod(fixture.executable, 0o722);
    await expect(resolveSignalLabBridgeLocation({
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: fixture.executable },
    })).rejects.toThrow(/group- or world-writable/);
  });
});

describe('SignalLab bridge client', () => {
  const atomizerRepositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
  const shippedBridge = resolve(atomizerRepositoryRoot, '..', 'TinySA_SignalLab', 'dist', 'bridge', 'atomizer-bridge.js');
  const electronExecutable = findElectronExecutable(atomizerRepositoryRoot);
  // Standalone Atomizer CI does not check out sibling repositories. The trio
  // release gate builds SignalLab first, so this remains a required live
  // interoperability test whenever the shipped bridge artifact is present.
  it.skipIf(!existsSync(shippedBridge))('interoperates with the sibling repository\'s shipped bridge contract', async () => {
    const client = await SignalLabBridgeClient.launch(await resolveSignalLabBridgeLocation({
      atomizerRepositoryRoot,
      environment: {},
    }), { diagnostics: () => undefined });
    const status = await client.status();
    expect(status.profiles.length).toBeGreaterThan(10);
    expect(status.identity.claims).toEqual({ usbEmulated: false, firmwareExecuted: false, rfEmitted: false });
    const spectrum = await client.acquireSpectrum({ startHz: 99_900_000, stopHz: 100_100_000, points: 17 });
    expect(spectrum.frequencyHz).toHaveLength(17);
    await client.close();
  });

  it.skipIf(!electronExecutable)('handshakes and exits zero under the installed Electron executable in Node mode', async () => {
    const fixture = await createFixture('electron-node-runtime');
    const client = await SignalLabBridgeClient.launch(await fixture.location(), {
      runtimeExecutablePath: electronExecutable,
      readyTimeoutMs: 5_000,
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    });
    expect(client.ready.contractId).toBe('tinysa-signal-lab-atomizer-measurement');
    expect((await client.status()).profile).toBe('cw');
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('consumes strict, correlated high-level measurements and keeps stderr diagnostic-only', async () => {
    const fixture = await createFixture('valid');
    const diagnostics: string[] = [];
    const client = await SignalLabBridgeClient.launch(await fixture.location(), {
      readyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      diagnostics: (line) => diagnostics.push(line),
    });
    expect(client.ready.identity.claims).toEqual({ usbEmulated: false, firmwareExecuted: false, rfEmitted: false });
    expect(client.ready.capabilities.map((capability) => capability.kind)).toEqual([
      'swept-spectrum', 'detected-power-timeseries',
    ]);
    expect((await client.status()).profile).toBe('cw');
    expect((await client.selectProfile('fm')).profile).toBe('fm');
    expect((await client.configureChannel({ model: 'rayleigh', noiseFloorDbm: -120, seed: 7, fadingRateHz: 4 })).channel.model).toBe('rayleigh');
    const spectrum = await client.acquireSpectrum({ startHz: 99_000_000, stopHz: 101_000_000, points: 5 });
    expect(spectrum).toMatchObject({ kind: 'swept-spectrum', points: 5, complete: true });
    expect(spectrum.frequencyHz).toEqual([99_000_000, 99_500_000, 100_000_000, 100_500_000, 101_000_000]);
    const detected = await client.acquireDetectedPower({ points: 4, samplePeriodSeconds: 0.001 });
    expect(detected).toMatchObject({
      kind: 'detected-power-timeseries', centerFrequencyHz: 100_000_000,
      points: 4, samplePeriodSeconds: 0.001, complete: true,
    });
    await client.close();
    expect(diagnostics).toContain('fixture diagnostic');
  });

  it('reserves the final process-budget line for joined shutdown before renewal', async () => {
    const fixture = await createFixture('valid');
    const client = await SignalLabBridgeClient.launch(await fixture.location(), {
      readyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      renewalThresholdRequests: 3,
    });

    await client.status();
    expect(client.requestCount).toBe(1);
    expect(client.renewalRequired).toBe(false);
    await client.status();
    expect(client.requestCount).toBe(2);
    expect(client.renewalRequired).toBe(true);
    await expect(client.status()).rejects.toThrow(/reserved for shutdown/);
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.requestCount).toBe(3);
  });

  it('makes a wrong correlation ID terminal and never retries or accepts another request', async () => {
    const fixture = await createFixture('wrong-correlation');
    const failures: Error[] = [];
    const client = await SignalLabBridgeClient.launch(await fixture.location(), {
      readyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      onTerminalFailure: (error) => failures.push(error),
    });
    await expect(client.status()).rejects.toThrow(/correlation ID/);
    await expect(client.status()).rejects.toThrow(/correlation ID/);
    expect(failures).toHaveLength(1);
    await expect(client.close()).rejects.toThrow(/correlation ID/);
  });

  it('makes any selected-waveform metadata or optional asset-hash drift terminal', async () => {
    for (const mode of ['waveform-metadata-drift', 'waveform-asset-hash-drift'] as const) {
      const fixture = await createFixture(mode);
      const failures: Error[] = [];
      const client = await SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
        onTerminalFailure: (error) => failures.push(error),
      });

      await expect(client.status()).rejects.toThrow(/selected waveform drifted from its catalog entry/);
      await expect(client.status()).rejects.toThrow(/selected waveform drifted from its catalog entry/);
      expect(failures).toHaveLength(1);
      await expect(client.close()).rejects.toThrow(/selected waveform drifted from its catalog entry/);
    }
  });

  it('treats a response timeout as terminal and rejects simultaneous requests at the client boundary', async () => {
    const delayed = await createFixture('delayed-status');
    const client = await SignalLabBridgeClient.launch(await delayed.location(), {
      readyTimeoutMs: 1_000, requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000,
    });
    const first = client.status();
    await expect(client.status()).rejects.toThrow(/exactly one in-flight/);
    expect((await first).profile).toBe('cw');
    await client.close();

    const silent = await createFixture('silent-after-ready');
    const timed = await SignalLabBridgeClient.launch(await silent.location(), {
      readyTimeoutMs: 1_000, requestTimeoutMs: 30, shutdownTimeoutMs: 200,
    });
    await expect(timed.status()).rejects.toThrow(/timed out; the request was not retried/);
    await expect(timed.status()).rejects.toThrow(/timed out; the request was not retried/);
    await expect(timed.close()).rejects.toThrow(/timed out/);
  });

  it('treats an unexpected child exit as a permanent session failure', async () => {
    const fixture = await createFixture('exit-after-ready');
    const failures: Error[] = [];
    const client = await SignalLabBridgeClient.launch(await fixture.location(), {
      readyTimeoutMs: 1_000, requestTimeoutMs: 1_000, shutdownTimeoutMs: 200,
      onTerminalFailure: (error) => failures.push(error),
    });
    await expect(client.status()).rejects.toThrow(/closed stdout unexpectedly/);
    await expect(client.status()).rejects.toThrow(/closed stdout unexpectedly/);
    expect(failures).toHaveLength(1);
    await expect(client.close()).rejects.toThrow(/closed stdout unexpectedly/);
  });

  it('treats clean stdout EOF as terminal even when the child otherwise stays alive', async () => {
    const fixture = await createFixture('close-stdout-after-ready');
    const failures: Error[] = [];
    let client: SignalLabBridgeClient;
    try {
      client = await SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 1_000, requestTimeoutMs: 1_000, shutdownTimeoutMs: 200,
        onTerminalFailure: (error) => failures.push(error),
      });
    } catch (value) {
      expect(value).toBeInstanceOf(Error);
      expect((value as Error).message).toMatch(/closed stdout unexpectedly/);
      return;
    }
    await expect(client.status()).rejects.toThrow(/closed stdout unexpectedly/);
    expect(failures).toHaveLength(1);
    await expect(client.close()).rejects.toThrow(/closed stdout unexpectedly/);
  });

  it('reaps the child before rejecting a duplicate-ready handoff failure', async () => {
    const fixture = await createFixture('duplicate-ready');
    const diagnostics: string[] = [];
    await expect(SignalLabBridgeClient.launch(await fixture.location(), {
      readyTimeoutMs: 500, requestTimeoutMs: 500, shutdownTimeoutMs: 500,
      diagnostics: (line) => diagnostics.push(line),
    })).rejects.toThrow();
    const pid = Number(diagnostics.find((line) => line.startsWith('fixture-pid='))?.slice('fixture-pid='.length));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('rejects malformed and contract-drifted ready handshakes before composition', async () => {
    for (const mode of ['malformed-ready', 'extra-ready-field'] as const) {
      const fixture = await createFixture(mode);
      await expect(SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 500, requestTimeoutMs: 500, shutdownTimeoutMs: 200,
      })).rejects.toThrow();
    }
  });
});

type FixtureMode = 'valid' | 'wrong-correlation' | 'delayed-status' | 'silent-after-ready' | 'exit-after-ready'
  | 'close-stdout-after-ready' | 'malformed-ready' | 'extra-ready-field' | 'duplicate-ready' | 'electron-node-runtime'
  | 'waveform-metadata-drift' | 'waveform-asset-hash-drift';

async function createFixture(mode: FixtureMode): Promise<{
  root: string;
  atomizerRoot: string;
  signalLabRoot: string;
  packagedResourcesRoot: string;
  executable: string;
  location(): ReturnType<typeof resolveSignalLabBridgeLocation>;
}> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'atomizer-signal-lab-')));
  temporaryRoots.push(root);
  const atomizerRoot = resolve(root, 'TinySA');
  const signalLabRoot = resolve(root, 'TinySA_SignalLab');
  const executable = resolve(signalLabRoot, 'dist', 'bridge', 'atomizer-bridge.js');
  const packagedResourcesRoot = resolve(root, 'Atomizer.app', 'Contents', 'Resources');
  const packagedExecutable = resolve(packagedResourcesRoot, SIGNAL_LAB_PACKAGED_BRIDGE_RELATIVE_PATH);
  await mkdir(resolve(signalLabRoot, 'dist', 'bridge'), { recursive: true });
  await mkdir(resolve(packagedExecutable, '..'), { recursive: true });
  await mkdir(atomizerRoot, { recursive: true });
  const program = fixtureProgram(mode);
  await Promise.all([
    writeFile(executable, program, { mode: 0o700 }),
    writeFile(packagedExecutable, program, { mode: 0o700 }),
  ]);
  return {
    root, atomizerRoot, signalLabRoot, packagedResourcesRoot, executable,
    location: () => resolveSignalLabBridgeLocation({
      atomizerRepositoryRoot: atomizerRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: executable },
    }),
  };
}

function fixtureProgram(mode: FixtureMode): string {
  const ready = readyMessage();
  if (mode === 'malformed-ready') return `#!/usr/bin/env node\nprocess.stdout.write('{not-json}\\n'); setInterval(() => {}, 1000);\n`;
  if (mode === 'extra-ready-field') return `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ ...ready, unexpected: true })}) + '\\n'); setInterval(() => {}, 1000);\n`;
  if (mode === 'duplicate-ready') return `#!/usr/bin/env node\nconst ready = ${JSON.stringify(ready)}; process.stderr.write('fixture-pid=' + process.pid + '\\n'); process.stdout.write(JSON.stringify(ready) + '\\n' + JSON.stringify(ready) + '\\n'); setInterval(() => {}, 1000);\n`;
  if (mode === 'exit-after-ready') return `#!/usr/bin/env node\nconst ready = ${JSON.stringify(ready)}; process.stdout.write(JSON.stringify(ready) + '\\n'); setTimeout(() => process.exit(7), 20);\n`;
  if (mode === 'close-stdout-after-ready') return `#!/usr/bin/env node\nconst ready = ${JSON.stringify(ready)}; process.stdout.write(JSON.stringify(ready) + '\\n', () => { process.stdout.end(); setInterval(() => {}, 1000); });\n`;
  return `#!/usr/bin/env node
if (${JSON.stringify(mode)} === 'electron-node-runtime'
  && (process.env.ELECTRON_RUN_AS_NODE !== '1' || typeof process.versions.electron !== 'string')) {
  process.stderr.write('fixture requires Electron running explicitly as Node\\n');
  process.exit(9);
}
const readline = require('node:readline');
const ready = ${JSON.stringify(ready)};
process.stdout.write(JSON.stringify(ready) + '\\n');
process.stderr.write('fixture diagnostic\\n');
let profile = 'cw';
let revision = '20000000-0000-4000-8000-000000000001';
let sequence = 0;
const descriptors = ${JSON.stringify(waveforms())};
const identity = ready.identity;
const capabilities = ready.capabilities;
const channel = { model: 'awgn', noiseFloorDbm: -110, seed: 1, fadingRateHz: 1 };
const status = () => {
  const selected = descriptors.find((item) => item.id === profile);
  let waveform = selected;
  if (${JSON.stringify(mode)} === 'waveform-metadata-drift') {
    waveform = { ...selected, standard: { ...selected.standard, clause: 'drifted-clause' } };
  } else if (${JSON.stringify(mode)} === 'waveform-asset-hash-drift') {
    const { assetSha256: _omittedAssetSha256, ...withoutAssetSha256 } = selected;
    waveform = withoutAssetSha256;
  }
  return {
    kind: 'status', sessionId: ready.sessionId, configurationRevision: revision,
    updatedAt: '2026-07-14T20:00:00.000Z', available: true, active: true,
    profile, profiles: ['cw', 'fm'], waveform,
    catalog: descriptors, channel, capabilities, identity,
  };
};
const reply = (request, result, requestId = request.requestId) => {
  process.stdout.write(JSON.stringify({ type: 'response', contractVersion: 1, requestId, ok: true, result }) + '\\n');
};
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const request = JSON.parse(line);
  if (${JSON.stringify(mode)} === 'silent-after-ready') return;
  const execute = () => {
    if (${JSON.stringify(mode)} === 'wrong-correlation') { reply(request, status(), 'wrong-request'); return; }
    if (request.method === 'status') reply(request, status());
    else if (request.method === 'select_profile') { profile = request.params.profile; revision = '20000000-0000-4000-8000-000000000002'; reply(request, status()); }
    else if (request.method === 'configure_channel') { Object.assign(channel, request.params.channel); revision = '20000000-0000-4000-8000-000000000003'; reply(request, status()); }
    else if (request.method === 'acquire_spectrum') {
      sequence += 1;
      const { startHz, stopHz, points } = request.params;
      const frequencyHz = Array.from({ length: points }, (_, index) => startHz + (stopHz - startHz) * index / (points - 1));
      reply(request, measurement({ kind: 'swept-spectrum', startHz, stopHz, points, frequencyHz, powerDbm: Array(points).fill(-70) }));
    } else if (request.method === 'acquire_detected_power') {
      sequence += 1;
      const { points, samplePeriodSeconds } = request.params;
      reply(request, measurement({ kind: 'detected-power-timeseries', centerFrequencyHz: 100000000, points, samplePeriodSeconds, powerDbm: Array(points).fill(-65) }));
    } else if (request.method === 'shutdown') {
      reply(request, { kind: 'shutdown', closed: true });
      setTimeout(() => process.exit(0), 5);
    }
  };
  if (${JSON.stringify(mode)} === 'delayed-status' && request.method === 'status') setTimeout(execute, 40);
  else execute();
});
function measurement(specific) {
  return {
    measurementId: '30000000-0000-4000-8000-' + String(sequence).padStart(12, '0'),
    sessionId: ready.sessionId, configurationRevision: revision, sequence,
    capturedAt: '2026-07-14T20:00:01.000Z', elapsedSeconds: 0.001,
    complete: true, qualification: 'synthetic-visual-projection', provenance: identity,
    ...specific,
  };
}
`;
}

function findElectronExecutable(repositoryRoot: string): string | undefined {
  const candidates = process.platform === 'darwin'
    ? [resolve(repositoryRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')]
    : process.platform === 'win32'
      ? [resolve(repositoryRoot, 'node_modules/electron/dist/electron.exe')]
      : [resolve(repositoryRoot, 'node_modules/electron/dist/electron')];
  return candidates.find((candidate) => existsSync(candidate));
}

function readyMessage() {
  return {
    type: 'ready', protocol: 'signal-lab-measurement-bridge',
    contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1,
    service: 'tinysa-signal-lab', sessionId: '10000000-0000-4000-8000-000000000001',
    identity: {
      driverId: 'signal-lab', sourceKind: 'signal-lab-simulation', execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge', contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 1, contractSha256: '1'.repeat(64), catalogSha256: '2'.repeat(64),
      generatorSha256: '3'.repeat(64), claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    },
    capabilities: [
      {
        kind: 'swept-spectrum', minimumFrequencyHz: 1, maximumFrequencyHz: 17_922_600_000,
        minimumPoints: 2, maximumPoints: 4_096, frequencyUnit: 'Hz', powerUnit: 'dBm',
        qualification: 'synthetic-visual-projection',
      },
      {
        kind: 'detected-power-timeseries', minimumPoints: 1, maximumPoints: 4_096,
        minimumSamplePeriodSeconds: 0.000_001, maximumSamplePeriodSeconds: 10,
        powerUnit: 'dBm', qualification: 'synthetic-visual-projection',
      },
    ],
    limits: {
      maxRequestLineBytes: 65_536, maxResponseLineBytes: 1_048_576,
      maxQueuedRequests: 32, maxSessionRequests: 10_000, reservedShutdownRequests: 1, requestTimeoutMs: 5_000,
    },
  };
}

function waveforms() {
  return ['cw', 'fm'].map((id) => ({
    id, label: id.toUpperCase(), family: id === 'cw' ? 'tone' : 'analog', model: `${id}-model`,
    qualification: 'visual', centerHz: 100_000_000, occupiedBandwidthHz: id === 'cw' ? 1 : 20_000,
    recommendedSpanHz: id === 'cw' ? 100_000 : 100_000,
    projection: {
      allocation: id === 'cw' ? 'carrier' : 'sidebands', modulation: id === 'cw' ? 'unmodulated' : 'fm',
      timing: 'continuous',
    },
    standard: {
      organization: 'TinySA SignalLab', specification: 'fixture', clause: 'fixture', revision: '1',
      url: 'https://example.test/signal-lab',
    },
    disclosure: 'Synthetic fixture only.',
    ...(id === 'cw' ? { assetSha256: '4'.repeat(64) } : {}),
  }));
}
