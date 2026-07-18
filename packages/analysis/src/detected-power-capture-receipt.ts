import {
  detectedPowerTimeseriesConfigurationSchema,
  deviceIdentitySchema,
  instrumentSessionProvenanceSchema,
  instrumentTimestampSchema,
  type DetectedPowerCaptureCandidateEvidence,
  type DetectedPowerCaptureReceipt,
  type DetectedSignal,
  type ZeroSpanCapture,
} from '@tinysa/contracts';
import { measurementIdentityKey } from './measurement-provenance.js';
import {
  compareClassificationCaptureTargetRankEvidence,
  type ClassificationCaptureTargetRankEvidence,
} from './classification-target-ranking.js';
import {
  SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID,
  SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID,
} from './observable-training-acquisition-geometry.js';

const issuedReceipts = new WeakSet<object>();
const issuedCaptureSnapshots = new WeakMap<object, ZeroSpanCapture>();
const CAPTURE_PAYLOAD_CANONICALIZATION =
  'zero-span-capture-canonical-json-v1' as const;
const CAPTURE_PAYLOAD_HASH_DOMAIN =
  'tinysa-detected-power-capture-payload-v1\0';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const DETECTED_POWER_CAPTURE_RUNTIME_ADMISSION_POLICY_ID =
  'exact-eight-sweep-pre-capture-observable-feature-admission-v1' as const;

/**
 * Internal authority boundary. Public callers receive receipts only through
 * createDetectedPowerCaptureReceipt(), which derives this complete shape from
 * contemporaneous tracker rows and the returned physical capture.
 */
export function issueDetectedPowerCaptureReceipt(
  receipt: DetectedPowerCaptureReceipt,
  trustedCaptureSnapshot: ZeroSpanCapture,
): DetectedPowerCaptureReceipt {
  assertReceiptSelfConsistent(receipt);
  if (!deeplyFrozen(trustedCaptureSnapshot)) {
    throw new Error(
      'Detected-power capture receipt authority requires an immutable trusted capture snapshot',
    );
  }
  if (receipt.capture.payloadBinding.sha256
    !== detectedPowerCapturePayloadSha256(trustedCaptureSnapshot)) {
    throw new Error(
      'Detected-power capture receipt payload binding does not match the capture authorized by the analysis boundary',
    );
  }
  deepFreeze(receipt);
  issuedReceipts.add(receipt);
  issuedCaptureSnapshots.set(receipt, trustedCaptureSnapshot);
  return receipt;
}

export interface DetectedPowerCaptureReceiptVerification {
  readonly receipt: DetectedPowerCaptureReceipt;
  readonly detection: DetectedSignal;
  readonly capture: ZeroSpanCapture;
  readonly spectrumSweepIds: readonly string[];
}

/**
 * Verify both receipt authority and every binding that can change between
 * target selection and feature extraction. A structured clone, deserialized
 * object, caller-authored lookalike, or internally contradictory receipt is
 * rejected even when every policy string is spelled correctly. On success,
 * return the immutable authority-owned snapshot that classification must use.
 */
