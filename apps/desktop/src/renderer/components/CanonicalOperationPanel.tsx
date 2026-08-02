import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, ChevronRight, Cpu, RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react';
import type {
  CanonicalAcquisitionKind,
  CanonicalInstrumentSurface,
  CanonicalOperation,
  CanonicalOperationConstraint,
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
  /** Optional result-shape context; never a driver or device-family branch. */
  readonly acquisitionKind?: CanonicalAcquisitionKind;
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
 * custom-value domain and recommendation policy for every parameter; Atomizer never
 * derives a native value, native setting name, or source family branch here.
 */
export function CanonicalOperationPanel({
  surface,
  operationId,
  placement,
  acquisitionKind,
  busy,
  className,
  onExecute,
}: CanonicalOperationPanelProps) {
  const operations = operationsForPlacement(surface.operations, placement, acquisitionKind);
  const [selectedOperationId, setSelectedOperationId] = useState<string | undefined>(
    () => operationId ?? defaultOperation(operations)?.id,
  );
  const operation = operationId === undefined
    ? operations.find((candidate) => candidate.id === selectedOperationId) ?? defaultOperation(operations)
    : operations.find((candidate) => candidate.id === operationId);
  const resetKey = `${surface.revision}:${acquisitionKind ?? ''}:${operation?.id ?? operationId ?? ''}`;
  const parameters = operationParameters(surface, operation);
  const [intents, setIntents] = useState<Readonly<Record<string, CanonicalParameterIntent>>>(() => initialIntents(parameters));
  const [executing, setExecuting] = useState(false);
  const [executionError, setExecutionError] = useState<string>();
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [expandedParameterId, setExpandedParameterId] = useState<string>();

  // A new surface revision is a new driver truth.  Preserve deliberate edits
  // within a revision, but never carry them across a retune/configuration.
  useEffect(() => {
    setIntents(initialIntents(parameters));
    setExecuting(false);
    setExecutionError(undefined);
    setConfirmationPending(false);
    setExpandedParameterId(undefined);
  }, [resetKey]);

  // An operation ID passed by a host intentionally pins the panel. Otherwise
  // keep a deliberate peer choice across fresh driver truth when it is still
  // declared at this presentation location; fall back only when it is gone.
  useEffect(() => {
    if (operationId !== undefined) return;
    setSelectedOperationId((current) => operations.some((operation) => operation.id === current)
      ? current
      : defaultOperation(operations)?.id);
  }, [surface.revision, operationId, placement, acquisitionKind]);

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
  const constraintIssues = operationConstraintIssues(parameters, operation.constraints ?? [], intents);
  const hasManualIntent = parameterIntents.some(({ intent }) => intent.mode === 'manual');
  const unavailable = operation.availability !== 'available';
  const disabled = busy || executing || unavailable || invalidParameter !== undefined || constraintIssues.length > 0;

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

  function restoreRecommendations(): void {
    setIntents(Object.fromEntries(parameters.map((parameter) => [parameter.id, { mode: 'auto' } as const])));
  }

  function customize(parameter: CanonicalParameter): void {
    const current = intents[parameter.id] ?? parameter.requested;
    if (current.mode === 'auto') updateMode(parameter, 'manual');
    setExpandedParameterId(parameter.id);
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

  return <section className={`canonical-operation-panel ${className ?? ''}`.trim()} aria-label={`${operation.label} settings`}>
    <header className="canonical-control-hero">
      <span className="canonical-control-kicker"><SlidersHorizontal size={13}/>Instrument setup</span>
      <div className="canonical-control-heading">
        <div><h2>{operation.label}</h2>{operation.description && <p>{operation.description}</p>}</div>
        <span className={unavailable ? 'unavailable' : hasManualIntent ? 'customized' : ''}>
          {unavailable ? operation.availability.replaceAll('-', ' ') : hasManualIntent ? 'Custom' : 'Ready'}
        </span>
      </div>
    </header>
    {operationId === undefined && operations.length > 1 && <div className="canonical-operation-tabs" role="group" aria-label="Instrument operation">
      {operations.map((candidate) => <button
        key={candidate.id}
        type="button"
        aria-pressed={candidate.id === operation.id}
        disabled={busy || executing || candidate.availability === 'unavailable'}
        onClick={() => setSelectedOperationId(candidate.id)}
      >{candidate.label}</button>)}
    </div>}
    <div className="canonical-recommendation">
      <div><Sparkles size={15}/><span><strong>Recommended settings</strong><small>Let the connected instrument choose a compatible configuration.</small></span></div>
      <button type="button" className="canonical-reset" disabled={busy || executing || !hasManualIntent} onClick={restoreRecommendations}>
        <RotateCcw size={12}/>Use recommended
      </button>
    </div>
    <div className="canonical-setting-groups">
      {parameterGroups(parameters).map(({ group, parameters: groupedParameters }) => <section key={group} className="canonical-setting-group" aria-label={`${group} settings`}>
        <h3>{group}</h3>
        {groupedParameters.map((parameter) => {
          const intent = intents[parameter.id] ?? parameter.requested;
          const issues = constraintIssues.filter((issue) => issue.parameterIds.includes(parameter.id));
          return <CanonicalParameterControl
            key={parameter.id}
            parameter={parameter}
            intent={intent}
            constraintIssues={issues}
            expanded={expandedParameterId === parameter.id}
            disabled={busy || executing || unavailable}
            onExpand={() => setExpandedParameterId((current) => current === parameter.id ? undefined : parameter.id)}
            onRecommended={() => updateMode(parameter, 'auto')}
            onCustomize={() => customize(parameter)}
            onManualValue={(value) => updateIntent(parameter.id, { mode: 'manual', value })}
          />;
        })}
      </section>)}
    </div>
    {invalidParameter && <div className="inline-error" role="alert">
      {invalidParameter.parameter.label}: {invalidParameter.issue}
    </div>}
    {constraintIssues.length > 0 && <div className="inline-error" role="alert">
      Resolve the highlighted settings before applying this configuration.
    </div>}
    {executionError && <div className="inline-error" role="alert">{executionError}</div>}
    {confirmationPending && <div className="canonical-operation-confirmation" role="alert">
      <p>This driver-declared operation can affect the connected hardware. Confirm the connected path before applying it.</p>
      <div>
        <button type="button" className="secondary" data-agent-exclusion="human-canonical-operation-boundary" onClick={() => setConfirmationPending(false)}>Cancel</button>
        <button type="button" data-agent-exclusion="human-canonical-operation-boundary" data-agent-risk="high-impact" onClick={execute}>Confirm and apply {operation.label}</button>
      </div>
    </div>}
    <div className="canonical-operation-apply">
      <button
        type="button"
        className="full"
        data-agent-exclusion="human-canonical-operation-boundary"
        disabled={disabled}
        onClick={execute}
      >
        <CheckCircle2 size={14}/>{executing ? 'Applying settings…' : confirmationPending ? `Review ${operation.label}` : 'Apply settings'}
      </button>
    </div>
  </section>;
}

/**
 * No renderer-owned fallback is permitted for an active instrument. A
 * canonical operation is the atomic source of its custom-value domain, driver
 * recommendation policy,
 * effective value, and verification evidence.
 */
export function CanonicalOperationRequired({ title = 'Instrument controls' }: { title?: string }) {
  return <section className="iq-control-panel">
    <div className="panel-header"><div><Cpu size={14}/>{title}</div><span>DRIVER REQUIRED</span></div>
    <div className="channel-contract-note" role="status" aria-label={`${title} unavailable`}>
      <Activity size={14}/><p>The connected driver has not declared a canonical operation for this function. Atomizer has no mutable controls to render until the driver supplies parameter domains, recommendation policy, and verification evidence.</p>
    </div>
  </section>;
}

function CanonicalParameterControl({
  parameter,
  intent,
  constraintIssues,
  expanded,
  disabled,
  onExpand,
  onRecommended,
  onCustomize,
  onManualValue,
}: {
  parameter: CanonicalParameter;
  intent: CanonicalParameterIntent;
  constraintIssues: readonly CanonicalConstraintIssue[];
  expanded: boolean;
  disabled: boolean;
  onExpand(): void;
  onRecommended(): void;
  onCustomize(): void;
  onManualValue(value: CanonicalParameterScalarValue): void;
}) {
  const issue = intent.mode === 'manual' ? manualValueIssue(parameter, intent.value) : undefined;
  const selectedValue = intent.mode === 'manual' ? intent.value : parameter.effectiveValue;
  // A surface only has an honest resolved recommendation when it was itself
  // emitted with the recommended intent. Switching a currently configured
  // custom setting back locally must not present the old custom value as if
  // the driver had recommended it.
  const recommendedValueKnown = parameter.requested.mode === 'auto';
  const summaryValue = intent.mode === 'auto' && !recommendedValueKnown
    ? 'Chosen on apply'
    : formatParameterValue(parameter, selectedValue);
  const issueIds = [
    ...(issue ? [`${parameter.id}-manual-issue`] : []),
    ...constraintIssues.map((_, index) => `${parameter.id}-constraint-${index}`),
  ];
  return <div className={`canonical-parameter${expanded ? ' expanded' : ''}`} data-canonical-parameter={parameter.id}>
    <button
      type="button"
      className="canonical-setting-summary"
      aria-expanded={expanded}
      aria-controls={`${parameter.id}-setting-editor`}
      aria-describedby={issueIds.length === 0 ? undefined : issueIds.join(' ')}
      disabled={disabled}
      onClick={onExpand}
    >
      <span><small>{parameter.label}</small><strong>{intent.mode === 'auto' ? 'Recommended' : 'Custom'}</strong></span>
      <span><strong>{summaryValue}</strong><ChevronRight size={15}/></span>
    </button>
    {expanded && <div id={`${parameter.id}-setting-editor`} className="canonical-setting-editor">
      <div className="canonical-setting-choices" role="radiogroup" aria-label={`${parameter.label} setting mode`}>
        <button type="button" role="radio" aria-checked={intent.mode === 'auto'} disabled={disabled} onClick={onRecommended}>
          <span><strong>Recommended</strong><small>{recommendedValueKnown ? `${formatParameterValue(parameter, parameter.effectiveValue)} · selected by instrument` : 'The connected instrument will choose a compatible value.'}</small></span>
          {intent.mode === 'auto' && <CheckCircle2 size={15}/>}
        </button>
        <button type="button" role="radio" aria-checked={intent.mode === 'manual'} disabled={disabled} onClick={onCustomize}>
          <span><strong>Custom</strong><small>Choose a value for this measurement.</small></span>
          {intent.mode === 'manual' && <CheckCircle2 size={15}/>}
        </button>
      </div>
      {intent.mode === 'manual' && <div className="canonical-custom-editor">
        <ManualParameterControl parameter={parameter} value={intent.value} disabled={disabled} onValue={onManualValue}/>
      </div>}
      <details className="canonical-setting-details">
        <summary>Details</summary>
        <p>{parameter.auto.description}</p>
        <span>Current value: {sentenceCase(parameter.verification)}</span>
      </details>
    </div>}
    {issue && <span id={`${parameter.id}-manual-issue`} className="canonical-parameter-error" role="alert">{issue}</span>}
    {constraintIssues.map((constraint, index) => <span key={constraint.key} id={`${parameter.id}-constraint-${index}`} className="canonical-parameter-error" role="alert">{constraint.message}</span>)}
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

function operationsForPlacement(
  operations: readonly CanonicalOperation[],
  placement: CanonicalOperationPlacement | undefined,
  acquisitionKind: CanonicalAcquisitionKind | undefined,
): readonly CanonicalOperation[] {
  const candidates = placement === 'source'
    ? operations.filter(({ scope }) => scope === 'source' || scope === 'instrument')
    : placement === 'acquisition'
      ? operations.filter(({ scope }) => scope !== 'source')
      : operations;
  if (acquisitionKind === undefined) return candidates;
  const acquisitionCandidates = candidates.filter(({ scope }) => scope !== 'source');
  const typed = acquisitionCandidates.filter((operation) => operation.acquisitionKind === acquisitionKind);
  if (typed.length > 0) return typed;
  const legacy = acquisitionCandidates.filter((operation) => operation.acquisitionKind === undefined);
  return legacy.length === 1 ? legacy : [];
}

type CanonicalConstraintIssue = Readonly<{
  key: string;
  message: string;
  parameterIds: readonly [string, string];
}>;

function parameterGroups(parameters: readonly CanonicalParameter[]): readonly Readonly<{
  group: string;
  parameters: readonly CanonicalParameter[];
}>[] {
  const groups = new Map<string, CanonicalParameter[]>();
  for (const parameter of parameters) {
    const group = groups.get(parameter.group);
    if (group) group.push(parameter);
    else groups.set(parameter.group, [parameter]);
  }
  return [...groups].map(([group, groupedParameters]) => ({ group, parameters: groupedParameters }));
}

function operationConstraintIssues(
  parameters: readonly CanonicalParameter[],
  constraints: readonly CanonicalOperationConstraint[],
  intents: Readonly<Record<string, CanonicalParameterIntent>>,
): readonly CanonicalConstraintIssue[] {
  const parameterById = new Map(parameters.map((parameter) => [parameter.id, parameter] as const));
  const issues: CanonicalConstraintIssue[] = [];
  for (const constraint of constraints) {
    const leftParameter = parameterById.get(constraint.leftParameterId);
    const rightParameter = parameterById.get(constraint.rightParameterId);
    const leftIntent = leftParameter && (intents[leftParameter.id] ?? leftParameter.requested);
    const rightIntent = rightParameter && (intents[rightParameter.id] ?? rightParameter.requested);
    // Any recommended value can be resolved as a pair by the connected
    // driver. Only two explicit custom values form a deterministic invalid
    // draft that Atomizer can honestly reject before touching hardware.
    if (!leftIntent || !rightIntent || leftIntent.mode !== 'manual' || rightIntent.mode !== 'manual'
      || typeof leftIntent.value !== 'number' || typeof rightIntent.value !== 'number') continue;
    if (numericRelationHolds(leftIntent.value, constraint.relation, rightIntent.value)) continue;
    issues.push({
      key: `${constraint.leftParameterId}:${constraint.relation}:${constraint.rightParameterId}`,
      message: constraint.message,
      parameterIds: [constraint.leftParameterId, constraint.rightParameterId],
    });
  }
  return issues;
}

function numericRelationHolds(
  left: number,
  relation: CanonicalOperationConstraint['relation'],
  right: number,
): boolean {
  switch (relation) {
    case 'less-than': return left < right;
    case 'less-than-or-equal': return left <= right;
    case 'greater-than': return left > right;
    case 'greater-than-or-equal': return left >= right;
  }
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
