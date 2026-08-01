import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Cpu, SlidersHorizontal, Sparkles } from 'lucide-react';
import type {
  CanonicalInstrumentSurface,
  CanonicalOperation,
  CanonicalOperationParameterIntent,
  CanonicalParameter,
  CanonicalParameterIntent,
  CanonicalParameterScalarValue,
} from '@tinysa/contracts';
import { EditableParameter, SelectParameter, ToggleParameter } from './ParameterRow.js';

export interface CanonicalOperationPanelProps {
  /** The complete, driver-emitted surface for the active session. */
  readonly surface: CanonicalInstrumentSurface;
  /** Defaults to the declared primary operation, then the first operation. */
  readonly operationId?: string;
  /** Optional host placement; operation semantics remain driver-owned. */
  readonly placement?: CanonicalOperationPlacement;
  readonly busy: boolean;
  readonly className?: string;
  /**
   * The host owns session identity and revision admission.  The panel owns
   * only the generic operation ID plus one intent for every operation
   * parameter.
   */
  onExecute(operationId: string, parameters: readonly CanonicalOperationParameterIntent[]): void | Promise<unknown>;
}

/** A presentation location, never a driver family or native control type. */
export type CanonicalOperationPlacement = 'acquisition' | 'source';

/**
 * A source-agnostic mutable-control surface.  The driver supplies both the
 * manual domain and the Auto policy for every parameter; Atomizer never
 * derives a native value, native setting name, or source family branch here.
 */
