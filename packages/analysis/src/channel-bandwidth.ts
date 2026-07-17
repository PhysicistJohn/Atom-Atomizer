import type { Sweep, ThreeDecibelBandwidthMeasurement, TraceFrame } from '@tinysa/contracts';

const HALF_POWER_DECIBELS = 10 * Math.log10(2);
const MINIMUM_RESOLVED_WIDTH_IN_RESOLUTION_ELEMENTS = 2;
const MINIMUM_ROBUST_WIDEBAND_WIDTH_IN_RESOLUTION_ELEMENTS = 3;
const ROBUST_ENVELOPE_GAP_IN_RESOLUTION_ELEMENTS = 4;
const ROBUST_UPPER_ENVELOPE_QUANTILE = 0.9;
const MINIMUM_COMPONENT_PROMINENCE_DB = 10;
const ROBUST_SIGMA_PROMINENCE_MULTIPLIER = 4;
const NARROW_PEAK_DOMINANCE_FRACTION = 0.5;

/**
 * Measures the local half-power width around the strongest sampled peak in a
 * caller-supplied channel window. Crossings are interpolated in dB versus
 * frequency. The result deliberately does not deconvolve an unknown receiver
 * filter: a response spanning at most two RBW/grid resolution elements is
 * reported as resolution-limited rather than as an emitter-width estimate.
 */
export function measureThreeDecibelBandwidth(
  sweep: Sweep,
  windowStartHz = sweep.actualStartHz,
  windowStopHz = sweep.actualStopHz,
): ThreeDecibelBandwidthMeasurement {
  validateScalarSweep(sweep);
  return measureSampledThreeDecibelBandwidth(sweep, windowStartHz, windowStopHz);
}

/** Same observed-response estimator for a host trace frame with explicit RBW. */
export function measureTraceThreeDecibelBandwidth(
  trace: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  actualRbwHz: number,
  windowStartHz = trace.frequencyHz[0]!,
  windowStopHz = trace.frequencyHz.at(-1)!,
  support?: { readonly startHz: number; readonly stopHz: number },
): ThreeDecibelBandwidthMeasurement {
  const response = {
    frequencyHz: trace.frequencyHz,
    powerDbm: trace.powerDbm,
    actualStartHz: trace.frequencyHz[0]!,
    actualStopHz: trace.frequencyHz.at(-1)!,
    actualRbwHz,
  };
  validateScalarResponse(response);
  return measureSampledThreeDecibelBandwidth(response, windowStartHz, windowStopHz, support);
}

interface SampledScalarResponse {
  readonly frequencyHz: readonly number[];
  readonly powerDbm: readonly number[];
  readonly actualStartHz: number;
  readonly actualStopHz: number;
  readonly actualRbwHz: number;
}

