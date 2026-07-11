import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface ParameterOption {
  value: string | number;
  label: string;
}

export function EditableParameter({ label, value, displayValue, unit, type = 'number', minimum, maximum, step, disabled = false, controlId, onCommit }: {
  label: string;
  value: string | number;
  displayValue?: string;
  unit?: string;
  type?: 'number' | 'text';
  minimum?: number;
  maximum?: number;
  step?: number | string;
  disabled?: boolean;
  controlId?: string;
  onCommit(value: string): void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!details.current?.open) setDraft(String(value));
  }, [value]);

  function commit(): void {
    const next = draft.trim();
    try {
      if (!next) throw new Error(`${label} is required`);
      if (type === 'number') {
        const numeric = Number(next);
        if (!Number.isFinite(numeric)) throw new Error(`${label} must be a number`);
        if (minimum !== undefined && numeric < minimum) throw new Error(`${label} must be at least ${minimum}`);
        if (maximum !== undefined && numeric > maximum) throw new Error(`${label} must be at most ${maximum}`);
      }
      onCommit(next);
      setError(undefined);
      if (!details.current) throw new Error(`${label} editor did not mount`);
      details.current.open = false;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  return <details ref={details} className={`parameter-row editable-parameter ${disabled ? 'disabled' : ''}`} data-agent-control={controlId} onToggle={(event) => {
    if (!event.currentTarget.open) return;
    setDraft(String(value));
    setError(undefined);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }}>
    <summary aria-label={`Edit ${label}`} aria-disabled={disabled} onClick={(event) => {
      if (disabled) { event.preventDefault(); return; }
      if (details.current?.open) return;
      details.current?.closest('.parameter-stack')?.querySelectorAll<HTMLDetailsElement>('details.editable-parameter[open]').forEach((item) => {
        if (item !== details.current) item.open = false;
      });
    }}>
      <span>{label}</span><strong>{displayValue ?? String(value)}{displayValue === undefined && unit && <em>{unit}</em>}</strong><ChevronDown size={15}/>
    </summary>
    <div className="parameter-editor">
      <div className="parameter-entry">
        <input ref={input} aria-label={label} aria-invalid={Boolean(error)} type={type} value={draft} min={minimum} max={maximum} step={step} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}/>
        {unit && <em>{unit}</em>}
        <button type="button" onClick={commit}><Check size={14}/>Apply</button>
      </div>
      {error && <span className="parameter-error" role="alert">{error}</span>}
    </div>
  </details>;
}

export function SelectParameter({ label, value, options, disabled = false, controlId, onValue }: {
  label: string;
  value: string | number;
  options: readonly ParameterOption[];
  disabled?: boolean;
  controlId?: string;
  onValue(value: string): void;
}) {
  const current = options.find((option) => String(option.value) === String(value));
  if (!current) throw new Error(`${label} value ${value} has no menu option`);
  return <label className={`parameter-row select-parameter ${disabled ? 'disabled' : ''}`} data-agent-control={controlId}>
    <span>{label}</span><strong>{current.label}</strong><ChevronDown size={15}/>
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onValue(event.target.value)}>{options.map((option) => <option key={String(option.value)} value={option.value}>{option.label}</option>)}</select>
  </label>;
}

export function ToggleParameter({ label, value, disabled = false, controlId, onToggle }: {
  label: string;
  value: boolean;
  disabled?: boolean;
  controlId?: string;
  onToggle(value: boolean): void;
}) {
  return <button type="button" className={`parameter-row toggle-parameter ${value ? 'on' : ''}`} data-agent-control={controlId} disabled={disabled} onClick={() => onToggle(!value)}><span>{label}</span><strong>{value ? 'On' : 'Off'}</strong><i/></button>;
}

export function SliderParameter({ label, value, displayValue, minimum, maximum, step = 1, disabled = false, controlId, onValue }: {
  label: string;
  value: number;
  displayValue: string;
  minimum: number;
  maximum: number;
  step?: number;
  disabled?: boolean;
  controlId?: string;
  onValue(value: number): void;
}) {
  return <label className={`parameter-row slider-parameter ${disabled ? 'disabled' : ''}`} data-agent-control={controlId}><span><span>{label}</span><strong>{displayValue}</strong></span><input aria-label={label} type="range" min={minimum} max={maximum} step={step} value={value} disabled={disabled} onChange={(event) => onValue(Number(event.target.value))}/></label>;
}