export function CanonicalOperationPanel({
  surface,
  operationId,
  placement,
  busy,
  className,
  onExecute,
}: CanonicalOperationPanelProps) {
  const operations = operationsForPlacement(surface.operations, placement);
  const [selectedOperationId, setSelectedOperationId] = useState<string | undefined>(
    () => operationId ?? defaultOperation(operations)?.id,
  );
  const operation = operationId === undefined
    ? operations.find((candidate) => candidate.id === selectedOperationId) ?? defaultOperation(operations)
    : operations.find((candidate) => candidate.id === operationId);
  const resetKey = `${surface.revision}:${operation?.id ?? operationId ?? ''}`;
  const parameters = operationParameters(surface, operation);
  const [intents, setIntents] = useState<Readonly<Record<string, CanonicalParameterIntent>>>(() => initialIntents(parameters));
  const [executing, setExecuting] = useState(false);
  const [executionError, setExecutionError] = useState<string>();
  const [confirmationPending, setConfirmationPending] = useState(false);

  // A new surface revision is a new driver truth.  Preserve deliberate edits
  // within a revision, but never carry them across a retune/configuration.
  useEffect(() => {
    setIntents(initialIntents(parameters));
    setExecuting(false);
    setExecutionError(undefined);
    setConfirmationPending(false);
  }, [resetKey]);

  // An operation ID passed by a host intentionally pins the panel. Otherwise
  // surface operations are peer choices: no source family determines which
  // one is rendered, and a refreshed surface chooses its driver-declared
  // primary operation again.
  useEffect(() => {
    if (operationId !== undefined) return;
    setSelectedOperationId(defaultOperation(operations)?.id);
  }, [surface.revision, operationId, placement]);

  if (!operation) {
    return <section className={`canonical-operation-panel ${className ?? ''}`.trim()} role="status">
      <div className="canonical-operation-empty">This operation is not available on the current instrument surface.</div>
    </section>;
  }

  // Retain the narrowed driver declaration for callbacks below.
  const activeOperation = operation;
  const parameterIntents = parameters.map((parameter) => ({
    parameterId: parameter.id,
    intent: intents[parameter.id] ?? parameter.requested,
  }));
  const invalidParameter = firstInvalidParameter(parameters, intents);
  const unavailable = operation.availability !== 'available';
  const disabled = busy || executing || unavailable || invalidParameter !== undefined;

  function updateIntent(parameterId: string, intent: CanonicalParameterIntent): void {
    setIntents((current) => ({ ...current, [parameterId]: intent }));
  }

  function updateMode(parameter: CanonicalParameter, mode: 'auto' | 'manual'): void {
    if (mode === 'auto') {
      updateIntent(parameter.id, { mode: 'auto' });
      return;
    }
    const current = intents[parameter.id] ?? parameter.requested;
    updateIntent(parameter.id, {
      mode: 'manual',
      value: current.mode === 'manual' ? current.value : parameter.effectiveValue,
    });
  }

  function execute(): void {
    if (disabled) return;
    if (activeOperation.confirmation === 'high-impact' && !confirmationPending) {
      setConfirmationPending(true);
      return;
    }
    setConfirmationPending(false);
    setExecuting(true);
    setExecutionError(undefined);
    try {
      const result = onExecute(activeOperation.id, parameterIntents);
      if (!isPromiseLike(result)) {
        setExecuting(false);
        return;
      }
      void Promise.resolve(result)
        .catch((error: unknown) => setExecutionError(errorMessage(error)))
        .finally(() => setExecuting(false));
    } catch (error) {
      setExecutionError(errorMessage(error));
      setExecuting(false);
    }
  }

  return <section className={`canonical-operation-panel ${className ?? ''}`.trim()} aria-label={`${operation.label} controls`}>
    <div className="panel-header">
      <div><SlidersHorizontal size={14}/><span>{operation.label}</span></div>
      <span>{unavailable ? operation.availability.replaceAll('-', ' ') : 'DRIVER DECLARED'}</span>
    </div>
    {operationId === undefined && operations.length > 1 && <div className="canonical-operation-picker">
      <SelectParameter
        label="Operation"
        value={operation.id}
        options={operations.map((candidate) => ({
          value: candidate.id,
          label: candidate.availability === 'available'
            ? candidate.label
            : `${candidate.label} · ${candidate.availability.replaceAll('-', ' ')}`,
        }))}
        disabled={busy || executing}
        onValue={setSelectedOperationId}
      />
    </div>}
    {operation.description && <p className="canonical-operation-description">{operation.description}</p>}
    <div className="canonical-parameter-stack parameter-stack">
      {parameters.map((parameter) => {
        const intent = intents[parameter.id] ?? parameter.requested;
        return <CanonicalParameterControl
          key={parameter.id}
          parameter={parameter}
          intent={intent}
          disabled={busy || executing || unavailable}
          onMode={(mode) => updateMode(parameter, mode)}
          onManualValue={(value) => updateIntent(parameter.id, { mode: 'manual', value })}
        />;
      })}
    </div>
    {invalidParameter && <div className="inline-error" role="alert">
      {invalidParameter.parameter.label}: {invalidParameter.issue}
    </div>}
    {executionError && <div className="inline-error" role="alert">{executionError}</div>}
    <div className="canonical-operation-note" role="status"><Sparkles size={14}/><p>Automatic values are resolved by the connected driver. Each effective value below includes its verification basis.</p></div>
    {confirmationPending && <div className="canonical-operation-confirmation" role="alert">
      <p>This driver-declared operation can affect the connected hardware. Confirm the connected path before applying it.</p>
      <div>
        <button type="button" className="secondary" data-agent-exclusion="human-canonical-operation-boundary" onClick={() => setConfirmationPending(false)}>Cancel</button>
        <button type="button" data-agent-exclusion="human-canonical-operation-boundary" data-agent-risk="high-impact" onClick={execute}>Confirm and apply {operation.label}</button>
      </div>
    </div>}
    <div className="panel-action">
      <button
        type="button"
        className="secondary full"
        data-agent-exclusion="human-canonical-operation-boundary"
        disabled={disabled}
        onClick={execute}
      >
        <CheckCircle2 size={14}/>{executing ? 'Applying…' : confirmationPending ? `Review ${operation.label}` : `Apply ${operation.label}`}
      </button>
    </div>
  </section>;
}

/**
 * No renderer-owned fallback is permitted for an active instrument. A
 * canonical operation is the atomic source of its manual domain, Auto policy,
 * effective value, and verification evidence.
 */
