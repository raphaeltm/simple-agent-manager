import { Button, Select } from '@simple-agent-manager/ui';
import { useId, useMemo, useState } from 'react';

import {
  CATALOG_SORT_OPTIONS,
  catalogCurrencies,
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
import {
  CONTINENTS,
  isRowAllowed,
  type MachineRegionRow,
  type RegionDraft,
  rowControlName,
} from '../../lib/compute-pool-region-rows';
import type { OrderableSource } from '../../lib/compute-pool-source-order';
import type { CatalogRowView } from './machine-catalog-row';
import { MachineCatalogCards } from './MachineCatalogCards';
import { MachineCatalogFilters } from './MachineCatalogFilters';
import { MachineCatalogTable } from './MachineCatalogTable';

/** Rows rendered per page of the list; "Show more" adds another page. */
const ROWS_PER_PAGE = 100;

interface MachineCatalogPaneProps {
  rows: MachineRegionRow[];
  accounts: OrderableSource[];
  accountRank: ReadonlyMap<string, number>;
  draft: RegionDraft;
  excluded: ReadonlySet<string>;
  /** Rows whose machine and region another account also offers (see `ambiguousRowKeys`). */
  ambiguous: ReadonlySet<string>;
  onSetRows: (rows: MachineRegionRow[], inPool: boolean) => void;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Every machine × region the connected accounts offer, with filters, sorting and bulk edits. */
export function MachineCatalogPane({
  rows,
  accounts,
  accountRank,
  draft,
  excluded,
  ambiguous,
  onSetRows,
}: MachineCatalogPaneProps) {
  const headingId = useId();
  const sortId = useId();
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
  const currencies = useMemo(() => catalogCurrencies(rows), [rows]);
  const cheapest = useMemo(() => cheapestRegionKeys(rows), [rows]);
  const visible = useMemo(
    () =>
      sortCatalogRows(filterCatalogRows(rows, filters, draft, accountTitles), sort, accountRank),
    [rows, filters, draft, accountTitles, sort, accountRank]
  );
  const page = visible.slice(0, limit);

  const inPool = (row: MachineRegionRow) => isRowAllowed(row, draft);
  const accountTitle = (row: MachineRegionRow) =>
    accountTitles.get(row.sourceId) ?? row.providerLabel;
  const view: CatalogRowView = {
    inPool,
    changed: (row) => draft.has(row.key),
    accountTitle,
    accountNote: (row) => (excluded.has(row.sourceId) ? POOL_EDITOR_COPY.offAccountNote : null),
    controlName: (row) => rowControlName(row, accountTitle(row), ambiguous),
    cheapest: (row) => cheapest.has(row.key),
    selected: (row) => selected.has(row.key),
    selectable: (row) => row.canAllow || inPool(row),
    toggleSelected: (row) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      }),
    setInPool: (row, next) => onSetRows([row], next),
  };

  // Bulk actions act on selected rows that are still listed, never on rows a filter hid, and
  // count only the rows each action would change.
  const selectedRows = visible.filter((row) => selected.has(row.key));
  const toAdd = selectedRows.filter((row) => !inPool(row) && row.canAllow);
  const toRemove = selectedRows.filter(inPool);
  const pageKeys = page.filter(view.selectable).map((row) => row.key);
  const pageSelected = pageKeys.filter((key) => selected.has(key)).length;
  const pageSelection =
    pageSelected === 0 ? 'none' : pageSelected === pageKeys.length ? 'all' : 'some';
  const selectPage = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const key of pageKeys) {
        if (pageSelection === 'all') next.delete(key);
        else next.add(key);
      }
      return next;
    });
  const applyBulk = (target: MachineRegionRow[], next: boolean) => {
    onSetRows(target, next);
    setSelected(new Set());
  };

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
        currencies={currencies}
        onChange={(next) => {
          setFilters(next);
          setLimit(ROWS_PER_PAGE);
          // A selection made under other filters must not act on rows the person can't see.
          setSelected(new Set());
        }}
      />

      {/* Narrow screens have no column headers: sort and select-all live here instead. */}
      <div className="grid min-w-0 grid-cols-[1fr_auto] items-end gap-2 xl:hidden">
        <div className="grid min-w-0 gap-1">
          <label htmlFor={sortId} className="text-xs font-medium text-fg-muted">
            Sort by
          </label>
          <Select
            id={sortId}
            value={sort?.key ?? ''}
            onChange={(event) => {
              const key = event.currentTarget.value as CatalogSortKey | '';
              setSort(key ? { key, direction: sort?.direction ?? 'asc' } : null);
            }}
          >
            <option value="">Account order</option>
            {CATALOG_SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!sort}
          onClick={() =>
            sort && setSort({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })
          }
        >
          {sort?.direction === 'desc' ? 'Descending' : 'Ascending'}
        </Button>
      </div>

      <div
        className={`flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-muted ${
          selectedRows.length > 0 ? 'sticky top-0 z-10 bg-surface py-2' : ''
        }`}
      >
        <span className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-9 items-center gap-2 xl:hidden">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--sam-color-focus-ring)]"
              checked={pageSelection === 'all'}
              ref={(element) => {
                if (element) element.indeterminate = pageSelection === 'some';
              }}
              disabled={pageKeys.length === 0}
              onChange={selectPage}
            />
            Select all {pageKeys.length} shown
          </label>
          <span aria-live="polite">
            {visible.length} of {rows.length} rows
          </span>
        </span>
        {selectedRows.length > 0 && (
          <span className="flex flex-wrap gap-2">
            {toAdd.length > 0 && (
              <Button size="sm" variant="raised" onClick={() => applyBulk(toAdd, true)}>
                Add {plural(toAdd.length, 'row')} to pool
              </Button>
            )}
            {toRemove.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => applyBulk(toRemove, false)}>
                Remove {plural(toRemove.length, 'row')} from pool
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </span>
        )}
      </div>

      {/* Wide screens: a sortable table. Its wrapper scrolls rather than clipping. */}
      <div className="relative hidden min-w-0 overflow-x-auto xl:block">
        <MachineCatalogTable
          rows={page}
          view={view}
          sort={sort}
          onSort={(key) => setSort((current) => nextSort(current, key))}
          pageSelection={pageSelection}
          onSelectPage={selectPage}
          labelledBy={headingId}
        />
      </div>
      <div className="xl:hidden">
        <MachineCatalogCards rows={page} view={view} />
      </div>

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
