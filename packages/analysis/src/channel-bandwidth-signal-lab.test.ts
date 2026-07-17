import { describe, expect, it } from 'vitest';
import type { DeviceIdentity, Sweep } from '@tinysa/contracts';
import {
  DEFAULT_REPLAY_CHANNEL,
  synthesizeSpectrum,
} from '../../../../TinySA_SignalLab/src/waveforms.js';
import { measureChannel } from './index.js';

const identity: DeviceIdentity = {
  model: 'SignalLab',
  hardwareVersion: 'test',
  firmwareVersion: 'test',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'channel-bandwidth-signal-lab-test',
    path: 'test://signal-lab/channel-bandwidth',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

describe('SignalLab analog/CW 3 dB channel integration', () => {
  it.each([
    { profile: 'cw', gridOffsetHz: 0 },
    { profile: 'am', gridOffsetHz: 250 },
    { profile: 'fm', gridOffsetHz: 500 },
  ] as const)('keeps the $profile strongest local response separate from full-trace 99% OBW', ({ profile, gridOffsetHz }) => {
    const centerHz = 98_000_000;
    const points = 501;
    const visibleSpanHz = 500_000;
    const startHz = centerHz - visibleSpanHz / 2 + gridOffsetHz;
    const stopHz = startHz + visibleSpanHz;
    const binWidthHz = visibleSpanHz / (points - 1);
    const frequencyHz = Array.from({ length: points }, (_, index) => startHz + index * binWidthHz);
    const powerDbm = synthesizeSpectrum({
      profile,
      startHz,
      stopHz,
      points,
      sweepIndex: 4,
      channel: DEFAULT_REPLAY_CHANNEL,
    });
    const result = measureChannel(makeSweep(frequencyHz, powerDbm, binWidthHz), {
      centerHz,
      mainBandwidthHz: 250_000,
      adjacentBandwidthHz: 50_000,
      channelSpacingHz: 175_000,
      adjacentChannelCount: 1,
      occupiedPowerPercent: 99,
      obwNoiseCorrection: 'none',
    });

    expect(result.threeDecibelBandwidth.status).not.toBe('unavailable');
    if (result.threeDecibelBandwidth.status === 'unavailable') throw new Error(`Expected local ${profile} half-power crossings`);
    expect(result.threeDecibelBandwidth.status).toBe('resolution-limited');
    expect(result.threeDecibelBandwidth.resolutionScaleHz).toBe(binWidthHz);
    expect(result.threeDecibelBandwidth.bandwidthHz).toBeLessThan(visibleSpanHz / 10);
    expect(result.occupiedBandwidth.percent).toBe(99);
    expect(result.occupiedBandwidth.bandwidthHz).toBeGreaterThan(result.threeDecibelBandwidth.bandwidthHz);
    expect(result.occupiedBandwidth).not.toHaveProperty('status');
  });
});

function makeSweep(
  frequencyHz: readonly number[],
  powerDbm: readonly number[],
  actualRbwHz: number,
): Sweep {
  return {
    kind: 'spectrum',
    id: 'signal-lab-channel-bandwidth-sweep',
    sequence: 1,
    capturedAt: '2026-07-16T00:00:00.000Z',
    elapsedMilliseconds: 20,
    frequencyHz,
    powerDbm,
    requested: {
      kind: 'swept-spectrum',
      startHz: frequencyHz[0]!,
      stopHz: frequencyHz.at(-1)!,
      points: frequencyHz.length,
      sweepTimeSeconds: 'auto',
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormat: 'text',
        resolutionBandwidthKhz: actualRbwHz / 1_000,
        attenuationDb: 'auto',
        detector: 'sample',
        spurRejection: 'auto',
        lowNoiseAmplifier: 'off',
        avoidSpurs: 'auto',
        trigger: { mode: 'auto' },
      },
    },
    actualStartHz: frequencyHz[0]!,
    actualStopHz: frequencyHz.at(-1)!,
    actualRbwHz,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity,
  };
}
