import { z } from 'zod';
import {
  MAX_INSTRUMENT_FREQUENCY_HZ_V1,
  MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1,
  MAX_INSTRUMENT_METADATA_CHARACTERS_V1,
  MAX_INSTRUMENT_POWER_ABS_DB_V1,
  MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1,
  instrumentOpaqueIdSchema,
} from './instrument.js';

/**
 * Canonical Atomizer interaction contract.
 *
 * Device protocols remain free to use their own controls, names, and
 * readback formats behind a driver.  This is the only mutable-control shape
 * an Atomizer presentation is allowed to receive.  In particular, a UI must
 * never manufacture an "automatic" value: every Auto request is resolved by
 * the driver (or by an explicitly declared host operation) and returns its
 * concrete effective value with an evidence qualification.
 */
export const CANONICAL_INSTRUMENT_SURFACE_VERSION = 1 as const;
export const MAX_CANONICAL_PARAMETERS_V1 = 128;
export const MAX_CANONICAL_OPERATIONS_V1 = 32;
export const MAX_CANONICAL_FACTS_V1 = 64;
export const MAX_CANONICAL_ENUM_OPTIONS_V1 = 256;

const canonicalLabelSchema = z.string().trim().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1);
const canonicalDescriptionSchema = z.string().trim().min(1).max(MAX_INSTRUMENT_MESSAGE_CHARACTERS_V1);
const canonicalParameterIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const canonicalOperationIdSchema = canonicalParameterIdSchema;
const canonicalNumberSchema = z.number().finite()
  .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1)
  .max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);
const canonicalIntegerSchema = z.number().int()
  .min(-MAX_INSTRUMENT_FREQUENCY_HZ_V1)
  .max(MAX_INSTRUMENT_FREQUENCY_HZ_V1);

export const canonicalParameterValueKindSchema = z.enum([
  'number',
  'integer',
  'enum',
  'boolean',
  'text',
]);
export type CanonicalParameterValueKind = z.infer<typeof canonicalParameterValueKindSchema>;

export const canonicalParameterScalarValueSchema = z.union([
  canonicalNumberSchema,
  z.boolean(),
  z.string().max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
]);
export type CanonicalParameterScalarValue = z.infer<typeof canonicalParameterScalarValueSchema>;

export const canonicalNumericDomainSchema = z.object({
  min: canonicalNumberSchema,
  max: canonicalNumberSchema,
  step: z.number().finite().positive().max(MAX_INSTRUMENT_SAMPLE_RATE_HZ_V1).optional(),
}).strict().superRefine((domain, context) => {
  if (domain.max < domain.min) {
    context.addIssue({ code: 'custom', path: ['max'], message: 'Parameter-domain maximum must not be below its minimum' });
  }
});
export type CanonicalNumericDomain = z.infer<typeof canonicalNumericDomainSchema>;

const canonicalEnumOptionSchema = z.object({
  value: z.string().min(1).max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
  label: canonicalLabelSchema,
  description: canonicalDescriptionSchema.optional(),
}).strict();

export const canonicalParameterManualDomainSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), range: canonicalNumericDomainSchema }).strict(),
  z.object({ kind: z.literal('integer'), range: canonicalNumericDomainSchema }).strict().superRefine((domain, context) => {
    for (const key of ['min', 'max', 'step'] as const) {
      const value = domain.range[key];
      if (value !== undefined && !Number.isInteger(value)) {
        context.addIssue({ code: 'custom', path: ['range', key], message: 'Integer parameter domains require integer bounds and step' });
      }
    }
  }),
  z.object({
    kind: z.literal('enum'),
    options: z.array(canonicalEnumOptionSchema).min(1).max(MAX_CANONICAL_ENUM_OPTIONS_V1),
  }).strict().superRefine((domain, context) => {
    if (new Set(domain.options.map((option) => option.value)).size !== domain.options.length) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'Enum parameter options must have unique values' });
    }
  }),
  z.object({ kind: z.literal('boolean') }).strict(),
  z.object({
    kind: z.literal('text'),
    minimumLength: z.number().int().nonnegative().max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1).default(0),
    maximumLength: z.number().int().positive().max(MAX_INSTRUMENT_METADATA_CHARACTERS_V1),
    pattern: z.string().min(1).max(256).optional(),
  }).strict().superRefine((domain, context) => {
    if (domain.maximumLength < domain.minimumLength) {
      context.addIssue({ code: 'custom', path: ['maximumLength'], message: 'Text parameter maximum length must not be below its minimum' });
    }
  }),
]);
export type CanonicalParameterManualDomain = z.infer<typeof canonicalParameterManualDomainSchema>;

