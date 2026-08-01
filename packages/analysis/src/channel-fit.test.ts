import { describe, expect, it } from 'vitest';
import type {
  ChannelMeasurementConfiguration,
  DeviceIdentity,
  Sweep,
} from '@tinysa/contracts';
import {
  fitChannelConfigurationToSweep,
  measureChannel,
  measureOccupiedBandwidth,
} from './index.js';

const identity: DeviceIdentity = {
  model: 'tinySA Ultra+ ZS407',
  hardwareVersion: 'test',
  firmwareVersion: 'test',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'channel-fit-test',
    path: 'test://channel-fit',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

const currentConfiguration: ChannelMeasurementConfiguration = {
  centerHz: 500_000,
  mainBandwidthHz: 100_000,
  adjacentBandwidthHz: 100_000,
  channelSpacingHz: 100_000,
  adjacentChannelCount: 3,
  occupiedPowerPercent: 99,
  obwNoiseCorrection: 'robust-floor',
};

describe('one-shot channel configuration fit', () => {
  it('uses a bounded wide component centroid and encloses its local OBW with one resolution guard', () => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const powerDbm = frequencyHz.map((frequency, index) =>
      frequency >= 300_000 && frequency <= 500_000
        ? -42 - (index % 2) * 3
        : -120);
    powerDbm[470] = -28;
    const sweep = makeSweep(frequencyHz, powerDbm, 1_000);

    const fit = fitChannelConfigurationToSweep(sweep, currentConfiguration);

    expect(fit.status).toBe('fitted');
    if (fit.status !== 'fitted') throw new Error(fit.message);
    expect(fit.evidence.centerMethod).toBe('resolved-component-linear-power-centroid');
    expect(fit.configuration.centerHz).toBeGreaterThan(380_000);
    expect(fit.configuration.centerHz).toBeLessThan(440_000);
    expect(fit.configuration.centerHz).not.toBe(470_000);
    const halfMainHz = fit.configuration.mainBandwidthHz / 2;
    expect(fit.configuration.centerHz - halfMainHz)
      .toBeLessThanOrEqual(fit.evidence.componentOccupiedBandwidth.startHz - 1_000);
    expect(fit.configuration.centerHz + halfMainHz)
      .toBeGreaterThanOrEqual(fit.evidence.componentOccupiedBandwidth.stopHz + 1_000);
    expect(fit.evidence).toMatchObject({
      sourceSweepId: sweep.id,
      resolutionScaleHz: 1_000,
      qualification: 'strongest-prominence-qualified-trace-component-not-channel-plan',
    });
    expectValidLayout(sweep, fit.configuration, fit.evidence.resolutionScaleHz);
    expect(() => measureChannel(sweep, fit.configuration)).not.toThrow();
  });

  it('keeps a resolution-limited CW on its sampled peak', () => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -35 - 10 * Math.log10(2) * (2 * (frequency - 625_000) / 1_000) ** 2,
    ));
    const sweep = makeSweep(frequencyHz, powerDbm, 1_000);

    const fit = fitChannelConfigurationToSweep(sweep, currentConfiguration);

    expect(fit.status).toBe('fitted');
    if (fit.status !== 'fitted') throw new Error(fit.message);
    expect(fit.evidence.centerMethod).toBe('local-peak');
    expect(fit.configuration.centerHz).toBe(625_000);
    expect(fit.configuration.mainBandwidthHz).toBeGreaterThanOrEqual(3_000);
    expectValidLayout(sweep, fit.configuration, fit.evidence.resolutionScaleHz);
    const measurement = measureChannel(sweep, fit.configuration);
    expect(measurement.threeDecibelBandwidth.status).toBe('resolution-limited');
  });

  it('fails without mutating configuration when no component clears the robust gate', () => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const sweep = makeSweep(frequencyHz, frequencyHz.map(() => -100), 1_000);
    const before = structuredClone(currentConfiguration);

    const fit = fitChannelConfigurationToSweep(sweep, currentConfiguration);

    expect(fit).toMatchObject({
      status: 'unavailable',
      reason: 'no-qualified-local-component',
      sourceSweepId: sweep.id,
    });
    expect(currentConfiguration).toEqual(before);
  });

  it('ignores a stronger unqualified pedestal and fits the strongest prominence-qualified component', () => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const powerDbm = frequencyHz.map(() => -120);
    for (let index = 190; index <= 210; index++) powerDbm[index] = -110.1;
    powerDbm[200] = -109.8;
    powerDbm[700] = -110;
    const sweep = makeSweep(frequencyHz, powerDbm, 1_000, 'pedestal-plus-qualified');

    const fit = requireFitted(fitChannelConfigurationToSweep(sweep, currentConfiguration));

    expect(fit.configuration.centerHz).toBe(700_000);
    expect(fit.evidence.componentStartHz).toBe(700_000);
    expect(fit.evidence.componentStopHz).toBe(700_000);
  });

  it.each([
    { name: 'lower', first: 0, last: 100 },
    { name: 'upper', first: 900, last: 1_000 },
  ])('fails closed when the strongest component is $name-edge censored', ({ first, last }) => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const powerDbm = frequencyHz.map((_frequency, index) =>
      index >= first && index <= last ? -40 : -120);

    expect(fitChannelConfigurationToSweep(
      makeSweep(frequencyHz, powerDbm, 1_000),
      currentConfiguration,
    )).toMatchObject({ status: 'unavailable', reason: 'component-edge-censored' });
  });

  it('fails when the fitted main response leaves no two-sided comparison evidence', () => {
    const frequencyHz = regularGrid(0, 100_000, 1_000);
    const powerDbm = frequencyHz.map((frequency) =>
      frequency >= 2_000 && frequency <= 72_000 ? -40 : -120);
    const sweep = makeSweep(frequencyHz, powerDbm, 1_000);

    expect(fitChannelConfigurationToSweep(sweep, {
      ...currentConfiguration,
      centerHz: 50_000,
    })).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-adjacent-span',
    });
  });

  it('reduces and clamps an off-center multi-pair layout deterministically', () => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const powerDbm = frequencyHz.map((frequency, index) =>
      frequency >= 150_000 && frequency <= 350_000
        ? -40 - (index % 2) * 2
        : -120);
    const sweep = makeSweep(frequencyHz, powerDbm, 1_000);
    const requested: ChannelMeasurementConfiguration = {
      ...currentConfiguration,
      channelSpacingHz: 500_000,
    };

    const first = fitChannelConfigurationToSweep(sweep, requested);
    const second = fitChannelConfigurationToSweep(sweep, requested);

    expect(first).toEqual(second);
    expect(first.status).toBe('fitted');
    if (first.status !== 'fitted') throw new Error(first.message);
    expect(first.configuration.adjacentChannelCount).toBeLessThan(3);
    expect(first.adjustments).toMatchObject({
      adjacentChannelCountReduced: true,
      adjacentBandwidthAdjusted: true,
      channelSpacingAdjusted: true,
    });
    expectValidLayout(sweep, first.configuration, first.evidence.resolutionScaleHz);
    expect(() => measureChannel(sweep, first.configuration)).not.toThrow();
  });

  it('is invariant to absolute power offset and does not substitute whole-span OBW', () => {
    const frequencyHz = regularGrid(0, 1_000_000, 1_000);
    const primaryOnly = frequencyHz.map((frequency, index) =>
      frequency >= 200_000 && frequency <= 320_000
        ? -35 - (index % 2) * 2
        : -120);
    const withRemoteComponent = primaryOnly.map((power, index) =>
      frequencyHz[index]! >= 780_000 && frequencyHz[index]! <= 860_000 ? -48 : power);
    const primarySweep = makeSweep(frequencyHz, primaryOnly, 1_000, 'primary');
    const remoteSweep = makeSweep(frequencyHz, withRemoteComponent, 1_000, 'remote');
    const shiftedSweep = makeSweep(
      frequencyHz,
      withRemoteComponent.map((power) => power + 37),
      1_000,
      'shifted',
    );

    const primaryFit = requireFitted(fitChannelConfigurationToSweep(primarySweep, currentConfiguration));
    const remoteFit = requireFitted(fitChannelConfigurationToSweep(remoteSweep, currentConfiguration));
    const shiftedFit = requireFitted(fitChannelConfigurationToSweep(shiftedSweep, currentConfiguration));

    expect(remoteFit.configuration).toEqual(primaryFit.configuration);
    expect(shiftedFit.configuration).toEqual(remoteFit.configuration);
    expect(remoteFit.evidence.componentOccupiedBandwidth.bandwidthHz)
      .toBe(primaryFit.evidence.componentOccupiedBandwidth.bandwidthHz);
    expect(measureOccupiedBandwidth(remoteSweep, 99, 'robust-floor').bandwidthHz)
      .toBeGreaterThan(remoteFit.configuration.mainBandwidthHz * 4);
  });

  it('fits a Neptune-shaped uncalibrated 4096-bin I/Q projection', () => {
    const points = 4_096;
    const binWidthHz = 10_000_000 / points;
    const frequencyHz = Array.from({ length: points }, (_, index) =>
      94_000_000 + index * binWidthHz);
    const powerDbm = frequencyHz.map((frequency, index) =>
      frequency >= 99_050_000 && frequency <= 99_350_000
        ? -31 - (index % 3) * 1.5
        : -102);
    const sweep = makeSweep(
      frequencyHz,
      powerDbm,
      binWidthHz * 1.5,
      'neptune-iq',
      true,
    );

    const fit = fitChannelConfigurationToSweep(sweep, {
      ...currentConfiguration,
      centerHz: 98_000_000,
      mainBandwidthHz: 200_000,
      adjacentBandwidthHz: 200_000,
      channelSpacingHz: 200_000,
      adjacentChannelCount: 2,
    });

    expect(fit.status).toBe('fitted');
    if (fit.status !== 'fitted') throw new Error(fit.message);
    expect(fit.configuration.centerHz).toBeGreaterThan(99_150_000);
    expect(fit.configuration.centerHz).toBeLessThan(99_250_000);
    expect(fit.evidence.resolutionScaleHz).toBe(Math.ceil(binWidthHz * 1.5));
    expectValidLayout(sweep, fit.configuration, fit.evidence.resolutionScaleHz);
    expect(() => measureChannel(sweep, fit.configuration)).not.toThrow();
  });
});

