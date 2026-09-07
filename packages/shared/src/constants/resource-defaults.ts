import {
  normalizeResourceRequirements,
  RESOURCE_REQUIREMENT_FIELDS,
  resourceRequirementToReservationUnit,
} from '../resource-requirements';
import type {
  LegacyVmSizeResolutionInput,
  ResolvedResourceReservation,
  ResourceRequirementField,
  ResourceRequirementFieldProvenance,
  ResourceRequirementProvenance,
  ResourceRequirements,
  ResourceRequirementsSource,
  ResourceResolutionInput,
} from '../types/resource';
import type { VMSize } from '../types/workspace';

// =============================================================================
// Resource Reservation Schema Version
// =============================================================================

/** Current schema version for ResolvedResourceReservation. Bump when fields change. */
export const RESOURCE_RESERVATION_VERSION = 2;

export const LEGACY_VM_SIZE_WORKLOAD_ADAPTER = 'legacy-vm-size-workload';
export const LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION = 1;

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

/**
 * Compatibility defaults for deprecated small/medium/large values.
 *
 * These are workload slices, not historical whole-VM shapes. Deployments can
 * override them through persisted capacity-pool settings or environment
 * fallback; the version/provenance is persisted on resolved reservations.
 */
export const DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS: Record<
  VMSize,
  Required<ResourceRequirements>
