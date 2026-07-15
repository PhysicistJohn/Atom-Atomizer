import type { MeasurementIdentity } from '@tinysa/contracts';

/**
 * Stable acquisition-source key used for repeated-evidence admission.
 * Generic sessions are intentionally session-bound; a reconnect starts a new
 * evidence lineage even when the driver exposes the same candidate again.
 */
export function measurementIdentityKey(identity: MeasurementIdentity): string {
  if (isInstrumentMeasurementIdentity(identity)) {
    return [
      'instrument-session',
      identity.driverId,
      identity.provenance.sourceKind,
      identity.candidateId,
      identity.sessionId,
      ...(identity.provenance.sourceKind === 'signal-lab'
        ? ['producer-configuration-epoch', identity.provenance.producerConfigurationEpoch]
        : []),
    ].join('\u0000');
  }
  return [
    'legacy-device',
    identity.port.id,
    identity.firmwareVersion,
    identity.execution,
  ].join('\u0000');
}

export function sameMeasurementIdentity(left: MeasurementIdentity, right: MeasurementIdentity): boolean {
  return measurementIdentityKey(left) === measurementIdentityKey(right);
}

export function isInstrumentMeasurementIdentity(
  identity: MeasurementIdentity,
): identity is Extract<MeasurementIdentity, { kind: 'instrument-session' }> {
  return 'kind' in identity && identity.kind === 'instrument-session';
}
