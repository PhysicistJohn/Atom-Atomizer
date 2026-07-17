import type {
  DetectedSignal,
  MarkerCenterSelection,
  MarkerComponentOccupiedBandwidthMeasurement,
  MarkerLocalCharacterization,
  MarkerPhysicalDetectionContext,
  TraceFrame,
} from '@tinysa/contracts';
import { measureTraceThreeDecibelBandwidth } from './channel-bandwidth.js';

// Ten dB matches the default local detector margin and remains an engineering
// candidate gate, not a calibrated probability of false alarm.
const MINIMUM_LOCAL_PROMINENCE_DB = 10;
const ROBUST_SIGMA_PROMINENCE_MULTIPLIER = 4;

interface ComponentIndices {
  readonly first: number;
  readonly last: number;
}

/**
 * Characterize the threshold-connected scalar response containing, or nearest
 * to, a marker. The complete assigned host trace is the primary evidence.
 * Current candidate/active detector rows are attached only as bounded context.
 */
export function characterizeMarkerLocalTrace(
  frame: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  markerBinIndex: number,
  actualRbwHz: number,
  detections: readonly DetectedSignal[] = [],
  centerSelection: MarkerCenterSelection = { markerCenterMethod: 'fixed-frequency' },
): MarkerLocalCharacterization {
  validateInput(frame, markerBinIndex, actualRbwHz);
  const binWidthHz = nominalBinWidth(frame.frequencyHz);
  const resolutionScaleHz = Math.max(actualRbwHz, binWidthHz);
  const robustFloorDbm = robustLowerTailFloor(frame.powerDbm);
  const robustSigmaDb = robustLowerTailSigma(frame.powerDbm, robustFloorDbm);
  const requiredProminenceDb = Math.max(
    MINIMUM_LOCAL_PROMINENCE_DB,
    robustSigmaDb * ROBUST_SIGMA_PROMINENCE_MULTIPLIER,
  );
  const componentThresholdDbm = robustFloorDbm + requiredProminenceDb;
  const aboveThreshold = frame.powerDbm.map((powerDbm) => powerDbm >= componentThresholdDbm);
  bridgeShortGaps(aboveThreshold, frame.frequencyHz, actualRbwHz, 1);
  const components = connectedComponents(aboveThreshold);
  const component = selectComponent(components, markerBinIndex, frame.frequencyHz);

  if (!component) {
    const localPeakHz = frame.frequencyHz[markerBinIndex]!;
    const localPeakDbm = frame.powerDbm[markerBinIndex]!;
    return {
      widthClassification: 'unavailable',
      componentRelationship: 'no-qualified-component',
      ...centerSelection,
      markerFrequencyHz: localPeakHz,
      localPeakHz,
      localPeakDbm,
      componentThresholdDbm,
      robustFloorDbm,
      peakToRobustFloorDb: localPeakDbm - robustFloorDbm,
      prominenceDb: localPeakDbm - robustFloorDbm,
      requiredProminenceDb,
      unavailableReason: 'no-qualified-local-component',
      ...physicalDetectionContext(localPeakHz, detections, resolutionScaleHz),
      evidence: 'host-derived-local-scalar-trace',
      qualification: 'observed-response-not-deconvolved-or-calibrated-snr',
    };
  }

  const peakIndex = maximumIndex(frame.powerDbm, component.first, component.last);
  const localPeakHz = frame.frequencyHz[peakIndex]!;
  const localPeakDbm = frame.powerDbm[peakIndex]!;
  const physicalContext = physicalDetectionContext(localPeakHz, detections, resolutionScaleHz);
  const shoulderLevelDbm = localShoulderLevel(frame.powerDbm, component, robustFloorDbm, resolutionScaleHz, binWidthHz);
  const prominenceDb = localPeakDbm - shoulderLevelDbm;
  if (prominenceDb < requiredProminenceDb) {
    return {
      widthClassification: 'unavailable',
      ...centerSelection,
      componentRelationship: markerBinIndex >= component.first && markerBinIndex <= component.last
        ? 'contains-marker-bin'
        : 'nearest-threshold-component',
      componentDistanceHz: componentDistanceHz(component, frame.frequencyHz[markerBinIndex]!, frame.frequencyHz),
      markerFrequencyHz: frame.frequencyHz[markerBinIndex]!,
      localPeakHz,
      localPeakDbm,
      componentStartHz: frame.frequencyHz[component.first]!,
      componentStopHz: frame.frequencyHz[component.last]!,
      componentThresholdDbm,
      robustFloorDbm,
      peakToRobustFloorDb: localPeakDbm - robustFloorDbm,
      prominenceDb,
      requiredProminenceDb,
      unavailableReason: 'insufficient-local-prominence',
      ...physicalContext,
      evidence: 'host-derived-local-scalar-trace',
      qualification: 'observed-response-not-deconvolved-or-calibrated-snr',
    };
  }
  // Detector rows are descriptive context only. They must never enlarge the
  // trace-local support: a stale or over-wide detector row cannot turn a CW
  // receiver response into a full-span 3 dB bandwidth.
  const firstSupportIndex = component.first;
  const lastSupportIndex = component.last;
  const componentIndex = components.findIndex((candidate) =>
    candidate.first === component.first && candidate.last === component.last);
  const previousComponent = componentIndex > 0 ? components[componentIndex - 1] : undefined;
  const nextComponent = componentIndex >= 0 ? components[componentIndex + 1] : undefined;
  // A threshold component begins at floor + the admission margin, which can
  // be above the half-power level for a low-SNR response. Give the crossing
  // search the complete basin between neighboring qualified components rather
  // than only one extra sample. Crossing-outside-window still fails closed if
  // a half-power edge would have to pass through another admitted component.
  const firstWindowIndex = previousComponent ? previousComponent.last + 1 : 0;
  const lastWindowIndex = nextComponent ? nextComponent.first - 1 : frame.frequencyHz.length - 1;
  const support = lastSupportIndex > firstSupportIndex
    ? {
      startHz: frame.frequencyHz[firstSupportIndex]!,
      stopHz: frame.frequencyHz[lastSupportIndex]!,
    }
    : undefined;
  const threeDecibelBandwidth = measureTraceThreeDecibelBandwidth(
    frame,
    actualRbwHz,
    frame.frequencyHz[firstWindowIndex]!,
    frame.frequencyHz[lastWindowIndex]!,
    support,
  );
  const componentOccupiedBandwidth = measureComponentOccupiedBandwidth(
    frame,
    frame.frequencyHz[firstSupportIndex]!,
    frame.frequencyHz[lastSupportIndex]!,
    robustFloorDbm,
    actualRbwHz,
  );
  const common = {
    ...centerSelection,
    componentRelationship: markerBinIndex >= component.first && markerBinIndex <= component.last
      ? 'contains-marker-bin' as const
      : 'nearest-threshold-component' as const,
    componentDistanceHz: componentDistanceHz(component, frame.frequencyHz[markerBinIndex]!, frame.frequencyHz),
    markerFrequencyHz: frame.frequencyHz[markerBinIndex]!,
    localPeakHz,
    localPeakDbm,
    componentStartHz: frame.frequencyHz[component.first]!,
    componentStopHz: frame.frequencyHz[component.last]!,
    componentThresholdDbm,
    robustFloorDbm,
    peakToRobustFloorDb: localPeakDbm - robustFloorDbm,
    prominenceDb,
    requiredProminenceDb,
    componentOccupiedBandwidth,
    ...physicalContext,
    evidence: 'host-derived-local-scalar-trace' as const,
    qualification: 'observed-response-not-deconvolved-or-calibrated-snr' as const,
  };
  if (threeDecibelBandwidth.status === 'unavailable') {
    return { ...common, widthClassification: 'unavailable', threeDecibelBandwidth };
  }
  if (threeDecibelBandwidth.status === 'resolution-limited') {
    return { ...common, widthClassification: 'resolution-limited-narrow', threeDecibelBandwidth };
  }
  return { ...common, widthClassification: 'resolved-wideband', threeDecibelBandwidth };
}