export function assertDetectedPowerCaptureReceiptMatches({
  receipt,
  detection,
  capture,
  spectrumSweepIds,
}: DetectedPowerCaptureReceiptVerification): ZeroSpanCapture {
  if (!issuedReceipts.has(receipt)) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt not issued by the analysis selection boundary',
    );
  }
  if (!deeplyFrozen(receipt)) {
    throw new Error('Observable classification rejects mutable detected-power capture receipt');
  }
  const trustedCaptureSnapshot = issuedCaptureSnapshots.get(receipt);
  if (!trustedCaptureSnapshot || !deeplyFrozen(trustedCaptureSnapshot)) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt without its immutable authority-owned capture snapshot',
    );
  }
  const suppliedCaptureSnapshot = trustedDetectedPowerCaptureSnapshot(capture);
  assertReceiptSelfConsistent(receipt);
  if (receipt.capture.payloadBinding.sha256
    !== detectedPowerCapturePayloadSha256(suppliedCaptureSnapshot)
    || receipt.capture.payloadBinding.sha256
      !== detectedPowerCapturePayloadSha256(trustedCaptureSnapshot)) {
    throw new Error(
      'Observable classification rejects a different or mutated capture: its canonical payload digest does not match the returned samples, cadence, geometry, or provenance',
    );
  }
  if (!sameRepresentativeEvidence(receipt.projectedRepresentative, detection)) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt projected to a different or mutated representative',
    );
  }
  if (receipt.selection.projectedRepresentativeId !== detection.id) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt member substitution',
    );
  }
  if (receipt.capture.id !== suppliedCaptureSnapshot.id
    || receipt.capture.sequence !== suppliedCaptureSnapshot.sequence
    || receipt.capture.capturedAt !== suppliedCaptureSnapshot.capturedAt
    || receipt.capture.measurementIdentityKey
      !== measurementIdentityKey(suppliedCaptureSnapshot.identity)
    || receipt.capture.targetDetectionId
      !== suppliedCaptureSnapshot.targetDetectionId
    || receipt.capture.admittedTargetTuneHz
      !== suppliedCaptureSnapshot.frequencyHz
    || receipt.capture.frequencyHz !== suppliedCaptureSnapshot.frequencyHz
    || receipt.capture.requestedCenterHz
      !== suppliedCaptureSnapshot.requested.centerHz) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt bound to a different or mutated capture',
    );
  }
  if (suppliedCaptureSnapshot.targetDetectionId !== receipt.selection.rawTargetId) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt whose raw target does not own the capture',
    );
  }
  if (suppliedCaptureSnapshot.frequencyHz
    !== suppliedCaptureSnapshot.requested.centerHz) {
    throw new Error(
      'Observable classification rejects detected-power capture whose returned tune contradicts its admitted request',
    );
  }
  if (!sameStringArray(receipt.spectrumSweepIds, spectrumSweepIds)) {
    throw new Error(
      'Observable classification rejects detected-power capture receipt bound to a different scalar evidence window',
    );
  }
  return trustedCaptureSnapshot;
}

