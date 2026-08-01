import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLEX_IQ_SAMPLES_V1,
  complexIqPayloadByteLength,
  instrumentCapabilitiesSchema,
  instrumentCapabilitySourceBindingIssues,
  instrumentConfigurationCommandSchema,
  instrumentMeasurementSchema,
  instrumentSessionSnapshotSchema,
  neptuneP210CandidateDescriptorSchema,
  neptuneP210SessionProvenanceSchema,
  neptuneP210TwinCandidateDescriptorSchema,
  neptuneP210TwinSessionProvenanceSchema,
  type InstrumentCandidate,
  type InstrumentConfigurationCommand,
  type InstrumentFeatureCommand,
} from '@tinysa/contracts';
import {
  InstrumentDriverRegistry,
  InstrumentManager,
  validateInstrumentDriver,
  validateInstrumentDriverDiscoveryResult,
  validateInstrumentSession,
  type InstrumentManagerRuntime,
} from '@tinysa/instrument-runtime';
import {
  NEPTUNE_P210_ENDPOINT_ENV_VAR,
  NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES,
  NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES,
  NEPTUNE_P210_MAX_SAMPLE_COUNT,
  NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ,
  NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR,
  NeptuneP210InstrumentDriver,
  type NeptuneTransportLike,
  type RecentDeviceStoreLike,
} from './neptune-p210-instrument-driver.js';
import type { RecentP210DeviceRecord } from './recent-devices-store.js';
import type {
  AttributeReadResult,
  CaptureParams,
  CaptureResult,
  IioProbeResult,
  NetworkScanCandidate,
} from './iio-transport.js';

const PHYSICAL_ENDPOINT = 'ip:10.0.0.250';
const TWIN_ENDPOINT = 'ip:127.0.0.1';

class FakeTransport implements NeptuneTransportLike {
  readonly calls: string[] = [];
  readonly setCenterFrequencyHzCalls: number[] = [];
  readonly getCenterFrequencyHzCalls: string[] = [];
  readonly setSampleRateHzCalls: number[] = [];
  readonly setRfBandwidthHzCalls: number[] = [];
  readonly captureCalls: CaptureParams[] = [];
  centerFrequencyHzReadback = 2_400_000_000;
  probeContextImpl: (uri: string) => Promise<IioProbeResult> = async (uri) => okProbe(uri);
  getDeviceAttributeImpl: (uri: string, device: string, channel: string, attribute: string) => Promise<AttributeReadResult> =
    async () => { throw new Error('no _available attribute on this fake device'); };
  getCenterFrequencyHzImpl: (uri: string) => Promise<number> = async () => this.centerFrequencyHzReadback;
  captureImpl: (params: CaptureParams) => Promise<CaptureResult> = async (params) => defaultCapture(params);
  scanNetworkImpl: () => Promise<readonly NetworkScanCandidate[]> = async () => [];
  disposeImpl: () => Promise<void> = async () => undefined;

  async probeContext(uri: string): Promise<IioProbeResult> {
    this.calls.push('probeContext');
    return this.probeContextImpl(uri);
  }

  async getDeviceAttribute(uri: string, device: string, channel: string, attribute: string): Promise<AttributeReadResult> {
    this.calls.push(`getDeviceAttribute:${attribute}`);
    return this.getDeviceAttributeImpl(uri, device, channel, attribute);
  }

  async setCenterFrequencyHz(_uri: string, hz: number): Promise<void> {
    this.calls.push('setCenterFrequencyHz');
    this.setCenterFrequencyHzCalls.push(hz);
    this.centerFrequencyHzReadback = Math.round(hz);
  }

  async getCenterFrequencyHz(uri: string): Promise<number> {
    this.calls.push('getCenterFrequencyHz');
    this.getCenterFrequencyHzCalls.push(uri);
    return this.getCenterFrequencyHzImpl(uri);
  }

  async setSampleRateHz(_uri: string, hz: number): Promise<void> {
    this.calls.push('setSampleRateHz');
    this.setSampleRateHzCalls.push(hz);
  }

  async setRfBandwidthHz(_uri: string, hz: number): Promise<void> {
    this.calls.push('setRfBandwidthHz');
    this.setRfBandwidthHzCalls.push(hz);
  }

  async capture(params: CaptureParams): Promise<CaptureResult> {
    this.calls.push('capture');
    this.captureCalls.push(structuredClone(params));
    return this.captureImpl(params);
  }

  async scanNetwork(): Promise<readonly NetworkScanCandidate[]> {
    this.calls.push('scanNetwork');
    return this.scanNetworkImpl();
  }

  async dispose(): Promise<void> {
    this.calls.push('dispose');
    return this.disposeImpl();
  }
}

function okProbe(uri: string): IioProbeResult {
  return {
    ok: true,
    uri,
    device: 'ad9361-phy',
    channel: 'altvoltage0',
    attribute: 'frequency',
    raw: '2400000000',
    numeric: 2_400_000_000,
    durationMs: 5,
  };
}

type ProbeFailureReason = 'tooling-not-found' | 'timeout' | 'unreachable' | 'unexpected-exit';

function failedProbe(uri: string, reason: ProbeFailureReason): IioProbeResult {
  return {
    ok: false,
    uri,
    reason,
    message: `simulated ${reason}`,
    durationMs: 5,
  };
}

