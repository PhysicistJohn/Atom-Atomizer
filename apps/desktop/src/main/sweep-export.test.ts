import { describe, expect, it } from 'vitest';
import {
  DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
  FIRMWARE_SOURCE_COMMIT,
  MAX_SWEEP_EXPORT_BYTES_V1,
  MAX_SWEEP_EXPORT_POINTS_V1,
  sweepExportRequestSchema,
  type Sweep,
} from '@tinysa/contracts';
import { defaultSweepFilename, serializeSweep } from './sweep-export.js';

const frequencyHz = Array.from({ length: 20 }, (_value, index) => 100 + (100 * index) / 19);
const powerDbm = Array.from({ length: 20 }, (_value, index) => index === 0 ? -90 : -40 - index);
const minimumFrequencySpacingHz = Math.min(...frequencyHz.slice(1).map((frequency, index) => frequency - frequencyHz[index]!));
const sweep: Sweep = {
  kind: 'spectrum', id: 'sweep-1', sequence: 1, capturedAt: '2026-07-10T12:34:56.000Z', elapsedMilliseconds: 10,
  frequencyHz, powerDbm,
  requested: {
    kind: 'swept-spectrum', startHz: 100, stopHz: 200, points: 20, sweepTimeSeconds: 'auto',
    controls: {
      schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 'auto', attenuationDb: 'auto',
      detector: 'sample', spurRejection: 'auto', lowNoiseAmplifier: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' },
    },
  },
  actualStartHz: 100, actualStopHz: 200, actualRbwHz: 10_000, actualAttenuationDb: 0, source: 'scan-text', complete: true,
  identity: { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'sim', firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT, firmwareQualification: 'protocol-test', port: { id: 'sim', path: 'simulator://zs407', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' }, simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double' },
};

describe('sweep export', () => {
  it('serializes provenance-preserving CSV', () => {
    const value = serializeSweep(sweep, 'csv');
    expect(value).toContain('frequency_hz,power_dbm,sweep_id');
    expect(value).toContain('requested_configuration_json');
    expect(value).toContain('""model"":""receiver""');
    expect(value).toContain('100,-90,sweep-1');
    expect(value).toContain('tinySA Ultra+ ZS407');
  });

  it('serializes the complete contract as JSON', () => {
    expect(JSON.parse(serializeSweep(sweep, 'json'))).toMatchObject({
      kind: 'spectrum', id: 'sweep-1', identity: { simulated: true }, requested: sweep.requested,
    });
  });

  it('preserves unavailable attenuation as null in JSON and an empty CSV field', () => {
    const unavailable: Sweep = {
      ...sweep,
      actualRbwHz: minimumFrequencySpacingHz,
      actualAttenuationDb: null,
      attenuationQualification: 'not-applicable',
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      source: 'signal-lab-synthetic',
      requested: {
        kind: 'swept-spectrum', startHz: 100, stopHz: 200, points: 20, sweepTimeSeconds: 0.05,
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
      },
      identity: signalLabIdentity(),
    };
    expect(JSON.parse(serializeSweep(unavailable, 'json'))).toMatchObject({
      actualAttenuationDb: null,
      attenuationQualification: 'not-applicable',
    });
    const [header, row] = serializeSweep(unavailable, 'csv').trimEnd().split('\n');
    const columns = header!.split(',');
    const values = row!.split(',');
    expect(values[columns.indexOf('actual_attenuation_db')]).toBe('');
    expect(values[columns.indexOf('attenuation_qualification')]).toBe('not-applicable');
    expect(serializeSweep(unavailable, 'csv')).toContain('a'.repeat(64));
  });

  it('creates a filesystem-safe default filename', () => {
    expect(defaultSweepFilename(sweep, 'csv')).toBe('tinysa-atomizer-2026-07-10T12-34-56-000Z.csv');
  });

  it('neutralizes spreadsheet formulas in untrusted metadata without changing numeric samples', () => {
    const csv = serializeSweep({ ...sweep, id: '=1+1' }, 'csv');
    expect(csv).toContain("100,-90,'=1+1");
  });

  it('strictly rejects malformed vectors, timestamps, provenance, fields, and nested strings', () => {
    expect(sweepExportRequestSchema.safeParse({ format: 'csv', sweep: { ...sweep, forged: true } }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'csv', sweep: { ...sweep, powerDbm: sweep.powerDbm.slice(1) },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'csv', sweep: { ...sweep, capturedAt: 'not-a-timestamp' },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'csv', sweep: { ...sweep, source: 'signal-lab-synthetic' },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'csv',
      sweep: {
        ...sweep,
        identity: { ...sweep.identity, firmwareVersion: 'x'.repeat(513) },
      },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'csv',
      sweep: {
        ...sweep,
        requested: { ...sweep.requested, points: 21 },
      },
    }).success).toBe(false);
    let oversizedTraceElementReads = 0;
    const oversizedTraceFrequency = new Proxy(new Array<number>(MAX_SWEEP_EXPORT_POINTS_V1 + 1), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) oversizedTraceElementReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(sweepExportRequestSchema.safeParse({
      format: 'json',
      sweep: {
        ...sweep,
        firmwareTraces: [{
          traceId: 1,
          role: 'measured',
          unit: 'dBm',
          frozen: false,
          frequencyHz: oversizedTraceFrequency,
          powerDbm: [-90],
          sourceSweepId: sweep.id,
          capturedAt: sweep.capturedAt,
          evidence: 'firmware-readback',
        }],
      },
    }).success).toBe(false);
    expect(oversizedTraceElementReads).toBe(0);
  });

  it('enforces the complete source, identity, qualification, and value evidence matrix', () => {
    const gridSpacing = minimumFrequencySpacingHz;
    const cases: readonly { label: string; value: Sweep }[] = [
      { label: 'protocol-test text', value: sweep },
      { label: 'protocol-test raw', value: { ...sweep, source: 'scanraw-binary', rawSweepOffsetDb: 32 } },
      { label: 'physical legacy text', value: { ...sweep, identity: physicalLegacyIdentity() } },
      { label: 'physical legacy raw', value: { ...sweep, source: 'scanraw-binary', rawSweepOffsetDb: 32, identity: physicalLegacyIdentity() } },
      { label: 'executable-twin legacy', value: { ...sweep, source: 'renode-executable-state', identity: twinLegacyIdentity() } },
      { label: 'executable-twin legacy raw', value: { ...sweep, source: 'renode-executable-state', rawSweepOffsetDb: 32, identity: twinLegacyIdentity() } },
      {
        label: 'physical instrument session',
        value: {
          ...sweep,
          source: 'instrument-driver-scalar',
          resolutionBandwidthQualification: 'device-observed',
          attenuationQualification: 'device-observed',
          identity: serialSessionIdentity(),
        },
      },
      {
        label: 'executable-twin instrument session',
        value: {
          ...sweep,
          source: 'renode-executable-state',
          resolutionBandwidthQualification: 'firmware-executed-twin',
          attenuationQualification: 'firmware-executed-twin',
          identity: twinSessionIdentity(),
        },
      },
      {
        label: 'SignalLab instrument session',
        value: {
          ...sweep,
          requested: syntheticRequested(),
          actualRbwHz: gridSpacing,
          actualAttenuationDb: null,
          source: 'signal-lab-synthetic',
          resolutionBandwidthQualification: 'synthetic-grid-equivalent',
          attenuationQualification: 'not-applicable',
          identity: signalLabIdentity(),
        },
      },
    ];

    for (const entry of cases) {
      expect(sweepExportRequestSchema.safeParse({ format: 'json', sweep: entry.value }).success, entry.label).toBe(true);

      const contradictorySource: Sweep['source'] = entry.value.source === 'scan-text' || entry.value.source === 'scanraw-binary'
        ? 'renode-executable-state'
        : 'scan-text';
      expect(sweepExportRequestSchema.safeParse({
        format: 'json',
        sweep: { ...entry.value, source: contradictorySource, rawSweepOffsetDb: undefined },
      }).success, `${entry.label}: source`).toBe(false);

      expect(sweepExportRequestSchema.safeParse({
        format: 'json',
        sweep: { ...entry.value, resolutionBandwidthQualification: 'unavailable' },
      }).success, `${entry.label}: resolution qualification`).toBe(false);

      const contradictoryAttenuation = entry.value.actualAttenuationDb === null
        ? { actualAttenuationDb: 0, attenuationQualification: 'not-applicable' as const }
        : { actualAttenuationDb: null, attenuationQualification: 'not-applicable' as const };
      expect(sweepExportRequestSchema.safeParse({
        format: 'json', sweep: { ...entry.value, ...contradictoryAttenuation },
      }).success, `${entry.label}: attenuation`).toBe(false);
    }

    const signalLab = cases.at(-1)!.value;
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...signalLab, actualRbwHz: signalLab.actualRbwHz + 1 },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...sweep, source: 'scanraw-binary' },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...sweep, rawSweepOffsetDb: 32 },
    }).success).toBe(false);
  });

  it('binds requested geometry and control model to the exported provenance', () => {
    const signalLab: Sweep = {
      ...sweep,
      requested: syntheticRequested(),
      actualRbwHz: minimumFrequencySpacingHz,
      actualAttenuationDb: null,
      source: 'signal-lab-synthetic',
      resolutionBandwidthQualification: 'synthetic-grid-equivalent',
      attenuationQualification: 'not-applicable',
      identity: signalLabIdentity(),
    };
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...signalLab, requested: sweep.requested },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...sweep, requested: syntheticRequested() },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...sweep, requested: { ...sweep.requested, startHz: 102 } },
    }).success).toBe(false);
    expect(sweepExportRequestSchema.safeParse({
      format: 'json', sweep: { ...sweep, requested: { ...sweep.requested, stopHz: 202 } },
    }).success).toBe(false);
  });

  it('exports a future receiver sweep above the TinySA frequency ceiling', () => {
    const startHz = 24_000_000_000;
    const stopHz = 24_100_000_000;
    const futureFrequencyHz = Array.from({ length: 20 }, (_value, index) => startHz + (stopHz - startHz) * index / 19);
    const identity = serialSessionIdentity();
    if (!('kind' in identity)) throw new Error('Expected instrument-session identity');
    const future: Sweep = {
      ...sweep,
      frequencyHz: futureFrequencyHz,
      requested: { ...sweep.requested, startHz, stopHz },
      actualStartHz: startHz,
      actualStopHz: stopHz,
      actualRbwHz: 5_000_000,
      source: 'instrument-driver-scalar',
      resolutionBandwidthQualification: 'device-observed',
      attenuationQualification: 'device-observed',
      identity: { ...identity, driverId: 'neptune-sdr', candidateId: 'serial:neptune' },
    };
    expect(() => serializeSweep(future, 'json')).not.toThrow();
    expect(JSON.parse(serializeSweep(future, 'json')).actualStopHz).toBe(stopHz);
  });

  it('rejects an oversized text artifact before returning output', () => {
    const traceFrequencyHz = Array.from(
      { length: MAX_SWEEP_EXPORT_POINTS_V1 },
      (_value, index) => index + 0.123456789,
    );
    const tracePowerDbm = Array.from(
      { length: MAX_SWEEP_EXPORT_POINTS_V1 },
      (_value, index) => -123.123456789 + (index % 10) / 100,
    );
    const trace = {
      traceId: 1 as const,
      role: 'measured' as const,
      unit: 'dBm' as const,
      frozen: false as const,
      frequencyHz: traceFrequencyHz,
      powerDbm: tracePowerDbm,
      sourceSweepId: sweep.id,
      capturedAt: sweep.capturedAt,
      evidence: 'firmware-readback' as const,
    };
    const oversized: Sweep = {
      ...sweep,
      firmwareTraces: [
        trace,
        { ...trace, traceId: 2 },
        { ...trace, traceId: 3 },
        { ...trace, traceId: 4 },
      ],
    };

    expect(() => serializeSweep(oversized, 'json'))
      .toThrow(new RegExp(`at most ${MAX_SWEEP_EXPORT_BYTES_V1} bytes`));
  });
});

