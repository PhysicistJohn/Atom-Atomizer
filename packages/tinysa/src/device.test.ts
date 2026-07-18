import { describe, expect, it } from 'vitest';
import {
  FIRMWARE_SOURCE_COMMIT,
  ZS407_CUSTOM_RECEIVER_DOCUMENTED_BINARY_SHA256,
  ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  type AnalyzerConfig,
  type GeneratorConfig,
  type PortCandidate,
} from '@tinysa/contracts';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';
import { TinySaDeviceService } from './device.js';
import { TinySaZs407InstrumentDriver } from './tinysa-instrument-driver.js';
import type { ByteTransport, TransportDiscoveryResult, TransportEvent } from './transport.js';

const generator: GeneratorConfig = {
  frequencyHz: 100_000_000,
  levelDbm: -30,
  path: 'mixer',
  modulation: 'off',
  modulationFrequencyHz: 1_000,
  amDepthPercent: 80,
  fmDeviationHz: 3_000,
};

const analyzer: AnalyzerConfig = {
  startHz: 88_000_000,
  stopHz: 108_000_000,
  points: 20,
  acquisitionFormat: 'text',
  rbwKhz: 30,
  attenuationDb: 7,
  sweepTimeSeconds: 0.25,
  detector: 'quasi-peak',
  spurRejection: 'on',
  lna: 'on',
  avoidSpurs: 'off',
  trigger: { mode: 'normal', levelDbm: -63 },
};

// Source-exact F303/ZS407 Phase 6 shell replies from sibling
// Atom-Firmware commit 53850c4aa4f8947e4a7ab3ebef553dad1f8e770d.
// The usage strings come from main.c/sa_cmd.c; the help partition follows
// cmd_help's CMD_RUN_IN_LOAD split in commands[]. State-dependent readbacks use
// values representable by the corresponding source formatters. In particular,
// chprintf `%F` delegates to ftoaS: 100 kHz and 0.08 s exercise its source-level
// `k` (>1000) and `m` (<1) engineering-prefix thresholds.
const FIRMWARE_53850C4_HELP = [
  'commands: freq time dac nf saveconfig clearconfig zero sweep pause restart resume wait waitscan repeat status caloutput save recall trace trigger marker line usart_cfg vbat_offset color if if1 lna2 agc actual_freq freq_corr attenuate level sweeptime leveloffset levelchange modulation rbw mode spur avoid lna direct ultra load ext_gain output deviceid correction calc menu text remark',
  'Other commands: version modern reset data frequencies scan hop scanraw abort test touchcal touchtest channel usart capture refresh touch release vbat help info selftest sd_list sd_read sd_delete threads',
].join('\r\n');

const FIRMWARE_53850C4_PROBE_REPLIES = Object.freeze({
  help: FIRMWARE_53850C4_HELP,
  'sweep ?': 'usage: sweep {start(Hz)} [stop(Hz)] [points]\r\n\tsweep {normal|precise|fast|noise|go|abort}\r\n\tsweep {start|stop|center|span|cw} {freq(Hz)}',
  'scan ? ? ? ? ?': 'usage: scan {start(Hz)} {stop(Hz)} [points] [outmask]',
  'scanraw ?': 'usage: scanraw {start(Hz)} {stop(Hz)} [points] [options]',
  'zero ?': 'usage: zero {level}\r\n-174dBm',
  'trace ?': 'trace {dBm|dBmV|dBuV|RAW|V|Vpp|W}\r\ntrace {scale|reflevel} auto|{value}\r\ntrace [{trace#}] value\r\ntrace [{trace#}] {copy|freeze|subtract|view|value} {trace#}|off|on|[{index} {value}]',
  'rbw ?': 'usage: rbw 0.2..850|auto\r\n100kHz',
  'attenuate ?': 'usage: attenuate 0..31|auto\r\n   0',
  'sweeptime ?': 'usage: sweeptime 0.003..60\r\n  80ms',
  'calc ?': 'usage: calc [{trace#}] off|minh|maxh|maxd|aver4|aver16|aver|quasi|log|lin\r\nOFF',
  'spur ?': 'usage: spur off|on|auto',
  'avoid ?': 'usage: avoid auto|off|on|dump',
  'lna ?': 'usage: lna off|on',
  'trigger ?': 'trigger {value}\r\ntrigger {auto|normal|single}',
});

const FIRMWARE_53850C4_PROBE_COMMANDS = [
  'sweep ?', 'scan ? ? ? ? ?', 'scanraw ?', 'zero ?', 'trace ?', 'rbw ?', 'attenuate ?',
  'sweeptime ?', 'calc ?', 'spur ?', 'avoid ?', 'lna ?', 'trigger ?',
] as const;

