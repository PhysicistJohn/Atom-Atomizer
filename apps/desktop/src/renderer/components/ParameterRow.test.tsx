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
    const input = within(details!).getByRole('spinbutton', { name: 'Center' });
    fireEvent.change(input, { target: { value: '100000000' } });
    fireEvent.click(within(details!).getByRole('button', { name: /Apply/i }));
    expect(commit).toHaveBeenCalledWith('100000000');
    expect(details?.open).toBe(false);
  });

  it('rejects out-of-range entry without silently changing the value', () => {
    const commit = vi.fn();
    const { container } = render(<EditableParameter label="Points" value={450} minimum={20} maximum={450} onCommit={commit}/>);
    const details = container.querySelector('details')!;
    fireEvent.click(screen.getByLabelText('Edit Points'));
    fireEvent.change(within(details).getByRole('spinbutton', { name: 'Points' }), { target: { value: '451' } });
    fireEvent.click(within(details).getByRole('button', { name: /Apply/i }));
    expect(screen.getByRole('alert').textContent).toContain('at most 450');
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