/** A parameter always accepts both explicit manual input and Auto intent. */
export const canonicalParameterIntentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('manual'), value: canonicalParameterScalarValueSchema }).strict(),
]);
export type CanonicalParameterIntent = z.infer<typeof canonicalParameterIntentSchema>;

export const canonicalParameterVerificationSchema = z.enum([
  'device-readback',
  'driver-selected',
  'driver-commanded',
  'host-derived',
]);
export type CanonicalParameterVerification = z.infer<typeof canonicalParameterVerificationSchema>;

export const canonicalParameterSchema = z.object({
  id: canonicalParameterIdSchema,
  label: canonicalLabelSchema,
  group: canonicalLabelSchema,
  unit: z.string().trim().min(1).max(32).optional(),
  manual: canonicalParameterManualDomainSchema,
  /**
   * Required, rather than an optional "supportsAuto" flag: an editable item
   * without a legitimate automatic policy is a fact, not a canonical
   * parameter. `resolver` tells the UI whose effective value it is showing.
   */
  auto: z.object({
    resolver: z.enum(['driver', 'host']),
    description: canonicalDescriptionSchema,
  }).strict(),
  requested: canonicalParameterIntentSchema,
  effectiveValue: canonicalParameterScalarValueSchema,
  verification: canonicalParameterVerificationSchema,
}).strict().superRefine((parameter, context) => {
  const manual = parameter.manual;
  const effective = parameter.effectiveValue;
  const requested = parameter.requested;
  const values = requested.mode === 'manual' ? [requested.value, effective] : [effective];
  for (const [index, value] of values.entries()) {
    const path = index === 0 && requested.mode === 'manual' ? ['requested', 'value'] : ['effectiveValue'];
    if ((manual.kind === 'number' || manual.kind === 'integer') && typeof value !== 'number') {
      context.addIssue({ code: 'custom', path, message: `${manual.kind} parameter values must be numeric` });
    } else if (manual.kind === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      context.addIssue({ code: 'custom', path, message: 'Integer parameter values must be integers' });
    } else if (manual.kind === 'enum' && (typeof value !== 'string' || !manual.options.some((option) => option.value === value))) {
      context.addIssue({ code: 'custom', path, message: 'Enum parameter values must be advertised option values' });
    } else if (manual.kind === 'boolean' && typeof value !== 'boolean') {
      context.addIssue({ code: 'custom', path, message: 'Boolean parameter values must be boolean' });
    } else if (manual.kind === 'text' && (typeof value !== 'string' || value.length < manual.minimumLength || value.length > manual.maximumLength)) {
      context.addIssue({ code: 'custom', path, message: 'Text parameter values must satisfy the declared length domain' });
    }
    if ((manual.kind === 'number' || manual.kind === 'integer') && typeof value === 'number'
      && (value < manual.range.min || value > manual.range.max)) {
      context.addIssue({ code: 'custom', path, message: 'Numeric parameter value lies outside the declared manual domain' });
    }
  }
});
export type CanonicalParameter = z.infer<typeof canonicalParameterSchema>;

export const canonicalAcquisitionKindSchema = z.enum([
  'swept-spectrum',
  'complex-iq',
  'detected-power-timeseries',
]);
export type CanonicalAcquisitionKind = z.infer<typeof canonicalAcquisitionKindSchema>;

/**
 * A driver-declared relationship between two numeric operation parameters.
 * This keeps cross-setting safety inside the canonical surface rather than
 * asking Atomizer to recognize a particular device or control family.
 */
export const canonicalOperationConstraintSchema = z.object({
  kind: z.literal('numeric-relation'),
  leftParameterId: canonicalParameterIdSchema,
  relation: z.enum(['less-than', 'less-than-or-equal', 'greater-than', 'greater-than-or-equal']),
  rightParameterId: canonicalParameterIdSchema,
  message: canonicalDescriptionSchema,
}).strict().superRefine((constraint, context) => {
  if (constraint.leftParameterId === constraint.rightParameterId) {
    context.addIssue({ code: 'custom', path: ['rightParameterId'], message: 'A parameter relation must name two different parameters' });
  }
});
export type CanonicalOperationConstraint = z.infer<typeof canonicalOperationConstraintSchema>;

