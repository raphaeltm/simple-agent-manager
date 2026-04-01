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

/**
 * @deprecated Use VM_SIZE_LABELS for display and provider catalog for specs.
 * Kept for backward compatibility with existing node display components.
 */
export const VM_SIZE_CONFIG: Record<VMSize, { hetznerType: string; cpus: number; ram: string }> = {
  small: { hetznerType: 'cx23', cpus: 2, ram: '4GB' },
  medium: { hetznerType: 'cx33', cpus: 4, ram: '8GB' },
  large: { hetznerType: 'cx43', cpus: 8, ram: '16GB' },
};