function signalLabIdentity(): Sweep['identity'] {
  return {
    kind: 'instrument-session',
    sessionId: 'session:signal-lab',
    driverId: 'signal-lab',
    candidateId: 'signal-lab:default',
    provenance: {
      sourceKind: 'signal-lab',
      sourceId: 'default',
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      verifiedAt: '2026-07-10T12:34:56.000Z',
      producerConfigurationEpoch: 'producer-epoch:1',
      contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 1,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorSha256: 'c'.repeat(64),
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    },
  };
}

function syntheticRequested(): Extract<Sweep['requested'], { kind: 'swept-spectrum' }> {
  return {
    kind: 'swept-spectrum', startHz: 100, stopHz: 200, points: 20, sweepTimeSeconds: 0.05,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  };
}

function serialSessionIdentity(): Sweep['identity'] {
  return {
    kind: 'instrument-session',
    sessionId: 'session:serial',
    driverId: 'tinysa',
    candidateId: 'serial:/dev/tty.usbmodem407',
    provenance: {
      sourceKind: 'serial-port',
      execution: 'physical',
      transport: 'usb-cdc-acm',
      qualification: 'device-observed',
      verifiedAt: '2026-07-10T12:34:56.000Z',
      serialPort: { path: '/dev/tty.usbmodem407', vendorId: '0483', productId: '5740' },
      device: {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'custom',
        firmwareQualification: 'custom-unqualified', usbIdentityVerified: true,
      },
    },
  };
}

