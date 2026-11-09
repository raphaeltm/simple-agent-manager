import { providerLocationRegion, providerRegionMeta } from '@simple-agent-manager/shared';

import type { MachineCell, MachineDraft, MachineGroup } from './compute-pool-machines';

/**
 * One row of the pool editor: one machine type in one region for one account. People pick
 * regions; a row stands for every zone of its region (`providerLocationRegion`), and allowing it
 * allows each of them. The zones stay under the hood.
 */
export interface MachineRegionRow {
  key: string;
  /** The account (capacity source) this row belongs to. */
  sourceId: string;
  provider: string;
  providerLabel: string;
  sku: string;
  vcpu: number | null;
  ramGb: number | null;
  diskGb: number | null;
  region: string;
  regionLabel: string;
  country: string | null;
  continent: Continent;
  /** The zone cells behind the row (one for providers without zones). */
  zones: MachineCell[];
  /** Server state: some zone of the region is in the pool. */
  allowed: boolean;
  /** Some zone can be added now. */
  canAllow: boolean;
  /** Why the row cannot be added, when it cannot. */
  issue: string | null;
  /** The cheapest zone's price, in the provider's own currency. */
  priceLabel: string | null;
  monthlyPrice: number | null;
  /** The currency of `monthlyPrice` as written in its label ("€", "$", "USD"). Never converted. */
  currency: string | null;
}

export const CONTINENTS = [
  'Europe',
  'North America',
  'South America',
  'Asia',
  'Oceania',
  'Middle East',
  'Africa',
  'Other',
] as const;
export type Continent = (typeof CONTINENTS)[number];

const CONTINENT_BY_COUNTRY: Readonly<Record<string, Continent>> = {
  AT: 'Europe',
  BE: 'Europe',
  CH: 'Europe',
  DE: 'Europe',
  DK: 'Europe',
  ES: 'Europe',
  FI: 'Europe',
  FR: 'Europe',
  GB: 'Europe',
  IE: 'Europe',
  IT: 'Europe',
  NL: 'Europe',
  NO: 'Europe',
  PL: 'Europe',
  SE: 'Europe',
  CA: 'North America',
  MX: 'North America',
  US: 'North America',
  BR: 'South America',
  CL: 'South America',
  HK: 'Asia',
  ID: 'Asia',
  IN: 'Asia',
  JP: 'Asia',
  KR: 'Asia',
  SG: 'Asia',
  TH: 'Asia',
  TW: 'Asia',
  AU: 'Oceania',
  NZ: 'Oceania',
  AE: 'Middle East',
  IL: 'Middle East',
  QA: 'Middle East',
  SA: 'Middle East',
  ZA: 'Africa',
};

export function continentForCountry(country: string | null): Continent {
  return (country && CONTINENT_BY_COUNTRY[country.toUpperCase()]) || 'Other';
}

/**
 * The currency marker of a price label: what is left once the amount and the period are taken
 * out ("€3.99/mo" → "€", "USD 12.00/mo" → "USD"). Amounts are only ever compared within one
 * marker, because prices are never converted.
 */
export function priceCurrency(label: string | null | undefined): string | null {
  if (!label) return null;
  const marker = label
    .replace(/^from\s+/i, '')
    .replace(/\/\s*[a-z]+\s*$/i, '')
    .replace(/[0-9.,\s]+/g, ' ')
    .trim();
  return marker || null;
}

function cheapest(cells: MachineCell[]): MachineCell | null {
  let best: MachineCell | null = null;
  for (const cell of cells) {
    if (cell.monthlyPrice === null) continue;
    if (!best || best.monthlyPrice === null || cell.monthlyPrice < best.monthlyPrice) best = cell;
  }
  return best ?? cells.find((cell) => cell.priceLabel) ?? null;
}

