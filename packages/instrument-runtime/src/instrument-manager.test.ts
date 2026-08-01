import { describe, expect, it } from 'vitest';
import type {
  InstrumentCandidate,
  InstrumentCandidateDescriptor,
  InstrumentCapabilities,
  InstrumentConfigurationCommand,
  InstrumentDriverId,
  InstrumentDriverDiscoveryResult,
  InstrumentFeatureCommand,
  InstrumentFeatureResult,
  InstrumentFeatureCapability,
  InstrumentManagerEvent,
  InstrumentMeasurement,
  InstrumentReceiveOnlySafetyState,
  ReceiveOnlySafetyReceipt,
  InstrumentSessionProvenance,
  InstrumentSessionEvent,
  InstrumentSourceKind,
} from '@tinysa/contracts';
import {
  MAX_DISCOVERY_CANDIDATES_V1,
  MAX_SIGNAL_LAB_PROFILES_V1,
  MAX_SWEPT_SPECTRUM_POINTS_V1,
} from '@tinysa/contracts';
import type { InstrumentDriver, InstrumentSession } from './instrument-driver.js';
import { InstrumentDriverRegistry } from './instrument-driver-registry.js';
import { InstrumentManager, type InstrumentManagerRuntime } from './instrument-manager.js';

describe('InstrumentManager discovery and selection', () => {
  it('discovers every registered driver independently and preserves per-driver failures', async () => {
    const serial = new StubDriver('tinysa-zs407', ['serial-port'], async () => [serialDescriptor()]);
    const signalLab = new StubDriver('signal-lab', ['signal-lab'], async () => { throw new Error('bridge unavailable'); });
    const manager = new InstrumentManager(new InstrumentDriverRegistry([serial, signalLab]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    const result = await manager.discover();

    expect(serial.discoverCalls).toBe(1);
    expect(signalLab.discoverCalls).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      driverId: 'tinysa-zs407', sourceKind: 'serial-port', discoveryRevision: 'discovery:1',
    });
    expect(result.failures).toEqual([{
      driverId: 'signal-lab', code: 'driver-failure', recoverable: false, message: 'bridge unavailable',
    }]);
    expect(events).toEqual([{ type: 'discovery', result }]);
  });

  it('preserves candidates alongside typed source-scoped failures from one driver', async () => {
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port', 'tinysa-firmware-twin'],
      async () => ({
        candidates: [serialDescriptor()],
        failures: [{
          sourceKind: 'tinysa-firmware-twin',
          code: 'source-unavailable',
          recoverable: true,
          message: 'firmware twin is not running',
        }],
      }),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());

    const result = await manager.discover();

    expect(result.candidates).toHaveLength(1);
    expect(result.failures).toEqual([{
      driverId: 'tinysa-zs407',
      sourceKind: 'tinysa-firmware-twin',
      code: 'source-unavailable',
      recoverable: true,
      message: 'firmware twin is not running',
    }]);
  });

  it('does not replace or retain the last admitted discovery when a future driver aggregate exceeds v1', async () => {
    let oversized = false;
    const driverCount = 5;
    const candidatesPerDriver = Math.floor(MAX_DISCOVERY_CANDIDATES_V1 / driverCount) + 1;
    const drivers = Array.from({ length: driverCount }, (_value, driverIndex) => {
      const driverId = `future-sdr-${driverIndex}`;
      return new StubDriver(
        driverId,
        ['signal-lab'],
        async () => oversized
          ? Array.from(
            { length: candidatesPerDriver },
            (_candidate, candidateIndex) => signalLabDescriptorFor(driverId, candidateIndex),
          )
          : driverIndex === 0 ? [signalLabDescriptorFor(driverId, 0)] : [],
      );
    });
    const manager = new InstrumentManager(new InstrumentDriverRegistry(drivers), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const admitted = (await manager.discover()).candidates[0]!;

    oversized = true;
    await expect(manager.discover()).rejects.toThrow();
    expect(events.filter((event) => event.type === 'discovery')).toHaveLength(1);

    await expect(manager.connect(admitted)).resolves.toMatchObject({ candidate: admitted });
    expect(manager.snapshot()?.candidate).toEqual(admitted);
    await manager.disconnect();
  });

  it('rejects oversized session capabilities before announcement and tears down the driver lease', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        const profiles = Array.from({ length: MAX_SIGNAL_LAB_PROFILES_V1 + 1 }, (_value, index) => ({
          profileId: `profile:${index}`,
          centerFrequencyHz: 100_000_000,
          recommendedSpanHz: 1_000_000,
        }));
        session = new StubSession(candidate, {
          ...analyzerCapabilities(),
          features: [{
            kind: 'signal-lab-profile-selection', profiles, selectedProfileId: 'profile:0',
          }],
        } as unknown as InstrumentCapabilities);
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    await expect(manager.connect((await manager.discover()).candidates[0]!))
      .rejects.toMatchObject({ code: 'driver-contract' });

    expect(session!.disconnectCalls).toBe(1);
    expect(manager.snapshot()).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(['discovery']);
  });

  it('rejects source-capability contradictions before announcing a session', async () => {
    const validSignalLab = signalLabCapabilities([]);
    const forbiddenSignalLabCapabilities: readonly InstrumentCapabilities[] = [
      analyzerCapabilities(),
      complexIqCapabilities(),
      { ...validSignalLab, features: [] },
      {
        ...validSignalLab,
        acquisitions: validSignalLab.acquisitions.map((capability) => capability.kind === 'swept-spectrum'
          ? { ...capability, sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.05, max: 0.05 } } }
          : capability),
      },
      {
        ...validSignalLab,
        features: [{
          kind: 'signal-lab-profile-selection',
          profiles: [signalLabFixtureProfile('outside', 6_000_000_001, 1_000_000)],
          selectedProfileId: 'outside',
          channel: signalLabFixtureChannel(),
          iqProfiles: [{
            profileId: 'outside', nativeSampleRateHz: null, signalBandwidthHz: 1,
            profileReferenceCenterHz: 6_000_000_001, nativeCarrierOffsetHz: 0,
            nativeMinimumCaptureBandwidthHz: null,
            replay: 'continuous', derivedTransportSupported: false,
          }],
        }],
      },
      signalLabCapabilities([generatorCapability()]),
      signalLabCapabilities([{ kind: 'screen', width: 2, height: 1, pixelFormat: 'rgb565le' }]),
      signalLabCapabilities([{ kind: 'touch', width: 2, height: 1 }]),
      signalLabCapabilities([{ kind: 'diagnostics', reports: ['identity'] }]),
    ];
    for (const [index, capabilities] of forbiddenSignalLabCapabilities.entries()) {
      let session: StubSession;
      const driver = new StubDriver(
        'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
        async (candidate) => (session = new StubSession(candidate, capabilities)),
      );
      const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
      await expect(manager.connect((await manager.discover()).candidates[0]!))
        .rejects.toMatchObject({ code: 'driver-contract' });
      expect(session!.disconnectCalls, `forbidden SignalLab capability case ${index}`).toBe(1);
      expect(manager.snapshot()).toBeUndefined();
    }

    let serialSession: StubSession;
    const serialDriver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (serialSession = new StubSession(candidate, signalLabCapabilities([]))),
    );
    const serialManager = new InstrumentManager(new InstrumentDriverRegistry([serialDriver]), deterministicRuntime());
    await expect(serialManager.connect((await serialManager.discover()).candidates[0]!))
      .rejects.toMatchObject({ code: 'driver-contract' });
    expect(serialSession!.disconnectCalls).toBe(1);
  });

  it('rejects stale candidates and admits only one active session', async () => {
    let session: StubSession | undefined;
    const driver = new StubDriver(
      'tinysa-zs407',
      ['serial-port'],
      async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const first = (await manager.discover()).candidates[0]!;
    const current = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(first)).rejects.toMatchObject({ code: 'stale-candidate' });
    expect(driver.connectCalls).toHaveLength(0);
    const connected = await manager.connect(current);
    expect(connected).toMatchObject({ sessionId: 'session:tinysa-zs407', candidate: current });
    await expect(manager.connect(current)).rejects.toMatchObject({ code: 'session-active' });
    expect(driver.connectCalls).toHaveLength(1);
    await manager.disconnect();
    expect(session?.disconnectCalls).toBe(1);
  });

  it('isolates retained discovery evidence from caller mutation before connect', async () => {
    const driver = new StubDriver('tinysa-zs407', ['serial-port'], async () => [serialDescriptor()]);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const returned = (await manager.discover()).candidates[0]!;
    const authentic = structuredClone(returned);
    if (returned.sourceKind !== 'serial-port') throw new Error('Expected serial fixture');

    returned.serialPort.path = '/dev/tty.forged-after-discovery';
    await expect(manager.connect(returned)).rejects.toMatchObject({ code: 'stale-candidate' });
    expect(driver.connectCalls).toHaveLength(0);

    await expect(manager.connect(authentic)).resolves.toMatchObject({ candidate: authentic });
    expect(driver.connectCalls).toHaveLength(1);
    expect(driver.connectCalls[0]).not.toBe(authentic);
    expect(Object.isFrozen(driver.connectCalls[0])).toBe(true);
    expect(driver.connectCalls[0]?.sourceKind === 'serial-port'
      && Object.isFrozen(driver.connectCalls[0].serialPort)).toBe(true);
    await manager.disconnect();
  });

  it('never falls back to a different driver when the selected driver fails', async () => {
    const selected = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async () => { throw new Error('selected bridge refused connection'); },
    );
    const other = new StubDriver('tinysa-zs407', ['serial-port'], async () => [serialDescriptor()]);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([selected, other]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates.find((value) => value.driverId === 'signal-lab')!;

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'driver-failure' });
    expect(selected.connectCalls).toHaveLength(1);
    expect(other.connectCalls).toHaveLength(0);
    expect(manager.snapshot()).toBeUndefined();
  });

  it('rejects SignalLab session provenance bound to another discovered source ID', async () => {
    let rejectedSession: StubSession | undefined;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        const session = new StubSession(candidate, analyzerCapabilities());
        rejectedSession = session;
        Object.defineProperty(session, 'provenance', {
          value: { ...session.provenance, sourceId: 'different-source' },
        });
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'driver-contract' });
    expect(manager.snapshot()).toBeUndefined();
    expect(rejectedSession?.disconnectCalls).toBe(1);
  });

  it('rejects and RF-safely tears down a session that faults synchronously while subscribing', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        session.onSubscribe = (listener) => listener({
          type: 'error',
          sessionId: session.sessionId,
          error: { code: 'driver-failure', message: 'transport failed during subscription', recoverable: false },
        });
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    await expect(manager.connect((await manager.discover()).candidates[0]!))
      .rejects.toMatchObject({ code: 'driver-failure' });

    expect(session!.featureCalls).toEqual([
      expect.objectContaining({ kind: 'rf-generator', action: 'set-output', enabled: false }),
    ]);
    expect(session!.disconnectCalls).toBe(1);
    expect(manager.snapshot()).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(['discovery']);
  });

  it('bounds synchronous subscription events before announcing or retaining a session', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onSubscribe = (listener) => {
          for (let index = 0; index < 300; index++) {
            listener({ type: 'status', sessionId: session.sessionId, status: 'busy' });
          }
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    await expect(manager.connect((await manager.discover()).candidates[0]!))
      .rejects.toMatchObject({ code: 'driver-contract' });

    expect(session!.disconnectCalls).toBe(1);
    expect(manager.snapshot()).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(['discovery']);
  });

  it('does not lose a terminal session event emitted reentrantly from a connected observer', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const firstObserverEvents: InstrumentManagerEvent[] = [];
    const secondObserverEvents: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => {
      firstObserverEvents.push(event);
      if (event.type === 'connected') {
        session.emit({
          type: 'status', sessionId: session.sessionId,
          status: 'faulted', message: 'fault emitted from connected observer',
        });
      }
    });
    manager.subscribe((event) => secondObserverEvents.push(event));

    const connected = await manager.connect((await manager.discover()).candidates[0]!);

    expect(connected.fault).toMatchObject({ code: 'session-fault', recoverable: false });
    expect(manager.snapshot()?.fault).toMatchObject({ code: 'session-fault', recoverable: false });
    expect(firstObserverEvents.map((event) => event.type)).toEqual([
      'discovery', 'connected', 'status', 'session-state',
    ]);
    expect(secondObserverEvents.map((event) => event.type)).toEqual([
      'discovery', 'connected', 'status', 'session-state',
    ]);
    await expect(manager.configure(sweepConfiguration())).rejects.toMatchObject({ code: 'driver-failure' });
    await manager.disconnect();
  });

  it('does not dispatch configuration after a caller accessor terminal-faults the session', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = sweepConfiguration();
    Object.defineProperty(configuration, 'startHz', {
      enumerable: true,
      get() {
        session.emit({
          type: 'status', sessionId: session.sessionId,
          status: 'faulted', message: 'fault from configuration getter',
        });
        return 100;
      },
    });

    await expect(manager.configure(configuration)).rejects.toMatchObject({ code: 'driver-failure' });
    expect(session!.configureCalls).toHaveLength(0);
    expect(manager.snapshot()?.fault).toMatchObject({ code: 'session-fault', recoverable: false });
    await manager.disconnect();
  });

  it('isolates manager event objects and listener membership for each dispatch cycle', async () => {
    const driver = new StubDriver('tinysa-zs407', ['serial-port'], async () => [serialDescriptor()]);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    let downstreamDisplayName: string | undefined;
    let lateListenerCalls = 0;
    manager.subscribe((event) => {
      if (event.type !== 'connected') return;
      event.session.candidate.displayName = 'MUTATED BY FIRST CONSUMER';
      manager.subscribe(() => { lateListenerCalls++; });
    });
    manager.subscribe((event) => {
      if (event.type === 'connected') downstreamDisplayName = event.session.candidate.displayName;
    });

    const connected = await manager.connect((await manager.discover()).candidates[0]!);

    expect(downstreamDisplayName).toBe('tinySA Ultra+ ZS407');
    expect(connected.candidate.displayName).toBe('tinySA Ultra+ ZS407');
    expect(manager.snapshot()?.candidate.displayName).toBe('tinySA Ultra+ ZS407');
    expect(lateListenerCalls).toBe(0);
    await manager.disconnect();
  });

  it('retains a rejected session as faulted and teardown-only when cleanup cannot disconnect it', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        session.onSubscribe = (listener) => listener({
          type: 'error',
          sessionId: session.sessionId,
          error: { code: 'driver-failure', message: 'subscription observed a terminal transport state', recoverable: false },
        });
        session.onDisconnect = async () => { throw new Error('device remained attached'); };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const retainedEvents: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => retainedEvents.push(event));
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'driver-contract' });
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown',
      rfOutputQualification: 'unverified',
      fault: { code: 'driver-failure', recoverable: false },
    });
    await expect(manager.configure(sweepConfiguration())).rejects.toMatchObject({ code: 'driver-failure' });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-failure' });
    for (let index = 0; index < 32; index++) {
      session!.emit({ type: 'status', sessionId: session!.sessionId, status: 'busy' });
    }
    expect(retainedEvents.map((event) => event.type)).toEqual(['discovery']);

    session!.onDisconnect = async () => undefined;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(manager.snapshot()).toBeUndefined();
  });

  it('retains rejected RF-capable session ownership when output-off cleanup is not acknowledged', async () => {
    let session: StubSession;
    let rejectOff = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        session.subscribeError = new Error('event subscription failed');
        const normal = session.onFeature;
        session.onFeature = async (command) => {
          if (rejectOff && command.kind === 'rf-generator' && command.action === 'set-output' && !command.enabled) {
            throw new Error('RF output-off acknowledgement was lost');
          }
          return normal(command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'driver-contract' });
    expect(session!.disconnectCalls).toBe(0);
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown', rfOutputQualification: 'unverified', fault: { recoverable: false },
    });

    rejectOff = false;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(session!.disconnectCalls).toBe(1);
    expect(manager.snapshot()).toBeUndefined();
  });
});

