import {
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN,
} from '../packages/analysis/dist/index.js';

/**
 * Immutable acceptance policy for the live SignalLab exercise.
 *
 * Keeping these independent oracles out of the UI driver makes it harder for
 * runner mechanics to silently widen a scientific or marker expectation.
 */

export const CANONICAL_SIGNAL_LAB_PROFILE_IDS = Object.freeze([
  'cw',
  'am',
  'fm',
  'gsm-900-loaded-bcch',
  'gsm-normal-burst',
  'gsm-qpsk-higher-symbol-rate-burst',
  'gsm-aqpsk-normal-burst',
  'gsm-8psk-normal-burst',
  'gsm-16qam-higher-symbol-rate-burst',
  'gsm-32qam-higher-symbol-rate-burst',
  'lte-band3-fdd-20m',
  'lte-band38-tdd-10m',
  'lte-etm1.1',
  'lte-etm3.1',
  'lte-etm3.1a',
  'lte-etm3.1b',
  'lte-ntm',
  'lte-nbiot-guard-isolated-component',
  'lte-nbiot-inband-isolated-component',
  'nr-n3-fdd-20m',
  'nr-n78-tdd-100m',
  'nr-fr1-tm1.1',
  'nr-fr1-tm3.1',
  'nr-fr1-tm3.1a',
  'nr-fr1-tm3.1b',
  'nr-nbiot-inband-isolated-component',
  'wifi-hr-dsss-11m',
  'wifi-ofdm-20m',
  'wifi6-he-su',
  'wifi6-he-er-su',
  'wifi6-he-mu',
  'wifi6-he-tb',
  'bluetooth-classic-connected',
  'bluetooth-le-advertising',
]);

export const SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS = Object.freeze(
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map(({ profileId }) => profileId),
);

const CLASSIFIER_RELEASE_GATE_PROFILE_IDS = new Set(
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
);

export const SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN = Object.freeze(
  SIGNAL_LAB_PRODUCTION_SPECTRUM_RELEASE_GATE_SOURCE_PLAN.map((entry) => Object.freeze({
    ...entry,
  })),
);

const CW_CLASSIFICATION_LABEL = Object.freeze([/^CW-like carrier$/i]);
const AM_CLASSIFICATION_LABEL = Object.freeze([/^DSB full-carrier AM-like$/i]);
const FM_CLASSIFICATION_LABEL = Object.freeze([/^FM \/ angle-modulated-like$/i]);
const GSM_CLASSIFICATION_LABEL = Object.freeze([/^GSM \/ GERAN-like$/i]);
const CELLULAR_AMBIGUOUS_CLASSIFICATION_LABEL = Object.freeze([
  /^OFDM-shaped · LTE\/NR-compatible$/i,
]);
const NR_TDD_CLASSIFICATION_LABELS = Object.freeze([
  /^5G NR TDD-like$/i,
  /^5G NR-compatible OFDM · duplex ambiguous$/i,
]);
const WIFI_CLASSIFICATION_LABEL = Object.freeze([
  /^802\.11-compatible channel morphology · PHY unresolved$/i,
]);
const BLUETOOTH_CLASSIFICATION_LABEL = Object.freeze([
  /^2\.4 GHz agile activity · Bluetooth-compatible$/i,
]);

// This is an external test oracle only. It is never passed to the classifier.
// Only these 12 fitted/canonized profiles have an independent production
// release oracle. The other 22 profiles still have to expose a current linked
// non-protocol result, but their terminal labels are deliberately unvalidated.
const SIGNAL_LAB_PROFILE_CLASSIFICATION_LABELS = Object.freeze({
  cw: CW_CLASSIFICATION_LABEL,
  am: AM_CLASSIFICATION_LABEL,
  fm: FM_CLASSIFICATION_LABEL,
  'gsm-900-loaded-bcch': GSM_CLASSIFICATION_LABEL,
  'lte-band3-fdd-20m': CELLULAR_AMBIGUOUS_CLASSIFICATION_LABEL,
  'lte-band38-tdd-10m': CELLULAR_AMBIGUOUS_CLASSIFICATION_LABEL,
  'nr-n3-fdd-20m': CELLULAR_AMBIGUOUS_CLASSIFICATION_LABEL,
  'nr-n78-tdd-100m': NR_TDD_CLASSIFICATION_LABELS,
  'wifi-hr-dsss-11m': WIFI_CLASSIFICATION_LABEL,
  'wifi-ofdm-20m': WIFI_CLASSIFICATION_LABEL,
  'bluetooth-classic-connected': BLUETOOTH_CLASSIFICATION_LABEL,
  'bluetooth-le-advertising': BLUETOOTH_CLASSIFICATION_LABEL,
});

