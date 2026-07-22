import { describe, expect, it } from 'vitest';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import type { ComplexIqMeasurement } from './complex-iq.js';
import { selectClassificationInput } from './classification-input-selection.js';

const target = { id: 'target-1' } as DetectedSignal;
const capture = (measurementId: string, capturedAt: string) =>
  ({ measurementId, capturedAt } as ComplexIqMeasurement);
const sweep = (id: string, capturedAt: string) =>
  ({ id, capturedAt } as Sweep);

describe('classification input selection', () => {
  it('moves an I/Q-capable Detect workspace onto each newer Run sweep', () => {
    const retainedIq = capture('iq-1', '2026-07-22T00:00:00.000Z');
    const first = selectClassificationInput({
      iqCapable: true,
      capture: retainedIq,
      sweep: sweep('sweep-1', '2026-07-22T00:00:01.000Z'),
      target,
    });
    const second = selectClassificationInput({
      iqCapable: true,
      capture: retainedIq,
      sweep: sweep('sweep-2', '2026-07-22T00:00:02.000Z'),
      target,
    });

    expect(first).toEqual({ source: 'scalar', key: 'scalar:sweep-1:target-1' });
    expect(second).toEqual({ source: 'scalar', key: 'scalar:sweep-2:target-1' });
  });

  it('prefers a newer or equally recent I/Q capture', () => {
    for (const iqCapturedAt of [
      '2026-07-22T00:00:01.000Z',
      '2026-07-22T00:00:02.000Z',
    ]) {
      expect(selectClassificationInput({
        iqCapable: true,
        capture: capture('iq-latest', iqCapturedAt),
        sweep: sweep('sweep-old', '2026-07-22T00:00:01.000Z'),
        target,
      })).toEqual({ source: 'iq', key: 'iq:iq-latest' });
    }
  });

  it('uses scalar evidence on an I/Q-capable source before any I/Q capture exists', () => {
    expect(selectClassificationInput({
      iqCapable: true,
      capture: undefined,
      sweep: sweep('sweep-only', '2026-07-22T00:00:01.000Z'),
      target,
    })).toEqual({ source: 'scalar', key: 'scalar:sweep-only:target-1' });
  });

  it('keeps the retained I/Q result until a scalar target is available', () => {
    expect(selectClassificationInput({
      iqCapable: true,
      capture: capture('iq-1', '2026-07-22T00:00:00.000Z'),
      sweep: sweep('untargeted', '2026-07-22T00:00:01.000Z'),
      target: undefined,
    })).toEqual({ source: 'iq', key: 'iq:iq-1' });
  });
});
