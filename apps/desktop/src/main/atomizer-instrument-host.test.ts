import { describe, expect, it, vi } from 'vitest';
import type {
  InstrumentCandidate,
  InstrumentConfiguration,
  InstrumentConfigurationState,
  InstrumentDiscoveryResult,
  InstrumentFeatureRequest,
  InstrumentFeatureResult,
  InstrumentManagerEvent,
  InstrumentMeasurement,
  InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import { MAX_SWEPT_SPECTRUM_POINTS_V1 } from '@tinysa/contracts';
import { AtomizerInstrumentHost } from './atomizer-instrument-host.js';
import type { InstrumentPreference, LoadedInstrumentPreference } from './instrument-preference.js';

const NOW = '2026-07-14T20:00:00.000Z';
const signalLabCandidate: InstrumentCandidate = {
  schemaVersion: 1,
  driverId: 'signal-lab',
  candidateId: 'signal-lab:default',
  displayName: 'SignalLab synthetic measurement source',
  sourceKind: 'signal-lab',
  signalLab: { sourceId: 'default' },
  discoveryRevision: 'discovery:1',
};
const physicalTinySaCandidate = {
  schemaVersion: 1,
  driverId: 'tinysa-zs407',
  candidateId: 'serial:/dev/tty.fixture',
  displayName: 'tinySA Ultra+ ZS407 fixture',
  sourceKind: 'serial-port',
  serialPort: { path: '/dev/tty.fixture', vendorId: '0483', productId: '5740' },
  discoveryRevision: 'discovery:1',
} satisfies InstrumentCandidate;

describe('AtomizerInstrumentHost startup', () => {
  it('isolates each host event consumer and snapshots listener membership per dispatch', async () => {
    const manager = new FakeManager();
    const host = createHost(manager, new FakePreferences());
    let downstreamCandidateId: string | undefined;
    let lateCalls = 0;
    host.subscribe((event) => {
      if (event.type !== 'preference') return;
      (event.preference.preference as { candidateId: string }).candidateId = 'mutated-by-observer';
      host.subscribe(() => { lateCalls += 1; });
      throw new Error('renderer observer failed');
    });
    host.subscribe((event) => {
      if (event.type === 'preference') downstreamCandidateId = event.preference.preference.candidateId;
    });

    await host.readPreference();

    expect(downstreamCandidateId).toBe(signalLabCandidate.candidateId);
    expect(host.state().preference?.preference.candidateId).toBe(signalLabCandidate.candidateId);
    expect(lateCalls).toBe(0);
  });

  it('loads the explicit SignalLab default and admits it through InstrumentManager exactly once', async () => {
    const manager = new FakeManager();
    const preferences = new FakePreferences();
    const host = createHost(manager, preferences);
    const events: InstrumentManagerEvent[] = [];
    host.subscribe((event) => {
      if (['discovery', 'connected'].includes(event.type)) events.push(event as InstrumentManagerEvent);
    });

    const state = await host.startPreferredInstrument();

    expect(state.startup).toEqual({ status: 'connected', connectedAt: NOW });
    expect(state.preference).toMatchObject({ source: 'factory-default', preference: { driverId: 'signal-lab' } });
    expect(state.session?.candidate.sourceKind).toBe('signal-lab');
    expect(state.session?.provenance).toMatchObject({
      sourceKind: 'signal-lab', claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    });
    expect(manager.discoverCalls).toBe(1);
    expect(manager.connectCalls).toEqual([signalLabCandidate]);
    expect(events.map((event) => event.type)).toEqual(['discovery', 'connected']);
  });

  it('retains and publishes preference-load failure without discovery or fallback', async () => {
    const manager = new FakeManager();
    const preferences = new FakePreferences();
    preferences.loadError = new Error('preference file is corrupt');
    const host = createHost(manager, preferences);
    const events: unknown[] = [];
    host.subscribe((event) => events.push(event));

    const state = await host.startPreferredInstrument();

    expect(state.startup).toMatchObject({
      status: 'failed', stage: 'preference-load', message: 'preference file is corrupt',
    });
    expect(manager.discoverCalls).toBe(0);
    expect(manager.connectCalls).toHaveLength(0);
    expect(events).toContainEqual({ type: 'startup', startup: state.startup });
    await expect(host.startPreferredInstrument()).resolves.toEqual(state);
  });

  it('refuses to persist an unknown driver or a source kind the registered driver does not own', async () => {
    const manager = new FakeManager();
    const preferences = new FakePreferences();
    const host = createHost(manager, preferences);

    await expect(host.writePreference({
      driverId: 'unregistered-driver', candidateKind: 'signal-lab', candidateId: 'candidate:unknown',
    })).rejects.toThrow(/not statically registered/);
    await expect(host.writePreference({
      driverId: 'signal-lab', candidateKind: 'serial-port', candidateId: 'serial:/dev/tty.fixture',
    }))
      .rejects.toThrow(/does not own source kind/);
    expect(preferences.saved).toHaveLength(0);
  });

  it('persists only an exact candidate tuple from a fresh main-owned discovery', async () => {
    const manager = new FakeManager();
    const preferences = new FakePreferences();
    const host = createHost(manager, preferences);

    await expect(host.writePreference({
      driverId: 'signal-lab', candidateKind: 'signal-lab', candidateId: 'ghost:never-discovered',
    })).rejects.toThrow(/unavailable/);
    await expect(host.writePreference({
      driverId: 'signal-lab', candidateKind: 'signal-lab', candidateId: physicalTinySaCandidate.candidateId,
    })).rejects.toThrow(/unavailable/);

    expect(manager.discoverCalls).toBe(2);
    expect(preferences.saved).toHaveLength(0);
  });

  it('changes the startup default only after the session and retained cleanup are safely disconnected', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture();
    const preferences = new FakePreferences();
    const host = createHost(manager, preferences);

    expect(() => host.writePreference({
      driverId: 'tinysa-zs407', candidateKind: 'serial-port', candidateId: physicalTinySaCandidate.candidateId,
    }))
      .toThrow(/disconnect the active instrument/i);
    expect(preferences.saved).toHaveLength(0);

    await host.disconnect();
    await expect(host.writePreference({
      driverId: 'tinysa-zs407', candidateKind: 'serial-port', candidateId: physicalTinySaCandidate.candidateId,
    })).resolves.toMatchObject({
      preference: {
        driverId: 'tinysa-zs407', candidateKind: 'serial-port', candidateId: physicalTinySaCandidate.candidateId,
      },
    });
    expect(preferences.saved).toEqual([{
      driverId: 'tinysa-zs407', candidateKind: 'serial-port', candidateId: physicalTinySaCandidate.candidateId,
    }]);

    manager.cleanupRequirement = { driverId: 'signal-lab', phase: 'driver-pending' };
    expect(() => host.writePreference({
      driverId: 'signal-lab', candidateKind: 'signal-lab', candidateId: signalLabCandidate.candidateId,
    }))
      .toThrow(/complete connection cleanup/i);
    expect(preferences.saved).toHaveLength(1);
  });

  it('propagates retained failed-connect cleanup and clears it after an explicit human retry', async () => {
    const manager = new FakeManager();
    manager.connectError = new Error('bridge boot and first child cleanup failed');
    manager.cleanupRequirement = { driverId: 'signal-lab', phase: 'driver-pending' };
    const host = createHost(manager, new FakePreferences());
    const cleanupEvents: unknown[] = [];
    host.subscribe((event) => { if (event.type === 'connection-cleanup') cleanupEvents.push(event); });

    await expect(host.connect(signalLabCandidate)).rejects.toThrow(/first child cleanup failed/);
    expect(host.state().connectionCleanup).toEqual({
      status: 'required', driverId: 'signal-lab', phase: 'driver-pending',
    });

    manager.connectError = undefined;
    await expect(host.disconnect()).resolves.toBeUndefined();
    expect(host.state().connectionCleanup).toEqual({ status: 'not-required' });
    expect(cleanupEvents).toEqual([
      { type: 'connection-cleanup', connectionCleanup: { status: 'required', driverId: 'signal-lab', phase: 'driver-pending' } },
      { type: 'connection-cleanup', connectionCleanup: { status: 'not-required' } },
    ]);
  });

  it('does not present an unannounced rejected session as connected while exposing its teardown retry', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture();
    manager.connectError = new Error('session admission failed and teardown was retained');
    manager.cleanupRequirement = { driverId: 'signal-lab', phase: 'rejected-session' };
    const host = createHost(manager, new FakePreferences());

    await expect(host.connect(signalLabCandidate)).rejects.toThrow(/teardown was retained/);
    expect(host.state()).toMatchObject({
      connectionCleanup: { status: 'required', driverId: 'signal-lab', phase: 'rejected-session' },
    });
    expect(host.state().session).toBeUndefined();

    await expect(host.disconnect()).resolves.toBeUndefined();
    expect(host.state().connectionCleanup).toEqual({ status: 'not-required' });
  });
});

