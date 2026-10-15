import {
  type CapacityPoolCandidate,
  type CapacitySourceIdentity,
  DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS,
  type ProviderCatalog,
} from '@simple-agent-manager/shared';

/**
 * Field normalization and identity keys for compute-pool offerings: provider labels,
 * price and size parsing, and the source/catalog keys that match pool candidates to
 * provider catalog rows.
 */

const HOURS_PER_APPROXIMATE_BILLING_MONTH = DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS;

/** Pool candidate plus the legacy/alternate field names older API payloads used. */
export type ExtendedCandidate = CapacityPoolCandidate & {
  providerOfferingId?: string | null;
  sku?: string | null;
  instanceType?: string | null;
  type?: string | null;
  providerInstanceType?: string | null;
  vcpu?: number | null;
  providerInstanceVcpuCount?: number | null;
  ramGb?: number | null;
  memoryGb?: number | null;
  memoryMb?: number | null;
  providerInstanceMemoryMb?: number | null;
  storageGb?: number | null;
  diskGb?: number | null;
  providerInstanceDiskGb?: number | null;
  price?: string | null;
  providerInstancePriceDisplay?: string | null;
  priceMonthly?: number | null;
  priceHourly?: number | null;
  priceMonthlyUsd?: number | null;
  priceHourlyUsd?: number | null;
  providerInstancePriceMonthlyCents?: number | null;
  providerInstancePriceHourlyMicros?: number | null;
  providerInstancePriceCurrency?: string | null;
  available?: boolean | null;
  stale?: boolean | null;
  catalogStatus?: string | null;
};

