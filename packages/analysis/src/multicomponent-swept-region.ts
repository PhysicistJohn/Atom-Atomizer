import type {
  BayesianDetectionEvidence,
  MulticomponentSweptRegionAssociationObservation,
  Sweep,
} from '@tinysa/contracts';
import { measurementIdentityKey } from './measurement-provenance.js';

export const MULTICOMPONENT_SWEPT_REGION_MODEL_ID = 'multicomponent-swept-region-v2' as const;
export const MULTICOMPONENT_LOCAL_DETECTOR_MODEL_ID = 'bayesian-exponential-multiscale-cfar-v3' as const;
export const MULTICOMPONENT_REGION_MINIMUM_PADDED_IOU = 0.75;

export interface MulticomponentSweptRegionCandidate {
  readonly startHz: number;
  readonly stopHz: number;
  readonly peakHz: number;
  readonly bandwidthHz: number;
  readonly detectorId: string;
  readonly bayesianEvidence: BayesianDetectionEvidence;
  readonly classificationRegionStartHz?: number;
  readonly classificationRegionStopHz?: number;
}

export interface MulticomponentSweptRegionAssociation {
  readonly candidateIndices: readonly number[];
  readonly startHz: number;
  readonly stopHz: number;
  readonly containmentToleranceHz: number;
  readonly qualification: MulticomponentSweptRegionAssociationObservation['qualification'];
  readonly anchorCandidateIndex?: number;
}

interface SweepGeometry {
  readonly actualStartHz: number;
  readonly actualStopHz: number;
  readonly actualRbwHz: number;
  readonly binWidthHz: number;
}

export interface MulticomponentSweptRegionLineageShape {
  readonly geometryId: string;
  readonly startHz: number;
  readonly stopHz: number;
  readonly rbwHz: number;
  readonly binWidthHz: number;
  readonly memberCentersHz: readonly number[];
}

export function multicomponentSweptRegionAssociations(
  candidates: readonly MulticomponentSweptRegionCandidate[],
  sweep: Sweep,
): readonly MulticomponentSweptRegionAssociation[] {
  return multicomponentSweptRegionAssociationsForGeometry(candidates, {
    actualStartHz: sweep.actualStartHz,
    actualStopHz: sweep.actualStopHz,
    actualRbwHz: sweep.actualRbwHz,
    binWidthHz: multicomponentSweepBinWidthHz(sweep),
  });
}

export function multicomponentSweptRegionAssociationsForGeometry(
  candidates: readonly MulticomponentSweptRegionCandidate[],
  geometry: SweepGeometry,
): readonly MulticomponentSweptRegionAssociation[] {
  // Four independently admitted components are required so a three-line
  // AM-equivalent morphology cannot become a wide regional hypothesis.
  if (candidates.length < 4) return [];
  const ordered = candidates.map((candidate, candidateIndex) => ({
    candidate,
    candidateIndex,
    centerHz: (candidate.startHz + candidate.stopHz) / 2,
  })).sort((left, right) => left.centerHz - right.centerHz);
  const gapsHz = ordered.slice(1).map((item, index) => item.centerHz - ordered[index]!.centerHz);
  const spacingHz = median(gapsHz);
  const sweepSpanHz = geometry.actualStopHz - geometry.actualStartHz;
  const minimumSpacingHz = Math.max(500_000, geometry.binWidthHz * 6, geometry.actualRbwHz * 3);
  const maximumSpacingHz = Math.min(20_000_000, sweepSpanHz * 0.25);
  if (!Number.isFinite(spacingHz) || spacingHz < minimumSpacingHz || spacingHz > maximumSpacingHz) return [];
  if (ordered.some(({ candidate }) => candidate.bandwidthHz
    > Math.max(geometry.actualRbwHz * 4, spacingHz * 0.76))) return [];

  const observedStartHz = ordered[0]!.candidate.startHz;
  const observedStopHz = ordered.at(-1)!.candidate.stopHz;
  const containmentToleranceHz = Math.max(geometry.binWidthHz * 1.1, geometry.actualRbwHz * 1.1);
  const containingAnchors = ordered.filter(({ candidate }) =>
    candidate.classificationRegionStartHz !== undefined
    && candidate.classificationRegionStopHz !== undefined
    && candidate.classificationRegionStartHz <= observedStartHz + containmentToleranceHz
    && candidate.classificationRegionStopHz >= observedStopHz - containmentToleranceHz)
    .sort((left, right) => {
      const leftWidth = left.candidate.classificationRegionStopHz! - left.candidate.classificationRegionStartHz!;
      const rightWidth = right.candidate.classificationRegionStopHz! - right.candidate.classificationRegionStartHz!;
      return leftWidth - rightWidth
        || left.candidate.bayesianEvidence.posteriorPredictiveNullProbability
          - right.candidate.bayesianEvidence.posteriorPredictiveNullProbability
        || left.candidateIndex - right.candidateIndex;
    });
  if (containingAnchors.length > 0) {
    return [{
      candidateIndices: ordered.map((item) => item.candidateIndex).sort((left, right) => left - right),
      startHz: observedStartHz,
      stopHz: observedStopHz,
      containmentToleranceHz,
      qualification: 'selected-multiscale-region-containment-not-emitter-identity',
      anchorCandidateIndex: containingAnchors[0]!.candidateIndex,
    }];
  }

  const spacingToleranceHz = Math.max(
    geometry.binWidthHz * 3.1,
    geometry.actualRbwHz * 1.5,
    spacingHz * 0.08,
  );
  let admittedEdgeExceptionCount = 0;
  if (gapsHz.some((gapHz, index) => {
    const rasterSteps = Math.round(gapHz / spacingHz);
    if (rasterSteps >= 1 && rasterSteps <= 3
      && Math.abs(gapHz - rasterSteps * spacingHz) <= spacingToleranceHz) return false;
    const edgeCandidate = index === 0 ? ordered[0]!.candidate
      : index === gapsHz.length - 1 ? ordered.at(-1)!.candidate
        : undefined;
    const rejected = !edgeCandidate
      || edgeCandidate.bandwidthHz > spacingHz * 0.3
      || gapHz < spacingHz * 0.5
      || gapHz > spacingHz * 1.5;
    if (!rejected) admittedEdgeExceptionCount++;
    return rejected;
  })) return [];
  if (admittedEdgeExceptionCount > 1) return [];
  const regionSpanHz = observedStopHz - observedStartHz;
  if (regionSpanHz < spacingHz * (ordered.length - 1) * 0.8 || regionSpanHz > sweepSpanHz * 0.9) return [];
  return [{
    candidateIndices: ordered.map((item) => item.candidateIndex).sort((left, right) => left - right),
    startHz: observedStartHz,
    stopHz: observedStopHz,
    containmentToleranceHz,
    qualification: 'resolved-component-raster-not-emitter-identity',
  }];
}

