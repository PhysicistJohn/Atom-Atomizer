import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE,
  SIGNAL_LAB_PACKAGED_BRIDGE_RELATIVE_PATH,
  SIGNAL_LAB_PROFILE_IDS,
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
    expect(status.profiles).toHaveLength(34);
    expect(status.identity.claims).toEqual({ usbEmulated: false, firmwareExecuted: false, rfEmitted: false });
    expect(status.catalog.find((item) => item.id === 'lte-band38-tdd-10m')?.projection).toMatchObject({
      duplex: 'tdd', timing: 'tdd-frame',
    });
    expect(status.catalog.find((item) => item.id === 'wifi-hr-dsss-11m')?.projection.modulation).toBe('hr-dsss');
    expect(status.catalog.find((item) => item.id === 'bluetooth-classic-connected')).toMatchObject({
      family: 'bluetooth',
      projection: { allocation: 'frequency-hopping', modulation: 'br-edr', timing: 'classic-slots' },
      source: {
        organization: 'Bluetooth SIG',
        references: expect.arrayContaining([
          expect.objectContaining({ specification: 'Bluetooth Core 6.3, Vol 2, Part A' }),
          expect.objectContaining({ specification: 'Bluetooth Core 6.3, Vol 2, Part B' }),
        ]),
      },
    });
    expect(status.catalog.find((item) => item.id === 'bluetooth-le-advertising')).toMatchObject({
      family: 'bluetooth',
      projection: { allocation: 'advertising-channels', modulation: 'ble-1m', timing: 'advertising-events' },
      source: {
        organization: 'Bluetooth SIG',
        references: expect.arrayContaining([
          expect.objectContaining({ specification: 'Bluetooth Core 6.3, Vol 6, Part A' }),
          expect.objectContaining({ specification: 'Bluetooth Core 6.3, Vol 6, Part B' }),
        ]),
      },
    });
    expect(status.catalog.find((item) => item.id === 'lte-band3-fdd-20m')?.source).toMatchObject({
      organization: '3GPP',
      references: expect.arrayContaining([
        expect.objectContaining({ specification: 'TS 36.101' }),
        expect.objectContaining({ specification: 'TS 36.211' }),
      ]),
    });
    expect(status.catalog.find((item) => item.id === 'nr-n78-tdd-100m')?.source).toMatchObject({
      organization: '3GPP',
      references: expect.arrayContaining([
        expect.objectContaining({ specification: 'TS 38.104' }),
        expect.objectContaining({ specification: 'TS 38.211' }),
      ]),
    });
    expect(status.catalog.find((item) => item.id === 'wifi-ofdm-20m')?.source).toMatchObject({
      organization: 'IEEE',
      references: expect.arrayContaining([
        expect.objectContaining({ specification: 'IEEE 802.11-2024' }),
      ]),
    });
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
    await expect(client.acquireDetectedPower({ centerFrequencyHz: 100_000_000.5, points: 4, samplePeriodSeconds: 0.001 }))
      .rejects.toThrow(/integer/);
    await expect(client.acquireDetectedPower({ centerFrequencyHz: 17_922_600_001, points: 4, samplePeriodSeconds: 0.001 }))
      .rejects.toThrow(/outside/);
    const detected = await client.acquireDetectedPower({ centerFrequencyHz: 100_000_125, points: 4, samplePeriodSeconds: 0.001 });
    expect(detected).toMatchObject({
      kind: 'detected-power-timeseries', centerFrequencyHz: 100_000_125,
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

  it('binds every measurement response to an immutable request snapshot and faults on geometry drift', async () => {
    const cases = [
      ['shifted-spectrum-geometry', 'spectrum'],
      ['wrong-spectrum-points', 'spectrum'],
      ['wrong-detected-center', 'detected'],
      ['wrong-detected-points', 'detected'],
      ['wrong-detected-sample-period', 'detected'],
    ] as const;
    for (const [mode, kind] of cases) {
      const fixture = await createFixture(mode);
      const failures: Error[] = [];
      const client = await SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
        onTerminalFailure: (error) => failures.push(error),
      });
      const spectrumRequest = { startHz: 99_000_000, stopHz: 101_000_000, points: 5 };
      const request = kind === 'spectrum'
        ? client.acquireSpectrum(spectrumRequest)
        : client.acquireDetectedPower({ centerFrequencyHz: 100_000_000, points: 4, samplePeriodSeconds: 0.001 });

      // A malicious result matches this post-dispatch mutation exactly. It
      // must still be compared with the private snapshot that was serialized.
      if (mode === 'shifted-spectrum-geometry') {
        spectrumRequest.startHz += 1_000;
        spectrumRequest.stopHz += 1_000;
      }

      await expect(request).rejects.toThrow(/result geometry does not match the admitted request/);
      await expect(client.status()).rejects.toThrow(/result geometry does not match the admitted request/);
      expect(client.requestCount).toBe(1);
      expect(failures).toHaveLength(1);
      await expect(client.close()).rejects.toThrow(/result geometry does not match the admitted request/);
    }
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

  it('rejects non-canonical or contradictory source provenance before admitting status', async () => {
    const cases = [
      ['insecure-source-url', /must use HTTPS/],
      ['duplicate-source-url', /reference URLs must be unique/],
      ['source-reference-whitespace', /must not have surrounding whitespace/],
      ['source-qualification-mismatch', /qualification does not match its source organization/],
      ['legacy-standard-field', /waveform fields are invalid/],
    ] as const;
    for (const [mode, message] of cases) {
      const fixture = await createFixture(mode);
      const client = await SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
      });
      await expect(client.status()).rejects.toThrow(message);
      await expect(client.close()).rejects.toThrow(message);
    }
  });

  it('rejects producer-removed allocation and timing variants at the bridge parser boundary', async () => {
    const cases = [
      ['projection-boosted', /SignalLab projection allocation/],
      ['projection-single-prb', /SignalLab projection allocation/],
      ['projection-subslot', /SignalLab projection timing/],
      ['projection-slot', /SignalLab projection timing/],
      ['projection-sbfd-du', /SignalLab projection timing/],
      ['projection-sbfd-ud', /SignalLab projection timing/],
      ['projection-sbfd-dud', /SignalLab projection timing/],
    ] as const;
    for (const [mode, message] of cases) {
      const fixture = await createFixture(mode);
      const client = await SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
      });
      await expect(client.status()).rejects.toThrow(message);
      await expect(client.close()).rejects.toThrow(message);
    }
  });

  it('pins the complete ordered measurement-contract v1 profile registry', async () => {
    expect(SIGNAL_LAB_PROFILE_IDS).toHaveLength(34);
    for (const mode of ['profiles-missing', 'profiles-extra', 'profiles-renamed', 'profiles-reordered'] as const) {
      const fixture = await createFixture(mode);
      const client = await SignalLabBridgeClient.launch(await fixture.location(), {
        readyTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
      });
      await expect(client.status()).rejects.toThrow(/SignalLab profile/);
      await expect(client.close()).rejects.toThrow(/SignalLab profile/);
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
  | 'shifted-spectrum-geometry' | 'wrong-spectrum-points' | 'wrong-detected-center'
  | 'wrong-detected-points' | 'wrong-detected-sample-period'
  | 'waveform-metadata-drift' | 'waveform-asset-hash-drift' | 'insecure-source-url'
  | 'duplicate-source-url' | 'source-reference-whitespace' | 'source-qualification-mismatch'
  | 'legacy-standard-field' | 'projection-boosted' | 'projection-single-prb'
  | 'projection-subslot' | 'projection-slot' | 'projection-sbfd-du' | 'projection-sbfd-ud'
  | 'projection-sbfd-dud' | 'profiles-missing' | 'profiles-extra' | 'profiles-renamed' | 'profiles-reordered';

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
  const projectionOverride = mode === 'projection-boosted' ? { allocation: 'boosted' }
    : mode === 'projection-single-prb' ? { allocation: 'single-prb' }
      : mode === 'projection-subslot' ? { timing: 'subslot' }
        : mode === 'projection-slot' ? { timing: 'slot' }
          : mode === 'projection-sbfd-du' ? { timing: 'sbfd-du' }
            : mode === 'projection-sbfd-ud' ? { timing: 'sbfd-ud' }
              : mode === 'projection-sbfd-dud' ? { timing: 'sbfd-dud' }
                : undefined;
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
const baseDescriptors = ${JSON.stringify(waveforms())};
const projectionOverride = ${JSON.stringify(projectionOverride ?? null)};
const descriptors = baseDescriptors.map((descriptor) => {
  const reference = descriptor.source.references[0];
  if (projectionOverride) return {
    ...descriptor,
    projection: { ...descriptor.projection, ...projectionOverride },
  };
  if (${JSON.stringify(mode)} === 'insecure-source-url') return {
    ...descriptor,
    source: { ...descriptor.source, references: [{ ...reference, url: 'http://example.test/insecure' }] },
  };
  if (${JSON.stringify(mode)} === 'duplicate-source-url') return {
    ...descriptor,
    source: {
      ...descriptor.source,
      references: [reference, { ...reference, specification: 'second fixture document' }],
    },
  };
  if (${JSON.stringify(mode)} === 'source-reference-whitespace') return {
    ...descriptor,
    source: { ...descriptor.source, references: [{ ...reference, specification: ' fixture' }] },
  };
  if (${JSON.stringify(mode)} === 'source-qualification-mismatch') return {
    ...descriptor,
    source: { ...descriptor.source, organization: '3GPP' },
  };
  if (${JSON.stringify(mode)} === 'legacy-standard-field') return {
    ...descriptor,
    standard: { organization: 'TinySA SignalLab' },
  };
  return descriptor;
});
const identity = ready.identity;
const capabilities = ready.capabilities;
const channel = { model: 'awgn', noiseFloorDbm: -110, seed: 1, fadingRateHz: 1 };
const status = () => {
  const selected = descriptors.find((item) => item.id === profile);
  const canonicalProfiles = descriptors.map((item) => item.id);
  const profiles = ${JSON.stringify(mode)} === 'profiles-missing'
    ? canonicalProfiles.slice(0, -1)
    : ${JSON.stringify(mode)} === 'profiles-extra'
      ? [...canonicalProfiles, 'future-profile']
      : ${JSON.stringify(mode)} === 'profiles-renamed'
        ? canonicalProfiles.map((id, index) => index === 1 ? 'future-profile' : id)
        : ${JSON.stringify(mode)} === 'profiles-reordered'
          ? [canonicalProfiles[1], canonicalProfiles[0], ...canonicalProfiles.slice(2)]
          : canonicalProfiles;
  let waveform = selected;
  if (${JSON.stringify(mode)} === 'waveform-metadata-drift') {
    waveform = {
      ...selected,
      source: {
        ...selected.source,
        references: selected.source.references.map((reference, index) => (
          index === 0 ? { ...reference, clause: 'drifted-clause' } : reference
        )),
      },
    };
  } else if (${JSON.stringify(mode)} === 'waveform-asset-hash-drift') {
    const { assetSha256: _omittedAssetSha256, ...withoutAssetSha256 } = selected;
    waveform = withoutAssetSha256;
  }
  return {
    kind: 'status', sessionId: ready.sessionId, configurationRevision: revision,
    updatedAt: '2026-07-14T20:00:00.000Z', available: true, active: true,
    profile, profiles, waveform,
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
      const resultStartHz = ${JSON.stringify(mode)} === 'shifted-spectrum-geometry' ? startHz + 1000 : startHz;
      const resultStopHz = ${JSON.stringify(mode)} === 'shifted-spectrum-geometry' ? stopHz + 1000 : stopHz;
      const resultPoints = ${JSON.stringify(mode)} === 'wrong-spectrum-points' ? points + 1 : points;
      const frequencyHz = Array.from({ length: resultPoints }, (_, index) => resultStartHz + (resultStopHz - resultStartHz) * index / (resultPoints - 1));
      reply(request, measurement({ kind: 'swept-spectrum', startHz: resultStartHz, stopHz: resultStopHz, points: resultPoints, frequencyHz, powerDbm: Array(resultPoints).fill(-70) }));
    } else if (request.method === 'acquire_detected_power') {
      sequence += 1;
      const { centerFrequencyHz, points, samplePeriodSeconds } = request.params;
      const resultCenterFrequencyHz = ${JSON.stringify(mode)} === 'wrong-detected-center' ? centerFrequencyHz + 1 : centerFrequencyHz;
      const resultPoints = ${JSON.stringify(mode)} === 'wrong-detected-points' ? points + 1 : points;
      const resultSamplePeriodSeconds = ${JSON.stringify(mode)} === 'wrong-detected-sample-period' ? samplePeriodSeconds * 2 : samplePeriodSeconds;
      reply(request, measurement({ kind: 'detected-power-timeseries', centerFrequencyHz: resultCenterFrequencyHz, points: resultPoints, samplePeriodSeconds: resultSamplePeriodSeconds, powerDbm: Array(resultPoints).fill(-65) }));
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
        kind: 'detected-power-timeseries', minimumFrequencyHz: 1, maximumFrequencyHz: 17_922_600_000,
        frequencyStepHz: 1, frequencyUnit: 'Hz', minimumPoints: 1, maximumPoints: 4_096,
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
  return SIGNAL_LAB_PROFILE_IDS.map((id) => ({
    id, label: id.toUpperCase(), family: id === 'cw' ? 'tone' : 'analog', model: `${id}-model`,
    qualification: 'visual', centerHz: 100_000_000, occupiedBandwidthHz: id === 'cw' ? 1 : 20_000,
    recommendedSpanHz: id === 'cw' ? 100_000 : 100_000,
    projection: {
      allocation: id === 'cw' ? 'carrier' : 'sidebands', modulation: id === 'cw' ? 'unmodulated' : 'fm',
      timing: 'continuous',
    },
    source: {
      organization: 'TinySA SignalLab',
      references: [{
        specification: 'fixture', clause: 'fixture', revision: '1',
        url: 'https://example.test/signal-lab',
      }],
    },
    disclosure: 'Synthetic fixture only.',
    ...(id === 'cw' ? { assetSha256: '4'.repeat(64) } : {}),
  }));
}
