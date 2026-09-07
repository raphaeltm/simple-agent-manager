import {
  normalizeResourceRequirements,
  type ResourceRequirements,
} from '@simple-agent-manager/shared';

export class ResourceRequirementsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceRequirementsValidationError';
  }
}

export function normalizeResourceRequirementsInput(
  value: unknown,
  fieldName = 'resourceRequirements'
): ResourceRequirements {
  try {
    return normalizeResourceRequirements(value);
  } catch (err) {
    if (err instanceof Error) {
      throw new ResourceRequirementsValidationError(
        err.message.replace(/^resourceRequirements(?=\.| |$)/, fieldName)
      );
    }
    throw err;
  }
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
  value: string | null | undefined,
  fieldName = 'resourceRequirementsJson'
): ResourceRequirements | undefined {
  if (!value) return undefined;
  try {
    return normalizeResourceRequirementsInput(JSON.parse(value), fieldName);
  } catch (err) {
    if (err instanceof ResourceRequirementsValidationError) {
      throw new ResourceRequirementsValidationError(`${fieldName} is malformed: ${err.message}`);
    }
    throw new ResourceRequirementsValidationError(`${fieldName} is malformed`);
  }
}
