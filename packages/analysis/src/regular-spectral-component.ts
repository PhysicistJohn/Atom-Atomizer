import type { DetectedSignal, Sweep } from '@tinysa/contracts';

export interface RegularSpectralComponentAssociation {
  candidateIndices: readonly number[];
  startHz: number;
  stopHz: number;
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
  }>();
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
        if (selected.length < 3) continue;
        const steps = selected.map(([step]) => step);
        if (steps.slice(1).some((step, index) => step - steps[index]! > 2)) continue;
        const selectedCenters = selected.map(([, center]) => center);
        const firstFrequencyHz = selectedCenters[0]!.frequencyHz;
        const lastFrequencyHz = selectedCenters.at(-1)!.frequencyHz;
        const spanHz = lastFrequencyHz - firstFrequencyHz;
        const minimumSpanIntervals = selected.length === 3 ? 1.8 : 2.8;
        if (spanHz < spacingHz * minimumSpanIntervals || spanHz > maximumClusterSpanHz) continue;
        const selectedIndices = new Set(selectedCenters.map((center) => center.candidateIndex));
        if (centers.some((center) => center.frequencyHz > firstFrequencyHz
          && center.frequencyHz < lastFrequencyHz
          && !selectedIndices.has(center.candidateIndex))) continue;
        const summedPeakMilliwatts = selectedCenters.reduce(
          (sum, center) => sum + dbmToMilliwatts(center.peakDbm),
          0,
        );
        const hypothesis = {
          indices: [...selectedIndices].sort((a, b) => a - b),
          spanHz,
          summedPeakDbm: milliwattsToDbm(summedPeakMilliwatts),
        };
        const key = hypothesis.indices.join(',');
        const existing = hypothesisByMembers.get(key);
        if (!existing
          || hypothesis.summedPeakDbm > existing.summedPeakDbm
          || (hypothesis.summedPeakDbm === existing.summedPeakDbm && hypothesis.spanHz < existing.spanHz)) {
          hypothesisByMembers.set(key, hypothesis);
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
    };
  });
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
