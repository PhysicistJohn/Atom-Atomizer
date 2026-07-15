import { describe, expect, it } from 'vitest';
import type { AnalyzerConfig, InstrumentAcquisitionCapability, ZeroSpanConfig } from '@tinysa/contracts';
import {
  detectedPowerConfigurationFor,
  reconcileAnalyzerConfiguration,
  reconcileDetectedPowerConfiguration,
  sweptSpectrumConfigurationFor,
} from './instrument-configuration.js';

const receiverSpectrum: Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }> = {
  kind: 'swept-spectrum', frequencyHz: { min: 0, max: 18_000_000_000 }, points: { min: 20, max: 450 },
  sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60 } },
  controls: {
    schemaVersion: 1, model: 'receiver', acquisitionFormats: ['text', 'raw'],
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31 } },
    detectors: ['sample', 'quasi-peak'], spurRejection: ['off', 'on', 'auto'],
    lowNoiseAmplifier: ['off', 'on'], avoidSpurs: ['off', 'on', 'auto'], triggerModes: ['auto', 'normal', 'single'],
    triggerLevelDbm: { min: -174, max: 30 },
  },
  powerUnit: 'dBm',
};
const syntheticSpectrum: Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }> = {
  ...receiverSpectrum,
  sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
  controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
};
const receiverDetectedPower: Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }> = {
  kind: 'detected-power-timeseries', centerFrequencyHz: { min: 0, max: 18_000_000_000 }, sampleCount: { min: 20, max: 450 },
  sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 60 } },
  controls: {
    schemaVersion: 1, model: 'receiver',
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31 } }, triggerModes: ['auto', 'normal', 'single'],
    triggerLevelDbm: { min: -174, max: 30 },
  },
  powerUnit: 'dBm', timing: 'uniform',
};
const syntheticDetectedPower: Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }> = {
  ...receiverDetectedPower,
  sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
  controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
};
const analyzer: AnalyzerConfig = {
  startHz: 88_000_000, stopHz: 108_000_000, points: 450, acquisitionFormat: 'text',
  rbwKhz: 30, attenuationDb: 7, sweepTimeSeconds: 0.05, detector: 'quasi-peak',
  spurRejection: 'on', lna: 'on', avoidSpurs: 'off', trigger: { mode: 'normal', levelDbm: -63 },
};
const zero: ZeroSpanConfig = {
  frequencyHz: 98_000_000, points: 450, rbwKhz: 100, attenuationDb: 9,
  sweepTimeSeconds: 0.05, trigger: { mode: 'single', levelDbm: -71 },
};