export type MarkerCenterBinSelection = MarkerCenterSelection & {
  readonly binIndex: number;
  readonly frequencyHz: number;
};

/**
 * Peak tracking remains a true sampled peak for a narrow, censored, or
 * unqualified response. Once one bounded broad threshold component is
 * demonstrably resolved (even when its 3 dB islands are nonmonotone), it tracks the bounded,
 * noise-subtracted linear-power centroid instead of an instantaneous ripple
 * or subcarrier maximum. This is continuous in the observed scalar powers.
 */
export function selectMarkerCenterOnTrace(
  frame: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  actualRbwHz: number,
  detections: readonly DetectedSignal[] = [],
): MarkerCenterBinSelection {
  validateInput(frame, 0, actualRbwHz);
  const peakIndex = maximumIndex(frame.powerDbm, 0, frame.powerDbm.length - 1);
  const peakSelection = { markerCenterMethod: 'local-peak' as const };
  const preliminary = characterizeMarkerLocalTrace(
    frame,
    peakIndex,
    actualRbwHz,
    detections,
    peakSelection,
  );
  const threeDecibelBandwidth = 'threeDecibelBandwidth' in preliminary
    ? preliminary.threeDecibelBandwidth
    : undefined;
  const componentIsBounded = preliminary.componentRelationship !== 'no-qualified-component'
    && preliminary.componentStartHz > frame.frequencyHz[0]!
    && preliminary.componentStopHz < frame.frequencyHz.at(-1)!;
  const componentExtentHz = preliminary.componentRelationship === 'no-qualified-component'
    ? 0
    : componentCellExtentHz(
      frame.frequencyHz,
      preliminary.componentStartHz,
      preliminary.componentStopHz,
    );
  const resolutionScaleHz = threeDecibelBandwidth?.resolutionScaleHz
    ?? Math.max(actualRbwHz, nominalBinWidth(frame.frequencyHz));
  const hasCentroidQualifiedShape = threeDecibelBandwidth?.status === 'resolved'
    || (threeDecibelBandwidth?.status === 'unavailable'
      && threeDecibelBandwidth.reason === 'nonmonotone-half-power-response');
  if (!componentIsBounded
    || !hasCentroidQualifiedShape
    || componentExtentHz <= 2 * resolutionScaleHz) {
    return {
      ...peakSelection,
      binIndex: peakIndex,
      frequencyHz: frame.frequencyHz[peakIndex]!,
    };
  }
  if (!threeDecibelBandwidth || !('referenceLevelDbm' in threeDecibelBandwidth)) {
    throw new Error('Qualified wide marker component is missing its robust reference level');
  }

  // Detector rows remain annotation-only here as well as in the width path.
  // Center must be invariant to stale, under-wide, or over-wide tracker bounds.
  // A bounded threshold-connected response can still have several resolved
  // half-power islands (for example a multi-RU OFDM allocation). In that case
  // the contiguous 3 dB width correctly remains unavailable, but the complete
  // above-floor component still supports a trace-local integrated-power center.
  // Floor-separated components are never merged by this path.
  const startHz = preliminary.componentStartHz;
  const stopHz = preliminary.componentStopHz;
  const powerCentroidHz = noiseSubtractedPowerCentroid(
    frame,
    startHz,
    stopHz,
    preliminary.robustFloorDbm,
    threeDecibelBandwidth.referenceLevelDbm,
  );
  const binIndex = nearestFrequencyIndex(frame.frequencyHz, powerCentroidHz);
  return {
    markerCenterMethod: 'resolved-component-linear-power-centroid',
    powerCentroidHz,
    binIndex,
    frequencyHz: frame.frequencyHz[binIndex]!,
  };
}