function assertReceiptSelfConsistent(receipt: DetectedPowerCaptureReceipt): void {
  if (receipt.schemaVersion !== 4) {
    throw new Error(`Unsupported detected-power capture receipt schema ${String(receipt.schemaVersion)}`);
  }
  if (receipt.capturePolicyId !== SIGNAL_LAB_PRODUCTION_DETECTED_POWER_CAPTURE_POLICY_ID) {
    throw new Error(`Unsupported detected-power capture policy ${String(receipt.capturePolicyId)}`);
  }
  if (receipt.targetSelectionPolicyId !== SIGNAL_LAB_PRODUCTION_CAPTURE_TARGET_SELECTION_POLICY_ID) {
    throw new Error(`Unsupported detected-power capture target-selection policy ${String(receipt.targetSelectionPolicyId)}`);
  }
  if (receipt.runtimeAdmissionPolicyId
    !== DETECTED_POWER_CAPTURE_RUNTIME_ADMISSION_POLICY_ID) {
    throw new Error(`Unsupported detected-power capture runtime-admission policy ${String(receipt.runtimeAdmissionPolicyId)}`);
  }
  if (receipt.candidates.length === 0) {
    throw new Error('Detected-power capture receipt requires contemporaneous candidate evidence');
  }
  if (new Set(receipt.candidates.map((candidate) => candidate.rawTargetId)).size
    !== receipt.candidates.length) {
    throw new Error('Detected-power capture receipt rejects duplicate raw target IDs');
  }
  if (new Set(receipt.candidates.map((candidate) => candidate.inputOrdinal)).size
    !== receipt.candidates.length
    || [...receipt.candidates].map((candidate) => candidate.inputOrdinal)
      .sort((left, right) => left - right)
      .some((ordinal, index) => ordinal !== index)) {
    throw new Error('Detected-power capture receipt requires complete contiguous tracker input ordinals');
  }
  for (let index = 0; index < receipt.candidates.length; index++) {
    const candidate = receipt.candidates[index]!;
    assertCandidateEvidenceWellFormed(candidate, index);
    if (index > 0
      && compareCaptureCandidateEvidence(receipt.candidates[index - 1]!, candidate) > 0) {
      throw new Error('Detected-power capture receipt candidate ranks contradict the target-selection policy');
    }
  }
  const selected = receipt.candidates.find(
    (candidate) => candidate.rawTargetId === receipt.selection.rawTargetId,
  );
  if (!selected
    || selected.projectedRepresentativeId !== receipt.selection.projectedRepresentativeId
    || selected.runtimeAdmission.status !== 'admitted'
    || receipt.projectedRepresentative.id !== receipt.selection.projectedRepresentativeId) {
    throw new Error('Detected-power capture receipt selection is not supported by a runtime-admitted ranked candidate');
  }
  if (selected.projectionKind === 'current-active-physical-representative') {
    if (selected.state !== 'active'
      || selected.rawTargetId !== selected.projectedRepresentativeId
      || receipt.projectedRepresentative.associationMode
        === 'frequency-agile-2g4-activity') {
      throw new Error(
        'Detected-power capture receipt direct projection contradicts its active physical representative',
      );
    }
  } else if (selected.rawTargetId === selected.projectedRepresentativeId
    || receipt.projectedRepresentative.associationMode
      !== 'frequency-agile-2g4-activity'
    || receipt.projectedRepresentative.missedSweeps !== 0
    || receipt.projectedRepresentative.associationMissedSweeps !== 0
    || receipt.projectedRepresentative.associationMemberTrackIds?.includes(
      selected.rawTargetId,
    ) !== true) {
    throw new Error(
      'Detected-power capture receipt agile projection contradicts its exact current physical member',
    );
  }
  if (!sameStringArray(
    selected.runtimeAdmission.spectrumSweepIds,
    receipt.spectrumSweepIds,
  )) {
    throw new Error('Detected-power capture receipt selected admission window contradicts its capture window');
  }
  if (receipt.selection.mode === 'integrated-excess-current') {
    if (receipt.selection.preferredRawTargetId !== undefined) {
      throw new Error('Automatic integrated-excess capture receipt cannot claim a preferred raw target');
    }
    const automaticWinner = receipt.candidates[0];
    if (automaticWinner?.rawTargetId !== receipt.selection.rawTargetId
      || automaticWinner.runtimeAdmission.status !== 'admitted') {
      throw new Error('Detected-power capture receipt did not select and runtime-admit its rank-0 integrated-excess current target');
    }
  } else {
    if (receipt.selection.preferredRawTargetId !== receipt.selection.rawTargetId) {
      throw new Error('Preferred-target capture receipt does not select its declared preferred raw target');
    }
  }
  if (receipt.capture.targetDetectionId !== receipt.selection.rawTargetId) {
    throw new Error('Detected-power capture receipt target identity contradicts its selection');
  }
  assertFiniteNonnegativeInteger(receipt.capture.sequence, 'capture sequence');
  instrumentTimestampSchema.parse(receipt.capture.capturedAt);
  for (const [label, value] of [
    ['capture frequency', receipt.capture.frequencyHz],
    ['admitted target tune', receipt.capture.admittedTargetTuneHz],
    ['requested capture center', receipt.capture.requestedCenterHz],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Detected-power capture receipt ${label} must be finite and non-negative`);
    }
  }
  if (!receipt.capture.id
    || !receipt.capture.measurementIdentityKey
    || !receipt.capture.targetDetectionId) {
    throw new Error('Detected-power capture receipt requires complete capture identity evidence');
  }
  if (receipt.capture.payloadBinding.algorithm !== 'sha256'
    || receipt.capture.payloadBinding.canonicalization
      !== CAPTURE_PAYLOAD_CANONICALIZATION
    || !SHA256_PATTERN.test(receipt.capture.payloadBinding.sha256)) {
    throw new Error(
      'Detected-power capture receipt requires a canonical lowercase SHA-256 capture-payload binding',
    );
  }
  if (receipt.capture.frequencyHz !== receipt.capture.admittedTargetTuneHz
    || receipt.capture.requestedCenterHz !== receipt.capture.admittedTargetTuneHz) {
    throw new Error(
      'Detected-power capture receipt returned, requested, and controller-admitted target tunes must agree',
    );
  }
  if (receipt.spectrumSweepIds.length !== 8
    || new Set(receipt.spectrumSweepIds).size !== receipt.spectrumSweepIds.length
    || receipt.spectrumSweepIds.some((sweepId) => !sweepId)) {
    throw new Error('Detected-power capture receipt requires exactly eight unique scalar sweep IDs');
  }
  assertRepresentativeEvidenceWellFormed(receipt.projectedRepresentative);
}

function assertCandidateEvidenceWellFormed(
  candidate: DetectedPowerCaptureCandidateEvidence,
  expectedRank: number,
): void {
  if (candidate.rank !== expectedRank
    || !Number.isSafeInteger(candidate.inputOrdinal)
    || candidate.inputOrdinal < 0
    || !candidate.rawTargetId
    || (candidate.state !== 'candidate' && candidate.state !== 'active')
    || (candidate.projectionKind !== 'current-active-physical-representative'
      && candidate.projectionKind !== 'current-qualified-agile-latest-member')
    || !candidate.projectedRepresentativeId) {
    throw new Error('Detected-power capture receipt contains malformed candidate rank or identity evidence');
  }
  if (candidate.projectionKind === 'current-active-physical-representative'
    ? candidate.state !== 'active'
      || candidate.rawTargetId !== candidate.projectedRepresentativeId
    : candidate.rawTargetId === candidate.projectedRepresentativeId) {
    throw new Error('Detected-power capture receipt candidate projection contradicts its raw state or identity');
  }
  for (const [label, value] of [
    ['current peak dBm', candidate.currentPeakDbm],
    ['current support start Hz', candidate.currentSupportStartHz],
    ['current support stop Hz', candidate.currentSupportStopHz],
    ['current robust floor dBm', candidate.currentRobustFloorDbm],
    ['current actual RBW Hz', candidate.currentActualRbwHz],
    ['current integrated excess-power mW', candidate.currentIntegratedExcessPowerMw],
    ['current peak Hz', candidate.currentPeakHz],
    ['current start Hz', candidate.currentStartHz],
    ['current stop Hz', candidate.currentStopHz],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new Error(`Detected-power capture receipt candidate ${label} must be finite`);
    }
  }
  if (candidate.currentStartHz < 0
    || candidate.currentStopHz < candidate.currentStartHz
    || candidate.currentPeakHz < candidate.currentStartHz
    || candidate.currentPeakHz > candidate.currentStopHz) {
    throw new Error('Detected-power capture receipt candidate peak lies outside its observed interval');
  }
  if (!candidate.currentSourceSweepId
    || !Number.isSafeInteger(candidate.currentSupportCellCount)
    || candidate.currentSupportCellCount < 1
    || candidate.currentSupportStartHz < candidate.currentStartHz
    || candidate.currentSupportStopHz > candidate.currentStopHz
    || candidate.currentSupportStopHz < candidate.currentSupportStartHz
    || candidate.currentPeakHz < candidate.currentSupportStartHz
    || candidate.currentPeakHz > candidate.currentSupportStopHz
    || candidate.currentActualRbwHz <= 0
    || candidate.currentIntegratedExcessPowerMw <= 0) {
    throw new Error('Detected-power capture receipt candidate exact integrated-power evidence is outside its domain');
  }
  assertFiniteNonnegativeInteger(candidate.missedSweeps, 'candidate missed-sweep count');
  instrumentTimestampSchema.parse(candidate.lastSeenAt);
  assertAssociationEvidenceWellFormed(candidate);
  if (candidate.runtimeAdmission.status === 'admitted') {
    if (candidate.runtimeAdmission.spectrumSweepIds.length !== 8
      || new Set(candidate.runtimeAdmission.spectrumSweepIds).size
        !== candidate.runtimeAdmission.spectrumSweepIds.length
      || candidate.runtimeAdmission.spectrumSweepIds.some((sweepId) => !sweepId)
      || candidate.runtimeAdmission.spectrumSweepIds[0]
        !== candidate.currentSourceSweepId) {
      throw new Error(
        'Detected-power capture receipt candidate runtime admission requires one projectable exact eight-sweep window beginning with its current source sweep',
      );
    }
  }
}

function assertRepresentativeEvidenceWellFormed(
  representative: DetectedPowerCaptureReceipt['projectedRepresentative'],
): void {
  if (!representative.id) {
    throw new Error('Detected-power capture receipt requires a projected representative identity');
  }
  for (const [label, value] of [
    ['start Hz', representative.startHz],
    ['stop Hz', representative.stopHz],
    ['peak Hz', representative.peakHz],
    ['peak dBm', representative.peakDbm],
    ['bandwidth Hz', representative.bandwidthHz],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new Error(`Detected-power capture receipt representative ${label} must be finite`);
    }
  }
  if (representative.startHz < 0
    || representative.stopHz < representative.startHz
    || representative.peakHz < representative.startHz
    || representative.peakHz > representative.stopHz
    || representative.bandwidthHz < 0) {
    throw new Error('Detected-power capture receipt representative geometry is contradictory');
  }
  assertFiniteNonnegativeInteger(representative.missedSweeps, 'representative missed-sweep count');
  instrumentTimestampSchema.parse(representative.lastSeenAt);
  assertAssociationEvidenceWellFormed(representative);
}

function assertAssociationEvidenceWellFormed(value: {
  associationMode?: DetectedSignal['associationMode'];
  associationId?: string;
  associationMemberTrackIds?: readonly string[];
  associationMissedSweeps?: number;
}): void {
  const local = value.associationMode === undefined || value.associationMode === 'frequency-local';
  if (local && (value.associationId !== undefined
    || value.associationMemberTrackIds !== undefined
    || value.associationMissedSweeps !== undefined)) {
    throw new Error('Detected-power capture receipt local candidate carries association-only evidence');
  }
  if (!local && (!value.associationId
    || !value.associationMemberTrackIds?.length
    || new Set(value.associationMemberTrackIds).size !== value.associationMemberTrackIds.length
    || value.associationMissedSweeps === undefined)) {
    throw new Error('Detected-power capture receipt associated candidate lacks complete current-member evidence');
  }
  if (value.associationMissedSweeps !== undefined) {
    assertFiniteNonnegativeInteger(
      value.associationMissedSweeps,
      'association missed-sweep count',
    );
  }
}

/**
 * Comparator sign follows Array.sort: a negative result means `left` must
 * precede `right`. It exactly pins the deployed v4 policy: current-source-sweep
 * integrated excess power, stable representative key, then raw tracker ID.
 */
function compareCaptureCandidateEvidence(
  left: DetectedPowerCaptureCandidateEvidence,
  right: DetectedPowerCaptureCandidateEvidence,
): number {
  return compareClassificationCaptureTargetRankEvidence(
    receiptCandidateRankEvidence(left),
    receiptCandidateRankEvidence(right),
  )
    || receiptRepresentativeKey(left).localeCompare(receiptRepresentativeKey(right))
    || left.rawTargetId.localeCompare(right.rawTargetId);
}

function receiptCandidateRankEvidence(
  candidate: DetectedPowerCaptureCandidateEvidence,
): ClassificationCaptureTargetRankEvidence {
  return {
    sourceSweepId: candidate.currentSourceSweepId,
    supportStartHz: candidate.currentSupportStartHz,
    supportStopHz: candidate.currentSupportStopHz,
    supportCellCount: candidate.currentSupportCellCount,
    robustFloorDbm: candidate.currentRobustFloorDbm,
    actualRbwHz: candidate.currentActualRbwHz,
    integratedExcessPowerMw: candidate.currentIntegratedExcessPowerMw,
  };
}

function receiptRepresentativeKey(candidate: DetectedPowerCaptureCandidateEvidence): string {
  const associationMode = candidate.associationMode ?? 'frequency-local';
  return `${associationMode}:${associationMode === 'frequency-local'
    ? candidate.rawTargetId
    : candidate.associationId ?? candidate.rawTargetId}`;
}

function sameRepresentativeEvidence(
  expected: DetectedPowerCaptureReceipt['projectedRepresentative'],
  actual: DetectedSignal,
): boolean {
  return expected.id === actual.id
    && expected.startHz === actual.startHz
    && expected.stopHz === actual.stopHz
    && expected.peakHz === actual.peakHz
    && expected.peakDbm === actual.peakDbm
    && expected.bandwidthHz === actual.bandwidthHz
    && expected.missedSweeps === actual.missedSweeps
    && expected.lastSeenAt === actual.lastSeenAt
    && expected.associationMode === actual.associationMode
    && expected.associationId === actual.associationId
    && sameOptionalStringArray(
      expected.associationMemberTrackIds,
      actual.associationMemberTrackIds,
    )
    && expected.associationMissedSweeps === actual.associationMissedSweeps;
}

function sameOptionalStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameStringArray(left, right);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertCallerCaptureGraphPlain(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype
    : prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `Detected-power capture receipt rejects non-plain object or Array subclass at ${path}`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(
      `Detected-power capture receipt rejects symbol-keyed capture value at ${path}`,
    );
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (array && key === 'length') continue;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(
        `Detected-power capture receipt requires every typed field to be an enumerable own data property at ${path}.${key}`,
      );
    }
    assertCallerCaptureGraphPlain(descriptor.value, `${path}.${key}`, seen);
  }
}

function assertTrustedCaptureSnapshotShape(snapshot: ZeroSpanCapture): void {
  assertExactOwnKeys(snapshot, [
    'kind',
    'id',
    'sequence',
    'capturedAt',
    'elapsedMilliseconds',
    'frequencyHz',
    'samplePeriodSeconds',
    'powerDbm',
    'requested',
    'actualRbwHz',
    'actualAttenuationDb',
    'source',
    'complete',
    'identity',
  ], [
    'timingQualification',
    'targetDetectionId',
    'resolutionBandwidthQualification',
    'attenuationQualification',
  ], '$');
  if (snapshot.kind !== 'zero-span'
    || snapshot.complete !== true
    || typeof snapshot.id !== 'string'
    || snapshot.id.length === 0
    || !Number.isSafeInteger(snapshot.sequence)
    || snapshot.sequence < 0
    || !Number.isFinite(snapshot.elapsedMilliseconds)
    || snapshot.elapsedMilliseconds < 0
    || !Number.isFinite(snapshot.frequencyHz)
    || snapshot.frequencyHz < 0
    || !Number.isFinite(snapshot.samplePeriodSeconds)
    || snapshot.samplePeriodSeconds <= 0
    || !Array.isArray(snapshot.powerDbm)
    || Object.getPrototypeOf(snapshot.powerDbm) !== Array.prototype
    || snapshot.powerDbm.length < 20) {
    throw new Error(
      'Detected-power capture receipt rejects malformed capture identity, geometry, or finite sample payload',
    );
  }
  const invalidSampleIndex = snapshot.powerDbm.findIndex((sample) =>
    typeof sample !== 'number' || !Number.isFinite(sample));
  if (invalidSampleIndex >= 0) {
    throw new Error(
      `Detected-power capture receipt requires finite samples; invalid $.powerDbm[${invalidSampleIndex}]`,
    );
  }
  instrumentTimestampSchema.parse(snapshot.capturedAt);
  detectedPowerTimeseriesConfigurationSchema.parse(snapshot.requested);
  if (snapshot.requested.sampleCount !== snapshot.powerDbm.length) {
    throw new Error(
      'Detected-power capture receipt requires requested sample count to equal the returned finite sample count',
    );
  }
  if (snapshot.actualRbwHz !== null
    && (!Number.isFinite(snapshot.actualRbwHz) || snapshot.actualRbwHz <= 0)) {
    throw new Error('Detected-power capture receipt rejects malformed actual RF RBW');
  }
  if (snapshot.actualAttenuationDb !== null
    && !Number.isFinite(snapshot.actualAttenuationDb)) {
    throw new Error('Detected-power capture receipt rejects malformed actual attenuation');
  }
  if (snapshot.timingQualification !== undefined
    && snapshot.timingQualification !== 'wall-clock-derived'
    && snapshot.timingQualification !== 'measured-calibrated'
    && snapshot.timingQualification !== 'simulation-exact') {
    throw new Error('Detected-power capture receipt rejects unknown timing qualification');
  }
  if (snapshot.targetDetectionId !== undefined
    && (typeof snapshot.targetDetectionId !== 'string'
      || snapshot.targetDetectionId.length === 0)) {
    throw new Error('Detected-power capture receipt rejects malformed target identity');
  }
  if (snapshot.resolutionBandwidthQualification !== undefined
    && snapshot.resolutionBandwidthQualification !== 'device-observed'
    && snapshot.resolutionBandwidthQualification !== 'firmware-executed-twin'
    && snapshot.resolutionBandwidthQualification !== 'synthetic-grid-equivalent'
    && snapshot.resolutionBandwidthQualification !== 'unavailable') {
    throw new Error('Detected-power capture receipt rejects unknown RF RBW qualification');
  }
  if (snapshot.attenuationQualification !== undefined
    && snapshot.attenuationQualification !== 'device-observed'
    && snapshot.attenuationQualification !== 'firmware-executed-twin'
    && snapshot.attenuationQualification !== 'not-applicable') {
    throw new Error('Detected-power capture receipt rejects unknown attenuation qualification');
  }
  if (snapshot.source !== 'scan-text'
    && snapshot.source !== 'renode-executable-state'
    && snapshot.source !== 'instrument-driver-detected-power'
    && snapshot.source !== 'signal-lab-synthetic') {
    throw new Error('Detected-power capture receipt rejects unknown capture source');
  }
  const identity = snapshot.identity;
  if ('kind' in identity && identity.kind === 'instrument-session') {
    assertExactOwnKeys(identity, [
      'kind', 'sessionId', 'driverId', 'candidateId', 'provenance',
    ], [], '$.identity');
    if (!identity.sessionId || !identity.driverId || !identity.candidateId) {
      throw new Error('Detected-power capture receipt rejects incomplete instrument identity');
    }
    instrumentSessionProvenanceSchema.parse(identity.provenance);
  } else {
    deviceIdentitySchema.parse(identity);
  }
}

function assertExactOwnKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(descriptors).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor);
  });
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Detected-power capture receipt requires exact enumerable own typed fields at ${path}; missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`,
    );
  }
}