describe('device fail-loud lifecycle', () => {
  it('admits the shipped ZS407 identity from its explicit info line and resolves exact source provenance', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-217-gc5dd31f\r\nPlatform: STM32F303',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      model: 'tinySA Ultra+ ZS407',
      hardwareVersion: 'V0.5.4 max2871',
      firmwareReportedRevision: 'c5dd31f',
      firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
      firmwareQualification: 'supported-oem',
      usbIdentityVerified: true,
      execution: 'physical',
    });
    expect(connected.capabilities).toMatchObject({
      evidence: 'device-observed',
      firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
      hostContractSourceCommit: FIRMWARE_SOURCE_COMMIT,
      firmwareTraces: true,
      qualification: 'device-observed-awaiting-rf-qualification',
    });
    expect(connected.receiveOnlySafety).toMatchObject({
      connectionReceipt: {
        schemaVersion: 1,
        sessionId: connected.sessionId,
        command: 'output off',
        reason: 'connection-first-command',
        outputState: 'off',
        acknowledgement: 'empty-reply-acknowledged',
        qualification: 'device-command-acknowledged-not-rf-measured',
        sequence: 1,
      },
      currentReceipt: { sessionId: connected.sessionId },
    });
    expect(connected.receiveOnlySafety!.connectionReceipt.acknowledgedAt <= connected.connectedAt!).toBe(true);
    expect(bytes.writes.slice(0, 4)).toEqual(['output off', 'version', 'info', 'help']);
    await service.disconnect();
  });

  it.each([
    { startHz: 88_000_000, stopHz: 108_000_000, points: 450 },
    { startHz: 88_000_000, stopHz: 108_000_000, points: 449 },
    { startHz: 0, stopHz: 1_000_000, points: 20 },
    { startHz: 12_345_601, stopHz: 12_345_800, points: 101 },
  ])('reproduces the exact requested endpoints for a raw-format sweep across $points points', async ({ startHz, stopHz, points }) => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-217-gc5dd31f\r\nPlatform: STM32F303',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureAnalyzer({ ...analyzer, acquisitionFormat: 'raw', startHz, stopHz, points });

    const writesBeforeAcquire = bytes.writes.length;
    const sweep = await service.acquireSweep();
    const acquisitionWrites = bytes.writes.slice(writesBeforeAcquire);

    expect(sweep.frequencyHz).toHaveLength(points);
    expect(sweep.powerDbm).toHaveLength(points);
    expect(sweep.actualStartHz).toBe(startHz);
    expect(sweep.actualStopHz).toBe(stopHz);
    expect(sweep.frequencyHz[0]).toBe(startHz);
    expect(sweep.frequencyHz.at(-1)).toBe(stopHz);
    expect(acquisitionWrites).toContain('trace');
    await service.disconnect();
  });

  it('isolates throwing device observers from connection and RF lifecycle state', async () => {
    const transport = new PhysicalFixtureTransport(new FakeTinySaTransport());
    const service = new TinySaDeviceService(transport);
    let downstreamEvents = 0;
    service.subscribe(() => { throw new Error('host observer failed'); });
    service.subscribe(() => { downstreamEvents += 1; });

    await expect(service.connect(transport.port)).resolves.toMatchObject({ connection: 'ready' });
    expect(service.snapshot()).toMatchObject({ connection: 'ready', generatorOutput: 'off' });
    expect(downstreamEvents).toBeGreaterThan(0);
    await expect(service.disconnect()).resolves.toBeUndefined();
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it.each([
    'tinySA4_v1.4-224-gc979386-dirty',
    'tinySA4_custom-gc979386',
    'tinySA4_v1.4-224-gc979386 HACKED',
  ])('warning-admits decorated known-revision shell identity %j as custom firmware', async (firmwareVersion) => {
    const bytes = new FakeTinySaTransport({
      versionResponse: `${firmwareVersion}\r\nHW Version:V0.5.4 max2871`,
      infoResponse: `tinySA ULTRA+ ZS407\r\nVersion: ${firmwareVersion}\r\nPlatform: STM32F303`,
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      firmwareVersion,
      firmwareReportedRevision: 'c979386',
      firmwareQualification: 'custom-unqualified',
      usbIdentityVerified: true,
      execution: 'physical',
    });
    expect(connected.identity?.firmwareSourceCommit).toBeUndefined();
    expect(connected.identity?.firmwareWarning).toMatch(/c979386.*without source qualification/i);
    await service.disconnect();
  });

  it.each([
    'tinySA4_hw-v0.3-fft1024-g43eb0f1-dirty',
    'tinySA4_hw-v0.3-fft1024-g43eb0f1+local',
    'tinySA4_custom-g43eb0f1',
  ])('does not source-qualify decorated or alternate 43eb0f1 identity %j', async (firmwareVersion) => {
    const bytes = new FakeTinySaTransport({
      versionResponse: `${firmwareVersion}\r\nHW Version:V0.5.4 max2871`,
      infoResponse: `tinySA ULTRA+ ZS407\r\nVersion: ${firmwareVersion}`,
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      firmwareVersion,
      firmwareReportedRevision: '43eb0f1',
      firmwareQualification: 'custom-unqualified',
    });
    expect(connected.identity).not.toHaveProperty('firmwareSourceCommit');
    expect(connected.capabilities).toMatchObject({
      sweepPoints: { min: 450, max: 450, step: 1, unit: 'points' },
      qualification: 'custom-firmware-unqualified',
    });
    await service.disconnect();
  });

  it('normalizes physical ZS407 RGB565 panel bytes to the little-endian screen contract', async () => {
    const bytes = new FakeTinySaTransport({ screenCaptureByteOrder: 'big-endian' });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);

    const frame = await service.captureScreen();

    expect(frame).toMatchObject({ width: 480, height: 320, format: 'rgb565le' });
    expect(frame.pixels).toHaveLength(307_200);
    // The fixture's first pixel is canonical RGB565 0x10a3.  The physical
    // command emits 10 a3; ScreenFrame must expose the LE bytes a3 10.
    expect(Array.from(frame.pixels.slice(0, 2))).toEqual([0xa3, 0x10]);
    await service.disconnect();
  });

  it('rejects a tinySA4 that has no strict ZS407 evidence', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA ZS405\r\nVersion: tinySA4_v1.4-217-gc5dd31f',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    await expect(new TinySaDeviceService(transport).connect(transport.port)).rejects.toThrow(/not a ZS407/);
  });

  it('does not treat an operation-only unknown response as acknowledgement of mandatory output-off', async () => {
    const bytes = new FakeTinySaTransport({ commandResponseSequences: { 'output off': ['output?', ''] } });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/rejected command output off/i);

    expect(service.snapshot()).toMatchObject({
      connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown',
      pendingPort: transport.port,
    });
    await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
    expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(2);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it.each(['error', 'unknown command', 'invalid request', 'no such command', 'ok', 'command accepted'])(
    'requires the closed empty-reply acknowledgement for mutating command response %j',
    async (reply) => {
      const bytes = new FakeTinySaTransport({ commandResponseSequences: { 'output off': [reply, ''] } });
      const transport = new PhysicalFixtureTransport(bytes);
      const service = new TinySaDeviceService(transport);

      await expect(service.connect(transport.port)).rejects.toThrow(/rejected command output off.*require an empty reply/i);

      expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown' });
      await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
      expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(2);
      expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
    },
  );

  it('does not issue a safety receipt for a whitespace-only output-off reply', async () => {
    const bytes = new FakeTinySaTransport({ commandResponseSequences: { 'output off': [' \r\n', ''] } });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/exact empty firmware reply/i);
    expect(service.snapshot().receiveOnlySafety).toBeUndefined();
    await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
  });

  it.each([
    [
      'arbitrary colon prose',
      'note: version info help output mode sweep rbw attenuate status vbat deviceid\r\nOther commands:',
      /Malformed help catalog commands line/i,
    ],
    [
      'a duplicate declaration',
      'commands: version info help output mode sweep rbw attenuate status vbat deviceid\r\nOther commands: output',
      /declared more than once/i,
    ],
    [
      'an extra catalog line',
      'commands: version info help output mode sweep rbw attenuate status vbat deviceid\r\nOther commands:\r\nnote: scan trace',
      /expected exactly commands and Other commands lines/i,
    ],
  ])('rejects help output containing %s', async (_case, helpResponse, expected) => {
    const bytes = new FakeTinySaTransport({ commandResponses: { help: helpResponse } });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(expected);

    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('rejects a physical firmware surface without the composition-required zero offset readback command', async () => {
    const bytes = new FakeTinySaTransport({
      helpCommands: [
        'version', 'info', 'help', 'output', 'mode', 'sweep', 'rbw', 'attenuate', 'status', 'vbat', 'deviceid',
      ],
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/missing required commands: zero/i);

    expect(bytes.writes.slice(0, 4)).toEqual(['output off', 'version', 'info', 'help']);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('invalidates an older RF-off acknowledgement when a later output-off attempt is rejected', async () => {
    const bytes = new FakeTinySaTransport({
      commandResponseSequences: { 'output off': ['', '', 'output?', ''] },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);

    await expect(service.configureAnalyzer(analyzer)).rejects.toThrow(/rejected command output off/i);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown' });
    await service.disconnect();

    expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(4);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('invalidates an admitted analyzer configuration after a partial generator transition fails', async () => {
    const bytes = new FakeTinySaTransport({ commandResponses: { 'freq 100000000': 'usage: freq {frequency}' } });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureAnalyzer(analyzer);

    await expect(service.configureGenerator(generator)).rejects.toThrow(/rejected command freq/i);
    expect(service.snapshot()).toMatchObject({
      connection: 'ready', mode: 'idle', generatorOutput: 'off', verification: 'commanded',
      analyzer: undefined, generator: undefined,
    });
    await expect(service.acquireSweep()).rejects.toThrow(/Analyzer is not configured/);
    await service.disconnect();
  });

  it('removes stale published analyzer state when a healthy-protocol reconfiguration fails', async () => {
    const bytes = new FakeTinySaTransport({ commandResponseSequences: { 'rbw 30': ['', 'usage: rbw 0.2..850|auto'] } });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureAnalyzer(analyzer);

    await expect(service.configureAnalyzer(analyzer)).rejects.toThrow(/rejected command rbw/i);
    expect(service.snapshot()).toMatchObject({
      connection: 'ready', mode: 'idle', generatorOutput: 'off', verification: 'commanded',
      analyzer: undefined, generator: undefined,
    });
    await expect(service.acquireSweep()).rejects.toThrow(/Analyzer is not configured/);
    await service.disconnect();
  });

  it('admits an otherwise valid ZS407 custom revision with explicit unqualified provenance', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      firmwareReportedRevision: 'deadbee',
      firmwareQualification: 'custom-unqualified',
      firmwareWarning: expect.stringMatching(/admitted without source qualification/i),
      usbIdentityVerified: true,
    });
    expect(connected.identity).not.toHaveProperty('firmwareSourceCommit');
    expect(connected.capabilities).toMatchObject({ qualification: 'custom-firmware-unqualified' });
    expect(connected.capabilities).not.toHaveProperty('firmwareSourceCommit');
    expect(bytes.writes.slice(0, 6)).toEqual(['output off', 'version', 'info', 'help', 'output off', 'mode input']);
    const lastProbe = bytes.writes.map((command) => command.endsWith(' ?')).lastIndexOf(true);
    expect(bytes.writes.slice(lastProbe + 1, lastProbe + 4)).toEqual(['output off', 'mode input', 'sweep']);
    expect(connected.generatorOutput).toBe('off');
    await service.disconnect();
  });

  it('cold-starts the frozen 43eb0f1 custom receiver at 101 points and exact-retunes FM and Band 14 at 449/450 points', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_hw-v0.3-fft1024-g43eb0f1\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_hw-v0.3-fft1024-g43eb0f1',
      initialSweepPoints: 101,
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      firmwareReportedRevision: '43eb0f1',
      firmwareSourceCommit: ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
      firmwareQualification: 'custom-source-qualified-receive-only',
      firmwareWarning: expect.stringMatching(/runtime serial protocol does not attest documented binary SHA-256.*not OEM, hardware\/RF, or metrology qualification/i),
      usbIdentityVerified: true,
      execution: 'physical',
    });
    expect(connected.identity?.firmwareWarning).toContain(ZS407_CUSTOM_RECEIVER_DOCUMENTED_BINARY_SHA256);
    expect(connected.capabilities).toMatchObject({
      analyzerFrequency: { min: 0, max: 900_000_000, step: 1, unit: 'Hz' },
      analyzerNormalMaximumHz: 900_000_000,
      sweepPoints: { min: 20, max: 450, step: 1, unit: 'points' },
      maxSweepPoints: 450,
      evidence: 'device-observed',
      firmwareSourceCommit: ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
      qualification: 'custom-firmware-source-qualified-receive-only',
      screenCapture: false,
      remoteTouch: false,
      firmwareMarkers: false,
      firmwareTraces: false,
      modulation: [],
    });
    expect(connected.capabilities).not.toHaveProperty('generatorFrequency');
    expect(connected.capabilities).not.toHaveProperty('generatorLevel');
    expect(connected.capabilities).not.toHaveProperty('analyzerUltraTransitionHz');

    const writesBeforeDeniedFeatures = bytes.writes.length;
    await expect(service.configureGenerator(generator)).rejects.toThrow(/generator frequency control is not advertised/i);
    await expect(service.setGeneratorOutput(true)).rejects.toThrow(/RF generator output is not advertised/i);
    await expect(service.captureScreen()).rejects.toThrow(/Screen capture is not advertised/i);
    await expect(service.touch({ x: 1, y: 1 })).rejects.toThrow(/Remote touch is not advertised/i);
    await expect(service.releaseTouch()).rejects.toThrow(/Remote touch is not advertised/i);
    expect(bytes.writes).toHaveLength(writesBeforeDeniedFeatures);

    const retunes = [
      { startHz: 88_000_000, stopHz: 108_000_000, points: 450 },
      { startHz: 758_000_000, stopHz: 768_000_000, points: 449 },
      { startHz: 758_000_000, stopHz: 768_000_000, points: 450 },
    ] as const;
    for (const retuneGeometry of retunes) {
      const retune: AnalyzerConfig = { ...analyzer, ...retuneGeometry, trigger: { mode: 'auto' } };
      const beforeRetune = bytes.writes.length;
      const configured = await service.configureAnalyzer(retune);
      expect(bytes.writes.slice(beforeRetune, beforeRetune + 4)).toEqual([
        'output off',
        'mode input',
        'trace dBm',
        `sweep ${retune.startHz} ${retune.stopHz} ${retune.points}`,
      ]);
      expect(configured).toMatchObject({
        connection: 'ready',
        mode: 'analyzer',
        generatorOutput: 'off',
        verification: 'commanded',
        analyzer: {
          requested: retuneGeometry,
          readback: retuneGeometry,
        },
      });
      const writesBeforeAcquire = bytes.writes.length;
      const sweep = await service.acquireSweep();
      const acquisitionWrites = bytes.writes.slice(writesBeforeAcquire);
      expect(sweep).toMatchObject({
        actualStartHz: retune.startHz,
        actualStopHz: retune.stopHz,
        complete: true,
        identity: {
          firmwareQualification: 'custom-source-qualified-receive-only',
          firmwareReportedRevision: '43eb0f1',
          firmwareSourceCommit: ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
        },
      });
      expect(sweep.frequencyHz).toHaveLength(retune.points);
      expect(acquisitionWrites).not.toContain('trace');
      expect(acquisitionWrites.some((command) => /^trace [1-4] value$/.test(command))).toBe(false);
    }
    expect(bytes.writes).not.toContain('output on');
    expect(bytes.writes).not.toContain('mode output');
    expect(bytes.writes).not.toContain('capture');
    expect(bytes.writes.some((command) => command.startsWith('touch '))).toBe(false);

    const writesBeforeRejectedTune = bytes.writes.length;
    await expect(service.configureAnalyzer({ ...analyzer, startHz: 900_000_000, stopHz: 900_000_001, points: 450 }))
      .rejects.toThrow(/outside 0\.\.900000000 Hz/i);
    expect(bytes.writes).toHaveLength(writesBeforeRejectedTune);
    await service.disconnect();
  });

  it('does not broaden an unqualified receiver without exact physical USB evidence', async () => {
    const transport = new FakeTinySaTransport({
      versionResponse: 'tinySA4_test-custom-gdeadbee\r\nHW Version:V0.5.4 + ZS407 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_test-custom-gdeadbee',
    });
    const service = new TinySaDeviceService(transport);

    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      execution: 'protocol-test-double',
      usbIdentityVerified: false,
      firmwareQualification: 'custom-unqualified',
    });
    expect(connected.capabilities?.analyzerFrequency).toEqual({
      min: 88_000_000,
      max: 108_000_000,
      step: 1,
      unit: 'Hz',
    });
    await service.disconnect();
  });

  it('fails closed when custom-firmware receive-retune readback is not exact', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_hw-v0.3-fft1024-g43eb0f1\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_hw-v0.3-fft1024-g43eb0f1',
      commandResponseSequences: {
        sweep: [
          '88000000 108000000 450',
          '88000000 108000000 450',
          '758000000 767999999 450',
        ],
      },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    const retune: AnalyzerConfig = {
      ...analyzer,
      startHz: 758_000_000,
      stopHz: 768_000_000,
      points: 450,
      trigger: { mode: 'auto' },
    };

    await expect(service.configureAnalyzer(retune)).rejects.toThrow(
      /readback 758000000\.\.767999999\/450 does not match request 758000000\.\.768000000\/450/i,
    );

    expect(service.snapshot()).toMatchObject({
      connection: 'ready',
      mode: 'idle',
      generatorOutput: 'off',
      verification: 'commanded',
      analyzer: undefined,
      generator: undefined,
      fault: { code: 'protocol' },
    });
    await expect(service.acquireSweep()).rejects.toThrow(/Analyzer is not configured/i);
    expect(bytes.writes).not.toContain('output on');
    const offBeforeDisconnect = bytes.writes.filter((command) => command === 'output off').length;
    await service.disconnect();
    // The retune began with a current acknowledged output-off command, so
    // Teardown now records its own command acknowledgement rather than
    // relabeling the most recent analyzer-configuration receipt.
    expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(offBeforeDisconnect + 1);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('admits the source-exact Atom-Firmware 53850c4 multiline probe surface without executing scan', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-326-g53850c4\r\nHW Version:V0.5.4 + ZS407 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-326-g53850c4',
      commandResponses: FIRMWARE_53850C4_PROBE_REPLIES,
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      firmwareReportedRevision: '53850c4',
      firmwareQualification: 'custom-unqualified',
    });
    expect(connected.identity).not.toHaveProperty('firmwareSourceCommit');
    expect(connected.capabilities).toMatchObject({
      rbwKhz: { min: 0.2, max: 850, step: 0.1, unit: 'kHz' },
      attenuationDb: { min: 0, max: 31, step: 1, unit: 'dB' },
      sweepSeconds: { min: 0.003, max: 60, step: 0.000_001, unit: 'seconds' },
      rawSweepOffsetReadback: true,
      firmwareTraces: false,
      scalarReceiver: {
        sweptSpectrum: true,
        detectedPower: true,
        acquisitionFormats: ['text', 'raw'],
        resolutionBandwidthAutomatic: true,
        attenuationAutomatic: true,
        sweepTimeAutomatic: false,
        detectors: ['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak'],
        spurRejection: ['off', 'on', 'auto'],
        lowNoiseAmplifier: ['off', 'on'],
        avoidSpurs: ['auto', 'off', 'on'],
        triggerModes: ['auto'],
      },
    });
    expect(bytes.writes).toContain('help');
    const firstProbe = bytes.writes.indexOf(FIRMWARE_53850C4_PROBE_COMMANDS[0]);
    expect(bytes.writes.slice(firstProbe, firstProbe + FIRMWARE_53850C4_PROBE_COMMANDS.length))
      .toEqual(FIRMWARE_53850C4_PROBE_COMMANDS);
    expect(bytes.writes).not.toContain('scan ?');
    await service.disconnect();
  });

  it('withholds capabilities when source-exact multiline probe replies are partial or contaminated', async () => {
    const cases = [
      {
        command: 'sweep ?',
        response: `${FIRMWARE_53850C4_PROBE_REPLIES['sweep ?']}\r\nnote: approximately compatible`,
        expected: 'no-common-receiver',
      },
      {
        command: 'zero ?',
        response: 'zero {level}\r\n-174dBm',
        expected: 'no-raw-offset',
      },
      {
        command: 'trace ?',
        response: 'trace {dBm|dBmV|dBuV|RAW|V|Vpp|W}\r\ntrace {scale|reflevel} auto|{value}\r\ntrace [{trace#}] value',
        expected: 'no-common-receiver',
      },
      {
        command: 'calc ?',
        response: `${FIRMWARE_53850C4_PROBE_REPLIES['calc ?']}\r\npossibly OFF`,
        expected: 'no-detectors',
      },
    ] as const;

    for (const candidate of cases) {
      const bytes = new FakeTinySaTransport({
        versionResponse: 'tinySA4_v1.4-326-g53850c4\r\nHW Version:V0.5.4 + ZS407 max2871',
        infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-326-g53850c4',
        commandResponses: { ...FIRMWARE_53850C4_PROBE_REPLIES, [candidate.command]: candidate.response },
      });
      const transport = new PhysicalFixtureTransport(bytes);
      const service = new TinySaDeviceService(transport);
      const connected = await service.connect(transport.port);

      if (candidate.expected === 'no-common-receiver') {
        expect(connected.capabilities?.scalarReceiver).toMatchObject({ sweptSpectrum: false, detectedPower: false });
      } else if (candidate.expected === 'no-raw-offset') {
        expect(connected.capabilities).toMatchObject({
          rawSweepOffsetReadback: false,
          scalarReceiver: { acquisitionFormats: ['text'] },
        });
      } else {
        expect(connected.capabilities?.scalarReceiver.detectors).toEqual([]);
        expect(connected.capabilities?.scalarReceiver.sweptSpectrum).toBe(false);
      }
      await service.disconnect();
    }
  });

  it('projects only the proven reduced custom-firmware receiver surface and exact advertised ranges', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      helpCommands: [
        'version', 'info', 'help', 'output', 'mode', 'sweep', 'zero', 'rbw', 'attenuate', 'status', 'vbat', 'deviceid',
        'scan', 'trace', 'sweeptime', 'calc', 'spur', 'avoid', 'lna', 'trigger', 'capture', 'touch', 'release',
      ],
      commandResponses: {
        'rbw ?': 'usage: rbw 5..25|auto',
        'attenuate ?': 'usage: attenuate 2..12|auto',
        'sweeptime ?': 'usage: sweeptime 0.01..2',
        'trace ?': 'usage: trace {dBm|RAW}',
      },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(service),
    ]));
    const managerEvents: unknown[] = [];
    manager.subscribe((event) => managerEvents.push(event));
    const connected = await manager.connect((await manager.discover()).candidates[0]!);

    expect(connected).toMatchObject({
      rfOutput: 'not-supported',
      rfOutputQualification: 'not-applicable',
      provenance: { device: { firmwareQualification: 'custom-unqualified' } },
      capabilities: {
        acquisitions: expect.arrayContaining([
          expect.objectContaining({
            kind: 'swept-spectrum',
            frequencyHz: { min: 0, max: 900_000_000, step: 1 },
            points: { min: 450, max: 450, step: 1 },
            sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.01, max: 2, step: 0.000_001 } },
            controls: expect.objectContaining({
              acquisitionFormats: ['text'],
              resolutionBandwidthKhz: { automatic: true, manual: { min: 5, max: 25, step: 0.1 } },
              attenuationDb: { automatic: true, manual: { min: 2, max: 12, step: 1 } },
              triggerModes: ['auto'],
            }),
          }),
          expect.objectContaining({
            kind: 'detected-power-timeseries',
            centerFrequencyHz: { min: 0, max: 900_000_000, step: 1 },
            sampleCount: { min: 450, max: 450, step: 1 },
            controls: expect.objectContaining({ triggerModes: ['auto'] }),
          }),
        ]),
        features: [{
          kind: 'diagnostics',
          reports: ['identity', 'health', 'configuration'],
        }],
      },
      receiveOnlySafety: {
        connectionReceipt: { reason: 'connection-first-command' },
      },
    });
    const spectrum = connected.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
    expect(spectrum?.controls).not.toHaveProperty('triggerLevelDbm');

    expect(bytes.writes).not.toContain('capture');
    expect(bytes.writes).not.toContain('touch 12 34');

    await expect(manager.configure({
      kind: 'swept-spectrum', startHz: 758_000_000, stopHz: 768_000_000, points: 450, sweepTimeSeconds: 0.5,
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
        attenuationDb: 5, detector: 'quasi-peak', spurRejection: 'on', lowNoiseAmplifier: 'on',
        avoidSpurs: 'off', trigger: { mode: 'auto' },
      },
    })).rejects.toThrow(/resolution bandwidth/i);
    expect(bytes.writes).not.toContain('rbw 30');

    await manager.configure({
      kind: 'swept-spectrum', startHz: 758_000_000, stopHz: 768_000_000, points: 450, sweepTimeSeconds: 0.5,
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 20,
        attenuationDb: 5, detector: 'quasi-peak', spurRejection: 'on', lowNoiseAmplifier: 'on',
        avoidSpurs: 'off', trigger: { mode: 'auto' },
      },
    });
    const outputOffBeforeAcquire = bytes.writes.filter((command) => command === 'output off').length;
    const measurement = await manager.acquire();

    expect(measurement).toMatchObject({
      kind: 'swept-spectrum',
      qualification: 'device-observed',
      receiveOnlySafetyReceipt: { reason: 'pre-acquisition' },
    });
    expect(manager.snapshot()?.receiveOnlySafety?.currentReceipt).toEqual(measurement.receiveOnlySafetyReceipt);
    expect(managerEvents).toContainEqual(expect.objectContaining({
      type: 'session-state',
      reason: 'receive-only-safety-advanced',
      session: expect.objectContaining({
        receiveOnlySafety: expect.objectContaining({
          currentReceipt: measurement.receiveOnlySafetyReceipt,
        }),
      }),
    }));
    // The session boundary and the device's immediately adjacent acquisition
    // guard both reassert output-off. Only the latter receipt may bind data.
    expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(outputOffBeforeAcquire + 2);
    const scan = bytes.writes.lastIndexOf('scan 758000000 768000000 450 3');
    expect(scan).toBeGreaterThan(-1);
    expect(bytes.writes.slice(scan + 1)).not.toContain('trace');
    await manager.disconnect();
  });

  it('fails closed and cleans up when custom firmware cannot describe any complete acquisition', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      helpCommands: [
        'version', 'info', 'help', 'output', 'mode', 'sweep', 'zero', 'rbw', 'attenuate', 'status', 'vbat', 'deviceid',
        'sweeptime',
      ],
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(service),
    ]));
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toThrow(/could not open the selected candidate/i);

    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
    expect(manager.snapshot()).toBeUndefined();
    expect(manager.pendingConnectionCleanup()).toBeUndefined();
  });

  it('rejects custom firmware whose scalar control ranges are not explicitly parseable', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: { 'rbw ?': 'usage: rbw implementation-defined' },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/did not advertise parseable RBW/i);

    const lastProbe = bytes.writes.map((command) => command.endsWith(' ?')).lastIndexOf(true);
    expect(bytes.writes.slice(lastProbe + 1, lastProbe + 4)).toEqual(['output off', 'mode input', 'sweep']);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it.each([
    ['misleading prefix', 'prefix usage: rbw 5..25|auto'],
    ['negative prose', 'RBW unsupported; usage: rbw 5..25|auto'],
    ['duplicate declarations', 'usage: rbw 5..25|auto\r\nusage: rbw 10..20|auto'],
    ['arbitrary colon line', 'note: rbw 5..25|auto'],
  ])('rejects %s instead of extracting a custom range from prose', async (_case, rbwResponse) => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: { 'rbw ?': rbwResponse },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/did not advertise parseable RBW/i);

    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it('never lets custom startup geometry broaden the normal receive-only envelope and clips scalar ranges', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: {
        sweep: '0 20000000000 450',
        'rbw ?': 'usage: rbw 0.05..900|auto',
        'attenuate ?': 'usage: attenuate -5..40|auto',
        'sweeptime ?': 'usage: sweeptime 0.000001..90',
      },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    const connected = await service.connect(transport.port);

    expect(connected.capabilities).toMatchObject({
      analyzerFrequency: { min: 0, max: 900_000_000, step: 1, unit: 'Hz' },
      sweepPoints: { min: 450, max: 450, step: 1, unit: 'points' },
      rbwKhz: { min: 0.2, max: 850, step: 0.1, unit: 'kHz' },
      attenuationDb: { min: 0, max: 31, step: 1, unit: 'dB' },
      sweepSeconds: { min: 0.003, max: 60, step: 0.000_001, unit: 'seconds' },
    });
    await service.disconnect();
  });

  it('rounds custom range endpoints inward to values the wire encoding can represent', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: {
        'rbw ?': 'usage: rbw 0.21..1.09',
        'attenuate ?': 'usage: attenuate 2.2..12.8',
        'sweeptime ?': 'usage: sweeptime 0.0030001..0.0100009',
      },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    const connected = await service.connect(transport.port);

    expect(connected.capabilities).toMatchObject({
      rbwKhz: { min: 0.3, max: 1, step: 0.1 },
      attenuationDb: { min: 3, max: 12, step: 1 },
      sweepSeconds: { min: 0.003_001, max: 0.01, step: 0.000_001 },
    });
    await service.disconnect();
  });

  it.each([
    ['rbw ?', 'usage: rbw 0.01..0.19', /RBW range .* has no value/i],
    ['attenuate ?', 'usage: attenuate 31.1..31.9', /attenuation range .* has no value/i],
    ['sweeptime ?', 'usage: sweeptime 0.001..0.002', /sweep-time range .* has no value/i],
  ])('rejects an empty quantized intersection advertised by %s', async (command, response, expected) => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: { [command]: response },
    });
    const transport = new PhysicalFixtureTransport(bytes);

    await expect(new TinySaDeviceService(transport).connect(transport.port)).rejects.toThrow(expected);
  });

  it('rejects custom sweep-point geometry outside the adapter schema before admission', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: { sweep: '88000000 108000000 10' },
    });
    const transport = new PhysicalFixtureTransport(bytes);

    await expect(new TinySaDeviceService(transport).connect(transport.port))
      .rejects.toThrow(/sweep point count range .* has no value/i);
  });

  it.each([
    'tinySA4_v1.4-999-gdeadbee',
    'tinySA4_hw-v0.3-fft1024-g43eb0f1',
  ])('rejects a %s custom shell probe that changes geometry after restoring RF-off input mode', async (firmwareVersion) => {
    const bytes = new FakeTinySaTransport({
      versionResponse: `${firmwareVersion}\r\nHW Version:V0.5.4 max2871`,
      infoResponse: `tinySA ULTRA+ ZS407\r\nVersion: ${firmwareVersion}`,
      commandResponseSequences: {
        sweep: ['88000000 108000000 450', '90000000 110000000 450'],
      },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/capability probes changed analyzer geometry/i);

    const lastProbe = bytes.writes.map((command) => command.endsWith(' ?')).lastIndexOf(true);
    expect(bytes.writes.slice(lastProbe + 1, lastProbe + 4)).toEqual(['output off', 'mode input', 'sweep']);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it('cannot bypass output-off and exact restoration when a frozen 43eb0f1 capability probe fails', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_hw-v0.3-fft1024-g43eb0f1\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_hw-v0.3-fft1024-g43eb0f1',
      initialSweepPoints: 101,
      commandResponses: { 'rbw ?': 'usage: rbw implementation-defined' },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/did not advertise parseable RBW/i);

    const lastProbe = bytes.writes.map((command) => command.endsWith(' ?')).lastIndexOf(true);
    expect(bytes.writes.slice(lastProbe + 1, lastProbe + 7)).toEqual([
      'output off', 'mode input', 'sweep', 'rbw', 'attenuate', 'status',
    ]);
    expect(bytes.writes.filter((command) => command === 'output off').length).toBeGreaterThanOrEqual(3);
    expect(bytes.writes).not.toContain('output on');
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('resets every automatic analyzer control explicitly, including firmware sweeptime zero', async () => {
    const bytes = new FakeTinySaTransport();
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);

    await service.configureAnalyzer(analyzer);
    const automatic = await service.configureAnalyzer({
      ...analyzer,
      rbwKhz: 'auto',
      attenuationDb: 'auto',
      sweepTimeSeconds: 'auto',
      spurRejection: 'auto',
      avoidSpurs: 'auto',
      trigger: { mode: 'auto' },
    });

    const manualSweepTime = bytes.writes.lastIndexOf('sweeptime 0.25');
    const automaticCommands = bytes.writes.slice(manualSweepTime + 1);
    expect(automaticCommands).toEqual(expect.arrayContaining([
      'rbw auto', 'attenuate auto', 'sweeptime 0', 'spur auto', 'avoid auto', 'trigger auto',
    ]));
    expect(automaticCommands.indexOf('sweeptime 0')).toBeGreaterThan(automaticCommands.indexOf('attenuate auto'));
    expect(automatic.analyzer).toMatchObject({
      requested: { rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', spurRejection: 'auto', avoidSpurs: 'auto', trigger: { mode: 'auto' } },
      readback: { actualRbwHz: expect.any(Number), attenuationDb: expect.any(Number) },
      verification: 'commanded',
    });
    await service.disconnect();
  });

  it('turns RF off and prepares detected power completely during configuration, before acquisition', async () => {
    const bytes = new FakeTinySaTransport();
    const transport = new PhysicalFixtureTransport(bytes);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(new TinySaDeviceService(transport)),
    ]));
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: generator.frequencyHz,
      levelDbm: generator.levelDbm, path: generator.path, modulation: { mode: 'off' },
    });
    await manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: true });
    expect(manager.snapshot()?.rfOutput).toBe('on');

    const outputOn = bytes.writes.lastIndexOf('output on');
    const configured = await manager.configure(detectedPowerConfiguration());
    const configurationCommands = bytes.writes.slice(outputOn + 1);

    expect(configured.configuration).toEqual(detectedPowerConfiguration());
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'off', configuration: configured });
    expect(configurationCommands.slice(0, 9)).toEqual([
      'output off', 'mode input', 'trace dBm', 'sweep 100000000 100000000 20',
      'rbw 100', 'attenuate 9', 'sweeptime 0.02', 'trigger single', 'trigger -71',
    ]);
    expect(configurationCommands).not.toContain('scan 100000000 100000000 20 3');

    await manager.acquire();
    expect(bytes.writes).toContain('scan 100000000 100000000 20 3');
    await manager.disconnect();
  });

  it('never publishes a detected-power configuration when a physical preparation command fails', async () => {
    const bytes = new FakeTinySaTransport({ commandResponses: { 'rbw 100': 'usage: rbw 0.2..850|auto' } });
    const transport = new PhysicalFixtureTransport(bytes);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(new TinySaDeviceService(transport)),
    ]));
    const events: unknown[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.configure(detectedPowerConfiguration())).rejects.toThrow(/configuration failed/i);

    expect(bytes.writes).toContain('output off');
    expect(bytes.writes).toContain('rbw 100');
    expect(events.some((event) => (event as { type?: unknown }).type === 'configured')).toBe(false);
    expect(manager.snapshot()?.configuration).toBeUndefined();
    expect(manager.snapshot()?.fault).toBeDefined();
    await manager.disconnect();
  });

  it('still rejects firmware that omits a parseable source revision', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_custom\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_custom',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    await expect(new TinySaDeviceService(transport).connect(transport.port)).rejects.toThrow(/did not report a source revision/);
  });

  it('reports RF-off failure during disconnect and enters faulted/unknown state', async () => {
    const transport = new FailDisconnectOutputOffTransport();
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureGenerator(generator);
    await service.setGeneratorOutput(true);

    await expect(service.disconnect()).rejects.toThrow(/forced output-off failure/);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown' });
  });

  it('marks an unexpected cable loss as faulted with unknown RF state', async () => {
    const transport = new FakeTinySaTransport();
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureGenerator(generator);
    await service.setGeneratorOutput(true);
    transport.unplug();
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown' });
  });

  it('retains an RF-off session after close failure so manager shutdown can retry to completion', async () => {
    const transport = new RetryPhysicalCloseTransport();
    const service = new TinySaDeviceService(transport);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(service),
    ]));
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    await expect(manager.disconnect()).rejects.toThrow(/forced transient close failure/);
    expect(manager.snapshot()).toMatchObject({
      fault: { recoverable: false },
      rfOutput: 'unknown',
    });
    expect(service.snapshot()).toMatchObject({
      connection: 'faulted',
      generatorOutput: 'off',
      verification: 'commanded',
    });

    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(2);
    expect(manager.snapshot()).toBeUndefined();
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it('retains a failed-connect transport for explicit app-owned cleanup retries', async () => {
    const transport = new RetryRejectedConnectCloseTransport();
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/transport cleanup also failed/);
    expect(transport.closeCalls).toBe(1);
    expect(service.snapshot()).toMatchObject({
      connection: 'faulted',
      generatorOutput: 'off',
      verification: 'commanded',
    });

    await expect(service.cleanupPendingInstrumentConnection()).rejects.toThrow(/forced retained-connect close failure/);
    expect(transport.closeCalls).toBe(2);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'off' });

    await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(3);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });

    await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(3);
  });
});