export const canonicalOperationSchema = z.object({
  id: canonicalOperationIdSchema,
  label: canonicalLabelSchema,
  description: canonicalDescriptionSchema.optional(),
  /**
   * A device-neutral placement hint.  It lets one homogeneous surface expose
   * source setup beside acquisition without asking a renderer to identify the
   * connected driver or native control family.  Omitted remains compatible
   * with the first acquisition-only surface revision.
   */
  scope: z.enum(['acquisition', 'source', 'instrument']).optional(),
  /**
   * The homogeneous result shape configured by an acquisition operation.
   * Renderers route generic commands by this field rather than labels,
   * outputs, or device-specific operation IDs.
   */
  acquisitionKind: canonicalAcquisitionKindSchema.optional(),
  parameterIds: z.array(canonicalParameterIdSchema).max(MAX_CANONICAL_PARAMETERS_V1),
  constraints: z.array(canonicalOperationConstraintSchema).max(MAX_CANONICAL_PARAMETERS_V1).optional(),
  outputs: z.array(canonicalLabelSchema).max(16).default([]),
  availability: z.enum(['available', 'busy', 'unavailable']),
  primary: z.boolean().default(false),
  confirmation: z.enum(['none', 'high-impact']).default('none'),
}).strict().superRefine((operation, context) => {
  if (new Set(operation.parameterIds).size !== operation.parameterIds.length) {
    context.addIssue({ code: 'custom', path: ['parameterIds'], message: 'Operation parameter IDs must be unique' });
  }
  if (operation.acquisitionKind !== undefined && operation.scope !== 'acquisition') {
    context.addIssue({
      code: 'custom',
      path: ['acquisitionKind'],
      message: 'Acquisition kind is valid only for acquisition operations',
    });
  }
});
export type CanonicalOperation = z.infer<typeof canonicalOperationSchema>;

export const canonicalInstrumentFactSchema = z.object({
  label: canonicalLabelSchema,
  value: canonicalDescriptionSchema,
  detail: canonicalDescriptionSchema.optional(),
}).strict();
export type CanonicalInstrumentFact = z.infer<typeof canonicalInstrumentFactSchema>;

export const canonicalInstrumentPresentationSchema = z.object({
  title: canonicalLabelSchema,
  subtitle: canonicalDescriptionSchema.optional(),
  qualification: canonicalLabelSchema,
  facts: z.array(canonicalInstrumentFactSchema).max(MAX_CANONICAL_FACTS_V1).default([]),
}).strict();
export type CanonicalInstrumentPresentation = z.infer<typeof canonicalInstrumentPresentationSchema>;

export const canonicalInstrumentSurfaceSchema = z.object({
  schemaVersion: z.literal(CANONICAL_INSTRUMENT_SURFACE_VERSION),
  revision: instrumentOpaqueIdSchema,
  presentation: canonicalInstrumentPresentationSchema,
  parameters: z.array(canonicalParameterSchema).max(MAX_CANONICAL_PARAMETERS_V1),
  operations: z.array(canonicalOperationSchema).min(1).max(MAX_CANONICAL_OPERATIONS_V1),
}).strict().superRefine((surface, context) => {
  const parameterIds = surface.parameters.map((parameter) => parameter.id);
  if (new Set(parameterIds).size !== parameterIds.length) {
    context.addIssue({ code: 'custom', path: ['parameters'], message: 'Canonical parameter IDs must be unique' });
  }
  const operationIds = surface.operations.map((operation) => operation.id);
  if (new Set(operationIds).size !== operationIds.length) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'Canonical operation IDs must be unique' });
  }
  if (surface.operations.filter((operation) => operation.primary).length > 1) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'A canonical surface can declare at most one primary operation' });
  }
  const parameterIdSet = new Set(parameterIds);
  const parametersById = new Map(surface.parameters.map((parameter) => [parameter.id, parameter] as const));
  for (const [operationIndex, operation] of surface.operations.entries()) {
    for (const [parameterIndex, parameterId] of operation.parameterIds.entries()) {
      if (!parameterIdSet.has(parameterId)) {
        context.addIssue({
          code: 'custom',
          path: ['operations', operationIndex, 'parameterIds', parameterIndex],
          message: `Operation references undeclared parameter ${parameterId}`,
        });
      }
    }
    const operationParameterIds = new Set(operation.parameterIds);
    for (const [constraintIndex, constraint] of (operation.constraints ?? []).entries()) {
      for (const side of ['leftParameterId', 'rightParameterId'] as const) {
        const parameterId = constraint[side];
        const parameter = parametersById.get(parameterId);
        if (!operationParameterIds.has(parameterId)) {
          context.addIssue({
            code: 'custom',
            path: ['operations', operationIndex, 'constraints', constraintIndex, side],
            message: `Operation constraint references parameter ${parameterId} outside this operation`,
          });
        } else if (parameter?.manual.kind !== 'number' && parameter?.manual.kind !== 'integer') {
          context.addIssue({
            code: 'custom',
            path: ['operations', operationIndex, 'constraints', constraintIndex, side],
            message: 'Numeric parameter relations require numeric or integer parameters',
          });
        }
      }
    }
  }
});
export type CanonicalInstrumentSurface = z.infer<typeof canonicalInstrumentSurfaceSchema>;