/**
 * Cross the caller-owned object-graph boundary exactly once. structuredClone
 * rejects Proxy objects (including nested proxies); the resulting ordinary
 * graph is canonicalized before it is frozen and retained by receipt
 * authority. Feature extraction must use this snapshot, never reread the
 * caller-owned graph after integrity verification.
 */
export function trustedDetectedPowerCaptureSnapshot(
  capture: ZeroSpanCapture,
): ZeroSpanCapture {
  assertCallerCaptureGraphPlain(capture, '$', new Set<object>());
  let snapshot: ZeroSpanCapture;
  try {
    snapshot = structuredClone(capture);
  } catch {
    throw new Error(
      'Detected-power capture receipt requires a trusted plain cloneable capture snapshot and rejects root or nested Proxy payloads',
    );
  }
  assertTrustedCaptureSnapshotShape(snapshot);
  canonicalDetectedPowerCapturePayload(snapshot);
  return deepFreeze(snapshot);
}

/**
 * Fixed, browser-safe integrity identity for the complete returned capture.
 * The domain separator prevents this digest from being confused with another
 * canonical-JSON hash used elsewhere in the application.
 */
export function detectedPowerCapturePayloadSha256(
  capture: ZeroSpanCapture,
): string {
  return sha256Hex(
    `${CAPTURE_PAYLOAD_HASH_DOMAIN}${canonicalDetectedPowerCapturePayload(capture)}`,
  );
}

