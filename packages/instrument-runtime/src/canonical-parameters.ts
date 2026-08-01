import type {
  CanonicalInstrumentSurface,
  CanonicalOperation,
  CanonicalParameter,
  CanonicalParameterIntent,
  CanonicalParameterVerification,
} from '@tinysa/contracts';

/** Reusable building blocks for a driver's canonical Auto/manual surface. */
export type CanonicalNumericRange = Readonly<{ min: number; max: number; step?: number }>;
export type CanonicalEffective<Value extends number | string | boolean> = Readonly<{
  value: Value;
  verification: CanonicalParameterVerification;
}>;
export const CANONICAL_DRIVER_AUTO_DESCRIPTION = 'The connected driver selects a valid setting when Auto is requested.';

export function canonicalRange(range: CanonicalNumericRange): { min: number; max: number; step?: number } {
  return { min: range.min, max: range.max, ...(range.step === undefined ? {} : { step: range.step }) };
}

function canonicalParameter(
  id: string, label: string, group: string, manual: CanonicalParameter['manual'],
  effective: CanonicalEffective<number | string | boolean>, requested: CanonicalParameterIntent,
  unit?: string, autoDescription = CANONICAL_DRIVER_AUTO_DESCRIPTION,
): CanonicalParameter {
  return {
    id, label, group, ...(unit === undefined ? {} : { unit }), manual,
    auto: { resolver: 'driver', description: autoDescription }, requested,
    effectiveValue: effective.value, verification: effective.verification,
  };
}

export function canonicalNumericParameter(
  kind: 'integer' | 'number', id: string, label: string, group: string, unit: string,
  range: CanonicalNumericRange, effective: CanonicalEffective<number>,
  requested: CanonicalParameterIntent = { mode: 'auto' }, autoDescription = CANONICAL_DRIVER_AUTO_DESCRIPTION,
): CanonicalParameter {
  return canonicalParameter(id, label, group, { kind, range: canonicalRange(range) }, effective, requested, unit, autoDescription);
}

export function canonicalIntegerParameter(
  id: string, label: string, group: string, unit: string | undefined, range: CanonicalNumericRange,
  requested: CanonicalParameterIntent, effectiveValue: number, verification: CanonicalParameterVerification,
  autoDescription = CANONICAL_DRIVER_AUTO_DESCRIPTION,
): CanonicalParameter {
  return canonicalParameter(id, label, group, { kind: 'integer', range: canonicalRange(range) }, { value: effectiveValue, verification }, requested, unit, autoDescription);
}

export function canonicalEnumParameter<Value extends string>(
  id: string, label: string, group: string, options: readonly Value[], effective: CanonicalEffective<Value>,
  requested: CanonicalParameterIntent = { mode: 'auto' }, autoDescription = CANONICAL_DRIVER_AUTO_DESCRIPTION,
): CanonicalParameter {
  return canonicalParameter(id, label, group, {
    kind: 'enum', options: options.map((value) => ({ value, label: humanizeCanonicalOption(value) })),
  }, effective, requested, undefined, autoDescription);
}

export function canonicalBooleanParameter(
  id: string, label: string, group: string, effective: CanonicalEffective<boolean>,
  requested: CanonicalParameterIntent = { mode: 'auto' }, autoDescription = CANONICAL_DRIVER_AUTO_DESCRIPTION,
): CanonicalParameter {
  return canonicalParameter(id, label, group, { kind: 'boolean' }, effective, requested, undefined, autoDescription);
}

export function canonicalOperationDefinition(input: Readonly<{
  id: string; label: string; description: string; scope: 'acquisition' | 'source' | 'instrument';
  parameters: readonly CanonicalParameter[]; outputs: readonly string[]; unavailable: boolean;
  acquisitionKind?: NonNullable<CanonicalOperation['acquisitionKind']>;
  primary?: boolean; confirmation?: 'none' | 'high-impact';
}>): CanonicalInstrumentSurface['operations'][number] {
  return {
    id: input.id, label: input.label, description: input.description, scope: input.scope,
    ...(input.acquisitionKind === undefined ? {} : { acquisitionKind: input.acquisitionKind }),
    parameterIds: input.parameters.map((parameter) => parameter.id), outputs: [...input.outputs],
    availability: input.unavailable ? 'unavailable' : 'available', primary: input.primary ?? false,
    confirmation: input.confirmation ?? 'none',
  };
}

