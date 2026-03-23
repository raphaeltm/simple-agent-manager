import type { VMSize } from './common';

// =============================================================================
// Credential
// =============================================================================
export const CREDENTIAL_PROVIDERS = ['hetzner', 'scaleway', 'gcp'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export interface Credential {
  id: string;
  userId: string;
  provider: CredentialProvider;
  encryptedToken: string;
  iv: string;
  createdAt: string;
  updatedAt: string;
}

/** API response (safe to expose - no encrypted data) */
export interface CredentialResponse {
  id: string;
  provider: CredentialProvider;
  connected: boolean;
  createdAt: string;
}

/**
 * Create credential request — discriminated by provider.
 * Hetzner uses a single API token; Scaleway requires secretKey + projectId.
 */
export type CreateCredentialRequest =
  | { provider: 'hetzner'; token: string }
  | { provider: 'scaleway'; secretKey: string; projectId: string }
  | { provider: 'gcp'; gcpProjectId: string; gcpProjectNumber: string; serviceAccountEmail: string; wifPoolId: string; wifProviderId: string; defaultZone: string };

// =============================================================================
// GCP OIDC Credential (stored after Connect GCP flow)
// =============================================================================

/** GCP OIDC credential — public identifiers, not secrets. Stored encrypted for consistency. */
export interface GcpOidcCredential {
  provider: 'gcp';
  gcpProjectId: string;
  gcpProjectNumber: string;
  serviceAccountEmail: string;
  wifPoolId: string;
  wifProviderId: string;
  defaultZone: string;
}

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