function noiseSubtractedPowerCentroid(
  frame: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  startHz: number,
  stopHz: number,
  floorDbm: number,
  referenceDbm: number,
): number {
  let weightedFrequency = 0;
  let integratedWeight = 0;
  for (const cell of componentPowerCells(frame, startHz, stopHz, floorDbm, referenceDbm)) {
    const weight = cell.relativePower * (cell.stopHz - cell.startHz);
    weightedFrequency += cell.centerHz * weight;
    integratedWeight += weight;
  }
  if (!Number.isFinite(integratedWeight) || integratedWeight <= 0 || !Number.isFinite(weightedFrequency)) {
    throw new Error('Resolved marker component has no finite linear power for centroid placement');
  }
  return Math.min(stopHz, Math.max(startHz, weightedFrequency / integratedWeight));
}

function measureComponentOccupiedBandwidth(
  frame: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  componentStartHz: number,
  componentStopHz: number,
  floorDbm: number,
  actualRbwHz: number,
): MarkerComponentOccupiedBandwidthMeasurement {
  const cells = componentPowerCells(frame, componentStartHz, componentStopHz, floorDbm, 0)
    .map((cell) => ({
      ...cell,
      milliwatts: cell.absolutePowerMilliwatts * (cell.stopHz - cell.startHz) / actualRbwHz,
    }));
  const totalMilliwatts = cells.reduce((sum, cell) => sum + cell.milliwatts, 0);
  if (!Number.isFinite(totalMilliwatts) || totalMilliwatts <= 0) {
    throw new Error('Qualified marker component has no finite power for occupied bandwidth');
  }
  const lowerTarget = totalMilliwatts * 0.005;
  const upperTarget = totalMilliwatts * 0.995;
  const startHz = componentCumulativeBoundary(cells, lowerTarget);
  const stopHz = componentCumulativeBoundary(cells, upperTarget);
  return {
    percent: 99,
    startHz,
    stopHz,
    bandwidthHz: Math.max(0, stopHz - startHz),
    occupiedPowerDbm: 10 * Math.log10(totalMilliwatts * 0.99),
    noiseCorrection: 'robust-floor',
  };
}