export const NARROW_MARKER = 'resolution-limited-narrow';
export const RESOLVED_MARKER = 'resolved-wideband';
export const UNAVAILABLE_MARKER = 'unavailable';
const INACTIVE_UNAVAILABLE_REASONS = Object.freeze([
  'no-qualified-local-component',
  'insufficient-local-prominence',
]);
const NONMONOTONE_UNAVAILABLE_REASON = 'nonmonotone-half-power-response';

function markerPolicy(
  allowedWidthClassifications,
  {
    allowedUnavailableReasons = [],
    centroidRequiredClassifications = [],
    centroidRequiredUnavailableReasons = [],
    centroidAbsentClassifications = [],
    centroidAbsentUnavailableReasons = [],
  } = {},
) {
  return Object.freeze({
    allowedWidthClassifications: Object.freeze(allowedWidthClassifications),
    allowedUnavailableReasons: Object.freeze(allowedUnavailableReasons),
    centroidRequiredClassifications: Object.freeze(centroidRequiredClassifications),
    centroidRequiredUnavailableReasons: Object.freeze(centroidRequiredUnavailableReasons),
    centroidAbsentClassifications: Object.freeze(centroidAbsentClassifications),
    centroidAbsentUnavailableReasons: Object.freeze(centroidAbsentUnavailableReasons),
  });
}

const NARROW_MARKER_POLICY = markerPolicy([NARROW_MARKER], {
  centroidAbsentClassifications: [NARROW_MARKER],
});
const RESOLVED_MARKER_POLICY = markerPolicy([RESOLVED_MARKER], {
  centroidRequiredClassifications: [RESOLVED_MARKER],
});
const RESOLVED_OR_INACTIVE_MARKER_POLICY = markerPolicy(
  [RESOLVED_MARKER, UNAVAILABLE_MARKER],
  {
    allowedUnavailableReasons: INACTIVE_UNAVAILABLE_REASONS,
    centroidRequiredClassifications: [RESOLVED_MARKER],
    centroidAbsentUnavailableReasons: INACTIVE_UNAVAILABLE_REASONS,
  },
);
const NONMONOTONE_OR_INACTIVE_MARKER_POLICY = markerPolicy([UNAVAILABLE_MARKER], {
  allowedUnavailableReasons: [
    NONMONOTONE_UNAVAILABLE_REASON,
    ...INACTIVE_UNAVAILABLE_REASONS,
  ],
  centroidRequiredUnavailableReasons: [NONMONOTONE_UNAVAILABLE_REASON],
  centroidAbsentUnavailableReasons: INACTIVE_UNAVAILABLE_REASONS,
});
const BLUETOOTH_MARKER_POLICY = markerPolicy(
  [NARROW_MARKER, RESOLVED_MARKER, UNAVAILABLE_MARKER],
  {
    allowedUnavailableReasons: INACTIVE_UNAVAILABLE_REASONS,
    centroidRequiredClassifications: [RESOLVED_MARKER],
    centroidAbsentClassifications: [NARROW_MARKER],
    centroidAbsentUnavailableReasons: INACTIVE_UNAVAILABLE_REASONS,
  },
);

const SIGNAL_LAB_PROFILE_MARKER_EXPECTATIONS = Object.freeze({
  cw: NARROW_MARKER_POLICY,
  am: NARROW_MARKER_POLICY,
  fm: NARROW_MARKER_POLICY,
  'gsm-900-loaded-bcch': RESOLVED_MARKER_POLICY,
  'gsm-normal-burst': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'gsm-qpsk-higher-symbol-rate-burst': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'gsm-aqpsk-normal-burst': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'gsm-8psk-normal-burst': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'gsm-16qam-higher-symbol-rate-burst': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'gsm-32qam-higher-symbol-rate-burst': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'lte-band3-fdd-20m': RESOLVED_MARKER_POLICY,
  'lte-band38-tdd-10m': RESOLVED_MARKER_POLICY,
  'lte-etm1.1': RESOLVED_MARKER_POLICY,
  'lte-etm3.1': RESOLVED_MARKER_POLICY,
  'lte-etm3.1a': RESOLVED_MARKER_POLICY,
  'lte-etm3.1b': RESOLVED_MARKER_POLICY,
  'lte-ntm': RESOLVED_MARKER_POLICY,
  'lte-nbiot-guard-isolated-component': RESOLVED_MARKER_POLICY,
  'lte-nbiot-inband-isolated-component': RESOLVED_MARKER_POLICY,
  'nr-n3-fdd-20m': RESOLVED_MARKER_POLICY,
  'nr-n78-tdd-100m': RESOLVED_MARKER_POLICY,
  'nr-fr1-tm1.1': RESOLVED_MARKER_POLICY,
  'nr-fr1-tm3.1': RESOLVED_MARKER_POLICY,
  'nr-fr1-tm3.1a': RESOLVED_MARKER_POLICY,
  'nr-fr1-tm3.1b': RESOLVED_MARKER_POLICY,
  'nr-nbiot-inband-isolated-component': RESOLVED_MARKER_POLICY,
  'wifi-hr-dsss-11m': RESOLVED_MARKER_POLICY,
  'wifi-ofdm-20m': RESOLVED_MARKER_POLICY,
  'wifi6-he-su': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'wifi6-he-er-su': RESOLVED_OR_INACTIVE_MARKER_POLICY,
  'wifi6-he-mu': NONMONOTONE_OR_INACTIVE_MARKER_POLICY,
  'wifi6-he-tb': NONMONOTONE_OR_INACTIVE_MARKER_POLICY,
  'bluetooth-classic-connected': BLUETOOTH_MARKER_POLICY,
  'bluetooth-le-advertising': BLUETOOTH_MARKER_POLICY,
});

