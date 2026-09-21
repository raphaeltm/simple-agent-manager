import type { FC } from 'react';

import type { NodeCapacity } from './capacity';
import { headroomSlots } from './capacity';
import {
  clampPercent,
  DIMENSION_BY_KEY,
  DIMENSIONS,
  formatByDimension,
  formatPercent,
  SEVERITY_FG,
  severityOf,
  TRACK,
} from './viz-tokens';

/**
 * Concept D — Headroom slots.
 *
 * Not a utilisation chart: a derived answer to "what fits here next?". The node's
 * capacity is quantised into slots the size of the median tenant already on it
 * (or the platform default on an empty node). Filled pips are running workspaces;
 * hollow pips are room. The binding dimension — the one that runs out first — is
 * named, because that is the number that decides whether the scheduler packs the
 * next task here or pays for another VM.
 *
 * Three hairline dimension bars sit under the pips so the raw utilisation is still
 * readable; the pips are the headline, the bars are the evidence.
 */

/**
 * High enough that a realistically empty node still shows its whole slot set across
 * two wrapped rows. Truncating to 16 with a "+18" made a node that is 15% full by
 * slots look about a third full — the pips misrepresented the one thing they exist
 * to show.
 */
const MAX_PIPS = 36;
const PIP = 7;

const DimensionStrip: FC<{ capacity: NodeCapacity }> = ({ capacity }) => (
  <div className="flex items-center gap-2.5 min-w-0">
    {DIMENSIONS.map((dimension) => {
      const dim = capacity.dimensions[dimension.key];
      const percent = dim.reservedPercent;
      return (
        <div key={dimension.key} className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-1 min-w-0">
            <span className="sam-type-caption text-fg-muted truncate">{dimension.label}</span>
            <span className="sam-type-caption text-fg-muted tabular-nums shrink-0">
              {percent === null ? '—' : `${formatPercent(percent)}%`}
            </span>
          </div>
          <span
            className="block w-full rounded-full overflow-hidden"
            style={{ height: 4, backgroundColor: TRACK }}
            role="meter"
            aria-valuenow={percent === null ? undefined : Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${dimension.longLabel} reserved ${
              percent === null ? 'unknown' : `${formatPercent(percent)} percent`
            }`}
          >
            {percent !== null && (
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${clampPercent(percent)}%`,
                  backgroundColor: dimension.hue,
                }}
              />
            )}
          </span>
          <span className="sam-type-caption text-fg-muted tabular-nums truncate">
            {dim.capacity === null
              ? 'unknown'
              : `${formatByDimension(dimension.key, dim.capacity - dim.reserved)} left`}
          </span>
        </div>
      );
    })}
  </div>
);

export const ConceptHeadroom: FC<{ capacity: NodeCapacity }> = ({ capacity }) => {
  const { slots, bindingKey, yardstick, yardstickIsDefault } = headroomSlots(capacity);
  const used = capacity.tenants.length;
  const binding = bindingKey ? DIMENSION_BY_KEY[bindingKey] : null;

  const totalPips = slots === null ? used : used + slots;
  const shownPips = Math.min(totalPips, MAX_PIPS);
  const overflowPips = totalPips - shownPips;
  const severity = severityOf(capacity.bindingPercent ?? 0);

  return (
    <section className="flex flex-col gap-2.5 min-w-0" aria-label="Node headroom">
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <span className="sam-type-caption text-fg-muted font-medium uppercase tracking-wide">
          Headroom
        </span>
        <span className="sam-type-caption text-fg-muted text-right [overflow-wrap:anywhere] min-w-0">
          {capacity.capacityUnknown
            ? 'hardware not reported yet'
            : binding
              ? `${binding.longLabel} runs out first`
              : 'nothing reserved'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1" aria-hidden="true">
        {Array.from({ length: shownPips }, (_, i) => {
          const filled = i < used;
          return (
            <span
              key={i}
              className="rounded-full shrink-0"
              style={{
                width: PIP,
                height: PIP,
                // A transparent pip with only a 1px ring was invisible against the
                // card; the empty slot has to read as a slot.
                backgroundColor: filled ? 'var(--sam-color-accent-primary)' : TRACK,
                boxShadow: filled ? undefined : 'inset 0 0 0 1px var(--sam-color-border-default)',
              }}
            />
          );
        })}
        {overflowPips > 0 && (
          <span className="sam-type-caption text-fg-muted tabular-nums pl-1">
            +{overflowPips}
          </span>
        )}
      </div>

      <p
        className="sam-type-body m-0 [overflow-wrap:anywhere]"
        style={{ color: SEVERITY_FG[severity] }}
      >
        {capacity.capacityUnknown ? (
          'Capacity unknown until the node reports its hardware.'
        ) : capacity.exclusive ? (
          <>
            <strong className="font-semibold">Exclusive</strong> — this node takes no more
            workspaces.
          </>
        ) : slots === null ? (
          'Capacity unknown.'
        ) : (
          <>
            <strong className="font-semibold tabular-nums">
              {used} running · room for {slots} more
            </strong>
          </>
        )}
      </p>

      {!capacity.capacityUnknown && !capacity.exclusive && slots !== null && (
        <p className="sam-type-caption text-fg-muted m-0 [overflow-wrap:anywhere]">
          One slot ={' '}
          <span className="tabular-nums">
            {formatByDimension('cpu', yardstick.cpuMillis)} ·{' '}
            {formatByDimension('memory', yardstick.memoryMb)} ·{' '}
            {formatByDimension('disk', yardstick.diskMb)}
          </span>{' '}
          ({yardstickIsDefault ? 'platform default' : 'median workspace here'}).
        </p>
      )}

      <DimensionStrip capacity={capacity} />

      {!capacity.capacityUnknown && (
        <p className="sam-type-caption text-fg-muted m-0 [overflow-wrap:anywhere]">
          Bars and percentages are what is reserved; the figure under each is what is left.
        </p>
      )}
    </section>
  );
};