export function CanonicalOperationRequired({ title = 'Instrument controls' }: { title?: string }) {
  return <section className="iq-control-panel">
    <div className="panel-header"><div><Cpu size={14}/>{title}</div><span>DRIVER REQUIRED</span></div>
    <div className="channel-contract-note" role="status" aria-label={`${title} unavailable`}>
      <Activity size={14}/><p>The connected driver has not declared a canonical operation for this function. Atomizer has no mutable controls to render until the driver supplies parameter domains, an Auto policy, and verification evidence.</p>
    </div>
  </section>;
}

function CanonicalParameterControl({
  parameter,
  intent,
  disabled,
  onMode,
  onManualValue,
}: {
  parameter: CanonicalParameter;
  intent: CanonicalParameterIntent;
  disabled: boolean;
  onMode(mode: 'auto' | 'manual'): void;
  onManualValue(value: CanonicalParameterScalarValue): void;
}) {
  const issue = intent.mode === 'manual' ? manualValueIssue(parameter, intent.value) : undefined;
  return <div className="canonical-parameter" data-canonical-parameter={parameter.id}>
    <SelectParameter
      label={`${parameter.label} mode`}
      value={intent.mode}
      options={MODE_OPTIONS}
      disabled={disabled}
      onValue={(value) => onMode(value === 'manual' ? 'manual' : 'auto')}
    />
    {intent.mode === 'manual' && <ManualParameterControl parameter={parameter} value={intent.value} disabled={disabled} onValue={onManualValue}/>}
    <div className="canonical-parameter-evidence">
      <span><small>{parameter.group} · effective</small><strong>{formatParameterValue(parameter, parameter.effectiveValue)}</strong></span>
      <span><small>Verification</small><strong>{sentenceCase(parameter.verification)}</strong></span>
      <p>{parameter.auto.description}</p>
    </div>
    {issue && <span className="canonical-parameter-error" role="alert">{issue}</span>}
  </div>;
}

function ManualParameterControl({
  parameter,
  value,
  disabled,
  onValue,
}: {
  parameter: CanonicalParameter;
  value: CanonicalParameterScalarValue;
  disabled: boolean;
  onValue(value: CanonicalParameterScalarValue): void;
}) {
  const label = `${parameter.label} value`;
  switch (parameter.manual.kind) {
    case 'number':
    case 'integer': {
      const numeric = numericValue(value, parameter.effectiveValue);
      return <EditableParameter
        label={label}
        value={numeric}
        displayValue={formatParameterValue(parameter, numeric)}
        unit={parameter.unit}
        minimum={parameter.manual.range.min}
        maximum={parameter.manual.range.max}
        step={parameter.manual.range.step ?? 'any'}
        stepBase={parameter.manual.range.min}
        disabled={disabled}
        onCommit={(next) => {
          const parsed = Number(next);
          if (!Number.isFinite(parsed) || (parameter.manual.kind === 'integer' && !Number.isInteger(parsed))) return;
          onValue(parsed);
        }}
      />;
    }
    case 'enum': {
      const selected = typeof value === 'string' ? value : parameter.manual.options[0]!.value;
      return <SelectParameter
        label={label}
        value={selected}
        options={parameter.manual.options.map((option) => ({ value: option.value, label: option.label }))}
        disabled={disabled}
        onValue={onValue}
      />;
    }
    case 'boolean': {
      const selected = typeof value === 'boolean' ? value : Boolean(parameter.effectiveValue);
      return <ToggleParameter
        label={label}
        value={selected}
        disabled={disabled}
        onToggle={onValue}
      />;
    }
    case 'text': {
      const selected = typeof value === 'string' ? value : String(parameter.effectiveValue);
      const issue = manualValueIssue(parameter, selected);
      return <label className={`canonical-text-parameter ${disabled ? 'disabled' : ''}`}>
        <span>{label}</span>
        <input
          aria-label={label}
          type="text"
          value={selected}
          minLength={parameter.manual.minimumLength}
          maxLength={parameter.manual.maximumLength}
          pattern={parameter.manual.pattern}
          disabled={disabled}
          aria-invalid={issue ? 'true' : undefined}
          onChange={(event) => onValue(event.target.value)}
        />
      </label>;
    }
  }
}

const MODE_OPTIONS = [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }] as const;

