import { Input, SearchField, SegmentedControl } from '@simple-agent-manager/ui';
import { useId } from 'react';

import type { CatalogFilters, CatalogView } from '../../lib/compute-pool-catalog-view';
import type { Continent } from '../../lib/compute-pool-region-rows';
import type { OrderableSource } from '../../lib/compute-pool-source-order';

const VIEW_OPTIONS: Array<{ value: CatalogView; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'In pool' },
  { value: 'out', label: 'Not in pool' },
];

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function parseLimit(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`min-h-9 max-w-full break-words rounded-full border px-3 text-xs font-medium ${
        pressed
          ? 'sam-raised border-transparent text-fg-primary'
          : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
      }`}
    >
      {children}
    </button>
  );
}

function NumberFilter({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number | null;
  step: number;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        min={0}
        step={step}
        inputMode="decimal"
        placeholder="Any"
        value={value ?? ''}
        onChange={(event) => onChange(parseLimit(event.currentTarget.value))}
      />
    </div>
  );
}

interface MachineCatalogFiltersProps {
  filters: CatalogFilters;
  accounts: OrderableSource[];
  continents: Continent[];
  onChange: (filters: CatalogFilters) => void;
}

export function MachineCatalogFilters({
  filters,
  accounts,
  continents,
  onChange,
}: MachineCatalogFiltersProps) {
  const update = <K extends keyof CatalogFilters>(key: K, value: CatalogFilters[K]) =>
    onChange({ ...filters, [key]: value });
  const hideId = useId();

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <SearchField
          className="min-w-0 flex-1"
          label="Search machines"
          placeholder="Search machine, region, provider…"
          value={filters.query}
          onValueChange={(value) => update('query', value)}
        />
        <SegmentedControl
          className="sm:w-80 sm:shrink-0"
          label="Show"
          options={VIEW_OPTIONS}
          value={filters.view}
          onChange={(value) => update('view', value)}
        />
      </div>
      {accounts.length > 1 && (
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Accounts">
          {accounts.map((account) => (
            <FilterChip
              key={account.id}
              pressed={filters.accounts.has(account.id)}
              onClick={() => update('accounts', toggle(filters.accounts, account.id))}
            >
              {account.title}
            </FilterChip>
          ))}
        </div>
      )}
      {continents.length > 1 && (
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Continents">
          {continents.map((continent) => (
            <FilterChip
              key={continent}
              pressed={filters.continents.has(continent)}
              onClick={() => update('continents', toggle(filters.continents, continent))}
            >
              {continent}
            </FilterChip>
          ))}
        </div>
      )}
      <div className="grid min-w-0 grid-cols-2 items-end gap-3 sm:grid-cols-4">
        <NumberFilter
          label="Min vCPU"
          value={filters.minVcpu}
          step={1}
          onChange={(value) => update('minVcpu', value)}
        />
        <NumberFilter
          label="Min memory (GB)"
          value={filters.minMemoryGb}
          step={1}
          onChange={(value) => update('minMemoryGb', value)}
        />
        <NumberFilter
          label="Max price / month"
          value={filters.maxMonthlyPrice}
          step={1}
          onChange={(value) => update('maxMonthlyPrice', value)}
        />
        <label
          htmlFor={hideId}
          className="flex min-h-11 items-center gap-2 text-sm text-fg-primary"
        >
          <input
            id={hideId}
            type="checkbox"
            className="h-4 w-4 accent-[var(--sam-color-focus-ring)]"
            checked={filters.hideUnavailable}
            onChange={(event) => update('hideUnavailable', event.currentTarget.checked)}
          />
          Hide unavailable
        </label>
      </div>
    </div>
  );
}