interface ComponentPowerCell {
  readonly centerHz: number;
  readonly startHz: number;
  readonly stopHz: number;
  readonly relativePower: number;
  readonly absolutePowerMilliwatts: number;
}

function componentPowerCells(
  frame: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  componentStartHz: number,
  componentStopHz: number,
  floorDbm: number,
  referenceDbm: number,
): readonly ComponentPowerCell[] {
  const firstIndex = nearestFrequencyIndex(frame.frequencyHz, componentStartHz);
  const lastIndex = nearestFrequencyIndex(frame.frequencyHz, componentStopHz);
  if (frame.frequencyHz[firstIndex] !== componentStartHz
    || frame.frequencyHz[lastIndex] !== componentStopHz
    || lastIndex < firstIndex) {
    throw new Error('Marker component power geometry must use observed trace bounds');
  }
  const floorRelative = 10 ** ((floorDbm - referenceDbm) / 10);
  const floorMilliwatts = 10 ** (floorDbm / 10);
  const cells: ComponentPowerCell[] = [];
  for (let index = firstIndex; index <= lastIndex; index++) {
    const centerHz = frame.frequencyHz[index]!;
    const startHz = index === 0
      ? centerHz
      : (frame.frequencyHz[index - 1]! + centerHz) / 2;
    const stopHz = index === frame.frequencyHz.length - 1
      ? centerHz
      : (centerHz + frame.frequencyHz[index + 1]!) / 2;
    if (stopHz <= startHz) continue;
    cells.push({
      centerHz,
      startHz,
      stopHz,
      relativePower: Math.max(0, 10 ** ((frame.powerDbm[index]! - referenceDbm) / 10) - floorRelative),
      absolutePowerMilliwatts: Math.max(0, 10 ** (frame.powerDbm[index]! / 10) - floorMilliwatts),
    });
  }
  return cells;
}

function componentCumulativeBoundary(
  cells: readonly (ComponentPowerCell & { readonly milliwatts: number })[],
  targetMilliwatts: number,
): number {
  let cumulative = 0;
  for (const cell of cells) {
    const next = cumulative + cell.milliwatts;
    if (targetMilliwatts <= next && cell.milliwatts > 0) {
      const fraction = Math.min(1, Math.max(0, (targetMilliwatts - cumulative) / cell.milliwatts));
      return cell.startHz + fraction * (cell.stopHz - cell.startHz);
    }
    cumulative = next;
  }
  return cells.at(-1)?.stopHz ?? Number.NaN;
}

function nearestFrequencyIndex(frequencies: readonly number[], targetHz: number): number {
  let best = 0;
  for (let index = 1; index < frequencies.length; index++) {
    if (Math.abs(frequencies[index]! - targetHz) < Math.abs(frequencies[best]! - targetHz)) best = index;
  }
  return best;
}

function physicalDetectionContext(
  localPeakHz: number,
  detections: readonly DetectedSignal[],
  resolutionScaleHz: number,
): { physicalDetection?: MarkerPhysicalDetectionContext } {
  const current = detections.filter((detection) =>
    (detection.state === 'candidate' || detection.state === 'active')
    && detection.missedSweeps === 0
    && detection.associationMode !== 'frequency-agile-2g4-activity');
  const ranked = current.map((detection) => {
    const toleranceHz = resolutionScaleHz / 2;
    const contains = localPeakHz >= detection.startHz - toleranceHz
      && localPeakHz <= detection.stopHz + toleranceHz;
    const distanceHz = contains
      ? 0
      : localPeakHz < detection.startHz
        ? detection.startHz - localPeakHz
        : localPeakHz - detection.stopHz;
    return { detection, contains, distanceHz };
  }).sort((left, right) =>
    Number(right.contains) - Number(left.contains)
    || left.distanceHz - right.distanceHz
    || Math.abs(left.detection.peakHz - localPeakHz) - Math.abs(right.detection.peakHz - localPeakHz)
    || Number(right.detection.state === 'active') - Number(left.detection.state === 'active')
    || left.detection.id.localeCompare(right.detection.id));
  const selected = ranked[0];
  if (!selected) return {};
  return {
    physicalDetection: {
      detectionId: selected.detection.id,
      detectionState: selected.detection.state as 'candidate' | 'active',
      relationship: selected.contains ? 'contains-local-peak' : 'nearest-current-detection',
      distanceHz: selected.distanceHz,
      startHz: selected.detection.startHz,
      stopHz: selected.detection.stopHz,
      peakHz: selected.detection.peakHz,
      peakDbm: selected.detection.peakDbm,
      prominenceDb: selected.detection.prominenceDb,
    },
  };
}

