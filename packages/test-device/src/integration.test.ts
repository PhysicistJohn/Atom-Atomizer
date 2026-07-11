import { describe, expect, it } from 'vitest';
import { TinySaDeviceService } from '@tinysa/device';
import type { AnalyzerConfig, GeneratorConfig, ZeroSpanConfig } from '@tinysa/contracts';
import { FakeTinySaTransport } from './index.js';

const analyzer: AnalyzerConfig = {
  startHz: 100_000,
  stopHz: 1_000_000,
  points: 64,
  acquisitionFormat: 'text',
  rbwKhz: 'auto',
  attenuationDb: 'auto',
  sweepTimeSeconds: 'auto',
  detector: 'sample',
  spurRejection: 'auto',
  lna: 'off',
  avoidSpurs: 'auto',
  trigger: { mode: 'auto' },
};
const generator: GeneratorConfig = {
  frequencyHz: 100_000_000,
  levelDbm: -30,
  path: 'mixer',
  modulation: 'am',
  modulationFrequencyHz: 1_000,
  amDepthPercent: 80,
  fmDeviationHz: 3_000,
};
const zeroSpan: ZeroSpanConfig = {
  frequencyHz: 433_920_000,
  points: 64,
  rbwKhz: 100,
  attenuationDb: 'auto',
  sweepTimeSeconds: 0.1,
  trigger: { mode: 'auto' },
};

describe('device service against byte-level simulator', () => {
  it('identifies, verifies, acquires, diagnoses, and captures without enabling RF', async () => {
    const transport = new FakeTinySaTransport({ chunkSize: 3 });
    const device = new TinySaDeviceService(transport);
    const connected = await device.connect(transport.port);
    expect(connected.identity).toMatchObject({ model: 'tinySA Ultra+ ZS407', hardwareVersion: expect.stringContaining('ZS407') });
    expect(connected.capabilities).toMatchObject({ maxSweepPoints: 450, rawSweep: true, screenCapture: true, remoteTouch: true });
    expect(connected.generatorOutput).toBe('off');

    const configured = await device.configureAnalyzer(analyzer);
    expect(configured.verification).toBe('verified');
    const sweep = await device.acquireSweep();
    expect(sweep.frequencyHz).toHaveLength(64);
    expect(sweep.powerDbm).toHaveLength(64);
    expect(sweep.source).toBe('scan-text');

    const diagnostics = await device.readDiagnostics();
    expect(diagnostics.telemetry).toMatchObject({ batteryMillivolts: 4_170, deviceId: 407 });
    const frame = await device.captureScreen();
    expect(frame.pixels).toHaveLength(307_200);
    await device.touch({ x: 10, y: 20 });
    await device.releaseTouch({ x: 10, y: 20 });
    expect(transport.writes).not.toContain('output on');
    await device.disconnect();
  });

  it('acquires strict binary raw sweeps and zero-span envelope samples', async () => {
    const transport = new FakeTinySaTransport({ chunkSize: 7 });
    const device = new TinySaDeviceService(transport);
    await device.connect(transport.port);
    await device.configureAnalyzer({ ...analyzer, acquisitionFormat: 'raw' });
    const raw = await device.acquireSweep();
    expect(raw.source).toBe('scanraw-binary');
    expect(raw.powerDbm).toHaveLength(64);
    const capture = await device.acquireZeroSpan(zeroSpan);
    expect(capture.frequencyHz).toBe(433_920_000);
    expect(capture.powerDbm).toHaveLength(64);
    expect(capture.samplePeriodSeconds).toBeGreaterThan(0);
    await device.disconnect();
  });

  it('owns continuous acquisition in the device service and stops after the in-flight sweep', async () => {
    const transport = new FakeTinySaTransport({ chunkSize: 5 });
    const device = new TinySaDeviceService(transport);
    await device.connect(transport.port);
    await device.configureAnalyzer({ ...analyzer, points: 20, acquisitionFormat: 'raw' });
    let count = 0;
    const stopped = new Promise<void>((resolve, reject) => {
      device.subscribe((event) => {
        if (event.type !== 'sweep' || ++count !== 3) return;
        void device.stopStreaming().then(resolve, reject);
      });
    });
    await device.startStreaming();
    await stopped;
    expect(count).toBe(3);
    await expect(device.stopStreaming()).rejects.toThrow(/not running/i);
    await device.disconnect();
  });

  it('switches Signal Lab profiles in the actual sweep byte source', async () => {
    const transport = new FakeTinySaTransport({ signalProfile: 'cw', demoIdentity: true });
    const device = new TinySaDeviceService(transport);
    await device.connect(transport.port);
    await device.configureAnalyzer({ ...analyzer, points: 145 });
    const cw = await device.acquireSweep();
    transport.setSignalProfile('lte');
    const lte = await device.acquireSweep();
    expect(cw.powerDbm.filter((value) => value > -80).length).toBeLessThan(8);
    expect(lte.powerDbm.filter((value) => value > -80).length).toBeGreaterThan(40);
    await device.disconnect();
  });

  it('replays a correlated capture-like noise floor that evolves between sweeps', async () => {
    const transport = new FakeTinySaTransport({ signalProfile: 'cw', demoIdentity: true });
    const device = new TinySaDeviceService(transport);
    await device.connect(transport.port);
    await device.configureAnalyzer({ ...analyzer, points: 321 });
    const first = await device.acquireSweep();
    const second = await device.acquireSweep();
    const backgroundIndexes = first.powerDbm
      .map((_value, index) => index)
      .filter((index) => index / (first.powerDbm.length - 1) < 0.42 || index / (first.powerDbm.length - 1) > 0.58);
    const floor = backgroundIndexes.map((index) => first.powerDbm[index]!);
    const adjacentMotion = floor.slice(1).map((value, index) => Math.abs(value - floor[index]!));
    const frameMotion = backgroundIndexes.map((index) => Math.abs(second.powerDbm[index]! - first.powerDbm[index]!));
    expect(Math.max(...floor) - Math.min(...floor)).toBeGreaterThan(7);
    expect(average(adjacentMotion)).toBeGreaterThan(0.2);
    expect(average(adjacentMotion)).toBeLessThan(2.5);
    expect(average(frameMotion)).toBeGreaterThan(0.25);
    expect(average(frameMotion)).toBeLessThan(2.5);
    await device.disconnect();
  });

  it('keeps generator output off through configuration and requires generator mode before enable', async () => {
    const transport = new FakeTinySaTransport();
    const device = new TinySaDeviceService(transport);
    await device.connect(transport.port);
    await expect(device.setGeneratorOutput(true)).rejects.toThrow(/Generator mode/);
    const configured = await device.configureGenerator(generator);
    expect(configured).toMatchObject({ mode: 'generator', generatorOutput: 'off', verification: 'commanded' });
    const modeOutputIndex = transport.writes.lastIndexOf('mode output');
    expect(modeOutputIndex).toBeGreaterThan(0);
    expect(transport.writes.slice(modeOutputIndex - 1, modeOutputIndex + 3)).toEqual([
      'output off',
      'mode output',
      'output off',
      'output mixer',
    ]);
    await device.setGeneratorOutput(true);
    expect(device.snapshot().generatorOutput).toBe('on');
    await device.setGeneratorOutput(false);
    await device.disconnect();
  });
});

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