function defaultCapture(params: CaptureParams): CaptureResult {
  return {
    iq: new Uint8Array(params.sampleCount * 4).fill(7),
    byteLength: params.sampleCount * 4,
    sampleCount: params.sampleCount,
    bytesPerSample: 4,
    device: 'cf-ad9361-lpc',
    channels: ['voltage0', 'voltage1'],
    durationMs: 12,
  };
}

function deterministicDriver(
  transport: FakeTransport,
  env: Readonly<Record<string, string | undefined>>,
  idPrefix = 'id',
) {
  let counter = 0;
  return new NeptuneP210InstrumentDriver({
    createTransport: () => transport,
    // Deliberately a separate, throwaway fake so discover()'s best-effort
    // scan step (a legitimate, always-run part of discover() now) never
    // appends to `transport.calls` -- tests below assert exact call
    // sequences against `transport` for the explicit candidate lifecycle
    // they are actually testing, not the independent scan.
    createScanTransport: () => new FakeTransport(),
    now: () => new Date('2026-07-31T12:00:00.000Z'),
    generateId: () => `${idPrefix}:${++counter}`,
    env,
    // The frozen clock above means every acquire() call's pacing-floor
    // computation sees zero elapsed time, which would otherwise force a
    // real NEPTUNE_P210_MIN_CAPTURE_INTERVAL_MS wait on every call after the
    // first in any test exercising repeated acquisitions. Dedicated pacing/
    // circuit-breaker tests below inject their own controllable sleep/now
    // instead of using this helper.
    sleep: async () => undefined,
  });
}

async function connectedSession(overrides: {
  transport?: FakeTransport;
  env?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const transport = overrides.transport ?? new FakeTransport();
  const env = overrides.env ?? { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT };
  const driver = deterministicDriver(transport, env);
  const discovery = await driver.discover();
  const descriptor = discovery.candidates[0]!;
  const candidate = { ...descriptor, discoveryRevision: 'discovery:1' } as InstrumentCandidate;
  const session = await driver.connect(candidate);
  return { driver, transport, candidate, session };
}

function configureCommand(sessionId: string, overrides: Partial<{
  centerHz: number;
  sampleRateHz: number;
  bandwidthHz: number;
  sampleCount: number;
  sampleFormat: string;
}> = {}): InstrumentConfigurationCommand {
  return instrumentConfigurationCommandSchema.parse({
    sessionId,
    configurationRevision: 'configuration:1',
    configuration: {
      kind: 'complex-iq',
      centerHz: overrides.centerHz ?? 2_400_000_000,
      sampleRateHz: overrides.sampleRateHz ?? 10_000_000,
      bandwidthHz: overrides.bandwidthHz ?? 8_000_000,
      sampleCount: overrides.sampleCount ?? 4_096,
      sampleFormat: overrides.sampleFormat ?? 'ci16le',
    },
  });
}

describe('NeptuneP210InstrumentDriver discovery', () => {
  it('returns clean empty discovery when neither endpoint variable is set', async () => {
    const driver = deterministicDriver(new FakeTransport(), {});
    const result = await driver.discover();
    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('probes NEPTUNE_P210_ENDPOINT and returns a strict neptune-p210 candidate on success', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const result = await driver.discover();
    expect(result.failures).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const candidate = neptuneP210CandidateDescriptorSchema.parse(result.candidates[0]);
    expect(candidate.sourceKind).toBe('neptune-p210');
    expect(candidate.driverId).toBe('neptune-p210');
    expect(candidate.neptuneP210).toEqual({ endpoint: PHYSICAL_ENDPOINT });
    expect(transport.calls).toEqual(['probeContext']);
  });

  it('probes NEPTUNE_P210_TWIN_ENDPOINT and returns a strict neptune-p210-twin candidate on success', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR]: TWIN_ENDPOINT });
    const result = await driver.discover();
    expect(result.failures).toEqual([]);
    const candidate = neptuneP210TwinCandidateDescriptorSchema.parse(result.candidates[0]);
    expect(candidate.sourceKind).toBe('neptune-p210-twin');
    expect(candidate.neptuneP210Twin).toEqual({
      endpoint: TWIN_ENDPOINT,
      profile: 'qemu-development',
      physicalRfModeled: false,
    });
  });

  it('discovers both source kinds independently when both variables are set', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, {
      [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT,
      [NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR]: TWIN_ENDPOINT,
    });
    const result = await driver.discover();
    expect(result.candidates.map((candidate) => candidate.sourceKind).sort()).toEqual(['neptune-p210', 'neptune-p210-twin']);
  });

  it('reports a recoverable source-unavailable failure without throwing when the probe is unreachable', async () => {
    const transport = new FakeTransport();
    transport.probeContextImpl = async (uri) => failedProbe(uri, 'unreachable');
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const result = await driver.discover();
    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([{
      sourceKind: 'neptune-p210',
      code: 'source-unavailable',
      recoverable: true,
      message: expect.stringContaining('unreachable'),
    }]);
  });

  it('reports a non-recoverable driver-failure when libiio tooling is missing', async () => {
    const transport = new FakeTransport();
    transport.probeContextImpl = async (uri) => failedProbe(uri, 'tooling-not-found');
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const result = await driver.discover();
    expect(result.failures[0]).toMatchObject({ code: 'driver-failure', recoverable: false });
  });

  it('round-trips through the runtime discovery-result validator', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, {
      [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT,
      [NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR]: TWIN_ENDPOINT,
    });
    const validated = validateInstrumentDriver(driver);
    const result = await validated.discover();
    expect(() => validateInstrumentDriverDiscoveryResult(driver, result)).not.toThrow();
  });
});

