import type { DetectedSignal, Sweep } from '@tinysa/contracts';

export const REGULAR_SPECTRAL_COMPONENT_MODEL_ID =
  'regular-spectral-component-lineage-v2' as const;

export function regularSpectralComponentLineageId(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error('Regular spectral-component lineage ordinal must be a positive safe integer');
  }
  return `regular-spectral-component-lineage-${String(ordinal).padStart(4, '0')}`;
}

export interface RegularSpectralComponentAssociation {
  candidateIndices: readonly number[];
  startHz: number;
  stopHz: number;
  /** Largest directly resolved step supported by this exact current detector population. */
  spacingHz: number;
  /** One exact current member center; other members lie on integer lattice steps from it. */
  latticeAnchorHz: number;
  /** Exact current detector-component centers, sorted by frequency. */
  memberCentersHz: readonly number[];
}

export interface RegularSpectralComponentLatticeRegion {
  startHz: number;
  stopHz: number;
  spacingHz: number;
  latticeAnchorHz: number;
  /** Exact current-look detector-component centers; track IDs may differ across looks. */
  memberCentersHz: readonly number[];
}

/**
 * A regular-line association is non-identity regional morphology. Its lineage
 * may therefore survive local track replacement or an intermittently missed
 * edge line, but only when both looks support the same replayable frequency
 * lattice, overlapping regional support, and at least one resolved component
 * center in common. Track IDs need not survive that shared frequency support.
 */
export function regularSpectralComponentLineagesAreCompatible(
  left: RegularSpectralComponentLatticeRegion,
  right: RegularSpectralComponentLatticeRegion,
  rbwHz: number,
  binWidthHz: number,
): boolean {
  if (![left.startHz, left.stopHz, left.spacingHz, left.latticeAnchorHz,
    right.startHz, right.stopHz, right.spacingHz, right.latticeAnchorHz,
    rbwHz, binWidthHz].every(Number.isFinite)
    || !left.memberCentersHz.length
    || !right.memberCentersHz.length
    || left.memberCentersHz.some((value) => !Number.isFinite(value))
    || right.memberCentersHz.some((value) => !Number.isFinite(value))
    || left.stopHz <= left.startHz
    || right.stopHz <= right.startHz
    || left.spacingHz <= 0
    || right.spacingHz <= 0
    || rbwHz <= 0
    || binWidthHz <= 0) return false;
  const fundamentalSpacingHz = Math.min(left.spacingHz, right.spacingHz);
  const largerSpacingHz = Math.max(left.spacingHz, right.spacingHz);
  const spacingToleranceHz = Math.max(
    binWidthHz * 2,
    rbwHz * 0.5,
    fundamentalSpacingHz * 0.08,
  );
  const spacingRatio = Math.round(largerSpacingHz / fundamentalSpacingHz);
  if (spacingRatio < 1
    || spacingRatio > 2
    || Math.abs(largerSpacingHz - spacingRatio * fundamentalSpacingHz)
      > spacingToleranceHz) return false;
  const anchorSteps = Math.round(
    (right.latticeAnchorHz - left.latticeAnchorHz) / fundamentalSpacingHz,
  );
  if (Math.abs(
    right.latticeAnchorHz - left.latticeAnchorHz
      - anchorSteps * fundamentalSpacingHz,
  ) > spacingToleranceHz) return false;
  const sharedMemberToleranceHz = Math.max(binWidthHz * 2, rbwHz * 0.5);
  if (!left.memberCentersHz.some((leftCenterHz) =>
    right.memberCentersHz.some((rightCenterHz) =>
      Math.abs(leftCenterHz - rightCenterHz) <= sharedMemberToleranceHz))) {
    return false;
  }
  // Require observed support to overlap. Merely lying on the same infinite
  // lattice is not enough: two nearby independent combs can share spacing and
  // phase. Real outer-line churn retains at least one resolved component (and
  // therefore a non-zero hull overlap); a wholly disjoint jump is ambiguous
  // and must allocate a new non-identity lineage.
  return Math.min(left.stopHz, right.stopHz) > Math.max(left.startHz, right.startHz);
}

