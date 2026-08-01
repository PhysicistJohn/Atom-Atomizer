import {
  channelMeasurementConfigurationSchema,
  type ChannelMeasurementConfiguration,
  type MarkerComponentOccupiedBandwidthMeasurement,
  type Sweep,
} from '@tinysa/contracts';
import {
  characterizeMarkerLocalTrace,
  selectMarkerCenterFromBinOnTrace,
} from './marker-characterization.js';

export type ChannelConfigurationFitUnavailableReason =
  | 'no-qualified-local-component'
  | 'insufficient-local-prominence'
  | 'component-edge-censored'
  | 'insufficient-adjacent-span';

export interface ChannelConfigurationFitEvidence {
  readonly sourceSweepId: string;
  readonly centerMethod: 'local-peak' | 'resolved-component-linear-power-centroid';
  readonly resolutionScaleHz: number;
  readonly componentStartHz: number;
  readonly componentStopHz: number;
  readonly componentOccupiedBandwidth: MarkerComponentOccupiedBandwidthMeasurement;
  readonly qualification: 'strongest-prominence-qualified-trace-component-not-channel-plan';
}

export interface FittedChannelConfiguration {
  readonly status: 'fitted';
  readonly configuration: ChannelMeasurementConfiguration;
  readonly evidence: ChannelConfigurationFitEvidence;
  readonly adjustments: {
    readonly adjacentChannelCountReduced: boolean;
    readonly adjacentBandwidthAdjusted: boolean;
    readonly channelSpacingAdjusted: boolean;
  };
}

export interface UnavailableChannelConfigurationFit {
  readonly status: 'unavailable';
  readonly reason: ChannelConfigurationFitUnavailableReason;
  readonly message: string;
  readonly sourceSweepId: string;
}

export type ChannelConfigurationFitResult =
  | FittedChannelConfiguration
  | UnavailableChannelConfigurationFit;

/**
 * Fits one stable channel-measurement layout to the strongest qualified
 * component in one complete scalar sweep. This is deliberately a one-shot
 * trace operation: it does not infer a protocol, channel plan, or emitter
 * identity, and persistent detector bounds do not control its geometry.
 */
