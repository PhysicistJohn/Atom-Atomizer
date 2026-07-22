import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Delete, X } from 'lucide-react';
import { formatFrequency } from '../format.js';

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
  const summary = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const units = entryUnits(unit);
  const initial = initialEntry(value, type, units);
  const [draft, setDraft] = useState(initial.draft);
  const [activeUnit, setActiveUnit] = useState(initial.unit);
  const [replaceOnDigit, setReplaceOnDigit] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<NumericPopoverPosition>();

  useEffect(() => {
    if (details.current?.open) return;
    const next = initialEntry(value, type, units);
    setDraft(next.draft);
    setActiveUnit(next.unit);
  }, [type, unit, value]);
  useEffect(() => {
    if (!open) return;
    const reposition = () => positionNumericPopover(summary.current, setPopoverPosition);
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition);
    };
  }, [open]);

  function resetEntry(): void {
    const next = initialEntry(value, type, units);
    setDraft(next.draft);
    setActiveUnit(next.unit);
    setReplaceOnDigit(true);
    setError(undefined);
  }

  function closeEditor(): void {
    if (details.current) details.current.open = false;
    setOpen(false);
    setPopoverPosition(undefined);
    summary.current?.focus();
  }

  function commit(multiplier = activeUnit.multiplier): void {
    const next = draft.trim();
    try {
      if (!next) throw new Error(`${label} is required`);
      let committed = next;
      if (type === 'number') {
        const numeric = Number(next);
        if (!Number.isFinite(numeric)) throw new Error(`${label} must be a number`);
        const baseValue = numeric * multiplier;
        if (!Number.isFinite(baseValue)) throw new Error(`${label} is outside the numeric range`);
        if (unit === 'Hz' && !Number.isSafeInteger(baseValue)) throw new Error(`${label} must resolve to a whole number of Hz`);
        if (minimum !== undefined && baseValue < minimum) throw new Error(`${label} must be at least ${formatBound(minimum, unit)}`);
        if (maximum !== undefined && baseValue > maximum) throw new Error(`${label} must be at most ${formatBound(maximum, unit)}`);
        if (typeof step === 'number' && step > 0) {
          const steps = (baseValue - (minimum ?? 0)) / step;
          if (Math.abs(steps - Math.round(steps)) > 1e-9) throw new Error(`${label} must use ${formatBound(step, unit)} steps`);
        }
        committed = String(baseValue);
      }
      if (!details.current) throw new Error(`${label} editor did not mount`);
      onCommit(committed);
      setError(undefined);
      closeEditor();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  function append(token: string): void {
    setDraft((current) => {
      if (replaceOnDigit) return token === '.' ? '0.' : token;
      if (token === '.' && current.includes('.')) return current;
      if (current === '0' && token !== '.') return token;
      return `${current}${token}`;
    });
    setReplaceOnDigit(false);
    setError(undefined);
    input.current?.focus();
  }

  function toggleSign(): void {
    setDraft((current) => current.startsWith('-') ? current.slice(1) : `-${current || '0'}`);
    setReplaceOnDigit(false);
    setError(undefined);
  }

  return <details ref={details} className={`parameter-row editable-parameter ${disabled ? 'disabled' : ''}`} data-agent-control={open ? undefined : controlId} data-agent-exclusion={open && controlId ? 'parameter-editor-origin' : undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary ref={summary} aria-label={`Edit ${label}`} aria-disabled={disabled} onClick={(event) => {
      event.preventDefault();
      if (disabled || !details.current) return;
      if (details.current.open) {
        closeEditor();
        return;
      }
      details.current?.closest('.parameter-stack')?.querySelectorAll<HTMLDetailsElement>('details.editable-parameter[open]').forEach((item) => {
        if (item !== details.current) item.open = false;
      });
      details.current.open = true;
      positionNumericPopover(summary.current, setPopoverPosition);
      setOpen(true);
      resetEntry();
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    }}>
      <span>{label}</span><strong>{displayValue ?? String(value)}{displayValue === undefined && unit && <em>{unit}</em>}</strong><ChevronDown size={15}/>
    </summary>
    {open && popoverPosition && createPortal(<div className="numeric-entry-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
      <section className="numeric-entry-panel" data-agent-control={controlId} data-parameter-editor={controlId ?? label} data-placement={popoverPosition.placement} style={{ top: popoverPosition.top, left: popoverPosition.left }} role="dialog" aria-modal="false" aria-label={`${label} numeric entry`} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
        if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); commit(); }
        if (event.key === 'Tab') {
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input')).filter((element) => !('disabled' in element) || !element.disabled);
          const first = focusable.at(0);
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <header><span><small>ACTIVE FUNCTION</small><strong>{label}</strong></span><button type="button" aria-label={`Cancel ${label} entry`} onClick={closeEditor}><X size={16}/></button></header>
        <div className="numeric-entry-display">
          <input ref={input} aria-label={label} aria-invalid={Boolean(error)} type="text" inputMode={type === 'number' ? 'none' : 'text'} value={draft} onFocus={(event) => event.currentTarget.select()} onChange={(event) => { setDraft(event.target.value); setReplaceOnDigit(false); setError(undefined); }}/>
          {activeUnit.label !== 'Enter' && <span>{activeUnit.label}</span>}
        </div>
        <div className="numeric-entry-context"><span>{minimum === undefined ? 'NO LOWER BOUND' : `MIN ${formatBound(minimum, unit)}`}</span><span>{maximum === undefined ? 'NO UPPER BOUND' : `MAX ${formatBound(maximum, unit)}`}</span></div>
        {error && <span className="parameter-error numeric-entry-error" role="alert">{error}</span>}
        <div className="numeric-entry-controls">
          {type === 'number' ? <div className="numeric-keypad" aria-label="Numeric keypad">
            {['7','8','9','4','5','6','1','2','3'].map((digit) => <button key={digit} type="button" onClick={() => append(digit)}>{digit}</button>)}
            <button type="button" aria-label="Toggle sign" onClick={toggleSign}>±</button>
            <button type="button" onClick={() => append('0')}>0</button>
            <button type="button" aria-label="Decimal point" onClick={() => append('.')}>.</button>
            <button type="button" className="numeric-key-wide" onClick={() => { setDraft(''); setReplaceOnDigit(false); setError(undefined); }}>Clear</button>
            <button type="button" aria-label="Backspace" onClick={() => { setDraft((current) => current.slice(0, -1)); setReplaceOnDigit(false); setError(undefined); }}><Delete size={17}/></button>
          </div> : <div className="numeric-keyboard-note">Type the value, then apply it.</div>}
          <div className="numeric-unit-keys" aria-label="Unit terminators">
            {units.map((entryUnit) => <button key={entryUnit.label} type="button" aria-label={`Apply ${entryUnit.label}`} className={entryUnit.label === activeUnit.label ? 'active' : ''} onClick={() => { setActiveUnit(entryUnit); commit(entryUnit.multiplier); }}><strong>{entryUnit.label}</strong><small>Apply</small></button>)}
          </div>
        </div>
        <footer><button type="button" onClick={closeEditor}>Cancel</button><button type="button" className="numeric-apply" aria-label={`Apply using ${activeUnit.label}`} onClick={() => commit()}><Check size={14}/>Apply {activeUnit.label === 'Enter' ? '' : activeUnit.label}</button></footer>
      </section>
    </div>, document.body)}
  </details>;
}

interface EntryUnit { label: string; multiplier: number }
interface NumericPopoverPosition { top: number; left: number; placement: 'left' | 'right' | 'over' }

const NUMERIC_POPOVER_WIDTH = 420;
const NUMERIC_POPOVER_HEIGHT = 548;
const NUMERIC_POPOVER_GAP = 12;
const NUMERIC_POPOVER_EDGE = 16;

function positionNumericPopover(anchor: HTMLElement | null, setPosition: (position: NumericPopoverPosition) => void): void {
  if (!anchor) return;
  const bounds = anchor.getBoundingClientRect();
  const maximumLeft = Math.max(NUMERIC_POPOVER_EDGE, window.innerWidth - NUMERIC_POPOVER_WIDTH - NUMERIC_POPOVER_EDGE);
  const fitsLeft = bounds.left - NUMERIC_POPOVER_GAP - NUMERIC_POPOVER_WIDTH >= NUMERIC_POPOVER_EDGE;
  const fitsRight = bounds.right + NUMERIC_POPOVER_GAP + NUMERIC_POPOVER_WIDTH <= window.innerWidth - NUMERIC_POPOVER_EDGE;
  const placement: NumericPopoverPosition['placement'] = fitsLeft ? 'left' : fitsRight ? 'right' : 'over';
  const preferredLeft = placement === 'left'
    ? bounds.left - NUMERIC_POPOVER_GAP - NUMERIC_POPOVER_WIDTH
    : placement === 'right'
      ? bounds.right + NUMERIC_POPOVER_GAP
      : bounds.left + bounds.width / 2 - NUMERIC_POPOVER_WIDTH / 2;
  const maximumTop = Math.max(NUMERIC_POPOVER_EDGE, window.innerHeight - NUMERIC_POPOVER_HEIGHT - NUMERIC_POPOVER_EDGE);
  setPosition({
    placement,
    left: Math.min(maximumLeft, Math.max(NUMERIC_POPOVER_EDGE, preferredLeft)),
    top: Math.min(maximumTop, Math.max(NUMERIC_POPOVER_EDGE, bounds.top - 36)),
  });
}

function entryUnits(unit?: string): readonly EntryUnit[] {
  if (unit === 'Hz') return [{ label: 'GHz', multiplier: 1e9 }, { label: 'MHz', multiplier: 1e6 }, { label: 'kHz', multiplier: 1e3 }, { label: 'Hz', multiplier: 1 }];
  if (unit === 's') return [{ label: 's', multiplier: 1 }, { label: 'ms', multiplier: 1e-3 }, { label: 'µs', multiplier: 1e-6 }];
  return [{ label: unit ?? 'Enter', multiplier: 1 }];
}

function initialEntry(value: string | number, type: 'number' | 'text', units: readonly EntryUnit[]): { draft: string; unit: EntryUnit } {
  const fallback = units.at(-1)!;
  if (type !== 'number' || !Number.isFinite(Number(value))) return { draft: String(value), unit: fallback };
  const numeric = Number(value);
  const absolute = Math.abs(numeric);
  const unit = absolute === 0 ? fallback : units.find((candidate) => candidate.multiplier <= absolute) ?? fallback;
  return { draft: trimEntry(numeric / unit.multiplier), unit };
}

function trimEntry(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

function formatBound(value: number, unit?: string): string {
  if (unit === 'Hz') return formatFrequency(value, 6);
  if (unit === 's' && Math.abs(value) < 1) return `${trimEntry(value * 1_000)} ms`;
  return `${trimEntry(value)}${unit ? ` ${unit}` : ''}`;
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
  const unavailable = current === undefined;
  const effectivelyDisabled = disabled || options.length === 0;
  return <label className={`parameter-row select-parameter ${effectivelyDisabled ? 'disabled' : ''} ${unavailable ? 'invalid' : ''}`} data-agent-control={controlId}>
    <span>{label}</span><strong>{current?.label ?? `${String(value)} · unavailable`}</strong><ChevronDown size={15}/>
    <select aria-label={label} aria-invalid={unavailable || undefined} value={value} disabled={effectivelyDisabled} onChange={(event) => onValue(event.target.value)}>
      {unavailable && <option value={value} disabled>{String(value)} · unavailable</option>}
      {options.map((option) => <option key={String(option.value)} value={option.value}>{option.label}</option>)}
    </select>
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