describe('AtomizerInstrumentHost acquisition ownership', () => {
  it('serializes continuous acquisition and publishes one event when manager event and return represent the same measurement', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.echoMeasurementEvent = true;
    const host = createHost(manager, new FakePreferences());
    const measurements: InstrumentMeasurement[] = [];
    host.subscribe((event) => { if (event.type === 'measurement') measurements.push(event.measurement); });

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);
    await host.stopStreaming();

    expect(manager.maximumConcurrentAcquisitions).toBe(1);
    expect(measurements).toHaveLength(1);
    expect(measurements[0]?.measurementId).toBe('measurement:1');
    expect(host.state().streaming).toEqual({ status: 'stopped' });

    await host.acquire();
    expect(measurements.map((measurement) => measurement.measurementId)).toEqual(['measurement:1', 'measurement:2']);
    expect(manager.acquireCalls).toBe(2);
  });

  it('interrupts a pending cadence slot immediately on Stop and leaks no additional acquisition work', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    const cadence = deferred<void>();
    let cadenceCalls = 0;
    const host = new AtomizerInstrumentHost(manager, new FakePreferences(), {
      now: () => new Date(NOW),
      yieldToEventLoop: () => { cadenceCalls++; return cadence.promise; },
    });

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1 && cadenceCalls === 1);
    await host.stopStreaming();

    expect(host.state().streaming).toEqual({ status: 'stopped' });
    expect(manager.acquireCalls).toBe(1);
    expect(manager.concurrentAcquisitions).toBe(0);
    cadence.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.acquireCalls).toBe(1);
  });

  it('keeps a prolonged zero-latency producer serialized and bounds remembered measurement identities', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    const host = new AtomizerInstrumentHost(manager, new FakePreferences(), {
      now: () => new Date(NOW),
      yieldToEventLoop: () => Promise.resolve(),
    });
    const target = 8_205;
    let stop: Promise<unknown> | undefined;
    host.subscribe((event) => {
      if (event.type === 'measurement' && event.measurement.sequence === target) stop = host.stopStreaming();
    });

    await host.startStreaming();
    await until(() => stop !== undefined);
    await stop;

    expect(manager.acquireCalls).toBe(target);
    expect(manager.maximumConcurrentAcquisitions).toBe(1);
    expect(manager.concurrentAcquisitions).toBe(0);
    manager.measurementQueue.push({
      ...measurementFixture(1),
      measurementId: 'measurement:reused-after-bounded-window',
    });
    await expect(host.acquire()).resolves.toMatchObject({ measurementId: 'measurement:reused-after-bounded-window' });
  }, 20_000);

  it('makes background acquisition failure queryable and delegates shutdown to manager', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireError = new Error('bridge timed out and was terminated');
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => host.state().streaming.status === 'faulted');
    expect(host.state().streaming).toMatchObject({ status: 'faulted', message: 'bridge timed out and was terminated' });

    await host.shutdown();
    expect(manager.disconnectCalls).toBe(1);
    expect(() => host.state()).not.toThrow();
    expect(() => host.subscribe(() => undefined)).toThrow(/closed/);
  });

  it('rejects conflicting manager event/return measurements before publishing either value', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.echoMeasurementEvent = true;
    manager.measurementEventTransform = (measurement) => ({ ...measurement, measurementId: 'conflicting-event' });
    const host = createHost(manager, new FakePreferences());
    const measurements: InstrumentMeasurement[] = [];
    host.subscribe((event) => { if (event.type === 'measurement') measurements.push(event.measurement); });

    await expect(host.acquire()).rejects.toThrow(/event and acquisition return disagree/);
    expect(measurements).toHaveLength(0);
  });

  it('does not publish or retain an oversized manager return and clears admission for a valid retry', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    let oversizedElementReads = 0;
    const frequencyHz = new Proxy(new Array<number>(MAX_SWEPT_SPECTRUM_POINTS_V1 + 1), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) oversizedElementReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const oversizedBase = measurementFixture(1);
    if (oversizedBase.kind !== 'swept-spectrum') throw new Error('invalid oversized fixture');
    manager.measurementQueue.push({
      ...oversizedBase,
      measurementId: 'measurement:oversized-future-sdr',
      frequencyHz,
      powerDbm: [-90, -90],
    });
    const host = createHost(manager, new FakePreferences());
    const measurements: InstrumentMeasurement[] = [];
    host.subscribe((event) => { if (event.type === 'measurement') measurements.push(event.measurement); });

    await expect(host.acquire()).rejects.toThrow();
    expect(measurements).toHaveLength(0);
    expect(oversizedElementReads).toBe(0);
    expect(JSON.stringify(host.state())).not.toContain('measurement:oversized-future-sdr');

    manager.measurementQueue.push(measurementFixture(2));
    await expect(host.acquire()).resolves.toMatchObject({ measurementId: 'measurement:2' });
    expect(measurements.map((measurement) => measurement.measurementId)).toEqual(['measurement:2']);
  });

  it('uses collision-safe measurement tuples even when opaque IDs contain delimiters', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.measurementQueue.push(
      { ...measurementFixture(1), sessionId: 'a', configurationRevision: 'b\u0000c', measurementId: 'first' },
      { ...measurementFixture(1), sessionId: 'a\u0000b', configurationRevision: 'c', measurementId: 'second' },
    );
    const host = createHost(manager, new FakePreferences());
    const measurements: InstrumentMeasurement[] = [];
    host.subscribe((event) => { if (event.type === 'measurement') measurements.push(event.measurement); });

    await host.acquire();
    await host.acquire();
    expect(measurements.map((measurement) => measurement.measurementId)).toEqual(['first', 'second']);
  });

  it('faults and stops a main-owned stream when the session reports even a recoverable error', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);
    manager.emit({
      type: 'error', sessionId: manager.session.sessionId,
      error: { code: 'driver-failure', message: 'recoverable transport warning', recoverable: true },
    });
    manager.acquireGate.resolve();
    await until(() => host.state().streaming.status === 'faulted');

    expect(host.state().streaming).toMatchObject({ status: 'faulted', message: 'recoverable transport warning' });
    expect(manager.acquireCalls).toBe(1);
  });

  it('rejects continuous complex-IQ v1 before starting the pump', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture({
      sessionId: 'session:signal-lab', configurationRevision: 'configuration:iq', configuredAt: NOW,
      configuration: {
        kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 1_000_000,
        bandwidthHz: 800_000, sampleCount: 1024, sampleFormat: 'cf32le',
      },
    });
    const host = createHost(manager, new FakePreferences());

    await expect(host.startStreaming()).rejects.toThrow(/bounded single acquisition/);
    expect(manager.acquireCalls).toBe(0);
  });

  it('keeps a failed shutdown retryable until disconnect succeeds', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.disconnectError = new Error('RF output-off acknowledgement lost');
    const host = createHost(manager, new FakePreferences());

    await expect(host.shutdown()).rejects.toThrow(/acknowledgement lost/);
    expect(host.state().session).toBeDefined();
    expect(() => host.subscribe(() => undefined)).not.toThrow();

    manager.disconnectError = undefined;
    await host.shutdown();
    expect(manager.disconnectCalls).toBe(2);
    expect(() => host.subscribe(() => undefined)).toThrow(/closed/);
  });

  it('cleans a pre-admission connection lease through the ordinary disconnect path', async () => {
    const manager = new FakeManager();
    const host = createHost(manager, new FakePreferences());

    await expect(host.disconnect()).resolves.toBeUndefined();

    expect(manager.disconnectCalls).toBe(1);
    expect(manager.pendingConnectionCleanupCalls).toBe(1);
  });

  it('keeps failed pre-admission connection cleanup retryable for the next before-quit attempt', async () => {
    const manager = new FakeManager();
    manager.pendingConnectionCleanupError = new Error('retained failed-connect transport did not close');
    const host = createHost(manager, new FakePreferences());

    await expect(host.shutdown()).rejects.toThrow(/failed-connect transport did not close/);
    expect(manager.disconnectCalls).toBe(1);
    expect(manager.pendingConnectionCleanupCalls).toBe(1);
    expect(() => host.subscribe(() => undefined)).not.toThrow();

    manager.pendingConnectionCleanupError = undefined;
    await expect(host.shutdown()).resolves.toBeUndefined();
    expect(manager.disconnectCalls).toBe(2);
    expect(manager.pendingConnectionCleanupCalls).toBe(2);
    expect(() => host.subscribe(() => undefined)).toThrow(/closed/);
  });

  it('stops and drains an in-flight stream acquisition before reconfiguration, and blocks restart during the transition', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);
    const requested = syntheticSpectrumConfiguration(400, 800, 5);
    const reconfiguration = host.configure(requested);

    expect(manager.configureCalls).toHaveLength(0);
    expect(() => host.startStreaming()).toThrow(/configuration transition/);
    expect(() => host.acquire()).toThrow(/configuration transition/);

    manager.acquireGate.resolve();
    const configured = await reconfiguration;

    expect(configured.configuration).toEqual(requested);
    expect(manager.acquireCalls).toBe(1);
    expect(manager.configureCalls).toHaveLength(1);
    expect(host.state().streaming).toEqual({ status: 'stopped' });
  });

  it('stops and drains streaming before a touch that can invalidate device mode', async () => {
    const manager = new FakeManager();
    manager.session = physicalTouchSessionFixture();
    manager.measurementQueue.push(physicalMeasurementFixture(1));
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);
    const touching = host.executeFeature({ kind: 'touch', action: 'tap', x: 20, y: 30 });

    expect(manager.featureCalls).toHaveLength(0);
    manager.acquireGate.resolve();
    await expect(touching).resolves.toMatchObject({ result: { kind: 'touch', x: 20, y: 30 } });
    expect(manager.featureCalls).toHaveLength(1);
    expect(manager.acquireCalls).toBe(1);
    expect(host.state().streaming).toEqual({ status: 'stopped' });
  });

  it('drains streaming before a connection mutation instead of overlapping the manager calls', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    manager.connectError = new Error('an instrument session is already active');
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);
    const connection = host.connect(signalLabCandidate);

    expect(manager.connectCalls).toHaveLength(0);
    manager.acquireGate.resolve();
    await expect(connection).rejects.toThrow(/already active/);
    expect(manager.connectCalls).toEqual([signalLabCandidate]);
    expect(manager.acquireCalls).toBe(1);
    expect(host.state().streaming).toEqual({ status: 'stopped' });
  });

  it('coalesces concurrent disconnect and shutdown around a deferred acquisition and admits no restart or new work', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);

    const disconnect = host.disconnect();
    expect(host.disconnect()).toBe(disconnect);
    expect(() => host.startStreaming()).toThrow(/disconnecting/);
    const shutdown = host.shutdown();
    expect(host.shutdown()).toBe(shutdown);
    expect(host.disconnect()).toBe(shutdown);
    expect(() => host.discover()).toThrow(/closed/);
    expect(() => host.configure(syntheticSpectrumConfiguration(1, 2, 2))).toThrow(/closed/);
    expect(manager.disconnectCalls).toBe(0);

    manager.acquireGate.resolve();
    await Promise.all([disconnect, shutdown]);

    expect(manager.acquireCalls).toBe(1);
    expect(manager.disconnectCalls).toBe(1);
    expect(host.shutdown()).toBe(shutdown);
    await host.shutdown();
    expect(manager.disconnectCalls).toBe(1);
    expect(host.state().streaming).toEqual({ status: 'stopped' });
    expect(() => host.subscribe(() => undefined)).toThrow(/closed/);
    await expect(host.disconnect()).resolves.toBeUndefined();
  });

  it('bounds its internal Promise tail and still reserves one RF-safe disconnect slot', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    const acquisition = host.acquire();
    await until(() => manager.acquireCalls === 1);
    const queuedDiscoveries = Array.from({ length: 63 }, () => host.discover());
    await expect(host.discover()).rejects.toThrow(/admission limit of 64/);
    const disconnect = host.disconnect();
    expect(host.disconnect()).toBe(disconnect);

    manager.acquireGate.resolve();
    await acquisition;
    await Promise.all(queuedDiscoveries);
    await disconnect;

    expect(manager.discoverCalls).toBe(63);
    expect(manager.disconnectCalls).toBe(1);
    expect(manager.operationOrder[0]).toBe('acquire');
    expect(manager.operationOrder[1]).toBe('disconnect');
    expect(manager.operationOrder.slice(2)).toHaveLength(63);
    expect(new Set(manager.operationOrder.slice(2))).toEqual(new Set(['discover']));
  });

  it('cancels a queued reconnect when ordinary disconnect overtakes the host tail', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    const acquisition = host.acquire();
    await until(() => manager.acquireCalls === 1);
    const staleReconnect = host.connect(signalLabCandidate);
    const disconnecting = host.disconnect();

    manager.acquireGate.resolve();
    await expect(acquisition).resolves.toMatchObject({ measurementId: 'measurement:1' });
    await expect(disconnecting).resolves.toBeUndefined();
    await expect(staleReconnect).rejects.toThrow(/canceled by disconnect/);

    expect(manager.operationOrder).toEqual(['acquire', 'disconnect']);
    expect(manager.connectCalls).toHaveLength(0);
    expect(manager.session).toBeUndefined();
    expect(host.state().session).toBeUndefined();
  });

  it('reserves transition admission before callers wait for a running stream to stop', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    await host.startStreaming();
    await until(() => manager.acquireCalls === 1);
    const configuration = syntheticSpectrumConfiguration(1, 2, 2);
    // The in-flight stream acquisition owns one admission; these transitions
    // reserve the other 63 while all of them await the same run.done.
    const admitted = Array.from({ length: 63 }, () => host.configure(configuration));
    await expect(host.configure(configuration)).rejects.toThrow(/admission limit of 64/);
    expect(manager.configureCalls).toHaveLength(0);

    manager.acquireGate.resolve();
    await Promise.all(admitted);
    expect(manager.configureCalls).toHaveLength(63);
    expect(host.state().streaming).toEqual({ status: 'stopped' });
  });

  it('lets active work finish, cancels admitted-but-not-started work, and disconnects once shutdown begins', async () => {
    const manager = new FakeManager();
    manager.session = sessionFixture(configurationFixture());
    manager.acquireGate = deferred<void>();
    const host = createHost(manager, new FakePreferences());

    const acquisition = host.acquire();
    await until(() => manager.acquireCalls === 1);
    const queuedDiscovery = host.discover();
    const shutdown = host.shutdown();

    manager.acquireGate.resolve();
    await expect(acquisition).resolves.toMatchObject({ measurementId: 'measurement:1' });
    await expect(queuedDiscovery).rejects.toThrow(/closed/);
    await shutdown;

    expect(manager.discoverCalls).toBe(0);
    expect(manager.disconnectCalls).toBe(1);
  });
});

