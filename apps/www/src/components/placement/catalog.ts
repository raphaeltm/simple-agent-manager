/**
 * Machine catalog snapshot for the placement explorer.
 *
 * PROVENANCE — snapshotted 2026-09-09 from `packages/providers`:
 *   HETZNER_SIZE_CONFIGS      + HETZNER_LOCATIONS      (hetzner-metadata.ts)
 *   SCALEWAY_SIZE_CONFIGS     + SCALEWAY_LOCATIONS     (scaleway.ts)
 *   DIGITALOCEAN_SIZE_CONFIGS + DIGITALOCEAN_LOCATIONS (digitalocean-metadata.ts)
 *   VULTR_SIZE_CONFIGS        + VULTR_LOCATIONS        (vultr-metadata.ts)
 *
 * This is a SNAPSHOT, not an import. `apps/www` is a static marketing build and must not pull
 * the Workers-oriented providers package into its runtime bundle. `tests/placement-catalog.test.ts`
 * imports the real symbols and fails if this file drifts from them, so the snapshot cannot go
 * stale silently.
 *
 * UpCloud and Infomaniak are deliberately excluded: their catalog entries carry
 * `price: 'provider-priced'` / `'usage-based'` with no numeric value, so price-ordered ranking —
 * the thing this explorer teaches — would be undefined for them.
 *
 * Two declared simplifications, both surfaced in the accompanying article:
 *   1. One price per SKU across every region. Real catalogs price some regions differently
 *      (Hetzner's US locations cost materially more than its EU ones). Same-price regions are
 *      the interesting case here, and they are real: production `capacity_pool_candidates` shows
 *      cx33 at an identical price in fsn1, nbg1 and hel1.
 *   2. Prices are the in-repo catalog's values, which are display defaults rather than live
 *      billing figures.
 */

/** Hours per month used to normalize hourly catalog prices. Mirrors
 * `DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS` in `packages/shared/src/constants/billing.ts`. */
export const APPROXIMATE_BILLING_MONTH_HOURS = 730;

export type ProviderId = 'hetzner' | 'scaleway' | 'digitalocean' | 'vultr';
export type Tier = 'small' | 'medium' | 'large';

export interface CatalogOffering {
  readonly provider: ProviderId;
  readonly tier: Tier;
  /** Real provider SKU, e.g. `cx33`. */
  readonly instanceType: string;
  readonly vcpu: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly monthlyCents: number;
}

export interface ProviderCatalog {
  readonly id: ProviderId;
  readonly label: string;
  readonly currency: string;
  readonly currencySymbol: string;
  readonly regions: readonly string[];
  readonly offerings: readonly CatalogOffering[];
}

const GB = 1024;

function offering(
  provider: ProviderId,
  tier: Tier,
  instanceType: string,
  vcpu: number,
  ramGb: number,
  storageGb: number,
  monthlyCents: number
): CatalogOffering {
  return {
    provider,
    tier,
    instanceType,
    vcpu,
    memoryMb: ramGb * GB,
    diskMb: storageGb * GB,
    monthlyCents,
  };
}

export const PROVIDER_CATALOG: Readonly<Record<ProviderId, ProviderCatalog>> = {
  hetzner: {
    id: 'hetzner',
    label: 'Hetzner',
    currency: 'EUR',
    currencySymbol: '€',
    regions: ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'],
    offerings: [
      offering('hetzner', 'small', 'cx23', 2, 4, 40, 399),
      offering('hetzner', 'medium', 'cx33', 4, 8, 80, 749),
      offering('hetzner', 'large', 'cx43', 8, 16, 160, 1449),
    ],
  },
  scaleway: {
    id: 'scaleway',
    label: 'Scaleway',
    currency: 'EUR',
    currencySymbol: '€',
    regions: ['fr-par-1', 'fr-par-2', 'fr-par-3', 'nl-ams-1', 'nl-ams-2', 'nl-ams-3', 'pl-waw-1', 'pl-waw-2'],
    offerings: [
      // Hourly catalog prices normalized at 730 h/month.
      offering('scaleway', 'small', 'DEV1-M', 3, 4, 40, Math.round(0.024 * APPROXIMATE_BILLING_MONTH_HOURS * 100)),
      offering('scaleway', 'medium', 'DEV1-XL', 4, 12, 120, Math.round(0.048 * APPROXIMATE_BILLING_MONTH_HOURS * 100)),
      offering('scaleway', 'large', 'GP1-S', 8, 32, 600, Math.round(0.084 * APPROXIMATE_BILLING_MONTH_HOURS * 100)),
    ],
  },
  digitalocean: {
    id: 'digitalocean',
    label: 'DigitalOcean',
    currency: 'USD',
    currencySymbol: '$',
    regions: ['fra1', 'ams3', 'lon1', 'nyc1', 'nyc3', 'sfo3', 'tor1', 'sgp1', 'blr1', 'syd1'],
    offerings: [
      offering('digitalocean', 'small', 's-2vcpu-4gb', 2, 4, 80, 2400),
      offering('digitalocean', 'medium', 's-4vcpu-8gb', 4, 8, 160, 4800),
      offering('digitalocean', 'large', 's-8vcpu-16gb', 8, 16, 320, 9600),
    ],
  },
  vultr: {
    id: 'vultr',
    label: 'Vultr',
    currency: 'USD',
    currencySymbol: '$',
    regions: ['fra', 'ams', 'lhr', 'ewr', 'ord', 'lax', 'nrt', 'sgp', 'syd'],
    offerings: [
      offering('vultr', 'small', 'vc2-2c-4gb', 2, 4, 80, 2000),
      offering('vultr', 'medium', 'vc2-4c-8gb', 4, 8, 160, 4000),
      offering('vultr', 'large', 'vc2-6c-16gb', 6, 16, 320, 8000),
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDER_CATALOG) as ProviderId[];

/** Default region selection: enough to show a same-price tie without crowding the UI. */
export const DEFAULT_REGION_COUNT = 3;

export function formatPrice(catalog: ProviderCatalog, monthlyCents: number): string {
  return `${catalog.currencySymbol}${(monthlyCents / 100).toFixed(2)}/mo`;
}

/** Every (offering x selected region) pair — the candidate set placement ranks over. */
export function candidatesFor(
  catalog: ProviderCatalog,
  regions: readonly string[]
): { offering: CatalogOffering; region: string }[] {
  const pairs: { offering: CatalogOffering; region: string }[] = [];
  for (const region of regions) {
    for (const item of catalog.offerings) pairs.push({ offering: item, region });
  }
  return pairs;
}