class FakeRecentDeviceStore implements RecentDeviceStoreLike {
  readonly recorded: Array<{ sourceKind: string; endpoint: string; contextDescription?: string }> = [];
  records: RecentP210DeviceRecord[] = [];

  async list(): Promise<readonly RecentP210DeviceRecord[]> {
    return this.records;
  }

  async record(entry: { sourceKind: 'neptune-p210' | 'neptune-p210-twin'; endpoint: string; contextDescription?: string }): Promise<void> {
    this.recorded.push(entry);
    this.records = this.records.filter((record) => !(record.sourceKind === entry.sourceKind && record.endpoint === entry.endpoint));
    this.records.push({ ...entry, connectedAt: '2026-07-31T12:00:00.000Z' });
  }
}

describe('NeptuneP210InstrumentDriver recent-device rediscovery', () => {
  it('re-probes a remembered device live and returns it as a normal, fully-verified candidate', async () => {
    const transport = new FakeTransport();
    const store = new FakeRecentDeviceStore();
    store.records = [{ sourceKind: 'neptune-p210', endpoint: PHYSICAL_ENDPOINT, connectedAt: '2026-07-30T12:00:00.000Z' }];
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      generateId: () => 'id:1',
      env: {},
      recentDevicesStore: store,
    });
    const result = await driver.discover();
    expect(result.failures).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceKind).toBe('neptune-p210');
  });

  it('reports a remembered device that no longer responds as an honest, timestamped discovery failure -- never as a live candidate', async () => {
    const transport = new FakeTransport();
    transport.probeContextImpl = async (uri) => failedProbe(uri, 'unreachable');
    const store = new FakeRecentDeviceStore();
    store.records = [{
      sourceKind: 'neptune-p210',
      endpoint: PHYSICAL_ENDPOINT,
      contextDescription: 'PlutoSDR Rev.B',
      connectedAt: '2026-07-29T12:00:00.000Z', // 2 days before "now" below
    }];
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      generateId: () => 'id:1',
      env: {},
      recentDevicesStore: store,
    });
    const result = await driver.discover();
    expect(result.candidates).toEqual([]);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0]!;
    expect(failure.sourceKind).toBe('neptune-p210');
    expect(failure.code).toBe('source-unavailable');
    expect(failure.recoverable).toBe(true);
    expect(failure.message).toContain('Last connected 2 days ago');
    expect(failure.message).toContain(PHYSICAL_ENDPOINT);
    expect(failure.message).toContain('PlutoSDR Rev.B');
    expect(failure.message).toContain('not currently reachable');
  });

  it('does not probe the same endpoint twice when both an env var and a remembered record name it', async () => {
    const transport = new FakeTransport();
    const store = new FakeRecentDeviceStore();
    store.records = [{ sourceKind: 'neptune-p210', endpoint: PHYSICAL_ENDPOINT, connectedAt: '2026-07-30T12:00:00.000Z' }];
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      generateId: () => 'id:1',
      env: { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT },
      recentDevicesStore: store,
    });
    const result = await driver.discover();
    expect(result.candidates).toHaveLength(1);
    expect(transport.calls.filter((call) => call === 'probeContext')).toHaveLength(1);
  });

  it('records a successful connect() into the store so the device is remembered on the next launch', async () => {
    const transport = new FakeTransport();
    const store = new FakeRecentDeviceStore();
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      generateId: () => 'id:1',
      env: { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT },
      recentDevicesStore: store,
    });
    const discovery = await driver.discover();
    const candidate = { ...discovery.candidates[0]!, discoveryRevision: 'discovery:1' } as InstrumentCandidate;
    await driver.connect(candidate);
    expect(store.recorded).toContainEqual({ sourceKind: 'neptune-p210', endpoint: PHYSICAL_ENDPOINT });
  });
});

describe('NeptuneP210InstrumentDriver addManualEndpoint()', () => {
  it('probes the given address live and records it into the store on success', async () => {
    const transport = new FakeTransport();
    const store = new FakeRecentDeviceStore();
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      generateId: () => 'id:1',
      env: {},
      recentDevicesStore: store,
    });
    const outcome = await driver.addManualEndpoint(` ${PHYSICAL_ENDPOINT} `);
    expect(outcome).toEqual({ ok: true });
    expect(store.recorded).toEqual([{ sourceKind: 'neptune-p210', endpoint: PHYSICAL_ENDPOINT }]);
  });

  it('reports a clear failure and records nothing when the address does not respond', async () => {
    const transport = new FakeTransport();
    transport.probeContextImpl = async (uri) => failedProbe(uri, 'unreachable');
    const store = new FakeRecentDeviceStore();
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      generateId: () => 'id:1',
      env: {},
      recentDevicesStore: store,
    });
    const outcome = await driver.addManualEndpoint(PHYSICAL_ENDPOINT);
    expect(outcome.ok).toBe(false);
    expect(store.recorded).toEqual([]);
  });

  it('rejects an empty address without touching the transport', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, {});
    const outcome = await driver.addManualEndpoint('   ');
    expect(outcome.ok).toBe(false);
    expect(transport.calls).toEqual([]);
  });
});

