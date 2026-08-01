import { describe, expect, it } from 'vitest';
import type {
  CanonicalInstrumentSurface,
  CanonicalOperationRequest,
  InstrumentCandidate,
  InstrumentConfiguration,
  InstrumentConfigurationCommand,
  InstrumentDriverDiscoveryResult,
  InstrumentFeatureCommand,
  InstrumentFeatureResult,
  InstrumentMeasurement,
  InstrumentSessionEvent,
  InstrumentSessionProvenance,
} from '@tinysa/contracts';
import { InstrumentDriverRegistry } from './instrument-driver-registry.js';
import { InstrumentManager } from './instrument-manager.js';
import type { CanonicalOperationResolution, InstrumentDriver, InstrumentSession } from './instrument-driver.js';

const descriptor = {
  schemaVersion: 1,
  driverId: 'canonical-fixture',
  candidateId: 'capture:fixture',
  displayName: 'Capture fixture',
  sourceKind: 'neptune-p210',
  neptuneP210: { endpoint: 'ip:192.0.2.10' },
} as const;

const capabilities = {
  schemaVersion: 1,
  acquisitions: [{
    kind: 'complex-iq',
    centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000, step: 1 },
    sampleRateHz: { min: 1_000_000, max: 20_000_000, step: 1 },
    bandwidthHz: { min: 200_000, max: 20_000_000, step: 1 },
    sampleCount: { min: 128, max: 1_000_000, step: 1 },
    sampleFormat: 'ci16le',
  }],
  features: [],
} as const;

function surface(revision = 'surface:1'): CanonicalInstrumentSurface {
  return {
    schemaVersion: 1,
    revision,
    presentation: { title: 'Capture fixture', qualification: 'DRIVER COMMAND', facts: [] },
    parameters: [
      {
        id: 'capture.tune', label: 'Tune', group: 'Capture', unit: 'Hz',
        manual: { kind: 'integer', range: capabilities.acquisitions[0].centerFrequencyHz },
        auto: { resolver: 'driver', description: 'Driver chooses the receive tune.' },
        requested: { mode: 'auto' }, effectiveValue: 99_000_000, verification: 'driver-selected',
      },
      {
        id: 'capture.rate', label: 'Rate', group: 'Capture', unit: 'Hz',
        manual: { kind: 'integer', range: capabilities.acquisitions[0].sampleRateHz },
        auto: { resolver: 'driver', description: 'Driver chooses the sample rate.' },
        requested: { mode: 'auto' }, effectiveValue: 10_000_000, verification: 'driver-selected',
      },
    ],
    operations: [{
      id: 'capture', label: 'Capture', parameterIds: ['capture.tune', 'capture.rate'],
      outputs: ['Complex I/Q'], availability: 'available', primary: true, confirmation: 'none',
    }],
  };
}

describe('canonical operation manager', () => {
  it('lets the driver resolve Auto, then admits the resulting configuration through the normal lifecycle', async () => {
    const fixture = new CanonicalCaptureSession();
    const driver = new FixtureDriver(fixture);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), {
      now: () => new Date('2026-08-01T00:00:00.000Z'),
      opaqueId: () => 'configuration:canonical',
    });
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    const offered = manager.canonicalSurface();
    expect(offered?.operations[0]?.primary).toBe(true);

    const result = await manager.executeCanonicalOperation({
      sessionId: fixture.sessionId,
      surfaceRevision: offered!.revision,
      operationId: 'capture',
      parameters: [
        { parameterId: 'capture.tune', intent: { mode: 'manual', value: 100_000_000 } },
        { parameterId: 'capture.rate', intent: { mode: 'auto' } },
      ],
    });

    expect(fixture.configureCalls).toEqual([{
      kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 10_000_000,
      bandwidthHz: 8_000_000, sampleCount: 4_096, sampleFormat: 'ci16le',
    }]);
    expect(manager.snapshot()?.configuration?.configuration.kind).toBe('complex-iq');
    expect(result.surface.parameters.map((parameter) => parameter.requested)).toEqual([
      { mode: 'manual', value: 100_000_000 }, { mode: 'auto' },
    ]);
    await manager.disconnect();
  });

  it('rejects a stale surface before it reaches a driver', async () => {
    const fixture = new CanonicalCaptureSession();
    const manager = new InstrumentManager(new InstrumentDriverRegistry([new FixtureDriver(fixture)]), {
      now: () => new Date('2026-08-01T00:00:00.000Z'),
      opaqueId: () => 'configuration:canonical',
    });
    await manager.connect((await manager.discover()).candidates[0]!);
    await expect(manager.executeCanonicalOperation({
      sessionId: fixture.sessionId,
      surfaceRevision: 'surface:stale',
      operationId: 'capture',
      parameters: [
        { parameterId: 'capture.tune', intent: { mode: 'auto' } },
        { parameterId: 'capture.rate', intent: { mode: 'auto' } },
      ],
    })).rejects.toMatchObject({ code: 'stale-candidate' });
    expect(fixture.resolveCalls).toBe(0);
    await manager.disconnect();
  });
});

class FixtureDriver implements InstrumentDriver {
  readonly driverId = 'canonical-fixture' as const;
  readonly sourceKinds = ['neptune-p210'] as const;

  constructor(private readonly session: CanonicalCaptureSession) {}

  async discover(): Promise<InstrumentDriverDiscoveryResult> { return { candidates: [descriptor], failures: [] }; }
  async connect(candidate: InstrumentCandidate): Promise<InstrumentSession> { this.session.candidate = candidate; return this.session; }
  async cleanupPendingConnection(): Promise<void> {}
}

class CanonicalCaptureSession implements InstrumentSession {
  readonly sessionId = 'session:canonical-fixture';
  readonly driverId = 'canonical-fixture' as const;
  candidate!: InstrumentCandidate;
  readonly provenance: InstrumentSessionProvenance = {
    sourceKind: 'neptune-p210', execution: 'physical', transport: 'libiio-network',
    qualification: 'device-observed', verifiedAt: '2026-08-01T00:00:00.000Z', endpoint: 'ip:192.0.2.10',
  };
  readonly capabilities = capabilities;
  readonly rfOutput = 'not-supported' as const;
  readonly configureCalls: InstrumentConfiguration[] = [];
  resolveCalls = 0;

  get canonicalSurface(): CanonicalInstrumentSurface { return surface(); }

  async resolveCanonicalOperation(request: CanonicalOperationRequest): Promise<CanonicalOperationResolution> {
    this.resolveCalls++;
    const tune = request.parameters.find((parameter) => parameter.parameterId === 'capture.tune');
    return {
      configuration: {
        kind: 'complex-iq',
        centerHz: tune?.intent.mode === 'manual' && typeof tune.intent.value === 'number' ? tune.intent.value : 99_000_000,
        sampleRateHz: 10_000_000,
        bandwidthHz: 8_000_000,
        sampleCount: 4_096,
        sampleFormat: 'ci16le',
      },
    };
  }

  async configure(command: InstrumentConfigurationCommand): Promise<void> { this.configureCalls.push(command.configuration); }
  async acquire(): Promise<InstrumentMeasurement> { throw new Error('not needed'); }
  async executeFeature(_command: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> { throw new Error('not needed'); }
  async disconnect(): Promise<void> {}
  subscribe(_listener: (event: InstrumentSessionEvent) => void): () => void { return () => undefined; }
}
