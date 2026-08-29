import {
  type CapacityPoolCandidate,
  type CapacityPoolStatus,
  type CapacitySourceIdentity,
  DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS,
  type ProviderCatalog,
  type ProviderCatalogOfferingInfo,
  type SizeInfo,
  type VMSize,
} from '@simple-agent-manager/shared';

const HOURS_PER_APPROXIMATE_BILLING_MONTH = DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS;

export interface ComputePoolOffering {
  key: string;
  sourceId: string | null;
  sourceKey: string | null;
  sourceLabel: string | null;
  provider: string;
  providerLabel: string;
  location: string;
  locationLabel: string;
  country: string | null;
  sku: string;
  providerInstanceType: string;
  providerInstanceSku: string | null;
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
  candidateStatus: CapacityPoolStatus | 'not-configured' | 'pending-add';
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

function identityPart(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.toLowerCase() : 'unknown';
}

function catalogSourceKey(catalog: ProviderCatalog): string | null {
  const source = catalog.credentialSource?.trim();
  if (source && catalog.externalSourceRef?.trim()) {
    return `${source}:${catalog.externalSourceRef.trim()}`;
  }
  const id =
    source === 'platform' ? catalog.platformCredentialId?.trim() : catalog.credentialId?.trim();
  return source && id ? `${source}:${id}` : null;
}

function sourceLabelFromParts(
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

function sourceKeyFromIdentity(source: CapacitySourceIdentity): string | null {
  if (source.platformCredentialId) return `platform:${source.platformCredentialId}`;
  if (source.credentialId && source.credentialSource) {
    return `${source.credentialSource}:${source.credentialId}`;
  }
  if (source.externalSourceRef && source.credentialSource) {
    return `${source.credentialSource}:${source.externalSourceRef}`;
  }
  if (source.externalSourceRef) return `external:${source.externalSourceRef}`;
  return null;
}

function sourceLabelFromIdentity(source: CapacitySourceIdentity): string | null {
  return sourceLabelFromParts(
    source.credentialSource,
    source.credentialId ?? source.platformCredentialId ?? source.externalSourceRef
  );
}

function offeringKey(
  sourceKey: string | null | undefined,
  provider: string,
  location: string,
  sku: string
): string {
  return [sourceKey ?? 'source-unscoped', provider, location, sku]
    .map((part) => identityPart(part))
    .join(':');
}

function legacyOfferingKey(
  sourceKey: string | null | undefined,
  provider: string,
  location: string,
  machineSize: string
): string {
  return offeringKey(sourceKey, provider, location, machineSize);
}

function candidateSourceKey(
  candidate: ExtendedCandidate,
  sourceKeysById: ReadonlyMap<string, string | null>
): string | null {
  const mapped = sourceKeysById.get(candidate.capacitySourceId);
  if (mapped) return mapped;
  const sourceId = candidate.capacitySourceId?.trim();
  return sourceId ? `capacity-source:${sourceId}` : null;
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

function monthlyPriceAmount(input: {
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

function offeringFromLegacySize(
  catalog: ProviderCatalog,
  locationId: string,
  locationLabel: string,
  country: string | null,
  machineSizeHint: string,
  size: SizeInfo
): ComputePoolOffering {
  const priceLabel = size.price || null;
  const sourceKey = catalogSourceKey(catalog);
  const sourceLabel = sourceLabelFromParts(
    catalog.credentialSource,
    catalog.credentialSource === 'platform' ? catalog.platformCredentialId : catalog.credentialId
  );
  const key = offeringKey(sourceKey, catalog.provider, locationId, size.type);

  return {
    key,
    sourceId: null,
    sourceKey,
    sourceLabel,
    provider: catalog.provider,
    providerLabel: titleCaseProvider(catalog.provider),
    location: locationId,
    locationLabel,
    country,
    sku: size.type,
    providerInstanceType: size.type,
    providerInstanceSku: null,
    vcpu: size.vcpu,
    ramGb: size.ramGb,
    diskGb: size.storageGb,
    priceLabel,
    monthlyPriceAmount: monthlyPriceAmount({ priceLabel }),
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
  const sku =
    offering.providerInstanceSku ??
    offering.providerInstanceType ??
    offering.sku ??
    offering.instanceType ??
    offering.type ??
    offering.id ??
    'sku pending';
  const priceLabel = priceLabelForOffering(offering);
  const sourceKey = catalogSourceKey(catalog);
  const sourceLabel = sourceLabelFromParts(
    catalog.credentialSource,
    catalog.credentialSource === 'platform' ? catalog.platformCredentialId : catalog.credentialId
  );

  return {
    key: offeringKey(sourceKey, catalog.provider, location, sku),
    sourceId: null,
    sourceKey,
    sourceLabel,
    provider: catalog.provider,
    providerLabel: titleCaseProvider(catalog.provider),
    location,
    locationLabel: offering.locationName ?? locationInfo?.name ?? location,
    country: offering.country ?? locationInfo?.country ?? null,
    sku,
    providerInstanceType:
      offering.providerInstanceType ??
      offering.instanceType ??
      offering.type ??
      offering.sku ??
      offering.id ??
      sku,
    providerInstanceSku: offering.providerInstanceSku ?? null,
    vcpu: normalizeNumber(offering.vcpu),
    ramGb: normalizeRamGb(offering),
    diskGb: normalizeDiskGb(offering),
    priceLabel,
    monthlyPriceAmount: monthlyPriceAmount({
      priceMonthly: offering.priceMonthly,
      priceHourly: offering.priceHourly,
      priceMonthlyUsd: offering.priceMonthlyUsd,
      priceHourlyUsd: offering.priceHourlyUsd,
      priceLabel,
    }),
    available: typeof offering.available === 'boolean' ? offering.available : null,
    stale: Boolean(offering.stale),
    statusLabel: offering.status ?? null,
    machineSizeHint: offering.machineSize ?? null,
  };
}

export function flattenProviderCatalogOfferings(
  catalogs: ProviderCatalog[]
): ComputePoolOffering[] {
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
    candidate.providerInstanceSku ??
    candidate.providerInstanceType ??
    candidate.sku ??
    candidate.instanceType ??
    candidate.type ??
    candidate.providerOfferingId ??
    null
  );
}

function candidateFallbackOffering(
  candidate: ExtendedCandidate,
  sourceKey: string | null,
  sourceLabel: string | null
): ComputePoolOffering {
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
    key: offeringKey(sourceKey, provider, location, sku),
    sourceId: candidate.capacitySourceId ?? null,
    sourceKey,
    sourceLabel,
    provider,
    providerLabel: titleCaseProvider(provider),
    location,
    locationLabel: location,
    country: null,
    sku,
    providerInstanceType:
      candidate.providerInstanceType ?? candidate.instanceType ?? candidate.type ?? sku,
    providerInstanceSku: candidate.providerInstanceSku ?? null,
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
    monthlyPriceAmount: monthlyPriceAmount({
      priceMonthly: monthlyFromCents,
      priceHourly: hourlyFromMicros,
      priceMonthlyUsd: candidate.priceMonthlyUsd,
      priceHourlyUsd: candidate.priceHourlyUsd,
      priceLabel,
    }),
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
  sources: CapacitySourceIdentity[] = [],
  draftStatuses: Record<string, CapacityPoolStatus> = {},
  draftCatalogAdditionKeys: ReadonlySet<string> = new Set()
): ComputePoolOfferingsModel {
  const sourceKeysById = new Map(
    sources.map((source) => [source.id, sourceKeyFromIdentity(source)])
  );
  const sourceLabelsById = new Map(
    sources.map((source) => [source.id, sourceLabelFromIdentity(source)])
  );
  const sourceIdsByKey = new Map<string, string>();
  for (const source of sources) {
    const key = sourceKeyFromIdentity(source);
    if (key) sourceIdsByKey.set(key, source.id);
  }
  const catalogOfferings = flattenProviderCatalogOfferings(catalogs);
  const byKey = new Map(catalogOfferings.map((offering) => [offering.key, offering]));
  const byLegacyCandidate = new Map<string, ComputePoolOffering>();
  const byUnscopedKey = new Map<string, ComputePoolOffering[]>();

  for (const offering of catalogOfferings) {
    const unscopedKey = offeringKey(null, offering.provider, offering.location, offering.sku);
    byUnscopedKey.set(unscopedKey, [...(byUnscopedKey.get(unscopedKey) ?? []), offering]);
    if (!offering.machineSizeHint) continue;
    byLegacyCandidate.set(
      legacyOfferingKey(
        offering.sourceKey,
        offering.provider,
        offering.location,
        offering.machineSizeHint
      ),
      offering
    );
  }

  const candidateOfferings = candidates.map((candidate): ComputePoolCandidateOffering => {
    const extended = candidate as ExtendedCandidate;
    const provider = extended.provider ?? 'unknown-provider';
    const location = extended.location ?? 'unknown-region';
    const nativeSku = candidateSku(extended);
    const sourceKey = candidateSourceKey(extended, sourceKeysById);
    const sourceLabel =
      sourceLabelsById.get(extended.capacitySourceId) ??
      (sourceKey ? `Capacity source ${extended.capacitySourceId}` : null);
    const sourceScopedKey = nativeSku
      ? offeringKey(sourceKey, provider, location, nativeSku)
      : null;
    const unscopedKey = nativeSku ? offeringKey(null, provider, location, nativeSku) : null;
    const unscopedMatches = unscopedKey ? (byUnscopedKey.get(unscopedKey) ?? []) : [];
    const exactCatalogOffering = nativeSku
      ? (byKey.get(sourceScopedKey ?? '') ??
        (unscopedMatches.length === 1 ? unscopedMatches[0] : null))
      : null;
    const legacyCatalogOffering = extended.machineSize
      ? byLegacyCandidate.get(
          legacyOfferingKey(sourceKey, provider, location, extended.machineSize)
        )
      : null;
    const base =
      exactCatalogOffering ??
      legacyCatalogOffering ??
      candidateFallbackOffering(extended, sourceKey, sourceLabel);
    const missingFromCurrentCatalog =
      nativeSku !== null && !exactCatalogOffering && !legacyCatalogOffering;

    return {
      ...base,
      sourceId: extended.capacitySourceId ?? base.sourceId,
      candidateId: candidate.id,
      candidateStatus: draftStatuses[candidate.id] ?? candidate.status,
      runtime: candidate.runtime,
      machineClass: candidate.machineClass,
      priority: candidate.priority,
      candidateOrder: candidate.candidateOrder,
      available: missingFromCurrentCatalog ? false : base.available,
      stale: missingFromCurrentCatalog ? true : base.stale,
      statusLabel: missingFromCurrentCatalog
        ? 'No longer present in the current provider catalog'
        : base.statusLabel,
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
        if (!matchingCandidate) {
          const sourceId = offering.sourceKey
            ? (sourceIdsByKey.get(offering.sourceKey) ?? null)
            : null;
          return {
            ...offering,
            sourceId,
            candidateId: null,
            candidateStatus: draftCatalogAdditionKeys.has(offering.key)
              ? 'pending-add'
              : 'not-configured',
            runtime: null,
            machineClass: null,
            canUpdateExistingCandidate: false,
          };
        }
        return {
          ...offering,
          sourceId: matchingCandidate.sourceId,
          candidateId: matchingCandidate.candidateId,
          candidateStatus: matchingCandidate.candidateStatus,
          runtime: matchingCandidate.runtime,
          machineClass: matchingCandidate.machineClass,
          canUpdateExistingCandidate: true,
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

  if (filters.availability === 'available' && !canAddComputePoolOffering(offering)) return false;
  if (filters.availability === 'unavailable' && (offering.available !== false || offering.stale)) {
    return false;
  }
  if (filters.availability === 'stale' && !offering.stale) return false;

  return true;
}

export function canAddComputePoolOffering(
  offering: Pick<ComputePoolOffering, 'available' | 'stale'>
): boolean {
  return offering.available !== false && !offering.stale;
}

export function formatOfferingNumber(value: number | null, unit: string): string {
  if (value === null) return 'Unknown';
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}
