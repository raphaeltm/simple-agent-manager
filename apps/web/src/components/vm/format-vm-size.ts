import type { ProviderCatalog, SizeInfo, VMSize } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS, VM_LOCATIONS, VM_SIZE_LABELS } from '@simple-agent-manager/shared';

/**
 * Select the catalog that matches the provider SAM will use.
 *
 * When no provider is selected, a single catalog is unambiguous; multiple
 * catalogs are not, so callers should fall back to generic tier labels.
 */
export function selectProviderCatalog(
  catalogs: ProviderCatalog[],
  provider: string | null | undefined,
): ProviderCatalog | null {
  if (provider) {
    return catalogs.find((c) => c.provider === provider) ?? null;
  }
  return catalogs.length === 1 ? catalogs[0] ?? null : null;
}

/**
 * Look up provider-specific size info from catalogs.
 * Returns null if no catalog matches the provider.
 */
export function lookupSizeInfo(
  catalogs: ProviderCatalog[],
  provider: string | null | undefined,
  vmSize: VMSize,
): SizeInfo | null {
  const catalog = selectProviderCatalog(catalogs, provider);
  return catalog?.sizes[vmSize] ?? null;
}

/**
 * Format VM size for inline display (e.g. node cards, overview sections).
 *
 * With catalog data:  "cx32 · 4 vCPU, 8 GB RAM, 80 GB storage · €7.69/mo"
 * Without:            "Medium — exact specs unavailable"
 */
export function formatVmSizeInline(
  vmSize: VMSize,
  sizeInfo: SizeInfo | null,
): string {
  if (sizeInfo) {
    return `${sizeInfo.type} \u00B7 ${sizeInfo.vcpu} vCPU, ${sizeInfo.ramGb} GB RAM, ${sizeInfo.storageGb} GB storage \u00B7 ${sizeInfo.price}`;
  }
  const labels = VM_SIZE_LABELS[vmSize];
  return labels ? `${labels.label} \u2014 exact specs unavailable` : `${vmSize} \u2014 exact specs unavailable`;
}

/**
 * Format VM size for dropdown options (e.g. task submit).
 *
 * With catalog data:  "Small — cx22 (2 vCPU, 4 GB RAM, 40 GB storage) €4.35/mo"
 * Without:            "Small — exact specs unavailable"
 */
export function formatVmSizeOption(
  vmSize: VMSize,
  sizeInfo: SizeInfo | null,
): string {
  const label = vmSize.charAt(0).toUpperCase() + vmSize.slice(1);
  if (sizeInfo) {
    return `${label} \u2014 ${sizeInfo.type} (${sizeInfo.vcpu} vCPU, ${sizeInfo.ramGb} GB RAM, ${sizeInfo.storageGb} GB storage) ${sizeInfo.price}`;
  }
  return `${label} \u2014 exact specs unavailable`;
}

export function formatProviderCatalogContext(
  catalog: ProviderCatalog | null,
  location: string | null | undefined,
): string {
  if (!catalog) return '';

  const providerLabel = PROVIDER_LABELS[catalog.provider] ?? catalog.provider;
  if (!location) return providerLabel;

  const locationMeta = VM_LOCATIONS[location];
  const locationLabel = locationMeta ? `${locationMeta.name}, ${locationMeta.country}` : location;
  return `${providerLabel} / ${locationLabel}`;
}
