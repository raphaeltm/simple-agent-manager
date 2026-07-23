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

// =============================================================================
// Platform Defaults (bottom of the precedence chain)
// =============================================================================

/** Platform default resource requirements — used when no layer specifies a value. */
export const PLATFORM_RESOURCE_DEFAULTS: Required<ResourceRequirements> = {
  minVcpu: 2,
  minMemoryGb: 4,
  minDiskGb: 40,
  exclusiveNode: false,
  maxCoTenants: 4,
};

// =============================================================================
// Provider Capacity Map (VM size → concrete capacity)
// =============================================================================

export interface VmCapacity {
  vcpu: number;
  ramGb: number;
  storageGb: number;
}

/** Full capacity per VM size per provider. */
export const PROVIDER_VM_CAPACITY: Record<string, Record<VMSize, VmCapacity>> = {
  hetzner: {
    small: { vcpu: 2, ramGb: 4, storageGb: 40 },
    medium: { vcpu: 4, ramGb: 8, storageGb: 80 },
    large: { vcpu: 8, ramGb: 16, storageGb: 160 },
  },
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
  vultr: {
    small: { vcpu: 2, ramGb: 4, storageGb: 80 },
    medium: { vcpu: 4, ramGb: 8, storageGb: 160 },
    large: { vcpu: 6, ramGb: 16, storageGb: 320 },
  },
};

/** Default capacity when provider is unknown. Uses Hetzner as baseline. */
export const DEFAULT_VM_CAPACITY: Record<VMSize, VmCapacity> =
  PROVIDER_VM_CAPACITY['hetzner']!;

// =============================================================================
// VM Size Selection from Resource Requirements
// =============================================================================

/**
 * Given resolved resource requirements, pick the smallest VM size that satisfies
 * them for the given provider. Returns 'large' if nothing fits (best-effort).
 */
export function selectVmSizeForRequirements(
  requirements: Required<ResourceRequirements>,
  provider: string = 'hetzner',
): VMSize {
  const capacities = PROVIDER_VM_CAPACITY[provider] ?? DEFAULT_VM_CAPACITY;
  const sizes: VMSize[] = ['small', 'medium', 'large'];

  for (const size of sizes) {
    const cap = capacities[size];
    if (
      cap.vcpu >= requirements.minVcpu &&
      cap.ramGb >= requirements.minMemoryGb &&
      cap.storageGb >= requirements.minDiskGb
    ) {
      return size;
    }
  }

  return 'large'; // best-effort fallback
}

// =============================================================================
// Resolver: ResourceRequirements → ResolvedResourceReservation
// =============================================================================

interface ResolutionLayer {
  source: ResourceRequirementsSource;
  sourceId: string;
  requirements?: ResourceRequirements;
}

type RequirementField = keyof ResourceRequirements;

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
    skillId?: string;
    agentProfileId?: string;
    projectId?: string;
    userId?: string;
  } = {},
): ResolvedResourceReservation {
  const layers: ResolutionLayer[] = [
    { source: 'task', sourceId: ids.taskId ?? '', requirements: input.task },
    { source: 'trigger', sourceId: ids.triggerId ?? '', requirements: input.trigger },
    { source: 'skill', sourceId: ids.skillId ?? '', requirements: input.skill },
    { source: 'agent-profile', sourceId: ids.agentProfileId ?? '', requirements: input.agentProfile },
    { source: 'project', sourceId: ids.projectId ?? '', requirements: input.project },
    { source: 'user', sourceId: ids.userId ?? '', requirements: input.user },
  ];

  const fields: RequirementField[] = [
    'minVcpu', 'minMemoryGb', 'minDiskGb', 'exclusiveNode', 'maxCoTenants',
  ];

  const resolved: Record<string, unknown> = {};
  const seen = new Set<RequirementField>();
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
    }
  }

  const minVcpu = resolved['minVcpu'] as number;
  const minMemoryGb = resolved['minMemoryGb'] as number;
  const minDiskGb = resolved['minDiskGb'] as number;

  return {
    cpuMillis: minVcpu * 1000,
    memoryMb: minMemoryGb * 1024,
    diskMb: minDiskGb * 1024,
    exclusiveNode: resolved['exclusiveNode'] as boolean,
    maxCoTenants: resolved['maxCoTenants'] as number,
    source: winningSource,
    sourceId: winningSourceId,
    version: RESOURCE_RESERVATION_VERSION,
  };
}