describe('InstrumentManager lifecycle and measurement admission', () => {
  it('finishes active work, then prioritizes teardown ahead of queued normal calls without overlap', async () => {
    const configureGate = deferred<void>();
    const order: string[] = [];
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onConfigure = async () => { order.push('configure:start'); await configureGate.promise; order.push('configure:end'); };
        session.onAcquire = async () => { throw new Error('queued acquisition must not outrun teardown'); };
        session.onDisconnect = async () => { order.push('disconnect'); };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    const configuring = manager.configure(sweepConfiguration());
    await turn();
    expect(order).toEqual(['configure:start']);
    const acquisitionFailure = expect(manager.acquire()).rejects.toMatchObject({ code: 'operation-canceled' });
    const disconnecting = manager.disconnect();

    configureGate.resolve();
    await configuring;
    await turn();
    expect(order).toEqual(['configure:start', 'configure:end', 'disconnect']);
    await disconnecting;
    await acquisitionFailure;
    expect(order).toEqual(['configure:start', 'configure:end', 'disconnect']);
  });

  it('cancels a queued reconnect when RF-safe disconnect overtakes it', async () => {
    const acquisitionGate = deferred<void>();
    const order: string[] = [];
    let connectionIndex = 0;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        connectionIndex++;
        const session = new StubSession(candidate, analyzerCapabilities());
        session.onAcquire = async () => {
          order.push('acquire:start');
          await acquisitionGate.promise;
          order.push('acquire:end');
          return sweptMeasurement(session, session.configureCalls[0]!.configurationRevision, 1);
        };
        session.onDisconnect = async () => { order.push(`disconnect:${connectionIndex}`); };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    await manager.configure(sweepConfiguration());

    const acquisition = manager.acquire();
    await turn();
    expect(order).toEqual(['acquire:start']);
    const staleReconnect = manager.connect(candidate);
    const disconnecting = manager.disconnect();

    acquisitionGate.resolve();
    await expect(acquisition).resolves.toMatchObject({ sequence: 1 });
    await expect(disconnecting).resolves.toBeUndefined();
    await expect(staleReconnect).rejects.toMatchObject({ code: 'operation-canceled' });

    expect(order).toEqual(['acquire:start', 'acquire:end', 'disconnect:1']);
    expect(driver.connectCalls).toHaveLength(1);
    expect(manager.snapshot()).toBeUndefined();
  });

  it('bounds its internal queue while reserving one coalesced RF-safe teardown admission', async () => {
    const configureGate = deferred<void>();
    const order: string[] = [];
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => { order.push('discover'); return [serialDescriptor()]; },
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onConfigure = async () => configureGate.promise;
        session.onDisconnect = async () => { order.push('disconnect'); };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    order.length = 0;

    const configuring = manager.configure(sweepConfiguration());
    await turn();
    const queuedDiscoveries = Array.from({ length: 63 }, () => manager.discover());
    await expect(manager.discover()).rejects.toMatchObject({ code: 'admission-limit' });
    const disconnecting = manager.disconnect();
    expect(manager.disconnect()).toBe(disconnecting);

    configureGate.resolve();
    await configuring;
    await Promise.all(queuedDiscoveries);
    await disconnecting;

    expect(driver.discoverCalls).toBe(64);
    expect(session!.disconnectCalls).toBe(1);
    expect(order[0]).toBe('disconnect');
    expect(order.slice(1)).toHaveLength(63);
    expect(new Set(order.slice(1))).toEqual(new Set(['discover']));
  });

  it('does not readmit configuration or RF certainty after a terminal event during configure', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        session.onConfigure = async () => {
          session.emit({ type: 'status', sessionId: session.sessionId, status: 'faulted', message: 'transport failed during configure' });
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.configure(sweepConfiguration())).rejects.toMatchObject({ code: 'driver-failure' });
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown', rfOutputQualification: 'unverified', fault: { recoverable: false },
    });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await manager.disconnect();
  });

  it('requires an explicit output-off acknowledgement after RF-capable receive configuration', async () => {
    let session: StubSession;
    let returnDishonestOffResult = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        const normal = session.onFeature;
        session.onFeature = async (command) => {
          if (returnDishonestOffResult
            && command.kind === 'rf-generator'
            && command.action === 'set-output'
            && !command.enabled) {
            return { ...command, enabled: true };
          }
          return normal(command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.configure(sweepConfiguration())).rejects.toMatchObject({ code: 'driver-contract' });
    expect(session!.configureCalls).toHaveLength(1);
    expect(session!.featureCalls).toEqual([
      expect.objectContaining({ kind: 'rf-generator', action: 'set-output', enabled: false }),
    ]);
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown',
      rfOutputQualification: 'unverified',
      fault: { code: 'driver-contract', recoverable: false },
    });
    expect(manager.snapshot()?.configuration).toBeUndefined();

    returnDishonestOffResult = false;
    await manager.disconnect();
  });

  it('terminal-faults an uncertain disconnect and permits only a later teardown retry', async () => {
    let session: StubSession;
    let rejectDisconnect = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onDisconnect = async () => {
          if (rejectDisconnect) throw new Error('transport closed without a disconnect acknowledgement');
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(sweepConfiguration());

    await expect(manager.disconnect()).rejects.toMatchObject({ code: 'driver-failure' });
    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-failure', recoverable: false } });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await expect(manager.configure(sweepConfiguration())).rejects.toMatchObject({ code: 'driver-failure' });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-failure' });

    rejectDisconnect = false;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(session!.disconnectCalls).toBe(2);
    expect(manager.snapshot()).toBeUndefined();
  });

  it('retains the exact failed event-unsubscribe lease until teardown retry succeeds', async () => {
    const sessions: StubSession[] = [];
    let rejectFirstUnsubscribe = true;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        const session = new StubSession(candidate, signalLabCapabilities([]));
        sessions.push(session);
        if (sessions.length === 1) {
          session.onUnsubscribe = () => {
            if (rejectFirstUnsubscribe) throw new Error('event listener lease is still retained');
          };
        }
        return session;
      },
    );
    // This hook intentionally succeeds without touching the admitted
    // session's event lease. It must not be able to clear that lease barrier.
    driver.onPendingConnectionCleanup = async () => undefined;
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    const firstDisconnect = manager.disconnect();
    expect(manager.disconnect()).toBe(firstDisconnect);
    await expect(firstDisconnect).rejects.toMatchObject({ code: 'driver-contract' });
    expect(sessions[0]!.disconnectCalls).toBe(1);
    expect(sessions[0]!.unsubscribeCalls).toBe(1);
    expect(manager.snapshot()).toBeUndefined();
    expect(manager.pendingConnectionCleanup()).toEqual({
      driverId: 'signal-lab', phase: 'rejected-session',
    });
    expect(driver.pendingConnectionCleanupCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual(['discovery', 'connected', 'disconnected']);

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'session-active' });
    expect(driver.connectCalls).toHaveLength(1);
    expect(driver.pendingConnectionCleanupCalls).toBe(0);

    rejectFirstUnsubscribe = false;
    const retry = manager.disconnect();
    expect(manager.disconnect()).toBe(retry);
    await expect(retry).resolves.toBeUndefined();
    expect(sessions[0]!.disconnectCalls).toBe(1);
    expect(sessions[0]!.unsubscribeCalls).toBe(2);
    expect(driver.pendingConnectionCleanupCalls).toBe(1);
    expect(manager.pendingConnectionCleanup()).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(['discovery', 'connected', 'disconnected']);

    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    expect(driver.connectCalls).toHaveLength(2);
    await manager.disconnect();
  });

  it('rejects unsupported configurations and measurements with false lifecycle bindings', async () => {
    const measurements: InstrumentMeasurement[] = [];
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onAcquire = async () => measurements.shift()!;
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    await expect(manager.configure({ ...sweepConfiguration(), stopHz: 2_000_000 })).rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(session!.configureCalls).toHaveLength(0);
    const configuration = await manager.configure(sweepConfiguration());
    measurements.push(sweptMeasurement(session!, 'configuration:forged', 1));
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
    await manager.disconnect();
    await manager.connect(candidate);
    const admitted = await manager.configure(sweepConfiguration());
    measurements.push(sweptMeasurement(session!, admitted.configurationRevision, 1));
    await expect(manager.acquire()).resolves.toMatchObject({ sequence: 1 });
    measurements.push(sweptMeasurement(session!, admitted.configurationRevision, 1));
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
  });

  it('publishes and binds fresh receive-only safety state across configuration and acquisition', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities(), true);
        session.onConfigure = async () => { session.advanceSafety('analyzer-configuration'); };
        session.onAcquire = async () => {
          const configuration = session.configureCalls.at(-1)!;
          const receipt = session.advanceSafety('pre-acquisition');
          return {
            ...sweptMeasurement(session, configuration.configurationRevision, 1),
            receiveOnlySafetyReceipt: receipt,
          };
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const connected = await manager.connect((await manager.discover()).candidates[0]!);

    expect(connected).toMatchObject({
      rfOutput: 'not-supported',
      receiveOnlySafety: {
        connectionReceipt: { reason: 'connection-first-command', sequence: 1 },
        currentReceipt: { reason: 'analyzer-configuration', sequence: 2 },
      },
    });
    await manager.configure(sweepConfiguration());
    expect(manager.snapshot()?.receiveOnlySafety?.currentReceipt).toMatchObject({
      reason: 'analyzer-configuration', sequence: 3,
    });
    const measurement = await manager.acquire();
    expect(measurement.receiveOnlySafetyReceipt).toMatchObject({ reason: 'pre-acquisition', sequence: 4 });
    expect(manager.snapshot()?.receiveOnlySafety?.currentReceipt).toEqual(measurement.receiveOnlySafetyReceipt);
    const safetyEvents = events.filter((event) => event.type === 'session-state'
      && event.reason === 'receive-only-safety-advanced');
    expect(safetyEvents).toHaveLength(2);
    expect(safetyEvents.at(-1)).toMatchObject({
      session: { receiveOnlySafety: { currentReceipt: measurement.receiveOnlySafetyReceipt } },
    });
  });

  it.each(['stale', 'wrong-current', 'rewritten-connection'] as const)(
    'faults receive-only acquisition with %s receipt evidence',
    async (failure) => {
      let session: StubSession;
      const driver = new StubDriver(
        'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
        async (candidate) => {
          session = new StubSession(candidate, analyzerCapabilities(), true);
          session.onConfigure = async () => { session.advanceSafety('analyzer-configuration'); };
          session.onAcquire = async () => {
            const configuration = session.configureCalls.at(-1)!;
            const previous = session.receiveOnlySafety!.currentReceipt;
            const current = failure === 'stale' ? previous : session.advanceSafety('pre-acquisition');
            if (failure === 'rewritten-connection') session.rewriteConnectionSafetyReceipt();
            const receipt = failure === 'wrong-current'
              ? { ...current, receiptId: '90000000-0000-4000-8000-000000000999' }
              : current;
            return {
              ...sweptMeasurement(session, configuration.configurationRevision, 1),
              receiveOnlySafetyReceipt: receipt,
            };
          };
          return session;
        },
      );
      const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
      await manager.connect((await manager.discover()).candidates[0]!);
      await manager.configure(sweepConfiguration());

      await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
      expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract', recoverable: false } });
    },
  );

  it('rejects a fabricated safety receipt from a session with no admitted receive-only state', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities(), 'uuid-only');
        session.onAcquire = async () => {
          const configuration = session.configureCalls.at(-1)!;
          return {
            ...sweptMeasurement(session, configuration.configurationRevision, 1),
            receiveOnlySafetyReceipt: safetyReceipt(
              '70000000-0000-4000-8000-000000000001',
              3,
              'pre-acquisition',
            ),
          };
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(sweepConfiguration());

    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
  });

  it('rejects receiver/synthetic control-model substitution before driver dispatch', async () => {
    let physicalSession: StubSession;
    const physical = new InstrumentManager(new InstrumentDriverRegistry([new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (physicalSession = new StubSession(candidate, analyzerCapabilities())),
    )]), deterministicRuntime());
    await physical.connect((await physical.discover()).candidates[0]!);
    await expect(physical.configure({
      ...sweepConfiguration(),
      controls: { ...receiverSpectrumControls(), trigger: { mode: 'normal', levelDbm: 31 } },
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(physical.configure({
      ...sweepConfiguration(),
      controls: { ...receiverSpectrumControls(), resolutionBandwidthKhz: 0.25 },
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(physical.configure({
      ...sweepConfiguration(),
      sweepTimeSeconds: 0.003_000_1,
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(physical.configure(syntheticSweepConfiguration()))
      .rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(physicalSession!.configureCalls).toHaveLength(0);

    let syntheticSession: StubSession;
    const synthetic = new InstrumentManager(new InstrumentDriverRegistry([new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (syntheticSession = new StubSession(candidate, signalLabCapabilities([]))),
    )]), deterministicRuntime());
    await synthetic.connect((await synthetic.discover()).candidates[0]!);
    await expect(synthetic.configure(sweepConfiguration()))
      .rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(syntheticSession!.configureCalls).toHaveLength(0);
  });

  it('isolates admitted configuration state from a driver mutating its dispatched clone', async () => {
    let session: StubSession;
    const manager = new InstrumentManager(new InstrumentDriverRegistry([new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onConfigure = async (command) => {
          if (command.configuration.kind !== 'swept-spectrum') throw new Error('Expected spectrum fixture');
          command.configuration.stopHz = 2_000_000;
          command.configuration.controls = syntheticScalarControls();
        };
        return session;
      },
    )]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);

    const requested = sweepConfiguration();
    const state = await manager.configure(requested);

    expect(session!.configureCalls[0]?.configuration).toMatchObject({
      stopHz: 2_000_000,
      controls: { model: 'synthetic-scalar' },
    });
    expect(state.configuration).toEqual(requested);
    expect(manager.snapshot()?.configuration?.configuration).toEqual(requested);
    expect(events.filter((event) => event.type === 'configured')).toEqual([
      { type: 'configured', configuration: state },
    ]);
    expect(Object.isFrozen(state.configuration)).toBe(true);
    expect(() => {
      if (state.configuration.kind !== 'swept-spectrum') throw new Error('Expected spectrum fixture');
      state.configuration.stopHz = 900_000;
    }).toThrow();
    expect(manager.snapshot()?.configuration?.configuration).toEqual(requested);
  });

  it('rejects an oversized future-SDR scalar return without publishing or retaining its vectors', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'neptune-sdr', ['serial-port'], async () => [{ ...serialDescriptor(), driverId: 'neptune-sdr' }],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(sweepConfiguration());
    let oversizedElementReads = 0;
    const frequencyHz = new Proxy(new Array<number>(MAX_SWEPT_SPECTRUM_POINTS_V1 + 1), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) oversizedElementReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    session!.onAcquire = async () => ({
      ...sweptMeasurement(session!, configuration.configurationRevision, 1),
      measurementId: 'measurement:oversized-neptune',
      frequencyHz,
      powerDbm: [-90, -90],
    });

    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });

    expect(events.some((event) => event.type === 'measurement')).toBe(false);
    expect(oversizedElementReads).toBe(0);
    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract', recoverable: false } });
    expect(JSON.stringify(manager.snapshot())).not.toContain('measurement:oversized-neptune');
    await manager.disconnect();
  });

  it('admits complex I/Q only as one capability-bounded complete buffer', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'neptune-sdr', ['serial-port'], async () => [{ ...serialDescriptor(), driverId: 'neptune-sdr' }],
      async (candidate) => (session = new StubSession(candidate, complexIqCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    const requested = {
      kind: 'complex-iq' as const,
      centerHz: 2_450_000_000,
      sampleRateHz: 1_000_000,
      bandwidthHz: 800_000,
      sampleCount: 4,
      sampleFormat: 'cf32le' as const,
    };
    await expect(manager.configure({ ...requested, sampleCount: 5 }))
      .rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(session!.configureCalls).toHaveLength(0);

    const configuration = await manager.configure(requested);
    session!.onAcquire = async () => complexIqMeasurement(session!, configuration.configurationRevision, 3);
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });

    await manager.disconnect();
    await manager.connect(candidate);
    const admitted = await manager.configure(requested);
    session!.onAcquire = async () => complexIqMeasurement(session!, admitted.configurationRevision, 4);
    await expect(manager.acquire()).resolves.toMatchObject({
      kind: 'complex-iq', sampleCount: 4, samples: expect.any(Uint8Array), complete: true,
    });
  });

  it('preserves SignalLab analytic complex-baseband qualification without weakening scalar provenance', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, signalLabIqCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    const requested = {
      kind: 'complex-iq' as const,
      centerHz: 100_000_000,
      sampleRateHz: 2_000_000,
      bandwidthHz: 50_000,
      sampleCount: 4,
      sampleFormat: 'cf32le' as const,
    };
    const admitted = await manager.configure(requested);
    const measurement = (): Extract<InstrumentMeasurement, { kind: 'complex-iq' }> => ({
      schemaVersion: 1,
      measurementId: 'measurement:signal-lab:iq',
      sessionId: session!.sessionId,
      configurationRevision: admitted.configurationRevision,
      producerConfigurationEpoch: 'producer-epoch:1',
      sequence: 1,
      capturedAt: CAPTURED_AT,
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: 'analytic-complex-baseband',
      complete: true,
      ...requested,
      profileReferenceCenterHz: 100_000_000,
      rfReferenceCenterHz: 100_000_000,
      nativeCarrierOffsetHz: 0,
      rfPlacement: 'profile-reference',
      outputCarrierOffsetHz: 0,
      rfTuneCenterHz: 100_000_000,
      signalBandwidthHz: 1,
      nativeSampleRateHz: requested.sampleRateHz,
      payloadKind: 'generated-at-output-rate',
      canonicalArtifactSha256: null,
      transformReceipt: {
        receiptVersion: 1,
        sourceArtifactSha256: null,
        sourceStartSample: 0,
        sourceSampleCount: requested.sampleCount,
        sourceBoundaryPolicy: 'continuous-session-origin-zero-extended',
        sourcePeriodSamples: null,
        outputStartSourceSampleNumerator: '0',
        outputStartSourceSampleDenominator: '1',
        sourceSampleRateHz: requested.sampleRateHz,
        outputSampleRateHz: requested.sampleRateHz,
        sourceCarrierOffsetHz: 0,
        outputCarrierOffsetHz: 0,
        outputSampleCount: requested.sampleCount,
        sourceSamplesSha256: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
        outputSamplesSha256: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
        operations: [],
      },
      representation: 'normalized-complex-envelope',
      normalization: 'unit-peak',
      receiverImpairment: 'clean',
      channelApplication: 'not-applied',
      samples: new Uint8Array(32),
    });
    session!.onAcquire = async () => measurement();
    await expect(manager.acquire()).resolves.toMatchObject({
      kind: 'complex-iq', qualification: 'analytic-complex-baseband',
    });

    const tampered = await manager.configure(requested);
    const tamperedSamples = new Uint8Array(32);
    tamperedSamples[0] = 1;
    session!.onAcquire = async () => ({
      ...measurement(),
      configurationRevision: tampered.configurationRevision,
      measurementId: 'measurement:signal-lab:iq:tampered-output',
      samples: tamperedSamples,
    });
    await expect(manager.acquire()).rejects.toMatchObject({
      code: 'driver-contract',
      message: expect.stringMatching(/output hash does not match the received sample bytes/i),
    });

    await manager.disconnect();
    await manager.connect(candidate);
    const next = await manager.configure(requested);
    session!.onAcquire = async () => ({
      ...measurement(),
      configurationRevision: next.configurationRevision,
      measurementId: 'measurement:signal-lab:iq:wrong-qualification',
      qualification: 'standards-derived-complex-baseband',
    });
    await expect(manager.acquire()).rejects.toMatchObject({
      code: 'driver-contract', message: expect.stringMatching(/qualification does not match/i),
    });
  });

  it('requires standards-derived complex-baseband qualification for standards-derived SignalLab profiles', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, signalLabIqCapabilities('lte-etm1.1'))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    const requested = {
      kind: 'complex-iq' as const,
      centerHz: 1_842_500_000,
      sampleRateHz: 10_000_000,
      bandwidthHz: 10_000_000,
      sampleCount: 4,
      sampleFormat: 'cf32le' as const,
    };
    let admitted = await manager.configure(requested);
    const measurement = (qualification: 'analytic-complex-baseband' | 'standards-derived-complex-baseband') => ({
      schemaVersion: 1 as const,
      measurementId: `measurement:signal-lab:iq:${qualification}`,
      sessionId: session!.sessionId,
      configurationRevision: admitted.configurationRevision,
      producerConfigurationEpoch: 'producer-epoch:1',
      sequence: 1,
      capturedAt: CAPTURED_AT,
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification,
      complete: true as const,
      ...requested,
      profileReferenceCenterHz: 1_842_500_000,
      rfReferenceCenterHz: 1_842_500_000,
      nativeCarrierOffsetHz: 0,
      rfPlacement: 'profile-reference' as const,
      outputCarrierOffsetHz: 0,
      rfTuneCenterHz: 1_842_500_000,
      signalBandwidthHz: 9_000_000,
      nativeSampleRateHz: requested.sampleRateHz,
      payloadKind: 'generated-at-output-rate' as const,
      canonicalArtifactSha256: null,
      transformReceipt: {
        receiptVersion: 1 as const,
        sourceArtifactSha256: null,
        sourceStartSample: 0,
        sourceSampleCount: requested.sampleCount,
        sourceBoundaryPolicy: 'continuous-session-origin-zero-extended' as const,
        sourcePeriodSamples: null,
        outputStartSourceSampleNumerator: '0',
        outputStartSourceSampleDenominator: '1',
        sourceSampleRateHz: requested.sampleRateHz,
        outputSampleRateHz: requested.sampleRateHz,
        sourceCarrierOffsetHz: 0,
        outputCarrierOffsetHz: 0,
        outputSampleCount: requested.sampleCount,
        sourceSamplesSha256: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
        outputSamplesSha256: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
        operations: [],
      },
      representation: 'normalized-complex-envelope' as const,
      normalization: 'unit-peak' as const,
      receiverImpairment: 'clean' as const,
      channelApplication: 'not-applied' as const,
      samples: new Uint8Array(32),
    });
    session!.onAcquire = async () => measurement('standards-derived-complex-baseband');
    await expect(manager.acquire()).resolves.toMatchObject({
      kind: 'complex-iq', qualification: 'standards-derived-complex-baseband',
    });

    admitted = await manager.configure(requested);
    session!.onAcquire = async () => measurement('analytic-complex-baseband');
    await expect(manager.acquire()).rejects.toMatchObject({
      code: 'driver-contract', message: expect.stringMatching(/qualification does not match/i),
    });
  });

  // Capture bandwidth is a symmetric passband about the RF tune center, so an
  // output carrier left at a nonzero offset costs `2 * |offset|` of it on top of
  // the signal bandwidth. A driver that reports an offset carrier inside a
  // capture too narrow to hold that span is describing impossible geometry, and
  // below the native span it must have translated the carrier to DC instead.
  it('rejects an offset SignalLab carrier that cannot fit inside the reported symmetric capture', async () => {
    const OFFSET_HZ = -31_000_000;
    const SIGNAL_BANDWIDTH_HZ = 1_000_000;
    const NATIVE_MINIMUM_CAPTURE_BANDWIDTH_HZ = 2 * Math.abs(OFFSET_HZ) + SIGNAL_BANDWIDTH_HZ;
    const PROFILE_REFERENCE_CENTER_HZ = 2_410_000_000;
    const ZERO_32_SHA256 = '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925';
    let session: StubSession;
    const capabilities = signalLabCapabilities([{
      kind: 'signal-lab-profile-selection',
      profiles: [{
        ...signalLabFixtureProfile('offset-artifact', PROFILE_REFERENCE_CENTER_HZ, 4_000_000),
        family: 'nr',
        qualification: 'standards-derived',
        occupiedBandwidthHz: SIGNAL_BANDWIDTH_HZ,
        source: {
          organization: '3GPP',
          references: [{
            specification: '3GPP TS 38.141-1',
            clause: '4.9.2',
            revision: 'Release 18',
            url: 'https://www.3gpp.org/dynareport/38141-1.htm',
          }],
        },
        governance: signalLabFixtureGovernance('offset-artifact', '3GPP'),
      }],
      selectedProfileId: 'offset-artifact',
      iqProfiles: [{
        profileId: 'offset-artifact',
        nativeSampleRateHz: 80_000_000,
        signalBandwidthHz: SIGNAL_BANDWIDTH_HZ,
        profileReferenceCenterHz: PROFILE_REFERENCE_CENTER_HZ,
        nativeCarrierOffsetHz: OFFSET_HZ,
        nativeMinimumCaptureBandwidthHz: NATIVE_MINIMUM_CAPTURE_BANDWIDTH_HZ,
        replay: 'cyclic',
        nativePeriodSamples: 80_000,
        derivedTransportSupported: true,
      }],
    }]);
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, capabilities)),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    const requested = (bandwidthHz: number) => ({
      kind: 'complex-iq' as const,
      centerHz: PROFILE_REFERENCE_CENTER_HZ,
      sampleRateHz: 80_000_000,
      bandwidthHz,
      sampleCount: 4,
      sampleFormat: 'cf32le' as const,
    });
    const offsetMeasurement = (
      configurationRevision: string,
      bandwidthHz: number,
    ) => ({
      schemaVersion: 1 as const,
      measurementId: `measurement:signal-lab:iq:offset:${bandwidthHz}`,
      sessionId: session!.sessionId,
      configurationRevision,
      producerConfigurationEpoch: 'producer-epoch:1',
      sequence: 1,
      capturedAt: CAPTURED_AT,
      elapsedMilliseconds: 1,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: 'standards-derived-complex-baseband' as const,
      complete: true as const,
      ...requested(bandwidthHz),
      profileReferenceCenterHz: PROFILE_REFERENCE_CENTER_HZ,
      rfReferenceCenterHz: PROFILE_REFERENCE_CENTER_HZ - OFFSET_HZ,
      nativeCarrierOffsetHz: OFFSET_HZ,
      rfPlacement: 'profile-reference' as const,
      outputCarrierOffsetHz: OFFSET_HZ,
      rfTuneCenterHz: PROFILE_REFERENCE_CENTER_HZ - OFFSET_HZ,
      signalBandwidthHz: SIGNAL_BANDWIDTH_HZ,
      nativeSampleRateHz: 80_000_000,
      payloadKind: 'native-canonical' as const,
      canonicalArtifactSha256: ZERO_32_SHA256,
      transformReceipt: {
        receiptVersion: 1 as const,
        sourceArtifactSha256: ZERO_32_SHA256,
        sourceStartSample: 0,
        sourceSampleCount: 4,
        sourceBoundaryPolicy: 'cyclic-modular' as const,
        sourcePeriodSamples: 80_000,
        outputStartSourceSampleNumerator: '0',
        outputStartSourceSampleDenominator: '1',
        sourceSampleRateHz: 80_000_000,
        outputSampleRateHz: 80_000_000,
        sourceCarrierOffsetHz: OFFSET_HZ,
        outputCarrierOffsetHz: OFFSET_HZ,
        outputSampleCount: 4,
        sourceSamplesSha256: ZERO_32_SHA256,
        outputSamplesSha256: ZERO_32_SHA256,
        operations: [],
      },
      representation: 'source-preserved-complex-envelope' as const,
      normalization: 'none' as const,
      receiverImpairment: 'clean' as const,
      channelApplication: 'not-applied' as const,
      samples: new Uint8Array(32),
    });

    const narrow = await manager.configure(requested(SIGNAL_BANDWIDTH_HZ));
    session!.onAcquire = async () =>
      offsetMeasurement(narrow.configurationRevision, SIGNAL_BANDWIDTH_HZ);
    await expect(manager.acquire()).rejects.toMatchObject({
      code: 'driver-contract',
      message: expect.stringMatching(/cannot symmetrically contain a -31000000 Hz carrier offset/i),
    });

    await manager.disconnect();
    await manager.connect(candidate);
    const wide = await manager.configure(requested(NATIVE_MINIMUM_CAPTURE_BANDWIDTH_HZ));
    session!.onAcquire = async () =>
      offsetMeasurement(wide.configurationRevision, NATIVE_MINIMUM_CAPTURE_BANDWIDTH_HZ);
    await expect(manager.acquire()).resolves.toMatchObject({
      kind: 'complex-iq',
      bandwidthHz: NATIVE_MINIMUM_CAPTURE_BANDWIDTH_HZ,
      outputCarrierOffsetHz: OFFSET_HZ,
      payloadKind: 'native-canonical',
    });
  });

  it('accepts truthful half-open sweep grids and rejects incomplete or out-of-range geometry', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    let configuration = await manager.configure(sweepConfiguration());
    session!.onAcquire = async () => ({
      ...sweptMeasurement(session!, configuration.configurationRevision, 1),
      frequencyHz: [100, 166, 233],
    });
    await expect(manager.acquire()).resolves.toMatchObject({ frequencyHz: [100, 166, 233] });

    for (const frequencyHz of [[100, 150, 200], [90, 190, 290]]) {
      configuration = await manager.configure(sweepConfiguration());
      session!.onAcquire = async () => ({
        ...sweptMeasurement(session!, configuration.configurationRevision, 1),
        frequencyHz,
      });
      await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
      await manager.disconnect();
      await manager.connect(candidate);
    }
  });

  it('rejects a SignalLab measurement from a stale producer epoch', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, signalLabCapabilities([]))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(syntheticSweepConfiguration());
    session!.onAcquire = async () => ({
      ...sweptMeasurement(session!, configuration.configurationRevision, 1),
      producerConfigurationEpoch: 'producer-epoch:stale',
    });

    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
  });

  it('rejects detected-power timing outside the driver-advertised interval before configuration', async () => {
    let session: StubSession;
    const capabilities: InstrumentCapabilities = {
      schemaVersion: 1,
      acquisitions: [{
        kind: 'detected-power-timeseries', centerFrequencyHz: { min: 1, max: 1_000_000_000 },
        sampleCount: { min: 20, max: 450 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 60 } },
        controls: receiverDetectedPowerCapability(),
        powerUnit: 'dBm', timing: 'uniform',
      }],
      features: [],
    };
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, capabilities)),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.configure({
      kind: 'detected-power-timeseries', centerHz: 100_000_000, sampleCount: 20,
      sweepTimeSeconds: 0.002_98, controls: receiverDetectedPowerControls(),
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(session!.configureCalls).toHaveLength(0);

    const configuration = await manager.configure({
      kind: 'detected-power-timeseries', centerHz: 100_000_000, sampleCount: 20,
      sweepTimeSeconds: 0.02, controls: receiverDetectedPowerControls(),
    });
    session!.onAcquire = async () => detectedMeasurement(session!, configuration.configurationRevision, 0.001_1, 'wall-clock-derived');
    await expect(manager.acquire()).resolves.toMatchObject({ sampleIntervalSeconds: 0.001_1 });

    const exact = await manager.configure(configuration.configuration);
    session!.onAcquire = async () => detectedMeasurement(session!, exact.configurationRevision, 0.001, 'simulation-exact');
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract', message: expect.stringMatching(/falsely claimed simulation-exact/) });
  });

  it('requires synthetic detected-power measurements to preserve simulation-exact qualification', async () => {
    for (const timingQualification of ['wall-clock-derived', 'measured-calibrated'] as const) {
      let session: StubSession;
      const manager = new InstrumentManager(new InstrumentDriverRegistry([new StubDriver(
        'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
        async (candidate) => (session = new StubSession(candidate, signalLabCapabilities([
          {
            kind: 'signal-lab-profile-selection',
            profiles: [{
              profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 1_000_000,
            }],
            selectedProfileId: 'cw',
          },
        ]))),
      )]), deterministicRuntime());
      await manager.connect((await manager.discover()).candidates[0]!);
      const configuration = await manager.configure(syntheticDetectedPowerConfiguration(100_000_000, 20));
      session!.onAcquire = async () => detectedMeasurement(
        session!, configuration.configurationRevision, 0.05 / 20, timingQualification,
      );
      await expect(manager.acquire()).rejects.toMatchObject({
        code: 'driver-contract', message: expect.stringMatching(/simulation-exact timing qualification/),
      });
    }
  });

  it('forwards only session-bound, configuration-bound, monotonic events', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const received: InstrumentManagerEvent[] = [];
    manager.subscribe(() => { throw new Error('consumer failure must be isolated'); });
    manager.subscribe((event) => received.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(sweepConfiguration());
    received.length = 0;

    session!.emit({ type: 'status', sessionId: session!.sessionId, status: 'ready' });
    session!.onAcquire = async () => {
      const measurement = sweptMeasurement(session!, configuration.configurationRevision, 1);
      session!.emit({ type: 'measurement', measurement });
      return measurement;
    };
    await manager.acquire();
    session!.emitUnsafe({ type: 'status', sessionId: 'session:forged', status: 'ready' });

    expect(received.slice(0, 2).map((event) => event.type)).toEqual(['status', 'measurement']);
    expect(received.slice(2).map((event) => event.type)).toEqual(['status', 'error', 'session-state']);
    expect(received[3]).toMatchObject({ type: 'error', error: { code: 'driver-contract' } });
    await manager.disconnect();
    const count = received.length;
    session!.emit({ type: 'status', sessionId: session!.sessionId, status: 'busy' });
    expect(received).toHaveLength(count);
  });

  it('reasserts RF-off immediately before every physical acquisition', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(sweepConfiguration());
    session!.featureCalls.length = 0;

    await manager.acquire();
    expect(session!.featureCalls).toEqual([
      expect.objectContaining({ kind: 'rf-generator', action: 'set-output', enabled: false }),
    ]);
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'off', rfOutputQualification: 'command-acknowledged' });
  });

  it('does not acquire or restore RF certainty after a terminal event during output-off reassertion', async () => {
    let session: StubSession;
    let acquireCalled = false;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        const normal = session.onFeature;
        let outputOffCalls = 0;
        session.onFeature = async (command) => {
          if (command.kind === 'rf-generator' && command.action === 'set-output' && !command.enabled
            && ++outputOffCalls === 2) {
            session.emit({ type: 'status', sessionId: session.sessionId, status: 'faulted', message: 'transport failed during RF-off reassertion' });
          }
          return normal(command);
        };
        session.onAcquire = async () => {
          acquireCalled = true;
          return sweptMeasurement(session, 'configuration:should-not-run', 1);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(sweepConfiguration());

    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-failure' });
    expect(acquireCalled).toBe(false);
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown', rfOutputQualification: 'unverified', fault: { recoverable: false },
    });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await manager.disconnect();
  });

  it('faults before publishing when a driver event disagrees with its acquisition return', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(sweepConfiguration());
    events.length = 0;
    session!.onAcquire = async () => {
      const returned = sweptMeasurement(session!, configuration.configurationRevision, 1);
      session!.emit({
        type: 'measurement',
        measurement: sweptMeasurement(session!, configuration.configurationRevision, 2),
      });
      return returned;
    };

    await expect(manager.acquire()).rejects.toMatchObject({
      code: 'driver-contract',
      message: 'Driver measurement event and acquisition return disagree',
    });
    expect(events.some((event) => event.type === 'measurement')).toBe(false);
    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract' } });
  });

  it('reconciles one late I/Q event by sequence without retaining or republishing the payload', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, complexIqCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(iqConfiguration());
    const returned = complexIqMeasurement(session!, configuration.configurationRevision, 4);
    returned.samples[0] = 17;
    session!.onAcquire = async () => returned;

    await expect(manager.acquire()).resolves.toEqual(returned);
    const publishedBeforeLateEvent = events.filter((event) => event.type === 'measurement').length;
    session!.emit({
      type: 'measurement',
      measurement: { ...returned, samples: returned.samples.slice() },
    });

    expect(manager.snapshot()?.fault).toBeUndefined();
    expect(events.filter((event) => event.type === 'measurement')).toHaveLength(publishedBeforeLateEvent);
  });

  it('terminal-faults a repeated late measurement event', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, complexIqCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(iqConfiguration());
    const returned = complexIqMeasurement(session!, configuration.configurationRevision, 4);
    session!.onAcquire = async () => returned;
    await manager.acquire();

    session!.emit({ type: 'measurement', measurement: { ...returned, samples: returned.samples.slice() } });
    expect(manager.snapshot()?.fault).toBeUndefined();
    session!.emit({ type: 'measurement', measurement: { ...returned, samples: returned.samples.slice() } });

    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract', recoverable: false } });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
  });

  it('terminal-faults a late measurement event whose sequence was never returned', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, complexIqCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    const configuration = await manager.configure(iqConfiguration());
    const returned = complexIqMeasurement(session!, configuration.configurationRevision, 4);
    session!.onAcquire = async () => returned;
    await manager.acquire();

    session!.emit({ type: 'measurement', measurement: { ...returned, sequence: 9, samples: returned.samples.slice() } });

    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract', recoverable: false } });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
  });

  it('enforces source-specific nullable RBW and attenuation before manager publication', async () => {
    let physicalSession: StubSession;
    const physical = new InstrumentManager(new InstrumentDriverRegistry([new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (physicalSession = new StubSession(candidate, analyzerCapabilities())),
    )]), deterministicRuntime());
    await physical.connect((await physical.discover()).candidates[0]!);
    const physicalConfiguration = await physical.configure(sweepConfiguration());
    physicalSession!.onAcquire = async () => ({
      ...sweptMeasurement(physicalSession!, physicalConfiguration.configurationRevision, 1),
      resolutionBandwidthHz: null,
    });
    await expect(physical.acquire()).rejects.toMatchObject({ code: 'driver-contract' });

    let signalSession: StubSession;
    const signal = new InstrumentManager(new InstrumentDriverRegistry([new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (signalSession = new StubSession(candidate, signalLabCapabilities([]))),
    )]), deterministicRuntime());
    await signal.connect((await signal.discover()).candidates[0]!);
    const signalConfiguration = await signal.configure(syntheticSweepConfiguration());
    signalSession!.onAcquire = async () => ({
      ...sweptMeasurement(signalSession!, signalConfiguration.configurationRevision, 1),
      resolutionBandwidthHz: 10,
      attenuationDb: 0,
    });
    await expect(signal.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
  });
});

