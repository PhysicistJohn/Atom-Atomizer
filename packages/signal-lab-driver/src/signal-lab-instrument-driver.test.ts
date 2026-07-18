import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentConfiguration, InstrumentMeasurement } from '@tinysa/contracts';
import {
  SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE,
  SIGNAL_LAB_PROFILE_IDS,
  SignalLabBridgeClient,
} from './signal-lab-bridge-client.js';
import {
  SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID,
  SignalLabInstrumentDriver,
} from './signal-lab-instrument-driver.js';

const temporaryRoots: string[] = [];
const GENERATOR_ARTIFACTS = [
  'atomizer-bridge.js', 'bluetooth-iq.js', 'canonical-timing.js', 'catalog.js', 'complex-iq.js', 'contracts.js',
  'geran-iq.js', 'measurement-bridge.js', 'measurement-contract.js', 'measurement-service.js', 'ofdm-iq.js',
  'source-provenance.js', 'waveforms.js',
] as const;
const FIXTURE_DESCRIPTORS = SIGNAL_LAB_PROFILE_IDS.map((id) => ({
  id,
  label: id.toUpperCase(),
  family: id === 'cw' ? 'tone'
    : id === 'am' || id === 'fm' ? 'analog'
      : id.startsWith('gsm') || id.startsWith('edge') ? 'geran'
        : id.startsWith('lte') ? 'e-utra'
          : id.startsWith('nr') ? 'nr'
            : id.startsWith('wifi') ? 'wlan' : 'bluetooth',
  model: `${id}-model`,
  qualification: id === 'cw' || id === 'am' || id === 'fm' ? 'visual' : 'standards-derived',
  centerHz: 100_000_000,
  occupiedBandwidthHz: id === 'cw' ? 1 : 20_000,
  recommendedSpanHz: id === 'cw' ? 2_000_000 : 500_000,
  projection: {
    allocation: id === 'cw' ? 'carrier' : 'sidebands',
    modulation: id === 'cw' ? 'unmodulated' : 'fm',
    timing: 'continuous',
  },
  source: {
    organization: id === 'cw' || id === 'am' || id === 'fm' ? 'TinySA SignalLab'
      : id.startsWith('wifi') ? 'IEEE'
        : id.startsWith('bluetooth') ? 'Bluetooth SIG' : '3GPP',
    references: [{
      specification: 'fixture', clause: 'fixture', revision: '1',
      url: 'https://example.test/signal-lab',
    }],
  },
  disclosure: 'Synthetic fixture only.',
}));

