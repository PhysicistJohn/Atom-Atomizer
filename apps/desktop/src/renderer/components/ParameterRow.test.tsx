// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

afterEach(cleanup);

describe('parameter-row contract', () => {
  it('keeps the current value readable and commits numeric entry explicitly', () => {
    const commit = vi.fn();
    const { container } = render(<EditableParameter label="Center" value={98_000_000} displayValue="98 MHz" unit="Hz" minimum={0} onCommit={commit}/>);
    expect(screen.getByText('98 MHz')).toBeTruthy();
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByLabelText('Edit Center'));
    expect(details?.open).toBe(true);
    const dialog = screen.getByRole('dialog', { name: /Center numeric entry/i });
    const input = within(dialog).getByRole('textbox', { name: 'Center' }) as HTMLInputElement;
    expect(input.value).toBe('98');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Apply MHz$/i }));
    expect(commit).toHaveBeenCalledWith('100000000');
    expect(details?.open).toBe(false);
  });

  it('supports X-Series-style digit entry terminated by a frequency unit', () => {
    const commit = vi.fn();
    const { container } = render(<EditableParameter label="Stop frequency" value={108_000_000} displayValue="108 MHz" unit="Hz" minimum={1} maximum={17_922_600_000} step={1} controlId="analyzer.stop" onCommit={commit}/>);
    fireEvent.click(screen.getByLabelText('Edit Stop frequency'));
    const dialog = screen.getByRole('dialog', { name: /Stop frequency numeric entry/i });
    expect(dialog.parentElement).toBe(document.body.querySelector('.numeric-entry-layer'));
    expect(dialog.getAttribute('data-parameter-editor')).toBe('analyzer.stop');
    expect(dialog.getAttribute('data-agent-control')).toBe('analyzer.stop');
    expect(container.querySelector('details')?.getAttribute('data-agent-control')).toBeNull();
    expect(container.querySelector('details')?.getAttribute('data-agent-exclusion')).toBe('parameter-editor-origin');
    for (const digit of ['9', '1', '5']) fireEvent.click(within(dialog).getByRole('button', { name: digit }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Apply MHz$/i }));
    expect(commit).toHaveBeenCalledWith('915000000');
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('selects a readable sub-second unit and commits its base seconds exactly', () => {
    const commit = vi.fn();
    render(<EditableParameter label="Capture time" value={0.05} unit="s" minimum={0.003} maximum={60} step={0.001} onCommit={commit}/>);
    fireEvent.click(screen.getByLabelText('Edit Capture time'));
    const input = screen.getByRole('textbox', { name: 'Capture time' }) as HTMLInputElement;
    expect(input.value).toBe('50');
    fireEvent.click(screen.getByRole('button', { name: /^Apply ms$/i }));
    expect(commit).toHaveBeenCalledWith('0.05');
  });

  it('rejects out-of-range entry without silently changing the value', () => {
    const commit = vi.fn();
    const { container } = render(<EditableParameter label="Points" value={450} minimum={20} maximum={450} onCommit={commit}/>);
    const details = container.querySelector('details')!;
    fireEvent.click(screen.getByLabelText('Edit Points'));
    const dialog = screen.getByRole('dialog', { name: /Points numeric entry/i });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Points' }), { target: { value: '451' } });
    fireEvent.click(dialog.querySelector<HTMLButtonElement>('.numeric-apply')!);
    expect(screen.getByRole('alert').textContent).toContain('at most 450');
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps button keyboard activation distinct from input Enter', () => {
    const commit = vi.fn();
    const { container } = render(<EditableParameter label="Frequency" value={98_000_000} unit="Hz" onCommit={commit}/>);
    fireEvent.click(screen.getByLabelText('Edit Frequency'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Frequency' }), { key: 'Enter' });
    expect(commit).toHaveBeenCalledWith('98000000');
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('traps modal focus and restores it on Escape without committing', () => {
    const commit = vi.fn();
    render(<EditableParameter label="Frequency" value={98_000_000} unit="Hz" onCommit={commit}/>);
    const origin = screen.getByLabelText('Edit Frequency');
    fireEvent.click(origin);
    const dialog = screen.getByRole('dialog', { name: /Frequency numeric entry/i });
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0]!;
    const last = buttons.at(-1)!;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Frequency numeric entry/i })).toBeNull();
    expect(document.activeElement).toBe(origin);
    expect(commit).not.toHaveBeenCalled();
  });

  it('makes the full select row expose the current option', () => {
    const change = vi.fn();
    render(<SelectParameter label="Detector" value="sample" options={[{ value: 'sample', label: 'Sample' }, { value: 'average', label: 'Average' }]} onValue={change}/>);
    const select = screen.getByRole('combobox', { name: 'Detector' }) as HTMLSelectElement;
    expect(select.value).toBe('sample');
    fireEvent.change(select, { target: { value: 'average' } });
    expect(change).toHaveBeenCalledWith('average');
  });

  it('keeps only one numeric editor open in a parameter stack', () => {
    const { container } = render(<div className="parameter-stack"><EditableParameter label="Start" value={1} onCommit={vi.fn()}/><EditableParameter label="Stop" value={2} onCommit={vi.fn()}/></div>);
    const [start, stop] = Array.from(container.querySelectorAll('details'));
    fireEvent.click(screen.getByLabelText('Edit Start'));
    expect(start?.open).toBe(true);
    fireEvent.click(screen.getByLabelText('Edit Stop'));
    expect(start?.open).toBe(false);
    expect(stop?.open).toBe(true);
  });

  it('does not open an unavailable value editor', () => {
    const { container } = render(<EditableParameter label="Frequency" value={100} disabled onCommit={vi.fn()}/>);
    fireEvent.click(screen.getByLabelText('Edit Frequency'));
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('.disabled')).toBeTruthy();
  });
});
