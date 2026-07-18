import {
  analyzerConfigSchema,
  detectedPowerTimeseriesConfigurationSchema,
  sweptSpectrumConfigurationSchema,
  zeroSpanConfigSchema,
  zeroSpanConfigPatchSchema,
  ZS407_FIRMWARE_LIMITS,
  type AnalyzerConfig,
  type DetectedPowerTimeseriesConfiguration,
  type InstrumentAcquisitionCapability,
  type SweptSpectrumConfiguration,
  type ZeroSpanConfig,
  type ZeroSpanConfigPatch,
} from '@tinysa/contracts';

type SpectrumCapability = Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }>;
type DetectedPowerCapability = Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }>;

// 450 is the ZS407's hardware sweep-point ceiling (ZS407_FIRMWARE_LIMITS.maximumSweepPoints),
// not a meaningful default for SignalLab's synthetic scalar source, which supports far more
// points. A still-generic 450 carried over from the ZS407-oriented default is upgraded to
// SignalLab's own preferred resolution instead of silently staying at a real-hardware ceiling
// that happens to also be a valid (but needlessly coarse) value in SignalLab's own range.
const SIGNAL_LAB_DEFAULT_SWEEP_POINTS = 1024;

/** Build the exact request supported by the active scalar-spectrum driver. */
export function sweptSpectrumConfigurationFor(
  capability: SpectrumCapability,
  staged: AnalyzerConfig,
): SweptSpectrumConfiguration {
  if (capability.controls.model === 'synthetic-scalar') {
    const exactSeconds = exactSyntheticSweepTime(capability.sweepTimeSeconds, 'swept spectrum');
    if (staged.sweepTimeSeconds !== exactSeconds) {
      throw new RangeError(`Synthetic swept spectrum supports exactly ${exactSeconds}s, not ${staged.sweepTimeSeconds}`);
    }
    const configuration = sweptSpectrumConfigurationSchema.parse({
      kind: 'swept-spectrum',
      startHz: staged.startHz,
      stopHz: staged.stopHz,
      points: staged.points,
      sweepTimeSeconds: exactSeconds,
      controls: capability.controls,
    });
    requireSpectrumCapability(configuration, capability);
    return configuration;
  }
  const configuration = sweptSpectrumConfigurationSchema.parse({
    kind: 'swept-spectrum',
    startHz: staged.startHz,
    stopHz: staged.stopHz,
    points: staged.points,
    sweepTimeSeconds: staged.sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      acquisitionFormat: staged.acquisitionFormat,
      resolutionBandwidthKhz: staged.rbwKhz,
      attenuationDb: staged.attenuationDb,
      detector: staged.detector,
      spurRejection: staged.spurRejection,
      lowNoiseAmplifier: staged.lna,
      avoidSpurs: staged.avoidSpurs,
      trigger: staged.trigger,
    },
  });
  requireSpectrumCapability(configuration, capability);
  return configuration;
}

/** Build detected-power intent without projecting receiver settings onto a synthetic source. */
export function detectedPowerConfigurationFor(
  capability: DetectedPowerCapability,
  staged: ZeroSpanConfig,
): DetectedPowerTimeseriesConfiguration {
  if (capability.controls.model === 'synthetic-scalar') {
    const exactSeconds = exactSyntheticSweepTime(capability.sweepTimeSeconds, 'detected power');
    if (staged.sweepTimeSeconds !== exactSeconds) {
      throw new RangeError(`Synthetic detected power supports exactly ${exactSeconds}s, not ${staged.sweepTimeSeconds}s`);
    }
    const configuration = detectedPowerTimeseriesConfigurationSchema.parse({
      kind: 'detected-power-timeseries',
      centerHz: staged.frequencyHz,
      sampleCount: staged.points,
      sweepTimeSeconds: exactSeconds,
      controls: capability.controls,
    });
    requireDetectedPowerCapability(configuration, capability);
    return configuration;
  }
  const configuration = detectedPowerTimeseriesConfigurationSchema.parse({
    kind: 'detected-power-timeseries',
    centerHz: staged.frequencyHz,
    sampleCount: staged.points,
    sweepTimeSeconds: staged.sweepTimeSeconds,
    controls: {
      schemaVersion: 1,
      model: 'receiver',
      resolutionBandwidthKhz: staged.rbwKhz,
      attenuationDb: staged.attenuationDb,
      trigger: staged.trigger,
    },
  });
  requireDetectedPowerCapability(configuration, capability);
  return configuration;
}

