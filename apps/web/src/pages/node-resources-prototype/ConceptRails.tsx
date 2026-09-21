import type { FC } from 'react';

import type { NodeCapacity } from './capacity';
import { tenantReservationFor } from './capacity';
import { RailTrack } from './RailTrack';
import {
  clampPercent,
  DIMENSIONS,
  type DimensionSpec,
  formatByDimension,
  formatPercent,
  formatVcpu,
  segmentColor,
  SEVERITY_FG,
  severityOf,
  TRACK,
} from './viz-tokens';

/**
 * Concept A — Capacity rails.
 *
 * Three stacked part-to-whole rails, one per dimension, each segmented by tenant.
 * Dimension identity comes from the row label and the validated categorical hue;
 * tenant identity comes from left-to-right order plus a light→dark ordinal step
 * plus the numbered chip on the workspace row below — never from hue alone.
 */

const RAIL_HEIGHT = 12;

/** Bare number for the leading value so "4.2 vCPU of 16 vCPU" cannot happen. */
function bare(key: DimensionSpec['key'], value: number): string {
  return key === 'cpu' ? formatVcpu(value, false) : formatByDimension(key, value);
}

const Rail: FC<{ dimension: DimensionSpec; capacity: NodeCapacity }> = ({
  dimension,
  capacity,
}) => {
  const dim = capacity.dimensions[dimension.key];
  const percent = dim.reservedPercent;
  const severity = severityOf(percent ?? 0);

  const total = dim.capacity;
  const segments =
    total === null || total === 0
      ? []
      : capacity.tenants
          .map((tenant) => {
            const value = tenantReservationFor(tenant, dimension.key);
            return {
              id: tenant.workspace.id,
              percent: clampPercent((value / total) * 100),
              color: segmentColor(dimension, tenant.index),
              title: `${tenant.index + 1}. ${tenant.label} — ${formatByDimension(
                dimension.key,
                value
              )}`,
            };
          })
          .filter((segment) => segment.percent > 0);

  return (
    <div className="grid grid-cols-[2.4rem_1fr] items-start gap-x-2 min-w-0">
      <span className="sam-type-caption text-fg-muted font-medium pt-[1px]">
        {dimension.label}
      </span>

      <div className="min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <RailTrack
            segments={segments}
            height={RAIL_HEIGHT}
            ariaValue={percent ?? undefined}
            ariaLabel={
              percent === null
                ? `${dimension.longLabel} capacity unknown`
                : `${dimension.longLabel} reserved ${formatPercent(percent)} percent`
            }
          />
          <span
            className="sam-type-caption tabular-nums shrink-0 text-right"
            style={{ color: SEVERITY_FG[severity], minWidth: '2.5rem' }}
          >
            {percent === null ? '—' : `${formatPercent(percent)}%`}
          </span>
        </div>

        <span className="sam-type-caption text-fg-muted tabular-nums [overflow-wrap:anywhere]">
          {dim.capacity === null
            ? 'capacity unknown'
            : `${bare(dimension.key, dim.reserved)} of ${formatByDimension(
                dimension.key,
                dim.capacity
              )}${dimension.key === 'memory' ? ' usable' : ''}`}
        </span>
      </div>
    </div>
  );
};

export const ConceptRails: FC<{ capacity: NodeCapacity }> = ({ capacity }) => {
  // bindingKey is set whenever a dimension has a computable percentage — including
  // 0% — so an empty node would otherwise claim "vCPU fills first".
  const anythingReserved = DIMENSIONS.some((d) => capacity.dimensions[d.key].reserved > 0);
  const binding =
    !anythingReserved || capacity.bindingKey === null
      ? null
      : (DIMENSIONS.find((d) => d.key === capacity.bindingKey) ?? null);

  return (
    <section className="flex flex-col gap-2.5 min-w-0" aria-label="Node capacity">
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <span className="sam-type-caption text-fg-muted font-medium uppercase tracking-wide">
          Reserved
        </span>
        <span className="sam-type-caption text-fg-muted text-right [overflow-wrap:anywhere] min-w-0">
          {capacity.capacityUnknown
            ? 'hardware not reported yet'
            : capacity.exclusive
              ? 'exclusive — no co-tenants'
              : binding === null
                ? 'nothing reserved'
                : `${binding.longLabel} fills first`}
        </span>
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        {DIMENSIONS.map((dimension) => (
          <Rail key={dimension.key} dimension={dimension} capacity={capacity} />
        ))}
      </div>

      {capacity.tenants.length > 0 && !capacity.capacityUnknown && (
        <ul className="m-0 p-0 list-none flex flex-wrap gap-x-3 gap-y-1 min-w-0">
          {capacity.tenants.map((tenant) => (
            <li
              key={tenant.workspace.id}
              className="inline-flex items-baseline gap-1.5 min-w-0 max-w-full"
            >
              <span
                aria-hidden="true"
                className="sam-type-caption tabular-nums shrink-0 rounded-sm px-1 text-fg-muted"
                style={{ backgroundColor: TRACK }}
              >
                {tenant.index + 1}
              </span>
              <span className="sam-type-caption text-fg-muted truncate min-w-0">
                {tenant.label}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="sam-type-caption text-fg-muted m-0 [overflow-wrap:anywhere]">
        {capacity.capacityUnknown
          ? 'Rails appear once the node reports its hardware.'
          : capacity.tenants.length > 1
            ? `Segments run left to right in the order above. ${capacity.hostReserveMb} MB of RAM is withheld for the host.`
            : `${capacity.hostReserveMb} MB of RAM is withheld for the host.`}
      </p>
    </section>
  );
};
