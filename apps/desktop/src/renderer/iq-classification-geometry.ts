export const TRUSTED_IQ_GEOMETRY_CONTEXT_KIND =
  'independently-verified-signal-lab-fixed-profile-geometry-v1' as const;

/**
 * Geometry-only classifier context admitted from a SignalLab measurement and
 * its independently verified fixed-profile capability.
 *
 * Profile identifiers and public classes are deliberately absent: this
 * context may describe the physical sampling transform, never provide a label
 * hint to the classifier.
 */
export interface TrustedIqGeometryContext {
  readonly kind: typeof TRUSTED_IQ_GEOMETRY_CONTEXT_KIND;
  readonly sampleRateHz: number;
  readonly nativeSampleRateHz: number;
}

const TRUSTED_IQ_GEOMETRY_CONTEXT_KEYS = Object.freeze([
  'kind',
  'nativeSampleRateHz',
  'sampleRateHz',
] as const);

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Validate a structured-cloned context at a worker/classifier boundary. */
export function admitTrustedIqGeometryContext(
  value: unknown,
): TrustedIqGeometryContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('trusted I/Q geometry context must be an object');
  }
  const context = value as Record<string, unknown>;
  const keys = Object.keys(context).sort();
  if (
    keys.length !== TRUSTED_IQ_GEOMETRY_CONTEXT_KEYS.length
    || keys.some(
      (key, index) => key !== TRUSTED_IQ_GEOMETRY_CONTEXT_KEYS[index],
    )
  ) {
    throw new RangeError(
      'trusted I/Q geometry context may contain only kind, sampleRateHz, '
      + 'and nativeSampleRateHz',
    );
  }
  if (context.kind !== TRUSTED_IQ_GEOMETRY_CONTEXT_KIND) {
    throw new RangeError('trusted I/Q geometry context kind is unsupported');
  }
  if (!positiveSafeInteger(context.sampleRateHz)) {
    throw new RangeError(
      'trusted I/Q geometry sampleRateHz must be a positive safe integer',
    );
  }
  if (!positiveSafeInteger(context.nativeSampleRateHz)) {
    throw new RangeError(
      'trusted I/Q geometry nativeSampleRateHz must be a positive safe integer',
    );
  }
  return Object.freeze({
    kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
    sampleRateHz: context.sampleRateHz,
    nativeSampleRateHz: context.nativeSampleRateHz,
  });
}

/**
 * Current-profile classification is defined only for a fixed native geometry.
 * Historical/legacy routes remain backward compatible and may omit context.
 */
export function admitIqGeometryForPrototypeSource(
  prototypeSource: 'current' | 'historical',
  value: unknown,
): TrustedIqGeometryContext | undefined {
  if (value === undefined) {
    if (prototypeSource === 'current') {
      throw new RangeError(
        'current I/Q classifier route requires trusted native sample-rate '
        + 'geometry',
      );
    }
    return undefined;
  }
  return admitTrustedIqGeometryContext(value);
}