describe('InstrumentManager feature boundary', () => {
  it('executes every advertised hardware feature and forces acknowledged RF-off before disconnect', async () => {
    let session: StubSession;
    const features: InstrumentFeatureCapability[] = [
      generatorCapability(),
      { kind: 'screen', width: 2, height: 1, pixelFormat: 'rgb565le' },
      { kind: 'touch', width: 480, height: 320 },
      { kind: 'diagnostics', reports: ['identity', 'health'] },
    ];
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities(features))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'normal', modulation: { mode: 'am', modulationFrequencyHz: 1_000, depthPercent: 50 },
    })).resolves.toMatchObject({ kind: 'rf-generator', action: 'configure' });
    await expect(manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'mixer', modulation: { mode: 'off' },
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'normal', modulation: { mode: 'fm', modulationFrequencyHz: 3_501, deviationHz: 25_000 },
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: true }))
      .resolves.toMatchObject({ enabled: true });
    await expect(manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: false }))
      .resolves.toMatchObject({ enabled: false });
    await expect(manager.executeFeature({ kind: 'screen', action: 'capture' }))
      .resolves.toMatchObject({ frame: { width: 2, height: 1, pixelFormat: 'rgb565le' } });
    await expect(manager.executeFeature({ kind: 'diagnostics', action: 'read', report: 'identity' }))
      .resolves.toMatchObject({ lines: ['fixture diagnostic'] });
    await expect(manager.executeFeature({ kind: 'touch', action: 'tap', x: 480, y: 0 }))
      .rejects.toMatchObject({ code: 'unsupported-capability' });
    await expect(manager.executeFeature({ kind: 'touch', action: 'tap', x: 479, y: 319 }))
      .resolves.toMatchObject({ accepted: true });
    await expect(manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: false }))
      .resolves.toMatchObject({ enabled: false });

    await manager.disconnect();
    expect(session!.featureCalls.at(-1)).toMatchObject({ kind: 'rf-generator', action: 'set-output', enabled: false });
    expect(session!.disconnectCalls).toBe(1);
    expect(events.filter((event) => event.type === 'feature-result')).toHaveLength(8);
  });

  it('does not treat generator configuration as RF-off evidence without a separate output acknowledgement', async () => {
    let session: StubSession;
    let rejectOff = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        const normal = session.onFeature;
        session.onFeature = async (command) => {
          if (rejectOff
            && command.kind === 'rf-generator'
            && command.action === 'set-output'
            && !command.enabled) {
            throw new Error('generator configure completed but output-off was not acknowledged');
          }
          return normal(command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'normal', modulation: { mode: 'off' },
    })).rejects.toMatchObject({ code: 'driver-failure' });
    expect(session!.featureCalls).toEqual([
      expect.objectContaining({ kind: 'rf-generator', action: 'configure' }),
      expect.objectContaining({ kind: 'rf-generator', action: 'set-output', enabled: false }),
    ]);
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown', rfOutputQualification: 'unverified', fault: { code: 'driver-failure' },
    });

    rejectOff = false;
    await manager.disconnect();
  });

  it('retains the active session when RF-off cannot be proven', async () => {
    let rejectOff = true;
    let session: StubSession;
    const features: InstrumentFeatureCapability[] = [
      generatorCapability(),
    ];
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities(features));
        const normal = session.onFeature;
        session.onFeature = async (command) => {
          if (rejectOff && command.kind === 'rf-generator' && command.action === 'set-output' && !command.enabled) {
            throw new Error('RF output-off acknowledgement lost');
          }
          return normal(command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.disconnect()).rejects.toMatchObject({ code: 'driver-failure' });
    expect(manager.snapshot()).toBeDefined();
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown', rfOutputQualification: 'unverified',
      fault: { code: 'driver-failure', recoverable: false },
    });
    expect(session!.disconnectCalls).toBe(0);
    rejectOff = false;
    await manager.disconnect();
    expect(session!.disconnectCalls).toBe(1);
  });

  it('terminal-faults uncertain RF enable and permits only acknowledged off before disconnect', async () => {
    let rejectEnable = true;
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        const normal = session.onFeature;
        session.onFeature = async (command) => {
          if (rejectEnable && command.kind === 'rf-generator' && command.action === 'set-output' && command.enabled) {
            throw new Error('enable acknowledgement lost after dispatch');
          }
          return normal(command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: true }))
      .rejects.toMatchObject({ code: 'driver-failure' });
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'unknown', fault: { recoverable: false } });
    await expect(manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'normal', modulation: { mode: 'off' },
    })).rejects.toMatchObject({ code: 'driver-failure' });

    rejectEnable = false;
    await expect(manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: false }))
      .resolves.toMatchObject({ enabled: false });
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'off', rfOutputQualification: 'command-acknowledged', fault: { recoverable: false },
    });
    await manager.disconnect();
  });

  it('does not publish or commit a feature result after a terminal event during its driver call', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        const normal = session.onFeature;
        session.onFeature = async (command) => {
          if (command.kind === 'rf-generator' && command.action === 'set-output' && command.enabled) {
            session.emit({ type: 'status', sessionId: session.sessionId, status: 'faulted', message: 'transport failed during RF enable' });
          }
          return normal(command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    events.length = 0;

    await expect(manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: true }))
      .rejects.toMatchObject({ code: 'driver-failure' });
    expect(manager.snapshot()).toMatchObject({
      rfOutput: 'unknown', rfOutputQualification: 'unverified', fault: { recoverable: false },
    });
    expect(events.some((event) => event.type === 'feature-result')).toBe(false);
    await manager.disconnect();
  });

  it('deep-compares every RF configuration field and faults on path or modulation drift', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([generatorCapability()]));
        session.onFeature = async (command) => command.kind === 'rf-generator' && command.action === 'configure'
          ? { ...command, path: 'normal', modulation: { mode: 'off' } }
          : defaultFeatureResult(session, command);
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: 100_000_000, levelDbm: -30,
      path: 'normal', modulation: { mode: 'am', modulationFrequencyHz: 1_000, depthPercent: 50 },
    })).rejects.toMatchObject({ code: 'driver-contract' });
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'unknown', fault: { code: 'driver-contract' } });
  });

  it('invalidates acquisition and RF evidence after a firmware touch until receive mode is re-established', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities([
        generatorCapability(), { kind: 'touch', width: 480, height: 320 },
      ]))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(sweepConfiguration());

    await manager.executeFeature({ kind: 'touch', action: 'tap', x: 10, y: 20 });
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'unknown' });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'not-configured' });
    await expect(manager.executeFeature({ kind: 'touch', action: 'tap', x: 11, y: 21 }))
      .rejects.toMatchObject({ code: 'driver-failure' });

    await manager.configure(sweepConfiguration());
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'off', rfOutputQualification: 'command-acknowledged' });
  });

  it('selects only an advertised profile on a SignalLab candidate', async () => {
    let session: StubSession;
    const features: SignalLabFeatureInput[] = [
      {
        kind: 'signal-lab-profile-selection',
        profiles: [
          { profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 },
          { profileId: 'fm', centerFrequencyHz: 101_000_000, recommendedSpanHz: 500_000 },
          { profileId: 'wifi6-he-su', centerFrequencyHz: 2_437_000_000, recommendedSpanHz: 30_000_000 },
        ],
        selectedProfileId: 'cw',
      },
    ];
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, signalLabCapabilities(features))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(syntheticSweepConfiguration());
    events.length = 0;

    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm',
    })).resolves.toMatchObject({ profileId: 'fm' });
    expect(session!.featureCalls[0]).toMatchObject({ sessionId: session!.sessionId, profileId: 'fm' });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    expect(manager.snapshot()?.provenance).toMatchObject({ producerConfigurationEpoch: 'producer-epoch:2' });
    expect(manager.snapshot()?.provenance).not.toHaveProperty('selectedProfileId');
    expect(manager.snapshot()?.capabilities.features).toContainEqual(expect.objectContaining({
      kind: 'signal-lab-profile-selection', selectedProfileId: 'fm',
    }));
    expect(events.map((event) => event.type)).toEqual(['feature-result', 'configuration-invalidated']);
    const invalidation = events[1];
    expect(invalidation?.type === 'configuration-invalidated' ? invalidation.session.capabilities.features : [])
      .toContainEqual(expect.objectContaining({ kind: 'signal-lab-profile-selection', selectedProfileId: 'fm' }));
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'not-configured' });
    await expect(manager.configure({
      ...syntheticDetectedPowerConfiguration(100_000_000, 20),
    })).resolves.toMatchObject({ configuration: { centerHz: 100_000_000 } });
    await expect(manager.configure({
      ...syntheticDetectedPowerConfiguration(101_000_000, 20),
    })).resolves.toMatchObject({ configuration: { centerHz: 101_000_000 } });
    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'not-advertised',
    })).rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(session!.featureCalls).toHaveLength(1);
  });

  it('configures only an advertised SignalLab channel and publishes the new producer state', async () => {
    let session: StubSession;
    const channel = { model: 'awgn' as const, noiseFloorDbm: -110, seed: 1, fadingRateHz: 1, receiverImpairment: 'clean' as const };
    const updatedChannel = { model: 'rayleigh' as const, noiseFloorDbm: -104, seed: 42, fadingRateHz: 3.5, receiverImpairment: 'clean' as const };
    const feature: SignalLabFeatureInput = {
      kind: 'signal-lab-profile-selection',
      profiles: [{ profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }],
      selectedProfileId: 'cw',
      channel,
    };
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, signalLabCapabilities([feature]))),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.configure(syntheticSweepConfiguration());
    events.length = 0;

    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection', action: 'configure-channel', channel: updatedChannel,
    })).resolves.toMatchObject({ action: 'configure-channel', channel: updatedChannel });
    expect(session!.featureCalls[0]).toMatchObject({
      sessionId: session!.sessionId, action: 'configure-channel', channel: updatedChannel,
    });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    expect(manager.snapshot()?.provenance).toMatchObject({ producerConfigurationEpoch: 'producer-epoch:2' });
    expect(manager.snapshot()?.capabilities.features).toContainEqual(expect.objectContaining({
      kind: 'signal-lab-profile-selection', selectedProfileId: 'cw', channel: updatedChannel,
    }));
    expect(events.map((event) => event.type)).toEqual(['feature-result', 'configuration-invalidated']);
    expect(events[1]).toMatchObject({ type: 'configuration-invalidated', reason: 'source-channel-changed' });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('admits refreshed custom-waveform geometry and uses it for the next I/Q configuration', async () => {
    let session: StubSession;
    const customNr = {
      ...signalLabFixtureProfile('custom-nr', 3_500_000_000, 50_000_000),
      family: 'nr' as const,
      model: 'Custom NR FR1 · 40 MHz',
      qualification: 'standards-derived' as const,
      occupiedBandwidthHz: 38_160_000,
      projection: {
        allocation: 'full' as const,
        modulation: 'ofdm-mixed' as const,
        timing: 'tdd-frame' as const,
        duplex: 'tdd' as const,
        subcarrierSpacingHz: 30_000,
        nominalResourceBlocks: 106,
      },
      source: {
        organization: '3GPP' as const,
        references: [{
          specification: '3GPP TS 38.141-1',
          clause: '4.9.2',
          revision: 'Release 18',
          url: 'https://www.3gpp.org/dynareport/38141-1.htm',
        }],
      },
      governance: signalLabFixtureGovernance('custom-nr', '3GPP'),
    };
    const initial = signalLabCapabilities([{
      kind: 'signal-lab-profile-selection',
      profiles: [customNr],
      selectedProfileId: 'custom-nr',
      iqProfiles: [{
        profileId: 'custom-nr',
        nativeSampleRateHz: null,
        signalBandwidthHz: customNr.occupiedBandwidthHz,
        profileReferenceCenterHz: customNr.centerFrequencyHz,
        nativeCarrierOffsetHz: 0,
        nativeMinimumCaptureBandwidthHz: null,
        replay: 'continuous',
        derivedTransportSupported: false,
      }],
    }]);
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, initial);
        session.onFeature = async (command) => {
          const expandedSignalBandwidthHz = 380_160_000;
          // The v2 complex-I/Q ceiling is a fixed 491.52 MHz, wide enough for the
          // largest legal custom NR build (FR2 / 120 kHz SCS / 400 MHz = 264 RB
          // = 380.16 MHz occupied). A custom build therefore republishes only
          // its own descriptor and I/Q transport; acquisitions do not move.
          session.capabilities = {
            ...initial,
            features: initial.features.map((feature) =>
              feature.kind === 'signal-lab-profile-selection'
                ? {
                    ...feature,
                    profiles: feature.profiles.map((profile) =>
                      profile.profileId === 'custom-nr'
                        ? {
                            ...profile,
                            model: 'Custom NR FR2 · 400 MHz',
                            occupiedBandwidthHz: expandedSignalBandwidthHz,
                            recommendedSpanHz: 400_000_000,
                            projection: {
                              ...profile.projection,
                              subcarrierSpacingHz: 120_000,
                              nominalResourceBlocks: 264,
                            },
                          }
                        : profile),
                    iqProfiles: feature.iqProfiles.map((profile) =>
                      profile.profileId === 'custom-nr'
                        ? { ...profile, signalBandwidthHz: expandedSignalBandwidthHz }
                        : profile),
                  }
                : feature),
          };
          return defaultFeatureResult(session, command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const events: InstrumentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);
    events.length = 0;

    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'configure-custom-waveform',
      standard: 'nr',
      selections: {
        frequencyRange: 'FR2',
        operatingBand: 'n257',
        subcarrierSpacingKHz: '120',
        channelBandwidthMHz: '400',
      },
    })).resolves.toMatchObject({ action: 'configure-custom-waveform', standard: 'nr' });

    const refreshed = manager.snapshot()!;
    expect(refreshed.capabilities.acquisitions).toEqual(initial.acquisitions);
    expect(refreshed.capabilities.acquisitions).toContainEqual(expect.objectContaining({
      kind: 'complex-iq',
      sampleRateHz: expect.objectContaining({ max: 491_520_000 }),
      bandwidthHz: expect.objectContaining({ max: 491_520_000 }),
    }));
    expect(refreshed.capabilities.features).toContainEqual(expect.objectContaining({
      kind: 'signal-lab-profile-selection',
      profiles: expect.arrayContaining([
        expect.objectContaining({ profileId: 'custom-nr', occupiedBandwidthHz: 380_160_000 }),
      ]),
      iqProfiles: expect.arrayContaining([
        expect.objectContaining({ profileId: 'custom-nr', signalBandwidthHz: 380_160_000 }),
      ]),
    }));
    expect(events[0]).toMatchObject({
      type: 'feature-result',
      session: {
        capabilities: {
          acquisitions: expect.arrayContaining([
            expect.objectContaining({
              kind: 'complex-iq',
              sampleRateHz: expect.objectContaining({ max: 491_520_000 }),
            }),
          ]),
        },
      },
    });
    await expect(manager.configure({
      kind: 'complex-iq',
      centerHz: 3_500_000_000,
      sampleRateHz: 491_520_000,
      bandwidthHz: 400_000_000,
      sampleCount: 64,
      sampleFormat: 'cf32le',
    })).resolves.toMatchObject({
      configuration: {
        sampleRateHz: 491_520_000,
        bandwidthHz: 400_000_000,
      },
    });
  });

  // A custom build is the one feature call that lets an untrusted driver hand
  // back a whole replacement capability. Everything except the configured
  // `custom-${standard}` descriptor and its matching I/Q transport must survive
  // the transition byte for byte, so each of these drivers tries to smuggle one
  // unrelated change through that door.
  describe('custom-waveform capability smuggling', () => {
    const customNrDescriptor = () => ({
      ...signalLabFixtureProfile('custom-nr', 3_500_000_000, 50_000_000),
      family: 'nr' as const,
      qualification: 'standards-derived' as const,
      occupiedBandwidthHz: 38_160_000,
      source: {
        organization: '3GPP' as const,
        references: [{
          specification: '3GPP TS 38.141-1',
          clause: '4.9.2',
          revision: 'Release 18',
          url: 'https://www.3gpp.org/dynareport/38141-1.htm',
        }],
      },
      governance: signalLabFixtureGovernance('custom-nr', '3GPP'),
    });

    function smugglingCapabilities(): InstrumentCapabilities {
      return signalLabCapabilities([{
        kind: 'signal-lab-profile-selection',
        profiles: [
          customNrDescriptor(),
          signalLabFixtureProfile('cw', 100_000_000, 2_000_000),
        ],
        selectedProfileId: 'cw',
      }]);
    }

    function withSource(
      capabilities: InstrumentCapabilities,
      mutate: (feature: SignalLabFeature) => SignalLabFeature,
    ): InstrumentCapabilities {
      return {
        ...capabilities,
        features: capabilities.features.map((feature) =>
          feature.kind === 'signal-lab-profile-selection' ? mutate(feature) : feature),
      };
    }

    async function admitRefreshed(
      initial: InstrumentCapabilities,
      refreshed: InstrumentCapabilities,
    ): Promise<InstrumentManager> {
      let session: StubSession;
      const driver = new StubDriver(
        'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
        async (candidate) => {
          session = new StubSession(candidate, initial);
          session.onFeature = async (command) => {
            session.capabilities = refreshed;
            return defaultFeatureResult(session, command);
          };
          return session;
        },
      );
      const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
      await manager.connect((await manager.discover()).candidates[0]!);
      return manager;
    }

    const configureCustomNr = (manager: InstrumentManager) => manager.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'configure-custom-waveform',
      standard: 'nr',
      selections: { subcarrierSpacingKHz: '30', channelBandwidthMHz: '40' },
    });

    it.each([
      [
        'widens the complex-I/Q acquisition ceiling',
        (initial: InstrumentCapabilities) => ({
          ...initial,
          acquisitions: initial.acquisitions.map((capability) =>
            capability.kind === 'complex-iq'
              ? { ...capability, sampleRateHz: { ...capability.sampleRateHz, max: 10_000_000_000 } }
              : capability),
        }),
        /changed acquisition capabilities/i,
      ],
      [
        'moves the selected profile',
        (initial: InstrumentCapabilities) =>
          withSource(initial, (feature) => ({ ...feature, selectedProfileId: 'custom-nr' })),
        /changed the selected profile/i,
      ],
      [
        'rewrites channel state',
        (initial: InstrumentCapabilities) => withSource(initial, (feature) => ({
          ...feature,
          channel: { ...feature.channel, receiverImpairment: 'awgn' as const },
        })),
        /changed channel state/i,
      ],
      [
        'rewrites an unrelated descriptor',
        (initial: InstrumentCapabilities) => withSource(initial, (feature) => ({
          ...feature,
          profiles: feature.profiles.map((profile) => profile.profileId === 'cw'
            ? { ...profile, recommendedSpanHz: 40_000_000, disclosure: 'Rewritten by the driver.' }
            : profile),
        })),
        /changed the unrelated cw descriptor/i,
      ],
      [
        'rewrites an unrelated I/Q transport',
        (initial: InstrumentCapabilities) => withSource(initial, (feature) => ({
          ...feature,
          iqProfiles: feature.iqProfiles.map((profile) => profile.profileId === 'cw'
            ? { ...profile, signalBandwidthHz: 20_000_000 }
            : profile),
        })),
        /changed the unrelated cw I\/Q transport/i,
      ],
      [
        'adds a profile to the governed catalog',
        (initial: InstrumentCapabilities) => withSource(initial, (feature) => ({
          ...feature,
          profiles: [...feature.profiles, signalLabFixtureProfile('smuggled', 900_000_000, 1_000_000)],
          iqProfiles: [...feature.iqProfiles, {
            profileId: 'smuggled',
            nativeSampleRateHz: null,
            signalBandwidthHz: 1,
            profileReferenceCenterHz: 900_000_000,
            nativeCarrierOffsetHz: 0,
            nativeMinimumCaptureBandwidthHz: null,
            replay: 'continuous' as const,
            derivedTransportSupported: false,
          }],
        })),
        /changed the size of the governed catalog/i,
      ],
      [
        'reorders the governed catalog',
        (initial: InstrumentCapabilities) => withSource(initial, (feature) => ({
          ...feature,
          profiles: [...feature.profiles].reverse(),
          iqProfiles: [...feature.iqProfiles].reverse(),
        })),
        /reordered or renamed the governed catalog/i,
      ],
      // A SignalLab source binding admits exactly one feature, the
      // profile-selection one, so the driver boundary's own dynamic-capability
      // validator catches feature-set tampering before the custom-waveform
      // admission runs. Both layers must hold, so assert the outcome here too.
      [
        'appends a feature its source kind may not advertise',
        (initial: InstrumentCapabilities) => ({
          ...initial,
          features: [
            ...initial.features,
            { kind: 'diagnostics' as const, reports: ['identity' as const] },
          ],
        }),
        /must advertise exactly one profile-selection feature/i,
      ],
      [
        'drops the SignalLab feature entirely',
        (initial: InstrumentCapabilities) => ({
          ...initial,
          features: initial.features.filter(
            (feature) => feature.kind !== 'signal-lab-profile-selection',
          ),
        }),
        /must advertise exactly one profile-selection feature/i,
      ],
    ])('faults when the refreshed capability %s', async (_label, mutate, expected) => {
      const initial = smugglingCapabilities();
      const manager = await admitRefreshed(initial, mutate(initial));

      await expect(configureCustomNr(manager)).rejects.toMatchObject({
        code: 'driver-contract',
        message: expect.stringMatching(expected),
      });
      expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract' } });
    });

    it('keeps every unrelated entry byte-identical while admitting the rebuilt custom entry', async () => {
      const initial = smugglingCapabilities();
      const refreshed = withSource(initial, (feature) => ({
        ...feature,
        profiles: feature.profiles.map((profile) => profile.profileId === 'custom-nr'
          ? { ...profile, occupiedBandwidthHz: 380_160_000, recommendedSpanHz: 400_000_000 }
          : profile),
        iqProfiles: feature.iqProfiles.map((profile) => profile.profileId === 'custom-nr'
          ? { ...profile, signalBandwidthHz: 380_160_000 }
          : profile),
      }));
      const manager = await admitRefreshed(initial, refreshed);

      await expect(configureCustomNr(manager)).resolves.toMatchObject({
        action: 'configure-custom-waveform',
        standard: 'nr',
      });
      const admitted = manager.snapshot()!.capabilities;
      const initialSource = initial.features.find(
        (feature) => feature.kind === 'signal-lab-profile-selection',
      );
      const admittedSource = admitted.features.find(
        (feature) => feature.kind === 'signal-lab-profile-selection',
      );
      if (initialSource?.kind !== 'signal-lab-profile-selection'
        || admittedSource?.kind !== 'signal-lab-profile-selection') {
        throw new Error('Expected an admitted SignalLab profile-selection capability');
      }
      expect(admitted.acquisitions).toEqual(initial.acquisitions);
      expect(admittedSource.selectedProfileId).toBe('cw');
      expect(admittedSource.channel).toEqual(initialSource.channel);
      expect(admittedSource.profiles.find((profile) => profile.profileId === 'cw'))
        .toEqual(initialSource.profiles.find((profile) => profile.profileId === 'cw'));
      expect(admittedSource.iqProfiles.find((profile) => profile.profileId === 'cw'))
        .toEqual(initialSource.iqProfiles.find((profile) => profile.profileId === 'cw'));
      expect(admittedSource.profiles.map(({ profileId }) => profileId))
        .toEqual(initialSource.profiles.map(({ profileId }) => profileId));
      expect(admittedSource.profiles.find((profile) => profile.profileId === 'custom-nr'))
        .toMatchObject({ occupiedBandwidthHz: 380_160_000, recommendedSpanHz: 400_000_000 });
      expect(admittedSource.iqProfiles.find((profile) => profile.profileId === 'custom-nr'))
        .toMatchObject({ signalBandwidthHz: 380_160_000 });
    });

    it('rejects a custom-waveform standard that is not an advertised profile', async () => {
      const initial = smugglingCapabilities();
      const manager = await admitRefreshed(initial, initial);

      await expect(manager.executeFeature({
        kind: 'signal-lab-profile-selection',
        action: 'configure-custom-waveform',
        standard: 'wifi',
        selections: { standardVariant: 'be', channelBandwidthMHz: '80' },
      })).rejects.toMatchObject({
        code: 'driver-contract',
        message: expect.stringMatching(/custom-wifi, which is not an advertised profile/i),
      });
    });
  });

  it('rejects malformed dynamic capabilities returned after a custom-waveform mutation', async () => {
    let session: StubSession;
    const initial = signalLabCapabilities([{
      kind: 'signal-lab-profile-selection',
      profiles: [{
        ...signalLabFixtureProfile('custom-nr', 3_500_000_000, 50_000_000),
        family: 'nr',
        qualification: 'standards-derived',
        source: {
          organization: '3GPP',
          references: [{
            specification: '3GPP TS 38.141-1',
            clause: '4.9.2',
            revision: 'Release 18',
            url: 'https://www.3gpp.org/dynareport/38141-1.htm',
          }],
        },
        governance: signalLabFixtureGovernance('custom-nr', '3GPP'),
      }],
      selectedProfileId: 'custom-nr',
    }]);
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, initial);
        session.onFeature = async (command) => {
          session.capabilities = {
            ...initial,
            undeclaredDynamicField: true,
          } as unknown as InstrumentCapabilities;
          return defaultFeatureResult(session, command);
        };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'configure-custom-waveform',
      standard: 'nr',
      selections: { subcarrierSpacingKHz: '30', channelBandwidthMHz: '40' },
    })).rejects.toMatchObject({
      code: 'driver-contract',
      message: expect.stringMatching(/invalid dynamic capabilities/i),
    });
    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract' } });
  });

  it('rejects a v2 SignalLab session that omits its explicit channel state', async () => {
    let session: StubSession;
    const complete = signalLabCapabilities([]);
    const invalid = {
      ...complete,
      features: complete.features.map((feature) => {
        if (feature.kind !== 'signal-lab-profile-selection') return feature;
        const { channel: _channel, ...withoutChannel } = feature;
        return withoutChannel;
      }),
    };
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => (session = new StubSession(candidate, invalid as unknown as InstrumentCapabilities)),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await expect(manager.connect((await manager.discover()).candidates[0]!))
      .rejects.toMatchObject({ code: 'driver-contract' });
    expect(session!.disconnectCalls).toBe(1);
  });

  it('faults after uncertain profile mutation, blocks operations, and reconnects cleanly', async () => {
    let session: StubSession;
    let manager: InstrumentManager;
    const profileFeature: SignalLabFeatureInput = {
      kind: 'signal-lab-profile-selection',
      profiles: [
        { profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 },
        { profileId: 'fm', centerFrequencyHz: 101_000_000, recommendedSpanHz: 500_000 },
      ],
      selectedProfileId: 'cw',
    };
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, signalLabCapabilities([profileFeature]));
        session.onFeature = async () => {
          expect(manager.snapshot()?.configuration).toBeUndefined();
          throw new Error('profile response lost after dispatch');
        };
        return session;
      },
    );
    manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    await manager.configure(syntheticSweepConfiguration());

    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm',
    })).rejects.toMatchObject({ code: 'driver-failure' });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await expect(manager.configure(syntheticSweepConfiguration())).rejects.toMatchObject({ code: 'driver-failure' });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-failure' });
    await expect(manager.executeFeature({
      kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'cw',
    })).rejects.toMatchObject({ code: 'driver-failure' });

    await manager.disconnect();
    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    await manager.disconnect();
  });

  it('invalidates and blocks on terminal driver events, then reconnects cleanly', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => (session = new StubSession(candidate, analyzerCapabilities())),
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    await manager.configure(sweepConfiguration());

    session!.emit({ type: 'status', sessionId: session!.sessionId, status: 'faulted', message: 'device vanished' });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await expect(manager.configure(sweepConfiguration())).rejects.toMatchObject({ code: 'driver-failure' });
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-failure' });

    await manager.disconnect();
    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    await manager.configure(sweepConfiguration());
    session!.emit({
      type: 'error', sessionId: session!.sessionId,
      error: { code: 'driver-failure', message: 'terminal transport failure', recoverable: false },
    });
    expect(manager.snapshot()?.configuration).toBeUndefined();
    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-failure' });
    await manager.disconnect();
  });

  it('rejects SignalLab-only capabilities on serial sessions and mismatched feature results', async () => {
    const invalidDriver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => new StubSession(candidate, analyzerCapabilities([
        signalLabCapabilities([]).features[0]!,
      ])),
    );
    const invalidManager = new InstrumentManager(new InstrumentDriverRegistry([invalidDriver]), deterministicRuntime());
    await expect(invalidManager.connect((await invalidManager.discover()).candidates[0]!))
      .rejects.toMatchObject({ code: 'driver-contract' });

    let session: StubSession;
    const screenDriver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities([
          { kind: 'screen', width: 2, height: 1, pixelFormat: 'rgb565le' },
        ]));
        session.onFeature = async () => ({
          kind: 'screen', action: 'capture', sessionId: session.sessionId,
          frame: { width: 1, height: 1, pixelFormat: 'rgb565le', pixels: new Uint8Array(2), capturedAt: CAPTURED_AT },
        });
        return session;
      },
    );
    const screenManager = new InstrumentManager(new InstrumentDriverRegistry([screenDriver]), deterministicRuntime());
    await screenManager.connect((await screenManager.discover()).candidates[0]!);
    await expect(screenManager.executeFeature({ kind: 'screen', action: 'capture' }))
      .rejects.toMatchObject({ code: 'driver-contract' });
  });

  it('aggregates pre-session cleanup across every registered driver and keeps failures retryable', async () => {
    const tinySa = new StubDriver('tinysa-zs407', ['serial-port'], async () => []);
    const signalLab = new StubDriver('signal-lab', ['signal-lab'], async () => []);
    tinySa.onPendingConnectionCleanup = async () => { throw new Error('TinySA retained transport close failed'); };
    const manager = new InstrumentManager(new InstrumentDriverRegistry([tinySa, signalLab]), deterministicRuntime());

    await expect(manager.disconnect()).rejects.toThrow(/TinySA retained transport close failed/);
    expect(tinySa.pendingConnectionCleanupCalls).toBe(1);
    expect(signalLab.pendingConnectionCleanupCalls).toBe(1);

    tinySa.onPendingConnectionCleanup = async () => undefined;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(tinySa.pendingConnectionCleanupCalls).toBe(2);
    expect(signalLab.pendingConnectionCleanupCalls).toBe(2);
  });

  it('publishes a failed-connect cleanup requirement until aggregate human teardown succeeds', async () => {
    let rejectConnect = true;
    let rejectCleanup = true;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => {
        if (rejectConnect) throw new Error('bridge boot failed');
        return new StubSession(candidate, signalLabCapabilities([]));
      },
    );
    driver.onPendingConnectionCleanup = async () => {
      if (rejectCleanup) throw new Error('bridge child did not exit');
    };
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toThrow(/Failed-connect cleanup also failed/);
    expect(manager.pendingConnectionCleanup()).toEqual({ driverId: 'signal-lab', phase: 'driver-pending' });
    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'session-active' });

    rejectCleanup = false;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(manager.pendingConnectionCleanup()).toBeUndefined();

    rejectConnect = false;
    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    await manager.disconnect();
  });

  it('publishes a cleanup requirement when post-session driver cleanup fails', async () => {
    let rejectCleanup = true;
    const driver = new StubDriver(
      'signal-lab', ['signal-lab'], async () => [signalLabDescriptor()],
      async (candidate) => new StubSession(candidate, signalLabCapabilities([])),
    );
    driver.onPendingConnectionCleanup = async () => {
      if (rejectCleanup) throw new Error('late bridge child did not exit');
    };
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    await expect(manager.disconnect()).rejects.toThrow(/late bridge child did not exit/);
    expect(manager.snapshot()).toBeUndefined();
    expect(manager.pendingConnectionCleanup()).toEqual({ driverId: 'signal-lab', phase: 'driver-pending' });
    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'session-active' });

    rejectCleanup = false;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(manager.pendingConnectionCleanup()).toBeUndefined();
  });

  it('never runs pre-session cleanup when admitted-session teardown fails first', async () => {
    let session: StubSession;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        session = new StubSession(candidate, analyzerCapabilities());
        session.onDisconnect = async () => { throw new Error('active session close failed'); };
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.disconnect()).rejects.toThrow(/active session close failed/);
    expect(driver.pendingConnectionCleanupCalls).toBe(0);
    session!.onDisconnect = async () => undefined;
    await manager.disconnect();
    expect(driver.pendingConnectionCleanupCalls).toBe(1);
  });

  it('retains a malformed returned session when its disconnect fails and blocks reconnect until teardown retry succeeds', async () => {
    let malformed: StubSession;
    let returnMalformed = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        const session = new StubSession(candidate, analyzerCapabilities());
        if (returnMalformed) {
          returnMalformed = false;
          malformed = session;
          Object.defineProperty(session, 'driverId', { value: 'signal-lab', configurable: true });
          session.onDisconnect = async () => { throw new Error('malformed session close failed'); };
        }
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toThrow(/Invalid-session cleanup also failed/);
    expect(manager.snapshot()).toBeUndefined();
    expect(malformed!.disconnectCalls).toBe(1);

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'session-active' });
    expect(driver.connectCalls).toHaveLength(1);

    malformed!.onDisconnect = async () => undefined;
    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(malformed!.disconnectCalls).toBe(2);
    expect(driver.pendingConnectionCleanupCalls).toBe(1);

    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    await manager.disconnect();
  });

  it('does not retain an impossible raw teardown when a malformed session has no disconnect method', async () => {
    let returnMalformed = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        const session = new StubSession(candidate, analyzerCapabilities());
        if (returnMalformed) {
          returnMalformed = false;
          Object.defineProperty(session, 'disconnect', { value: undefined, configurable: true });
        }
        return session;
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'driver-contract' });
    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'session-active' });
    expect(driver.connectCalls).toHaveLength(1);

    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(driver.pendingConnectionCleanupCalls).toBe(1);
    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    await manager.disconnect();
  });

  it('routes a falsy session return through the driver cleanup barrier before reconnect', async () => {
    let returnNull = true;
    const driver = new StubDriver(
      'tinysa-zs407', ['serial-port'], async () => [serialDescriptor()],
      async (candidate) => {
        if (returnNull) {
          returnNull = false;
          return null as unknown as InstrumentSession;
        }
        return new StubSession(candidate, analyzerCapabilities());
      },
    );
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'driver-contract' });
    await expect(manager.connect(candidate)).rejects.toMatchObject({ code: 'session-active' });
    expect(driver.connectCalls).toHaveLength(1);

    await manager.disconnect();
    expect(driver.pendingConnectionCleanupCalls).toBe(1);
    await expect(manager.connect(candidate)).resolves.toMatchObject({ candidate });
    await manager.disconnect();
  });
});

