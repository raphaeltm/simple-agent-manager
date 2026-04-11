import type { VMSize } from '../types';

// =============================================================================
// VM Size Display (provider-agnostic)
// =============================================================================

/** Generic VM size display info. For provider-specific details (exact specs, price),
 *  use the provider catalog API (GET /api/providers/catalog). */
export const VM_SIZE_LABELS: Record<VMSize, { label: string; shortDescription: string }> = {
  small: { label: 'Small', shortDescription: '2-3 vCPUs, 4 GB RAM' },
  medium: { label: 'Medium', shortDescription: '4 vCPUs, 8-12 GB RAM' },
  large: { label: 'Large', shortDescription: '8 vCPUs, 16-32 GB RAM' },
};

// =============================================================================
// VM Size → vCPU Count Mapping (per provider)
// =============================================================================

/** vCPU counts per VM size, keyed by cloud provider.
 *  Providers have different hardware for the same abstract size. */
export const PROVIDER_VM_SIZE_VCPUS: Record<string, Record<VMSize, number>> = {
  hetzner: { small: 2, medium: 4, large: 8 },
  scaleway: { small: 3, medium: 4, large: 8 },
  gcp: { small: 1, medium: 2, large: 4 },
};

/** Default vCPU counts when provider is unknown. Uses Hetzner as the reference. */
export const DEFAULT_VM_SIZE_VCPUS: Record<VMSize, number> = {
  small: 2,
  medium: 4,
  large: 8,
};

/** Fallback vCPU count when both provider map and default size map miss. */
const VCPU_COUNT_UNKNOWN_FALLBACK = 2;

/** Resolve the vCPU count for a given VM size and optional cloud provider. */
export function getVcpuCount(vmSize: string, cloudProvider?: string | null): number {
  const size = vmSize as VMSize;
  if (cloudProvider) {
    const providerMap = PROVIDER_VM_SIZE_VCPUS[cloudProvider];
    if (providerMap) {
      return providerMap[size] ?? DEFAULT_VM_SIZE_VCPUS[size] ?? VCPU_COUNT_UNKNOWN_FALLBACK;
    }
  }
  return DEFAULT_VM_SIZE_VCPUS[size] ?? VCPU_COUNT_UNKNOWN_FALLBACK;
}