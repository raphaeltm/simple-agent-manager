import { CREDENTIAL_PROVIDERS,type CredentialProvider } from '../types';

// =============================================================================
// Provider Display Labels
// =============================================================================

/** Human-readable display labels for credential providers. */
export const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  hetzner: 'Hetzner',
  scaleway: 'Scaleway',
  gcp: 'Google Cloud',
  vultr: 'Vultr',
  digitalocean: 'DigitalOcean',
};

/** Provider console URLs and help text for onboarding / credential setup. */
export interface ProviderHelpMeta {
  description: string;
  helpUrl: string;
  helpText: string;
}

export const PROVIDER_HELP: Record<CredentialProvider, ProviderHelpMeta> = {
  hetzner: {
    description: 'European cloud, great value',
    helpUrl: 'https://console.hetzner.cloud/projects',
    helpText: 'Go to your project \u2192 Security \u2192 API Tokens \u2192 Generate API Token (Read & Write)',
  },
  scaleway: {
    description: 'European cloud, GPU options',
    helpUrl: 'https://console.scaleway.com/iam/api-keys',
    helpText: 'Go to IAM \u2192 API Keys \u2192 Generate an API Key',
  },
  gcp: {
    description: 'Google Cloud Platform',
    helpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    helpText: 'Set up Workload Identity Federation or create a service account key',
  },
  vultr: {
    description: 'Global cloud, hourly billing',
    helpUrl: 'https://my.vultr.com/settings/#settingsapi',
    helpText:
      'Go to Account → API, enable API access, and set Access Control to "Allow All IPv4/IPv6" (SAM calls from Cloudflare with no fixed IP), then copy your Personal Access Token',
  },
  digitalocean: {
    description: 'Global cloud, simple droplets',
    helpUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    helpText:
      'Go to API → Tokens/Keys → Generate New Token with Full Access (or custom scopes covering droplet, block_storage, tag, image, region, size, account, and actions), then copy your Personal Access Token',
  },
};

// =============================================================================
// VM Location Display Names (all providers)
// =============================================================================

/** Metadata for a VM location. */
export interface LocationMeta {
  id: string;
  name: string;
  country: string;
}