export const canonicalOperationParameterIntentSchema = z.object({
  parameterId: canonicalParameterIdSchema,
  intent: canonicalParameterIntentSchema,
}).strict();
export type CanonicalOperationParameterIntent = z.infer<typeof canonicalOperationParameterIntentSchema>;

export const canonicalOperationRequestSchema = z.object({
  sessionId: instrumentOpaqueIdSchema,
  surfaceRevision: instrumentOpaqueIdSchema,
  operationId: canonicalOperationIdSchema,
  parameters: z.array(canonicalOperationParameterIntentSchema).max(MAX_CANONICAL_PARAMETERS_V1),
}).strict().superRefine((request, context) => {
  if (new Set(request.parameters.map((parameter) => parameter.parameterId)).size !== request.parameters.length) {
    context.addIssue({ code: 'custom', path: ['parameters'], message: 'Operation parameter intents must be unique' });
  }
});
export type CanonicalOperationRequest = z.infer<typeof canonicalOperationRequestSchema>;

export const canonicalOperationResultSchema = z.object({
  sessionId: instrumentOpaqueIdSchema,
  operationId: canonicalOperationIdSchema,
  surface: canonicalInstrumentSurfaceSchema,
}).strict();
export type CanonicalOperationResult = z.infer<typeof canonicalOperationResultSchema>;

/** Reusable guard for a driver before it accepts a generic operation request. */
export function canonicalOperationParameterIntentsFor(
  surface: CanonicalInstrumentSurface,
  operationId: string,
  value: unknown,
): ReadonlyMap<string, CanonicalParameterIntent> {
  const request = canonicalOperationRequestSchema.parse(value);
  if (request.surfaceRevision !== surface.revision) {
    throw new RangeError('Canonical operation targets a stale instrument surface revision');
  }
  if (request.operationId !== operationId) {
    throw new RangeError(`Canonical operation request ${request.operationId} does not match ${operationId}`);
  }
  const operation = surface.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new RangeError(`Canonical operation ${operationId} is not advertised`);
  if (operation.availability !== 'available') throw new RangeError(`Canonical operation ${operationId} is ${operation.availability}`);
  const requestedIds = new Set(request.parameters.map((parameter) => parameter.parameterId));
  for (const parameterId of operation.parameterIds) {
    if (!requestedIds.has(parameterId)) {
      throw new RangeError(`Canonical operation ${operationId} is missing parameter ${parameterId}`);
    }
  }
  if (request.parameters.some((parameter) => !operation.parameterIds.includes(parameter.parameterId))) {
    throw new RangeError(`Canonical operation ${operationId} received a parameter it does not own`);
  }
  const intents = new Map(request.parameters.map((parameter) => [parameter.parameterId, parameter.intent] as const));
  for (const constraint of operation.constraints ?? []) {
    const left = intents.get(constraint.leftParameterId);
    const right = intents.get(constraint.rightParameterId);
    // A recommended value is deliberately resolved by the driver as part of
    // its complete configuration. Only two explicit numeric custom values are
    // a deterministic relation that this portable request guard can reject.
    if (left?.mode !== 'manual' || right?.mode !== 'manual'
      || typeof left.value !== 'number' || typeof right.value !== 'number') continue;
    if (numericConstraintRelationHolds(left.value, constraint.relation, right.value)) continue;
    throw new RangeError(constraint.message);
  }
  return intents;
}

function numericConstraintRelationHolds(
  left: number,
  relation: CanonicalOperationConstraint['relation'],
  right: number,
): boolean {
  switch (relation) {
    case 'less-than': return left < right;
    case 'less-than-or-equal': return left <= right;
    case 'greater-than': return left > right;
    case 'greater-than-or-equal': return left >= right;
  }
}
