import { describe, expect, it } from 'vitest';
import type { ModulationClassification } from './embedding-classifier-runtime.js';
import {
  accumulateModulationConsensus,
  DETECT_CONSENSUS_WINDOW_MS,
  emptyModulationConsensus,
} from './classification-consensus.js';

function result(
  distribution: Record<string, number>,
  modulation?: string,
  options: { readonly unknown?: boolean; readonly displayCandidates?: readonly string[] } = {},
): ModulationClassification {
  const ranked = Object.entries(distribution)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) => right.confidence - left.confidence);
  const winner = ranked[0]!;
  const candidates = options.displayCandidates
    ? options.displayCandidates.map((label) => ({ label, confidence: distribution[label]! }))
    : ranked;
  return {
    flavor: 'magnitude',
    family: options.unknown ? 'unknown' : winner.label,
    modulation: options.unknown ? 'unknown' : modulation ?? winner.label,
    confidence: winner.confidence,
    isUnknown: options.unknown ?? false,
    posterior: distribution,
    candidates,
    bwFraction: 0.2,
  };
}

describe('Detect modulation consensus', () => {
  it('projects the first instantaneous sample directly', () => {
    const { state, projection } = accumulateModulationConsensus(
      emptyModulationConsensus(),
      result({ dsss: 0.9, ofdm: 0.1 }, 'dsss'),
      10,
    );
    expect(state.samples).toHaveLength(1);
    expect(projection.sampleCount).toBe(1);
    expect(projection.result.family).toBe('dsss');
    expect(projection.result.confidence).toBeCloseTo(0.9);
  });

  it('updates the winner from the mean posterior inside the rolling time window', () => {
    let state = emptyModulationConsensus();
    ({ state } = accumulateModulationConsensus(state, result({ dsss: 0.9, ofdm: 0.1 }), 0));
    ({ state } = accumulateModulationConsensus(state, result({ ofdm: 0.8, dsss: 0.2 }), 100));
    const third = accumulateModulationConsensus(state, result({ ofdm: 0.9, dsss: 0.1 }, '64qam'), 200);

    expect(third.projection.sampleCount).toBe(3);
    expect(third.projection.result.family).toBe('ofdm');
    expect(third.projection.result.modulation).toBe('64qam');
    expect(third.projection.result.confidence).toBeCloseTo(0.6);
    expect(third.projection.result.candidates[1]?.label).toBe('dsss');
    expect(third.projection.result.candidates[1]?.confidence).toBeCloseTo(0.4);
  });

  it('retains every successful sample in 500 ms and evicts by inclusive timestamp boundary', () => {
    let state = emptyModulationConsensus();
    for (let observedAt = 0; observedAt <= 440; observedAt += 40) {
      ({ state } = accumulateModulationConsensus(state, result({ ofdm: 1 }), observedAt));
    }
    expect(state.samples).toHaveLength(12);

    ({ state } = accumulateModulationConsensus(state, result({ ofdm: 1 }), DETECT_CONSENSUS_WINDOW_MS));
    expect(state.samples).toHaveLength(13);
    expect(state.samples[0]?.completedAtMilliseconds).toBe(0);

    ({ state } = accumulateModulationConsensus(state, result({ ofdm: 1 }), DETECT_CONSENSUS_WINDOW_MS + 1));
    expect(state.samples).toHaveLength(13);
    expect(state.samples[0]?.completedAtMilliseconds).toBe(40);
  });

  it('lets a sustained new trend win after old samples age out', () => {
    let state = emptyModulationConsensus();
    for (const observedAt of [0, 100, 200]) {
      ({ state } = accumulateModulationConsensus(state, result({ dsss: 0.9, ofdm: 0.1 }), observedAt));
    }
    const outlier = accumulateModulationConsensus(state, result({ ofdm: 1, dsss: 0 }), 300);
    expect(outlier.projection.result.family).toBe('dsss');

    const replacement = accumulateModulationConsensus(outlier.state, result({ ofdm: 1, dsss: 0 }), 701);
    expect(replacement.state.samples.map((sample) => sample.completedAtMilliseconds)).toEqual([300, 701]);
    expect(replacement.projection.result.family).toBe('ofdm');
  });

  it('integrates the complete posterior rather than only display-truncated candidates', () => {
    const first = result(
      { dsss: 0.40, ofdm: 0.35, fm: 0.25 },
      undefined,
      { displayCandidates: ['dsss'] },
    );
    const second = result(
      { ofdm: 0.60, dsss: 0.30, fm: 0.10 },
      undefined,
      { displayCandidates: ['ofdm'] },
    );
    let state = accumulateModulationConsensus(emptyModulationConsensus(), first, 0).state;
    const projection = accumulateModulationConsensus(state, second, 20).projection.result;
    expect(projection.family).toBe('ofdm');
    expect(projection.posterior).toMatchObject({ ofdm: 0.475, dsss: 0.35, fm: 0.175 });
  });

  it('preserves candid unknown when it dominates the rolling samples', () => {
    let state = accumulateModulationConsensus(
      emptyModulationConsensus(),
      result({ dsss: 0.55, ofdm: 0.45 }, undefined, { unknown: true }),
      0,
    ).state;
    ({ state } = accumulateModulationConsensus(
      state,
      result({ ofdm: 0.9, dsss: 0.1 }),
      10,
    ));
    const projection = accumulateModulationConsensus(
      state,
      result({ ofdm: 0.51, dsss: 0.49 }, undefined, { unknown: true }),
      20,
    ).projection.result;
    expect(projection).toMatchObject({ family: 'unknown', modulation: 'unknown', isUnknown: true });
    expect(projection.confidence).toBeCloseTo(2 / 3);
    expect(projection.posterior?.ofdm).toBeCloseTo(0.62);
    expect(projection.posterior?.dsss).toBeCloseTo(0.38);
    expect(projection.candidates[0]?.label).toBe('ofdm');
    expect(projection.candidates[0]?.confidence).toBeCloseTo(0.62);
    expect(projection.topLeaf).toBeUndefined();
  });

  it('rejects a non-monotonic sample timestamp', () => {
    const state = accumulateModulationConsensus(emptyModulationConsensus(), result({ fm: 1 }), 10).state;
    expect(() => accumulateModulationConsensus(state, result({ fm: 1 }), 9))
      .toThrow(/monotonic/i);
  });
});
