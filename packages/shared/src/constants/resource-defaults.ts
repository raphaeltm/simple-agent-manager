import type {
  ResolvedResourceReservation,
  ResourceRequirements,
  ResourceRequirementsSource,
  ResourceResolutionInput,
} from '../types/resource';
import type { VMSize } from '../types/workspace';

// =============================================================================
// Resource Reservation Schema Version
// =============================================================================

/** Current schema version for ResolvedResourceReservation. Bump when fields change. */
export const RESOURCE_RESERVATION_VERSION = 1;

const RESOURCE_REQUIREMENT_FIELDS = [
  'minVcpu',
  'minMemoryMb',
  'minDiskMb',
  'exclusiveNode',
  'maxCoTenants',
  'preset',
] as const;

type RequirementField = (typeof RESOURCE_REQUIREMENT_FIELDS)[number];
type NumericRequirementField = 'minVcpu' | 'minMemoryMb' | 'minDiskMb' | 'maxCoTenants';

export const RESOURCE_REQUIREMENT_LIMITS: Record<NumericRequirementField, { min: number; max: number }> = {
  minVcpu: { min: 1, max: 256 },
  minMemoryMb: { min: 128, max: 2_097_152 },
  minDiskMb: { min: 1_024, max: 10_485_760 },
  maxCoTenants: { min: 1, max: 1_000 },
};

// =============================================================================
// Platform Defaults (bottom of the precedence chain)
// =============================================================================

/** Platform default resource requirements — used when no layer specifies a value. */
export const PLATFORM_RESOURCE_DEFAULTS: Required<ResourceRequirements> = {
  minVcpu: 2,
  minMemoryMb: 4 * 1024,
  minDiskMb: 40 * 1024,
  exclusiveNode: false,
  maxCoTenants: 4,
  preset: 'platform-default',
};

// =============================================================================
// Provider Capacity Map (VM size → concrete capacity)
// =============================================================================

export interface VmCapacity {
  vcpu: number;
  ramGb: number;
  storageGb: number;
}

const HETZNER_VM_CAPACITY: Record<VMSize, VmCapacity> = {
  small: { vcpu: 2, ramGb: 4, storageGb: 40 },
  medium: { vcpu: 4, ramGb: 8, storageGb: 80 },
  large: { vcpu: 8, ramGb: 16, storageGb: 160 },
};

/** Full capacity per VM size per provider. */
export const PROVIDER_VM_CAPACITY: Record<string, Record<VMSize, VmCapacity>> = {
  hetzner: HETZNER_VM_CAPACITY,
  scaleway: {
    small: { vcpu: 3, ramGb: 4, storageGb: 40 },
    medium: { vcpu: 4, ramGb: 12, storageGb: 120 },
    large: { vcpu: 8, ramGb: 32, storageGb: 600 },
  },
  gcp: {
    small: { vcpu: 1, ramGb: 4, storageGb: 50 },
    medium: { vcpu: 2, ramGb: 8, storageGb: 50 },
    large: { vcpu: 4, ramGb: 16, storageGb: 50 },
  },
};

/** Default capacity when provider is unknown. Uses Hetzner as baseline. */
export const DEFAULT_VM_CAPACITY: Record<VMSize, VmCapacity> = HETZNER_VM_CAPACITY;

// =============================================================================
// VM Size Selection from Resource Requirements
// =============================================================================

/**
 * Given resolved resource requirements, pick the smallest VM size that satisfies
 * them for the given provider. Returns 'large' if nothing fits (best-effort).
 */
export function selectVmSizeForRequirements(
  requirements: Required<Omit<ResourceRequirements, 'preset'>> & { preset?: string | null },
  provider: string = 'hetzner',
): VMSize {
  const capacities = PROVIDER_VM_CAPACITY[provider] ?? DEFAULT_VM_CAPACITY;
  const sizes: VMSize[] = ['small', 'medium', 'large'];

  for (const size of sizes) {
    const cap = capacities[size];
    if (
      cap.vcpu >= requirements.minVcpu &&
      cap.ramGb * 1024 >= requirements.minMemoryMb &&
      cap.storageGb * 1024 >= requirements.minDiskMb
    ) {
      return size;
    }
  }

  return 'large'; // best-effort fallback
}

// =============================================================================
// Validation and Resolver: ResourceRequirements → ResolvedResourceReservation
// =============================================================================

interface ResolutionLayer {
  source: ResourceRequirementsSource;
  sourceId: string;
  requirements?: ResourceRequirements;
}

export interface ResourceRequirementsValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePositiveInteger(
  requirements: Record<string, unknown>,
  field: NumericRequirementField,
  errors: string[],
): void {
  const value = requirements[field];
  if (value === undefined) return;
  const limits = RESOURCE_REQUIREMENT_LIMITS[field];
  if (!Number.isInteger(value) || (value as number) < limits.min || (value as number) > limits.max) {
    errors.push(`${field} must be an integer between ${limits.min} and ${limits.max}`);
  }
}

