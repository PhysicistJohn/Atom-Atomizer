import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OEM_ZS407_FIRMWARE_RELEASE, ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT } from '@tinysa/contracts';
import { FIRMWARE_UPDATE_JOURNAL_FILENAME, FirmwareUpdater, inspectStm32DfuDevices, parseDfuUtilVersion, parseStm32DfuDevices, verifyFirmwareArtifact } from './firmware-updater.js';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('fail-closed firmware updater primitives', () => {
  it('accepts only dfu-util 0.11', () => {
    expect(parseDfuUtilVersion('dfu-util 0.11')).toBe('0.11');
    expect(() => parseDfuUtilVersion('dfu-util 0.10')).toThrow(/requires 0.11/);
    expect(() => parseDfuUtilVersion('unknown tool')).toThrow(/missing/);
  });

  it('recognizes only STM32 DFU alt-zero internal flash', () => {
    const exact = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/128*002Kg", serial="407"';
    const optionBytes = 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=1, name="@Option Bytes", serial="407"';
    const unrelated = 'Found DFU: [1234:5678] ver=0100, devnum=6, cfg=1, intf=0, path="1-2", alt=0, name="@Internal Flash", serial="x"';
    expect(parseStm32DfuDevices([exact, optionBytes, unrelated].join('\n'))).toEqual([exact]);
    expect(parseStm32DfuDevices(`${exact}\n${exact}`)).toHaveLength(2);
    expect(inspectStm32DfuDevices([exact, optionBytes, unrelated].join('\n'))).toEqual({ deviceCount: 1, targets: [exact] });
    const second = exact.replace('devnum=5', 'devnum=8').replace('path="1-1"', 'path="1-3"');
    expect(inspectStm32DfuDevices(`${exact}\n${second}`).deviceCount).toBe(2);
    expect(() => inspectStm32DfuDevices('Found DFU: [0483:df11] alt=0, name="@Internal Flash"')).toThrow(/Malformed/);
  });

  it('rejects an artifact before hashing when its exact byte count differs', () => {
    expect(() => verifyFirmwareArtifact(new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes - 1))).toThrow(/expected 185704/);
  });

  it('rejects an exact-length artifact with the wrong SHA-256', () => {
    expect(() => verifyFirmwareArtifact(new Uint8Array(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes))).toThrow(/does not match pinned/);
  });

  it('turns an interrupted write journal into a durable do-not-flash state after restart', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, FIRMWARE_UPDATE_JOURNAL_FILENAME), JSON.stringify({
      schemaVersion: 1,
      targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      writtenAt: '2026-07-11T22:00:00.000Z',
      state: {
        phase: 'flashing', target: OEM_ZS407_FIRMWARE_RELEASE, updateAvailable: true,
        current: { version: 'tinySA4_v1.4-217-gc5dd31f', revision: 'c5dd31f', sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT },
        artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes, sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256, verifiedAt: '2026-07-11T21:58:00.000Z' },
        dfuUtility: { available: true, version: '0.11' }, dfuDevice: { detected: true, count: 1 },
        preparation: preparation(), writeDisposition: 'started', writeStartedAt: '2026-07-11T22:00:01.000Z',
      },
    }));
    const updater = new FirmwareUpdater(directory, physicalDevice());
    const state = await updater.state();
    expect(state).toMatchObject({ phase: 'failed', writeDisposition: 'started' });
    expect(state.error).toMatch(/do not flash again/i);
    await expect(updater.detectDfu()).rejects.toThrow(/write attempt already began/i);
  });

  it('locks flashing when a persisted journal cannot be validated', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, FIRMWARE_UPDATE_JOURNAL_FILENAME), '{"schemaVersion":1,"state":"corrupt"}');
    const state = await new FirmwareUpdater(directory, physicalDevice()).state();
    expect(state).toMatchObject({ phase: 'failed', writeDisposition: 'indeterminate' });
    expect(state.error).toMatch(/locked pending manual inspection/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinysa-firmware-updater-'));
  temporaryDirectories.push(directory);
  return directory;
}

function preparation() {
  return {
    id: 'a5ada7f3-fbe3-41bd-83ac-a07028bc55f6', preparedAt: '2026-07-11T21:59:00.000Z', batteryMillivolts: 4211,
    deviceId: 0, screenSha256: '39174d17a08e3f6c09407bec2d2f8088a56232c5ec177056c8f3b5b37f53694a',
    selfTestPassed: true, configurationDisposition: 'new-device-unchanged', rfPortsDisconnected: true,
  } as const;
}

function physicalDevice() {
  return {
    snapshot: () => ({ connection: 'ready', identity: {
      execution: 'physical', usbIdentityVerified: true, firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
      firmwareReportedRevision: 'c5dd31f', firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
    } }),
  } as never;
}
