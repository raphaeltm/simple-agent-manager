import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import type { CatalogSort, CatalogSortKey } from '../../lib/compute-pool-catalog-view';
import { formatOfferingNumber } from '../../lib/compute-pool-offerings';
import type { MachineRegionRow } from '../../lib/compute-pool-region-rows';
import {
  AccountLine,
  type CatalogRowView,
  RowAction,
  RowCheckbox,
  UnsavedTag,
} from './machine-catalog-row';

/**
 * The first column holds the machine and its account, so the table fits the settings pane; it
 * sorts by either. The remaining columns each sort by their own value.
 */
const MACHINE_SORT_KEYS: Array<{ key: CatalogSortKey; label: string }> = [
  { key: 'machine', label: 'Machine' },
  { key: 'provider', label: 'Provider' },
];
const COLUMNS: Array<{ key: CatalogSortKey; label: string; numeric?: boolean }> = [
  { key: 'vcpu', label: 'vCPU', numeric: true },
  { key: 'memory', label: 'Memory', numeric: true },
  { key: 'disk', label: 'Disk', numeric: true },
  { key: 'region', label: 'Region' },
  { key: 'price', label: 'Price / month', numeric: true },
];

function SortIcon({ active }: { active: CatalogSort | null }) {
  if (!active) return <ArrowUpDown size={12} aria-hidden className="opacity-50" />;
  return active.direction === 'asc' ? (
    <ArrowUp size={12} aria-hidden />
  ) : (
    <ArrowDown size={12} aria-hidden />
  );
}

function SortButton({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: CatalogSortKey;
  sort: CatalogSort | null;
  onSort: (key: CatalogSortKey) => void;
}) {
  const active = sort?.key === sortKey ? sort : null;
  return (
    <button
      type="button"
      // The name starts with the visible label and says which way it is sorted, because two
      // sort buttons share the first column's header.
      aria-label={
        active
          ? `${label}, sorted ${active.direction === 'asc' ? 'ascending' : 'descending'}`
          : label
      }
      title={sortKey === 'price' ? 'Grouped by currency, then by amount' : undefined}
      className="inline-flex items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 font-medium text-inherit hover:text-fg-primary"
      onClick={() => onSort(sortKey)}
    >
      {label}
      <SortIcon active={active} />
    </button>
  );
}

function ariaSortFor(sort: CatalogSort | null, keys: CatalogSortKey[]) {
  if (!sort || !keys.includes(sort.key)) return 'none' as const;
  return sort.direction === 'asc' ? ('ascending' as const) : ('descending' as const);
}

interface MachineCatalogTableProps {
  rows: MachineRegionRow[];
  view: CatalogRowView;
  sort: CatalogSort | null;
  onSort: (key: CatalogSortKey) => void;
  /** Selection state of the rows on this page that can be selected. */
  pageSelection: 'none' | 'some' | 'all';
  onSelectPage: () => void;
  labelledBy: string;
}

/** The machine list on wide screens: one sortable row per machine × region. */
export function MachineCatalogTable({
  rows,
  view,
  sort,
  onSort,
  pageSelection,
  onSelectPage,
  labelledBy,
}: MachineCatalogTableProps) {
  return (
    <table className="w-full border-collapse text-sm" aria-labelledby={labelledBy}>
      <thead>
        <tr className="border-b border-border-default text-left text-xs text-fg-muted">
          <th className="w-8 py-2 pr-2">
            <input
              type="checkbox"
              aria-label="Select every row on this page"
              className="h-4 w-4 accent-[var(--sam-color-focus-ring)]"
              checked={pageSelection === 'all'}
              ref={(element) => {
                if (element) element.indeterminate = pageSelection === 'some';
              }}
              onChange={onSelectPage}
            />
          </th>
          <th
            className="py-2 pr-3 font-medium"
            aria-sort={ariaSortFor(
              sort,
              MACHINE_SORT_KEYS.map((entry) => entry.key)
            )}
          >
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              {MACHINE_SORT_KEYS.map((entry) => (
                <SortButton
                  key={entry.key}
                  label={entry.label}
                  sortKey={entry.key}
                  sort={sort}
                  onSort={onSort}
                />
              ))}
            </span>
          </th>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              className={`py-2 pr-3 font-medium ${column.numeric ? 'text-right' : ''}`}
              aria-sort={ariaSortFor(sort, [column.key])}
            >
              <SortButton label={column.label} sortKey={column.key} sort={sort} onSort={onSort} />
            </th>
          ))}
          <th className="py-2 text-right font-medium">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            className={`border-b border-border-default align-middle ${
              view.inPool(row) ? 'bg-[var(--sam-status-success-bg)]' : ''
            }`}
          >
            <td className="py-2 pr-2">
              <RowCheckbox row={row} view={view} className="h-4 w-4" />
            </td>
            <td className="min-w-[10rem] py-2 pr-3">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-fg-primary [overflow-wrap:anywhere]">
                  {row.sku}
                </span>
                <UnsavedTag row={row} view={view} />
              </span>
              <span className="block text-xs text-fg-muted [overflow-wrap:anywhere]">
                <AccountLine row={row} view={view} />
              </span>
            </td>
            <td className="py-2 pr-3 text-right tabular-nums">
              {formatOfferingNumber(row.vcpu, '')}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">
              {formatOfferingNumber(row.ramGb, 'GB')}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">
              {formatOfferingNumber(row.diskGb, 'GB')}
            </td>
            <td className="min-w-[7rem] py-2 pr-3">
              <span className="block text-fg-primary [overflow-wrap:anywhere]">
                {row.regionLabel}
              </span>
              {row.region !== row.regionLabel && (
                <span className="block text-xs text-fg-muted [overflow-wrap:anywhere]">
                  {row.region}
                </span>
              )}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 text-right">
              <span className="block text-fg-primary">{row.priceLabel ?? 'Price unavailable'}</span>
              {view.cheapest(row) && (
                <span className="block text-xs text-[var(--sam-status-success-fg)]">
                  Cheapest region
                </span>
              )}
            </td>
            <td className="whitespace-nowrap py-2 text-right">
              <RowAction row={row} view={view} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
