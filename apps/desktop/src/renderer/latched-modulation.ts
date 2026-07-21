import { useEffect, useRef, useState } from 'react';
import type { ModulationClassification } from './embedding-classifier-runtime.js';

/** One time-stamped classifier result in the rolling accumulation window. */
export interface ModulationFrame {
  readonly t: number;
  readonly result: ModulationClassification;
}

export interface LatchOptions {
  /** Rolling window (ms) over which the dominant class is accumulated. */
  readonly windowMs: number;
  /**
   * Hysteresis: a challenger must exceed the incumbent's accumulated mass by
   * this factor before the displayed class switches. Keeps the readout from
   * flip-flopping between two near-tied classes.
   */
  readonly switchMargin: number;
}

export const DEFAULT_LATCH: LatchOptions = { windowMs: 1_000, switchMargin: 1.15 };

/**
 * Temporal latch for the live classifier readout. Each streamed capture is
 * classified independently, so a Run would otherwise flicker frame to frame.
 * This accumulates the per-family posterior mass over a rolling window and
 * displays the class that held the highest probability across it — "the
 * dominant class over ~the last second" — with a light incumbent margin so a
 * momentary tie does not swap the label. Detail fields (leaf, resolved order,
 * bandwidth) are taken from the most recent frame that actually resolved the
 * winning family, so they stay consistent with the latched class.
 *
 * Pure and deterministic in its inputs; the caller owns the frame window and
 * the clock, which keeps it unit-testable.
 */
export function latchModulation(
  frames: readonly ModulationFrame[],
  incumbentFamily: string | undefined,
  opts: LatchOptions = DEFAULT_LATCH,
): ModulationClassification | undefined {
  if (frames.length === 0) return undefined;
  const n = frames.length;
  const mass = new Map<string, number>();
  for (const frame of frames) {
    for (const candidate of frame.result.candidates) {
      mass.set(candidate.label, (mass.get(candidate.label) ?? 0) + candidate.confidence);
    }
  }
  const ranked = [...mass.entries()]
    .map(([label, total]) => ({ label, confidence: total / n }))
    .sort((a, b) => b.confidence - a.confidence);

  let winner = ranked[0]!.label;
  if (incumbentFamily && incumbentFamily !== winner) {
    const incumbentMass = mass.get(incumbentFamily) ?? 0;
    const challengerMass = mass.get(winner) ?? 0;
    if (challengerMass < incumbentMass * opts.switchMargin) winner = incumbentFamily;
  }

  const representative = [...frames].reverse().find((frame) => frame.result.family === winner)?.result
    ?? frames[n - 1]!.result;
  const matchesWinner = representative.family === winner;
  const winnerConfidence = (mass.get(winner) ?? 0) / n;
  const candidates = [
    { label: winner, confidence: winnerConfidence },
    ...ranked.filter((entry) => entry.label !== winner),
  ].slice(0, 4);

  return {
    ...representative,
    family: winner,
    modulation: matchesWinner ? representative.modulation : winner,
    isUnknown: matchesWinner ? representative.isUnknown : false,
    confidence: winnerConfidence,
    candidates,
    topLeaf: matchesWinner ? representative.topLeaf : undefined,
  };
}

/**
 * React binding for {@link latchModulation}. Feeds each new classifier result
 * into a rolling wall-clock window and returns the latched projection. The
 * returned value persists between frames (so a stopped Run keeps its last
 * stable readout) and resets when acquisition goes idle.
 */
export function useLatchedModulation(
  result: ModulationClassification | undefined,
  active: boolean,
  opts: LatchOptions = DEFAULT_LATCH,
): ModulationClassification | undefined {
  const framesRef = useRef<ModulationFrame[]>([]);
  const [latched, setLatched] = useState<ModulationClassification | undefined>(undefined);
  useEffect(() => {
    if (!active) {
      framesRef.current = [];
      setLatched(undefined);
      return;
    }
    if (!result) return;
    const now = performance.now();
    const frames = [...framesRef.current, { t: now, result }].filter((frame) => frame.t >= now - opts.windowMs);
    framesRef.current = frames;
    setLatched((previous) => latchModulation(frames, previous?.family, opts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, active]);
  return latched;
}