const CAPTURED_AT = '2026-07-14T18:00:00.000Z';

class StubDriver implements InstrumentDriver {
  discoverCalls = 0;
  pendingConnectionCleanupCalls = 0;
  readonly connectCalls: InstrumentCandidate[] = [];
  onPendingConnectionCleanup: () => Promise<void> = async () => undefined;

  constructor(
    readonly driverId: InstrumentDriverId,
    readonly sourceKinds: readonly InstrumentSourceKind[],
    private readonly discoverImpl: () => Promise<readonly InstrumentCandidateDescriptor[] | InstrumentDriverDiscoveryResult>,
    private readonly connectImpl: (candidate: InstrumentCandidate) => Promise<InstrumentSession> = async (candidate) => new StubSession(
      candidate,
      candidate.sourceKind === 'signal-lab' ? signalLabCapabilities([]) : analyzerCapabilities(),
    ),
  ) {}

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    this.discoverCalls++;
    const discovered = await this.discoverImpl();
    return Array.isArray(discovered)
      ? { candidates: discovered, failures: [] }
      : discovered as InstrumentDriverDiscoveryResult;
  }

  connect(candidate: InstrumentCandidate): Promise<InstrumentSession> {
    this.connectCalls.push(candidate);
    return this.connectImpl(candidate);
  }

  async cleanupPendingConnection(): Promise<void> {
    this.pendingConnectionCleanupCalls++;
    await this.onPendingConnectionCleanup();
  }
}