function requireFitted(
  result: ReturnType<typeof fitChannelConfigurationToSweep>,
) {
  if (result.status !== 'fitted') throw new Error(result.message);
  return result;
}

function expectValidLayout(
  sweep: Sweep,
  configuration: ChannelMeasurementConfiguration,
  resolutionScaleHz: number,
): void {
  expect(configuration.channelSpacingHz)
    .toBeGreaterThanOrEqual((configuration.mainBandwidthHz + configuration.adjacentBandwidthHz) / 2);
  const outerExtentHz = configuration.adjacentChannelCount * configuration.channelSpacingHz
    + configuration.adjacentBandwidthHz / 2;
  expect(configuration.centerHz - outerExtentHz)
    .toBeGreaterThanOrEqual(sweep.actualStartHz + resolutionScaleHz);
  expect(configuration.centerHz + outerExtentHz)
    .toBeLessThanOrEqual(sweep.actualStopHz - resolutionScaleHz);
}

function regularGrid(startHz: number, stopHz: number, stepHz: number): number[] {
  return Array.from({ length: Math.floor((stopHz - startHz) / stepHz) + 1 },
    (_, index) => startHz + index * stepHz);
}

function makeSweep(
  frequencyHz: readonly number[],
  powerDbm: readonly number[],
  actualRbwHz: number,
  id = 'channel-fit-sweep',
  uncalibratedIq = false,
): Sweep {
  const startHz = frequencyHz[0]!;
  const stopHz = frequencyHz.at(-1)!;
  return {
    kind: 'spectrum',
    id,
    sequence: 1,
    capturedAt: '2026-07-31T00:00:00.000Z',
    elapsedMilliseconds: 20,
    frequencyHz,
    powerDbm,
    ...(uncalibratedIq
      ? { powerReference: 'uncalibrated-dbfs-relative' as const }
      : {}),
    requested: uncalibratedIq
      ? {
        kind: 'swept-spectrum',
        startHz,
        stopHz,
        points: frequencyHz.length,
        sweepTimeSeconds: 0.001,
        controls: {
          schemaVersion: 1,
          model: 'host-derived-iq-projection',
          fftSize: frequencyHz.length,
          window: 'hann-periodic',
        },
      }
      : {
        kind: 'swept-spectrum',
        startHz,
        stopHz,
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
    actualStartHz: startHz,
    actualStopHz: stopHz,
    actualRbwHz,
    actualAttenuationDb: uncalibratedIq ? null : 0,
    ...(uncalibratedIq
      ? {
        resolutionBandwidthQualification: 'host-derived-fft-bin' as const,
        attenuationQualification: 'not-applicable' as const,
      }
      : {}),
    source: uncalibratedIq ? 'host-derived-from-complex-iq' : 'scan-text',
    complete: true,
    identity,
  };
}