/** Merge one typed detected-power staging patch and validate it against the
 * active source model before it becomes visible application state. */
export function stageDetectedPowerConfigurationPatch(
  capability: DetectedPowerCapability | undefined,
  staged: ZeroSpanConfig,
  input: ZeroSpanConfigPatch,
): { readonly patch: ZeroSpanConfigPatch; readonly configuration: ZeroSpanConfig } {
  const patch = zeroSpanConfigPatchSchema.parse(input);
  const configuration = zeroSpanConfigSchema.parse({ ...staged, ...patch });
  if (capability?.controls.model === 'synthetic-scalar') {
    const receiverOnly = ['rbwKhz', 'attenuationDb', 'trigger']
      .find((key) => key in patch);
    if (receiverOnly) throw new Error(`${receiverOnly} is not applicable to synthetic scalar acquisition`);
  }
  if (capability) detectedPowerConfigurationFor(capability, configuration);
  return { patch, configuration };
}

/**
 * Reconcile persisted TinySA-shaped staging to the active receiver contract.
 * Every changed value remains visible in UI state; this does not silently
 * alter an admitted configuration or a user request in flight.
 */
export function reconcileAnalyzerConfiguration(
  capability: SpectrumCapability,
  staged: AnalyzerConfig,
): AnalyzerConfig {
  let startHz = reconcileRangeValue(staged.startHz, capability.frequencyHz, 'minimum');
  let stopHz = reconcileRangeValue(staged.stopHz, capability.frequencyHz, 'maximum');
  if (stopHz <= startHz) {
    startHz = capability.frequencyHz.min;
    stopHz = maximumAdmittedValue(capability.frequencyHz);
    if (stopHz <= startHz) throw new Error('Swept-spectrum capability cannot represent a positive span');
  }
  if (capability.controls.model === 'synthetic-scalar') {
    const points = staged.points === ZS407_FIRMWARE_LIMITS.maximumSweepPoints && rangeContains(SIGNAL_LAB_DEFAULT_SWEEP_POINTS, capability.points)
      ? SIGNAL_LAB_DEFAULT_SWEEP_POINTS
      : reconcileRangeValue(staged.points, capability.points, 'minimum');
    return analyzerConfigSchema.parse({
      ...staged,
      startHz,
      stopHz,
      points,
      sweepTimeSeconds: exactSyntheticSweepTime(capability.sweepTimeSeconds, 'swept spectrum'),
    });
  }
  const geometry = {
    startHz,
    stopHz,
    points: reconcileRangeValue(staged.points, capability.points, 'minimum'),
  };
  const controls = capability.controls;
  return analyzerConfigSchema.parse({
    ...staged,
    ...geometry,
    sweepTimeSeconds: reconcileAutomaticValue(staged.sweepTimeSeconds, capability.sweepTimeSeconds.automatic, capability.sweepTimeSeconds.manualSeconds),
    acquisitionFormat: selectAdmitted(staged.acquisitionFormat, controls.acquisitionFormats),
    rbwKhz: reconcileAutomaticValue(staged.rbwKhz, controls.resolutionBandwidthKhz.automatic, controls.resolutionBandwidthKhz.manual),
    attenuationDb: reconcileAutomaticValue(staged.attenuationDb, controls.attenuationDb.automatic, controls.attenuationDb.manual),
    detector: selectAdmitted(staged.detector, controls.detectors),
    spurRejection: selectAdmitted(staged.spurRejection, controls.spurRejection),
    lna: selectAdmitted(staged.lna, controls.lowNoiseAmplifier),
    avoidSpurs: selectAdmitted(staged.avoidSpurs, controls.avoidSpurs),
    trigger: reconcileTrigger(staged.trigger, controls.triggerModes, controls.triggerLevelDbm),
  });
}