class StubSession implements InstrumentSession {
  readonly sessionId: string;
  readonly driverId: InstrumentDriverId;
  readonly provenance: InstrumentSessionProvenance;
  readonly rfOutput: 'off' | 'not-supported';
  capabilities: InstrumentCapabilities;
  readonly configureCalls: InstrumentConfigurationCommand[] = [];
  readonly featureCalls: InstrumentFeatureCommand[] = [];
  disconnectCalls = 0;
  unsubscribeCalls = 0;
  private listener: ((event: InstrumentSessionEvent) => void) | undefined;
  private configuration: InstrumentConfigurationCommand | undefined;
  private safetyState: InstrumentReceiveOnlySafetyState | undefined;
  private safetySequence = 0;

  onConfigure: (command: InstrumentConfigurationCommand) => Promise<void> = async () => undefined;
  onAcquire: () => Promise<InstrumentMeasurement> = async () => {
    if (!this.configuration) throw new Error('not configured');
    return sweptMeasurement(this, this.configuration.configurationRevision, 1);
  };
  onFeature: (command: InstrumentFeatureCommand) => Promise<InstrumentFeatureResult> = async (command) => defaultFeatureResult(this, command);
  onDisconnect: () => Promise<void> = async () => undefined;
  onSubscribe: (listener: (event: InstrumentSessionEvent) => void) => void = () => undefined;
  onUnsubscribe: () => void = () => undefined;
  subscribeError: Error | undefined;