function selectComponent(
  components: readonly ComponentIndices[],
  markerBinIndex: number,
  frequencyHz: readonly number[],
): ComponentIndices | undefined {
  const containing = components.find((component) => markerBinIndex >= component.first && markerBinIndex <= component.last);
  if (containing) return containing;
  const markerFrequencyHz = frequencyHz[markerBinIndex]!;
  return [...components].sort((left, right) =>
    componentDistanceHz(left, markerFrequencyHz, frequencyHz) - componentDistanceHz(right, markerFrequencyHz, frequencyHz)
    || left.first - right.first)[0];
}

function componentDistanceHz(
  component: ComponentIndices,
  markerFrequencyHz: number,
  frequencyHz: readonly number[],
): number {
  if (markerFrequencyHz < frequencyHz[component.first]!) return frequencyHz[component.first]! - markerFrequencyHz;
  if (markerFrequencyHz > frequencyHz[component.last]!) return markerFrequencyHz - frequencyHz[component.last]!;
  return 0;
}

function connectedComponents(mask: readonly boolean[]): ComponentIndices[] {
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

function componentCellExtentHz(
  frequencies: readonly number[],
  componentStartHz: number,
  componentStopHz: number,
): number {
  const firstIndex = nearestFrequencyIndex(frequencies, componentStartHz);
  const lastIndex = nearestFrequencyIndex(frequencies, componentStopHz);
  const startHz = firstIndex === 0
    ? frequencies[firstIndex]!
    : (frequencies[firstIndex - 1]! + frequencies[firstIndex]!) / 2;
  const stopHz = lastIndex === frequencies.length - 1
    ? frequencies[lastIndex]!
    : (frequencies[lastIndex]! + frequencies[lastIndex + 1]!) / 2;
  return stopHz - startHz;
}

function localShoulderLevel(
  powerDbm: readonly number[],
  component: ComponentIndices,
  robustFloorDbm: number,
  resolutionScaleHz: number,
  binWidthHz: number,
): number {
  const shoulderBins = Math.max(3, Math.ceil(3 * resolutionScaleHz / binWidthHz));
  const shoulders = [
    ...powerDbm.slice(Math.max(0, component.first - shoulderBins), component.first),
    ...powerDbm.slice(component.last + 1, Math.min(powerDbm.length, component.last + 1 + shoulderBins)),
  ];
  return shoulders.length ? Math.max(robustFloorDbm, median(shoulders)) : robustFloorDbm;
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

function maximumIndex(values: readonly number[], first: number, last: number): number {
  let best = first;
  for (let index = first + 1; index <= last; index++) if (values[index]! > values[best]!) best = index;
  return best;
}

function nominalBinWidth(frequencies: readonly number[]): number {
  return median(frequencies.slice(1).map((frequency, index) => frequency - frequencies[index]!));
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function validateInput(
  frame: Pick<TraceFrame, 'frequencyHz' | 'powerDbm'>,
  markerBinIndex: number,
  actualRbwHz: number,
): void {
  if (frame.frequencyHz.length !== frame.powerDbm.length || frame.frequencyHz.length < 3) {
    throw new Error('Marker characterization requires at least three paired trace samples');
  }
  if (!Number.isInteger(markerBinIndex) || markerBinIndex < 0 || markerBinIndex >= frame.frequencyHz.length) {
    throw new Error('Marker characterization requires an in-range marker bin');
  }
  if (!Number.isFinite(actualRbwHz) || actualRbwHz <= 0) {
    throw new Error('Marker characterization requires a positive finite RBW');
  }
  if (frame.frequencyHz.some((value) => !Number.isFinite(value))
    || frame.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Marker characterization rejects non-finite trace samples');
  }
  for (let index = 1; index < frame.frequencyHz.length; index++) {
    if (frame.frequencyHz[index]! <= frame.frequencyHz[index - 1]!) {
      throw new Error('Marker characterization requires strictly increasing trace frequencies');
    }
  }
}
