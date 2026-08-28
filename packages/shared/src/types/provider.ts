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

/** Provider-native instance offering metadata. */
export interface ProviderCatalogOfferingInfo {
  /** Stable provider-native offering identifier when the provider exposes one. */
  id?: string;
  /** Provider SKU / server type / machine type (e.g., 'cx23', 'cpx31', 'n2-standard-4'). */
  sku?: string;
  /** Alias used by some providers/APIs for the provider SKU. */
  instanceType?: string;
  /** Legacy alias used by the existing catalog shape. */
  type?: string;
  /** Human-readable label if it differs from the SKU. */
  name?: string;
  /** Provider-specific region/location identifier. */
  location: string;
  /** Human-readable location name. */
  locationName?: string;
  /** ISO country/market code when known. */
  country?: string;
  /** vCPU count when known. */
  vcpu?: number;
  /** RAM in GB when known. */
  ramGb?: number;
  /** Memory in GB when providers call it memory instead of RAM. */
  memoryGb?: number;
  /** Memory in MB for APIs that use integer MB values. */
  memoryMb?: number;
  /** Storage/disk in GB when known. */
  storageGb?: number;
  /** Disk in GB when providers call it disk instead of storage. */
  diskGb?: number;
  /** Provider-formatted price string. */
  price?: string;
  /** Numeric monthly price when the backend can normalize it. */
  priceMonthlyUsd?: number;
  /** Numeric hourly price when the backend can normalize it. */
  priceHourlyUsd?: number;
  /** Currency for normalized prices when known. */
  currency?: string;
  /** Current provider availability when known. */
  available?: boolean;
  /** Whether catalog data is stale/last-known-good. */
  stale?: boolean;
  /** Provider/backend status string for unavailable/stale offerings. */
  status?: string;
  /** Temporary bridge to legacy default-pool candidates until backend native candidates land. */
  machineSize?: VMSize | string;
}

/** Catalog of available resources for a single provider */
export interface ProviderCatalog {
  provider: CredentialProvider;
  locations: LocationInfo[];
  sizes: Record<VMSize, SizeInfo>;
  /** Provider-native instance offerings. Omitted by the legacy catalog endpoint. */
  offerings?: ProviderCatalogOfferingInfo[];
  defaultLocation: string;
}

/** Response from GET /api/providers/catalog */
export interface ProviderCatalogResponse {
  catalogs: ProviderCatalog[];
}
