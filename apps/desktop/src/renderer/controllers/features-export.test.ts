// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtomizerFilesApiV1, InstrumentMeasurement, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { createRendererRuntime } from '../AppShell.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function neptuneSession(): InstrumentSessionSnapshot {
  return {
    sessionId: 'session:neptune',
    driverId: 'neptune-p210',
    candidate: {
      schemaVersion: 1,
      driverId: 'neptune-p210',
      candidateId: 'neptune-p210:ip:10.0.0.250',
      displayName: 'NeptuneSDR P210',
      sourceKind: 'neptune-p210',
      neptuneP210: { endpoint: 'ip:10.0.0.250' },
      discoveryRevision: 'discovery:1',
    },
    provenance: {
      sourceKind: 'neptune-p210',
      execution: 'physical',
      transport: 'libiio-network',
      qualification: 'device-observed',
      verifiedAt: '2026-07-31T22:00:00.000Z',
      endpoint: 'ip:10.0.0.250',
      contextDescription: 'HAMGEEK P210',
    },
    capabilities: { schemaVersion: 1, acquisitions: [], features: [] },
    rfOutput: 'not-supported',
    rfOutputQualification: 'not-applicable',
  } as InstrumentSessionSnapshot;
}

function iqCapture(sessionId = 'session:neptune'): Extract<InstrumentMeasurement, { kind: 'complex-iq' }> {
  return {
    schemaVersion: 1,
    kind: 'complex-iq',
    measurementId: 'measurement:neptune:1',
    sessionId,
    configurationRevision: 'configuration:neptune:1',
    sequence: 1,
    capturedAt: '2026-07-31T22:00:01.000Z',
    elapsedMilliseconds: 12,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    qualification: 'device-observed',
    complete: true,
    centerHz: 99_000_000,
    sampleRateHz: 56_000_000,
    bandwidthHz: 200_000,
    sampleFormat: 'ci16le',
    sampleCount: 2,
    samples: new Uint8Array(8),
    adcSignificantBits: 12,
    adcFullScaleCode: 2_048,
    powerReference: 'uncalibrated-dbfs-relative',
  };
}

function installFilesApi() {
  const api: AtomizerFilesApiV1 = {
    version: 1,
    exportSweep: vi.fn().mockResolvedValue({ status: 'cancelled', format: 'csv' }),
    exportComplexIq: vi.fn().mockResolvedValue({
      status: 'saved',
      metaPath: '/tmp/capture.sigmf-meta',
      dataPath: '/tmp/capture.sigmf-data',
      bytesWritten: 1_024,
    }),
  };
  vi.stubGlobal('atomizerFiles', api);
  return api;
}

describe('complex-I/Q export controller', () => {
  it('binds the byte-exact capture to the active Neptune session identity', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'iq', initialAgentOpen: false });
    const session = neptuneSession();
    const measurement = iqCapture();
    runtime.store.set({
      instrument: { ...runtime.store.get().instrument, session },
      iqCapture: measurement,
    });
    const files = installFilesApi();

    await expect(runtime.features.exportLatestIq()).resolves.toMatchObject({ status: 'saved' });
    expect(files.exportComplexIq).toHaveBeenCalledWith({
      measurement,
      identity: {
        kind: 'instrument-session',
        sessionId: session.sessionId,
        driverId: session.driverId,
        candidateId: session.candidate.candidateId,
        provenance: session.provenance,
      },
    });
    expect(runtime.store.get().notice).toMatch(/byte-exact SigMF bytes/);
  });

  it('fails closed when a retained capture does not belong to the active session', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'iq', initialAgentOpen: false });
    runtime.store.set({
      instrument: { ...runtime.store.get().instrument, session: neptuneSession() },
      iqCapture: iqCapture('session:stale'),
    });
    const files = installFilesApi();

    await expect(runtime.features.exportLatestIq()).rejects.toThrow(/does not belong to the active instrument session/i);
    expect(files.exportComplexIq).not.toHaveBeenCalled();
    expect(runtime.store.get().error).toMatch(/does not belong to the active instrument session/i);
  });

  it('gives Atom the same session-bound SigMF export path as the visual control', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'iq', initialAgentOpen: false });
    const session = neptuneSession();
    const measurement = iqCapture();
    runtime.store.set({
      instrument: { ...runtime.store.get().instrument, session },
      iqCapture: measurement,
    });
    const files = installFilesApi();

    await expect(runtime.agent.executeAgentTool('export_latest_iq', {})).resolves.toMatchObject({ status: 'saved' });
    expect(files.exportComplexIq).toHaveBeenCalledWith(expect.objectContaining({
      measurement,
      identity: expect.objectContaining({ sessionId: session.sessionId }),
    }));
  });
});
