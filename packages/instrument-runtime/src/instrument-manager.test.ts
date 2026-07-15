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
        } as InstrumentCapabilities);
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
          profiles: [{ profileId: 'outside', centerFrequencyHz: 6_000_000_001, recommendedSpanHz: 1_000_000 }],
          selectedProfileId: 'outside',
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
        measurement: { ...returned, measurementId: 'event-disagrees' },
      });
      return returned;
    };

    await expect(manager.acquire()).rejects.toMatchObject({ code: 'driver-contract' });
    expect(events.some((event) => event.type === 'measurement')).toBe(false);
    expect(manager.snapshot()).toMatchObject({ fault: { code: 'driver-contract' } });
  });

  it('reconciles cloned late I/Q events by digest without retaining the complete payload', async () => {
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

  it('terminal-faults a late I/Q event whose payload differs from its acquisition return', async () => {
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
    const changed = returned.samples.slice();
    changed[changed.length - 1] = 1;

    session!.emit({ type: 'measurement', measurement: { ...returned, samples: changed } });

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
    const features: InstrumentFeatureCapability[] = [
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

  it('faults after uncertain profile mutation, blocks operations, and reconnects cleanly', async () => {
    let session: StubSession;
    let manager: InstrumentManager;
    const profileFeature: InstrumentFeatureCapability = {
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
        {
          kind: 'signal-lab-profile-selection',
          profiles: [{ profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }],
          selectedProfileId: 'cw',
        },
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
  readonly configureCalls: InstrumentConfigurationCommand[] = [];
  readonly featureCalls: InstrumentFeatureCommand[] = [];
  disconnectCalls = 0;
  private listener: ((event: InstrumentSessionEvent) => void) | undefined;
  private configuration: InstrumentConfigurationCommand | undefined;

  onConfigure: (command: InstrumentConfigurationCommand) => Promise<void> = async () => undefined;
  onAcquire: () => Promise<InstrumentMeasurement> = async () => {
    if (!this.configuration) throw new Error('not configured');
    return sweptMeasurement(this, this.configuration.configurationRevision, 1);
  };
  onFeature: (command: InstrumentFeatureCommand) => Promise<InstrumentFeatureResult> = async (command) => defaultFeatureResult(this, command);
  onDisconnect: () => Promise<void> = async () => undefined;
  onSubscribe: (listener: (event: InstrumentSessionEvent) => void) => void = () => undefined;
  subscribeError: Error | undefined;

  constructor(readonly candidate: InstrumentCandidate, readonly capabilities: InstrumentCapabilities) {
    this.driverId = candidate.driverId;
    this.sessionId = `session:${candidate.driverId}`;
    this.provenance = provenanceFor(candidate);
    this.rfOutput = capabilities.features.some((feature) => feature.kind === 'rf-generator') ? 'off' : 'not-supported';
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
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  emit(event: InstrumentSessionEvent): void { this.listener?.(event); }
  emitUnsafe(event: unknown): void { this.listener?.(event as InstrumentSessionEvent); }
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

function signalLabCapabilities(features: readonly InstrumentFeatureCapability[]): InstrumentCapabilities {
  const admittedFeatures: readonly InstrumentFeatureCapability[] = features.length > 0 ? features : [{
    kind: 'signal-lab-profile-selection',
    profiles: [{ profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }],
    selectedProfileId: 'cw',
  }];
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
    ],
    features: admittedFeatures,
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
  return {
    sourceKind: 'signal-lab', sourceId: candidate.signalLab.sourceId,
    execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge',
    qualification: 'synthetic-visual-projection', verifiedAt: CAPTURED_AT,
    producerConfigurationEpoch: 'producer-epoch:1',
    contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1,
    contractSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), generatorSha256: 'c'.repeat(64),
    claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
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
