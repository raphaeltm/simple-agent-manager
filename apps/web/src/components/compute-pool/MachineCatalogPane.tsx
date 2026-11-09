import { Button, Chip } from '@simple-agent-manager/ui';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import {
  type CatalogFilters,
  type CatalogSort,
  type CatalogSortKey,
  cheapestRegionKeys,
  DEFAULT_CATALOG_FILTERS,
  filterCatalogRows,
  nextSort,
  sortCatalogRows,
} from '../../lib/compute-pool-catalog-view';
import { POOL_EDITOR_COPY } from '../../lib/compute-pool-copy';
import { formatOfferingNumber } from '../../lib/compute-pool-offerings';
import {
  CONTINENTS,
  isRowAllowed,
  type MachineRegionRow,
  type RegionDraft,
} from '../../lib/compute-pool-region-rows';
import type { OrderableSource } from '../../lib/compute-pool-source-order';
import { MachineCatalogFilters } from './MachineCatalogFilters';

/** Rows rendered per page of the list; "Show more" adds another page. */
const ROWS_PER_PAGE = 100;

/**
 * The first column holds the machine and its account, so the table fits the settings pane; it
 * sorts by either. The remaining columns each sort by their own value.
 */
const MACHINE_SORT_KEYS: Array<{ key: CatalogSortKey; label: string }> = [
  { key: 'machine', label: 'Machine' },
  { key: 'provider', label: 'Account' },
];
const COLUMNS: Array<{ key: CatalogSortKey; label: string; numeric?: boolean }> = [
  { key: 'vcpu', label: 'vCPU', numeric: true },
  { key: 'memory', label: 'Memory', numeric: true },
  { key: 'disk', label: 'Disk', numeric: true },
  { key: 'region', label: 'Region' },
  { key: 'price', label: 'Price / month', numeric: true },
];

interface MachineCatalogPaneProps {
  rows: MachineRegionRow[];
  accounts: OrderableSource[];
  accountRank: ReadonlyMap<string, number>;
  draft: RegionDraft;
  excluded: ReadonlySet<string>;
  readOnly: boolean;
  onSetRows: (rows: MachineRegionRow[], inPool: boolean) => void;
}

function specs(row: MachineRegionRow): string {
  return [
    `${formatOfferingNumber(row.vcpu, '')} vCPU`,
    `${formatOfferingNumber(row.ramGb, 'GB')}`,
    `${formatOfferingNumber(row.diskGb, 'GB')} disk`,
  ].join(' · ');
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
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 font-medium text-inherit hover:text-fg-primary"
      onClick={() => onSort(sortKey)}
    >
      {label}
      <SortIcon active={sort?.key === sortKey ? sort : null} />
    </button>
  );
}

function ariaSortFor(sort: CatalogSort | null, keys: CatalogSortKey[]) {
  if (!sort || !keys.includes(sort.key)) return 'none' as const;
  return sort.direction === 'asc' ? ('ascending' as const) : ('descending' as const);
}

function SortIcon({ active }: { active: CatalogSort | null }) {
  if (!active) return <ArrowUpDown size={12} aria-hidden className="opacity-50" />;
  return active.direction === 'asc' ? (
    <ArrowUp size={12} aria-hidden />
  ) : (
    <ArrowDown size={12} aria-hidden />
  );
}