type FixtureBehavior = 'normal' | 'dishonest-ready-hash' | 'mutate-artifact-during-startup' | 'mutate-source-provenance-during-startup' | 'stale-measurement-epoch' | 'shifted-spectrum-geometry' | 'unchanged-profile-epoch' | 'exit-after-status';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('SignalLab instrument driver', () => {
  it('discovers an explicitly supplied packaged resource instead of a sibling development checkout', async () => {
    const fixture = await createBridgeFixture();
    const signalLabRoot = resolve(fixture.atomizerRoot, '..', 'Atom-SignalLab');
    const packagedResourcesRoot = resolve(fixture.atomizerRoot, 'Atomizer.app', 'Contents', 'Resources');
    await mkdir(packagedResourcesRoot, { recursive: true });
    await cp(signalLabRoot, resolve(packagedResourcesRoot, 'signal-lab'), { recursive: true });
    await rm(signalLabRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    const driver = new SignalLabInstrumentDriver({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      packagedResourcesRoot,
      environment: {},
    });
    await expect(driver.discover()).resolves.toMatchObject({
      candidates: [{ candidateId: SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID, sourceKind: 'signal-lab' }],
      failures: [],
    });
  });

  it('composes scalar and bounded I/Q acquisition without claiming USB, firmware, RF, screen, touch, or diagnostics', async () => {
    const fixture = await createBridgeFixture();
    const driver = new SignalLabInstrumentDriver({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: fixture.executable },
      bridge: { readyTimeoutMs: 1_000, requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, diagnostics: () => undefined },
      now: () => new Date('2026-07-14T21:00:00.000Z'),
    });
    const discovery = await driver.discover();
    expect(discovery.failures).toEqual([]);
    const descriptors = discovery.candidates;
    expect(descriptors).toEqual([{
      schemaVersion: 1,
      driverId: 'signal-lab',
      candidateId: SIGNAL_LAB_INSTRUMENT_CANDIDATE_ID,
      displayName: 'SignalLab synthetic measurement source',
      sourceKind: 'signal-lab',
      signalLab: { sourceId: 'default' },
    }]);
    expect(deepKeys(descriptors)).not.toEqual(expect.arrayContaining([
      'path', 'usbMatch', 'vendorId', 'productId', 'serialNumber', 'firmwareVersion', 'firmwareRevision',
    ]));

    const session = await driver.connect({ ...descriptors[0]!, discoveryRevision: 'discovery:test' });
    expect(session.driverId).toBe('signal-lab');
    expect(session.provenance).toMatchObject({
      sourceKind: 'signal-lab',
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 1,
      contractSha256: fixture.contractSha256,
      catalogSha256: fixture.catalogSha256,
      generatorSha256: fixture.generatorSha256,
      verifiedAt: '2026-07-14T21:00:00.000Z',
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000001',
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    });
    expect(session.capabilities.acquisitions.map((capability) => capability.kind)).toEqual([
      'swept-spectrum', 'detected-power-timeseries', 'complex-iq',
    ]);
    expect(session.capabilities.features).toHaveLength(1);
    expect(session.capabilities.features[0]).toMatchObject({
      kind: 'signal-lab-profile-selection', selectedProfileId: 'cw',
      channel: { model: 'awgn', noiseFloorDbm: -110, seed: 1, fadingRateHz: 1 },
      iqProfileIds: [...SIGNAL_LAB_PROFILE_IDS],
    });
    if (session.capabilities.features[0]?.kind !== 'signal-lab-profile-selection') {
      throw new Error('fixture did not expose SignalLab profile selection');
    }
    expect(session.capabilities.features[0].profiles).toHaveLength(SIGNAL_LAB_PROFILE_IDS.length);
    expect(session.capabilities.features[0].profiles.slice(0, 3)).toMatchObject([
      { profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 },
      { profileId: 'am', centerFrequencyHz: 100_000_000, recommendedSpanHz: 500_000 },
      { profileId: 'fm', centerFrequencyHz: 100_000_000, recommendedSpanHz: 500_000 },
    ]);
    expect(session.capabilities.features[0].profiles[0]).toMatchObject({
      label: 'CW', family: 'tone', model: 'cw-model', qualification: 'visual',
      occupiedBandwidthHz: 1,
      projection: { allocation: 'carrier', modulation: 'unmodulated', timing: 'continuous' },
      source: { organization: 'TinySA SignalLab' }, disclosure: 'Synthetic fixture only.',
    });
    expect(session.capabilities.features[0].profiles.find(({ profileId }) => profileId === 'lte-etm1.1')).toMatchObject({
      family: 'e-utra', qualification: 'standards-derived', source: { organization: '3GPP' },
    });
    expect(session.capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq')).toEqual({
      kind: 'complex-iq',
      centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
      sampleRateHz: { min: 1_000_000, max: 245_760_000 },
      bandwidthHz: { min: 1_000, max: 245_760_000 },
      bandwidthMode: 'independent',
      sampleCount: { min: 1, max: 65_536, step: 1 },
      sampleFormat: 'cf32le',
    });
    expect(session.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries')).toMatchObject({
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
    });
    expect(session.capabilities.features.some((feature) => feature.kind === 'rf-generator')).toBe(false);
    expect(session.capabilities.features.some((feature) => feature.kind === 'screen')).toBe(false);
    expect(session.capabilities.features.some((feature) => feature.kind === 'touch')).toBe(false);
    expect(session.capabilities.features.some((feature) => feature.kind === 'diagnostics')).toBe(false);
    await session.disconnect();
  });

  it('maps spectrum, profile selection, and detected power into the generic session contract', async () => {
    const fixture = await createBridgeFixture();
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    const events: unknown[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    });
    const spectrum = await session.acquire();
    expect(spectrum).toMatchObject({
      schemaVersion: 1, kind: 'swept-spectrum', sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum', elapsedMilliseconds: 1,
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000001',
      resolutionBandwidthHz: null, attenuationDb: null,
      qualification: 'synthetic-visual-projection', complete: true,
    });
    if (spectrum.kind !== 'swept-spectrum') throw new Error('Expected swept spectrum');
    expect(spectrum.frequencyHz).toEqual([99_000_000, 99_500_000, 100_000_000, 100_500_000, 101_000_000]);
    expect(deepKeys(spectrum)).not.toEqual(expect.arrayContaining([
      'profile', 'profileId', 'selectedProfileId',
    ]));

    await expect(session.executeFeature({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm',
    })).resolves.toEqual({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm',
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000002',
    });
    expect(session.provenance).toMatchObject({
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000002',
    });
    expect(session.capabilities.features).toContainEqual(expect.objectContaining({
      kind: 'signal-lab-profile-selection',
      selectedProfileId: 'fm',
      channel: { model: 'awgn', noiseFloorDbm: -110, seed: 1, fadingRateHz: 1 },
    }));
    await expect(session.acquire()).rejects.toThrow(/not configured/);

    const channel = { model: 'rayleigh' as const, noiseFloorDbm: -104, seed: 42, fadingRateHz: 3.5 };
    await expect(session.executeFeature({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'configure-channel', channel,
    })).resolves.toEqual({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'configure-channel', channel,
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000003',
    });
    expect(session.provenance).toMatchObject({
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000003',
    });
    expect(session.capabilities.features).toContainEqual(expect.objectContaining({
      kind: 'signal-lab-profile-selection', selectedProfileId: 'fm', channel,
    }));

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:detected',
      configuration: syntheticDetectedPower(100_000_000, 4),
    });
    const detected = await session.acquire();
    expect(detected).toMatchObject({
      schemaVersion: 1, kind: 'detected-power-timeseries', sessionId: session.sessionId,
      configurationRevision: 'configuration:detected', centerHz: 100_000_000,
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000003',
      sampleIntervalSeconds: 0.0125, elapsedMilliseconds: 1,
      resolutionBandwidthHz: null, attenuationDb: null,
      qualification: 'synthetic-visual-projection', complete: true,
    });
    if (detected.kind !== 'detected-power-timeseries') throw new Error('Expected detected power');
    expect(detected.powerDbm).toEqual([-65, -65, -65, -65]);
    expect(deepKeys(detected)).not.toEqual(expect.arrayContaining([
      'profile', 'profileId', 'selectedProfileId',
    ]));
    expect(events).toEqual([
      { type: 'status', sessionId: session.sessionId, status: 'busy' },
      { type: 'status', sessionId: session.sessionId, status: 'ready' },
      { type: 'status', sessionId: session.sessionId, status: 'busy' },
      { type: 'status', sessionId: session.sessionId, status: 'ready' },
    ]);
    unsubscribe();
    await session.disconnect();
  });

  it('renews bounded child processes across the prior request boundary without changing session state or sequence', async () => {
    const fixture = await createBridgeFixture();
    const terminalObservers: Array<(error: Error) => void> = [];
    const driver = new SignalLabInstrumentDriver({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: fixture.executable },
      bridge: {
        readyTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
        renewalThresholdRequests: 5,
        diagnostics: () => undefined,
      },
      launchBridgeClient: async (location, options, retainPendingConnection) => {
        const admittedOptions = options ?? {};
        if (admittedOptions.onTerminalFailure) terminalObservers.push(admittedOptions.onTerminalFailure);
        return SignalLabBridgeClient.launch(location, admittedOptions, retainPendingConnection);
      },
      now: () => new Date('2026-07-14T21:00:00.000Z'),
    });
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    const originalSessionId = session.sessionId;
    const originalIdentity = structuredClone(session.provenance);

    await session.executeFeature({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm',
    });
    const provenance = session.provenance;
    if (provenance.sourceKind !== 'signal-lab') throw new Error('Expected SignalLab provenance');
    const producerEpoch = provenance.producerConfigurationEpoch;
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:renewal-stress',
      configuration: syntheticSpectrum(99_750_000, 100_250_000, 3),
    });

    const measurements: InstrumentMeasurement[] = [];
    for (let index = 0; index < 14; index += 1) measurements.push(await session.acquire());

    expect(measurements.map((measurement) => measurement.sequence))
      .toEqual(Array.from({ length: 14 }, (_unused, index) => index + 1));
    expect(new Set(measurements.map((measurement) => measurement.sessionId))).toEqual(new Set([originalSessionId]));
    expect(new Set(measurements.map((measurement) => measurement.producerConfigurationEpoch)))
      .toEqual(new Set([producerEpoch]));
    expect(session.provenance).toMatchObject({ producerConfigurationEpoch: producerEpoch });
    expect(session.provenance).toEqual({ ...originalIdentity, producerConfigurationEpoch: producerEpoch });
    expect(terminalObservers.length).toBeGreaterThan(1);

    // The callback belonging to the joined, retired child is generation
    // fenced and cannot fault its admitted replacement.
    terminalObservers[0]!(new Error('late retired-child terminal observer'));
    await expect(session.acquire()).resolves.toMatchObject({ sequence: 15, sessionId: originalSessionId });
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  it('honors detected-power and exact profile-dependent I/Q qualification while rejecting RF operations', async () => {
    const fixture = await createBridgeFixture();
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:tuned-center',
      configuration: syntheticDetectedPower(101_000_000, 4),
    })).resolves.toBeUndefined();
    await expect(session.acquire()).resolves.toMatchObject({
      kind: 'detected-power-timeseries', centerHz: 101_000_000,
    });
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:iq',
      configuration: {
        kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 2_000_000,
        bandwidthHz: 100_000, sampleCount: 4, sampleFormat: 'cf32le',
      },
    })).resolves.toBeUndefined();
    const iq = await session.acquire();
    expect(iq).toMatchObject({
      kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 2_000_000,
      bandwidthHz: 100_000, sampleCount: 4, sampleFormat: 'cf32le',
      qualification: 'analytic-complex-baseband', resolutionBandwidthHz: null, attenuationDb: null,
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000001', complete: true,
    });
    if (iq.kind !== 'complex-iq') throw new Error('Expected complex-I/Q measurement');
    expect(iq.samples).toEqual(new Uint8Array(32));
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:iq-unequal-bandwidth',
      configuration: {
        kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 2_000_000,
        bandwidthHz: 3_000_000, sampleCount: 4, sampleFormat: 'cf32le',
      },
    })).rejects.toThrow(/bandwidth cannot exceed its sample rate/);
    await session.executeFeature({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'lte-etm1.1',
    });
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:iq-standards-derived',
      configuration: {
        kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 2_000_000,
        bandwidthHz: 2_000_000, sampleCount: 4, sampleFormat: 'cf32le',
      },
    })).resolves.toBeUndefined();
    const standardsIq = await session.acquire();
    expect(standardsIq).toMatchObject({
      kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 2_000_000,
      bandwidthHz: 2_000_000, sampleCount: 4, sampleFormat: 'cf32le',
      qualification: 'standards-derived-complex-baseband',
      producerConfigurationEpoch: '20000000-0000-4000-8000-000000000002', complete: true,
    });
    if (standardsIq.kind !== 'complex-iq') throw new Error('Expected standards-derived complex-I/Q measurement');
    expect(standardsIq.samples).toEqual(new Uint8Array(32));
    await expect(session.executeFeature({
      sessionId: session.sessionId, kind: 'rf-generator', action: 'set-output', enabled: false,
    })).resolves.toEqual({
      sessionId: session.sessionId, kind: 'rf-generator', action: 'set-output', enabled: false,
    });
    await expect(session.executeFeature({
      sessionId: session.sessionId, kind: 'rf-generator', action: 'set-output', enabled: true,
    })).rejects.toThrow(/does not support rf-generator\/set-output/);
    await session.disconnect();
  });

  it('rejects a bridge that reports hashes inconsistent with independently loaded artifacts', async () => {
    const fixture = await createBridgeFixture('dishonest-ready-hash');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/contract hash does not match independently loaded bytes/);
  });

  it('rejects artifacts changed after discovery before launching the bridge', async () => {
    const fixture = await createBridgeFixture();
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    await writeFile(resolve(fixture.bridgeRoot, 'waveforms.js'), "'use strict';\n// changed after discovery\n", { mode: 0o600 });
    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/artifacts changed after discovery/);
  });

  it('rejects artifacts changed by the bridge while it is starting', async () => {
    const fixture = await createBridgeFixture('mutate-artifact-during-startup');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/artifacts changed while the bridge was starting/);
  });

  it('rejects source-provenance runtime bytes changed while the bridge is starting', async () => {
    const fixture = await createBridgeFixture('mutate-source-provenance-during-startup');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/artifacts changed while the bridge was starting/);
  });

  it('retains and retries child-process cleanup when composition fails before session admission', async () => {
    const fixture = await createBridgeFixture('mutate-artifact-during-startup');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const cleanup = vi.spyOn(SignalLabBridgeClient.prototype, 'cleanupPendingConnection')
      .mockRejectedValueOnce(new Error('forced child reap uncertainty'));

    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/child-process teardown could not be confirmed/);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/must be cleaned before reconnecting/);

    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('retains a boot-process lease when launch cleanup times out and retries it through the driver lifecycle', async () => {
    const fixture = await createBridgeFixture();
    let cleanupConfirmed = false;
    let cleanupCalls = 0;
    const bootLease = {
      get cleanupConfirmed() { return cleanupConfirmed; },
      async cleanupPendingConnection() {
        cleanupCalls++;
        cleanupConfirmed = true;
      },
    };
    const driver = new SignalLabInstrumentDriver({
      atomizerRepositoryRoot: fixture.atomizerRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: fixture.executable },
      launchBridgeClient: async (_location, _options, retainPendingConnection) => {
        retainPendingConnection?.(bootLease);
        throw new AggregateError(
          [new Error('ready handshake timed out'), new Error('first process reap timed out')],
          'SignalLab bridge startup and process termination both failed',
        );
      },
    });
    const descriptor = (await driver.discover()).candidates[0]!;

    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/startup and process termination both failed/);
    expect(cleanupCalls).toBe(0);
    await expect(driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' }))
      .rejects.toThrow(/must be cleaned before reconnecting/);

    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(cleanupCalls).toBe(1);
    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(cleanupCalls).toBe(1);
  });

  it('faults closed when a measurement carries a stale producer epoch', async () => {
    const fixture = await createBridgeFixture('stale-measurement-epoch');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    });
    await expect(session.acquire()).rejects.toThrow(/producer configuration epoch is stale or mismatched/);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', status: 'faulted' }),
      expect.objectContaining({ type: 'error', error: expect.objectContaining({ recoverable: false }) }),
    ]));
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:again',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    })).rejects.toThrow(/producer configuration epoch is stale or mismatched/);
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  it('faults the instrument session when a malicious bridge shifts admitted measurement geometry', async () => {
    const fixture = await createBridgeFixture('shifted-spectrum-geometry');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum-geometry',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    });

    await expect(session.acquire()).rejects.toThrow(/spectrum result geometry does not match the admitted request/);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', status: 'faulted' }),
      expect.objectContaining({ type: 'error', error: expect.objectContaining({ recoverable: false }) }),
    ]));
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:after-geometry-fault',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    })).rejects.toThrow(/spectrum result geometry does not match the admitted request/);
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  // The 'exit-after-status' fixture ends only its own stdout and stays alive
  // (matching signal-lab-bridge-client.test.ts's 'close-stdout-after-ready'),
  // which Windows' named-pipe child stdio does not reliably propagate to the
  // parent as a stream 'end' event -- the fault this test replays may never
  // be detected at all on that platform, not just later than expected.
  it.skipIf(process.platform === 'win32')('replays a bridge failure that occurs after status but before the first session subscriber', async () => {
    const fixture = await createBridgeFixture('exit-after-status');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    const events: unknown[] = [];

    session.subscribe((event) => events.push(event));

    expect(events).toEqual([
      expect.objectContaining({ type: 'status', status: 'faulted' }),
      expect.objectContaining({ type: 'error', error: expect.objectContaining({ recoverable: false }) }),
    ]);
    await expect(session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:after-terminal-handoff',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    })).rejects.toThrow(/closed stdout unexpectedly|exited unexpectedly/);
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  it('invalidates prior configuration and faults when profile mutation does not advance the epoch', async () => {
    const fixture = await createBridgeFixture('unchanged-profile-epoch');
    const driver = fixture.driver();
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect({ ...descriptor, discoveryRevision: 'discovery:test' });
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum',
      configuration: syntheticSpectrum(99_000_000, 101_000_000, 5),
    });
    await expect(session.executeFeature({
      sessionId: session.sessionId,
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm',
    })).rejects.toThrow(/did not advance the producer configuration epoch/);
    await expect(session.acquire()).rejects.toThrow(/did not advance the producer configuration epoch/);
    await expect(session.disconnect()).resolves.toBeUndefined();
  });
});

