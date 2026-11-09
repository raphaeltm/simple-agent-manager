import { Alert, Button, Chip, IconButton } from '@simple-agent-manager/ui';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useId, useState } from 'react';

import {
  EMPTY_POOL_COPY,
  POOL_EDITOR_COPY,
  PROVIDER_ORDER_COPY,
} from '../../lib/compute-pool-copy';
import type { MachineRegionRow, RegionDraft } from '../../lib/compute-pool-region-rows';
import { isRowAllowed } from '../../lib/compute-pool-region-rows';
import type { OrderableSource } from '../../lib/compute-pool-source-order';
import { ModelToggleSwitch } from '../agent-models/ModelToggleSwitch';

/** Picked rows shown per account before "Show all". */
const VISIBLE_ITEMS_PER_ACCOUNT = 5;

interface PoolAccountsPaneProps {
  accounts: OrderableSource[];
  rows: MachineRegionRow[];
  draft: RegionDraft;
  excluded: ReadonlySet<string>;
  /** null: every account is equal. Otherwise every account id, most preferred first. */
  order: string[] | null;
  /** Rows SAM can place on: in the pool, on an account that is on. */
  usableCount: number;
  readOnly: boolean;
  onAccountChange: (sourceId: string, on: boolean) => void;
  onOrderChange: (order: string[] | null) => void;
  onRemoveRows: (rows: MachineRegionRow[]) => void;
}

function machineCount(count: number): string {
  return `${count} machine${count === 1 ? '' : 's'}`;
}

function cheapestLabel(items: MachineRegionRow[]): string | null {
  const priced = items.filter((row) => row.monthlyPrice !== null && row.priceLabel);
  if (priced.length === 0) return null;
  const min = priced.reduce((best, row) =>
    (row.monthlyPrice ?? Infinity) < (best.monthlyPrice ?? Infinity) ? row : best
  );
  const allSame = priced.every((row) => row.priceLabel === min.priceLabel);
  return allSame ? min.priceLabel : `from ${min.priceLabel}`;
}

/** Swap an account with its neighbour among the accounts that are on. */
function moveAmong(order: string[], visible: string[], id: string, delta: -1 | 1): string[] {
  const position = visible.indexOf(id);
  const neighbour = visible[position + delta];
  if (neighbour === undefined) return order;
  const next = [...order];
  const a = next.indexOf(id);
  const b = next.indexOf(neighbour);
  [next[a], next[b]] = [neighbour, id];
  return next;
}