> = {
  small: {
    minVcpu: 1,
    minMemoryGb: 2,
    minDiskGb: 20,
    exclusiveNode: false,
    maxCoTenants: 4,
  },
  medium: {
    minVcpu: 2,
    minMemoryGb: 4,
    minDiskGb: 40,
    exclusiveNode: false,
    maxCoTenants: 3,
  },
  large: {
    minVcpu: 4,
    minMemoryGb: 8,
    minDiskGb: 80,
    exclusiveNode: false,
    maxCoTenants: 2,
  },
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
export const PROVIDER_VM_CAPACITY: Record<string, Record<VMSize, VmCapacity>> & {
  hetzner: Record<VMSize, VmCapacity>;
} = {
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
  infomaniak: {
    small: { vcpu: 2, ramGb: 4, storageGb: 20 },
    medium: { vcpu: 4, ramGb: 8, storageGb: 20 },
    large: { vcpu: 8, ramGb: 16, storageGb: 20 },
  },
  digitalocean: {
    small: { vcpu: 2, ramGb: 4, storageGb: 80 },
    medium: { vcpu: 4, ramGb: 8, storageGb: 160 },
    large: { vcpu: 8, ramGb: 16, storageGb: 320 },
  },
  upcloud: {
    small: { vcpu: 2, ramGb: 4, storageGb: 50 },
    medium: { vcpu: 4, ramGb: 8, storageGb: 80 },
    large: { vcpu: 8, ramGb: 16, storageGb: 160 },
  },
};

/** Default capacity when provider is unknown. Uses Hetzner as baseline. */
export const DEFAULT_VM_CAPACITY: Record<VMSize, VmCapacity> = PROVIDER_VM_CAPACITY.hetzner;

// =============================================================================
// VM Size Selection from Resource Requirements
// =============================================================================

/**
 * Given resolved resource requirements, pick the smallest VM size that satisfies
 * them for the given provider. Returns 'large' if nothing fits (best-effort).
 */
export function selectVmSizeForRequirements(
  requirements: Required<ResourceRequirements>,
  provider: string = 'hetzner'
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
  legacyVmSize?: VMSize;
}

export interface ResourceReservationResolutionOptions {
  platformDefaults?: Required<ResourceRequirements>;
  legacyVmSizes?: LegacyVmSizeResolutionInput;
  legacyWorkloadMapping?: Record<VMSize, Required<ResourceRequirements>>;
  compatibilityAdapterVersion?: number;
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
    skillId?: string;
    agentProfileId?: string;
    projectId?: string;
    userId?: string;
  } = {},
  options: ResourceReservationResolutionOptions = {}
): ResolvedResourceReservation {
  const platformDefaults = validateResourceRequirementsLayer(
    'platform',
    'platform',
    options.platformDefaults ?? PLATFORM_RESOURCE_DEFAULTS
  ) as Required<ResourceRequirements>;
  const legacyWorkloadMapping = options.legacyWorkloadMapping
    ? validateLegacyWorkloadMapping(options.legacyWorkloadMapping)
    : DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS;
  const compatibilityAdapterVersion =
    options.compatibilityAdapterVersion ?? LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION;
  const layers: ResolutionLayer[] = [
    {
      source: 'task',
      sourceId: ids.taskId ?? '',
      requirements: input.task,
      legacyVmSize: options.legacyVmSizes?.task,
    },
    {
      source: 'trigger',
      sourceId: ids.triggerId ?? '',
      requirements: input.trigger,
      legacyVmSize: options.legacyVmSizes?.trigger,
    },
    {
      source: 'skill',
      sourceId: ids.skillId ?? '',
      requirements: input.skill,
      legacyVmSize: options.legacyVmSizes?.skill,
    },
    {
      source: 'agent-profile',
      sourceId: ids.agentProfileId ?? '',
      requirements: input.agentProfile,
      legacyVmSize: options.legacyVmSizes?.['agent-profile'],
    },
    {
      source: 'project',
      sourceId: ids.projectId ?? '',
      requirements: input.project,
      legacyVmSize: options.legacyVmSizes?.project,
    },
    {
      source: 'user',
      sourceId: ids.userId ?? '',
      requirements: input.user,
      legacyVmSize: options.legacyVmSizes?.user,
    },
  ];

  const resolved: Record<string, unknown> = {};
  const provenance: ResourceRequirementProvenance = {};
  const diagnostics: string[] = [];
  const seen = new Set<ResourceRequirementField>();
  let winningSource: ResourceRequirementsSource = 'platform';
  let winningSourceId = 'platform';
  let firstWinnerFound = false;

  const recordLayerContribution = (
    layer: ResolutionLayer,
    req: { requirements: ResourceRequirements; provenance: ResourceRequirementProvenance }
  ): void => {
    for (const field of RESOURCE_REQUIREMENT_FIELDS) {
      if (seen.has(field)) continue;
      const fieldValue = req.requirements[field];
      if (fieldValue !== undefined) {
        resolved[field] = fieldValue;
        seen.add(field);
        provenance[field] = req.provenance[field];
        if (!firstWinnerFound) {
          winningSource = layer.source;
          winningSourceId = layer.sourceId;
          firstWinnerFound = true;
        }
      }
    }
  };

  for (const layer of layers) {
    const explicit = validatedExplicitLayer(layer);
    if (explicit) recordLayerContribution(layer, explicit);

    const legacy = validatedLegacyLayer(layer, {
      mapping: legacyWorkloadMapping,
      adapterVersion: compatibilityAdapterVersion,
      diagnostics,
    });
    if (legacy) recordLayerContribution(layer, legacy);
  }

  // Fill remaining fields from platform defaults
  for (const field of RESOURCE_REQUIREMENT_FIELDS) {
    if (!seen.has(field)) {
      resolved[field] = platformDefaults[field];
      provenance[field] = {
        source: 'platform',
        sourceId: 'platform',
        value: platformDefaults[field],
      };
    }
  }

  const minVcpu = resolved['minVcpu'] as number;
  const minMemoryGb = resolved['minMemoryGb'] as number;
  const minDiskGb = resolved['minDiskGb'] as number;
  const cpuMillis = resourceRequirementToReservationUnit('minVcpu', minVcpu);
  const memoryMb = resourceRequirementToReservationUnit('minMemoryGb', minMemoryGb);
  const diskMb = resourceRequirementToReservationUnit('minDiskGb', minDiskGb);

  return {
    cpuMillis,
    memoryMb,
    diskMb,
    exclusiveNode: resolved['exclusiveNode'] as boolean,
    maxCoTenants: resolved['maxCoTenants'] as number,
    source: winningSource,
    sourceId: winningSourceId,
    version: RESOURCE_RESERVATION_VERSION,
    fieldProvenance: provenance,
    diagnostics,
  };
}