/** Flattens the per-account machine groups into one row per machine type and region. */
export function buildMachineRegionRows(groups: MachineGroup[]): MachineRegionRow[] {
  const rows: MachineRegionRow[] = [];
  for (const group of groups) {
    for (const machine of group.rows) {
      const byRegion = new Map<string, MachineCell[]>();
      for (const cell of machine.cells) {
        const region = providerLocationRegion(machine.provider, cell.location);
        byRegion.set(region, [...(byRegion.get(region) ?? []), cell]);
      }
      for (const [region, zones] of byRegion) {
        const meta = providerRegionMeta(machine.provider, region);
        // Without zones the location is the region, and the live catalog's name for it wins.
        const single = zones.length === 1 && zones[0]?.location === region ? zones[0] : null;
        const catalogName =
          single && single.locationLabel !== single.location ? single.locationLabel : null;
        const country = meta?.country ?? zones.find((zone) => zone.country)?.country ?? null;
        const price = cheapest(zones);
        const canAllow = zones.some((zone) => zone.canAllow);
        rows.push({
          key: `${machine.key}|${region.toLowerCase()}`,
          sourceId: group.key,
          provider: machine.provider,
          providerLabel: machine.providerLabel,
          sku: machine.sku,
          vcpu: machine.vcpu,
          ramGb: machine.ramGb,
          diskGb: machine.diskGb,
          region,
          regionLabel: catalogName ?? meta?.name ?? region,
          country,
          continent: continentForCountry(country),
          zones,
          allowed: zones.some((zone) => zone.allowed),
          canAllow,
          issue: canAllow ? null : (zones.find((zone) => zone.issue)?.issue ?? 'Unavailable'),
          priceLabel: price?.priceLabel ?? null,
          monthlyPrice: price?.monthlyPrice ?? null,
          currency: priceCurrency(price?.priceLabel),
        });
      }
    }
  }
  return rows;
}

/**
 * Rows whose machine and region another account also offers. Their control names add the
 * account, so "Add cx23 in Falkenstein" stays unique for screen readers.
 */
export function ambiguousRowKeys(rows: MachineRegionRow[]): Set<string> {
  const sources = new Map<string, Set<string>>();
  for (const row of rows) {
    const name = `${row.sku}|${row.regionLabel}`;
    sources.set(name, (sources.get(name) ?? new Set()).add(row.sourceId));
  }
  return new Set(
    rows
      .filter((row) => (sources.get(`${row.sku}|${row.regionLabel}`)?.size ?? 0) > 1)
      .map((row) => row.key)
  );
}

/** "cx23 in Falkenstein", plus the account when another account offers the same thing. */
export function rowControlName(
  row: MachineRegionRow,
  accountTitle: string,
  ambiguous: ReadonlySet<string>
): string {
  const name = `${row.sku} in ${row.regionLabel}`;
  return ambiguous.has(row.key) ? `${name}, ${accountTitle}` : name;
}

/** Desired in-pool state per region row key, holding only rows the person changed. */
export type RegionDraft = ReadonlyMap<string, boolean>;

export function isRowAllowed(row: MachineRegionRow, draft: RegionDraft): boolean {
  return draft.get(row.key) ?? row.allowed;
}

/** Sets rows to a desired state. Returning a row to its server state drops it from the draft. */
export function setRows(
  draft: RegionDraft,
  rows: MachineRegionRow[],
  desired: boolean
): Map<string, boolean> {
  const next = new Map(draft);
  for (const row of rows) {
    if (desired && !row.canAllow && !row.allowed) continue;
    if (desired === row.allowed) next.delete(row.key);
    else next.set(row.key, desired);
  }
  return next;
}

/**
 * The zone-level draft the update API understands. Adding a region adds every zone that can be
 * added (and catalog zones the pool has no row for yet); removing it removes every zone in it.
 */
export function zoneDraftForRows(rows: MachineRegionRow[], draft: RegionDraft): MachineDraft {
  const zones = new Map<string, boolean>();
  for (const row of rows) {
    const desired = draft.get(row.key);
    if (desired === undefined || desired === row.allowed) continue;
    for (const zone of row.zones) {
      if (desired && !zone.canAllow) continue;
      zones.set(zone.key, desired);
    }
  }
  return zones;
}
