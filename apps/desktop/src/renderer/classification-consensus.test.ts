import { describe, expect, it } from 'vitest';
import type { ModulationClassification } from './embedding-classifier-runtime.js';
import { accumulateModulationConsensus, DETECT_CONSENSUS_FIFO_LOOKS, emptyModulationConsensus } from './classification-consensus.js';

function result(distribution: Record<string, number>, modulation?: string): ModulationClassification {
  const candidates = Object.entries(distribution)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) => right.confidence - left.confidence);
  const family = candidates[0]!.label;
  return {
    flavor: 'magnitude',
    family,
    modulation: modulation ?? family,
    confidence: candidates[0]!.confidence,
    isUnknown: false,
    candidates,
    bwFraction: 0.2,
  };
}

describe('Detect modulation consensus', () => {
  it('projects the first look directly', () => {
    const { state, projection } = accumulateModulationConsensus(
      emptyModulationConsensus(),
      result({ dsss: 0.9, ofdm: 0.1 }, 'dsss'),
    );
    expect(state.lookCount).toBe(1);
    expect(projection.lookCount).toBe(1);
    expect(projection.result.family).toBe('dsss');
    expect(projection.result.confidence).toBeCloseTo(0.9);
  });

  it('updates the winner from the mean posterior in the live FIFO', () => {
    let state = emptyModulationConsensus();
    ({ state } = accumulateModulationConsensus(state, result({ dsss: 0.9, ofdm: 0.1 })));
    ({ state } = accumulateModulationConsensus(state, result({ ofdm: 0.8, dsss: 0.2 })));
    const third = accumulateModulationConsensus(state, result({ ofdm: 0.9, dsss: 0.1 }, '64qam'));

    expect(third.projection.lookCount).toBe(3);
    expect(third.projection.result.family).toBe('ofdm');
    expect(third.projection.result.modulation).toBe('64qam');
    expect(third.projection.result.confidence).toBeCloseTo(0.6);
    expect(third.projection.result.candidates[1]?.label).toBe('dsss');
    expect(third.projection.result.candidates[1]?.confidence).toBeCloseTo(0.4);
  });

  it('evicts the oldest look when the live FIFO is full', () => {
    let state = emptyModulationConsensus();
    ({ state } = accumulateModulationConsensus(state, result({ dsss: 1, ofdm: 0 })));
    for (let look = 0; look < DETECT_CONSENSUS_FIFO_LOOKS; look++) {
      ({ state } = accumulateModulationConsensus(state, result({ ofdm: 1, dsss: 0 })));
    }
    expect(state.lookCount).toBe(DETECT_CONSENSUS_FIFO_LOOKS);
    expect(state.frames).toHaveLength(DETECT_CONSENSUS_FIFO_LOOKS);
    expect(state.frames.every((frame) => frame.family === 'ofdm')).toBe(true);
    expect(accumulateModulationConsensus(state, result({ ofdm: 1 })).projection.result.confidence).toBe(1);
  });
});