export function titleCaseProvider(value: string | null | undefined): string {
  if (!value) return 'Unknown provider';
  const named: Record<string, string> = {
    digitalocean: 'DigitalOcean',
    gcp: 'Google Cloud',
    hetzner: 'Hetzner',
    infomaniak: 'Infomaniak',
    scaleway: 'Scaleway',
    upcloud: 'UpCloud',
    vultr: 'Vultr',
  };
  return (
    named[value] ??
    value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

export function identityPart(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.toLowerCase() : 'unknown';
}

interface SourceKeyParts {
  credentialSource?: string | null;
  credentialId?: string | null;
  platformCredentialId?: string | null;
  externalSourceRef?: string | null;
}

/**
 * The one key that ties a pool source to the provider catalog read through the same
 * credential. Both sides MUST use this function: a composable attachment carries a
 * credential id AND an attachment ref (`cc_attachments:…`, see `provider-catalogs.ts`),
 * and when the source keyed by the credential id while the catalog keyed by the
 * attachment ref, every offering of that source rendered as stale catalog data.
 */
function capacitySourceKey(parts: SourceKeyParts): string | null {
  const source = parts.credentialSource?.trim() || null;
  const externalRef = parts.externalSourceRef?.trim() || null;
  const platformId = parts.platformCredentialId?.trim() || null;
  const credentialId = parts.credentialId?.trim() || null;
  if (source && externalRef) return `${source}:${externalRef}`;
  if (platformId) return `platform:${platformId}`;
  if (source && credentialId) return `${source}:${credentialId}`;
  if (externalRef) return `external:${externalRef}`;
  return null;
}

export function catalogSourceKey(catalog: ProviderCatalog): string | null {
  return capacitySourceKey(catalog);
}

export function sourceLabelFromParts(
  credentialSource: string | null | undefined,
  credentialId: string | null | undefined
): string | null {
  if (!credentialSource && !credentialId) return null;
  const source =
    credentialSource === 'platform'
      ? 'Platform credential'
      : credentialSource === 'project'
        ? 'Project credential'
        : credentialSource === 'user'
          ? 'User credential'
          : credentialSource
            ? `${titleCaseProvider(credentialSource)} credential`
            : 'Credential';
  return credentialId ? `${source} ${credentialId}` : source;
}

export function sourceKeyFromIdentity(source: CapacitySourceIdentity): string | null {
  return capacitySourceKey(source);
}

export function sourceLabelFromIdentity(source: CapacitySourceIdentity): string | null {
  return sourceLabelFromParts(
    source.credentialSource,
    source.credentialId ?? source.platformCredentialId ?? source.externalSourceRef
  );
}

export function offeringKey(
  sourceKey: string | null | undefined,
  provider: string,
  location: string,
  sku: string
): string {
  return [sourceKey ?? 'source-unscoped', provider, location, sku]
    .map((part) => identityPart(part))
    .join(':');
}

export function legacyOfferingKey(
  sourceKey: string | null | undefined,
  provider: string,
  location: string,
  machineSize: string
): string {
  return offeringKey(sourceKey, provider, location, machineSize);
}

export function candidateSourceKey(
  candidate: ExtendedCandidate,
  sourceKeysById: ReadonlyMap<string, string | null>
): string | null {
  const mapped = sourceKeysById.get(candidate.capacitySourceId);
  if (mapped) return mapped;
  const sourceId = candidate.capacitySourceId?.trim();
  return sourceId ? `capacity-source:${sourceId}` : null;
}

export function parsePriceAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replace(',', '.').match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  if (/\/\s*(h|hr|hour)/i.test(value)) {
    return amount * HOURS_PER_APPROXIMATE_BILLING_MONTH;
  }

  return amount;
}

export function monthlyPriceAmount(input: {
  priceMonthly?: number | null;
  priceHourly?: number | null;
  priceMonthlyUsd?: number | null;
  priceHourlyUsd?: number | null;
  priceLabel?: string | null;
}): number | null {
  if (typeof input.priceMonthly === 'number' && Number.isFinite(input.priceMonthly)) {
    return input.priceMonthly;
  }
  if (typeof input.priceHourly === 'number' && Number.isFinite(input.priceHourly)) {
    return input.priceHourly * HOURS_PER_APPROXIMATE_BILLING_MONTH;
  }
  if (typeof input.priceMonthlyUsd === 'number' && Number.isFinite(input.priceMonthlyUsd)) {
    return input.priceMonthlyUsd;
  }
  if (typeof input.priceHourlyUsd === 'number' && Number.isFinite(input.priceHourlyUsd)) {
    return input.priceHourlyUsd * HOURS_PER_APPROXIMATE_BILLING_MONTH;
  }
  return parsePriceAmount(input.priceLabel);
}

export function normalizeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeRamGb(offering: {
  ramGb?: number | null;
  memoryGb?: number | null;
  memoryMb?: number | null;
}): number | null {
  const ramGb = normalizeNumber(offering.ramGb ?? offering.memoryGb);
  if (ramGb !== null) return ramGb;
  const memoryMb = normalizeNumber(offering.memoryMb);
  return memoryMb === null ? null : memoryMb / 1024;
}

export function normalizeDiskGb(offering: {
  storageGb?: number | null;
  diskGb?: number | null;
}): number | null {
  return normalizeNumber(offering.storageGb ?? offering.diskGb);
}

export function priceLabelForOffering(offering: {
  price?: string | null;
  priceMonthly?: number | null;
  priceHourly?: number | null;
  priceMonthlyUsd?: number | null;
  priceHourlyUsd?: number | null;
  currency?: string | null;
}): string | null {
  if (offering.price) return offering.price;
  if (typeof offering.priceMonthly === 'number' && Number.isFinite(offering.priceMonthly)) {
    return `${offering.currency ?? 'CUR'} ${offering.priceMonthly.toFixed(2)}/mo`;
  }
  if (typeof offering.priceHourly === 'number' && Number.isFinite(offering.priceHourly)) {
    return `${offering.currency ?? 'CUR'} ${offering.priceHourly.toFixed(4)}/hr`;
  }
  if (typeof offering.priceMonthlyUsd === 'number' && Number.isFinite(offering.priceMonthlyUsd)) {
    return `${offering.currency ?? 'USD'} ${offering.priceMonthlyUsd.toFixed(2)}/mo`;
  }
  if (typeof offering.priceHourlyUsd === 'number' && Number.isFinite(offering.priceHourlyUsd)) {
    return `${offering.currency ?? 'USD'} ${offering.priceHourlyUsd.toFixed(4)}/hr`;
  }
  return null;
}
