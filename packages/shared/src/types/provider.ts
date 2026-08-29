import type { CredentialProvider } from './user';
import type { VMSize } from './workspace';

// =============================================================================
// Provider Catalog (dynamic instance types & locations)
// =============================================================================

/** Location metadata for a provider */
export interface LocationInfo {
  /** Provider-specific location identifier (e.g., 'fsn1', 'fr-par-1') */
  id: string;
  /** Human-readable name (e.g., 'Nuremberg', 'Paris') */
  name: string;
  /** ISO country code (e.g., 'DE', 'FR') */
  country: string;
}

/** Size configuration for a VM tier */
export interface SizeInfo {
  /** Provider-specific server type (e.g., 'cx23', 'DEV1-M') */
  type: string;
  /** Price string (e.g., '€3.99/mo', '~€0.024/hr') */
  price: string;
  /** vCPU count */
  vcpu: number;
  /** RAM in GB */
  ramGb: number;
  /** Storage in GB */
  storageGb: number;
}

export const PROVIDER_INSTANCE_CATALOG_SOURCES = ['api', 'static'] as const;
export type ProviderInstanceCatalogSource = (typeof PROVIDER_INSTANCE_CATALOG_SOURCES)[number];

/** Provider-native instance offering metadata. */
export interface ProviderCatalogOfferingInfo {
  /** Cloud provider identifier when the offering is returned outside its parent catalog. */
  provider?: CredentialProvider;
  /** Stable provider-native offering identifier when the provider exposes one. */
  id?: string;
  /** Provider SKU / server type / machine type (e.g., 'cx23', 'cpx31', 'n2-standard-4'). */
  sku?: string;
  /** Normalized provider-native instance type/SKU field used by compute pools. */
  providerInstanceType?: string;
  /** Optional provider-native SKU when distinct from the instance type. */
  providerInstanceSku?: string | null;
  /** Alias used by some providers/APIs for the provider SKU. */
  instanceType?: string;
  /** Legacy alias used by the existing catalog shape. */
  type?: string;
  /** Human-readable label if it differs from the SKU. */
  name?: string;
  /** Human-readable display label for the offering. */
  displayName?: string;
  /** Provider-specific region/location identifier. */
  location: string;
  /** Human-readable location name. */
  locationName?: string;
  /** ISO country/market code when known. */
  country?: string;
  /** vCPU count when known. */
  vcpu?: number | null;
  /** RAM in GB when known. */
  ramGb?: number | null;
  /** Memory in GB when providers call it memory instead of RAM. */
  memoryGb?: number | null;
  /** Memory in MB for APIs that use integer MB values. */
  memoryMb?: number | null;
  /** Storage/disk in GB when known. */
  storageGb?: number | null;
  /** Disk in GB when providers call it disk instead of storage. */
  diskGb?: number | null;
  /** Provider-formatted price string. */
  price?: string;
  /** Numeric monthly price when the backend can normalize it. */
  priceMonthlyUsd?: number | null;
  /** Numeric hourly price when the backend can normalize it. */
  priceHourlyUsd?: number | null;
  /** Numeric monthly price in the `currency` field, when known. */
  priceMonthly?: number | null;
  /** Numeric hourly price in the `currency` field, when known. */
  priceHourly?: number | null;
  /** Currency for normalized prices when known. */
  currency?: string | null;
  /** Current provider availability when known. */
  available?: boolean | null;
  /** Whether catalog data is stale/last-known-good. */
  stale?: boolean;
  /** Provider/backend status string for unavailable/stale offerings. */
  status?: string | null;
  /** Temporary bridge to legacy default-pool candidates until backend native candidates land. */
  machineSize?: VMSize | string;
  /** Whether the offering came from a provider API or curated static metadata. */
  catalogSource?: ProviderInstanceCatalogSource;
  /** ISO timestamp when this offering was observed from a provider API. Null for static data. */
  catalogLastSeenAt?: string | null;
  /** Non-secret provider/catalog metadata for diagnostics or future UI display. */
  catalogMetadata?: Record<string, unknown>;
}

export interface ProviderInstanceOffering extends ProviderCatalogOfferingInfo {
  provider: CredentialProvider;
  location: string;
  providerInstanceType: string;
  providerInstanceSku: string | null;
  displayName: string;
  vcpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  currency: string | null;
  catalogSource: ProviderInstanceCatalogSource;
  catalogLastSeenAt: string | null;
}

/** Catalog of available resources for a single provider */
export interface ProviderCatalog {
  provider: CredentialProvider;
  /** Non-secret credential/source identity for credential-backed catalogs. */
  credentialSource?: 'user' | 'project' | 'platform';
  /** Non-secret credential row ID for user/project credentials, when applicable. */
  credentialId?: string | null;
  locations: LocationInfo[];
  sizes: Record<VMSize, SizeInfo>;
  /** Provider-native instance offerings for compute-pool setup. */
  offerings?: ProviderInstanceOffering[];
  defaultLocation: string;
}

/** Response from GET /api/providers/catalog */
export interface ProviderCatalogResponse {
  catalogs: ProviderCatalog[];
  credentialSetupRequired?: boolean;
  credentialSetupMessage?: string;
}

export function isProviderInstanceCatalogSource(
  value: unknown
): value is ProviderInstanceCatalogSource {
  return (
    typeof value === 'string' &&
    (PROVIDER_INSTANCE_CATALOG_SOURCES as readonly string[]).includes(value)
  );
}