function operationsForPlacement(
  operations: readonly CanonicalOperation[],
  placement: CanonicalOperationPlacement | undefined,
): readonly CanonicalOperation[] {
  if (placement === 'source') return operations.filter(({ scope }) => scope === 'source' || scope === 'instrument');
  return placement === 'acquisition' ? operations.filter(({ scope }) => scope !== 'source') : operations;
}

function defaultOperation(operations: readonly CanonicalOperation[]): CanonicalOperation | undefined {
  return operations.find((operation) => operation.primary) ?? operations[0];
}

function operationParameters(surface: CanonicalInstrumentSurface, operation: CanonicalOperation | undefined): readonly CanonicalParameter[] {
  if (!operation) return [];
  const byId = new Map(surface.parameters.map((parameter) => [parameter.id, parameter] as const));
  return operation.parameterIds.flatMap((parameterId) => byId.get(parameterId) ?? []);
}

function initialIntents(parameters: readonly CanonicalParameter[]): Readonly<Record<string, CanonicalParameterIntent>> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.requested]));
}

function firstInvalidParameter(
  parameters: readonly CanonicalParameter[],
  intents: Readonly<Record<string, CanonicalParameterIntent>>,
): { parameter: CanonicalParameter; issue: string } | undefined {
  for (const parameter of parameters) {
    const intent = intents[parameter.id] ?? parameter.requested;
    const issue = intent.mode === 'manual' ? manualValueIssue(parameter, intent.value) : undefined;
    if (issue) return { parameter, issue };
  }
}

function numericValue(value: CanonicalParameterScalarValue, fallback: CanonicalParameterScalarValue): number {
  if (typeof value === 'number') return value;
  return typeof fallback === 'number' ? fallback : 0;
}

function manualValueIssue(parameter: CanonicalParameter, value: CanonicalParameterScalarValue): string | undefined {
  switch (parameter.manual.kind) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a finite number.';
      if (parameter.manual.kind === 'integer' && !Number.isInteger(value)) return 'Enter a whole number.';
      if (value < parameter.manual.range.min || value > parameter.manual.range.max) {
        return `Enter a value from ${formatNumber(parameter.manual.range.min)} to ${formatNumber(parameter.manual.range.max)}${parameter.unit ? ` ${parameter.unit}` : ''}.`;
      }
      const step = parameter.manual.range.step;
      if (step !== undefined && !isOnLattice(value, parameter.manual.range.min, step)) {
        return `Use ${formatNumber(step)}${parameter.unit ? ` ${parameter.unit}` : ''} increments.`;
      }
      return undefined;
    }
    case 'enum':
      return typeof value === 'string' && parameter.manual.options.some((option) => option.value === value)
        ? undefined
        : 'Choose one of the advertised values.';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Choose on or off.';
    case 'text': {
      if (typeof value !== 'string') return 'Enter text.';
      if (value.length < parameter.manual.minimumLength || value.length > parameter.manual.maximumLength) {
        return `Use ${parameter.manual.minimumLength} to ${parameter.manual.maximumLength} characters.`;
      }
      if (!parameter.manual.pattern) return undefined;
      try {
        return new RegExp(parameter.manual.pattern).test(value) ? undefined : 'The value does not match the driver-required format.';
      } catch {
        return 'The driver supplied an invalid text format.';
      }
    }
  }
}

function isOnLattice(value: number, origin: number, step: number): boolean {
  return Math.abs((value - origin) / step - Math.round((value - origin) / step)) <= 1e-9;
}

function formatParameterValue(parameter: CanonicalParameter, value: CanonicalParameterScalarValue): string {
  switch (parameter.manual.kind) {
    case 'enum':
      return typeof value === 'string'
        ? parameter.manual.options.find((option) => option.value === value)?.label ?? value
        : String(value);
    case 'boolean':
      return value === true ? 'On' : value === false ? 'Off' : String(value);
    case 'number':
    case 'integer':
      return typeof value === 'number'
        ? `${formatNumber(value)}${parameter.unit ? ` ${parameter.unit}` : ''}`
        : String(value);
    case 'text':
      return String(value);
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 9,
  }).format(value);
}

function sentenceCase(value: string): string {
  return value.replaceAll('-', ' ').replace(/^./, (character) => character.toUpperCase());
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
