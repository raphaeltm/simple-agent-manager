import type {
  CapacityPoolCandidate,
  CapacityPoolStatus,
  ProviderCatalog,
  ProviderCatalogOfferingInfo,
  SizeInfo,
  VMSize,
} from '@simple-agent-manager/shared';

const HOURS_PER_APPROXIMATE_BILLING_MONTH = 730;

export interface ComputePoolOffering {
  key: string;
  provider: string;
  providerLabel: string;
  location: string;
  locationLabel: string;
  country: string | null;
  sku: string;
  vcpu: number | null;
  ramGb: number | null;
  diskGb: number | null;
  priceLabel: string | null;
  monthlyPriceAmount: number | null;
  available: boolean | null;
  stale: boolean;
  statusLabel: string | null;
  machineSizeHint: string | null;
}

export interface ComputePoolCandidateOffering extends ComputePoolOffering {
  candidateId: string;
  candidateStatus: CapacityPoolStatus;
  runtime: string | null;
  machineClass: string | null;
  priority: number;
  candidateOrder: number;
}

export interface ComputePoolCatalogOffering extends ComputePoolOffering {
  candidateId: string | null;
  candidateStatus: CapacityPoolStatus | 'not-configured';
  runtime: string | null;
  machineClass: string | null;
  canUpdateExistingCandidate: boolean;
}

export interface ComputePoolOfferingsModel {
  allowed: ComputePoolCandidateOffering[];
  excluded: ComputePoolCandidateOffering[];
  catalog: ComputePoolCatalogOffering[];
}

export interface ComputePoolOfferingFilters {
  provider: string;
  location: string;
  minVcpu: string;
  minRamGb: string;
  maxMonthlyPrice: string;
  availability: 'all' | 'available' | 'unavailable' | 'stale';
}

type ExtendedCandidate = CapacityPoolCandidate & {
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
  priceMonthlyUsd?: number | null;
  priceHourlyUsd?: number | null;
  providerInstancePriceMonthlyCents?: number | null;
  providerInstancePriceHourlyMicros?: number | null;
  providerInstancePriceCurrency?: string | null;
  available?: boolean | null;
  stale?: boolean | null;
  catalogStatus?: string | null;
};

