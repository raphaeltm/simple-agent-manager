import type { VMSize } from '@simple-agent-manager/shared';

/** Fallback VM size options used when the provider catalog is unavailable. */
export const FALLBACK_VM_SIZES: { value: VMSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: '2-3 vCPUs, 4 GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8-12 GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16-32 GB RAM' },
];
