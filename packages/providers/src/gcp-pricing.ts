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
 * Parse one SKU into a unit price, or null when it is not an on-demand VM core/RAM SKU or its
 * pricing is not in the shape this parser understands. Anything unexpected is skipped rather than
 * guessed: a missing price shows as "unavailable", a wrong one would rank machines wrongly.
 */
export function parseGcpUnitSku(raw: unknown): ParsedUnitSku | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sku = raw as Record<string, unknown>;
  const description = typeof sku.description === 'string' ? sku.description : '';
  const match = VM_UNIT_SKU.exec(description);
  if (!match) return null;
  const category = sku.category as Record<string, unknown> | undefined;
  if (category?.usageType !== 'OnDemand') return null;
  const regions = Array.isArray(sku.serviceRegions)
    ? sku.serviceRegions.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];
  if (regions.length === 0) return null;

  const kind = match[2] as 'Core' | 'Ram';
  const pricingInfo = Array.isArray(sku.pricingInfo) ? sku.pricingInfo[0] : undefined;
  const expression = (pricingInfo as Record<string, unknown> | undefined)?.pricingExpression as
    Record<string, unknown> | undefined;
  if (expression?.usageUnit !== UNIT_FOR_KIND[kind]) return null;
  const tiers = Array.isArray(expression.tieredRates) ? expression.tieredRates : [];
  // The last tier is the steady-state rate; earlier tiers (if any) cover free usage.
  const rate = tiers[tiers.length - 1] as Record<string, unknown> | undefined;
  const unitPrice = rate?.unitPrice as Record<string, unknown> | undefined;
  if (!unitPrice || unitPrice.currencyCode !== GCP_PRICE_CURRENCY) return null;
  const units = Number(unitPrice.units ?? 0);
  const nanos = Number(unitPrice.nanos ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  const price = units + nanos / 1e9;
  if (!(price > 0)) return null;

  return { series: (match[1] as string).toLowerCase(), kind, regions, price };
}

/**
 * Fold parsed SKUs into a price table. Two different prices for the same region, series and kind
 * are a conflict this code cannot resolve, so that unit becomes unknown rather than either value.
 */
export function buildGcpPriceTable(skus: Iterable<ParsedUnitSku>): GcpPriceTable {
  const regions: GcpPriceTable['regions'] = {};
  const conflicts = new Set<string>();
  for (const sku of skus) {
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
  return { currency: GCP_PRICE_CURRENCY, regions };
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
 */
export async function fetchGcpComputePriceTable(
  accessToken: string,
  options: GcpPriceFetchOptions,
  context?: ProviderRequestContext
): Promise<GcpPriceTable> {
  const parsed: ParsedUnitSku[] = [];
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
    return { currency: GCP_PRICE_CURRENCY, regions: out };
  } catch {
    return null;
  }
}

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
