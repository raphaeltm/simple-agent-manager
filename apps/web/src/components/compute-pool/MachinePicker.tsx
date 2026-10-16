import { Button, Input } from '@simple-agent-manager/ui';
import { AlertTriangle, Check } from 'lucide-react';
import { useId, useState } from 'react';

import {
  isCellAllowed,
  type MachineCell,
  type MachineDraft,
  type MachineGroup,
  type MachineTypeRow,
  rowPriceLabel,
} from '../../lib/compute-pool-machines';
import { groupTitles, machineSpecs } from './machine-labels';

function rowMatches(row: MachineTypeRow, query: string): boolean {
  if (row.sku.toLowerCase().includes(query)) return true;
  return row.cells.some((cell) =>
    `${cell.location} ${cell.locationLabel} ${cell.country ?? ''}`.toLowerCase().includes(query)
  );
}

function chipClasses(on: boolean, disabled: boolean, warn: boolean): string {
  if (on && warn) return 'border-warning/40 bg-warning-tint text-fg-primary';
  if (on) return 'border-accent bg-accent-tint text-fg-primary';
  if (disabled) return 'cursor-not-allowed border-dashed border-border-default text-fg-muted';
  return 'border-border-default bg-transparent text-fg-muted hover:border-accent hover:text-fg-primary';
}

function RegionChip({
  row,
  cell,
  on,
  onToggle,
}: {
  row: MachineTypeRow;
  cell: MachineCell;
  on: boolean;
  onToggle: (cell: MachineCell) => void;
}) {
  // A machine the provider no longer offers can still be turned off, never back on.
  const disabled = !on && !cell.canAllow;
  const issue = cell.issue?.toLowerCase();
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      aria-label={`${row.sku} in ${cell.locationLabel}${cell.issue ? ` (${issue})` : ''}`}
      title={[cell.locationLabel, cell.issue ?? cell.priceLabel].filter(Boolean).join(' · ')}
      onClick={() => onToggle(cell)}
      className={`inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${chipClasses(on, disabled, Boolean(cell.issue))}`}
    >
      {on &&
        (cell.issue ? (
          <AlertTriangle size={12} aria-hidden className="shrink-0" />
        ) : (
          <Check size={12} aria-hidden className="shrink-0" />
        ))}
      <span className="line-clamp-1 min-w-0 [overflow-wrap:anywhere]">
        {cell.locationLabel}
        {issue && <span className="font-normal"> · {issue}</span>}
      </span>
    </button>
  );
}

function MachineRows({
  rows,
  draft,
  onToggle,
}: {
  rows: MachineTypeRow[];
  draft: MachineDraft;
  onToggle: (cell: MachineCell) => void;
}) {
  return (
    <ul className="m-0 grid min-w-0 list-none divide-y divide-border-default rounded-md border border-border-default bg-inset p-0">
      {rows.map((row) => {
        const price = rowPriceLabel(row);
        return (
          <li key={row.key} className="grid min-w-0 gap-2 px-3 py-2.5">
            <div className="grid min-w-0 gap-0.5">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 font-semibold text-fg-primary [overflow-wrap:anywhere]">
                  {row.sku}
                </span>
                {price && (
                  <span className="shrink-0 text-sm tabular-nums text-fg-primary">{price}</span>
                )}
              </div>
              <span className="text-xs text-fg-muted">{machineSpecs(row)}</span>
            </div>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {row.cells.map((cell) => (
                <RegionChip
                  key={cell.key}
                  row={row}
                  cell={cell}
                  on={isCellAllowed(cell, draft)}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface MachinePickerProps {
  groups: MachineGroup[];
  draft: MachineDraft;
  onToggle: (cell: MachineCell) => void;
}

/**
 * One row per machine type, one chip per region. Machine types already in use come
 * first; the rest stay folded until asked for, so the editor starts short.
 */
export function MachinePicker({ groups, draft, onToggle }: MachinePickerProps) {
  const headingId = useId();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const normalizedQuery = query.trim().toLowerCase();
  const titles = groupTitles(groups);

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={headingId}>
      <div>
        <h3 id={headingId} className="m-0 text-sm font-semibold text-fg-primary">
          Allowed machines
        </h3>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Select the regions where SAM may start each machine type.
        </p>
      </div>
      <Input
        type="search"
        className="[&::-webkit-search-cancel-button]:appearance-none"
        aria-label="Search machine types"
        placeholder="Search by name or region"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {groups.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">
          No machines found yet. Use Refresh to read your cloud account&apos;s machine list.
        </p>
      )}
      {groups.map((group) => {
        const matches = normalizedQuery
          ? group.rows.filter((row) => rowMatches(row, normalizedQuery))
          : group.rows;
        const inUse = matches.filter((row) => row.allowed);
        const others = matches.filter((row) => !row.allowed);
        const showOthers =
          Boolean(normalizedQuery) || expanded.has(group.key) || inUse.length === 0;
        return (
          <div key={group.key} className="grid min-w-0 gap-2">
            {groups.length > 1 && (
              <h4 className="m-0 text-xs font-semibold text-fg-muted">{titles.get(group.key)}</h4>
            )}
            {inUse.length > 0 && <MachineRows rows={inUse} draft={draft} onToggle={onToggle} />}
            {others.length > 0 &&
              (showOthers ? (
                <>
                  {inUse.length > 0 && (
                    <h5 className="m-0 mt-1 text-xs font-medium text-fg-muted">
                      Other machine types
                    </h5>
                  )}
                  <MachineRows rows={others} draft={draft} onToggle={onToggle} />
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-self-start"
                  onClick={() => setExpanded((current) => new Set(current).add(group.key))}
                >
                  Show {others.length} more machine type{others.length === 1 ? '' : 's'}
                </Button>
              ))}
            {matches.length === 0 && normalizedQuery && (
              <p className="m-0 text-xs text-fg-muted">No machine types match “{query.trim()}”.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
