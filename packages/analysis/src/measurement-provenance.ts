import type { MeasurementIdentity } from '@tinysa/contracts';

/**
 * Stable acquisition-source key used for repeated-evidence admission.
 * Generic sessions are intentionally session-bound; a reconnect starts a new
 * evidence lineage even when the driver exposes the same candidate again.
 */
export function measurementIdentityKey(identity: MeasurementIdentity): string {
  if (isInstrumentMeasurementIdentity(identity)) {
    return lengthFramedKey([
      'instrument-session',
      identity.driverId,
      identity.provenance.sourceKind,
      identity.candidateId,
      identity.sessionId,
      ...(identity.provenance.sourceKind === 'signal-lab'
        ? ['producer-configuration-epoch', identity.provenance.producerConfigurationEpoch]
        : []),
    ]);
  }
  return lengthFramedKey([
    'legacy-device',
    identity.port.id,
    identity.firmwareVersion,
    identity.execution,
  ]);
}

export function sameMeasurementIdentity(left: MeasurementIdentity, right: MeasurementIdentity): boolean {
  return measurementIdentityKey(left) === measurementIdentityKey(right);
}

export function isInstrumentMeasurementIdentity(
  identity: MeasurementIdentity,
): identity is Extract<MeasurementIdentity, { kind: 'instrument-session' }> {
  return 'kind' in identity && identity.kind === 'instrument-session';
}

/** Injective for arbitrary JavaScript strings, including embedded delimiters. */
function lengthFramedKey(components: readonly string[]): string {
  return components.map((component) => `${component.length}:${component}`).join('');
}
