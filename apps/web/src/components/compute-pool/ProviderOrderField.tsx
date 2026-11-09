import { Button } from '@simple-agent-manager/ui';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useId } from 'react';

import { PROVIDER_ORDER_COPY } from '../../lib/compute-pool-copy';
import type { OrderableSource } from '../../lib/compute-pool-source-order';

function machineCountLabel(count: number): string {
  if (count === 0) return 'No machines allowed yet';
  return `${count} allowed machine${count === 1 ? '' : 's'}`;
}

/** Starting order when an order is turned on: accounts that can start machines come first. */
function seedOrder(sources: OrderableSource[]): string[] {
  return [...sources]
    .sort((a, b) => Number(b.allowedMachineCount > 0) - Number(a.allowedMachineCount > 0))
    .map((source) => source.id);
}

function move(order: string[], index: number, delta: number): string[] {
  const next = [...order];
  const [id] = next.splice(index, 1);
  if (id !== undefined) next.splice(index + delta, 0, id);
  return next;
}

interface ProviderOrderFieldProps {
  sources: OrderableSource[];
  /** null: every source is equal. Otherwise every orderable source id, most preferred first. */
  order: string[] | null;
  onChange: (order: string[] | null) => void;
}

/** Editor section for the pool's provider order (`sourceOrder`). */
export function ProviderOrderField({ sources, order, onChange }: ProviderOrderFieldProps) {
  const name = useId();
  const byId = new Map(sources.map((source) => [source.id, source]));
  const listed = order?.flatMap((id) => byId.get(id) ?? []) ?? [];

  return (
    <section className="grid min-w-0 gap-3" aria-label="Provider order">
      <div>
        <h3 className="m-0 text-sm font-semibold text-fg-primary">Provider order</h3>
        <p className="m-0 mt-1 text-xs text-fg-muted">{PROVIDER_ORDER_COPY.help}</p>
      </div>
      {/* A stored order stays clearable even after the pool drops to one account. */}
      {sources.length < 2 && order === null ? (
        <p className="m-0 text-xs text-fg-muted">{PROVIDER_ORDER_COPY.singleSource}</p>
      ) : (
        <>
          <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
            <legend className="sr-only">Provider order</legend>
            <label className="flex items-start gap-2 text-sm text-fg-primary">
              <input
                type="radio"
                name={name}
                className="mt-1 accent-[var(--sam-color-focus-ring)]"
                checked={order === null}
                onChange={() => onChange(null)}
              />
              <span>
                {PROVIDER_ORDER_COPY.equal.label}
                <span className="block text-xs text-fg-muted">
                  {PROVIDER_ORDER_COPY.equal.description}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-fg-primary">
              <input
                type="radio"
                name={name}
                className="mt-1 accent-[var(--sam-color-focus-ring)]"
                checked={order !== null}
                onChange={() => onChange(seedOrder(sources))}
              />
              <span>
                {PROVIDER_ORDER_COPY.ordered.label}
                <span className="block text-xs text-fg-muted">
                  {PROVIDER_ORDER_COPY.ordered.description}
                </span>
              </span>
            </label>
          </fieldset>
          {order && listed.length > 0 && (
            <ol
              aria-label="Accounts in order"
              className="m-0 grid min-w-0 list-none divide-y divide-border-default rounded-md border border-border-default bg-inset p-0"
            >
              {listed.map((source, index) => (
                <li key={source.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <span
                    aria-hidden
                    className="grid size-6 shrink-0 place-items-center rounded-full border border-border-default text-xs font-semibold tabular-nums text-fg-primary"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg-primary [overflow-wrap:anywhere]">
                      <span className="sr-only">{index + 1}. </span>
                      {source.title}
                    </div>
                    <div className="text-xs text-fg-muted">
                      {machineCountLabel(source.allowedMachineCount)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move ${source.title} up`}
                      disabled={index === 0}
                      onClick={() => onChange(move(order, index, -1))}
                    >
                      <ArrowUp size={14} aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move ${source.title} down`}
                      disabled={index === listed.length - 1}
                      onClick={() => onChange(move(order, index, 1))}
                    >
                      <ArrowDown size={14} aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
