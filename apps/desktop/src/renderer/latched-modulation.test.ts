import { describe, expect, it } from 'vitest';
import { latchModulation, type ModulationFrame } from './latched-modulation.js';

/** Build a frame from a per-label posterior; the top label is the frame's family. */
function frame(t: number, distribution: Record<string, number>): ModulationFrame {
  const candidates = Object.entries(distribution)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0]!;
  return {
    t,
    result: {
      flavor: 'iq',
      modulation: top.label,
      family: top.label,
      confidence: top.confidence,
      isUnknown: false,
      candidates,
      bwFraction: 0.1,
      topLeaf: undefined,
    },
  };
}

describe('latchModulation', () => {
  it('returns undefined for an empty window', () => {
    expect(latchModulation([], undefined)).toBeUndefined();
  });

  it('reports a single frame directly with its posterior as confidence', () => {
    const out = latchModulation([frame(0, { fm: 0.9, am: 0.1 })], undefined);
    expect(out?.family).toBe('fm');
    expect(out?.confidence).toBeCloseTo(0.9, 5);
  });

  it('latches the class that dominates the window despite an outlier frame', () => {
    const frames = [
      frame(0, { fm: 0.8, am: 0.2 }),
      frame(1, { fm: 0.8, am: 0.2 }),
      frame(2, { gsm: 0.7, fm: 0.3 }), // outlier
      frame(3, { fm: 0.8, am: 0.2 }),
    ];
    expect(latchModulation(frames, undefined)?.family).toBe('fm');
  });

  it('holds the incumbent when a challenger only marginally leads (hysteresis)', () => {
    const frames = [
      frame(0, { gsm: 0.6, fm: 0.4 }),
      frame(1, { gsm: 0.6, fm: 0.4 }),
      frame(2, { fm: 0.55, gsm: 0.45 }),
      frame(3, { fm: 0.55, gsm: 0.45 }),
    ];
    // gsm mass 2.10 vs fm mass 1.90: gsm leads but < 1.15x, so fm holds.
    expect(latchModulation(frames, undefined)?.family).toBe('gsm'); // no incumbent -> pure argmax
    expect(latchModulation(frames, 'fm')?.family).toBe('fm'); // incumbent fm resists the marginal lead
  });

  it('switches when the challenger clearly overtakes the incumbent', () => {
    const frames = [
      frame(0, { gsm: 0.7, fm: 0.3 }),
      frame(1, { gsm: 0.7, fm: 0.3 }),
      frame(2, { gsm: 0.7, fm: 0.3 }),
      frame(3, { fm: 0.6, gsm: 0.4 }),
    ];
    // gsm mass 2.5 vs fm mass 1.5: clear lead, incumbent fm yields.
    expect(latchModulation(frames, 'fm')?.family).toBe('gsm');
  });
});