describe('NeptuneP210InstrumentDriver connect()', () => {
  it('rejects a candidate that was never returned by discovery', async () => {
    const driver = deterministicDriver(new FakeTransport(), { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    await driver.discover();
    const foreign = neptuneP210CandidateDescriptorSchema.parse({
      schemaVersion: 1,
      driverId: 'neptune-p210',
      candidateId: 'neptune-p210:ip:9.9.9.9',
      displayName: 'Foreign candidate',
      sourceKind: 'neptune-p210',
      neptuneP210: { endpoint: 'ip:9.9.9.9' },
    });
    await expect(driver.connect({ ...foreign, discoveryRevision: 'discovery:1' } as InstrumentCandidate))
      .rejects.toThrow(/no longer matches the latest driver discovery/);
  });

  it('rejects a stale/mutated candidate sharing a candidateId with the latest discovery', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const discovery = await driver.discover();
    const descriptor = discovery.candidates[0]!;
    if (descriptor.sourceKind !== 'neptune-p210') throw new Error('unreachable');
    const mutated = {
      ...descriptor,
      neptuneP210: { endpoint: 'ip:255.255.255.255' },
      discoveryRevision: 'discovery:1',
    } as InstrumentCandidate;
    await expect(driver.connect(mutated)).rejects.toThrow(/no longer matches the latest driver discovery/);
  });

  it('issues the connection-first probe as the first transport call and never writes before it', async () => {
    const { transport, session } = await connectedSession();
    expect(transport.calls[0]).toBe('probeContext');
    // Every call made during connect() (probe plus capability range queries)
    // must be read-only -- never a set*/capture call.
    expect(transport.calls.every((call) => call === 'probeContext' || call.startsWith('getDeviceAttribute'))).toBe(true);
    expect(session.rfOutput).toBe('not-supported');
    expect(session.receiveOnlySafety).toBeUndefined();
  });

  it('opens a physical session with strictly bound provenance and complex-I/Q-only capabilities', async () => {
    const { session } = await connectedSession();
    const provenance = neptuneP210SessionProvenanceSchema.parse(session.provenance);
    expect(provenance).toMatchObject({
      sourceKind: 'neptune-p210',
      execution: 'physical',
      transport: 'libiio-network',
      qualification: 'device-observed',
      endpoint: PHYSICAL_ENDPOINT,
    });
    const capabilities = instrumentCapabilitiesSchema.parse(session.capabilities);
    expect(instrumentCapabilitySourceBindingIssues('neptune-p210', capabilities)).toEqual([]);
    expect(capabilities.features).toEqual([]);
    const iq = capabilities.acquisitions.find((entry) => entry.kind === 'complex-iq');
    expect(iq?.kind === 'complex-iq' && iq.sampleFormat).toBe('ci16le');
  });

  it('opens a QEMU-twin session with strictly bound provenance', async () => {
    const transport = new FakeTransport();
    const { session } = await connectedSession({ transport, env: { [NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR]: TWIN_ENDPOINT } });
    const provenance = neptuneP210TwinSessionProvenanceSchema.parse(session.provenance);
    expect(provenance).toMatchObject({
      sourceKind: 'neptune-p210-twin',
      execution: 'firmware-executed-twin',
      qualification: 'firmware-executed-twin',
      endpoint: TWIN_ENDPOINT,
      profile: 'qemu-development',
      physicalRfModeled: false,
    });
  });

  it('derives capability ranges from a live `_available` attribute when the device exposes one', async () => {
    const transport = new FakeTransport();
    transport.getDeviceAttributeImpl = async (_uri, _device, _channel, attribute) => {
      if (attribute === 'sampling_frequency_available') return { raw: '[521000 1 61440000]', numeric: null };
      throw new Error('no other _available attribute on this fake device');
    };
    const { session } = await connectedSession({ transport });
    const capabilities = instrumentCapabilitiesSchema.parse(session.capabilities);
    const iq = capabilities.acquisitions.find((entry) => entry.kind === 'complex-iq');
    expect(iq?.kind === 'complex-iq' && iq.sampleRateHz).toEqual({ min: 521_000, max: 61_440_000 });
  });

  it('falls back to the documented AD9361/P210 bounds when no `_available` attribute is readable', async () => {
    const { session } = await connectedSession();
    const capabilities = instrumentCapabilitiesSchema.parse(session.capabilities);
    const iq = capabilities.acquisitions.find((entry) => entry.kind === 'complex-iq');
    if (iq?.kind !== 'complex-iq') throw new Error('unreachable');
    expect(iq.centerFrequencyHz).toEqual(NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES.centerFrequencyHz);
    expect(iq.sampleRateHz).toEqual(NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES.sampleRateHz);
    expect(iq.bandwidthHz).toEqual(NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES.bandwidthHz);
    expect(iq.sampleCount).toEqual({ min: 1, max: NEPTUNE_P210_MAX_SAMPLE_COUNT });
  });

  it('rejects connect() when the connection-first probe fails, without ever setting an attribute', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    // Discovery's own probe must still succeed so a real candidate exists;
    // only the connection-first probe issued from connect() fails.
    const discovery = await driver.discover();
    const candidate = { ...discovery.candidates[0]!, discoveryRevision: 'discovery:1' } as InstrumentCandidate;
    transport.probeContextImpl = async (uri) => failedProbe(uri, 'unreachable');
    transport.calls.length = 0;
    await expect(driver.connect(candidate)).rejects.toThrow(/connection-first probe/);
    expect(transport.setCenterFrequencyHzCalls).toEqual([]);
    expect(transport.calls).toEqual(['probeContext']);
  });

  it('produces a full public session snapshot that satisfies instrumentSessionSnapshotSchema', async () => {
    const { session } = await connectedSession();
    const snapshot = instrumentSessionSnapshotSchema.parse({
      sessionId: session.sessionId,
      driverId: session.driverId,
      candidate: session.candidate,
      provenance: session.provenance,
      capabilities: session.capabilities,
      rfOutput: session.rfOutput,
      rfOutputQualification: 'not-applicable',
    });
    expect(snapshot.rfOutput).toBe('not-supported');
  });

  it('validates end to end through validateInstrumentSession (the full runtime admission path)', async () => {
    const { driver, candidate, session } = await connectedSession();
    expect(() => validateInstrumentSession(driver, candidate, session)).not.toThrow();
  });
});

