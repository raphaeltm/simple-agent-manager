import {
  normalizeResourceRequirements,
  type ResourceRequirements,
  type ResourceResolutionInput,
} from '@simple-agent-manager/shared';

const RESOURCE_LAYER_ORDER = [
  'task',
  'trigger',
  'skill',
  'agentProfile',
  'project',
  'user',
] as const;
type StoredResourceLayerName = (typeof RESOURCE_LAYER_ORDER)[number];

interface ResourceRequirementLayerJsonInput {
  task?: string | null | undefined;
  trigger?: string | null | undefined;
  skill?: string | null | undefined;
  agentProfile?: string | null | undefined;
  project?: string | null | undefined;
  user?: string | null | undefined;
}

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

export function collectStoredResourceRequirementLayers(
  layers: ResourceRequirementLayerJsonInput
): ResourceResolutionInput {
  const input: ResourceResolutionInput = {};
  for (const layer of RESOURCE_LAYER_ORDER) {
    const raw = layers[layer];
    if (raw === undefined || raw === null) continue;
    const parsed = parseStoredResourceRequirementsJson(raw, `${layer}.resourceRequirementsJson`);
    if (parsed !== undefined) input[layer] = parsed;
  }
  return input;
}

export function mergeResourceRequirementLayers(
  base: ResourceResolutionInput,
  overrides: ResourceResolutionInput
): ResourceResolutionInput {
  const filtered: Partial<Record<StoredResourceLayerName, ResourceRequirements>> = {};
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = overrides[layer];
    if (requirements !== undefined) {
      filtered[layer] = requirements;
    }
  }
  return { ...base, ...filtered };
}

export function firstResourceRequirementLayer(
  layers: ResourceResolutionInput
): ResourceRequirements | null {
  for (const layer of RESOURCE_LAYER_ORDER) {
    const requirements = layers[layer];
    if (requirements !== undefined) return requirements;
  }
  return null;
}

export function firstResourceRequirementLayerJson(layers: ResourceResolutionInput): string | null {
  const requirements = firstResourceRequirementLayer(layers);
  return requirements === null ? null : JSON.stringify(requirements);
}