export function effectiveNumber(value: unknown, range: CanonicalNumericRange, fallback: number): CanonicalEffective<number> {
  return typeof value === 'number' && rangeAdmits(value, range)
    ? { value, verification: 'driver-commanded' }
    : { value: fallback, verification: 'driver-selected' };
}

export function effectiveEnum<Value extends string>(
  value: unknown, options: readonly Value[], fallback: Value,
): CanonicalEffective<Value> {
  return typeof value === 'string' && options.includes(value as Value)
    ? { value: value as Value, verification: 'driver-commanded' }
    : { value: fallback, verification: 'driver-selected' };
}

export function requiredCanonicalIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string, context = 'Canonical operation',
): CanonicalParameterIntent {
  const intent = intents.get(parameterId);
  if (!intent) throw new RangeError(`${context} is missing ${parameterId}`);
  return intent;
}

export function resolveCanonicalNumberIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string, automaticValue: number, integer = false,
  context = 'Canonical operation',
): number {
  const intent = requiredCanonicalIntent(intents, parameterId, context);
  if (intent.mode === 'auto') return automaticValue;
  if (typeof intent.value !== 'number' || !Number.isFinite(intent.value)) {
    throw new TypeError(`${context} parameter ${parameterId} requires a numeric manual value`);
  }
  if (integer && !Number.isInteger(intent.value)) {
    throw new TypeError(`${context} parameter ${parameterId} requires an integer manual value`);
  }
  return intent.value;
}

export function resolveCanonicalRangedNumberIntent(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string, automaticValue: number,
  range: CanonicalNumericRange, outOfRangeMessage: string, integer = false, context = 'Canonical operation',
): number {
  const value = resolveCanonicalNumberIntent(intents, parameterId, automaticValue, integer, context);
  if (!rangeAdmits(value, range)) throw new RangeError(outOfRangeMessage);
  return value;
}

export function resolveCanonicalEnumIntent<Value extends string>(
  intents: ReadonlyMap<string, CanonicalParameterIntent>, parameterId: string,
  options: readonly Value[], automaticValue: Value, context = 'Canonical operation',
): Value {
  const intent = requiredCanonicalIntent(intents, parameterId, context);
  if (intent.mode === 'auto') return automaticValue;
  if (typeof intent.value !== 'string' || !options.includes(intent.value as Value)) {
    throw new RangeError(`${context} parameter ${parameterId} is not an advertised option`);
  }
  return intent.value as Value;
}

export function maximumReachableRangeValue(range: CanonicalNumericRange): number {
  if (range.step === undefined) return range.max;
  const offset = (range.max - range.min) / range.step;
  const steps = Math.abs(offset - Math.round(offset)) <= Number.EPSILON * Math.max(8, Math.abs(offset) * 8)
    ? Math.round(offset) : Math.floor(offset);
  return Math.min(range.max, range.min + steps * range.step);
}

export function rangeAdmits(value: number, range: CanonicalNumericRange): boolean {
  if (!Number.isFinite(value) || value < range.min || value > range.max) return false;
  if (range.step === undefined) return true;
  const offset = (value - range.min) / range.step;
  return Math.abs(offset - Math.round(offset)) <= Number.EPSILON * Math.max(8, Math.abs(offset) * 8);
}

export function canonicalRangeValue(
  range: CanonicalNumericRange, preferred: number, safeIntegerMessage = 'Canonical range selection is not a safe integer',
): number {
  const step = range.step ?? 1;
  const maximum = range.min + Math.floor((range.max - range.min) / step) * step;
  const value = range.min + Math.round((Math.min(maximum, Math.max(range.min, preferred)) - range.min) / step) * step;
  if (!Number.isSafeInteger(value)) throw new RangeError(safeIntegerMessage);
  return value;
}

export function resolveCanonicalInteger(
  intent: CanonicalParameterIntent | undefined, automaticValue: number, range: CanonicalNumericRange, label: string,
): number {
  if (!intent) throw new RangeError(`${label} intent is missing`);
  const value = intent.mode === 'auto' ? automaticValue : intent.value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer`);
  requireCanonicalRange(value, range, label);
  return value;
}

export function requireCanonicalRange(value: number, range: CanonicalNumericRange, label: string): void {
  if (value < range.min || value > range.max) {
    throw new RangeError(`${label} ${value} is outside the advertised capability [${range.min}, ${range.max}]`);
  }
  if (range.step !== undefined) {
    const steps = (value - range.min) / range.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9 * Math.max(1, Math.abs(steps))) {
      throw new RangeError(`${label} ${value} does not lie on the advertised step grid`);
    }
  }
}

export function humanizeCanonicalOption(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