function validatedExplicitLayer(
  layer: ResolutionLayer
): { requirements: ResourceRequirements; provenance: ResourceRequirementProvenance } | null {
  const explicit = validateResourceRequirementsLayer(
    layer.source,
    layer.sourceId,
    layer.requirements
  );
  if (!explicit) return null;
  const provenance: ResourceRequirementProvenance = {};
  let hasValue = false;

  for (const field of RESOURCE_REQUIREMENT_FIELDS) {
    const explicitValue = explicit[field];
    if (explicitValue === undefined) continue;
    provenance[field] = { source: layer.source, sourceId: layer.sourceId, value: explicitValue };
    hasValue = true;
  }

  return hasValue ? { requirements: explicit, provenance } : null;
}

function validatedLegacyLayer(
  layer: ResolutionLayer,
  options: {
    mapping: Record<VMSize, Required<ResourceRequirements>>;
    adapterVersion: number;
    diagnostics: string[];
  }
): { requirements: ResourceRequirements; provenance: ResourceRequirementProvenance } | null {
  const provenance: ResourceRequirementProvenance = {};
  const merged: ResourceRequirements = {};
  if (!layer.legacyVmSize) return null;

  const legacyDefaults = options.mapping[layer.legacyVmSize];
  for (const field of RESOURCE_REQUIREMENT_FIELDS) {
    const legacyValue = legacyDefaults[field];
    setNormalizedResourceRequirementField(merged, field, legacyValue);
    provenance[field] = legacyFieldProvenance(layer, legacyValue, options.adapterVersion);
  }
  options.diagnostics.push(
    `${layer.source}:${layer.legacyVmSize}:mapped-by-${LEGACY_VM_SIZE_WORKLOAD_ADAPTER}-v${options.adapterVersion}`
  );

  return { requirements: merged, provenance };
}

function setNormalizedResourceRequirementField(
  target: ResourceRequirements,
  field: ResourceRequirementField,
  value: number | boolean
): void {
  if (field === 'exclusiveNode') {
    target.exclusiveNode = value as boolean;
    return;
  }
  target[field] = value as number;
}

function legacyFieldProvenance(
  layer: ResolutionLayer,
  value: number | boolean,
  adapterVersion: number
): ResourceRequirementFieldProvenance {
  return {
    source: layer.source,
    sourceId: layer.sourceId,
    value,
    compatibility: {
      adapter: LEGACY_VM_SIZE_WORKLOAD_ADAPTER,
      version: adapterVersion,
      legacyVmSize: layer.legacyVmSize as VMSize,
    },
  };
}

function validateLegacyWorkloadMapping(
  mapping: Record<VMSize, Required<ResourceRequirements>>
): Record<VMSize, Required<ResourceRequirements>> {
  return {
    small: validateResourceRequirementsLayer('platform', 'legacy:small', mapping.small, {
      requireAllFields: true,
    }) as Required<ResourceRequirements>,
    medium: validateResourceRequirementsLayer('platform', 'legacy:medium', mapping.medium, {
      requireAllFields: true,
    }) as Required<ResourceRequirements>,
    large: validateResourceRequirementsLayer('platform', 'legacy:large', mapping.large, {
      requireAllFields: true,
    }) as Required<ResourceRequirements>,
  };
}

function validateResourceRequirementsLayer(
  source: ResourceRequirementsSource,
  sourceId: string,
  requirements: ResourceRequirements | undefined,
  options: { requireAllFields?: boolean } = {}
): ResourceRequirements | undefined {
  if (!requirements) return undefined;
  try {
    return normalizeResourceRequirements(requirements, options);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Invalid ${source} resource requirements ${sourceId}: ${err.message}`);
    }
    throw err;
  }
}
