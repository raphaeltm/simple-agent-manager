/**
 * Live Compute Engine list prices from the Cloud Billing Catalog API.
 *
 * Machine types are not priced as a unit. Each series is billed per vCPU-hour ("Core") and per
 * GiB-hour of memory ("Ram"), per region, through SKUs such as
 * "E2 Instance Core running in Americas" or "N2D AMD Instance Ram running in Belgium". A machine
 * type's hourly price is therefore vCPUs × core price + memory GiB × RAM price for its region.
 *
 * Docs: https://cloud.google.com/billing/docs/reference/rest/v1/services.skus/list
 */
import { providerFetch, throwIfProviderRequestAborted } from './provider-fetch';
import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import { parseProviderJson } from './validation';
import { expectObject, optionalArray, optionalString, requireString } from './validation-core';

export const GCP_BILLING_API_BASE = 'https://cloudbilling.googleapis.com/v1';
/** Cloud Billing service id for Compute Engine. */
export const GCP_COMPUTE_BILLING_SERVICE = 'services/6F81-5844-456A';
/** The Catalog API's documented maximum page size. */
export const GCP_BILLING_PAGE_SIZE = 5000;
export const GCP_PRICE_CURRENCY = 'USD';

/** Per-region on-demand unit prices for one machine series, in `GCP_PRICE_CURRENCY`. */
export interface GcpSeriesUnitPrices {
  /** Price per vCPU-hour. */
  coreHourly: number | null;
  /** Price per GiB-hour of memory. */
  ramGibHourly: number | null;
}

/** region → machine series (lower-case, e.g. `e2`, `n2d`) → unit prices. */
export interface GcpPriceTable {
  currency: typeof GCP_PRICE_CURRENCY;
  regions: Record<string, Record<string, GcpSeriesUnitPrices>>;
  /**
   * region → zonal `pd-balanced` capacity price per GiB-month, the boot disk type SAM creates
   * (`DEFAULT_GCP_BOOT_DISK_TYPE`). Optional: a table stored before boot disks were priced has
   * none, and its offerings show the machine price alone until the next refresh.
   */
  balancedDiskGibMonthly?: Record<string, number | null>;
}

/**
 * An on-demand VM core or RAM SKU: `<SERIES>[ <vendor>] Instance <Core|Ram> running in <place>`.
 * Anchoring at the start excludes Spot/Preemptible, Custom, Sole Tenancy and commitment SKUs,
 * whose descriptions put another word before or inside the pattern.
 */
const VM_UNIT_SKU = /^([A-Z][A-Z0-9]*)(?: (?:AMD|Intel|Arm))? Instance (Core|Ram) running in /;
const UNIT_FOR_KIND = { Core: 'h', Ram: 'GiBy.h' } as const;

interface ParsedUnitSku {
  series: string;
  kind: 'Core' | 'Ram';
  regions: string[];
  price: number;
}

/**
 * Zonal Balanced Persistent Disk capacity: "Balanced PD Capacity" (one SKU for a group of
 * regions) or "Balanced PD Capacity in Belgium". Anchored so "Regional Balanced PD Capacity"
 * (replicated disks, twice the price) never matches. Verified against the live catalog
 * 2026-11-14: unit `GiBy.mo`, usage type `OnDemand`.
 */
const BALANCED_DISK_SKU = /^Balanced PD Capacity(?: in .+)?$/;
const BALANCED_DISK_UNIT = 'GiBy.mo';

interface ParsedDiskSku {
  kind: 'BalancedDisk';
  regions: string[];
  price: number;
}

export type ParsedGcpSku = ParsedUnitSku | ParsedDiskSku;

/**
 * Parse one SKU into a unit price, or null when it is not an on-demand VM core/RAM SKU or its
 * pricing is not in the shape this parser understands. Anything unexpected is skipped rather than
 * guessed: a missing price shows as "unavailable", a wrong one would rank machines wrongly.
 */
