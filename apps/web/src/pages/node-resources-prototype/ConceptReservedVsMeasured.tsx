import type { FC } from 'react';

import type { NodeCapacity } from './capacity';
import {
  clampPercent,
  DIMENSIONS,
  type DimensionSpec,
  formatByDimension,
  formatPercent,
  formatVcpu,
  GAP,
  isCompressible,
  SEVERITY_FG,
  severityOf,
  TRACK,
} from './viz-tokens';

/**
 * Concept B — Reserved vs used.
 *
 * One row per dimension. The track is the node's schedulable capacity. A wash of the
 * dimension hue spans 0 → reserved (the envelope the scheduler holds). A solid 6px bar
 * inside it spans 0 → the summed measured mean of the tenants (what actually ran). A
 * 2px tick marks the node's OWN observed utilisation from `lastMetrics`.
 *
 * The tick is deliberately NOT a sum of tenant peaks. Peaks do not co-occur, so their
 * sum is a number the machine never reached — iteration 2 of this prototype rendered
 * "peak 14.8 vCPU" on an 8-vCPU host that way. Means sum correctly; peaks do not.
 * Burst is therefore reported per tenant instead: how many workspaces exceeded their
 * OWN reservation, which is a comparison that is actually defined.
 *
 * The story is the gap between the wash and the bar: reserved capacity nobody used.
 */

const ROW_HEIGHT = 14;
const USED_HEIGHT = 6;

/** Bare number for the leading value so the unit is not printed twice in a row. */
function bare(key: DimensionSpec['key'], value: number): string {
  return key === 'cpu' ? formatVcpu(value, false) : formatByDimension(key, value);
}