describe('NeptuneP210InstrumentDriver pending-connection lease / cleanupPendingConnection()', () => {
  it('is a genuine no-op when no connect() attempt is pending', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, {});
    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(transport.calls).toEqual([]);
  });

  it('retains a failed-connect transport lease, fails to clear it once, then succeeds on retry', async () => {
    const transport = new FakeTransport();
    let disposeAttempts = 0;
    transport.disposeImpl = async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error('leaked iio_readdev child did not exit');
    };
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    // Discovery's own probe must still succeed so a real candidate exists;
    // only the connection-first probe issued from connect() fails.
    const discovery = await driver.discover();
    const candidate = { ...discovery.candidates[0]!, discoveryRevision: 'discovery:1' } as InstrumentCandidate;
    transport.probeContextImpl = async (uri) => failedProbe(uri, 'unreachable');

    await expect(driver.connect(candidate)).rejects.toThrow(/connection-first probe/);

    // First cleanup attempt fails and must leave the lease retained.
    await expect(driver.cleanupPendingConnection()).rejects.toThrow(/leaked iio_readdev child did not exit/);
    expect(disposeAttempts).toBe(1);

    // A reconnect attempt must not silently paper over the still-pending lease
    // by opening a second transport concurrently.
    await expect(driver.connect(candidate)).rejects.toThrow(/already has a connection attempt in progress/);

    // Retry succeeds and clears the lease.
    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(disposeAttempts).toBe(2);

    // Idempotent: a further call is a genuine no-op, no additional dispose.
    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();
    expect(disposeAttempts).toBe(2);
  });

  it('never retains a lease across a successful connect(); the session owns teardown afterward', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const discovery = await driver.discover();
    const candidate = { ...discovery.candidates[0]!, discoveryRevision: 'discovery:1' } as InstrumentCandidate;
    await driver.connect(candidate);
    // cleanupPendingConnection() must be a no-op post-admission: it must
    // never reach into (and dispose) an admitted session's live transport.
    await driver.cleanupPendingConnection();
    expect(transport.calls).not.toContain('dispose');
  });
});

