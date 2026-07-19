/**
 * Regression pins for InstrumentManager lifecycle behavior that the SignalLab
 * web bridge depends on. These tests freeze CURRENT manager semantics before
 * any refactor:
 *
 * - A7a: executeFeature(select-profile) emits `feature-result` and THEN
 *   `configuration-invalidated` (reason `source-profile-changed`), adjacently.
 * - A7b: a feature-driven invalidation makes acquire() refuse with
 *   `not-configured` until a new configuration is admitted.
 * - A8: the acquire() path rejects a session measurement whose sequence does
 *   not advance. Current code THROWS from the second acquire() with a
 *   `driver-contract` error and terminal-faults the session (it does not
 *   silently suppress the measurement).
 *
 * The fake driver below implements InstrumentDriver/InstrumentSession honestly
 * (real epoch advancement, real capability mutation on profile selection) with
 * capabilities modeled on the signal-lab shape used by
 * apps/desktop/src/shared/in-process-signal-lab-driver.ts.
 */
import { describe, expect, it } from 'vitest';
import type {
  InstrumentCandidate,
  InstrumentCandidateDescriptor,
  InstrumentCapabilities,
  InstrumentConfigurationCommand,
  InstrumentDriverDiscoveryResult,
  InstrumentFeatureCommand,
  InstrumentFeatureResult,
  InstrumentManagerEvent,
  InstrumentMeasurement,
  InstrumentSessionEvent,
  InstrumentSessionProvenance,
} from '@tinysa/contracts';
import type { InstrumentDriver, InstrumentSession } from './instrument-driver.js';
import { InstrumentDriverRegistry } from './instrument-driver-registry.js';
import {
  InstrumentManager,
  InstrumentManagerError,
  type InstrumentManagerRuntime,
} from './instrument-manager.js';

const CAPTURED_AT = '2026-07-14T18:00:00.000Z';
const FAKE_DRIVER_ID = 'signal-lab';
const FAKE_SOURCE_ID = 'web';
const INITIAL_PROFILE_ID = 'cw';
const OTHER_PROFILE_ID = 'lte-etm1.1';