describe('renderer admitted scalar configuration', () => {
  it('carries every staged TinySA receiver control without defaults or loss', () => {
    expect(sweptSpectrumConfigurationFor(receiverSpectrum, analyzer)).toEqual({
      kind: 'swept-spectrum', startHz: analyzer.startHz, stopHz: analyzer.stopHz, points: analyzer.points,
      sweepTimeSeconds: analyzer.sweepTimeSeconds,
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
        attenuationDb: 7, detector: 'quasi-peak', spurRejection: 'on', lowNoiseAmplifier: 'on',
        avoidSpurs: 'off', trigger: { mode: 'normal', levelDbm: -63 },
      },
    });
    expect(detectedPowerConfigurationFor(receiverDetectedPower, zero)).toEqual({
      kind: 'detected-power-timeseries', centerHz: zero.frequencyHz, sampleCount: zero.points,
      sweepTimeSeconds: zero.sweepTimeSeconds,
      controls: { schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz: 100, attenuationDb: 9, trigger: { mode: 'single', levelDbm: -71 } },
    });
  });

  it('admits SignalLab exact timing without projecting any receiver control', () => {
    const spectrum = sweptSpectrumConfigurationFor(syntheticSpectrum, analyzer);
    const detected = detectedPowerConfigurationFor(syntheticDetectedPower, zero);
    expect(spectrum).toMatchObject({ sweepTimeSeconds: 0.05, controls: { model: 'synthetic-scalar' } });
    expect(detected).toMatchObject({ sweepTimeSeconds: 0.05, controls: { model: 'synthetic-scalar' } });
    for (const value of [spectrum, detected]) {
      expect(value.controls).not.toHaveProperty('resolutionBandwidthKhz');
      expect(value.controls).not.toHaveProperty('attenuationDb');
      expect(value.controls).not.toHaveProperty('trigger');
    }
  });

  it('fails closed instead of rewriting staged timing to a synthetic capability', () => {
    expect(() => sweptSpectrumConfigurationFor(syntheticSpectrum, { ...analyzer, sweepTimeSeconds: 'auto' }))
      .toThrow(/exactly 0.05s, not auto/);
    expect(() => detectedPowerConfigurationFor(syntheticDetectedPower, { ...zero, sweepTimeSeconds: 0.1 }))
      .toThrow(/exactly 0.05s, not 0.1s/);
  });

  it('reconciles persisted staging visibly to a narrower receiver capability before first configure', () => {
    const narrowSpectrum: typeof receiverSpectrum = {
      ...receiverSpectrum,
      frequencyHz: { min: 80_000_000, max: 120_000_000, step: 10 },
      points: { min: 20, max: 20 },
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.1, max: 0.1 } },
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormats: ['text'],
        resolutionBandwidthKhz: { automatic: false, manual: { min: 10, max: 10 } },
        attenuationDb: { automatic: false, manual: { min: 3, max: 3 } },
        detectors: ['quasi-peak'], spurRejection: ['off'], lowNoiseAmplifier: ['on'],
        avoidSpurs: ['on'], triggerModes: ['normal'], triggerLevelDbm: { min: -80, max: -70 },
      },
    };
    const narrowDetected: typeof receiverDetectedPower = {
      ...receiverDetectedPower,
      centerFrequencyHz: { min: 90_000_000, max: 110_000_000, step: 10 },
      sampleCount: { min: 20, max: 20 },
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.1, max: 0.1 } },
      controls: {
        schemaVersion: 1, model: 'receiver',
        resolutionBandwidthKhz: { automatic: false, manual: { min: 10, max: 10 } },
        attenuationDb: { automatic: false, manual: { min: 3, max: 3 } },
        triggerModes: ['single'], triggerLevelDbm: { min: -75, max: -65 },
      },
    };

    const reconciledSpectrum = reconcileAnalyzerConfiguration(narrowSpectrum, {
      ...analyzer, startHz: 80_000_001, stopHz: 119_999_999, sweepTimeSeconds: 'auto', trigger: { mode: 'auto' },
    });
    expect(reconciledSpectrum).toEqual({
      ...analyzer,
      startHz: 80_000_000,
      stopHz: 120_000_000,
      points: 20,
      acquisitionFormat: 'text',
      rbwKhz: 10,
      attenuationDb: 3,
      sweepTimeSeconds: 0.1,
      detector: 'quasi-peak',
      spurRejection: 'off',
      lna: 'on',
      avoidSpurs: 'on',
      trigger: { mode: 'normal', levelDbm: -80 },
    });
    expect(() => sweptSpectrumConfigurationFor(narrowSpectrum, reconciledSpectrum)).not.toThrow();

    const reconciledDetected = reconcileDetectedPowerConfiguration(narrowDetected, {
      ...zero, frequencyHz: 98_000_001, points: 450, sweepTimeSeconds: 0.05, trigger: { mode: 'auto' },
    });
    expect(reconciledDetected).toEqual({
      ...zero,
      frequencyHz: 90_000_000,
      points: 20,
      rbwKhz: 10,
      attenuationDb: 3,
      sweepTimeSeconds: 0.1,
      trigger: { mode: 'single', levelDbm: -75 },
    });
    expect(() => detectedPowerConfigurationFor(narrowDetected, reconciledDetected)).not.toThrow();
  });

  it('rejects receiver values outside advertised steps and trigger ranges', () => {
    const stepped: typeof receiverSpectrum = {
      ...receiverSpectrum,
      sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } },
      controls: {
        ...receiverSpectrum.controls,
        resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
        triggerLevelDbm: { min: -174, max: 30 },
      },
    };
    expect(() => sweptSpectrumConfigurationFor(stepped, { ...analyzer, rbwKhz: 0.25 }))
      .toThrow(/resolution bandwidth/);
    expect(() => sweptSpectrumConfigurationFor(stepped, { ...analyzer, sweepTimeSeconds: 0.003_000_1 }))
      .toThrow(/sweep time/);
    expect(() => sweptSpectrumConfigurationFor(stepped, { ...analyzer, trigger: { mode: 'normal', levelDbm: 31 } }))
      .toThrow(/trigger level/);
  });
});