class FakePreferences {
  loadError: Error | undefined;
  loaded: LoadedInstrumentPreference = {
    source: 'factory-default',
    preference: {
      schemaVersion: 1, driverId: 'signal-lab', candidateKind: 'signal-lab',
      candidateId: signalLabCandidate.candidateId, updatedAt: new Date(0).toISOString(),
    },
  };
  readonly saved: Array<{ driverId: string; candidateKind: string; candidateId: string }> = [];

  async load(): Promise<LoadedInstrumentPreference> {
    if (this.loadError) throw this.loadError;
    return structuredClone(this.loaded);
  }

  async save(
    driverId: string,
    candidateKind: InstrumentCandidate['sourceKind'],
    candidateId: string,
  ): Promise<InstrumentPreference> {
    this.saved.push({ driverId, candidateKind, candidateId });
    return { schemaVersion: 1, driverId, candidateKind, candidateId, updatedAt: NOW };
  }
}

class FakeManager {
  readonly registry = {
    get: (driverId: string) => driverId === 'signal-lab'
      ? { driverId: 'signal-lab', sourceKinds: ['signal-lab'] as const }
      : driverId === 'tinysa-zs407'
        ? { driverId: 'tinysa-zs407', sourceKinds: ['serial-port', 'tinysa-firmware-twin'] as const }
        : undefined,
  };
  readonly listeners = new Set<(event: InstrumentManagerEvent) => void>();
  readonly connectCalls: InstrumentCandidate[] = [];
  readonly configureCalls: InstrumentConfiguration[] = [];
  readonly featureCalls: InstrumentFeatureRequest[] = [];
  discoverCalls = 0;
  disconnectCalls = 0;
  pendingConnectionCleanupCalls = 0;
  acquireCalls = 0;
  concurrentAcquisitions = 0;
  maximumConcurrentAcquisitions = 0;
  echoMeasurementEvent = false;
  measurementEventTransform: ((measurement: InstrumentMeasurement) => InstrumentMeasurement) | undefined;
  readonly measurementQueue: InstrumentMeasurement[] = [];
  readonly operationOrder: string[] = [];
  acquireError: Error | undefined;
  connectError: Error | undefined;
  disconnectError: Error | undefined;
  pendingConnectionCleanupError: Error | undefined;
  acquireGate: Deferred<void> | undefined;
  session: InstrumentSessionSnapshot | undefined;
  cleanupRequirement: { driverId: 'signal-lab' | 'tinysa-zs407'; phase: 'driver-pending' | 'rejected-session' } | undefined = undefined;
  discoveryCandidates: readonly InstrumentCandidate[] = [signalLabCandidate, physicalTinySaCandidate];