describe('NeptuneP210InstrumentSession configure()', () => {
  it('sends every admitted field to the transport and verifies the RX LO readback', async () => {
    const { transport, session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId, {
      centerHz: 2_437_000_000, sampleRateHz: 20_000_000, bandwidthHz: 18_000_000, sampleCount: 8_192,
    }));
    expect(transport.setCenterFrequencyHzCalls).toEqual([2_437_000_000]);
    expect(transport.getCenterFrequencyHzCalls).toEqual([PHYSICAL_ENDPOINT]);
    expect(transport.setSampleRateHzCalls).toEqual([20_000_000]);
    expect(transport.setRfBandwidthHzCalls).toEqual([18_000_000]);
  });

  it('accepts only the one-Hz RX LO readback allowance for integer device quantization', async () => {
    const { transport, session } = await connectedSession();
    transport.getCenterFrequencyHzImpl = async () => 2_437_000_000 + NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ;

    await expect(session.configure(configureCommand(session.sessionId, { centerHz: 2_437_000_000 })))
      .resolves.toBeUndefined();
  });

  it('fails closed when the RX LO readback materially differs from the requested tune', async () => {
    const { transport, session } = await connectedSession();
    const firstCenterHz = 2_400_000_000;
    const rejectedCenterHz = 2_437_000_000;
    await session.configure(configureCommand(session.sessionId, { centerHz: firstCenterHz }));
    const rateWritesBeforeRejectedRetune = transport.setSampleRateHzCalls.length;
    const bandwidthWritesBeforeRejectedRetune = transport.setRfBandwidthHzCalls.length;
    transport.getCenterFrequencyHzImpl = async () => rejectedCenterHz + NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ + 1;

    await expect(session.configure(configureCommand(session.sessionId, { centerHz: rejectedCenterHz })))
      .rejects.toThrow(/RX LO readback .* does not match requested 2437000000 Hz/);
    // The readback must stop this configuration before unrelated receiver
    // settings are applied, and must revoke the formerly valid A binding.
    expect(transport.setSampleRateHzCalls).toHaveLength(rateWritesBeforeRejectedRetune);
    expect(transport.setRfBandwidthHzCalls).toHaveLength(bandwidthWritesBeforeRejectedRetune);
    await expect(session.acquire()).rejects.toThrow(/not configured/);
  });

  it('rejects a sample format other than ci16le explicitly, never substituting it silently', async () => {
    const { transport, session } = await connectedSession();
    await expect(session.configure(configureCommand(session.sessionId, { sampleFormat: 'cf32le' })))
      .rejects.toThrow(/not honestly satisfiable/);
    expect(transport.calls).not.toContain('setCenterFrequencyHz');
  });

  it('rejects an out-of-range center frequency without touching the transport', async () => {
    const { transport, session } = await connectedSession();
    await expect(session.configure(configureCommand(session.sessionId, { centerHz: 1 })))
      .rejects.toThrow(/outside the advertised capability/);
    expect(transport.calls).not.toContain('setCenterFrequencyHz');
  });

  it('rejects an oversized I/Q sample count via contract schema validation before any driver logic runs', async () => {
    const { transport, session } = await connectedSession();
    const command = {
      sessionId: session.sessionId,
      configurationRevision: 'configuration:1',
      configuration: {
        kind: 'complex-iq',
        centerHz: 2_400_000_000,
        sampleRateHz: 10_000_000,
        bandwidthHz: 8_000_000,
        sampleCount: MAX_COMPLEX_IQ_SAMPLES_V1 + 1,
        sampleFormat: 'ci16le',
      },
    };
    await expect(session.configure(command as unknown as InstrumentConfigurationCommand)).rejects.toThrow();
    expect(transport.calls).not.toContain('setCenterFrequencyHz');
  });

  it('rejects configuration for a different session ID', async () => {
    const { session } = await connectedSession();
    await expect(session.configure(configureCommand('some-other-session'))).rejects.toThrow(/different session/);
  });

  it('revokes a prior binding before dispatch so a partial write failure cannot leave acquire() usable', async () => {
    const { transport, session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId));
    transport.setSampleRateHz = async () => { throw new Error('device rejected sample rate'); };
    await expect(session.configure(configureCommand(session.sessionId, { sampleRateHz: 5_000_000, bandwidthHz: 4_000_000 })))
      .rejects.toThrow(/device rejected sample rate/);
    await expect(session.acquire()).rejects.toThrow(/not configured/);
  });

  it('propagates sequential RX retunes into both capture requests and measurements', async () => {
    const { transport, session } = await connectedSession();
    const firstCenterHz = 2_400_000_000;
    const secondCenterHz = 2_437_000_000;

    await session.configure(configureCommand(session.sessionId, { centerHz: firstCenterHz }));
    const first = await session.acquire();
    await session.configure(configureCommand(session.sessionId, { centerHz: secondCenterHz }));
    const second = await session.acquire();
    if (first.kind !== 'complex-iq' || second.kind !== 'complex-iq') throw new Error('unreachable');

    expect(transport.setCenterFrequencyHzCalls).toEqual([firstCenterHz, secondCenterHz]);
    expect(transport.getCenterFrequencyHzCalls).toEqual([PHYSICAL_ENDPOINT, PHYSICAL_ENDPOINT]);
    expect(transport.captureCalls.map((params) => params.centerFrequencyHz)).toEqual([firstCenterHz, secondCenterHz]);
    expect([first.centerHz, second.centerHz]).toEqual([firstCenterHz, secondCenterHz]);
  });
});

describe('NeptuneP210InstrumentSession acquire()', () => {
  it('maps a capture into a contract-valid complex-I/Q measurement carrying Neptune ADC evidence', async () => {
    const { session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId, { sampleCount: 2_048 }));
    const measurement = await session.acquire();
    const parsed = instrumentMeasurementSchema.parse(measurement);
    if (parsed.kind !== 'complex-iq') throw new Error('unreachable');
    expect(parsed.sampleFormat).toBe('ci16le');
    expect(parsed.sampleCount).toBe(2_048);
    expect(parsed.samples.byteLength).toBe(complexIqPayloadByteLength(2_048, 'ci16le'));
    expect(parsed.adcSignificantBits).toBe(12);
    expect(parsed.adcFullScaleCode).toBe(2048);
    expect(parsed.powerReference).toBe('uncalibrated-dbfs-relative');
    expect(parsed.qualification).toBe('device-observed');
    expect(parsed.sequence).toBe(1);
  });

  it('advances sequence on repeated acquisitions', async () => {
    const { session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId, { sampleCount: 1_024 }));
    const first = await session.acquire();
    const second = await session.acquire();
    expect(second.sequence).toBe(first.sequence + 1);
  });

  it('rejects acquisition before configure()', async () => {
    const { session } = await connectedSession();
    await expect(session.acquire()).rejects.toThrow(/not configured/);
  });

  it('rejects a capture result whose sample count disagrees with the admitted configuration (event/return mismatch)', async () => {
    const { transport, session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId, { sampleCount: 4_096 }));
    transport.captureImpl = async (params) => ({ ...defaultCapture(params), sampleCount: params.sampleCount - 1 });
    await expect(session.acquire()).rejects.toThrow(/does not match the admitted configuration/);
  });

  it('rejects a capture result whose byte length disagrees with its own declared sample count (short/oversized capture)', async () => {
    const { transport, session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId, { sampleCount: 4_096 }));
    transport.captureImpl = async (params) => {
      const honest = defaultCapture(params);
      return { ...honest, iq: new Uint8Array(honest.iq.byteLength + 4) };
    };
    await expect(session.acquire()).rejects.toThrow(/does not match the admitted configuration/);
  });
});