function syntheticSpectrum(
  startHz: number,
  stopHz: number,
  points: number,
): Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }> {
  return {
    kind: 'swept-spectrum', startHz, stopHz, points, sweepTimeSeconds: 0.05,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

function syntheticDetectedPower(
  centerHz: number,
  sampleCount: number,
): Extract<InstrumentConfiguration, { kind: 'detected-power-timeseries' }> {
  return {
    kind: 'detected-power-timeseries', centerHz, sampleCount, sweepTimeSeconds: 0.05,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

async function createBridgeFixture(behavior: FixtureBehavior = 'normal'): Promise<{
  atomizerRoot: string;
  bridgeRoot: string;
  executable: string;
  contractSha256: string;
  catalogSha256: string;
  generatorSha256: string;
  driver(): SignalLabInstrumentDriver;
}> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'atomizer-signal-lab-driver-')));
  temporaryRoots.push(root);
  const atomizerRoot = resolve(root, 'Atom-Atomizer');
  const signalLabRoot = resolve(root, 'Atom-SignalLab');
  const bridgeRoot = resolve(signalLabRoot, 'dist', 'bridge');
  const executable = resolve(bridgeRoot, 'atomizer-bridge.js');
  const contractPath = resolve(signalLabRoot, 'contracts', 'signal-lab-measurement-bridge-v1.json');
  await mkdir(bridgeRoot, { recursive: true });
  await mkdir(resolve(contractPath, '..'), { recursive: true });
  await mkdir(atomizerRoot, { recursive: true });
  await writeFile(contractPath, `${JSON.stringify(fixtureContractDocument(), null, 2)}\n`, { mode: 0o600 });
  await writeFile(executable, bridgeProgram(behavior), { mode: 0o700 });
  await chmod(executable, 0o700);
  for (const name of GENERATOR_ARTIFACTS) {
    if (name === 'atomizer-bridge.js') continue;
    await writeFile(resolve(bridgeRoot, name), `'use strict';\n// ${name} fixture artifact\n`, { mode: 0o600 });
  }
  const contractSha256 = sha256(await readFile(contractPath));
  const catalogSha256 = sha256(Buffer.from(JSON.stringify(FIXTURE_DESCRIPTORS), 'utf8'));
  const generatorSha256 = await aggregateGeneratorHash(bridgeRoot);
  return {
    atomizerRoot,
    bridgeRoot,
    executable,
    contractSha256,
    catalogSha256,
    generatorSha256,
    driver: () => new SignalLabInstrumentDriver({
      atomizerRepositoryRoot: atomizerRoot,
      environment: { [SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]: executable },
      bridge: { readyTimeoutMs: 1_000, requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, diagnostics: () => undefined },
      now: () => new Date('2026-07-14T21:00:00.000Z'),
    }),
  };
}