function measureSampledThreeDecibelBandwidth(
  sweep: SampledScalarResponse,
  windowStartHz: number,
  windowStopHz: number,
  support?: { readonly startHz: number; readonly stopHz: number },
): ThreeDecibelBandwidthMeasurement {
  if (!Number.isFinite(windowStartHz) || !Number.isFinite(windowStopHz) || windowStopHz <= windowStartHz) {
    throw new Error('3 dB bandwidth requires a positive finite measurement window');
  }
  if (windowStartHz < sweep.actualStartHz || windowStopHz > sweep.actualStopHz) {
    throw new Error(`3 dB bandwidth window ${windowStartHz}–${windowStopHz} Hz is outside the acquired span ${sweep.actualStartHz}–${sweep.actualStopHz} Hz`);
  }

  const sampledIndices = sweep.frequencyHz
    .map((frequencyHz, index) => ({ frequencyHz, index }))
    .filter(({ frequencyHz }) => frequencyHz >= windowStartHz && frequencyHz <= windowStopHz)
    .map(({ index }) => index);
  const resolutionScaleHz = Math.max(
    sweep.actualRbwHz,
    localGridResolutionHz(sweep.frequencyHz, windowStartHz, windowStopHz),
  );
  const base = { windowStartHz, windowStopHz, resolutionScaleHz } as const;
  if (!sampledIndices.length) return { ...base, status: 'unavailable', reason: 'no-sampled-peak' };

  const peakIndex = sampledIndices.reduce((best, index) =>
    sweep.powerDbm[index]! > sweep.powerDbm[best]! ? index : best, sampledIndices[0]!);
  const peakHz = sweep.frequencyHz[peakIndex]!;
  const peakDbm = sweep.powerDbm[peakIndex]!;
  const robustReference = robustWidebandReference(
    sweep,
    sampledIndices,
    peakIndex,
    resolutionScaleHz,
    support,
  );
  const referenceKind = robustReference
    ? 'robust-upper-envelope' as const
    : 'sampled-peak' as const;
  const referenceLevelDbm = robustReference?.referenceLevelDbm ?? peakDbm;
  const halfPowerLevelDbm = referenceLevelDbm - HALF_POWER_DECIBELS;
  const peak = {
    ...base,
    peakHz,
    peakDbm,
    referenceLevelDbm,
    referenceKind,
    halfPowerLevelDbm,
  } as const;
  if (robustReference?.kind === 'ambiguous') {
    return { ...peak, status: 'unavailable', reason: 'nonmonotone-half-power-response' };
  }

  const crossings = robustReference?.kind === 'wideband'
    ? crossingsAroundSupport(
      sweep,
      robustReference.firstIndex,
      robustReference.lastIndex,
      halfPowerLevelDbm,
    )
    : crossingsAroundPeak(sweep, peakIndex, halfPowerLevelDbm);
  if (crossings.reason) return { ...peak, status: 'unavailable', reason: crossings.reason };
  const { startHz, stopHz } = crossings;
  const windowToleranceHz = Math.max(1e-6, resolutionScaleHz * 1e-9);
  if (startHz < windowStartHz - windowToleranceHz || stopHz > windowStopHz + windowToleranceHz) {
    return { ...peak, status: 'unavailable', reason: 'crossing-outside-window' };
  }
  const bandwidthHz = stopHz - startHz;
  if (!Number.isFinite(bandwidthHz) || bandwidthHz <= 0) {
    throw new Error('3 dB bandwidth interpolation did not produce a positive finite width');
  }
  const resolutionLimitHz = resolutionScaleHz * MINIMUM_RESOLVED_WIDTH_IN_RESOLUTION_ELEMENTS;
  const resolutionLimitToleranceHz = Math.max(
    Number.EPSILON * resolutionLimitHz * 8,
    resolutionLimitHz * 1e-12,
  );
  const status = bandwidthHz <= resolutionLimitHz + resolutionLimitToleranceHz
    ? 'resolution-limited'
    : 'resolved';
  return { ...peak, status, startHz, stopHz, bandwidthHz };
}

type CrossingResult =
  | { readonly startHz: number; readonly stopHz: number; readonly reason?: never }
  | { readonly reason: 'lower-crossing-not-observed' | 'upper-crossing-not-observed' };

function crossingsAroundPeak(
  sweep: SampledScalarResponse,
  peakIndex: number,
  levelDbm: number,
): CrossingResult {
  let lowerIndex = peakIndex - 1;
  while (lowerIndex >= 0 && sweep.powerDbm[lowerIndex]! > levelDbm) lowerIndex--;
  if (lowerIndex < 0) return { reason: 'lower-crossing-not-observed' };
  let upperIndex = peakIndex + 1;
  while (upperIndex < sweep.powerDbm.length && sweep.powerDbm[upperIndex]! > levelDbm) upperIndex++;
  if (upperIndex >= sweep.powerDbm.length) return { reason: 'upper-crossing-not-observed' };
  return {
    startHz: interpolateLevelCrossing(sweep, lowerIndex, lowerIndex + 1, levelDbm),
    stopHz: interpolateLevelCrossing(sweep, upperIndex - 1, upperIndex, levelDbm),
  };
}