function titleCaseProvider(value: string | null | undefined): string {
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

function offeringKey(provider: string, location: string, sku: string): string {
  return [provider, location, sku].map((part) => part.trim().toLowerCase()).join(':');
}

function parsePriceAmount(value: string | null | undefined): number | null {
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

function monthlyPriceAmount(
  priceMonthlyUsd: number | null | undefined,
  priceHourlyUsd: number | null | undefined,
  priceLabel: string | null | undefined
): number | null {
  if (typeof priceMonthlyUsd === 'number' && Number.isFinite(priceMonthlyUsd)) {
    return priceMonthlyUsd;
  }
  if (typeof priceHourlyUsd === 'number' && Number.isFinite(priceHourlyUsd)) {
    return priceHourlyUsd * HOURS_PER_APPROXIMATE_BILLING_MONTH;
  }
  return parsePriceAmount(priceLabel);
}

function normalizeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeRamGb(offering: {
  ramGb?: number | null;
  memoryGb?: number | null;
  memoryMb?: number | null;
}): number | null {
  const ramGb = normalizeNumber(offering.ramGb ?? offering.memoryGb);
  if (ramGb !== null) return ramGb;
  const memoryMb = normalizeNumber(offering.memoryMb);
  return memoryMb === null ? null : memoryMb / 1024;
}

function normalizeDiskGb(offering: {
  storageGb?: number | null;
  diskGb?: number | null;
}): number | null {
  return normalizeNumber(offering.storageGb ?? offering.diskGb);
}

function priceLabelForOffering(offering: {
  price?: string | null;
  priceMonthlyUsd?: number | null;
  priceHourlyUsd?: number | null;
  currency?: string | null;
}): string | null {
  if (offering.price) return offering.price;
  if (typeof offering.priceMonthlyUsd === 'number' && Number.isFinite(offering.priceMonthlyUsd)) {
    return `${offering.currency ?? 'USD'} ${offering.priceMonthlyUsd.toFixed(2)}/mo`;
  }
  if (typeof offering.priceHourlyUsd === 'number' && Number.isFinite(offering.priceHourlyUsd)) {
    return `${offering.currency ?? 'USD'} ${offering.priceHourlyUsd.toFixed(4)}/hr`;
  }
  return null;
}

function offeringFromLegacySize(
  catalog: ProviderCatalog,
  locationId: string,
  locationLabel: string,
  country: string | null,
  machineSizeHint: string,
  size: SizeInfo
): ComputePoolOffering {
  const priceLabel = size.price || null;
  const key = offeringKey(catalog.provider, locationId, size.type);

  return {
    key,
    provider: catalog.provider,
    providerLabel: titleCaseProvider(catalog.provider),
    location: locationId,
    locationLabel,
    country,
    sku: size.type,
    vcpu: size.vcpu,
    ramGb: size.ramGb,
    diskGb: size.storageGb,
    priceLabel,
    monthlyPriceAmount: monthlyPriceAmount(null, null, priceLabel),
    available: true,
    stale: false,
    statusLabel: null,
    machineSizeHint,
  };
}

function offeringFromNativeCatalog(
  catalog: ProviderCatalog,
  offering: ProviderCatalogOfferingInfo
): ComputePoolOffering {
  const location = offering.location;
  const locationInfo = catalog.locations.find((item) => item.id === location);
  const sku = offering.sku ?? offering.instanceType ?? offering.type ?? offering.id ?? 'sku pending';
  const priceLabel = priceLabelForOffering(offering);

  return {
    key: offeringKey(catalog.provider, location, sku),
    provider: catalog.provider,
    providerLabel: titleCaseProvider(catalog.provider),
    location,
    locationLabel: offering.locationName ?? locationInfo?.name ?? location,
    country: offering.country ?? locationInfo?.country ?? null,
    sku,
    vcpu: normalizeNumber(offering.vcpu),
    ramGb: normalizeRamGb(offering),
    diskGb: normalizeDiskGb(offering),
    priceLabel,
    monthlyPriceAmount: monthlyPriceAmount(
      offering.priceMonthlyUsd,
      offering.priceHourlyUsd,
      priceLabel
    ),
    available: typeof offering.available === 'boolean' ? offering.available : null,
    stale: Boolean(offering.stale),
    statusLabel: offering.status ?? null,
    machineSizeHint: offering.machineSize ?? null,
  };
}

export function flattenProviderCatalogOfferings(catalogs: ProviderCatalog[]): ComputePoolOffering[] {
  return catalogs.flatMap((catalog) => {
    if (catalog.offerings && catalog.offerings.length > 0) {
      return catalog.offerings.map((offering) => offeringFromNativeCatalog(catalog, offering));
    }

    return catalog.locations.flatMap((location) =>
      (Object.entries(catalog.sizes) as [VMSize, SizeInfo][]).map(([machineSize, size]) =>
        offeringFromLegacySize(
          catalog,
          location.id,
          location.name,
          location.country,
          machineSize,
          size
        )
      )
    );
  });
}

function candidateSku(candidate: ExtendedCandidate): string | null {
  return (
    candidate.providerInstanceType ??
    candidate.sku ??
    candidate.instanceType ??
    candidate.type ??
    candidate.providerOfferingId ??
    null
  );
}

function candidateFallbackOffering(candidate: ExtendedCandidate): ComputePoolOffering {
  const provider = candidate.provider ?? 'unknown-provider';
  const location = candidate.location ?? 'unknown-region';
  const sku = candidateSku(candidate) ?? 'Provider SKU pending';
  const priceLabel =
    candidate.providerInstancePriceDisplay ??
    priceLabelForOffering({
      ...candidate,
      currency: candidate.providerInstancePriceCurrency,
    });
  const monthlyFromCents =
    typeof candidate.providerInstancePriceMonthlyCents === 'number'
      ? candidate.providerInstancePriceMonthlyCents / 100
      : null;
  const hourlyFromMicros =
    typeof candidate.providerInstancePriceHourlyMicros === 'number'
      ? candidate.providerInstancePriceHourlyMicros / 1_000_000
      : null;

  return {
    key: offeringKey(provider, location, sku),
    provider,
    providerLabel: titleCaseProvider(provider),
    location,
    locationLabel: location,
    country: null,
    sku,
    vcpu: normalizeNumber(candidate.providerInstanceVcpuCount ?? candidate.vcpu),
    ramGb: normalizeRamGb({
      ramGb: candidate.ramGb ?? candidate.memoryGb,
      memoryMb: candidate.providerInstanceMemoryMb ?? candidate.memoryMb,
    }),
    diskGb: normalizeDiskGb({
      storageGb: candidate.storageGb,
      diskGb: candidate.providerInstanceDiskGb ?? candidate.diskGb,
    }),
    priceLabel,
    monthlyPriceAmount: monthlyPriceAmount(
      monthlyFromCents ?? candidate.priceMonthlyUsd,
      hourlyFromMicros ?? candidate.priceHourlyUsd,
      priceLabel
    ),
    available: typeof candidate.available === 'boolean' ? candidate.available : null,
    stale: Boolean(candidate.stale),
    statusLabel: candidate.catalogStatus ?? null,
    machineSizeHint: candidate.machineSize,
  };
}

function sortOfferings<T extends ComputePoolOffering>(offerings: T[]): T[] {
  return [...offerings].sort((a, b) => {
    const provider = a.providerLabel.localeCompare(b.providerLabel);
    if (provider !== 0) return provider;
    const location = a.location.localeCompare(b.location);
    if (location !== 0) return location;
    const priceA = a.monthlyPriceAmount ?? Number.POSITIVE_INFINITY;
    const priceB = b.monthlyPriceAmount ?? Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
    return a.sku.localeCompare(b.sku);
  });
}

export function buildComputePoolOfferingsModel(
  candidates: CapacityPoolCandidate[],
  catalogs: ProviderCatalog[],
  draftStatuses: Record<string, CapacityPoolStatus> = {}
): ComputePoolOfferingsModel {
  const catalogOfferings = flattenProviderCatalogOfferings(catalogs);
  const byKey = new Map(catalogOfferings.map((offering) => [offering.key, offering]));
  const byLegacyCandidate = new Map<string, ComputePoolOffering>();

  for (const offering of catalogOfferings) {
    if (!offering.machineSizeHint) continue;
    byLegacyCandidate.set(
      offeringKey(offering.provider, offering.location, offering.machineSizeHint),
      offering
    );
  }

  const candidateOfferings = candidates.map((candidate): ComputePoolCandidateOffering => {
    const extended = candidate as ExtendedCandidate;
    const provider = extended.provider ?? 'unknown-provider';
    const location = extended.location ?? 'unknown-region';
    const nativeSku = candidateSku(extended);
    const exactCatalogOffering = nativeSku
      ? byKey.get(offeringKey(provider, location, nativeSku))
      : null;
    const legacyCatalogOffering = extended.machineSize
      ? byLegacyCandidate.get(offeringKey(provider, location, extended.machineSize))
      : null;
    const base = exactCatalogOffering ?? legacyCatalogOffering ?? candidateFallbackOffering(extended);

    return {
      ...base,
      candidateId: candidate.id,
      candidateStatus: draftStatuses[candidate.id] ?? candidate.status,
      runtime: candidate.runtime,
      machineClass: candidate.machineClass,
      priority: candidate.priority,
      candidateOrder: candidate.candidateOrder,
    };
  });

  const byCandidateKey = new Map(candidateOfferings.map((candidate) => [candidate.key, candidate]));

  return {
    allowed: sortOfferings(
      candidateOfferings.filter((offering) => offering.candidateStatus === 'active')
    ),
    excluded: sortOfferings(
      candidateOfferings.filter((offering) => offering.candidateStatus !== 'active')
    ),
    catalog: sortOfferings(
      catalogOfferings.map((offering) => {
        const matchingCandidate = byCandidateKey.get(offering.key);
        return {
          ...offering,
          candidateId: matchingCandidate?.candidateId ?? null,
          candidateStatus: matchingCandidate?.candidateStatus ?? 'not-configured',
          runtime: matchingCandidate?.runtime ?? null,
          machineClass: matchingCandidate?.machineClass ?? null,
          canUpdateExistingCandidate: Boolean(matchingCandidate),
        };
      })
    ),
  };
}

export function matchesComputePoolFilters(
  offering: ComputePoolOffering,
  filters: ComputePoolOfferingFilters
): boolean {
  if (filters.provider !== 'all' && offering.provider !== filters.provider) return false;
  if (
    filters.location.trim() &&
    !`${offering.location} ${offering.locationLabel} ${offering.country ?? ''}`
      .toLowerCase()
      .includes(filters.location.trim().toLowerCase())
  ) {
    return false;
  }

  const minVcpu = Number(filters.minVcpu);
  if (filters.minVcpu && Number.isFinite(minVcpu) && (offering.vcpu ?? 0) < minVcpu) {
    return false;
  }

  const minRamGb = Number(filters.minRamGb);
  if (filters.minRamGb && Number.isFinite(minRamGb) && (offering.ramGb ?? 0) < minRamGb) {
    return false;
  }

  const maxMonthlyPrice = Number(filters.maxMonthlyPrice);
  if (filters.maxMonthlyPrice && Number.isFinite(maxMonthlyPrice)) {
    if (offering.monthlyPriceAmount === null || offering.monthlyPriceAmount > maxMonthlyPrice) {
      return false;
    }
  }

  if (filters.availability === 'available' && offering.available === false) return false;
  if (filters.availability === 'unavailable' && offering.available !== false) return false;
  if (filters.availability === 'stale' && !offering.stale) return false;

  return true;
}

export function formatOfferingNumber(value: number | null, unit: string): string {
  if (value === null) return 'Unknown';
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}