  constructor(
    readonly candidate: InstrumentCandidate,
    capabilities: InstrumentCapabilities,
    receiveOnlySafety: boolean | 'uuid-only' = false,
  ) {
    this.capabilities = capabilities;
    this.driverId = candidate.driverId;
    this.sessionId = receiveOnlySafety
      ? '70000000-0000-4000-8000-000000000001'
      : `session:${candidate.driverId}`;
    this.provenance = provenanceFor(candidate);
    this.rfOutput = capabilities.features.some((feature) => feature.kind === 'rf-generator') ? 'off' : 'not-supported';
    if (receiveOnlySafety === true) {
      const connectionReceipt = this.issueSafetyReceipt('connection-first-command');
      const currentReceipt = this.issueSafetyReceipt('analyzer-configuration');
      this.safetyState = { connectionReceipt, currentReceipt };
    }
  }

  get receiveOnlySafety(): InstrumentReceiveOnlySafetyState | undefined {
    return this.safetyState ? structuredClone(this.safetyState) : undefined;
  }

  advanceSafety(reason: ReceiveOnlySafetyReceipt['reason']): ReceiveOnlySafetyReceipt {
    if (!this.safetyState) throw new Error('Stub receive-only safety is not enabled');
    const currentReceipt = this.issueSafetyReceipt(reason);
    this.safetyState = { connectionReceipt: this.safetyState.connectionReceipt, currentReceipt };
    return structuredClone(currentReceipt);
  }

