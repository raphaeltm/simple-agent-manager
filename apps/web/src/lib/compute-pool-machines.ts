import type {
  CapacityPoolCandidate,
  CapacityPoolStatus,
  CapacitySourceIdentity,
  DefaultCapacityPoolCandidateCatalogAddition,
  ProviderCatalog,
} from '@simple-agent-manager/shared';

import {
  buildComputePoolOfferingsModel,
  canAddComputePoolOffering,
  type ComputePoolOffering,
} from './compute-pool-offerings';

/**
 * One machine type in one region for one pool source. A cell is allowed when any of its
 * candidate rows is active. `disabled` (never selected) and `deleted` (turned off by a
 * person, kept off by Reconcile) are both simply "not allowed" to the user.
 */
export interface MachineCell {
  key: string;
  location: string;
  locationLabel: string;
  country: string | null;
  candidates: Array<{ id: string; status: CapacityPoolStatus }>;
  /** Set when the provider offers this machine but the pool has no row for it yet. */
  catalogAddition: DefaultCapacityPoolCandidateCatalogAddition | null;
  allowed: boolean;
  /** False when the provider does not currently offer it, or nothing can be written. */
  canAllow: boolean;
  /** Why the cell is unavailable, in plain words. */
  issue: string | null;
  priceLabel: string | null;
  monthlyPrice: number | null;
}

export interface MachineTypeRow {
  key: string;
  provider: string;
  providerLabel: string;
  sku: string;
  vcpu: number | null;
  ramGb: number | null;
  diskGb: number | null;
  cells: MachineCell[];
  /** Allowed in at least one region (server state, so rows do not jump while editing). */
  allowed: boolean;
}

export type MachineSourceKind = 'cloud-provider-key' | 'connection' | 'platform' | 'unknown';

/** All machines reachable through one pool source (one cloud account connection). */
export interface MachineGroup {
  key: string;
  provider: string;
  providerLabel: string;
  kind: MachineSourceKind;
  credentialSource: string | null;
  rows: MachineTypeRow[];
}

/** Desired allowed state per cell key, holding only cells the person changed. */
export type MachineDraft = ReadonlyMap<string, boolean>;

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function cellKeyFor(groupKey: string, offering: ComputePoolOffering): string {
  return [groupKey, offering.provider, offering.location, offering.sku].map(normalized).join('|');
}

function sourceKind(source: CapacitySourceIdentity | undefined): MachineSourceKind {
  if (!source) return 'unknown';
  if (source.credentialSource === 'platform' || source.platformCredentialId) return 'platform';
  if (source.externalSourceRef || source.credentialReference?.startsWith('cc_credentials:')) {
    return 'connection';
  }
  return 'cloud-provider-key';
}

function issueFor(offering: ComputePoolOffering): string | null {
  if (canAddComputePoolOffering(offering)) return null;
  if (offering.stale) return 'Not currently offered';
  const label = offering.statusLabel?.trim();
  if (!label) return 'Unavailable';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function newCell(key: string, offering: ComputePoolOffering): MachineCell {
  return {
    key,
    location: offering.location,
    locationLabel: offering.locationLabel || offering.location,
    country: offering.country,
    candidates: [],
    catalogAddition: null,
    allowed: false,
    canAllow: false,
    issue: null,
    priceLabel: offering.priceLabel,
    monthlyPrice: offering.monthlyPriceAmount,
  };
}

function compareNullable(a: number | null, b: number | null): number {
  return (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);
}

function minPrice(row: MachineTypeRow): number | null {
  const prices = row.cells.map((cell) => cell.monthlyPrice).filter((p): p is number => p !== null);
  return prices.length > 0 ? Math.min(...prices) : null;
}

function compareRows(a: MachineTypeRow, b: MachineTypeRow): number {
  if (a.allowed !== b.allowed) return a.allowed ? -1 : 1;
  return (
    compareNullable(a.vcpu, b.vcpu) ||
    compareNullable(a.ramGb, b.ramGb) ||
    compareNullable(minPrice(a), minPrice(b)) ||
    a.sku.localeCompare(b.sku)
  );
}

/** Known countries first (grouped), then by name; `region-2` before `region-10`. */
function compareCells(a: MachineCell, b: MachineCell): number {
  if (Boolean(a.country) !== Boolean(b.country)) return a.country ? -1 : 1;
  return (
    (a.country ?? '').localeCompare(b.country ?? '') ||
    a.locationLabel.localeCompare(b.locationLabel, undefined, { numeric: true })
  );
}

/**
 * Groups a pool's candidate rows and the provider catalogs into machine types per
 * source. Catalog rows whose source cannot be identified are left out: nothing could
 * be written for them.
 */
export function buildMachineGroups(
  candidates: CapacityPoolCandidate[],
  catalogs: ProviderCatalog[],
  sources: CapacitySourceIdentity[]
): MachineGroup[] {
  const model = buildComputePoolOfferingsModel(candidates, catalogs, sources);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const cells = new Map<
    string,
    { cell: MachineCell; groupKey: string; offering: ComputePoolOffering }
  >();

  for (const offering of [...model.allowed, ...model.excluded]) {
    const groupKey = offering.sourceId ?? `provider:${offering.provider}`;
    const key = cellKeyFor(groupKey, offering);
    const entry = cells.get(key) ?? { cell: newCell(key, offering), groupKey, offering };
    entry.cell.candidates.push({ id: offering.candidateId, status: offering.candidateStatus });
    if (offering.candidateStatus === 'active') entry.cell.allowed = true;
    if (canAddComputePoolOffering(offering)) entry.cell.canAllow = true;
    else entry.cell.issue ??= issueFor(offering);
    cells.set(key, entry);
  }

  for (const offering of model.catalog) {
    if (offering.candidateId || !offering.sourceId) continue;
    const key = cellKeyFor(offering.sourceId, offering);
    if (cells.has(key)) continue;
    const cell = newCell(key, offering);
    cell.catalogAddition = {
      sourceId: offering.sourceId,
      provider: offering.provider as DefaultCapacityPoolCandidateCatalogAddition['provider'],
      location: offering.location,
      providerInstanceType: offering.providerInstanceType,
      providerInstanceSku: offering.providerInstanceSku,
    };
    cell.canAllow = canAddComputePoolOffering(offering);
    cell.issue = issueFor(offering);
    cells.set(key, { cell, groupKey: offering.sourceId, offering });
  }

  const groups = new Map<string, MachineGroup>();
  const rows = new Map<string, MachineTypeRow>();
  for (const { cell, groupKey, offering } of cells.values()) {
    if (cell.canAllow) cell.issue = null;
    let group = groups.get(groupKey);
    if (!group) {
      const source = sourcesById.get(groupKey);
      group = {
        key: groupKey,
        provider: offering.provider,
        providerLabel: offering.providerLabel,
        kind: sourceKind(source),
        credentialSource: source?.credentialSource ?? null,
        rows: [],
      };
      groups.set(groupKey, group);
    }
    const rowKey = [groupKey, offering.provider, offering.sku].map(normalized).join('|');
    let row = rows.get(rowKey);
    if (!row) {
      row = {
        key: rowKey,
        provider: offering.provider,
        providerLabel: offering.providerLabel,
        sku: offering.sku,
        vcpu: offering.vcpu,
        ramGb: offering.ramGb,
        diskGb: offering.diskGb,
        cells: [],
        allowed: false,
      };
      rows.set(rowKey, row);
      group.rows.push(row);
    }
    row.cells.push(cell);
    if (cell.allowed) row.allowed = true;
  }

  for (const group of groups.values()) {
    for (const row of group.rows) row.cells.sort(compareCells);
    group.rows.sort(compareRows);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.rows.some((row) => row.allowed)) - Number(a.rows.some((row) => row.allowed)) ||
      a.providerLabel.localeCompare(b.providerLabel)
  );
}