export function liveSignalLabMarkerExpectation(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('SignalLab profile is required');
  const policy = SIGNAL_LAB_PROFILE_MARKER_EXPECTATIONS[profile.id];
  if (!policy) {
    throw new Error(`No live marker oracle is defined for SignalLab profile ${String(profile.id)}`);
  }
  return {
    profileId: profile.id,
    ...policy,
  };
}

export function liveSignalLabClassificationExpectation(profile, resultLabel) {
  if (!profile || typeof profile !== 'object') throw new TypeError('SignalLab profile is required');
  const label = typeof resultLabel === 'string' && resultLabel.trim()
    ? resultLabel.trim()
    : null;
  const releaseGateProfile = CLASSIFIER_RELEASE_GATE_PROFILE_IDS.has(profile.id);
  const allowed = SIGNAL_LAB_PROFILE_CLASSIFICATION_LABELS[profile.id] ?? null;
  const compatible = releaseGateProfile && label !== null
    ? allowed.some((pattern) => pattern.test(label))
    : null;
  return {
    profileId: profile.id,
    claim: releaseGateProfile
      ? 'canonical-release-gate-observable-label-compatibility'
      : 'classification-oracle-unvalidated',
    oracleStatus: releaseGateProfile
      ? label === null ? 'pending' : compatible ? 'validated' : 'failed'
      : 'classification-oracle-unvalidated',
    resultLabel: label,
    known: label !== null && !/^Unknown$/i.test(label),
    compatible,
  };
}

export function interleavedFullCatalogClassificationRecord(profile, resultLabel) {
  const expectation = liveSignalLabClassificationExpectation(profile, resultLabel);
  return {
    ...expectation,
    claim: 'classification-oracle-unvalidated-interleaved-source-clock',
    oracleStatus: 'classification-oracle-unvalidated',
    compatible: null,
  };
}

export function validateSignalLabPolicyCatalog(catalogIds) {
  if (!Array.isArray(catalogIds)) throw new TypeError('SignalLab catalog IDs must be an array');
  if (!sameOrderedValues(catalogIds, CANONICAL_SIGNAL_LAB_PROFILE_IDS)) {
    throw new Error(
      `SignalLab live catalog IDs/order do not match the closed acceptance catalog: ${catalogIds.join(', ')}`,
    );
  }
  if (Object.keys(SIGNAL_LAB_PROFILE_CLASSIFICATION_LABELS).length
      !== CLASSIFIER_RELEASE_GATE_PROFILE_IDS.size
    || [...CLASSIFIER_RELEASE_GATE_PROFILE_IDS].some(
      (id) => !Object.hasOwn(SIGNAL_LAB_PROFILE_CLASSIFICATION_LABELS, id),
    )) {
    throw new Error('SignalLab live classifier oracle does not match the fitted 12-profile release gate');
  }
  if (Object.keys(SIGNAL_LAB_PROFILE_MARKER_EXPECTATIONS).length
      !== CANONICAL_SIGNAL_LAB_PROFILE_IDS.length
    || CANONICAL_SIGNAL_LAB_PROFILE_IDS.some(
      (id) => !Object.hasOwn(SIGNAL_LAB_PROFILE_MARKER_EXPECTATIONS, id),
    )) {
    throw new Error('SignalLab live marker oracle does not cover the closed profile catalog');
  }
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
