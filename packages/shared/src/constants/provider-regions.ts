import { type LocationMeta, PROVIDER_LOCATIONS } from './providers';

/**
 * Regions for providers whose locations are zones inside a region. People choose regions; SAM
 * places into any of a chosen region's zones. Providers not listed here use the location itself
 * as the region (`providerLocationRegion`).
 *
 * GCP names follow Google's Compute Engine region table
 * (https://cloud.google.com/compute/docs/regions-zones, read 2026-11-09). Google adds regions
 * over time; an unlisted region still works and shows its id.
 */
const GCP_REGIONS: readonly LocationMeta[] = [
  { id: 'africa-south1', name: 'Johannesburg', country: 'ZA' },
  { id: 'asia-east1', name: 'Taiwan', country: 'TW' },
  { id: 'asia-east2', name: 'Hong Kong', country: 'HK' },
  { id: 'asia-northeast1', name: 'Tokyo', country: 'JP' },
  { id: 'asia-northeast2', name: 'Osaka', country: 'JP' },
  { id: 'asia-northeast3', name: 'Seoul', country: 'KR' },
  { id: 'asia-south1', name: 'Mumbai', country: 'IN' },
  { id: 'asia-south2', name: 'Delhi', country: 'IN' },
  { id: 'asia-southeast1', name: 'Singapore', country: 'SG' },
  { id: 'asia-southeast2', name: 'Jakarta', country: 'ID' },
  { id: 'asia-southeast3', name: 'Bangkok', country: 'TH' },
  { id: 'australia-southeast1', name: 'Sydney', country: 'AU' },
  { id: 'australia-southeast2', name: 'Melbourne', country: 'AU' },
  { id: 'europe-central2', name: 'Warsaw', country: 'PL' },
  { id: 'europe-north1', name: 'Finland', country: 'FI' },
  { id: 'europe-north2', name: 'Stockholm', country: 'SE' },
  { id: 'europe-southwest1', name: 'Madrid', country: 'ES' },
  { id: 'europe-west1', name: 'Belgium', country: 'BE' },
  { id: 'europe-west10', name: 'Berlin', country: 'DE' },
  { id: 'europe-west12', name: 'Turin', country: 'IT' },
  { id: 'europe-west2', name: 'London', country: 'GB' },
  { id: 'europe-west3', name: 'Frankfurt', country: 'DE' },
  { id: 'europe-west4', name: 'Netherlands', country: 'NL' },
  { id: 'europe-west6', name: 'Zurich', country: 'CH' },
  { id: 'europe-west8', name: 'Milan', country: 'IT' },
  { id: 'europe-west9', name: 'Paris', country: 'FR' },
  { id: 'me-central1', name: 'Doha', country: 'QA' },
  { id: 'me-central2', name: 'Dammam', country: 'SA' },
  { id: 'me-west1', name: 'Tel Aviv', country: 'IL' },
  { id: 'northamerica-northeast1', name: 'Montréal', country: 'CA' },
  { id: 'northamerica-northeast2', name: 'Toronto', country: 'CA' },
  { id: 'northamerica-south1', name: 'Querétaro', country: 'MX' },
  { id: 'southamerica-east1', name: 'São Paulo', country: 'BR' },
  { id: 'southamerica-west1', name: 'Santiago', country: 'CL' },
  { id: 'us-central1', name: 'Iowa', country: 'US' },
  { id: 'us-east1', name: 'South Carolina', country: 'US' },
  { id: 'us-east4', name: 'Virginia', country: 'US' },
  { id: 'us-east5', name: 'Columbus', country: 'US' },
  { id: 'us-south1', name: 'Dallas', country: 'US' },
  { id: 'us-west1', name: 'Oregon', country: 'US' },
  { id: 'us-west2', name: 'Los Angeles', country: 'US' },
  { id: 'us-west3', name: 'Salt Lake City', country: 'US' },
  { id: 'us-west4', name: 'Las Vegas', country: 'US' },
];

/** Scaleway zones are `<region>-<n>` (`fr-par-2`). */
const SCALEWAY_REGIONS: readonly LocationMeta[] = [
  { id: 'fr-par', name: 'Paris', country: 'FR' },
  { id: 'nl-ams', name: 'Amsterdam', country: 'NL' },
  { id: 'pl-waw', name: 'Warsaw', country: 'PL' },
];

const ZONED_PROVIDER_REGIONS: Readonly<Record<string, readonly LocationMeta[]>> = {
  gcp: GCP_REGIONS,
  scaleway: SCALEWAY_REGIONS,
};

/** Trailing zone suffix per zoned provider: `europe-west1-b`, `fr-par-2`. */
const ZONE_SUFFIX: Readonly<Record<string, RegExp>> = {
  gcp: /-[a-z]$/,
  scaleway: /-\d+$/,
};

/**
 * The region a provider location belongs to. For providers without zones the location is the
 * region. Pure string work: an unknown provider or location returns the location unchanged.
 */
export function providerLocationRegion(provider: string, location: string): string {
  const suffix = ZONE_SUFFIX[provider];
  return suffix ? location.replace(suffix, '') : location;
}

/** Name and country for a region, or null when SAM has no label for it. */
export function providerRegionMeta(provider: string, region: string): LocationMeta | null {
  const zoned = ZONED_PROVIDER_REGIONS[provider];
  const list = zoned ?? PROVIDER_LOCATIONS[provider as keyof typeof PROVIDER_LOCATIONS] ?? [];
  return list.find((entry) => entry.id === region) ?? null;
}