export function reconcileDetectedPowerConfiguration(
  capability: DetectedPowerCapability,
  staged: ZeroSpanConfig,
): ZeroSpanConfig {
  const geometry = {
    frequencyHz: reconcileRangeValue(staged.frequencyHz, capability.centerFrequencyHz, 'minimum'),
    points: reconcileRangeValue(staged.points, capability.sampleCount, 'minimum'),
  };
  if (capability.controls.model === 'synthetic-scalar') {
    return zeroSpanConfigSchema.parse({
      ...staged,
      ...geometry,
      sweepTimeSeconds: exactSyntheticSweepTime(capability.sweepTimeSeconds, 'detected power'),
    });
  }
  const controls = capability.controls;
  return zeroSpanConfigSchema.parse({
    ...staged,
    ...geometry,
    sweepTimeSeconds: reconcileAutomaticValue(staged.sweepTimeSeconds, false, capability.sweepTimeSeconds.manualSeconds),
    rbwKhz: reconcileAutomaticValue(staged.rbwKhz, controls.resolutionBandwidthKhz.automatic, controls.resolutionBandwidthKhz.manual),
    attenuationDb: reconcileAutomaticValue(staged.attenuationDb, controls.attenuationDb.automatic, controls.attenuationDb.manual),
    trigger: reconcileTrigger(staged.trigger, controls.triggerModes, controls.triggerLevelDbm),
  });
}

