/** Inclusive sample indices for one threshold-connected response. */
export interface ComponentIndices {
  readonly first: number;
  readonly last: number;
}

/** Returns contiguous runs of samples selected by a threshold mask. */
export function connectedComponents(mask: readonly boolean[]): ComponentIndices[] {
  const components: ComponentIndices[] = [];
  let first: number | undefined;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] && first === undefined) first = index;
    if (first !== undefined && (!mask[index] || index === mask.length - 1)) {
      components.push({ first, last: mask[index] ? index : index - 1 });
      first = undefined;
    }
  }
  return components;
}

/** Joins bounded interior gaps only when their physical width fits the RBW policy. */
export function bridgeShortGaps(
  mask: boolean[],
  frequencies: readonly number[],
  actualRbwHz: number,
  maximumResolutionElements: number,
): void {
  let index = 0;
  while (index < mask.length) {
    if (mask[index]) { index++; continue; }
    const first = index;
    while (index < mask.length && !mask[index]) index++;
    if (first > 0 && index < mask.length && physicalGapFitsResolutionPolicy(
      frequencies,
      first,
      index,
      actualRbwHz,
      maximumResolutionElements,
    )) {
      for (let cursor = first; cursor < index; cursor++) mask[cursor] = true;
    }
  }
}

function physicalGapFitsResolutionPolicy(
  frequencies: readonly number[],
  firstGapIndex: number,
  firstRightSupportIndex: number,
  actualRbwHz: number,
  maximumResolutionElements: number,
): boolean {
  const leftSupportIndex = firstGapIndex - 1;
  const lastGapIndex = firstRightSupportIndex - 1;
  const gapStartHz = (frequencies[leftSupportIndex]! + frequencies[firstGapIndex]!) / 2;
  const gapStopHz = (frequencies[lastGapIndex]! + frequencies[firstRightSupportIndex]!) / 2;
  const gapWidthHz = gapStopHz - gapStartHz;
  let localSpacingHz = 0;
  for (let index = leftSupportIndex + 1; index <= firstRightSupportIndex; index++) {
    localSpacingHz = Math.max(localSpacingHz, frequencies[index]! - frequencies[index - 1]!);
  }
  const localResolutionScaleHz = Math.max(actualRbwHz, localSpacingHz);
  const maximumGapHz = maximumResolutionElements * localResolutionScaleHz;
  const toleranceHz = Math.max(1e-6, maximumGapHz * 1e-12);
  return Number.isFinite(gapWidthHz)
    && gapWidthHz > 0
    && gapWidthHz <= maximumGapHz + toleranceHz;
}