export function fitChannelConfigurationToSweep(
  sweep: Sweep,
  input: ChannelMeasurementConfiguration,
): ChannelConfigurationFitResult {
  validateFitSweep(sweep);
  const current = channelMeasurementConfigurationSchema.parse(input);
  const resolutionScaleHz = Math.ceil(Math.max(
    sweep.actualRbwHz,
    nominalBinWidth(sweep.frequencyHz),
  ));
  const selection = selectStrongestProminenceQualifiedComponent(sweep);
  if (selection.status === 'unavailable') {
    return unavailable(
      sweep,
      selection.reason,
      selection.reason === 'no-qualified-local-component'
        ? 'No response clears the current sweep\'s robust prominence gate.'
        : 'No threshold component has enough local prominence for an automatic channel fit.',
    );
  }
  const { centerSelection, centerMethod, characterization } = selection;

  const edgeToleranceHz = Math.max(1e-6, resolutionScaleHz * 1e-12);
  if (characterization.componentStartHz - sweep.actualStartHz
      < resolutionScaleHz - edgeToleranceHz
    || sweep.actualStopHz - characterization.componentStopHz
      < resolutionScaleHz - edgeToleranceHz) {
    return unavailable(
      sweep,
      'component-edge-censored',
      'The strongest response reaches the sweep edge; widen or retune before fitting channel windows.',
    );
  }

  const centerHz = Math.round(centerSelection.markerCenterMethod === 'resolved-component-linear-power-centroid'
    ? centerSelection.powerCentroidHz
    : centerSelection.frequencyHz);
  const occupied = characterization.componentOccupiedBandwidth;
  const occupiedHalfExtentHz = Math.max(
    centerHz - occupied.startHz,
    occupied.stopHz - centerHz,
  );
  const mainBandwidthHz = 2 * Math.ceil(Math.max(
    resolutionScaleHz,
    occupiedHalfExtentHz + resolutionScaleHz,
  ));
  const availableHalfSpanHz = Math.min(
    centerHz - sweep.actualStartHz,
    sweep.actualStopHz - centerHz,
  ) - resolutionScaleHz;
  const minimumAdjacentBandwidthHz = resolutionScaleHz;
  const desiredAdjacentBandwidthHz = Math.min(
    Math.max(current.adjacentBandwidthHz, minimumAdjacentBandwidthHz),
    mainBandwidthHz,
  );

  for (let adjacentChannelCount = current.adjacentChannelCount;
    adjacentChannelCount >= 1;
    adjacentChannelCount--) {
    const maximumAdjacentBandwidthHz = Math.floor(
      (2 * availableHalfSpanHz - adjacentChannelCount * mainBandwidthHz)
      / (adjacentChannelCount + 1),
    );
    const adjacentBandwidthHz = Math.min(
      desiredAdjacentBandwidthHz,
      maximumAdjacentBandwidthHz,
    );
    if (adjacentBandwidthHz < minimumAdjacentBandwidthHz) continue;

    const minimumSpacingHz = Math.ceil((mainBandwidthHz + adjacentBandwidthHz) / 2);
    const maximumSpacingHz = Math.floor(
      (availableHalfSpanHz - adjacentBandwidthHz / 2) / adjacentChannelCount,
    );
    if (maximumSpacingHz < minimumSpacingHz) continue;
    const channelSpacingHz = Math.min(
      Math.max(current.channelSpacingHz, minimumSpacingHz),
      maximumSpacingHz,
    );
    const configuration = channelMeasurementConfigurationSchema.parse({
      ...current,
      centerHz,
      mainBandwidthHz,
      adjacentBandwidthHz,
      channelSpacingHz,
      adjacentChannelCount,
    });
    return {
      status: 'fitted',
      configuration,
      evidence: {
        sourceSweepId: sweep.id,
        centerMethod,
        resolutionScaleHz,
        componentStartHz: characterization.componentStartHz,
        componentStopHz: characterization.componentStopHz,
        componentOccupiedBandwidth: occupied,
        qualification: 'strongest-prominence-qualified-trace-component-not-channel-plan',
      },
      adjustments: {
        adjacentChannelCountReduced:
          adjacentChannelCount !== current.adjacentChannelCount,
        adjacentBandwidthAdjusted:
          adjacentBandwidthHz !== current.adjacentBandwidthHz,
        channelSpacingAdjusted: channelSpacingHz !== current.channelSpacingHz,
      },
    };
  }

  return unavailable(
    sweep,
    'insufficient-adjacent-span',
    'The current sweep does not contain one resolution-wide comparison band on both sides; widen or retune before fitting.',
  );
}

