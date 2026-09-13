import * as v from 'valibot';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const FiniteNumberSchema = v.pipe(
  v.number(),
  v.check((value: number) => Number.isFinite(value), 'Value must be finite')
);

const PositiveNumberSchema = v.pipe(
  FiniteNumberSchema,
  v.minValue(Number.MIN_VALUE, 'Value must be greater than 0')
);

const NonNegativeNumberSchema = v.pipe(
  FiniteNumberSchema,
  v.minValue(0, 'Value must be greater than or equal to 0')
);

const PositiveSafeIntegerSchema = v.pipe(
  FiniteNumberSchema,
  v.integer('Value must be an integer'),
  v.minValue(1, 'Value must be greater than 0'),
  v.maxValue(MAX_SAFE_INTEGER, 'Value must be a safe integer')
);

/** Resource requirements — all optional, unset fields inherit from precedence chain. */
export const ResourceRequirementsSchema = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    'resourceRequirements must be a JSON object'
  ),
  v.object({
    minVcpu: v.optional(PositiveNumberSchema),
    minMemoryGb: v.optional(PositiveNumberSchema),
    minDiskGb: v.optional(NonNegativeNumberSchema),
    exclusiveNode: v.optional(v.boolean()),
    maxCoTenants: v.optional(PositiveSafeIntegerSchema),
  })
);
