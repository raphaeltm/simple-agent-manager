import type { ResourceRequirements } from '@simple-agent-manager/shared';

export class ResourceRequirementsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceRequirementsValidationError';
  }
}

type CompatResourceRequirements = ResourceRequirements & Record<string, unknown>;

const NUMBER_FIELDS = ['minVcpu', 'minMemoryGb', 'minDiskGb', 'maxCoTenants'] as const;

function assertResourceRequirementsObject(
  value: unknown,
  fieldName: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResourceRequirementsValidationError(`${fieldName} must be a JSON object`);
  }
}

export function normalizeResourceRequirementsInput(
  value: unknown,
  fieldName = 'resourceRequirements'
): CompatResourceRequirements {
  assertResourceRequirementsObject(value, fieldName);
  const normalized: CompatResourceRequirements = { ...value };

  for (const field of NUMBER_FIELDS) {
    const fieldValue = normalized[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0) {
      throw new ResourceRequirementsValidationError(
        `${fieldName}.${field} must be a finite non-negative number`
      );
    }
  }

  if (normalized.exclusiveNode !== undefined && typeof normalized.exclusiveNode !== 'boolean') {
    throw new ResourceRequirementsValidationError(`${fieldName}.exclusiveNode must be a boolean`);
  }

  return normalized;
}

export function serializeResourceRequirementsInput(
  value: unknown,
  fieldName = 'resourceRequirements'
): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.stringify(normalizeResourceRequirementsInput(JSON.parse(trimmed), fieldName));
    } catch (err) {
      if (err instanceof ResourceRequirementsValidationError) throw err;
      throw new ResourceRequirementsValidationError(`${fieldName} must be a valid JSON object`);
    }
  }
  return JSON.stringify(normalizeResourceRequirementsInput(value, fieldName));
}

export function parseStoredResourceRequirementsJson(
  value: string | null | undefined
): CompatResourceRequirements | undefined {
  if (!value) return undefined;
  try {
    return normalizeResourceRequirementsInput(JSON.parse(value), 'resourceRequirementsJson');
  } catch {
    return undefined;
  }
}