function crossingsAroundSupport(
  sweep: SampledScalarResponse,
  firstIndex: number,
  lastIndex: number,
  levelDbm: number,
): CrossingResult {
  let lowerIndex = firstIndex - 1;
  while (lowerIndex >= 0 && sweep.powerDbm[lowerIndex]! > levelDbm) lowerIndex--;
  if (lowerIndex < 0) return { reason: 'lower-crossing-not-observed' };
  let upperIndex = lastIndex + 1;
  while (upperIndex < sweep.powerDbm.length && sweep.powerDbm[upperIndex]! > levelDbm) upperIndex++;
  if (upperIndex >= sweep.powerDbm.length) return { reason: 'upper-crossing-not-observed' };
  return {
    startHz: interpolateLevelCrossing(sweep, lowerIndex, lowerIndex + 1, levelDbm),
    stopHz: interpolateLevelCrossing(sweep, upperIndex - 1, upperIndex, levelDbm),
  };
}

type RobustWidebandReference =
  | {
    readonly kind: 'wideband';
    readonly referenceLevelDbm: number;
    readonly firstIndex: number;
    readonly lastIndex: number;
  }
  | {
    readonly kind: 'ambiguous';
    readonly referenceLevelDbm: number;
  };

/**
 * A raw first crossing is correct for a narrow receiver response, but a single
 * OFDM/subcarrier fade must not truncate a broad plateau to one or two bins.
 * This policy estimates an upper-envelope reference from a qualified local
 * component, closes only bounded interior upper-envelope notches no wider than
 * four resolution elements, and either returns the outer support or fails
 * closed when resolved islands remain disjoint. Threshold components themselves
 * bridge at most one resolution element, so it cannot join components separated
 * by a floor gap wider than one element; a one-element gap is unresolved by
 * policy.
 */
function robustWidebandReference(
  sweep: SampledScalarResponse,
  sampledIndices: readonly number[],
  peakIndex: number,
  resolutionScaleHz: number,
  suppliedSupport?: { readonly startHz: number; readonly stopHz: number },
): RobustWidebandReference | undefined {
  const binWidthHz = nominalBinWidth(sweep.frequencyHz);
  const firstSampledIndex = sampledIndices[0]!;
  const lastSampledIndex = sampledIndices.at(-1)!;
  let component: { first: number; last: number } | undefined;
  if (suppliedSupport) {
    if (!Number.isFinite(suppliedSupport.startHz)
      || !Number.isFinite(suppliedSupport.stopHz)
      || suppliedSupport.stopHz <= suppliedSupport.startHz) {
      throw new Error('3 dB bandwidth support requires positive finite bounds');
    }
    const supportIndices = sampledIndices.filter((index) =>
      sweep.frequencyHz[index]! >= suppliedSupport.startHz
      && sweep.frequencyHz[index]! <= suppliedSupport.stopHz);
    if (supportIndices.includes(peakIndex)) {
      component = { first: supportIndices[0]!, last: supportIndices.at(-1)! };
    }
  } else {
    const floorDbm = robustLowerTailFloor(sweep.powerDbm);
    const floorSigmaDb = robustLowerTailSigma(sweep.powerDbm, floorDbm);
    const thresholdDbm = floorDbm + Math.max(
      MINIMUM_COMPONENT_PROMINENCE_DB,
      floorSigmaDb * ROBUST_SIGMA_PROMINENCE_MULTIPLIER,
    );
    const componentMask = sweep.powerDbm.map((powerDbm, index) =>
      index >= firstSampledIndex && index <= lastSampledIndex && powerDbm >= thresholdDbm);
    bridgeShortGaps(
      componentMask,
      sweep.frequencyHz,
      sweep.actualRbwHz,
      1,
    );
    component = connectedComponents(componentMask)
      .find((candidate) => peakIndex >= candidate.first && peakIndex <= candidate.last);
  }
  if (!component || component.last <= component.first) return undefined;

  const componentPowers = sweep.powerDbm.slice(component.first, component.last + 1);
  const referenceLevelDbm = quantile(componentPowers, ROBUST_UPPER_ENVELOPE_QUANTILE);
  const sampledPeakHalfPowerDbm = sweep.powerDbm[peakIndex]! - HALF_POWER_DECIBELS;
  const sampledPeakIslands = connectedComponents(sweep.powerDbm.map((powerDbm, index) =>
    index >= component.first && index <= component.last && powerDbm >= sampledPeakHalfPowerDbm));
  const sampledPeakIsAnOutlier = sweep.powerDbm[peakIndex]! - referenceLevelDbm > HALF_POWER_DECIBELS;
  if (sampledPeakIsAnOutlier && narrowPeakDominatesComponentPower(
    sweep,
    component,
    peakIndex,
    resolutionScaleHz,
  )) return undefined;
  if (sampledPeakIslands.length <= 1 && !sampledPeakIsAnOutlier) return undefined;

  const halfPowerLevelDbm = referenceLevelDbm - HALF_POWER_DECIBELS;
  const supportMask = sweep.powerDbm.map((powerDbm, index) =>
    index >= component!.first && index <= component!.last && powerDbm >= halfPowerLevelDbm);
  bridgeShortGaps(
    supportMask,
    sweep.frequencyHz,
    sweep.actualRbwHz,
    ROBUST_ENVELOPE_GAP_IN_RESOLUTION_ELEMENTS,
  );
  const islands = connectedComponents(supportMask);
  const peakIsland = islands.find((candidate) => peakIndex >= candidate.first && peakIndex <= candidate.last);
  if (!peakIsland) return undefined;
  const supportWidthHz = supportExtentHz(peakIsland, sweep.frequencyHz, binWidthHz);
  const allSupportFirst = islands[0]?.first;
  const allSupportLast = islands.at(-1)?.last;
  const allSupportWidthHz = allSupportFirst === undefined || allSupportLast === undefined
    ? 0
    : supportExtentHz({ first: allSupportFirst, last: allSupportLast }, sweep.frequencyHz, binWidthHz);
  const resolvedLimitHz = resolutionScaleHz * MINIMUM_RESOLVED_WIDTH_IN_RESOLUTION_ELEMENTS;
  const robustWidebandLimitHz = resolutionScaleHz * MINIMUM_ROBUST_WIDEBAND_WIDTH_IN_RESOLUTION_ELEMENTS;
  if (islands.length > 1 && allSupportWidthHz > resolvedLimitHz) {
    return { kind: 'ambiguous', referenceLevelDbm };
  }
  if (supportWidthHz > robustWidebandLimitHz) {
    return {
      kind: 'wideband',
      referenceLevelDbm,
      firstIndex: peakIsland.first,
      lastIndex: peakIsland.last,
    };
  }
  return undefined;
}

