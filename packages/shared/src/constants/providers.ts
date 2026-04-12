import { CREDENTIAL_PROVIDERS,type CredentialProvider } from '../types';

// =============================================================================
// Provider Display Labels
// =============================================================================

/** Human-readable display labels for credential providers. */
export const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  hetzner: 'Hetzner',
  scaleway: 'Scaleway',
  gcp: 'Google Cloud',
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
};

/** Default location per provider. */
export const PROVIDER_DEFAULT_LOCATIONS: Record<CredentialProvider, string> = {
  hetzner: 'fsn1',
  scaleway: 'fr-par-1',
  gcp: 'us-central1-a',
};

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