export function MachineCatalogPane({
  rows,
  accounts,
  accountRank,
  draft,
  excluded,
  readOnly,
  onSetRows,
}: MachineCatalogPaneProps) {
  const headingId = useId();
  const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_CATALOG_FILTERS);
  const [sort, setSort] = useState<CatalogSort | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [limit, setLimit] = useState(ROWS_PER_PAGE);

  const accountTitles = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.title])),
    [accounts]
  );
  const continents = useMemo(() => {
    const present = new Set(rows.map((row) => row.continent));
    return CONTINENTS.filter((continent) => present.has(continent));
  }, [rows]);
  const cheapest = useMemo(() => cheapestRegionKeys(rows), [rows]);
  const visible = useMemo(
    () =>
      sortCatalogRows(filterCatalogRows(rows, filters, draft, accountTitles), sort, accountRank),
    [rows, filters, draft, accountTitles, sort, accountRank]
  );
  const page = visible.slice(0, limit);
  const selectedRows = rows.filter((row) => selected.has(row.key));
  const pageKeys = page.filter((row) => row.canAllow || isRowAllowed(row, draft)).map((r) => r.key);
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((key) => selected.has(key));

  const toggleSelected = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const applyBulk = (inPool: boolean) => {
    onSetRows(selectedRows, inPool);
    setSelected(new Set());
  };

  const actionFor = (row: MachineRegionRow) => {
    const inPool = isRowAllowed(row, draft);
    if (!inPool && !row.canAllow) {
      return (
        <Chip size="sm" tone="warning" title={row.issue ?? undefined}>
          {row.issue ?? 'Unavailable'}
        </Chip>
      );
    }
    if (readOnly)
      return inPool ? (
        <Chip size="sm" tone="success">
          In pool
        </Chip>
      ) : null;
    return (
      <Button
        size="sm"
        variant={inPool ? 'ghost' : 'raised'}
        aria-label={`${inPool ? 'Remove' : 'Add'} ${row.sku} in ${row.regionLabel}`}
        onClick={() => onSetRows([row], !inPool)}
      >
        {inPool ? 'Remove' : 'Add'}
      </Button>
    );
  };

  // Account titles already start with the provider ("Hetzner · Personal").
  const accountTitle = (row: MachineRegionRow) =>
    accountTitles.get(row.sourceId) ?? row.providerLabel;
  const onSort = (key: CatalogSortKey) => setSort((current) => nextSort(current, key));
  const accountNote = (row: MachineRegionRow) =>
    excluded.has(row.sourceId) ? ' · account off' : '';

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={headingId}>
      <div className="min-w-0">
        <h3 id={headingId} className="m-0 text-sm font-semibold text-fg-primary">
          {POOL_EDITOR_COPY.catalogTitle}
        </h3>
        <p className="m-0 mt-1 text-xs text-fg-muted">{POOL_EDITOR_COPY.catalogHelp}</p>
      </div>
      <MachineCatalogFilters
        filters={filters}
        accounts={accounts}
        continents={continents}
        onChange={(next) => {
          setFilters(next);
          setLimit(ROWS_PER_PAGE);
        }}
      />

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
        <span aria-live="polite">
          {visible.length} of {rows.length} rows
        </span>
        {!readOnly && selected.size > 0 && (
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="raised" onClick={() => applyBulk(true)}>
              Add {selected.size} to pool
            </Button>
            <Button size="sm" variant="ghost" onClick={() => applyBulk(false)}>
              Remove {selected.size} from pool
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </span>
        )}
      </div>

      {/* Desktop: a sortable table. Its wrapper scrolls rather than clipping on narrow panes. */}
      <div className="relative hidden min-w-0 overflow-x-auto lg:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-default text-left text-xs text-fg-muted">
              {!readOnly && (
                <th className="w-8 py-2 pr-2">
                  <input
                    type="checkbox"
                    aria-label="Select every row on this page"
                    className="h-4 w-4 accent-[var(--sam-color-focus-ring)]"
                    checked={allPageSelected}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const key of pageKeys) {
                          if (allPageSelected) next.delete(key);
                          else next.add(key);
                        }
                        return next;
                      })
                    }
                  />
                </th>
              )}
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
                  <SortButton
                    label={column.label}
                    sortKey={column.key}
                    sort={sort}
                    onSort={onSort}
                  />
                </th>
              ))}
              <th className="py-2 text-right font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.map((row) => {
              const inPool = isRowAllowed(row, draft);
              return (
                <tr
                  key={row.key}
                  className={`border-b border-border-default align-middle ${
                    inPool ? 'bg-[var(--sam-status-success-bg)]' : ''
                  }`}
                >
                  {!readOnly && (
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.sku} in ${row.regionLabel}`}
                        className="h-4 w-4 accent-[var(--sam-color-focus-ring)]"
                        checked={selected.has(row.key)}
                        disabled={!inPool && !row.canAllow}
                        onChange={() => toggleSelected(row.key)}
                      />
                    </td>
                  )}
                  <td className="min-w-[10rem] py-2 pr-3">
                    <span className="block font-mono text-fg-primary [overflow-wrap:anywhere]">
                      {row.sku}
                    </span>
                    <span className="block text-xs text-fg-muted [overflow-wrap:anywhere]">
                      {accountTitle(row)}
                      {accountNote(row)}
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
                    <span className="block text-xs text-fg-muted [overflow-wrap:anywhere]">
                      {row.region}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right">
                    <span className="block text-fg-primary">
                      {row.priceLabel ?? 'Price unavailable'}
                    </span>
                    {cheapest.has(row.key) && (
                      <span className="block text-xs text-[var(--sam-status-success-fg)]">
                        Cheapest region
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">{actionFor(row)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile and narrow panes: one card per row. */}
      <ul className="m-0 grid list-none gap-2 p-0 lg:hidden">
        {page.map((row) => {
          const inPool = isRowAllowed(row, draft);
          return (
            <li
              key={row.key}
              className={`flex min-w-0 items-start gap-3 rounded-md border border-border-default p-3 ${
                inPool ? 'bg-[var(--sam-status-success-bg)]' : 'bg-inset'
              }`}
            >
              {!readOnly && (
                <input
                  type="checkbox"
                  aria-label={`Select ${row.sku} in ${row.regionLabel}`}
                  className="mt-1 h-5 w-5 shrink-0 accent-[var(--sam-color-focus-ring)]"
                  checked={selected.has(row.key)}
                  disabled={!inPool && !row.canAllow}
                  onChange={() => toggleSelected(row.key)}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="m-0 text-sm text-fg-primary [overflow-wrap:anywhere]">
                  <span className="font-mono">{row.sku}</span> · {row.regionLabel}
                </p>
                <p className="m-0 text-xs text-fg-muted [overflow-wrap:anywhere]">
                  {accountTitle(row)}
                  {accountNote(row)}
                </p>
                <p className="m-0 text-xs text-fg-muted">{specs(row)}</p>
                <p className="m-0 text-xs text-fg-primary">
                  {row.priceLabel ?? 'Price unavailable'}
                  {cheapest.has(row.key) ? ' · cheapest region' : ''}
                </p>
              </div>
              <div className="shrink-0">{actionFor(row)}</div>
            </li>
          );
        })}
      </ul>

      {visible.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">
          {rows.length === 0
            ? 'The connected accounts have not listed any machines yet. Try Refresh.'
            : 'No machines match these filters.'}
        </p>
      )}
      {visible.length > page.length && (
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start"
          onClick={() => setLimit((current) => current + ROWS_PER_PAGE)}
        >
          Show {Math.min(ROWS_PER_PAGE, visible.length - page.length)} more
        </Button>
      )}
    </section>
  );
}