  rewriteConnectionSafetyReceipt(): void {
    if (!this.safetyState) throw new Error('Stub receive-only safety is not enabled');
    this.safetyState = {
      connectionReceipt: this.issueSafetyReceipt('connection-first-command'),
      currentReceipt: this.safetyState.currentReceipt,
    };
  }

  async configure(command: InstrumentConfigurationCommand): Promise<void> {
    this.configureCalls.push(command);
    this.configuration = command;
    await this.onConfigure(command);
  }

  acquire(): Promise<InstrumentMeasurement> { return this.onAcquire(); }

  executeFeature(command: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.featureCalls.push(command);
    return this.onFeature(command);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    await this.onDisconnect();
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    if (this.subscribeError) throw this.subscribeError;
    this.listener = listener;
    this.onSubscribe(listener);
    return () => {
      this.unsubscribeCalls++;
      this.onUnsubscribe();
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(event: InstrumentSessionEvent): void { this.listener?.(event); }
  emitUnsafe(event: unknown): void { this.listener?.(event as InstrumentSessionEvent); }

  private issueSafetyReceipt(reason: ReceiveOnlySafetyReceipt['reason']): ReceiveOnlySafetyReceipt {
    const sequence = ++this.safetySequence;
    return safetyReceipt(this.sessionId, sequence, reason);
  }
}

function serialDescriptor(): InstrumentCandidateDescriptor {
  return {
    schemaVersion: 1,
    driverId: 'tinysa-zs407',
    candidateId: 'serial:/dev/tty.fixture',
    displayName: 'tinySA Ultra+ ZS407',
    sourceKind: 'serial-port',
    serialPort: { path: '/dev/tty.fixture', vendorId: '0483', productId: '5740' },
  };
}

function signalLabDescriptor(): InstrumentCandidateDescriptor {
  return {
    schemaVersion: 1,
    driverId: 'signal-lab',
    candidateId: 'signal-lab:default',
    displayName: 'SignalLab',
    sourceKind: 'signal-lab',
    signalLab: { sourceId: 'default' },
  };
}

function signalLabDescriptorFor(driverId: InstrumentDriverId, index: number): InstrumentCandidateDescriptor {
  return {
    schemaVersion: 1,
    driverId,
    candidateId: `${driverId}:source:${index}`,
    displayName: `${driverId} source ${index}`,
    sourceKind: 'signal-lab',
    signalLab: { sourceId: `source:${index}` },
  };
}

function analyzerCapabilities(features: readonly InstrumentFeatureCapability[] = []): InstrumentCapabilities {
  return {
    schemaVersion: 1,
    acquisitions: [{
      kind: 'swept-spectrum',
      frequencyHz: { min: 0, max: 1_000_000 },
      points: { min: 2, max: 450, step: 1 },
      sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } },
      controls: receiverSpectrumCapability(),
      powerUnit: 'dBm',
    }],
    features,
  };
}

function complexIqCapabilities(): InstrumentCapabilities {
  return {
    schemaVersion: 1,
    acquisitions: [{
      kind: 'complex-iq',
      centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000 },
      sampleRateHz: { min: 48_000, max: 20_000_000 },
      bandwidthHz: { min: 10_000, max: 20_000_000 },
      sampleCount: { min: 1, max: 4 },
      sampleFormat: 'cf32le',
    }],
    features: [],
  };
}

type SignalLabFeature = Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }>;
type SignalLabProfileInput = SignalLabFeature['profiles'][number] | {
  readonly profileId: string;
  readonly centerFrequencyHz: number;
  readonly recommendedSpanHz: number;
};
type SignalLabFeatureInput = Omit<SignalLabFeature, 'profiles' | 'channel' | 'iqProfiles'> & {
  readonly profiles: readonly SignalLabProfileInput[];
  readonly channel?: SignalLabFeature['channel'];
  readonly iqProfiles?: SignalLabFeature['iqProfiles'];
};
type InstrumentFeatureInput =
  | Exclude<InstrumentFeatureCapability, SignalLabFeature>
  | SignalLabFeatureInput;