/** Exported from this internal module only so the canonicalization can be
 * independently checked against a platform SHA-256 implementation in tests. */
export function canonicalDetectedPowerCapturePayload(
  capture: ZeroSpanCapture,
): string {
  return canonicalJson(capture, '$', new Set<object>());
}

function canonicalJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      const description = path.startsWith('$.powerDbm[')
        ? 'non-finite samples'
        : 'non-finite number';
      throw new Error(
        `Detected-power capture receipt cannot canonically bind ${description} at ${path}`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(
      `Detected-power capture receipt cannot canonically bind ${typeof value} at ${path}`,
    );
  }
  if (ancestors.has(value)) {
    throw new Error(
      `Detected-power capture receipt cannot canonically bind cyclic value at ${path}`,
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0
        || Object.keys(value).some((key) => {
          const index = Number(key);
          return !Number.isSafeInteger(index)
            || index < 0
            || index >= value.length
            || String(index) !== key;
        })) {
        throw new Error(
          `Detected-power capture receipt cannot canonically bind decorated array at ${path}`,
        );
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(
            `Detected-power capture receipt cannot canonically bind sparse array at ${path}[${index}]`,
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(
            `Detected-power capture receipt cannot canonically bind accessor array item at ${path}[${index}]`,
          );
        }
        const item = descriptor.value;
        if (item === undefined) {
          throw new Error(
            `Detected-power capture receipt cannot canonically bind undefined array item at ${path}[${index}]`,
          );
        }
        items.push(canonicalJson(item, `${path}[${index}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        `Detected-power capture receipt cannot canonically bind non-plain object at ${path}`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(
        `Detected-power capture receipt cannot canonically bind symbol-keyed value at ${path}`,
      );
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(
          `Detected-power capture receipt cannot canonically bind accessor property at ${path}.${key}`,
        );
      }
      return descriptor.value !== undefined;
    }).sort();
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const sigma0 = rotateRight(word15, 7)
        ^ rotateRight(word15, 18)
        ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17)
        ^ rotateRight(word2, 19)
        ^ (word2 >>> 10);
      words[index] = (
        words[index - 16]! + sigma0 + words[index - 7]! + sigma1
      ) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (
        h! + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!
      ) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return [...hash]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function assertFiniteNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Detected-power capture receipt ${label} must be a non-negative safe integer`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
}