function detectedPowerConfiguration() {
  return {
    kind: 'detected-power-timeseries' as const,
    centerHz: 100_000_000,
    sampleCount: 20,
    sweepTimeSeconds: 0.02,
    controls: {
      schemaVersion: 1 as const,
      model: 'receiver' as const,
      resolutionBandwidthKhz: 100,
      attenuationDb: 9,
      trigger: { mode: 'single' as const, levelDbm: -71 },
    },
  };
}

class PhysicalFixtureTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-zs407', path: '/dev/tty.fixture', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  constructor(private readonly inner: FakeTinySaTransport) {}
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.port], failures: [] }); }
  open(): Promise<void> { return this.inner.open(this.inner.port); }
  close(): Promise<void> { return this.inner.close(); }
  write(bytes: Uint8Array): Promise<void> { return this.inner.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return undefined; }
}

class FailDisconnectOutputOffTransport implements ByteTransport {
  readonly kind = 'protocol-test-double' as const;
  readonly #inner = new FakeTinySaTransport();
  #outputOffCount = 0;
  get port(): PortCandidate { return this.#inner.port; }
  list(): Promise<TransportDiscoveryResult> { return this.#inner.list(); }
  open(candidate: PortCandidate): Promise<void> { return this.#inner.open(candidate); }
  close(): Promise<void> { return this.#inner.close(); }
  async write(bytes: Uint8Array): Promise<void> {
    const command = new TextDecoder().decode(bytes).trim();
    if (command === 'output off' && ++this.#outputOffCount === 5) throw new Error('forced output-off failure');
    await this.#inner.write(bytes);
  }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.#inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.#inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return this.#inner.consumeAcquisitionMetadata(); }
}

class RetryPhysicalCloseTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-retry-close', path: '/dev/tty.retry-close', vendorId: '0483', productId: '5740',
    usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  readonly #inner = new FakeTinySaTransport();
  closeCalls = 0;
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.port], failures: [] }); }
  open(): Promise<void> { return this.#inner.open(this.#inner.port); }
  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeCalls === 1
      ? Promise.reject(new Error('forced transient close failure'))
      : this.#inner.close();
  }
  write(bytes: Uint8Array): Promise<void> { return this.#inner.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.#inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.#inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return this.#inner.consumeAcquisitionMetadata(); }
}

class RetryRejectedConnectCloseTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-rejected-connect', path: '/dev/tty.rejected-connect', vendorId: '0483', productId: '5740',
    usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  readonly #inner = new FakeTinySaTransport({
    versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
    infoResponse: 'tinySA ULTRA ZS405\r\nVersion: tinySA4_v1.4-217-gc5dd31f',
  });
  closeCalls = 0;
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.port], failures: [] }); }
  open(): Promise<void> { return this.#inner.open(this.#inner.port); }
  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeCalls <= 2
      ? Promise.reject(new Error('forced retained-connect close failure'))
      : this.#inner.close();
  }
  write(bytes: Uint8Array): Promise<void> { return this.#inner.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.#inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.#inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return this.#inner.consumeAcquisitionMetadata(); }
}