export function parseGcpUnitSku(raw: unknown): ParsedGcpSku | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sku = raw as Record<string, unknown>;
  const description = typeof sku.description === 'string' ? sku.description : '';
  const category = sku.category as Record<string, unknown> | undefined;
  if (category?.usageType !== 'OnDemand') return null;
  const regions = Array.isArray(sku.serviceRegions)
    ? sku.serviceRegions.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];
  if (regions.length === 0) return null;

  const match = VM_UNIT_SKU.exec(description);
  if (match) {
    const kind = match[2] as 'Core' | 'Ram';
    const price = skuUnitPrice(sku, UNIT_FOR_KIND[kind]);
    return price === null
      ? null
      : { series: (match[1] as string).toLowerCase(), kind, regions, price };
  }
  if (BALANCED_DISK_SKU.test(description)) {
    const price = skuUnitPrice(sku, BALANCED_DISK_UNIT);
    return price === null ? null : { kind: 'BalancedDisk', regions, price };
  }
  return null;
}

/** The steady-state unit price of a SKU in `GCP_PRICE_CURRENCY`, or null for any other shape. */
function skuUnitPrice(sku: Record<string, unknown>, usageUnit: string): number | null {
  const pricingInfo = Array.isArray(sku.pricingInfo) ? sku.pricingInfo[0] : undefined;
  const expression = (pricingInfo as Record<string, unknown> | undefined)?.pricingExpression as
    Record<string, unknown> | undefined;
  if (expression?.usageUnit !== usageUnit) return null;
  const tiers = Array.isArray(expression.tieredRates) ? expression.tieredRates : [];
  // The last tier is the steady-state rate; earlier tiers (if any) cover free usage.
  const rate = tiers[tiers.length - 1] as Record<string, unknown> | undefined;
  const unitPrice = rate?.unitPrice as Record<string, unknown> | undefined;
  if (!unitPrice || unitPrice.currencyCode !== GCP_PRICE_CURRENCY) return null;
  const units = Number(unitPrice.units ?? 0);
  const nanos = Number(unitPrice.nanos ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  const price = units + nanos / 1e9;
  return price > 0 ? price : null;
}

/**
 * Fold parsed SKUs into a price table. Two different prices for the same region, series and kind
 * are a conflict this code cannot resolve, so that unit becomes unknown rather than either value.
 */
export function buildGcpPriceTable(skus: Iterable<ParsedGcpSku>): GcpPriceTable {
  const regions: GcpPriceTable['regions'] = {};
  const balancedDiskGibMonthly: Record<string, number | null> = {};
  const conflicts = new Set<string>();
  for (const sku of skus) {
    if (sku.kind === 'BalancedDisk') {
      for (const region of sku.regions) {
        const key = `${region}|balanced-disk`;
        if (conflicts.has(key)) continue;
        const existing = balancedDiskGibMonthly[region];
        if (existing !== undefined && existing !== sku.price) {
          balancedDiskGibMonthly[region] = null;
          conflicts.add(key);
          continue;
        }
        balancedDiskGibMonthly[region] = sku.price;
      }
      continue;
    }
    const field = sku.kind === 'Core' ? 'coreHourly' : 'ramGibHourly';
    for (const region of sku.regions) {
      const key = `${region}|${sku.series}|${field}`;
      if (conflicts.has(key)) continue;
      const series = (regions[region] ??= {});
      const prices = (series[sku.series] ??= { coreHourly: null, ramGibHourly: null });
      const existing = prices[field];
      if (existing !== null && existing !== sku.price) {
        prices[field] = null;
        conflicts.add(key);
        continue;
      }
      prices[field] = sku.price;
    }
  }
  return { currency: GCP_PRICE_CURRENCY, regions, balancedDiskGibMonthly };
}

export interface GcpPriceFetchOptions {
  /** Upper bound on pages read; exceeding it fails rather than returning a partial table. */
  maxPages: number;
  /** Timeout per page request. */
  requestTimeoutMs: number;
  /** Overridable for tests. */
  apiBase?: string;
}

/**
 * Read every Compute Engine SKU page and build the price table. Pages are parsed and dropped one
 * at a time, so memory scales with one page, not with the whole catalog.
 *
 * Bounds: `maxPages` × 5000 SKUs (the API maximum page size; default 20 pages = 100,000 SKUs).
 * A catalog larger than that fails loudly rather than storing a partial table. Wall time is
 * bounded by the caller's signal; the scheduled refresh passes `gcpCatalog.priceRefreshBudgetMs`
 * (default 90 s) across every page and credential.
 */
export async function fetchGcpComputePriceTable(
  accessToken: string,
  options: GcpPriceFetchOptions,
  context?: ProviderRequestContext
): Promise<GcpPriceTable> {
  const parsed: ParsedGcpSku[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  const base = options.apiBase ?? GCP_BILLING_API_BASE;

  for (let page = 0; page < options.maxPages; page += 1) {
    throwIfProviderRequestAborted(context);
    const params = new URLSearchParams({
      pageSize: String(GCP_BILLING_PAGE_SIZE),
      currencyCode: GCP_PRICE_CURRENCY,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await providerFetch(
      'gcp',
      `${base}/${GCP_COMPUTE_BILLING_SERVICE}/skus?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      options.requestTimeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const root = expectObject(
      await parseProviderJson(res, 'gcp', 'billingSkus'),
      'gcp',
      'billingSkus'
    );
    for (const sku of optionalArray(root, 'skus', 'gcp', 'billingSkus') ?? []) {
      const unit = parseGcpUnitSku(sku);
      if (unit) parsed.push(unit);
    }
    const next = optionalString(root, 'nextPageToken', 'gcp', 'billingSkus');
    if (!next) return buildGcpPriceTable(parsed);
    if (seenTokens.has(next)) {
      throw new ProviderError('gcp', undefined, 'GCP billing SKUs pagination repeated a page', {
        category: 'invalid_config',
      });
    }
    seenTokens.add(next);
    pageToken = next;
  }
  throw new ProviderError(
    'gcp',
    undefined,
    `GCP billing SKUs exceeded ${options.maxPages} pages; raise the page limit to read the full price list`,
    { category: 'invalid_config' }
  );
}

/**
 * Check that a token can read the Cloud Billing Catalog with one single-SKU request. Throws the
 * same `ProviderError` a full price download would (for example `SERVICE_DISABLED` when the
 * Cloud Billing API is off in the token's project), so callers classify it the same way.
 */
export async function probeGcpBillingAccess(
  accessToken: string,
  options: Pick<GcpPriceFetchOptions, 'requestTimeoutMs' | 'apiBase'>,
  context?: ProviderRequestContext
): Promise<void> {
  throwIfProviderRequestAborted(context);
  const base = options.apiBase ?? GCP_BILLING_API_BASE;
  const params = new URLSearchParams({ pageSize: '1', currencyCode: GCP_PRICE_CURRENCY });
  const res = await providerFetch(
    'gcp',
    `${base}/${GCP_COMPUTE_BILLING_SERVICE}/skus?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    options.requestTimeoutMs,
    undefined,
    context
  );
  throwIfProviderRequestAborted(context);
  expectObject(await parseProviderJson(res, 'gcp', 'billingSkus'), 'gcp', 'billingSkus');
}

/** Validate a stored price table read back from cache; null when it is not one. */
export function parseStoredGcpPriceTable(value: unknown): GcpPriceTable | null {
  try {
    const root = expectObject(value, 'gcp', 'storedPriceTable');
    if (requireString(root, 'currency', 'gcp', 'storedPriceTable') !== GCP_PRICE_CURRENCY) {
      return null;
    }
    const regions = expectObject(root.regions, 'gcp', 'storedPriceTable.regions');
    const out: GcpPriceTable['regions'] = {};
    for (const [region, seriesValue] of Object.entries(regions)) {
      const series = expectObject(seriesValue, 'gcp', 'storedPriceTable.series');
      const parsedSeries: Record<string, GcpSeriesUnitPrices> = {};
      for (const [name, pricesValue] of Object.entries(series)) {
        const prices = expectObject(pricesValue, 'gcp', 'storedPriceTable.prices');
        parsedSeries[name] = {
          coreHourly: finitePositiveOrNull(prices.coreHourly),
          ramGibHourly: finitePositiveOrNull(prices.ramGibHourly),
        };
      }
      out[region] = parsedSeries;
    }
    // Optional and newer than the rest: absent stays absent, so a caller can tell a table stored
    // before boot disks were priced (refresh it) from one with no disk price for a region. A
    // malformed disk map loses only the disk prices, never the core and RAM rates.
    const storedDisk = root.balancedDiskGibMonthly;
    if (storedDisk === undefined) return { currency: GCP_PRICE_CURRENCY, regions: out };
    const disk: Record<string, number | null> = {};
    if (storedDisk && typeof storedDisk === 'object' && !Array.isArray(storedDisk)) {
      for (const [region, price] of Object.entries(storedDisk)) {
        disk[region] = finitePositiveOrNull(price);
      }
    }
    return { currency: GCP_PRICE_CURRENCY, regions: out, balancedDiskGibMonthly: disk };
  } catch {
    return null;
  }
}

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