function twinSessionIdentity(): Sweep['identity'] {
  return {
    kind: 'instrument-session',
    sessionId: 'session:twin',
    driverId: 'tinysa',
    candidateId: 'twin:renode',
    provenance: {
      sourceKind: 'tinysa-firmware-twin',
      execution: 'firmware-executed-twin',
      transport: 'renode-monitor-bridge',
      qualification: 'firmware-executed-twin',
      verifiedAt: '2026-07-10T12:34:56.000Z',
      bridge: 'renode-monitor-v1',
      repositoryCommit: 'b'.repeat(40),
      firmwareBinarySha256: 'a'.repeat(64),
      usbTransactionsModeled: false,
      device: { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'twin' },
    },
  };
}

function physicalLegacyIdentity(): Sweep['identity'] {
  return {
    model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'custom',
    firmwareQualification: 'custom-unqualified',
    port: {
      id: 'serial:physical', path: '/dev/tty.usbmodem407', vendorId: '0483', productId: '5740',
      usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
    },
    simulated: false, usbIdentityVerified: true, execution: 'physical',
  };
}

function twinLegacyIdentity(): Sweep['identity'] {
  const digitalTwin = {
    contractVersion: 1,
    bridge: 'renode-monitor-v1',
    firmwareRelease: 'lab-v0.2.0-protocol',
    repositoryCommit: DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
    firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7',
    usbTransactionsModeled: false,
    bootEvidence: 'ZS407_TWIN_BOOT=PASS test',
  } as const;
  return {
    model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'twin',
    firmwareSourceCommit: DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
    firmwareQualification: 'executable-twin',
    port: {
      id: 'twin:renode', path: 'renode://zs407', usbMatch: 'firmware-digital-twin',
      transport: 'renode-monitor-bridge', execution: 'firmware-digital-twin', digitalTwin,
    },
    simulated: true, usbIdentityVerified: false, execution: 'firmware-digital-twin', digitalTwin,
  };
}