export function PoolAccountsPane({
  accounts,
  rows,
  draft,
  excluded,
  order,
  usableCount,
  readOnly,
  onAccountChange,
  onOrderChange,
  onRemoveRows,
}: PoolAccountsPaneProps) {
  const headingId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const picked = new Map<string, MachineRegionRow[]>();
  for (const row of rows) {
    if (!isRowAllowed(row, draft)) continue;
    picked.set(row.sourceId, [...(picked.get(row.sourceId) ?? []), row]);
  }
  const rank = new Map((order ?? accounts.map((account) => account.id)).map((id, i) => [id, i]));
  const sorted = [...accounts].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
  );
  const on = sorted.filter((account) => !excluded.has(account.id) && picked.has(account.id));
  const off = sorted.filter((account) => excluded.has(account.id) || !picked.has(account.id));
  const allPicked = [...picked.values()].flat();
  const onIds = on.map((account) => account.id);

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={headingId}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="m-0 text-sm font-semibold text-fg-primary">
            {POOL_EDITOR_COPY.accountsTitle}
          </h3>
          <p className="m-0 mt-1 text-xs text-fg-muted">{POOL_EDITOR_COPY.accountsHelp}</p>
        </div>
        {!readOnly && allPicked.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onRemoveRows(allPicked)}>
            Remove all
          </Button>
        )}
      </div>

      {usableCount === 0 && (
        <Alert variant="warning">
          <strong className="block">{EMPTY_POOL_COPY.title}</strong>
          {EMPTY_POOL_COPY.body}
        </Alert>
      )}

      {on.length > 1 && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
          <span>
            {order
              ? PROVIDER_ORDER_COPY.ordered.description
              : PROVIDER_ORDER_COPY.equal.description}
          </span>
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOrderChange(order ? null : sorted.map((account) => account.id))}
            >
              {order ? PROVIDER_ORDER_COPY.equal.label : PROVIDER_ORDER_COPY.ordered.label}
            </Button>
          )}
        </div>
      )}

      {on.length > 0 && (
        <ol className="m-0 grid list-none gap-2 p-0">
          {on.map((account, index) => {
            const items = picked.get(account.id) ?? [];
            const open = expanded.has(account.id);
            const shown = open ? items : items.slice(0, VISIBLE_ITEMS_PER_ACCOUNT);
            const price = cheapestLabel(items);
            return (
              <li
                key={account.id}
                className="grid min-w-0 gap-2 rounded-md border border-border-default bg-inset p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {order && (
                    <span className="sam-raised grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold text-fg-primary">
                      {index + 1}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="m-0 break-words text-sm font-medium text-fg-primary">
                      {account.title}
                    </p>
                    <p className="m-0 text-xs text-fg-muted">
                      {machineCount(items.length)}
                      {price ? ` · ${price}` : ''}
                    </p>
                  </div>
                  {order && !readOnly && (
                    <span className="sam-well flex shrink-0 rounded-[10px]">
                      <IconButton
                        size="sm"
                        label={`Try ${account.title} earlier`}
                        icon={<ArrowUp size={16} aria-hidden />}
                        disabled={index === 0}
                        onClick={() => onOrderChange(moveAmong(order, onIds, account.id, -1))}
                      />
                      <IconButton
                        size="sm"
                        label={`Try ${account.title} later`}
                        icon={<ArrowDown size={16} aria-hidden />}
                        disabled={index === on.length - 1}
                        onClick={() => onOrderChange(moveAmong(order, onIds, account.id, 1))}
                      />
                    </span>
                  )}
                  <ModelToggleSwitch
                    checked
                    disabled={readOnly}
                    label={`Use ${account.title} in this pool`}
                    onChange={() => onAccountChange(account.id, false)}
                  />
                </div>
                <ul className="m-0 grid list-none gap-1 p-0">
                  {shown.map((row) => (
                    <li
                      key={row.key}
                      className="flex min-w-0 items-center gap-2 border-t border-border-default pt-1 text-xs"
                    >
                      <span className="min-w-0 flex-1 break-words text-fg-primary">
                        <span className="font-mono">{row.sku}</span> · {row.regionLabel}
                      </span>
                      {row.priceLabel && (
                        <span className="shrink-0 text-fg-muted">{row.priceLabel}</span>
                      )}
                      {!readOnly && (
                        <IconButton
                          size="sm"
                          label={`Remove ${row.sku} in ${row.regionLabel}`}
                          icon={<X size={14} aria-hidden />}
                          onClick={() => onRemoveRows([row])}
                        />
                      )}
                    </li>
                  ))}
                </ul>
                {items.length > VISIBLE_ITEMS_PER_ACCOUNT && (
                  <button
                    type="button"
                    className="justify-self-start border-0 bg-transparent p-0 text-xs font-medium text-accent underline-offset-2 hover:underline"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.delete(account.id);
                        else next.add(account.id);
                        return next;
                      })
                    }
                  >
                    {open ? 'Show fewer' : `Show all ${items.length}`}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {off.length > 0 && (
        <div className="grid min-w-0 gap-2">
          <p className="m-0 text-xs font-medium text-fg-muted">{POOL_EDITOR_COPY.offTitle}</p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {off.map((account) => {
              const kept = picked.get(account.id)?.length ?? 0;
              return (
                <li
                  key={account.id}
                  className="flex min-w-0 items-center gap-2 rounded-md border border-dashed border-border-default p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="m-0 break-words text-sm font-medium text-fg-primary">
                      {account.title}
                    </p>
                    <p className="m-0 text-xs text-fg-muted">
                      {kept > 0
                        ? `${machineCount(kept)} kept, not used`
                        : POOL_EDITOR_COPY.noMachinesOn}
                    </p>
                  </div>
                  {kept > 0 ? (
                    <ModelToggleSwitch
                      checked={false}
                      disabled={readOnly}
                      label={`Use ${account.title} in this pool`}
                      onChange={() => onAccountChange(account.id, true)}
                    />
                  ) : (
                    <Chip size="sm" tone="muted">
                      Off
                    </Chip>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {accounts.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">No cloud accounts are connected to this pool.</p>
      )}
    </section>
  );
}