export function validateResourceRequirements(value: unknown): ResourceRequirementsValidationResult {
  if (value === undefined || value === null) {
    return { valid: true, errors: [] };
  }
  if (!isRecord(value)) {
    return { valid: false, errors: ['resource requirements must be an object'] };
  }

  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(RESOURCE_REQUIREMENT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${key} is not a supported resource requirement field`);
    }
  }

  validatePositiveInteger(value, 'minVcpu', errors);
  validatePositiveInteger(value, 'minMemoryMb', errors);
  validatePositiveInteger(value, 'minDiskMb', errors);
  validatePositiveInteger(value, 'maxCoTenants', errors);

  if (value.exclusiveNode !== undefined && typeof value.exclusiveNode !== 'boolean') {
    errors.push('exclusiveNode must be a boolean');
  }
  if (value.preset !== undefined && (typeof value.preset !== 'string' || value.preset.trim().length === 0)) {
    errors.push('preset must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidResourceRequirements(value: unknown): asserts value is ResourceRequirements {
  const result = validateResourceRequirements(value);
  if (!result.valid) {
    throw new Error(result.errors.join('; '));
  }
}

/**
 * Resolve resource requirements from the precedence chain.
 * Each field is independently resolved: the first layer that defines a field wins.
 * Any field not set by any layer falls back to PLATFORM_RESOURCE_DEFAULTS.
 *
 * The `source` field on the output records the highest-priority layer that
 * contributed at least one field. If no layer contributes anything, source is 'platform'.
 */
export function resolveResourceReservation(
  input: ResourceResolutionInput,
  ids: {
    taskId?: string;
    triggerId?: string;
    agentProfileId?: string;
    projectId?: string;
    userId?: string;
  } = {},
): ResolvedResourceReservation {
  const layers: ResolutionLayer[] = [
    { source: 'task', sourceId: ids.taskId ?? '', requirements: input.task },
    { source: 'trigger', sourceId: ids.triggerId ?? '', requirements: input.trigger },
    { source: 'agent-profile', sourceId: ids.agentProfileId ?? '', requirements: input.agentProfile },
    { source: 'project', sourceId: ids.projectId ?? '', requirements: input.project },
    { source: 'user', sourceId: ids.userId ?? '', requirements: input.user },
  ];

  const validationErrors = layers.flatMap((layer) => {
    const result = validateResourceRequirements(layer.requirements);
    return result.valid ? [] : result.errors.map((error) => `${layer.source}: ${error}`);
  });
  if (validationErrors.length > 0) {
    throw new Error(`Invalid resource requirements: ${validationErrors.join('; ')}`);
  }

  const fields: RequirementField[] = [...RESOURCE_REQUIREMENT_FIELDS];

  const resolved: Record<string, unknown> = {};
  const seen = new Set<RequirementField>();
  const fieldSources = {} as ResolvedResourceReservation['fieldSources'];
  let winningSource: ResourceRequirementsSource = 'platform';
  let winningSourceId = 'platform';
  let firstWinnerFound = false;

  for (const layer of layers) {
    if (!layer.requirements) continue;
    const req = layer.requirements;
    let layerContributed = false;

    for (const field of fields) {
      if (seen.has(field)) continue;
      if (req[field] !== undefined) {
        resolved[field] = req[field];
        seen.add(field);
        fieldSources[field] = layer.source;
        layerContributed = true;
      }
    }

    if (layerContributed && !firstWinnerFound) {
      winningSource = layer.source;
      winningSourceId = layer.sourceId;
      firstWinnerFound = true;
    }
  }

  // Fill remaining fields from platform defaults
  for (const field of fields) {
    if (!seen.has(field)) {
      resolved[field] = PLATFORM_RESOURCE_DEFAULTS[field];
      fieldSources[field] = 'platform';
    }
  }

  const minVcpu = resolved['minVcpu'] as number;
  const minMemoryMb = resolved['minMemoryMb'] as number;
  const minDiskMb = resolved['minDiskMb'] as number;

  return {
    cpuMillis: minVcpu * 1000,
    memoryMb: minMemoryMb,
    diskMb: minDiskMb,
    exclusiveNode: resolved['exclusiveNode'] as boolean,
    maxCoTenants: resolved['maxCoTenants'] as number,
    requirements: {
      minVcpu,
      minMemoryMb,
      minDiskMb,
      exclusiveNode: resolved['exclusiveNode'] as boolean,
      maxCoTenants: resolved['maxCoTenants'] as number,
      preset: resolved['preset'] as string | null,
    },
    source: winningSource,
    sourceId: winningSourceId,
    fieldSources,
    version: RESOURCE_RESERVATION_VERSION,
  };
}