describe('NeptuneP210InstrumentSession acquire() device protection', () => {
  /** Mutable clock + sleep tracker: acquire() reads `this.#now()` at call time, so tests advance `clockMs` between calls to simulate elapsed wall-clock time without ever actually waiting. */
  function clockedSession(transport: FakeTransport, initialMs = 0) {
    const state = { clockMs: initialMs };
    const sleepCalls: number[] = [];
    const counter = { value: 0 };
    const driver = new NeptuneP210InstrumentDriver({
      createTransport: () => transport,
      createScanTransport: () => new FakeTransport(),
      now: () => new Date(state.clockMs),
      generateId: () => `id:${++counter.value}`,
      env: { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT },
      sleep: async (ms) => { sleepCalls.push(ms); },
    });
    return { driver, state, sleepCalls };
  }

  async function connectAndConfigure(driver: NeptuneP210InstrumentDriver, sessionSampleCount = 1_024) {
    const discovery = await driver.discover();
    const descriptor = discovery.candidates[0]!;
    const candidate = { ...descriptor, discoveryRevision: 'discovery:1' } as InstrumentCandidate;
    const session = await driver.connect(candidate);
    await session.configure(configureCommand(session.sessionId, { sampleCount: sessionSampleCount }));
    return session;
  }

  it('waits out the remaining pacing floor when a second acquisition starts before it has elapsed', async () => {
    const transport = new FakeTransport();
    const { driver, state, sleepCalls } = clockedSession(transport);
    const session = await connectAndConfigure(driver);

    await session.acquire(); // first call: nothing to pace against yet
    expect(sleepCalls).toEqual([]);

    state.clockMs += 50; // only 50ms of the 200ms floor has elapsed
    await session.acquire();
    expect(sleepCalls).toEqual([150]);
  });

  it('does not wait when the pacing floor has already elapsed on its own', async () => {
    const transport = new FakeTransport();
    const { driver, state, sleepCalls } = clockedSession(transport);
    const session = await connectAndConfigure(driver);

    await session.acquire();
    state.clockMs += 500; // well past the 200ms floor
    await session.acquire();
    expect(sleepCalls).toEqual([]);
  });

  it('suspends further acquisitions after 3 consecutive capture failures, without touching the transport on the 4th attempt', async () => {
    const transport = new FakeTransport();
    transport.captureImpl = async () => { throw new Error('Unable to refill buffer: Unknown error 110'); };
    const { driver, state } = clockedSession(transport);
    const session = await connectAndConfigure(driver);

    for (let attempt = 0; attempt < NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES; attempt++) {
      state.clockMs += 1_000;
      await expect(session.acquire()).rejects.toThrow(/Unable to refill buffer/);
    }
    expect(transport.calls.filter((call) => call === 'capture')).toHaveLength(NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES);

    state.clockMs += 1_000;
    await expect(session.acquire()).rejects.toThrow(/power cycle/i);
    // The breaker rejects before ever calling the transport again.
    expect(transport.calls.filter((call) => call === 'capture')).toHaveLength(NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES);
  });

  it('never trips the breaker on non-consecutive failures: a success in between resets the count', async () => {
    const transport = new FakeTransport();
    let shouldFail = true;
    transport.captureImpl = async (params) => {
      if (shouldFail) throw new Error('Unable to refill buffer: Unknown error 110');
      return defaultCapture(params);
    };
    const { driver, state } = clockedSession(transport);
    const session = await connectAndConfigure(driver);

    // Two failures, then a success -- must NOT trip the 3-in-a-row breaker.
    state.clockMs += 1_000; await expect(session.acquire()).rejects.toThrow();
    state.clockMs += 1_000; await expect(session.acquire()).rejects.toThrow();
    shouldFail = false;
    state.clockMs += 1_000; await expect(session.acquire()).resolves.toBeDefined();

    // Now two more failures -- still only 2 consecutive, still not tripped.
    shouldFail = true;
    state.clockMs += 1_000; await expect(session.acquire()).rejects.toThrow();
    state.clockMs += 1_000; await expect(session.acquire()).rejects.toThrow(/Unable to refill buffer/);

    // A third consecutive failure finally trips it.
    state.clockMs += 1_000; await expect(session.acquire()).rejects.toThrow(/Unable to refill buffer/);
    state.clockMs += 1_000; await expect(session.acquire()).rejects.toThrow(/power cycle/i);
  });

  it('scopes suspension to one session: a fresh connect() after a tripped breaker is not affected', async () => {
    const transport = new FakeTransport();
    transport.captureImpl = async () => { throw new Error('Unable to refill buffer: Unknown error 110'); };
    const { driver, state } = clockedSession(transport);
    const first = await connectAndConfigure(driver);
    for (let attempt = 0; attempt < NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES; attempt++) {
      state.clockMs += 1_000;
      await expect(first.acquire()).rejects.toThrow();
    }
    state.clockMs += 1_000;
    await expect(first.acquire()).rejects.toThrow(/power cycle/i);

    // A brand-new connection (as if the operator power-cycled and reconnected)
    // must start with a clean breaker even though it is the same driver/device.
    transport.captureImpl = async (params) => defaultCapture(params);
    await first.disconnect();
    state.clockMs += 1_000;
    const second = await connectAndConfigure(driver);
    await expect(second.acquire()).resolves.toBeDefined();
  });
});

describe('NeptuneP210InstrumentSession executeFeature()', () => {
  it('fails closed for every feature command -- v1 advertises no optional features', async () => {
    const { session } = await connectedSession();
    const command: InstrumentFeatureCommand = {
      sessionId: session.sessionId,
      kind: 'diagnostics',
      action: 'read',
      report: 'identity',
    };
    await expect(session.executeFeature(command)).rejects.toThrow(/does not implement feature/);
  });
});