/** Pure regular-line association shared by tracking and provenance revalidation. */
export function regularSpectralComponentAssociations(
  candidates: readonly DetectedSignal[],
  sweep: Sweep,
): readonly RegularSpectralComponentAssociation[] {
  // Three resolved, regularly spaced components are the smallest scalar
  // morphology that can express a carrier with mirrored sidebands. The
  // association remains explicitly non-identifying.
  if (candidates.length < 3 || sweep.frequencyHz.length < 2) return [];
  const binWidthHz = median(sweep.frequencyHz.slice(1).map(
    (frequency, index) => frequency - sweep.frequencyHz[index]!,
  ));
  const minimumSpacingHz = Math.max(1_000, binWidthHz * 4, sweep.actualRbwHz * 1.5);
  const maximumSpacingHz = 500_000;
  const maximumClusterSpanHz = Math.min(2_000_000, (sweep.actualStopHz - sweep.actualStartHz) * 0.6);
  const centers = candidates.map((candidate, candidateIndex) => ({
    candidateIndex,
    frequencyHz: (candidate.startHz + candidate.stopHz) / 2,
    peakDbm: candidate.peakDbm,
    bandwidthHz: candidate.bandwidthHz,
  })).sort((left, right) => left.frequencyHz - right.frequencyHz);
  const hypothesisByMembers = new Map<string, {
    indices: readonly number[];
    spanHz: number;
    summedPeakDbm: number;
    spacingHz: number;
    latticeAnchorHz: number;
  }>();
  const evaluatedMemberSpacing = new Set<string>();
  for (let leftIndex = 0; leftIndex < centers.length - 1; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < centers.length; rightIndex++) {
      const left = centers[leftIndex]!;
      const right = centers[rightIndex]!;
      const differenceHz = right.frequencyHz - left.frequencyHz;
      for (let intervals = 1; intervals <= 8; intervals++) {
        const spacingHz = differenceHz / intervals;
        if (spacingHz < minimumSpacingHz || spacingHz > maximumSpacingHz) continue;
        const toleranceHz = Math.max(binWidthHz * 2, sweep.actualRbwHz * 0.5);
        const byStep = new Map<number, typeof left>();
        for (const center of centers) {
          if (center.bandwidthHz > Math.max(sweep.actualRbwHz * 4, spacingHz * 0.7)) continue;
          const step = Math.round((center.frequencyHz - left.frequencyHz) / spacingHz);
          if (Math.abs(step) > 12) continue;
          const residualHz = Math.abs(center.frequencyHz - (left.frequencyHz + step * spacingHz));
          if (residualHz > toleranceHz) continue;
          const existing = byStep.get(step);
          if (!existing || center.peakDbm > existing.peakDbm) byStep.set(step, center);
        }
        const selected = [...byStep.entries()].sort((a, b) => a[0] - b[0]);
        // A shared infinite lattice does not make disjoint combs one region.
        // Partition the current hits at gaps larger than one allowed missing
        // line so a remote same-spacing run cannot poison a valid local run.
        for (const run of maximalRegularStepRuns(selected)) {
          if (run.length < 3) continue;
          // This hypothesis was seeded by `left` and `right`; only the one
          // maximal run containing both seeds belongs to it. Other runs are
          // evaluated by their own local seed pairs, avoiding both cross-run
          // attribution and a combinatorial duplicate expansion.
          if (!run.some(([, center]) => center.candidateIndex === left.candidateIndex)
            || !run.some(([, center]) =>
              center.candidateIndex === right.candidateIndex)) continue;
          const runSteps = run.map(([step]) => step);
          const commonStepDivisor = runSteps.slice(1).reduce(
            (divisor, step, index) =>
              greatestCommonDivisor(divisor, step - runSteps[index]!),
            0,
          );
          if (commonStepDivisor > 1) continue;
          const selectedCenters = run.map(([, center]) => center);
          const firstFrequencyHz = selectedCenters[0]!.frequencyHz;
          const lastFrequencyHz = selectedCenters.at(-1)!.frequencyHz;
          const spanHz = lastFrequencyHz - firstFrequencyHz;
          const minimumSpanIntervals = run.length === 3 ? 1.8 : 2.8;
          if (spanHz < spacingHz * minimumSpanIntervals || spanHz > maximumClusterSpanHz) continue;
          const selectedIndices = new Set(
            selectedCenters.map((center) => center.candidateIndex),
          );
          const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
          const memberSpacingKey = `${sortedIndices.join(',')}@${spacingHz}`;
          if (evaluatedMemberSpacing.has(memberSpacingKey)) continue;
          evaluatedMemberSpacing.add(memberSpacingKey);
          if (centers.some((center) => center.frequencyHz > firstFrequencyHz
            && center.frequencyHz < lastFrequencyHz
            && !selectedIndices.has(center.candidateIndex))) continue;
          const summedPeakMilliwatts = selectedCenters.reduce(
            (sum, center) => sum + dbmToMilliwatts(center.peakDbm),
            0,
          );
          const hypothesis = {
            indices: sortedIndices,
            spanHz,
            summedPeakDbm: milliwattsToDbm(summedPeakMilliwatts),
            spacingHz,
            latticeAnchorHz: firstFrequencyHz,
          };
          const key = hypothesis.indices.join(',');
          const existing = hypothesisByMembers.get(key);
          if (!existing
            || hypothesis.summedPeakDbm > existing.summedPeakDbm
            || (hypothesis.summedPeakDbm === existing.summedPeakDbm
              && (hypothesis.spanHz < existing.spanHz
                || (hypothesis.spanHz === existing.spanHz
                  // The larger spacing is the directly resolved lattice.
                  // A smaller divisor with empty intermediate steps is an
                  // observationally possible fundamental, not a resolved one.
                  && hypothesis.spacingHz > existing.spacingHz)))) {
            hypothesisByMembers.set(key, hypothesis);
          }
        }
      }
    }
  }

  const hypotheses = [...hypothesisByMembers.values()];
  const maximal = hypotheses.filter((hypothesis) => !hypotheses.some((other) =>
    other !== hypothesis
    && other.indices.length > hypothesis.indices.length
    && hypothesis.indices.every((index) => other.indices.includes(index))));
  const ambiguous = new Set<typeof maximal[number]>();
  for (let leftIndex = 0; leftIndex < maximal.length - 1; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < maximal.length; rightIndex++) {
      const left = maximal[leftIndex]!;
      const right = maximal[rightIndex]!;
      if (!left.indices.some((index) => right.indices.includes(index))) continue;
      ambiguous.add(left);
      ambiguous.add(right);
    }
  }
  return maximal.filter((hypothesis) => !ambiguous.has(hypothesis)).map((hypothesis) => {
    const selectedCandidates = hypothesis.indices.map((index) => candidates[index]!);
    return {
      candidateIndices: hypothesis.indices,
      startHz: Math.min(...selectedCandidates.map((candidate) => candidate.startHz)),
      stopHz: Math.max(...selectedCandidates.map((candidate) => candidate.stopHz)),
      spacingHz: hypothesis.spacingHz,
      latticeAnchorHz: hypothesis.latticeAnchorHz,
      memberCentersHz: selectedCandidates
        .map((candidate) => (candidate.startHz + candidate.stopHz) / 2)
        .sort((left, right) => left - right),
    };
  });
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function maximalRegularStepRuns<T>(
  selected: readonly (readonly [number, T])[],
): readonly (readonly (readonly [number, T])[])[] {
  const runs: Array<Array<readonly [number, T]>> = [];
  for (const item of selected) {
    const current = runs.at(-1);
    if (!current || item[0] - current.at(-1)![0] > 2) {
      runs.push([item]);
    } else {
      current.push(item);
    }
  }
  return runs;
}

function dbmToMilliwatts(value: number): number { return 10 ** (value / 10); }
function milliwattsToDbm(value: number): number { return 10 * Math.log10(Math.max(Number.MIN_VALUE, value)); }
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