function narrowPeakDominatesComponentPower(
  sweep: SampledScalarResponse,
  component: { readonly first: number; readonly last: number },
  peakIndex: number,
  resolutionScaleHz: number,
): boolean {
  const floorDbm = robustLowerTailFloor(sweep.powerDbm);
  const floorMilliwatts = 10 ** (floorDbm / 10);
  const peakHz = sweep.frequencyHz[peakIndex]!;
  let componentPower = 0;
  let peakResolutionPower = 0;
  for (let index = component.first; index <= component.last; index++) {
    const signalMilliwatts = Math.max(0, 10 ** (sweep.powerDbm[index]! / 10) - floorMilliwatts);
    const cellWidthHz = sampleCellWidthHz(sweep.frequencyHz, index);
    const integratedPower = signalMilliwatts * cellWidthHz;
    componentPower += integratedPower;
    if (Math.abs(sweep.frequencyHz[index]! - peakHz) <= resolutionScaleHz / 2) {
      peakResolutionPower += integratedPower;
    }
  }
  return Number.isFinite(componentPower)
    && componentPower > 0
    && peakResolutionPower / componentPower >= NARROW_PEAK_DOMINANCE_FRACTION;
}

function sampleCellWidthHz(frequencies: readonly number[], index: number): number {
  const frequencyHz = frequencies[index]!;
  const leftEdgeHz = index === 0
    ? frequencyHz - (frequencies[1]! - frequencyHz) / 2
    : (frequencies[index - 1]! + frequencyHz) / 2;
  const rightEdgeHz = index === frequencies.length - 1
    ? frequencyHz + (frequencyHz - frequencies[index - 1]!) / 2
    : (frequencyHz + frequencies[index + 1]!) / 2;
  return rightEdgeHz - leftEdgeHz;
}

