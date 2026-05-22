import type { ProviderCatalog, SizeInfo, VMSize } from '@simple-agent-manager/shared';
import { VM_SIZE_LABELS } from '@simple-agent-manager/shared';

/**
 * Look up provider-specific size info from catalogs.
 * Returns null if no catalog matches the provider.
 */
export function lookupSizeInfo(
  catalogs: ProviderCatalog[],
  provider: string | null | undefined,
  vmSize: VMSize,
): SizeInfo | null {
  if (!provider) return null;
  const catalog = catalogs.find((c) => c.provider === provider);
  return catalog?.sizes[vmSize] ?? null;
}

/**
 * Format VM size for inline display (e.g. node cards, overview sections).
 *
 * With catalog data:  "cx32 · 4 vCPU, 8 GB RAM · €7.69/mo"
 * Without:            "Medium (4 vCPUs, 8-12 GB RAM)"
 */
export function formatVmSizeInline(
  vmSize: VMSize,
  sizeInfo: SizeInfo | null,
): string {
  if (sizeInfo) {
    return `${sizeInfo.type} \u00B7 ${sizeInfo.vcpu} vCPU, ${sizeInfo.ramGb} GB RAM \u00B7 ${sizeInfo.price}`;
  }
  const labels = VM_SIZE_LABELS[vmSize];
  return labels ? `${labels.label} (${labels.shortDescription})` : vmSize;
}

/**
 * Format VM size for dropdown options (e.g. task submit).
 *
 * With catalog data:  "Small — cx22 (2 vCPU, 4 GB) €4.35/mo"
 * Without:            "Small — 2-3 vCPUs, 4 GB RAM"
 */
export function formatVmSizeOption(
  vmSize: VMSize,
  sizeInfo: SizeInfo | null,
): string {
  const label = vmSize.charAt(0).toUpperCase() + vmSize.slice(1);
  if (sizeInfo) {
    return `${label} \u2014 ${sizeInfo.type} (${sizeInfo.vcpu} vCPU, ${sizeInfo.ramGb} GB) ${sizeInfo.price}`;
  }
  const labels = VM_SIZE_LABELS[vmSize];
  return labels ? `${label} \u2014 ${labels.shortDescription}` : label;
}
