import type { Continent, MachineRegionRow, RegionDraft } from './compute-pool-region-rows';
import { isRowAllowed } from './compute-pool-region-rows';

export type CatalogView = 'all' | 'in' | 'out';
export type CatalogSortKey =
  'provider' | 'machine' | 'vcpu' | 'memory' | 'disk' | 'region' | 'price';

export interface CatalogSort {
  key: CatalogSortKey;
  direction: 'asc' | 'desc';
}

export interface CatalogFilters {
  query: string;
  view: CatalogView;
  /** Accounts to show; empty shows every account. */
  accounts: ReadonlySet<string>;
  /** Continents to show; empty shows every continent. */
  continents: ReadonlySet<Continent>;
  minVcpu: number | null;
  minMemoryGb: number | null;
  /**
   * Highest monthly price per currency marker (see `priceCurrency`). Prices are never
   * converted, so a limit only applies to rows priced in its own currency.
   */
  maxMonthlyPrices: ReadonlyMap<string, number>;
  hideUnavailable: boolean;
}

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  query: '',
  view: 'all',
  accounts: new Set(),
  continents: new Set(),
  minVcpu: null,
  minMemoryGb: null,
  maxMonthlyPrices: new Map(),
  hideUnavailable: true,
};

/** Currency markers present in the rows, for one price limit each. */
export function catalogCurrencies(rows: MachineRegionRow[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.currency ? [row.currency] : [])))].sort(
    compareText
  );
}

/**
 * Rows matching the filters. A row in the pool is never hidden as unavailable, and a row the
 * person changed in this edit stays listed whatever the view, so its button keeps focus and the
 * change can be undone where it was made.
 */
export function filterCatalogRows(
  rows: MachineRegionRow[],
  filters: CatalogFilters,
  draft: RegionDraft,
  accountLabels: ReadonlyMap<string, string>
): MachineRegionRow[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const inPool = isRowAllowed(row, draft);
    const changed = draft.has(row.key);
    if (!changed && filters.view === 'in' && !inPool) return false;
    if (!changed && filters.view === 'out' && inPool) return false;
    if (!changed && filters.hideUnavailable && !inPool && !row.canAllow) return false;
    if (filters.accounts.size > 0 && !filters.accounts.has(row.sourceId)) return false;
    if (filters.continents.size > 0 && !filters.continents.has(row.continent)) return false;
    if (filters.minVcpu !== null && (row.vcpu ?? 0) < filters.minVcpu) return false;
    if (filters.minMemoryGb !== null && (row.ramGb ?? 0) < filters.minMemoryGb) return false;
    const maxPrice = row.currency ? filters.maxMonthlyPrices.get(row.currency) : undefined;
    if (maxPrice !== undefined && (row.monthlyPrice === null || row.monthlyPrice > maxPrice)) {
      return false;
    }
    if (terms.length === 0) return true;
    const haystack = [
      row.providerLabel,
      accountLabels.get(row.sourceId) ?? '',
      row.sku,
      row.region,
      row.regionLabel,
      row.country ?? '',
      row.continent,
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function compareNumbers(a: number | null, b: number | null): number {
  // Unknown values sort last in either direction.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Account order first (the pool's priority), then machine size, then region. */
function defaultCompare(
  a: MachineRegionRow,
  b: MachineRegionRow,
  accountRank: ReadonlyMap<string, number>
): number {
  return (
    (accountRank.get(a.sourceId) ?? Number.MAX_SAFE_INTEGER) -
      (accountRank.get(b.sourceId) ?? Number.MAX_SAFE_INTEGER) ||
    compareNumbers(a.vcpu, b.vcpu) ||
    compareNumbers(a.ramGb, b.ramGb) ||
    compareText(a.sku, b.sku) ||
    compareText(a.regionLabel, b.regionLabel) ||
    compareText(a.key, b.key)
  );
}

function compareBy(key: CatalogSortKey, a: MachineRegionRow, b: MachineRegionRow): number {
  switch (key) {
    case 'provider':
      return compareText(a.providerLabel, b.providerLabel);
    case 'machine':
      return compareText(a.sku, b.sku);
    case 'vcpu':
      return compareNumbers(a.vcpu, b.vcpu);
    case 'memory':
      return compareNumbers(a.ramGb, b.ramGb);
    case 'disk':
      return compareNumbers(a.diskGb, b.diskGb);
    case 'region':
      return compareText(a.regionLabel, b.regionLabel);
    case 'price':
      // Grouped by currency, then by amount: amounts in different currencies are not compared.
      if (a.monthlyPrice === null || b.monthlyPrice === null) {
        return compareNumbers(a.monthlyPrice, b.monthlyPrice);
      }
      return compareText(a.currency ?? '', b.currency ?? '') || a.monthlyPrice - b.monthlyPrice;
  }
}

function sortValueUnknown(key: CatalogSortKey, row: MachineRegionRow): boolean {
  if (key === 'vcpu') return row.vcpu === null;
  if (key === 'memory') return row.ramGb === null;
  if (key === 'disk') return row.diskGb === null;
  if (key === 'price') return row.monthlyPrice === null;
  return false;
}

export function sortCatalogRows(
  rows: MachineRegionRow[],
  sort: CatalogSort | null,
  accountRank: ReadonlyMap<string, number>
): MachineRegionRow[] {
  return [...rows].sort((a, b) => {
    if (sort) {
      const primary = compareBy(sort.key, a, b);
      // Unknown values stay last when descending too.
      const unknown = sortValueUnknown(sort.key, a) || sortValueUnknown(sort.key, b);
      if (primary !== 0) return sort.direction === 'desc' && !unknown ? -primary : primary;
    }
    return defaultCompare(a, b, accountRank);
  });
}

/** Sort choices for the list where there are no column headers (narrow screens). */
export const CATALOG_SORT_OPTIONS: ReadonlyArray<{ key: CatalogSortKey; label: string }> = [
  { key: 'machine', label: 'Machine' },
  { key: 'provider', label: 'Provider' },
  { key: 'vcpu', label: 'vCPU' },
  { key: 'memory', label: 'Memory' },
  { key: 'disk', label: 'Disk' },
  { key: 'region', label: 'Region' },
  { key: 'price', label: 'Price (by currency)' },
];

/** Header click cycles ascending, descending, back to the default order. */
export function nextSort(current: CatalogSort | null, key: CatalogSortKey): CatalogSort | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return null;
}

/** Rows that are the cheapest region for their machine type, when regions differ in price. */
export function cheapestRegionKeys(rows: MachineRegionRow[]): Set<string> {
  const byMachine = new Map<string, MachineRegionRow[]>();
  for (const row of rows) {
    const key = `${row.sourceId}|${row.sku}`;
    byMachine.set(key, [...(byMachine.get(key) ?? []), row]);
  }
  const cheapest = new Set<string>();
  for (const group of byMachine.values()) {
    const prices = group.map((row) => row.monthlyPrice).filter((p): p is number => p !== null);
    if (prices.length < 2) continue;
    const min = Math.min(...prices);
    if (min === Math.max(...prices)) continue;
    for (const row of group) if (row.monthlyPrice === min) cheapest.add(row.key);
  }
  return cheapest;
}