export function sameSweptSpectrumConfiguration(
  left: SweptSpectrumConfiguration,
  right: SweptSpectrumConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactSyntheticSweepTime(
  capability: SpectrumCapability['sweepTimeSeconds'] | DetectedPowerCapability['sweepTimeSeconds'],
  label: string,
): number {
  if (capability.automatic || capability.manualSeconds.min !== capability.manualSeconds.max) {
    throw new Error(`Synthetic ${label} capability must advertise one non-automatic exact sweep time`);
  }
  return capability.manualSeconds.min;
}

type NumericRange = { min: number; max: number; step?: number };

function requireSpectrumCapability(configuration: SweptSpectrumConfiguration, capability: SpectrumCapability): void {
  requireRange(configuration.startHz, capability.frequencyHz, 'sweep start');
  requireRange(configuration.stopHz, capability.frequencyHz, 'sweep stop');
  requireRange(configuration.points, capability.points, 'sweep points');
  requireSweepTime(configuration.sweepTimeSeconds, capability.sweepTimeSeconds, 'sweep time');
  if (configuration.controls.model !== capability.controls.model) throw new RangeError('Sweep control model is not advertised');
  if (configuration.controls.model === 'synthetic-scalar') return;
  if (capability.controls.model !== 'receiver') throw new Error('Receiver spectrum capability is inconsistent');
  const controls = configuration.controls;
  if (!capability.controls.acquisitionFormats.includes(controls.acquisitionFormat)) throw new RangeError(`Acquisition format ${controls.acquisitionFormat} is not advertised`);
  requireAutomatic(controls.resolutionBandwidthKhz, capability.controls.resolutionBandwidthKhz, 'resolution bandwidth');
  requireAutomatic(controls.attenuationDb, capability.controls.attenuationDb, 'attenuation');
  requireEnum(controls.detector, capability.controls.detectors, 'detector');
  requireEnum(controls.spurRejection, capability.controls.spurRejection, 'spur rejection');
  requireEnum(controls.lowNoiseAmplifier, capability.controls.lowNoiseAmplifier, 'LNA');
  requireEnum(controls.avoidSpurs, capability.controls.avoidSpurs, 'avoid-spurs');
  requireTrigger(controls.trigger, capability.controls.triggerModes, capability.controls.triggerLevelDbm);
}

function requireDetectedPowerCapability(configuration: DetectedPowerTimeseriesConfiguration, capability: DetectedPowerCapability): void {
  requireRange(configuration.centerHz, capability.centerFrequencyHz, 'detected-power center');
  requireRange(configuration.sampleCount, capability.sampleCount, 'detected-power samples');
  requireSweepTime(configuration.sweepTimeSeconds, capability.sweepTimeSeconds, 'detected-power sweep time');
  if (configuration.controls.model !== capability.controls.model) throw new RangeError('Detected-power control model is not advertised');
  if (configuration.controls.model === 'synthetic-scalar') return;
  if (capability.controls.model !== 'receiver') throw new Error('Receiver detected-power capability is inconsistent');
  requireAutomatic(configuration.controls.resolutionBandwidthKhz, capability.controls.resolutionBandwidthKhz, 'resolution bandwidth');
  requireAutomatic(configuration.controls.attenuationDb, capability.controls.attenuationDb, 'attenuation');
  requireTrigger(configuration.controls.trigger, capability.controls.triggerModes, capability.controls.triggerLevelDbm);
}

function requireSweepTime(
  value: 'auto' | number,
  capability: { automatic: boolean; manualSeconds: NumericRange },
  label: string,
): void {
  if (value === 'auto') {
    if (!capability.automatic) throw new RangeError(`${label} does not advertise automatic selection`);
  } else requireRange(value, capability.manualSeconds, label);
}

function requireAutomatic(
  value: 'auto' | number,
  capability: { automatic: boolean; manual: NumericRange },
  label: string,
): void {
  if (value === 'auto') {
    if (!capability.automatic) throw new RangeError(`${label} does not advertise automatic selection`);
  } else requireRange(value, capability.manual, label);
}

function requireTrigger(
  trigger: AnalyzerConfig['trigger'],
  modes: readonly AnalyzerConfig['trigger']['mode'][],
  levelRange: NumericRange | undefined,
): void {
  requireEnum(trigger.mode, modes, 'trigger mode');
  if (trigger.mode !== 'auto') {
    if (!levelRange) throw new Error(`Trigger mode ${trigger.mode} has no advertised level range`);
    requireRange(trigger.levelDbm, levelRange, 'trigger level');
  }
}

function requireEnum<Value extends string>(value: Value, values: readonly Value[], label: string): void {
  if (!values.includes(value)) throw new RangeError(`${label} ${value} is not advertised`);
}

function requireRange(value: number, range: NumericRange, label: string): void {
  if (!rangeContains(value, range)) throw new RangeError(`${label} ${value} is outside the advertised capability`);
}

function rangeContains(value: number, range: NumericRange): boolean {
  if (value < range.min || value > range.max) return false;
  if (range.step === undefined) return true;
  const offset = (value - range.min) / range.step;
  return Math.abs(offset - Math.round(offset)) <= Number.EPSILON * Math.max(8, Math.abs(offset) * 8);
}

function reconcileAutomaticValue(
  value: 'auto' | number,
  automatic: boolean,
  manual: NumericRange,
): 'auto' | number {
  if (value === 'auto' && automatic) return value;
  if (typeof value === 'number' && rangeContains(value, manual)) return value;
  return automatic ? 'auto' : manual.min;
}

function reconcileRangeValue(value: number, range: NumericRange, fallback: 'minimum' | 'maximum'): number {
  if (rangeContains(value, range)) return value;
  return fallback === 'minimum' ? range.min : maximumAdmittedValue(range);
}

function maximumAdmittedValue(range: NumericRange): number {
  if (range.step === undefined) return range.max;
  return range.min + Math.floor((range.max - range.min) / range.step) * range.step;
}

function selectAdmitted<Value extends string>(value: Value, admitted: readonly Value[]): Value {
  return admitted.includes(value) ? value : admitted[0]!;
}

function reconcileTrigger(
  trigger: AnalyzerConfig['trigger'],
  modes: readonly AnalyzerConfig['trigger']['mode'][],
  levelRange: NumericRange | undefined,
): AnalyzerConfig['trigger'] {
  if (modes.includes(trigger.mode)
    && (trigger.mode === 'auto' || (levelRange !== undefined && rangeContains(trigger.levelDbm, levelRange)))) return trigger;
  if (modes.includes('auto')) return { mode: 'auto' };
  const mode = modes[0];
  if (!mode || mode === 'auto' || !levelRange) throw new Error('Receiver capability has no usable trigger mode');
  return { mode, levelDbm: levelRange.min };
}