const Row: FC<{ dimension: DimensionSpec; capacity: NodeCapacity }> = ({
  dimension,
  capacity,
}) => {
  const dim = capacity.dimensions[dimension.key];
  const reservedPercent = dim.reservedPercent;
  const measuredPercent = dim.measuredPercent;
  const hostPercent = dim.hostPercent;
  const compressible = isCompressible(dimension.key);

  // Efficiency answers "did we ask for the right amount?", which is a different
  // question from "is the host full?" — so it is measured against the reservation.
  const efficiency =
    dim.reserved > 0 && dim.measuredMean !== null ? (dim.measuredMean / dim.reserved) * 100 : null;

  return (
    <div className="grid grid-cols-[2.4rem_1fr] items-start gap-x-2 min-w-0">
      <span className="sam-type-caption text-fg-muted font-medium pt-[2px]">
        {dimension.label}
      </span>

      <div className="min-w-0 flex flex-col gap-1">
        <div
          className="relative w-full rounded-full overflow-hidden"
          style={{ height: ROW_HEIGHT, backgroundColor: TRACK }}
          role="meter"
          aria-valuenow={measuredPercent === null ? undefined : Math.round(measuredPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            dim.capacity === null
              ? `${dimension.longLabel} capacity unknown`
              : `${dimension.longLabel}: ${formatByDimension(dimension.key, dim.reserved)} reserved, ${
                  dim.measuredMean === null
                    ? 'no measurement yet'
                    : `${formatByDimension(dimension.key, dim.measuredMean)} used on average`
                }`
          }
        >
          {reservedPercent !== null && (
            <span
              style={{
                position: 'absolute',
                inset: 0,
                width: `${clampPercent(reservedPercent)}%`,
                backgroundColor: dimension.hue,
                opacity: 0.22,
              }}
            />
          )}
          {measuredPercent !== null && (
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: (ROW_HEIGHT - USED_HEIGHT) / 2,
                height: USED_HEIGHT,
                width: `max(3px, ${clampPercent(measuredPercent)}%)`,
                borderRadius: 999,
                backgroundColor: dimension.hue,
              }}
            />
          )}
          {hostPercent !== null && (
            <span
              title={`Host reports ${formatPercent(hostPercent)}%`}
              style={{
                position: 'absolute',
                left: `${clampPercent(hostPercent)}%`,
                top: 1,
                bottom: 1,
                width: 2,
                marginLeft: -1,
                backgroundColor: 'var(--sam-color-fg-primary)',
                // A 1px surface halo keeps the tick legible where it crosses a fill.
                boxShadow: `0 0 0 1px ${GAP}`,
              }}
            />
          )}
        </div>

        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="sam-type-caption text-fg-muted tabular-nums [overflow-wrap:anywhere] min-w-0">
            {dim.capacity === null
              ? 'capacity unknown'
              : dim.measuredMean === null
                ? `${formatByDimension(dimension.key, dim.reserved)} reserved · not measured`
                : `${bare(dimension.key, dim.measuredMean)} of ${formatByDimension(
                    dimension.key,
                    dim.reserved
                  )}${hostPercent === null ? '' : ` · host ${formatPercent(hostPercent)}%`}`}
          </span>
          {dim.burstTenants > 0 ? (
            <span
              className="sam-type-caption tabular-nums shrink-0"
              style={{
                color: compressible
                  ? 'var(--sam-color-fg-muted)'
                  : 'var(--sam-color-danger-fg)',
              }}
              title={
                compressible
                  ? 'CPU is time-sliced, so bursting above a reservation is expected'
                  : 'Memory and disk cannot be oversubscribed — this risks an OOM kill'
              }
            >
              {dim.burstTenants} burst{compressible ? ' (ok)' : ''}
            </span>
          ) : (
            efficiency !== null && (
              <span
                className="sam-type-caption tabular-nums shrink-0"
                // Severity here tracks WASTE, not load: the more of a reservation goes
                // unused, the louder the readout gets.
                style={{ color: SEVERITY_FG[severityOf(100 - efficiency)] }}
              >
                {formatPercent(efficiency)}% used
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Hue-free key for the three marks. Every swatch sits on the real track colour and is
 * drawn in the muted text token, so the key describes SHAPE only — it must never claim
 * a colour that a given row does not actually use.
 */
const ShapeKey: FC<{ kind: 'wash' | 'solid' | 'tick'; label: string }> = ({ kind, label }) => (
  <span className="inline-flex items-center gap-1.5">
    <span
      aria-hidden="true"
      className="relative inline-flex items-center rounded-full shrink-0"
      style={{ width: 18, height: 10, backgroundColor: TRACK }}
    >
      {kind === 'wash' && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            backgroundColor: 'var(--sam-color-fg-muted)',
            opacity: 0.22,
          }}
        />
      )}
      {kind === 'solid' && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 2,
            height: 6,
            width: '100%',
            borderRadius: 999,
            backgroundColor: 'var(--sam-color-fg-muted)',
          }}
        />
      )}
      {kind === 'tick' && (
        <span
          style={{
            position: 'absolute',
            left: '60%',
            top: 1,
            bottom: 1,
            width: 2,
            backgroundColor: 'var(--sam-color-fg-primary)',
          }}
        />
      )}
    </span>
    {label}
  </span>
);

export const ConceptReservedVsMeasured: FC<{ capacity: NodeCapacity }> = ({ capacity }) => {
  const oomCount = capacity.tenants.reduce((sum, t) => sum + (t.measured?.oomCount ?? 0), 0);
  const untracked = capacity.dimensions.cpu.untrackedTenants;

  return (
    <section className="flex flex-col gap-2.5 min-w-0" aria-label="Reserved versus measured">
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <span className="sam-type-caption text-fg-muted font-medium uppercase tracking-wide">
          Reserved vs used
        </span>
        {oomCount > 0 && (
          <span
            className="sam-type-caption rounded-full px-2 py-0.5 shrink-0"
            style={{
              backgroundColor: 'var(--sam-color-danger-tint)',
              color: 'var(--sam-color-danger-fg)',
            }}
          >
            {oomCount} OOM {oomCount === 1 ? 'kill' : 'kills'}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        {DIMENSIONS.map((dimension) => (
          <Row key={dimension.key} dimension={dimension} capacity={capacity} />
        ))}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 sam-type-caption text-fg-muted"
        aria-label="Shape key"
      >
        <ShapeKey kind="wash" label="reserved" />
        <ShapeKey kind="solid" label="used" />
        <ShapeKey kind="tick" label="host now" />
      </div>

      {untracked > 0 && (
        <p className="sam-type-caption text-fg-muted m-0 [overflow-wrap:anywhere]">
          {untracked} of {capacity.tenants.length} workspaces have no telemetry yet; their usage is
          not in these bars.
        </p>
      )}
    </section>
  );
};