function bridgeProgram(behavior: FixtureBehavior): string {
  return `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const descriptors = ${JSON.stringify(FIXTURE_DESCRIPTORS)};
const generatorArtifacts = ${JSON.stringify(GENERATOR_ARTIFACTS)};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const generator = crypto.createHash('sha256');
for (const name of generatorArtifacts) {
  const bytes = fs.readFileSync(path.resolve(__dirname, name));
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.byteLength));
  generator.update(name, 'utf8').update(Buffer.of(0)).update(size).update(bytes);
}
const computedContractSha256 = sha256(fs.readFileSync(path.resolve(__dirname, '..', '..', 'contracts', 'signal-lab-measurement-bridge-v1.json')));
const identity = {
  driverId: 'signal-lab', sourceKind: 'signal-lab-simulation', execution: 'signal-lab-simulation',
  transport: 'signal-lab-measurement-bridge', contractId: 'tinysa-signal-lab-atomizer-measurement',
  contractVersion: 1,
  contractSha256: ${JSON.stringify(behavior)} === 'dishonest-ready-hash' ? '${'f'.repeat(64)}' : computedContractSha256,
  catalogSha256: sha256(Buffer.from(JSON.stringify(descriptors), 'utf8')),
  generatorSha256: generator.digest('hex'),
  claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
};
const capabilities = [
  { kind: 'swept-spectrum', minimumFrequencyHz: 1, maximumFrequencyHz: 17922600000, minimumPoints: 2, maximumPoints: 4096, frequencyUnit: 'Hz', powerUnit: 'dBm', qualification: 'synthetic-visual-projection' },
  { kind: 'detected-power-timeseries', minimumFrequencyHz: 1, maximumFrequencyHz: 17922600000, frequencyStepHz: 1, frequencyUnit: 'Hz', minimumPoints: 1, maximumPoints: 4096, minimumSamplePeriodSeconds: 0.000001, maximumSamplePeriodSeconds: 10, powerUnit: 'dBm', qualification: 'synthetic-visual-projection' },
  { kind: 'complex-iq', minimumCenterFrequencyHz: 1, maximumCenterFrequencyHz: 17922600000, frequencyStepHz: 1, frequencyUnit: 'Hz', minimumSampleRateHz: 1000000, maximumSampleRateHz: 245760000, minimumBandwidthHz: 1000, maximumBandwidthHz: 245760000, bandwidthMode: 'independent', minimumSamples: 1, maximumSamples: 65536, sampleFormat: 'cf32le', encoding: 'base64', layout: 'interleaved-iq', byteOrder: 'little-endian', timingQualification: 'simulation-exact', qualification: 'profile-dependent-complex-baseband', profiles: ${JSON.stringify(SIGNAL_LAB_PROFILE_IDS)} },
];
const continuationSource = process.env.ATOMIZER_SIGNAL_LAB_CONTINUATION_V1;
const continuation = continuationSource
  ? JSON.parse(Buffer.from(continuationSource, 'base64url').toString('utf8'))
  : undefined;
const sessionId = continuation?.sessionId ?? '10000000-0000-4000-8000-000000000001';
process.stdout.write(JSON.stringify({
  type: 'ready', protocol: 'signal-lab-measurement-bridge', contractId: 'tinysa-signal-lab-atomizer-measurement',
  contractVersion: 1, service: 'tinysa-signal-lab', sessionId, identity, capabilities,
  limits: { maxRequestLineBytes: 65536, maxResponseLineBytes: 1048576, maxQueuedRequests: 32, maxSessionRequests: 10000, reservedShutdownRequests: 1, requestTimeoutMs: 5000 },
}) + '\\n');
let profile = continuation?.profile ?? 'cw';
let revision = continuation?.configurationRevision ?? '20000000-0000-4000-8000-000000000001';
let updatedAt = continuation?.updatedAt ?? '2026-07-14T20:00:00.000Z';
let channel = continuation?.channel ?? { model: 'awgn', noiseFloorDbm: -110, seed: 1, fadingRateHz: 1 };
let sequence = continuation?.sequence ?? 0;
const status = () => ({
  kind: 'status', sessionId, configurationRevision: revision, updatedAt,
  available: true, active: true, profile, profiles: descriptors.map((item) => item.id),
  waveform: descriptors.find((item) => item.id === profile), catalog: descriptors,
  channel, capabilities, identity,
});
const reply = (request, result) => process.stdout.write(JSON.stringify({ type: 'response', contractVersion: 1, requestId: request.requestId, ok: true, result }) + '\\n');
const base = () => ({
  measurementId: '30000000-0000-4000-8000-' + String(sequence).padStart(12, '0'), sessionId,
  configurationRevision: revision, sequence, capturedAt: '2026-07-14T20:00:01.000Z', elapsedSeconds: 0.001,
  complete: true, qualification: 'synthetic-visual-projection', provenance: identity,
});
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'status') {
    if (${JSON.stringify(behavior)} === 'mutate-artifact-during-startup') {
      fs.appendFileSync(path.resolve(__dirname, 'waveforms.js'), '// startup mutation\\n');
    }
    if (${JSON.stringify(behavior)} === 'mutate-source-provenance-during-startup') {
      fs.appendFileSync(path.resolve(__dirname, 'source-provenance.js'), '// startup mutation\\n');
    }
    reply(request, status());
    if (${JSON.stringify(behavior)} === 'exit-after-status') process.stdout.end();
  }
  else if (request.method === 'select_profile') {
    profile = request.params.profile;
    if (${JSON.stringify(behavior)} !== 'unchanged-profile-epoch') {
      revision = '20000000-0000-4000-8000-000000000002';
      updatedAt = '2026-07-14T20:00:00.001Z';
    }
    reply(request, status());
  }
  else if (request.method === 'configure_channel') {
    channel = request.params.channel;
    revision = '20000000-0000-4000-8000-000000000003';
    updatedAt = '2026-07-14T20:00:00.002Z';
    reply(request, status());
  }
  else if (request.method === 'acquire_spectrum') {
    sequence += 1;
    const { startHz, stopHz, points } = request.params;
    const resultStartHz = ${JSON.stringify(behavior)} === 'shifted-spectrum-geometry' ? startHz + 1000 : startHz;
    const resultStopHz = ${JSON.stringify(behavior)} === 'shifted-spectrum-geometry' ? stopHz + 1000 : stopHz;
    const measurement = { ...base(), kind: 'swept-spectrum', startHz: resultStartHz, stopHz: resultStopHz, points,
      frequencyHz: Array.from({ length: points }, (_, index) => resultStartHz + (resultStopHz - resultStartHz) * index / (points - 1)), powerDbm: Array(points).fill(-70) };
    if (${JSON.stringify(behavior)} === 'stale-measurement-epoch') measurement.configurationRevision = '20000000-0000-4000-8000-000000000099';
    reply(request, measurement);
  } else if (request.method === 'acquire_detected_power') {
    sequence += 1;
    const { centerFrequencyHz, points, samplePeriodSeconds } = request.params;
    reply(request, { ...base(), kind: 'detected-power-timeseries', centerFrequencyHz, points, samplePeriodSeconds, powerDbm: Array(points).fill(-65) });
  } else if (request.method === 'acquire_iq') {
    sequence += 1;
    const { centerHz, sampleRateHz, bandwidthHz, sampleCount, sampleFormat } = request.params;
    const samples = Buffer.alloc(sampleCount * 8);
    reply(request, {
      ...base(), kind: 'complex-iq', centerHz, sampleRateHz, bandwidthHz, sampleFormat, sampleCount,
      byteLength: samples.byteLength, encoding: 'base64', layout: 'interleaved-iq', byteOrder: 'little-endian',
      samplesBase64: samples.toString('base64'), samplesSha256: sha256(samples),
      timingQualification: 'simulation-exact', qualification: ['cw', 'am', 'fm'].includes(profile)
        ? 'analytic-complex-baseband' : 'standards-derived-complex-baseband',
      representation: 'normalized-complex-envelope', normalization: 'unit-peak', channelApplication: 'not-applied',
    });
  } else if (request.method === 'shutdown') { reply(request, { kind: 'shutdown', closed: true }); setTimeout(() => process.exit(0), 5); }
});
`;
}

function fixtureContractDocument(): Record<string, unknown> {
  return {
    documentType: 'contract-manifest',
    contractId: 'tinysa-signal-lab-atomizer-measurement',
    contractVersion: 1,
    status: 'active',
    identityHashes: {
      contractSha256: 'sha256-of-the-exact-loaded-contract-json-bytes',
      catalogSha256: 'sha256-of-the-runtime-canonical-catalog-json',
      generatorSha256: 'sha256-length-framed-aggregate-of-every-shipped-runtime-javascript-artifact',
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function aggregateGeneratorHash(bridgeRoot: string): Promise<string> {
  const generator = createHash('sha256');
  for (const name of GENERATOR_ARTIFACTS) {
    const bytes = await readFile(resolve(bridgeRoot, name));
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.byteLength));
    generator.update(name, 'utf8').update(Buffer.of(0)).update(size).update(bytes);
  }
  return generator.digest('hex');
}

function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...deepKeys(nested)]);
}