  subscribe(listener: (event: InstrumentManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): InstrumentSessionSnapshot | undefined { return this.session ? structuredClone(this.session) : undefined; }
  pendingConnectionCleanup() { return this.cleanupRequirement; }

  async discover(): Promise<InstrumentDiscoveryResult> {
    this.operationOrder.push('discover');
    this.discoverCalls++;
    const result: InstrumentDiscoveryResult = {
      discoveryRevision: 'discovery:1', discoveredAt: NOW, candidates: this.discoveryCandidates, failures: [],
    };
    this.emit({ type: 'discovery', result });
    return result;
  }

  async connect(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    this.operationOrder.push('connect');
    this.connectCalls.push(candidate);
    if (this.connectError) throw this.connectError;
    this.session = sessionFixture();
    this.emit({ type: 'connected', session: this.session });
    return this.session;
  }

  async configure(configuration: InstrumentConfiguration): Promise<InstrumentConfigurationState> {
    this.operationOrder.push('configure');
    if (!this.session) throw new Error('no session');
    this.configureCalls.push(configuration);
    const state = configurationFixture(configuration);
    this.session = { ...this.session, configuration: state };
    this.emit({ type: 'configured', configuration: state });
    return state;
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.operationOrder.push('acquire');
    this.acquireCalls++;
    this.concurrentAcquisitions++;
    this.maximumConcurrentAcquisitions = Math.max(this.maximumConcurrentAcquisitions, this.concurrentAcquisitions);
    try {
      await this.acquireGate?.promise;
      if (this.acquireError) throw this.acquireError;
      const measurement = this.measurementQueue.shift() ?? measurementFixture(this.acquireCalls);
      if (this.echoMeasurementEvent) this.emit({
        type: 'measurement',
        measurement: this.measurementEventTransform?.(measurement) ?? measurement,
      });
      return measurement;
    } finally {
      this.concurrentAcquisitions--;
    }
  }

  async executeFeature(request: InstrumentFeatureRequest): Promise<InstrumentFeatureResult> {
    this.operationOrder.push('feature');
    if (!this.session) throw new Error('unsupported fixture feature');
    this.featureCalls.push(request);
    if (request.kind === 'touch') {
      const result: InstrumentFeatureResult = { ...request, sessionId: this.session.sessionId, accepted: true };
      const { configuration: _configuration, ...withoutConfiguration } = this.session;
      this.session = withoutConfiguration;
      this.emit({ type: 'feature-result', result, session: this.session });
      return result;
    }
    if (request.kind !== 'signal-lab-profile-selection') throw new Error('unsupported fixture feature');
    if (this.session.provenance.sourceKind !== 'signal-lab') throw new Error('fixture session is not SignalLab');
    const result = { ...request, sessionId: this.session.sessionId, producerConfigurationEpoch: `producer-epoch:${request.profileId}` };
    const features = this.session.capabilities.features.map((feature) => feature.kind === 'signal-lab-profile-selection'
      ? { ...feature, selectedProfileId: request.profileId }
      : feature);
    const { configuration: _configuration, ...withoutConfiguration } = this.session;
    this.session = {
      ...withoutConfiguration,
      provenance: { ...this.session.provenance, producerConfigurationEpoch: result.producerConfigurationEpoch },
      capabilities: { ...this.session.capabilities, features },
    };
    this.emit({ type: 'feature-result', result, session: this.session });
    return result;
  }

  async disconnect(): Promise<void> {
    this.operationOrder.push('disconnect');
    this.disconnectCalls++;
    if (this.disconnectError) throw this.disconnectError;
    if (this.session) {
      const prior = this.session;
      this.session = undefined;
      this.emit({ type: 'disconnected', sessionId: prior.sessionId, driverId: prior.driverId });
    }
    this.pendingConnectionCleanupCalls++;
    if (this.pendingConnectionCleanupError) throw this.pendingConnectionCleanupError;
    this.cleanupRequirement = undefined;
  }

  emit(event: InstrumentManagerEvent): void { for (const listener of this.listeners) listener(event); }
}

function createHost(
  manager: FakeManager,
  preferences: FakePreferences,
): AtomizerInstrumentHost {
  return new AtomizerInstrumentHost(manager, preferences, {
    now: () => new Date(NOW),
    yieldToEventLoop: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  });
}

function sessionFixture(configuration?: InstrumentConfigurationState): InstrumentSessionSnapshot {
  return {
    sessionId: 'session:signal-lab', driverId: 'signal-lab', candidate: signalLabCandidate,
    provenance: {
      sourceKind: 'signal-lab', sourceId: 'default',
      execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection', verifiedAt: NOW,
      producerConfigurationEpoch: 'producer-epoch:cw',
      contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1,
      contractSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), generatorSha256: 'c'.repeat(64),
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    },
    capabilities: {
      schemaVersion: 1,
      acquisitions: [{
        kind: 'swept-spectrum', frequencyHz: { min: 1, max: 1_000_000_000 },
        points: { min: 2, max: 4_096 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
        powerUnit: 'dBm',
      }, {
        kind: 'detected-power-timeseries', centerFrequencyHz: { min: 1, max: 1_000_000_000 },
        sampleCount: { min: 1, max: 4_096 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
        powerUnit: 'dBm', timing: 'uniform',
      }],
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: [
          { profileId: 'cw', centerFrequencyHz: 100, recommendedSpanHz: 200 },
          { profileId: 'fm', centerFrequencyHz: 200, recommendedSpanHz: 100 },
        ],
        selectedProfileId: 'cw',
      }],
    },
    rfOutput: 'not-supported',
    rfOutputQualification: 'not-applicable',
    ...(configuration ? { configuration } : {}),
  };
}

