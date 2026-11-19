import type {
  CapacityPoolCandidate,
  CapacityPoolStatus,
  CapacitySourceIdentity,
  ProviderCatalog,
  ProviderCatalogOfferingInfo,
  SizeInfo,
  VMSize,
} from '@simple-agent-manager/shared';

import {
  candidateSourceKey,
  catalogSourceKey,
  type ExtendedCandidate,
  knownProviderLocation,
  monthlyPriceAmount,
  normalizeDiskGb,
  normalizeNumber,
  normalizeRamGb,
  offeringKey,
  priceLabelForOffering,
  providerDisplayName,
  sourceKeyFromIdentity,
} from './compute-pool-offering-fields';

export interface ComputePoolOffering {
  key: string;
  sourceId: string | null;
  sourceKey: string | null;
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
}

export interface ComputePoolCatalogOffering extends ComputePoolOffering {
  candidateId: string | null;
  candidateStatus: CapacityPoolStatus | 'not-configured';
}

export interface ComputePoolOfferingsModel {
  allowed: ComputePoolCandidateOffering[];
  excluded: ComputePoolCandidateOffering[];
  catalog: ComputePoolCatalogOffering[];
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
  const key = offeringKey(sourceKey, catalog.provider, locationId, size.type);

  return {
    key,
    sourceId: null,
    sourceKey,
    provider: catalog.provider,
    providerLabel: providerDisplayName(catalog.provider),
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

  return {
    key: offeringKey(sourceKey, catalog.provider, location, sku),
    sourceId: null,
    sourceKey,
    provider: catalog.provider,
    providerLabel: providerDisplayName(catalog.provider),
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

function flattenProviderCatalogOfferings(catalogs: ProviderCatalog[]): ComputePoolOffering[] {
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
  sourceKey: string | null
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

  const knownLocation = knownProviderLocation(provider, location);

  return {
    key: offeringKey(sourceKey, provider, location, sku),
    sourceId: candidate.capacitySourceId ?? null,
    sourceKey,
    provider,
    providerLabel: providerDisplayName(provider),
    location,
    locationLabel: knownLocation?.name ?? location,
    country: knownLocation?.country ?? null,
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
  sources: CapacitySourceIdentity[] = []
): ComputePoolOfferingsModel {
  const sourceKeysById = new Map(
    sources.map((source) => [source.id, sourceKeyFromIdentity(source)])
  );
  const sourceIdsByKey = new Map<string, string>();
  for (const source of sources) {
    const key = sourceKeyFromIdentity(source);
    if (key) sourceIdsByKey.set(key, source.id);
  }
  const catalogOfferings = flattenProviderCatalogOfferings(catalogs);
  // A row is only "no longer offered" when its own account's catalog is loaded and lacks it.
  // Without that catalog (a fallback pool, a failed catalog read) there is no evidence either way.
  const loadedCatalogSourceKeys = new Set(
    catalogs.map((catalog) => catalogSourceKey(catalog)).filter((key): key is string => !!key)
  );
  const byKey = new Map(catalogOfferings.map((offering) => [offering.key, offering]));
  const byLegacyCandidate = new Map<string, ComputePoolOffering>();
  const byUnscopedKey = new Map<string, ComputePoolOffering[]>();

  for (const offering of catalogOfferings) {
    const unscopedKey = offeringKey(null, offering.provider, offering.location, offering.sku);
    byUnscopedKey.set(unscopedKey, [...(byUnscopedKey.get(unscopedKey) ?? []), offering]);
    if (!offering.machineSizeHint) continue;
    byLegacyCandidate.set(
      offeringKey(
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
      ? byLegacyCandidate.get(offeringKey(sourceKey, provider, location, extended.machineSize))
      : null;
    const base =
      exactCatalogOffering ??
      legacyCatalogOffering ??
      candidateFallbackOffering(extended, sourceKey);
    const missingFromCurrentCatalog =
      nativeSku !== null &&
      !exactCatalogOffering &&
      !legacyCatalogOffering &&
      sourceKey !== null &&
      loadedCatalogSourceKeys.has(sourceKey);

    return {
      ...base,
      sourceId: extended.capacitySourceId ?? base.sourceId,
      candidateId: candidate.id,
      candidateStatus: candidate.status,
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
            candidateStatus: 'not-configured',
          };
        }
        return {
          ...offering,
          sourceId: matchingCandidate.sourceId,
          candidateId: matchingCandidate.candidateId,
          candidateStatus: matchingCandidate.candidateStatus,
        };
      })
    ),
  };
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