describe('InstrumentManager lifecycle regression pins (SignalLab shape)', () => {
  it('A7a: select-profile emits feature-result immediately followed by configuration-invalidated (source-profile-changed)', async () => {
    const { manager, events } = await connectedManager();
    await manager.configure(syntheticSweepConfiguration());
    events.length = 0;

    const result = await manager.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: OTHER_PROFILE_ID,
    });
    expect(result.kind).toBe('signal-lab-profile-selection');
    if (result.kind !== 'signal-lab-profile-selection' || result.action !== 'select-profile') {
      throw new Error('unexpected feature result shape');
    }
    expect(result.profileId).toBe(OTHER_PROFILE_ID);
    expect(result.producerConfigurationEpoch).toBe('producer-epoch:2');

    const featureIndex = events.findIndex((event) => event.type === 'feature-result');
    const invalidatedIndex = events.findIndex((event) => event.type === 'configuration-invalidated');
    expect(featureIndex).toBeGreaterThanOrEqual(0);
    expect(invalidatedIndex).toBeGreaterThanOrEqual(0);
    // Current behavior: feature-result first, configuration-invalidated
    // immediately after it (adjacent), nothing between them.
    expect(invalidatedIndex).toBe(featureIndex + 1);

    const invalidated = events[invalidatedIndex]!;
    if (invalidated.type !== 'configuration-invalidated') throw new Error('unreachable');
    expect(invalidated.reason).toBe('source-profile-changed');
    expect(invalidated.sessionId).toBe(`session:${FAKE_DRIVER_ID}`);
    // The invalidation snapshot has already dropped the admitted configuration
    // and adopted the newly selected profile.
    expect(invalidated.session.configuration).toBeUndefined();
    const sourceFeature = invalidated.session.capabilities.features
      .find((feature) => feature.kind === 'signal-lab-profile-selection');
    expect(sourceFeature?.kind === 'signal-lab-profile-selection' && sourceFeature.selectedProfileId)
      .toBe(OTHER_PROFILE_ID);

    const featureEvent = events[featureIndex]!;
    if (featureEvent.type !== 'feature-result') throw new Error('unreachable');
    expect(featureEvent.result).toMatchObject({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: OTHER_PROFILE_ID,
    });
  });

  it('A7b: after a feature-driven invalidation, acquire() refuses with not-configured until re-configured', async () => {
    const { manager } = await connectedManager();
    await manager.configure(syntheticSweepConfiguration());
    // A configured session acquires normally before the invalidation.
    const before = await manager.acquire();
    expect(before.sequence).toBe(1);
    expect(before.producerConfigurationEpoch).toBe('producer-epoch:1');

    await manager.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: OTHER_PROFILE_ID,
    });

    const error = await manager.acquire().then(
      () => { throw new Error('acquire resolved after configuration invalidation'); },
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(InstrumentManagerError);
    expect((error as InstrumentManagerError).code).toBe('not-configured');
    expect((error as InstrumentManagerError).message)
      .toBe('Instrument session has no admitted configuration revision');

    // Re-configuring re-admits acquisition against the advanced producer epoch.
    const state = await manager.configure(syntheticSweepConfiguration());
    const after = await manager.acquire();
    expect(after.configurationRevision).toBe(state.configurationRevision);
    expect(after.producerConfigurationEpoch).toBe('producer-epoch:2');
  });

  it('A8: acquire() throws driver-contract and terminal-faults the session when the same sequence is returned twice', async () => {
    const { manager, events } = await connectedManager({ sequences: [7, 7] });
    await manager.configure(syntheticSweepConfiguration());
    const first = await manager.acquire();
    expect(first.sequence).toBe(7);

    const error = await manager.acquire().then(
      () => { throw new Error('acquire resolved for a repeated measurement sequence'); },
      (value: unknown) => value,
    );
    // Current behavior: the second acquire THROWS (the measurement is not
    // silently suppressed) with a driver-contract repetition error...
    expect(error).toBeInstanceOf(InstrumentManagerError);
    expect((error as InstrumentManagerError).code).toBe('driver-contract');
    expect((error as InstrumentManagerError).message)
      .toBe('Measurement sequence 7 was returned more than once');

    // ...exactly one measurement was ever published...
    expect(events.filter((event) => event.type === 'measurement')).toHaveLength(1);

    // ...and the session is terminal-faulted, refusing further acquisition
    // until it is disconnected.
    const snapshot = manager.snapshot();
    expect(snapshot?.fault).toMatchObject({ code: 'driver-contract', recoverable: false });
    const faulted = await manager.acquire().then(
      () => { throw new Error('acquire resolved on a faulted session'); },
      (value: unknown) => value,
    );
    expect(faulted).toBeInstanceOf(InstrumentManagerError);
    expect((faulted as InstrumentManagerError).message).toMatch(/faulted and must be disconnected/);
  });

  it('A8: acquire() also rejects an unseen sequence that is not newer than the last admitted one', async () => {
    const { manager } = await connectedManager({ sequences: [5, 2] });
    await manager.configure(syntheticSweepConfiguration());
    const first = await manager.acquire();
    expect(first.sequence).toBe(5);

    const error = await manager.acquire().then(
      () => { throw new Error('acquire resolved for a regressing measurement sequence'); },
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(InstrumentManagerError);
    expect((error as InstrumentManagerError).code).toBe('driver-contract');
    expect((error as InstrumentManagerError).message)
      .toBe('Measurement sequence 2 is not newer than 5');
    expect(manager.snapshot()?.fault).toMatchObject({ code: 'driver-contract' });
  });
});

interface FakeOptions {
  /** Explicit measurement sequences to return, in order; auto-increments after the queue drains. */
  sequences?: readonly number[];
}

async function connectedManager(options: FakeOptions = {}) {
  const driver = new FakeSignalLabDriver(options);
  const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
  const events: InstrumentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event));
  const discovery = await manager.discover();
  const candidate = discovery.candidates.find((value) => value.driverId === FAKE_DRIVER_ID);
  if (!candidate) throw new Error('fake discovery produced no candidate');
  await manager.connect(candidate);
  return { manager, driver, events };
}