function physicalTouchSessionFixture(): InstrumentSessionSnapshot {
  return {
    sessionId: 'session:physical',
    driverId: 'tinysa-zs407',
    candidate: physicalTinySaCandidate,
    provenance: {
      sourceKind: 'serial-port',
      execution: 'physical',
      transport: 'usb-cdc-acm',
      qualification: 'device-observed',
      verifiedAt: NOW,
      serialPort: physicalTinySaCandidate.serialPort,
      device: {
        model: 'tinySA Ultra+ ZS407',
        hardwareVersion: 'ZS407',
        firmwareVersion: 'tinySA4_fixture-custom-gdeadbee',
        firmwareReportedRevision: 'deadbee',
        firmwareQualification: 'custom-unqualified',
        firmwareWarning: 'Custom firmware revision deadbee is admitted without source qualification.',
        usbIdentityVerified: true,
      },
    },
    capabilities: {
      schemaVersion: 1,
      acquisitions: [{
        kind: 'swept-spectrum',
        frequencyHz: { min: 1, max: 1_000_000_000 },
        points: { min: 2, max: 4_096 },
        sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
        controls: {
          schemaVersion: 1,
          model: 'receiver',
          acquisitionFormats: ['text', 'raw'],
          resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850 } },
          attenuationDb: { automatic: true, manual: { min: 0, max: 31 } },
          detectors: ['sample', 'quasi-peak'],
          spurRejection: ['off', 'on', 'auto'],
          lowNoiseAmplifier: ['off', 'on'],
          avoidSpurs: ['off', 'on', 'auto'],
          triggerModes: ['auto', 'normal', 'single'],
          triggerLevelDbm: { min: -174, max: 30 },
        },
        powerUnit: 'dBm',
      }],
      features: [{ kind: 'touch', width: 480, height: 320 }],
    },
    rfOutput: 'not-supported',
    rfOutputQualification: 'not-applicable',
    configuration: receiverConfigurationFixture(),
  };
}