function selectStrongestProminenceQualifiedComponent(sweep: Sweep): {
  readonly status: 'selected';
  readonly centerSelection: ReturnType<typeof selectMarkerCenterFromBinOnTrace>;
  readonly centerMethod: ChannelConfigurationFitEvidence['centerMethod'];
  readonly characterization: ReturnType<typeof characterizeMarkerLocalTrace> & {
    readonly componentStartHz: number;
    readonly componentStopHz: number;
    readonly componentOccupiedBandwidth: MarkerComponentOccupiedBandwidthMeasurement;
  };
} | {
  readonly status: 'unavailable';
  readonly reason: 'no-qualified-local-component' | 'insufficient-local-prominence';
} {
  const rankedPeakBins = localPeakBins(sweep.powerDbm)
    .sort((left, right) => sweep.powerDbm[right]! - sweep.powerDbm[left]! || left - right);
  const visitedComponents = new Set<string>();
  let sawInsufficientLocalProminence = false;

  for (const binIndex of rankedPeakBins) {
    const centerSelection = selectMarkerCenterFromBinOnTrace(
      sweep,
      binIndex,
      sweep.actualRbwHz,
    );
    const centerMethod = centerSelection.markerCenterMethod
      === 'resolved-component-linear-power-centroid'
      ? centerSelection.markerCenterMethod
      : 'local-peak';
    const centerEvidence = centerSelection.markerCenterMethod === 'resolved-component-linear-power-centroid'
      ? {
        markerCenterMethod: centerSelection.markerCenterMethod,
        powerCentroidHz: centerSelection.powerCentroidHz,
      } as const
      : { markerCenterMethod: 'local-peak' as const };
    const characterization = characterizeMarkerLocalTrace(
      sweep,
      centerSelection.binIndex,
      sweep.actualRbwHz,
      [],
      centerEvidence,
    );
    const componentKey = 'componentStartHz' in characterization
      ? `${characterization.componentStartHz}:${characterization.componentStopHz}`
      : undefined;
    if (componentKey && visitedComponents.has(componentKey)) continue;
    if (componentKey) visitedComponents.add(componentKey);

    if ('componentOccupiedBandwidth' in characterization) {
      return {
        status: 'selected',
        centerSelection,
        centerMethod,
        characterization,
      };
    }
    if (characterization.unavailableReason === 'insufficient-local-prominence') {
      sawInsufficientLocalProminence = true;
    }
  }

  return {
    status: 'unavailable',
    reason: sawInsufficientLocalProminence
      ? 'insufficient-local-prominence'
      : 'no-qualified-local-component',
  };
}

function localPeakBins(powerDbm: readonly number[]): number[] {
  const peaks: number[] = [];
  for (let index = 0; index < powerDbm.length; index++) {
    const left = index === 0 ? Number.NEGATIVE_INFINITY : powerDbm[index - 1]!;
    const right = index === powerDbm.length - 1 ? Number.NEGATIVE_INFINITY : powerDbm[index + 1]!;
    if (powerDbm[index]! > left && powerDbm[index]! >= right) peaks.push(index);
  }
  return peaks;
}

function unavailable(
  sweep: Sweep,
  reason: ChannelConfigurationFitUnavailableReason,
  message: string,
): UnavailableChannelConfigurationFit {
  return { status: 'unavailable', reason, message, sourceSweepId: sweep.id };
}

function nominalBinWidth(frequencies: readonly number[]): number {
  const differences = frequencies.slice(1).map((frequency, index) =>
    frequency - frequencies[index]!);
  const sorted = [...differences].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function validateFitSweep(sweep: Sweep): void {
  if (sweep.complete !== true) throw new Error('Channel fit requires a complete sweep');
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) {
    throw new Error('Channel fit requires equal frequency and power arrays');
  }
  if (sweep.frequencyHz.length < 3) {
    throw new Error('Channel fit requires at least three sweep points');
  }
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value))
    || sweep.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Channel fit requires finite sweep values');
  }
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || sweep.actualStopHz <= sweep.actualStartHz) {
    throw new Error('Channel fit requires finite increasing actual frequency bounds');
  }
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) {
    throw new Error('Channel fit requires a finite positive analysis resolution scale');
  }
  for (let index = 1; index < sweep.frequencyHz.length; index++) {
    if (sweep.frequencyHz[index]! <= sweep.frequencyHz[index - 1]!) {
      throw new Error('Channel fit requires strictly increasing sweep frequencies');
    }
  }
  const geometryToleranceHz = Math.max(
    sweep.actualRbwHz,
    (sweep.actualStopHz - sweep.actualStartHz) * 1e-9,
  );
  if (sweep.frequencyHz[0]! < sweep.actualStartHz - geometryToleranceHz
    || sweep.frequencyHz.at(-1)! > sweep.actualStopHz + geometryToleranceHz) {
    throw new Error('Channel fit frequency grid lies outside its actual bounds');
  }
}