function signalLabCapabilities(features: readonly InstrumentFeatureInput[]): InstrumentCapabilities {
  const requestedFeatures: readonly InstrumentFeatureInput[] = features.length > 0 ? features : [{
    kind: 'signal-lab-profile-selection',
    profiles: [{ profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }],
    selectedProfileId: 'cw',
  }];
  const admittedFeatures: readonly InstrumentFeatureCapability[] = requestedFeatures.map((feature) => {
    if (feature.kind !== 'signal-lab-profile-selection') return feature;
    const profiles = feature.profiles.map((profile) =>
      'governance' in profile
        ? profile
        : signalLabFixtureProfile(
            profile.profileId,
            profile.centerFrequencyHz,
            profile.recommendedSpanHz,
          ));
    return {
      ...feature,
      profiles,
      channel: feature.channel ?? signalLabFixtureChannel(),
      iqProfiles: feature.iqProfiles ?? profiles.map((profile) => ({
        profileId: profile.profileId,
        nativeSampleRateHz: null,
        signalBandwidthHz: profile.occupiedBandwidthHz,
        profileReferenceCenterHz: profile.centerFrequencyHz,
        nativeCarrierOffsetHz: 0,
        nativeMinimumCaptureBandwidthHz: null,
        replay: 'continuous' as const,
        derivedTransportSupported: false,
      })),
    };
  });
  return {
    schemaVersion: 1,
    acquisitions: [
      {
        kind: 'swept-spectrum', frequencyHz: { min: 1, max: 6_000_000_000 },
        points: { min: 2, max: 450 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: syntheticScalarCapability(), powerUnit: 'dBm',
      },
      {
        kind: 'detected-power-timeseries', centerFrequencyHz: { min: 1, max: 6_000_000_000 },
        sampleCount: { min: 1, max: 450 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: syntheticScalarCapability(),
        powerUnit: 'dBm', timing: 'uniform',
      },
      {
        kind: 'complex-iq',
        centerFrequencyHz: { min: 1, max: 6_000_000_000, step: 1 },
        sampleRateHz: { min: 1, max: 491_520_000, step: 1 },
        bandwidthHz: { min: 1, max: 491_520_000, step: 1 },
        bandwidthMode: 'independent',
        sampleCount: { min: 1, max: 65_536, step: 1 },
        sampleFormat: 'cf32le',
      },
    ],
    features: admittedFeatures,
  };
}

function signalLabIqCapabilities(selectedProfileId: 'cw' | 'lte-etm1.1' = 'cw'): InstrumentCapabilities {
  const scalar = signalLabCapabilities([{
    kind: 'signal-lab-profile-selection',
    profiles: [
      {
        profileId: 'cw', label: 'CW', family: 'tone', model: 'cw-model', qualification: 'visual',
        centerFrequencyHz: 100_000_000, occupiedBandwidthHz: 1, recommendedSpanHz: 2_000_000,
        projection: { allocation: 'carrier', modulation: 'unmodulated', timing: 'continuous' },
        source: {
          organization: 'TinySA SignalLab',
          references: [{
            specification: 'SignalLab fixture', clause: 'CW', revision: '1',
            url: 'https://example.test/signal-lab/cw',
          }],
        },
        governance: signalLabFixtureGovernance('cw', 'TinySA SignalLab'),
        disclosure: 'Analytic fixture profile.',
      },
      {
        profileId: 'lte-etm1.1', label: 'LTE E-TM 1.1', family: 'e-utra', model: 'E-TM 1.1',
        qualification: 'standards-derived', centerFrequencyHz: 1_842_500_000,
        occupiedBandwidthHz: 9_000_000, recommendedSpanHz: 12_000_000,
        projection: {
          allocation: 'full', modulation: 'ofdm-mixed', timing: 'frame', duplex: 'fdd',
          subcarrierSpacingHz: 15_000, nominalResourceBlocks: 50,
        },
        source: {
          organization: '3GPP',
          references: [{
            specification: 'TS 36.141', clause: '6.1', revision: 'Release 18',
            url: 'https://www.3gpp.org/dynareport/36141.htm',
          }],
        },
        governance: signalLabFixtureGovernance('lte-etm1.1', '3GPP'),
        disclosure: 'Standards-derived deterministic fixture projection.',
      },
    ],
    selectedProfileId,
    iqProfiles: [
      {
        profileId: 'cw', nativeSampleRateHz: null, signalBandwidthHz: 1,
        profileReferenceCenterHz: 100_000_000, nativeCarrierOffsetHz: 0,
        nativeMinimumCaptureBandwidthHz: null,
        replay: 'continuous', derivedTransportSupported: false,
      },
      {
        profileId: 'lte-etm1.1', nativeSampleRateHz: null, signalBandwidthHz: 9_000_000,
        profileReferenceCenterHz: 1_842_500_000, nativeCarrierOffsetHz: 0,
        nativeMinimumCaptureBandwidthHz: null,
        replay: 'continuous', derivedTransportSupported: false,
      },
    ],
  }]);
  return {
    ...scalar,
    acquisitions: scalar.acquisitions,
  };
}

function signalLabFixtureChannel(): SignalLabFeature['channel'] {
  return {
    model: 'awgn',
    noiseFloorDbm: -108,
    seed: 407,
    fadingRateHz: 2,
    receiverImpairment: 'clean',
  };
}

function signalLabFixtureProfile(
  profileId: string,
  centerFrequencyHz: number,
  recommendedSpanHz: number,
): SignalLabFeature['profiles'][number] {
  return {
    profileId,
    label: profileId,
    family: 'tone',
    model: 'deterministic-fixture',
    qualification: 'visual',
    centerFrequencyHz,
    occupiedBandwidthHz: 1,
    recommendedSpanHz,
    projection: { allocation: 'carrier', modulation: 'unmodulated', timing: 'continuous' },
    source: {
      organization: 'TinySA SignalLab',
      references: [{
        specification: 'SignalLab fixture',
        clause: profileId,
        revision: '1',
        url: `https://example.test/signal-lab/${encodeURIComponent(profileId)}`,
      }],
    },
    governance: signalLabFixtureGovernance(profileId, 'TinySA SignalLab'),
    disclosure: 'Deterministic contract fixture profile.',
  };
}

function signalLabFixtureGovernance(
  profileId: string,
  organization: '3GPP' | 'TinySA SignalLab',
): SignalLabFeature['profiles'][number]['governance'] {
  const standardsDerived = organization === '3GPP';
  return {
    schemaVersion: 1,
    profileId,
    signalKind: standardsDerived
      ? 'standards-derived-engineering-profile'
      : 'mathematical-lab-reference',
    governingOrganizations: [organization],
    governingBodies: [{
      organization,
      technicalBody: standardsDerived ? '3GPP TSG RAN' : 'TinySA SignalLab project',
      authorityScope: standardsDerived
        ? 'LTE waveform definition and deterministic test-model configuration.'
        : 'Deterministic mathematical laboratory reference.',
    }],
    normativeReferences: standardsDerived ? [{
      organization: '3GPP',
      documentId: '3GPP TS 36.141',
      revision: 'Release 18',
      clauses: ['6.1'],
      url: 'https://www.3gpp.org/dynareport/36141.htm',
    }] : [],
    applicability: {
      status: standardsDerived ? 'applicable' : 'not-applicable',
      reason: standardsDerived
        ? 'The engineering fixture is governed by the cited LTE test-model specification.'
        : 'A mathematical fixture has no external radio-standard applicability.',
    },
    implementedQualificationState: standardsDerived
      ? 'standards-derived-engineering-projection'
      : 'mathematical-reference',
    testedClaimScope: {
      kind: standardsDerived
        ? 'deterministic-engineering-projection'
        : 'deterministic-mathematical-reference',
      statement: 'Fixture verifies the declared deterministic SignalLab boundary.',
      testLocations: ['src/instrument-manager.test.ts'],
    },
    claims: {
      standardsCompliance: 'not-claimed',
      digitalStandardsAdherence: standardsDerived ? 'not-verified' : 'not-applicable',
      digitalQualification: 'not-qualified',
      rfConformance: 'not-qualified',
    },
    digitalQualificationEvidence: null,
    qualificationBlockers: ['Fixture carries no independent digital-baseband qualification evidence.'],
    reason: 'Runtime fixture declares only its directly tested deterministic scope.',
  };
}

function sweepConfiguration() {
  return {
    kind: 'swept-spectrum' as const, startHz: 100, stopHz: 300, points: 3,
    sweepTimeSeconds: 'auto' as const,
    controls: receiverSpectrumControls(),
  };
}

function syntheticSweepConfiguration() {
  return {
    kind: 'swept-spectrum' as const, startHz: 100, stopHz: 300, points: 3,
    sweepTimeSeconds: 0.05,
    controls: syntheticScalarControls(),
  };
}

function syntheticDetectedPowerConfiguration(centerHz: number, sampleCount: number) {
  return {
    kind: 'detected-power-timeseries' as const,
    centerHz, sampleCount, sweepTimeSeconds: 0.05,
    controls: syntheticScalarControls(),
  };
}

function receiverSpectrumCapability() {
  return {
    schemaVersion: 1 as const,
    model: 'receiver' as const,
    acquisitionFormats: ['text', 'raw'] as const,
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    detectors: ['sample', 'quasi-peak'] as const,
    spurRejection: ['off', 'on', 'auto'] as const,
    lowNoiseAmplifier: ['off', 'on'] as const,
    avoidSpurs: ['off', 'on', 'auto'] as const,
    triggerModes: ['auto', 'normal', 'single'] as const,
    triggerLevelDbm: { min: -174, max: 30 },
  };
}

function receiverDetectedPowerCapability() {
  return {
    schemaVersion: 1 as const,
    model: 'receiver' as const,
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    triggerModes: ['auto', 'normal', 'single'] as const,
    triggerLevelDbm: { min: -174, max: 30 },
  };
}

function receiverSpectrumControls() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const, acquisitionFormat: 'raw' as const,
    resolutionBandwidthKhz: 'auto' as const, attenuationDb: 'auto' as const,
    detector: 'sample' as const, spurRejection: 'auto' as const,
    lowNoiseAmplifier: 'off' as const, avoidSpurs: 'auto' as const, trigger: { mode: 'auto' as const },
  };
}

function receiverDetectedPowerControls() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const,
    resolutionBandwidthKhz: 'auto' as const, attenuationDb: 'auto' as const, trigger: { mode: 'auto' as const },
  };
}

function syntheticScalarCapability() {
  return { schemaVersion: 1 as const, model: 'synthetic-scalar' as const, timingQualification: 'simulation-exact' as const };
}

function syntheticScalarControls() {
  return syntheticScalarCapability();
}

function iqConfiguration() {
  return {
    kind: 'complex-iq' as const,
    centerHz: 2_450_000_000,
    sampleRateHz: 1_000_000,
    bandwidthHz: 800_000,
    sampleCount: 4,
    sampleFormat: 'cf32le' as const,
  };
}

function sweptMeasurement(session: StubSession, configurationRevision: string, sequence: number): InstrumentMeasurement {
  return {
    schemaVersion: 1,
    measurementId: `measurement:${sequence}:${configurationRevision}`,
    sessionId: session.sessionId,
    configurationRevision,
    sequence,
    capturedAt: CAPTURED_AT,
    elapsedMilliseconds: 1,
    resolutionBandwidthHz: session.provenance.sourceKind === 'signal-lab' ? null : 10,
    attenuationDb: session.provenance.sourceKind === 'signal-lab' ? null : 0,
    qualification: session.provenance.qualification,
    ...(session.provenance.sourceKind === 'signal-lab'
      ? { producerConfigurationEpoch: session.provenance.producerConfigurationEpoch }
      : {}),
    complete: true,
    kind: 'swept-spectrum',
    frequencyHz: [100, 200, 300],
    powerDbm: [-90, -80, -95],
  };
}

function detectedMeasurement(
  session: StubSession,
  configurationRevision: string,
  sampleIntervalSeconds: number,
  timingQualification: 'wall-clock-derived' | 'measured-calibrated' | 'simulation-exact',
): InstrumentMeasurement {
  return {
    schemaVersion: 1,
    measurementId: `measurement:detected:${configurationRevision}`,
    sessionId: session.sessionId,
    configurationRevision,
    sequence: 1,
    capturedAt: CAPTURED_AT,
    elapsedMilliseconds: 22,
    resolutionBandwidthHz: session.provenance.sourceKind === 'signal-lab' ? null : 10_000,
    attenuationDb: session.provenance.sourceKind === 'signal-lab' ? null : 0,
    qualification: session.provenance.qualification,
    ...(session.provenance.sourceKind === 'signal-lab'
      ? { producerConfigurationEpoch: session.provenance.producerConfigurationEpoch }
      : {}),
    complete: true,
    kind: 'detected-power-timeseries',
    centerHz: 100_000_000,
    sampleIntervalSeconds,
    timingQualification,
    powerDbm: Array.from({ length: 20 }, () => -80),
  };
}

function complexIqMeasurement(
  session: StubSession,
  configurationRevision: string,
  sampleCount: number,
): Extract<InstrumentMeasurement, { kind: 'complex-iq' }> {
  return {
    schemaVersion: 1,
    measurementId: `measurement:iq:${configurationRevision}:${sampleCount}`,
    sessionId: session.sessionId,
    configurationRevision,
    sequence: 1,
    capturedAt: CAPTURED_AT,
    elapsedMilliseconds: 1,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    qualification: session.provenance.qualification,
    complete: true,
    kind: 'complex-iq',
    centerHz: 2_450_000_000,
    sampleRateHz: 1_000_000,
    bandwidthHz: 800_000,
    sampleFormat: 'cf32le',
    sampleCount,
    samples: new Uint8Array(sampleCount * 8),
  };
}

function provenanceFor(candidate: InstrumentCandidate): InstrumentSessionProvenance {
  if (candidate.sourceKind === 'serial-port') {
    return {
      sourceKind: 'serial-port', execution: 'physical', transport: 'usb-cdc-acm',
      qualification: 'device-observed', verifiedAt: CAPTURED_AT, serialPort: candidate.serialPort,
      device: {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
        firmwareReportedRevision: 'c5dd31f',
        firmwareSourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
        firmwareQualification: 'supported-oem', usbIdentityVerified: true,
      },
    };
  }
  if (candidate.sourceKind === 'tinysa-firmware-twin') {
    return {
      sourceKind: 'tinysa-firmware-twin', execution: 'firmware-executed-twin', transport: 'renode-monitor-bridge',
      qualification: 'firmware-executed-twin', verifiedAt: CAPTURED_AT,
      bridge: candidate.firmwareTwin.bridge, repositoryCommit: candidate.firmwareTwin.repositoryCommit,
      firmwareBinarySha256: candidate.firmwareTwin.firmwareBinarySha256, usbTransactionsModeled: false,
      device: { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'executable-fixture' },
    };
  }
  if (candidate.sourceKind === 'signal-lab') {
    return {
      sourceKind: 'signal-lab', sourceId: candidate.signalLab.sourceId,
      execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection', verifiedAt: CAPTURED_AT,
      producerConfigurationEpoch: 'producer-epoch:1',
      contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 2,
      contractSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), generatorContractBindingSha256: 'c'.repeat(64),
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    };
  }
  // This fixture file never exercises a Neptune P210 candidate; the
  // dedicated @tinysa/neptune-p210 package owns Neptune's real provenance
  // construction and its own hostile-contract test coverage.
  throw new Error(`provenanceFor fixture does not support source kind ${candidate.sourceKind}`);
}

function safetyReceipt(
  sessionId: string,
  sequence: number,
  reason: ReceiveOnlySafetyReceipt['reason'],
): ReceiveOnlySafetyReceipt {
  return {
    schemaVersion: 1,
    receiptId: `80000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`,
    sessionId,
    command: 'output off',
    reason,
    outputState: 'off',
    acknowledgement: 'empty-reply-acknowledged',
    qualification: 'device-command-acknowledged-not-rf-measured',
    sequence,
    acknowledgedAt: `2026-07-14T18:00:${sequence.toString().padStart(2, '0')}.000Z`,
  };
}

function generatorCapability(): InstrumentFeatureCapability {
  return {
    kind: 'rf-generator',
    paths: [{ path: 'normal', frequencyHz: { min: 1_000_000, max: 1_000_000_000 } }],
    levelDbm: { min: -115, max: -18.5 },
    modulation: {
      off: true,
      am: { modulationFrequencyHz: { min: 1, max: 10_000 }, depthPercent: { min: 0, max: 100 } },
      fm: { modulationFrequencyHz: { min: 1, max: 3_500 }, deviationHz: { min: 1_000, max: 300_000 } },
    },
  };
}

function defaultFeatureResult(session: StubSession, command: InstrumentFeatureCommand): InstrumentFeatureResult {
  if (command.kind === 'rf-generator') return { ...command };
  if (command.kind === 'screen') {
    const capability = session.capabilities.features.find((feature) => feature.kind === 'screen');
    if (!capability || capability.kind !== 'screen') throw new Error('screen not advertised');
    const bytesPerPixel = capability.pixelFormat === 'rgb565le' ? 2 : 4;
    return {
      ...command,
      frame: {
        width: capability.width,
        height: capability.height,
        pixelFormat: capability.pixelFormat,
        pixels: new Uint8Array(capability.width * capability.height * bytesPerPixel),
        capturedAt: CAPTURED_AT,
      },
    } as InstrumentFeatureResult;
  }
  if (command.kind === 'touch') return { ...command, accepted: true };
  if (command.kind === 'diagnostics') return { ...command, lines: ['fixture diagnostic'] };
  return { ...command, producerConfigurationEpoch: 'producer-epoch:2' };
}

function deterministicRuntime(): InstrumentManagerRuntime {
  const counters = { discovery: 0, configuration: 0 };
  return {
    now: () => new Date(CAPTURED_AT),
    opaqueId: (scope) => `${scope}:${++counters[scope]}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