/**
 * Minimal in-memory SignalLab-shaped driver. Honest against the
 * InstrumentDriver/InstrumentSession contract: profile selection really
 * advances the producer configuration epoch and rewrites the advertised
 * capabilities, and acquisition really binds measurements to the admitted
 * configuration revision and current epoch.
 */
class FakeSignalLabDriver implements InstrumentDriver {
  readonly driverId = FAKE_DRIVER_ID;
  readonly sourceKinds = Object.freeze(['signal-lab'] as const);
  session: FakeSignalLabSession | undefined;

  constructor(private readonly options: FakeOptions) {}

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    return { candidates: [candidateDescriptor()], failures: [] };
  }

  async connect(candidate: InstrumentCandidate): Promise<InstrumentSession> {
    if (candidate.driverId !== this.driverId || candidate.sourceKind !== 'signal-lab') {
      throw new Error('fake driver admits only its own signal-lab candidate');
    }
    this.session = new FakeSignalLabSession(candidate, this.options);
    return this.session;
  }

  async cleanupPendingConnection(): Promise<void> {
    // The in-memory fake holds no process, port, or file lease.
  }
}

class FakeSignalLabSession implements InstrumentSession {
  readonly driverId = FAKE_DRIVER_ID;
  readonly rfOutput = 'not-supported' as const;
  readonly sessionId = `session:${FAKE_DRIVER_ID}`;
  readonly candidate: InstrumentCandidate;
  capabilities: InstrumentCapabilities;
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  readonly #sequenceQueue: number[];
  #epoch = 1;
  #autoSequence = 0;
  #configuration: InstrumentConfigurationCommand | undefined;
  #configurationEpoch = 0;
  #closed = false;

  constructor(candidate: InstrumentCandidate, options: FakeOptions) {
    this.candidate = candidate;
    this.capabilities = fakeCapabilities(INITIAL_PROFILE_ID);
    this.#sequenceQueue = [...(options.sequences ?? [])];
  }

  get provenance(): InstrumentSessionProvenance {
    return {
      sourceKind: 'signal-lab',
      sourceId: FAKE_SOURCE_ID,
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      verifiedAt: CAPTURED_AT,
      producerConfigurationEpoch: `producer-epoch:${this.#epoch}`,
      contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 1,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorSha256: 'c'.repeat(64),
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    };
  }

