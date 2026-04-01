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

/** Catalog of available resources for a single provider */
export interface ProviderCatalog {
  provider: CredentialProvider;
  locations: LocationInfo[];
  sizes: Record<VMSize, SizeInfo>;
  defaultLocation: string;
}

/** Response from GET /api/providers/catalog */
export interface ProviderCatalogResponse {
  catalogs: ProviderCatalog[];
}