export function isCellAllowed(cell: MachineCell, draft: MachineDraft): boolean {
  return draft.get(cell.key) ?? cell.allowed;
}

/** Flips one cell. Returning to the server state drops the cell from the draft. */
export function toggleCell(draft: MachineDraft, cell: MachineCell): Map<string, boolean> {
  const next = new Map(draft);
  const desired = !isCellAllowed(cell, draft);
  if (desired === cell.allowed) next.delete(cell.key);
  else next.set(cell.key, desired);
  return next;
}

export interface MachineChanges {
  candidates: Array<{ id: string; status: CapacityPoolStatus }>;
  catalogAdditions: DefaultCapacityPoolCandidateCatalogAddition[];
}

/**
 * Turns the draft into the existing update API's shape. Allowing writes `active`;
 * blocking writes `deleted`, which Reconcile never re-enables.
 */
export function buildMachineChanges(groups: MachineGroup[], draft: MachineDraft): MachineChanges {
  const changes: MachineChanges = { candidates: [], catalogAdditions: [] };
  for (const group of groups) {
    for (const row of group.rows) {
      for (const cell of row.cells) {
        const desired = draft.get(cell.key);
        if (desired === undefined || desired === cell.allowed) continue;
        if (desired) {
          for (const candidate of cell.candidates) {
            if (candidate.status !== 'active') {
              changes.candidates.push({ id: candidate.id, status: 'active' });
            }
          }
          if (cell.candidates.length === 0 && cell.catalogAddition) {
            changes.catalogAdditions.push(cell.catalogAddition);
          }
        } else {
          for (const candidate of cell.candidates) {
            if (candidate.status === 'active') {
              changes.candidates.push({ id: candidate.id, status: 'deleted' });
            }
          }
        }
      }
    }
  }
  return changes;
}

export interface AllowedMachinesSummary {
  providers: string[];
  regions: string[];
  machineTypeCount: number;
  smallest: MachineTypeRow | null;
  largest: MachineTypeRow | null;
}

/** What a pool allows today, for the one-sentence summary. */
export function summarizeAllowedMachines(groups: MachineGroup[]): AllowedMachinesSummary {
  const providers = new Set<string>();
  const regions = new Set<string>();
  const allowedRows: MachineTypeRow[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      const allowedCells = row.cells.filter((cell) => cell.allowed);
      if (allowedCells.length === 0) continue;
      providers.add(row.providerLabel);
      for (const cell of allowedCells) regions.add(cell.locationLabel);
      allowedRows.push(row);
    }
  }
  const bySize = [...allowedRows].sort(
    (a, b) => compareNullable(a.vcpu, b.vcpu) || compareNullable(a.ramGb, b.ramGb)
  );
  const types = new Set(allowedRows.map((row) => `${row.provider}|${row.sku}`));
  return {
    providers: [...providers],
    regions: [...regions],
    machineTypeCount: types.size,
    smallest: bySize[0] ?? null,
    largest: bySize[bySize.length - 1] ?? null,
  };
}

/** Price shown for a machine type: exact when every region agrees, else the minimum. */
export function rowPriceLabel(
  row: MachineTypeRow,
  cells: MachineCell[] = row.cells
): string | null {
  const priced = cells.filter((cell) => cell.priceLabel);
  if (priced.length === 0) return null;
  const labels = new Set(priced.map((cell) => cell.priceLabel));
  const cheapest = [...priced].sort((a, b) => compareNullable(a.monthlyPrice, b.monthlyPrice))[0];
  if (!cheapest?.priceLabel) return null;
  return labels.size === 1 ? cheapest.priceLabel : `from ${cheapest.priceLabel}`;
}
