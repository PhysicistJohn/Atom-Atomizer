import {
  detectedPowerTimeseriesConfigurationSchema,
  sweptSpectrumConfigurationSchema,
  type AnalyzerConfig,
  type DetectedPowerTimeseriesConfiguration,
  type SweptSpectrumConfiguration,
  type ZeroSpanConfig,
} from '@tinysa/contracts';

/**
 * The generic contract names only controls shared by scalar receivers. This
 * adapter is the sole TinySA-specific translation and deliberately has no
 * defaults: a missing or synthetic control model is rejected.
 */
export function tinySaAnalyzerConfiguration(configurationValue: SweptSpectrumConfiguration): AnalyzerConfig {
  const configuration = sweptSpectrumConfigurationSchema.parse(configurationValue);
  if (configuration.controls.model !== 'receiver') {
    throw new Error('TinySA swept-spectrum acquisition requires receiver controls');
  }
  return {
    startHz: configuration.startHz,
    stopHz: configuration.stopHz,
    points: configuration.points,
    acquisitionFormat: configuration.controls.acquisitionFormat,
    rbwKhz: configuration.controls.resolutionBandwidthKhz,
    attenuationDb: configuration.controls.attenuationDb,
    sweepTimeSeconds: configuration.sweepTimeSeconds,
    detector: configuration.controls.detector,
    spurRejection: configuration.controls.spurRejection,
    lna: configuration.controls.lowNoiseAmplifier,
    avoidSpurs: configuration.controls.avoidSpurs,
    trigger: configuration.controls.trigger,
  };
}

export function tinySaDetectedPowerConfiguration(configurationValue: DetectedPowerTimeseriesConfiguration): ZeroSpanConfig {
  const configuration = detectedPowerTimeseriesConfigurationSchema.parse(configurationValue);
  if (configuration.controls.model !== 'receiver') {
    throw new Error('TinySA detected-power acquisition requires receiver controls');
  }
  return {
    frequencyHz: configuration.centerHz,
    points: configuration.sampleCount,
    rbwKhz: configuration.controls.resolutionBandwidthKhz,
    attenuationDb: configuration.controls.attenuationDb,
    sweepTimeSeconds: configuration.sweepTimeSeconds,
    trigger: configuration.controls.trigger,
  };
}

export function admittedTinySaSpectrumConfiguration(configuration: AnalyzerConfig): SweptSpectrumConfiguration {
  return sweptSpectrumConfigurationSchema.parse({
    kind: 'swept-spectrum',
    startHz: configuration.startHz,
    stopHz: configuration.stopHz,
    points: configuration.points,
    sweepTimeSeconds: configuration.sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      acquisitionFormat: configuration.acquisitionFormat,
      resolutionBandwidthKhz: configuration.rbwKhz,
      attenuationDb: configuration.attenuationDb,
      detector: configuration.detector,
      spurRejection: configuration.spurRejection,
      lowNoiseAmplifier: configuration.lna,
      avoidSpurs: configuration.avoidSpurs,
      trigger: configuration.trigger,
    },
  });
}

export function admittedTinySaDetectedPowerConfiguration(configuration: ZeroSpanConfig): DetectedPowerTimeseriesConfiguration {
  return detectedPowerTimeseriesConfigurationSchema.parse({
    kind: 'detected-power-timeseries',
    centerHz: configuration.frequencyHz,
    sampleCount: configuration.points,
    sweepTimeSeconds: configuration.sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      resolutionBandwidthKhz: configuration.rbwKhz,
      attenuationDb: configuration.attenuationDb,
      trigger: configuration.trigger,
    },
  });
}
