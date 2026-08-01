import { describe, expect, it } from 'vitest';
import { fitChannelConfigurationToSweep } from '@tinysa/analysis';
import type { ChannelMeasurementConfiguration, Sweep } from '@tinysa/contracts';
import { reconcileChannelConfigurationToSweep } from './acquisition.js';

const channel: ChannelMeasurementConfiguration = {
  centerHz: 98_000_000,
  mainBandwidthHz: 100_000,
  adjacentBandwidthHz: 50_000,
  channelSpacingHz: 75_000,
  adjacentChannelCount: 2,
  occupiedPowerPercent: 99,
  obwNoiseCorrection: 'none',
};

describe('channel configuration reconciliation', () => {
  it('moves stale persisted windows into a newly accepted I/Q-derived FFT span', () => {
    const fitted = reconcileChannelConfigurationToSweep(channel, {
      actualStartHz: 2_375_000_000,
      actualStopHz: 2_424_987_792.96875,
    });
    const extent = fitted.adjacentChannelCount * fitted.channelSpacingHz
      + fitted.adjacentBandwidthHz / 2;

    expect(fitted.centerHz).toBeGreaterThan(2_399_000_000);
    expect(fitted.centerHz).toBeLessThan(2_401_000_000);
    expect(fitted.centerHz - extent).toBeGreaterThanOrEqual(Math.ceil(2_375_000_000));
    expect(fitted.centerHz + extent).toBeLessThanOrEqual(Math.floor(2_424_987_792.96875));
  });

  it('preserves object identity when an operator configuration is already in span', () => {
    const reconciled = reconcileChannelConfigurationToSweep(channel, {
      actualStartHz: 70_000_000.25,
      actualStopHz: 125_986_328.125,
    });

    expect(reconciled).toBe(channel);
  });

  it('does not undo a valid off-center one-shot fit on the next identical sweep', () => {
    const frequencyHz = Array.from({ length: 1_001 }, (_, index) => index * 1_000);
    const sweep = makeSweep(frequencyHz, frequencyHz.map((_frequency, index) =>
      index === 100 ? -30 : -120));
    const fit = fitChannelConfigurationToSweep(sweep, {
      ...channel,
      centerHz: 500_000,
      mainBandwidthHz: 10_000,
      adjacentBandwidthHz: 1_000,
      channelSpacingHz: 500_000,
      adjacentChannelCount: 1,
    });

    expect(fit.status).toBe('fitted');
    if (fit.status !== 'fitted') throw new Error(fit.message);
    expect(fit.configuration.centerHz
      - fit.configuration.channelSpacingHz
      - fit.configuration.adjacentBandwidthHz / 2).toBe(1_000);
    expect(reconcileChannelConfigurationToSweep(fit.configuration, sweep))
      .toBe(fit.configuration);
  });
});

function makeSweep(frequencyHz: readonly number[], powerDbm: readonly number[]): Sweep {
  return {
    kind: 'spectrum',
    id: 'channel-reconcile-fit-sweep',
    sequence: 1,
    capturedAt: '2026-07-31T00:00:00.000Z',
    elapsedMilliseconds: 10,
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
        resolutionBandwidthKhz: 1,
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
    actualRbwHz: 1_000,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity: {
      model: 'test receiver',
      hardwareVersion: 'test',
      firmwareVersion: 'test',
      firmwareQualification: 'protocol-test',
      port: {
        id: 'channel-reconciliation-test',
        path: 'test://channel-reconciliation',
        usbMatch: 'protocol-test-double',
        transport: 'protocol-test-double',
        execution: 'protocol-test-double',
      },
      simulated: true,
      usbIdentityVerified: false,
      execution: 'protocol-test-double',
    },
  };
}