/** Provider-keyed location registry. Source of truth for valid provider–location pairs. */
export const PROVIDER_LOCATIONS: Record<CredentialProvider, LocationMeta[]> = {
  hetzner: [
    { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
    { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
    { id: 'hel1', name: 'Helsinki', country: 'FI' },
    { id: 'ash', name: 'Ashburn', country: 'US' },
    { id: 'hil', name: 'Hillsboro', country: 'US' },
  ],
  scaleway: [
    { id: 'fr-par-1', name: 'Paris 1', country: 'FR' },
    { id: 'fr-par-2', name: 'Paris 2', country: 'FR' },
    { id: 'fr-par-3', name: 'Paris 3', country: 'FR' },
    { id: 'nl-ams-1', name: 'Amsterdam 1', country: 'NL' },
    { id: 'nl-ams-2', name: 'Amsterdam 2', country: 'NL' },
    { id: 'nl-ams-3', name: 'Amsterdam 3', country: 'NL' },
    { id: 'pl-waw-1', name: 'Warsaw 1', country: 'PL' },
    { id: 'pl-waw-2', name: 'Warsaw 2', country: 'PL' },
  ],
  gcp: [
    { id: 'us-central1-a', name: 'Iowa', country: 'US' },
    { id: 'us-east1-b', name: 'South Carolina', country: 'US' },
    { id: 'us-west1-a', name: 'Oregon', country: 'US' },
    { id: 'europe-west1-b', name: 'Belgium', country: 'BE' },
    { id: 'europe-west3-a', name: 'Frankfurt', country: 'DE' },
    { id: 'europe-west2-a', name: 'London', country: 'GB' },
    { id: 'asia-southeast1-a', name: 'Singapore', country: 'SG' },
    { id: 'asia-northeast1-a', name: 'Tokyo', country: 'JP' },
  ],
  vultr: [
    { id: 'fra', name: 'Frankfurt', country: 'DE' },
    { id: 'ams', name: 'Amsterdam', country: 'NL' },
    { id: 'lhr', name: 'London', country: 'GB' },
    { id: 'ewr', name: 'New Jersey', country: 'US' },
    { id: 'ord', name: 'Chicago', country: 'US' },
    { id: 'lax', name: 'Los Angeles', country: 'US' },
    { id: 'nrt', name: 'Tokyo', country: 'JP' },
    { id: 'sgp', name: 'Singapore', country: 'SG' },
    { id: 'syd', name: 'Sydney', country: 'AU' },
  ],
  digitalocean: [
    { id: 'fra1', name: 'Frankfurt', country: 'DE' },
    { id: 'ams3', name: 'Amsterdam', country: 'NL' },
    { id: 'lon1', name: 'London', country: 'GB' },
    { id: 'nyc1', name: 'New York 1', country: 'US' },
    { id: 'nyc3', name: 'New York 3', country: 'US' },
    { id: 'sfo3', name: 'San Francisco', country: 'US' },
    { id: 'tor1', name: 'Toronto', country: 'CA' },
    { id: 'sgp1', name: 'Singapore', country: 'SG' },
    { id: 'blr1', name: 'Bangalore', country: 'IN' },
    { id: 'syd1', name: 'Sydney', country: 'AU' },
  ],
};

/** Default location per provider. */
export const PROVIDER_DEFAULT_LOCATIONS: Record<CredentialProvider, string> = {
  hetzner: 'fsn1',
  scaleway: 'fr-par-1',
  gcp: 'us-central1-a',
  vultr: 'fra',
  digitalocean: 'fra1',
};

// =============================================================================
// BYOC compute credential gating (DRY helper for the has-cloud onboarding gates)
// =============================================================================

/**
 * Token-based BYOC compute providers that count as "a cloud provider is connected"
 * for the onboarding / has-cloud-provider gates. A single API token connected for
 * any of these makes the user immediately provisionable.
 *
 * GCP is intentionally EXCLUDED: it requires a multi-step Workload Identity
 * Federation handshake, and its has-cloud gating is a pre-existing question tracked
 * separately (tasks/backlog/2026-07-23-credential-routes-preexisting-hardening.md).
 * Do not add GCP here without addressing that follow-up.
 */
export const TOKEN_COMPUTE_PROVIDERS = ['hetzner', 'scaleway', 'vultr', 'digitalocean'] as const;

/**
 * True when the credential list contains at least one BYOC token-compute credential
 * (Hetzner / Scaleway / Vultr / DigitalOcean). Excludes GCP by design — see
 * TOKEN_COMPUTE_PROVIDERS. Shared by every "does the user have a cloud provider"
 * onboarding gate so the provider set lives in exactly one place.
 */
export function hasByocComputeCredential(
  credentials: ReadonlyArray<{ provider: string }>,
): boolean {
  const providers = TOKEN_COMPUTE_PROVIDERS as readonly string[];
  return credentials.some((c) => providers.includes(c.provider));
}

/** Flat lookup of all locations (derived from PROVIDER_LOCATIONS). */
export const VM_LOCATIONS: Record<string, { name: string; country: string }> = Object.fromEntries(
  Object.values(PROVIDER_LOCATIONS)
    .flat()
    .map((loc) => [loc.id, { name: loc.name, country: loc.country }])
);

/** Type guard: check if a string is a valid CredentialProvider. Use at system boundaries for untrusted input. */
export function isValidProvider(value: string): value is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

/** Get valid locations for a provider. */
export function getLocationsForProvider(provider: CredentialProvider): LocationMeta[] {
  return PROVIDER_LOCATIONS[provider];
}

/** Get the default location for a provider. */
export function getDefaultLocationForProvider(provider: CredentialProvider): string {
  return PROVIDER_DEFAULT_LOCATIONS[provider];
}

/** Check if a location is valid for the given provider. */
export function isValidLocationForProvider(provider: CredentialProvider, location: string): boolean {
  return PROVIDER_LOCATIONS[provider].some((loc) => loc.id === location);
}
