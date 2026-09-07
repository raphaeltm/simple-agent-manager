import type { ResourceRequirementField, ResourceRequirements } from './types/resource';

export interface NormalizeResourceRequirementsOptions {
  requireAllFields?: boolean;
}

export const RESOURCE_REQUIREMENT_FIELDS = [
  'minVcpu',
  'minMemoryGb',
  'minDiskGb',
  'exclusiveNode',
  'maxCoTenants',
] as const satisfies readonly ResourceRequirementField[];

export type ReservationUnitResourceField = Extract<
  ResourceRequirementField,
  'minVcpu' | 'minMemoryGb' | 'minDiskGb'
>;

const RESERVATION_UNIT_MULTIPLIERS: Record<ReservationUnitResourceField, number> = {
  minVcpu: 1000,
  minMemoryGb: 1024,
  minDiskGb: 1024,
};

const MAX_RESERVATION_UNIT = Number.MAX_SAFE_INTEGER;

/**
 * Validate and normalize unknown workload resource requirements.
 *
 * The returned object contains only supported own fields. Undefined/null
 * semantics belong to adapters before calling this function; this function
 * accepts only object values and treats an empty object as valid inheritance.
 */
export function normalizeResourceRequirements(
  value: unknown,
  options: NormalizeResourceRequirementsOptions = {}
): ResourceRequirements {
  assertResourceRequirementsObject(value);

  const normalized: ResourceRequirements = {};
  for (const field of RESOURCE_REQUIREMENT_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      if (options.requireAllFields === true) {
        throw new Error(`resourceRequirements.${field} is required`);
      }
      continue;
    }

    const fieldValue = value[field as keyof typeof value];
    if (fieldValue === undefined) {
      if (options.requireAllFields === true) {
        throw new Error(`resourceRequirements.${field} is required`);
      }
      continue;
    }
    setResourceRequirementField(normalized, field, normalizeResourceRequirementField(field, fieldValue));
  }

  return normalized;
}

export function resourceRequirementToReservationUnit(
  field: ReservationUnitResourceField,
  value: number
): number {
  const multiplier = RESERVATION_UNIT_MULTIPLIERS[field];
  const units = Math.ceil(value * multiplier);
  const allowsZero = field === 'minDiskGb';
  if (
    !Number.isSafeInteger(units) ||
    units > MAX_RESERVATION_UNIT ||
    (allowsZero ? units < 0 : units <= 0)
  ) {
    throw new Error(`resourceRequirements.${field} converts to unsafe reservation units`);
  }
  return units;
}

function assertResourceRequirementsObject(
  value: unknown
): asserts value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('resourceRequirements must be a JSON object');
  }
}

function normalizeResourceRequirementField(
  field: ResourceRequirementField,
  value: unknown
): number | boolean {
  if (field === 'exclusiveNode') {
    if (typeof value === 'boolean') return value;
    throw new Error('resourceRequirements.exclusiveNode must be a boolean');
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`resourceRequirements.${field} must be a finite number`);
  }

  if (field === 'maxCoTenants') {
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw new Error('resourceRequirements.maxCoTenants must be a positive safe integer');
  }

  if (field === 'minVcpu' || field === 'minMemoryGb') {
    if (value <= 0) {
      throw new Error(`resourceRequirements.${field} must be a finite positive number`);
    }
    resourceRequirementToReservationUnit(field, value);
    return value;
  }

  if (value < 0) {
    throw new Error('resourceRequirements.minDiskGb must be a finite non-negative number');
  }
  resourceRequirementToReservationUnit(field, value);
  return value;
}

function setResourceRequirementField(
  target: ResourceRequirements,
  field: ResourceRequirementField,
  value: number | boolean
): void {
  switch (field) {
    case 'minVcpu':
    case 'minMemoryGb':
    case 'minDiskGb':
    case 'maxCoTenants':
      if (typeof value !== 'number') {
        throw new Error(`resourceRequirements.${field} must be a number`);
      }
      target[field] = value;
      return;
    case 'exclusiveNode':
      if (typeof value !== 'boolean') {
        throw new Error('resourceRequirements.exclusiveNode must be a boolean');
      }
      target[field] = value;
      return;
  }
}