export function multicomponentAssociationRegionsOverlap(
  leftStartHz: number,
  leftStopHz: number,
  rightStartHz: number,
  rightStopHz: number,
  rbwHz: number,
  binWidthHz: number,
): boolean {
  if (![leftStartHz, leftStopHz, rightStartHz, rightStopHz, rbwHz, binWidthHz].every(Number.isFinite)
    || leftStopHz <= leftStartHz
    || rightStopHz <= rightStartHz
    || rbwHz <= 0
    || binWidthHz <= 0) return false;
  const paddingHz = Math.max(rbwHz * 2, binWidthHz * 5);
  const paddedLeftStartHz = leftStartHz - paddingHz;
  const paddedLeftStopHz = leftStopHz + paddingHz;
  const paddedRightStartHz = rightStartHz - paddingHz;
  const paddedRightStopHz = rightStopHz + paddingHz;
  const intersectionHz = Math.max(
    0,
    Math.min(paddedLeftStopHz, paddedRightStopHz) - Math.max(paddedLeftStartHz, paddedRightStartHz),
  );
  const unionHz = Math.max(paddedLeftStopHz, paddedRightStopHz)
    - Math.min(paddedLeftStartHz, paddedRightStartHz);
  return intersectionHz / unionHz >= MULTICOMPONENT_REGION_MINIMUM_PADDED_IOU;
}

export function multicomponentSweptRegionLineagesAreCompatible(
  left: MulticomponentSweptRegionLineageShape,
  right: MulticomponentSweptRegionLineageShape,
): boolean {
  if (!left.geometryId
    || left.geometryId !== right.geometryId
    || left.rbwHz !== right.rbwHz
    || left.binWidthHz !== right.binWidthHz
    || !left.memberCentersHz.length
    || !right.memberCentersHz.length
    || !left.memberCentersHz.every(Number.isFinite)
    || !right.memberCentersHz.every(Number.isFinite)) return false;
  if (!multicomponentAssociationRegionsOverlap(
    left.startHz,
    left.stopHz,
    right.startHz,
    right.stopHz,
    right.rbwHz,
    right.binWidthHz,
  )) return false;
  const sharedCenterToleranceHz = Math.max(
    right.rbwHz * 2,
    right.binWidthHz * 5,
  );
  return left.memberCentersHz.some((leftCenterHz) =>
    right.memberCentersHz.some((rightCenterHz) =>
      Math.abs(leftCenterHz - rightCenterHz) <= sharedCenterToleranceHz));
}

export function multicomponentSweepBinWidthHz(sweep: Sweep): number {
  return sweep.frequencyHz.length > 1
    ? median(sweep.frequencyHz.slice(1).map((frequency, index) => frequency - sweep.frequencyHz[index]!))
    : sweep.actualRbwHz;
}

export function multicomponentSweepGeometryId(sweep: Sweep): string {
  return [
    'multicomponent-swept-region-geometry-v1',
    measurementIdentityKey(sweep.identity),
    sweep.actualStartHz,
    sweep.actualStopHz,
    sweep.actualRbwHz,
    multicomponentSweepBinWidthHz(sweep),
    sweep.resolutionBandwidthQualification,
    sweep.attenuationQualification,
    sweep.actualAttenuationDb ?? 'none',
    sweep.requested.startHz,
    sweep.requested.stopHz,
    sweep.requested.points,
    sweep.requested.sweepTimeSeconds,
    JSON.stringify(sweep.requested.controls),
  ].join('\u0000');
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