function supportExtentHz(
  support: { readonly first: number; readonly last: number },
  frequencies: readonly number[],
  nominalBinWidthHz: number,
): number {
  return frequencies[support.last]! - frequencies[support.first]! + nominalBinWidthHz;
}

function connectedComponents(mask: readonly boolean[]): Array<{ first: number; last: number }> {
  const components: Array<{ first: number; last: number }> = [];
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

function bridgeShortGaps(
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

function robustLowerTailFloor(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return median(ordered.slice(0, Math.max(1, Math.floor(ordered.length * 0.2))));
}

function robustLowerTailSigma(values: readonly number[], center: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const reference = ordered.slice(0, Math.max(3, Math.floor(ordered.length * 0.2)));
  return median(reference.map((value) => Math.abs(value - center))) * 1.4826;
}

function quantile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (index - lower);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function interpolateLevelCrossing(
  sweep: SampledScalarResponse,
  firstIndex: number,
  secondIndex: number,
  levelDbm: number,
): number {
  const firstPowerDbm = sweep.powerDbm[firstIndex]!;
  const secondPowerDbm = sweep.powerDbm[secondIndex]!;
  const powerDifferenceDb = secondPowerDbm - firstPowerDbm;
  if (powerDifferenceDb === 0) {
    if (firstPowerDbm === levelDbm) {
      return (sweep.frequencyHz[firstIndex]! + sweep.frequencyHz[secondIndex]!) / 2;
    }
    throw new Error('3 dB bandwidth crossing is indeterminate across a level plateau');
  }
  const fraction = Math.min(1, Math.max(0, (levelDbm - firstPowerDbm) / powerDifferenceDb));
  return sweep.frequencyHz[firstIndex]!
    + fraction * (sweep.frequencyHz[secondIndex]! - sweep.frequencyHz[firstIndex]!);
}

function nominalBinWidth(frequencies: readonly number[]): number {
  const differences = frequencies.slice(1).map((frequency, index) => frequency - frequencies[index]!);
  const sorted = [...differences].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function localGridResolutionHz(
  frequencies: readonly number[],
  windowStartHz: number,
  windowStopHz: number,
): number {
  let maximumSpacingHz = 0;
  for (let index = 1; index < frequencies.length; index++) {
    const leftHz = frequencies[index - 1]!;
    const rightHz = frequencies[index]!;
    if (rightHz < windowStartHz || leftHz > windowStopHz) continue;
    maximumSpacingHz = Math.max(maximumSpacingHz, rightHz - leftHz);
  }
  return maximumSpacingHz > 0 ? maximumSpacingHz : nominalBinWidth(frequencies);
}

function validateScalarSweep(sweep: Sweep): void {
  if (sweep.complete !== true) throw new Error('3 dB bandwidth requires a complete sweep');
  validateScalarResponse(sweep);
}

function validateScalarResponse(sweep: SampledScalarResponse): void {
  if (sweep.frequencyHz.length !== sweep.powerDbm.length || sweep.frequencyHz.length < 3) {
    throw new Error('3 dB bandwidth requires at least three paired frequency and power samples');
  }
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value))
    || sweep.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('3 dB bandwidth sweep contains non-finite samples');
  }
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || sweep.actualStopHz <= sweep.actualStartHz
    || !Number.isFinite(sweep.actualRbwHz)
    || sweep.actualRbwHz <= 0) {
    throw new Error('3 dB bandwidth requires finite increasing span bounds and a positive RBW');
  }
  for (let index = 1; index < sweep.frequencyHz.length; index++) {
    if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) {
      throw new Error('3 dB bandwidth requires strictly increasing sweep frequencies');
    }
  }
  const geometryToleranceHz = Math.max(
    sweep.actualRbwHz,
    (sweep.actualStopHz - sweep.actualStartHz) * 1e-9,
  );
  if (sweep.frequencyHz[0]! < sweep.actualStartHz - geometryToleranceHz
    || sweep.frequencyHz.at(-1)! > sweep.actualStopHz + geometryToleranceHz) {
    throw new Error('3 dB bandwidth frequency grid lies outside its actual span');
  }
}