function receiverConfigurationFixture(): InstrumentConfigurationState {
  return {
    sessionId: 'session:physical',
    configurationRevision: 'configuration:1',
    configuredAt: NOW,
    configuration: {
      kind: 'swept-spectrum', startHz: 100, stopHz: 300, points: 3, sweepTimeSeconds: 'auto',
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text',
        resolutionBandwidthKhz: 'auto', attenuationDb: 'auto', detector: 'sample',
        spurRejection: 'auto', lowNoiseAmplifier: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' },
      },
    },
  };
}

function physicalMeasurementFixture(sequence: number): InstrumentMeasurement {
  return {
    schemaVersion: 1, kind: 'swept-spectrum', measurementId: `measurement:physical:${sequence}`,
    sessionId: 'session:physical', configurationRevision: 'configuration:1', sequence, capturedAt: NOW,
    elapsedMilliseconds: 1, resolutionBandwidthHz: 10_000, attenuationDb: 0,
    qualification: 'device-observed', complete: true,
    frequencyHz: [100, 200, 300], powerDbm: [-90, -70, -90],
  };
}

function configurationFixture(configuration: InstrumentConfiguration = {
  ...syntheticSpectrumConfiguration(100, 300, 3),
}): InstrumentConfigurationState {
  return {
    sessionId: 'session:signal-lab', configurationRevision: 'configuration:1', configuration, configuredAt: NOW,
  };
}

function syntheticSpectrumConfiguration(
  startHz: number,
  stopHz: number,
  points: number,
): Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }> {
  return {
    kind: 'swept-spectrum', startHz, stopHz, points, sweepTimeSeconds: 0.05,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

function measurementFixture(sequence: number): InstrumentMeasurement {
  return {
    schemaVersion: 1, kind: 'swept-spectrum', measurementId: `measurement:${sequence}`,
    sessionId: 'session:signal-lab', configurationRevision: 'configuration:1', sequence, capturedAt: NOW,
    producerConfigurationEpoch: 'producer-epoch:cw',
    elapsedMilliseconds: 1, resolutionBandwidthHz: null, attenuationDb: null,
    qualification: 'synthetic-visual-projection', complete: true,
    frequencyHz: [100, 200, 300], powerDbm: [-90, -70, -90],
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for fixture state');
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