  async configure(command: InstrumentConfigurationCommand): Promise<void> {
    this.#requireOpen();
    if (command.sessionId !== this.sessionId) throw new Error('fake configuration names a different session');
    if (command.configuration.kind !== 'swept-spectrum') throw new Error('fake session admits only swept-spectrum configurations');
    this.#configuration = structuredClone(command);
    this.#configurationEpoch = this.#epoch;
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    const command = this.#configuration;
    if (!command || command.configuration.kind !== 'swept-spectrum') throw new Error('fake session is not configured');
    if (this.#configurationEpoch !== this.#epoch) throw new Error('fake producer configuration changed after admission');
    const sequence = this.#sequenceQueue.length > 0 ? this.#sequenceQueue.shift()! : ++this.#autoSequence;
    const { startHz, stopHz, points } = command.configuration;
    const stepHz = (stopHz - startHz) / (points - 1);
    return {
      schemaVersion: 1,
      measurementId: `measurement:${sequence}:${command.configurationRevision}`,
      sessionId: this.sessionId,
      configurationRevision: command.configurationRevision,
      producerConfigurationEpoch: `producer-epoch:${this.#epoch}`,
      sequence,
      capturedAt: CAPTURED_AT,
      elapsedMilliseconds: 50,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: 'synthetic-visual-projection',
      complete: true,
      kind: 'swept-spectrum',
      frequencyHz: Array.from({ length: points }, (_, index) => startHz + stepHz * index),
      powerDbm: Array.from({ length: points }, () => -80),
    };
  }

  async executeFeature(command: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.#requireOpen();
    if (command.sessionId !== this.sessionId) throw new Error('fake feature names a different session');
    if (command.kind !== 'signal-lab-profile-selection' || command.action !== 'select-profile') {
      throw new Error(`fake session does not implement feature ${command.kind}`);
    }
    const source = this.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    if (source?.kind !== 'signal-lab-profile-selection'
      || !source.profiles.some((profile) => profile.profileId === command.profileId)) {
      throw new Error(`fake session does not advertise profile ${command.profileId}`);
    }
    // A source mutation invalidates any prior acquisition binding and really
    // advances the producer configuration epoch, like the browser driver.
    this.#configuration = undefined;
    this.#epoch++;
    this.capabilities = fakeCapabilities(command.profileId);
    return {
      sessionId: this.sessionId,
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: command.profileId,
      producerConfigurationEpoch: `producer-epoch:${this.#epoch}`,
    };
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('fake session is closed');
  }
}

function candidateDescriptor(): InstrumentCandidateDescriptor {
  return {
    schemaVersion: 1,
    driverId: FAKE_DRIVER_ID,
    candidateId: `${FAKE_DRIVER_ID}:${FAKE_SOURCE_ID}`,
    displayName: 'SignalLab · Fake',
    sourceKind: 'signal-lab',
    signalLab: { sourceId: FAKE_SOURCE_ID },
  };
}

/** Capability shape modeled on BrowserSignalLabSession#buildCapabilities. */
function fakeCapabilities(selectedProfileId: string): InstrumentCapabilities {
  return {
    schemaVersion: 1,
    acquisitions: [
      {
        kind: 'swept-spectrum',
        frequencyHz: { min: 1, max: 6_000_000_000, step: 1 },
        points: { min: 2, max: 450, step: 1 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: syntheticScalarControls(),
        powerUnit: 'dBm',
      },
      {
        kind: 'detected-power-timeseries',
        centerFrequencyHz: { min: 1, max: 6_000_000_000, step: 1 },
        sampleCount: { min: 1, max: 450, step: 1 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: syntheticScalarControls(),
        powerUnit: 'dBm',
        timing: 'uniform',
      },
    ],
    features: [{
      kind: 'signal-lab-profile-selection',
      profiles: [
        {
          profileId: INITIAL_PROFILE_ID,
          label: 'CW',
          family: 'tone',
          model: 'cw-model',
          qualification: 'visual',
          centerFrequencyHz: 100_000_000,
          occupiedBandwidthHz: 1,
          recommendedSpanHz: 2_000_000,
          projection: { allocation: 'carrier', modulation: 'unmodulated', timing: 'continuous' },
          source: {
            organization: 'TinySA SignalLab',
            references: [{
              specification: 'SignalLab fixture',
              clause: 'CW',
              revision: '1',
              url: 'https://example.test/signal-lab/cw',
            }],
          },
          disclosure: 'Analytic fixture profile.',
        },
        {
          profileId: OTHER_PROFILE_ID,
          label: 'LTE E-TM 1.1',
          family: 'e-utra',
          model: 'E-TM 1.1',
          qualification: 'standards-derived',
          centerFrequencyHz: 1_842_500_000,
          occupiedBandwidthHz: 9_000_000,
          recommendedSpanHz: 12_000_000,
          projection: {
            allocation: 'full',
            modulation: 'ofdm-mixed',
            timing: 'frame',
            duplex: 'fdd',
            subcarrierSpacingHz: 15_000,
            nominalResourceBlocks: 50,
          },
          source: {
            organization: '3GPP',
            references: [{
              specification: 'TS 36.141',
              clause: '6.1',
              revision: 'Release 18',
              url: 'https://www.3gpp.org/dynareport/36141.htm',
            }],
          },
          disclosure: 'Standards-derived deterministic fixture projection.',
        },
      ],
      selectedProfileId,
    }],
  };
}

function syntheticSweepConfiguration() {
  return {
    kind: 'swept-spectrum' as const,
    startHz: 100,
    stopHz: 300,
    points: 3,
    sweepTimeSeconds: 0.05,
    controls: syntheticScalarControls(),
  };
}

function syntheticScalarControls() {
  return {
    schemaVersion: 1 as const,
    model: 'synthetic-scalar' as const,
    timingQualification: 'simulation-exact' as const,
  };
}

function deterministicRuntime(): InstrumentManagerRuntime {
  const counters = { discovery: 0, configuration: 0 };
  return {
    now: () => new Date(CAPTURED_AT),
    opaqueId: (scope) => `${scope}:${++counters[scope]}`,
  };
}
