import type {
  InstrumentAcquisitionCapability,
  TriggerConfig,
  ZeroSpanConfig,
  ZeroSpanConfigPatch,
} from '@tinysa/contracts';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

type DetectedPowerCapability = Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }>;
type AutomaticNumericValue = 'auto' | number;
type AutomaticNumericCapability = {
  readonly automatic: boolean;
  readonly manual: { readonly min: number; readonly max: number; readonly step?: number };
};

export function AutomaticNumericParameter({
  label,
  value,
  capability,
  unit,
  disabled,
  controlId,
  displayValue = (current) => `${current} ${unit}`,
  onValue,
}: {
  label: string;
  value: AutomaticNumericValue;
  capability: AutomaticNumericCapability;
  unit: string;
  disabled: boolean;
  controlId: string;
  displayValue?(value: number): string;
  onValue(value: AutomaticNumericValue): void;
}) {
  const selection = value === 'auto' ? 'auto' : 'manual';
  const options = capability.automatic
    ? [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }]
    : [{ value: 'manual', label: 'Manual · required' }];
  return <>
    <SelectParameter
      label={`${label} mode`}
      value={selection}
      options={options}
      disabled={disabled}
      controlId={`${controlId}-mode`}
      onValue={(next) => onValue(next === 'auto' ? 'auto' : value === 'auto' ? capability.manual.min : value)}
    />
    {value !== 'auto' && <EditableParameter
      label={label}
      value={value}
      displayValue={displayValue(value)}
      unit={unit}
      minimum={capability.manual.min}
      maximum={capability.manual.max}
      step={capability.manual.step ?? 'any'}
      disabled={disabled}
      controlId={controlId}
      onCommit={(next) => onValue(Number(next))}
    />}
  </>;
}

export function TriggerParameters({
  trigger,
  modes,
  level,
  disabled,
  controlPrefix,
  onTrigger,
}: {
  trigger: TriggerConfig;
  modes: readonly TriggerConfig['mode'][];
  level?: { readonly min: number; readonly max: number; readonly step?: number };
  disabled: boolean;
  controlPrefix: string;
  onTrigger(trigger: TriggerConfig): void;
}) {
  return <>
    <SelectParameter
      label="Trigger"
      value={trigger.mode}
      options={modes.map((mode) => ({ value: mode, label: sentenceCase(mode) }))}
      disabled={disabled}
      controlId={`${controlPrefix}.trigger`}
      onValue={(mode) => {
        if (mode === 'auto') onTrigger({ mode: 'auto' });
        else {
          if (!level) throw new Error(`Trigger mode ${mode} has no advertised threshold range`);
          onTrigger({ mode: mode as 'normal' | 'single', levelDbm: trigger.mode === 'auto' ? level.min : trigger.levelDbm });
        }
      }}
    />
    {trigger.mode !== 'auto' && level && <EditableParameter
      label="Trigger level"
      value={trigger.levelDbm}
      displayValue={`${trigger.levelDbm} dBm`}
      unit="dBm"
      minimum={level.min}
      maximum={level.max}
      step={level.step ?? 'any'}
      disabled={disabled}
      controlId={`${controlPrefix}.trigger-level`}
      onCommit={(value) => onTrigger({ mode: trigger.mode, levelDbm: Number(value) })}
    />}
  </>;
}

export function DetectedPowerReceiverControls({
  config,
  capability,
  disabled,
  controlPrefix,
  onChange,
}: {
  config: ZeroSpanConfig;
  capability?: DetectedPowerCapability;
  disabled: boolean;
  controlPrefix: string;
  onChange(patch: ZeroSpanConfigPatch): void;
}) {
  if (!capability) {
    return <div className="receiver-control-applicability" role="status">Receiver controls unavailable · no detected-power capability</div>;
  }
  if (capability.controls.model === 'synthetic-scalar') {
    return <div className="receiver-control-applicability synthetic" role="status">
      Receiver controls not applicable · synthetic scalar source · exact {formatSeconds(capability.sweepTimeSeconds.manualSeconds.min)} timing
    </div>;
  }
  return <div className="receiver-control-rows" role="group" aria-label="Detected-power receiver controls">
    <AutomaticNumericParameter
      label="RBW"
      value={config.rbwKhz}
      capability={capability.controls.resolutionBandwidthKhz}
      unit="kHz"
      disabled={disabled}
      controlId={`${controlPrefix}.rbw`}
      onValue={(rbwKhz) => onChange({ rbwKhz })}
    />
    <AutomaticNumericParameter
      label="Attenuation"
      value={config.attenuationDb}
      capability={capability.controls.attenuationDb}
      unit="dB"
      disabled={disabled}
      controlId={`${controlPrefix}.attenuation`}
      onValue={(attenuationDb) => onChange({ attenuationDb })}
    />
    <TriggerParameters
      trigger={config.trigger}
      modes={capability.controls.triggerModes}
      level={capability.controls.triggerLevelDbm}
      disabled={disabled}
      controlPrefix={controlPrefix}
      onTrigger={(trigger) => onChange({ trigger })}
    />
  </div>;
}

export function sentenceCase(value: string): string {
  return value.replaceAll('-', ' ').replace(/^./, (character) => character.toUpperCase());
}

function formatSeconds(seconds: number): string {
  return seconds < 1 ? `${Number((seconds * 1_000).toPrecision(12))} ms` : `${seconds} s`;
}