describe('NeptuneP210InstrumentSession subscribe()', () => {
  it('is a no-op registry: listeners are added/removed but never invoked', async () => {
    const { session } = await connectedSession();
    let calls = 0;
    const unsubscribe = session.subscribe(() => { calls += 1; });
    await session.configure(configureCommand(session.sessionId, { sampleCount: 512 }));
    await session.acquire();
    expect(calls).toBe(0);
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('NeptuneP210InstrumentSession disconnect()', () => {
  it('disposes the transport and is idempotent', async () => {
    const { transport, session } = await connectedSession();
    await session.disconnect();
    expect(transport.calls).toContain('dispose');
    const disposeCallsBefore = transport.calls.filter((call) => call === 'dispose').length;
    await session.disconnect();
    expect(transport.calls.filter((call) => call === 'dispose').length).toBe(disposeCallsBefore);
  });

  it('retries after a failed teardown, succeeds without leaking the resource, and never bypasses the still-admitted session', async () => {
    const { transport, session } = await connectedSession();
    await session.configure(configureCommand(session.sessionId, { sampleCount: 256 }));
    let disposeAttempts = 0;
    transport.disposeImpl = async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error('subprocess did not exit');
    };

    await expect(session.disconnect()).rejects.toThrow(/subprocess did not exit/);
    expect(disposeAttempts).toBe(1);

    // Not bypassed: the session is still open after the failed teardown, so
    // its already-admitted configuration is still usable.
    await expect(session.acquire()).resolves.toMatchObject({ kind: 'complex-iq', sampleCount: 256 });

    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(disposeAttempts).toBe(2);

    // Idempotent close: a further disconnect() is a true no-op.
    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(disposeAttempts).toBe(2);

    // And now genuinely closed: further operations refuse.
    await expect(session.acquire()).rejects.toThrow(/session is closed/);
  });
});

describe('NeptuneP210InstrumentDriver full-stack InstrumentManager integration', () => {
  function deterministicRuntime(): InstrumentManagerRuntime {
    const counters = { discovery: 0, configuration: 0 };
    return {
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      opaqueId: (scope) => `${scope}:${++counters[scope]}`,
    };
  }

  it('publishes a generic capture surface whose Auto policy is resolved inside the driver and retains RX-LO readback evidence', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);
    const surface = manager.canonicalSurface();
    if (!surface) throw new Error('Expected canonical capture surface');
    expect(surface.operations).toMatchObject([{
      id: 'capture', primary: true,
      parameterIds: ['capture.tune', 'capture.sample-rate', 'capture.bandwidth', 'capture.samples'],
    }]);
    expect(surface.parameters.every((parameter) => parameter.auto.resolver === 'driver')).toBe(true);
    expect(surface.parameters.every((parameter) => parameter.requested.mode === 'auto')).toBe(true);

    const result = await manager.executeCanonicalOperation({
      sessionId: manager.snapshot()!.sessionId,
      surfaceRevision: surface.revision,
      operationId: 'capture',
      parameters: [
        { parameterId: 'capture.tune', intent: { mode: 'manual', value: 100_000_000 } },
        { parameterId: 'capture.sample-rate', intent: { mode: 'auto' } },
        { parameterId: 'capture.bandwidth', intent: { mode: 'auto' } },
        { parameterId: 'capture.samples', intent: { mode: 'auto' } },
      ],
    });

    expect(transport.setCenterFrequencyHzCalls).toEqual([100_000_000]);
    expect(transport.getCenterFrequencyHzCalls).toEqual([PHYSICAL_ENDPOINT]);
    expect(manager.snapshot()?.configuration?.configuration).toMatchObject({
      kind: 'complex-iq', centerHz: 100_000_000, sampleRateHz: 10_000_000, bandwidthHz: 8_000_000,
    });
    expect(result.surface.parameters.find((parameter) => parameter.id === 'capture.tune')).toMatchObject({
      requested: { mode: 'manual', value: 100_000_000 },
      effectiveValue: 100_000_000,
      verification: 'device-readback',
    });
    expect(result.surface.parameters.filter((parameter) => parameter.id !== 'capture.tune')
      .every((parameter) => parameter.requested.mode === 'auto')).toBe(true);
    await manager.disconnect();
  });

  it('discovers, connects, configures, acquires, and disconnects through the real InstrumentManager', async () => {
    const transport = new FakeTransport();
    const driver = deterministicDriver(transport, { [NEPTUNE_P210_ENDPOINT_ENV_VAR]: PHYSICAL_ENDPOINT });
    const manager = new InstrumentManager(new InstrumentDriverRegistry([driver]), deterministicRuntime());
    const discovery = await manager.discover();
    const candidate = discovery.candidates.find((value) => value.sourceKind === 'neptune-p210');
    if (!candidate) throw new Error('Neptune candidate not discovered');

    const snapshot = await manager.connect(candidate);
    expect(snapshot.rfOutput).toBe('not-supported');
    expect(snapshot.rfOutputQualification).toBe('not-applicable');

    await manager.configure({
      kind: 'complex-iq',
      centerHz: 2_400_000_000,
      sampleRateHz: 10_000_000,
      bandwidthHz: 8_000_000,
      sampleCount: 1_024,
      sampleFormat: 'ci16le',
    });
    const measurement = await manager.acquire();
    expect(measurement.kind).toBe('complex-iq');

    await manager.disconnect();
    expect(transport.calls).toContain('dispose');
  });
});
