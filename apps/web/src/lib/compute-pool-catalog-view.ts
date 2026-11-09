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
  /** In each provider's own currency: prices are never converted. */
  maxMonthlyPrice: number | null;
  hideUnavailable: boolean;
}

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  query: '',
  view: 'all',
  accounts: new Set(),
  continents: new Set(),
  minVcpu: null,
  minMemoryGb: null,
  maxMonthlyPrice: null,
  hideUnavailable: true,
};

/** Rows matching the filters. A row in the pool is never hidden as unavailable. */
export function filterCatalogRows(
  rows: MachineRegionRow[],
  filters: CatalogFilters,
  draft: RegionDraft,
  accountLabels: ReadonlyMap<string, string>
): MachineRegionRow[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const inPool = isRowAllowed(row, draft);
    if (filters.view === 'in' && !inPool) return false;
    if (filters.view === 'out' && inPool) return false;
    if (filters.hideUnavailable && !inPool && !row.canAllow) return false;
    if (filters.accounts.size > 0 && !filters.accounts.has(row.sourceId)) return false;
    if (filters.continents.size > 0 && !filters.continents.has(row.continent)) return false;
    if (filters.minVcpu !== null && (row.vcpu ?? 0) < filters.minVcpu) return false;
    if (filters.minMemoryGb !== null && (row.ramGb ?? 0) < filters.minMemoryGb) return false;
    if (
      filters.maxMonthlyPrice !== null &&
      (row.monthlyPrice === null || row.monthlyPrice > filters.maxMonthlyPrice)
    ) {
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
      return compareNumbers(a.monthlyPrice, b.monthlyPrice);
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
