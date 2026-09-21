import type { FC } from 'react';

import type { NodeCapacity, Tenant } from './capacity';
import { tenantReservationFor } from './capacity';
import {
  clampPercent,
  DIMENSIONS,
  formatByDimension,
  formatPercent,
  SEVERITY_FG,
  severityOf,
  TRACK,
} from './viz-tokens';

/**
 * Concept C — Workspace ledger.
 *
 * Rows are tenants, columns are dimensions. Each micro-bar is a SHARE OF WHAT IS
 * RESERVED in that column, so the widest bar in a column is the tenant holding most
 * of that resource and the column always uses its full width.
 *
 * Iteration 2 normalised against node CAPACITY instead. At the 26% utilisation this
 * fleet actually runs at, every tenant bar collapsed into the left eighth of its
 * track and the tenant-vs-tenant comparison the ledger exists for was invisible.
 * Node-capacity context moved to the footer line, where one sentence carries it.
 *
 * Optimises for "which workspace is costing me this node". Column heads carry the
 * dimension hue; there is no per-tenant hue at all, so it scales to any tenant count.
 */

const BAR_HEIGHT = 6;

const MicroBar: FC<{ percent: number | null; color: string; title: string }> = ({
  percent,
  color,
  title,
}) => (
  <span
    title={title}
    className="block w-full rounded-full overflow-hidden"
    style={{ height: BAR_HEIGHT, backgroundColor: TRACK }}
  >
    {percent !== null && (
      <span
        className="block h-full rounded-full"
        style={{ width: `${clampPercent(percent)}%`, backgroundColor: color }}
      />
    )}
  </span>
);

const LedgerRow: FC<{
  capacity: NodeCapacity;
  label: string;
  chip?: string;
  values: Array<number | null>;
  colors: string[];
}> = ({ capacity, label, chip, values, colors }) => (
  <div className="flex flex-col gap-1 min-w-0">
    <div className="min-w-0 flex items-baseline gap-1.5">
      {chip && (
        <span
          className="sam-type-caption tabular-nums shrink-0 rounded-sm px-1 text-fg-muted"
          style={{ backgroundColor: TRACK }}
        >
          {chip}
        </span>
      )}
      <span className="sam-type-caption text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
        {label}
      </span>
    </div>

    <div className="grid grid-cols-3 gap-x-2 min-w-0">
      {DIMENSIONS.map((dimension, i) => {
        const dim = capacity.dimensions[dimension.key];
        const value = values[i] ?? null;
        // Share of the column's reserved total, not of node capacity — see the note
        // at the top of this file.
        const percent = value === null || dim.reserved <= 0 ? null : (value / dim.reserved) * 100;
        return (
          <div key={dimension.key} className="min-w-0 flex flex-col gap-1">
            <MicroBar
              percent={percent}
              color={colors[i] ?? dimension.hue}
              title={`${label} — ${dimension.longLabel} ${
                value === null ? 'unknown' : formatByDimension(dimension.key, value)
              }`}
            />
            <span className="sam-type-caption text-fg-muted tabular-nums truncate">
              {value === null ? '—' : formatByDimension(dimension.key, value)}
            </span>
          </div>
        );
      })}
    </div>
  </div>
);

export const ConceptLedger: FC<{ capacity: NodeCapacity }> = ({ capacity }) => {
  const colors = DIMENSIONS.map((d) => d.hue);
  const freeValues = DIMENSIONS.map((d) => {
    const dim = capacity.dimensions[d.key];
    return dim.capacity === null ? null : Math.max(0, dim.capacity - dim.reserved);
  });

  return (
    <section className="flex flex-col gap-2 min-w-0" aria-label="Per-workspace resource ledger">
      <div className="grid grid-cols-3 gap-x-2 min-w-0">
        {DIMENSIONS.map((dimension) => (
          <span
            key={dimension.key}
            className="sam-type-caption text-fg-muted font-medium tracking-wide inline-flex items-center gap-1.5 min-w-0"
          >
            <span
              aria-hidden="true"
              className="shrink-0 rounded-full"
              style={{ width: 7, height: 7, backgroundColor: dimension.hue }}
            />
            <span className="truncate">{dimension.label}</span>
          </span>
        ))}
      </div>

      {capacity.capacityUnknown ? (
        <p className="sam-type-caption text-fg-muted m-0">
          Bars appear once the node reports its hardware.
        </p>
      ) : capacity.tenants.length === 0 ? (
        <p className="sam-type-caption text-fg-muted m-0">
          No workspaces — the whole node is free.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5 min-w-0">
          {capacity.tenants.map((tenant: Tenant) => (
            <LedgerRow
              key={tenant.workspace.id}
              capacity={capacity}
              chip={String(tenant.index + 1)}
              label={tenant.label}
              values={DIMENSIONS.map((d) => tenantReservationFor(tenant, d.key))}
              colors={colors}
            />
          ))}
        </div>
      )}

      {!capacity.capacityUnknown && capacity.tenants.length > 0 && (
        <div className="border-t border-border-default pt-2 flex flex-col gap-1 min-w-0">
          <p className="sam-type-caption text-fg-muted m-0 tabular-nums [overflow-wrap:anywhere]">
            Bars are each workspace&rsquo;s share of what is reserved. Of the node:{' '}
            {DIMENSIONS.map((dimension, i) => {
              const dim = capacity.dimensions[dimension.key];
              return (
                <span key={dimension.key}>
                  {i > 0 ? ' · ' : ''}
                  {dim.reservedPercent === null ? '—' : `${formatPercent(dim.reservedPercent)}%`}{' '}
                  {dimension.label}
                </span>
              );
            })}
            .
          </p>
          <p
            className="sam-type-caption m-0 [overflow-wrap:anywhere]"
            style={{ color: SEVERITY_FG[severityOf(capacity.bindingPercent ?? 0)] }}
          >
            {capacity.exclusive
              ? 'Reserved exclusively — this node takes no more workspaces.'
              : `${formatByDimension('cpu', freeValues[0] ?? 0)}, ${formatByDimension(
                  'memory',
                  freeValues[1] ?? 0
                )} and ${formatByDimension('disk', freeValues[2] ?? 0)} still free.`}
          </p>
        </div>
      )}
    </section>
  );
};
