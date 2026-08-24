import {
  COMMENT_BUCKET_COLORS,
  COMMENT_BUCKET_LABELS,
  COMMENT_BUCKET_ORDER,
  type CommentInboxCounts,
  type CommentInboxFilter,
} from './comment-inbox';

const FILTERS: { value: CommentInboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...COMMENT_BUCKET_ORDER.map((bucket) => ({
    value: bucket satisfies CommentInboxFilter,
    label: COMMENT_BUCKET_LABELS[bucket],
  })),
];

function accentForFilter(value: CommentInboxFilter): string {
  if (value === 'all') return 'var(--sam-color-accent-primary)';
  return COMMENT_BUCKET_COLORS[value];
}

function classNameForFilter(active: boolean, count: number): string {
  if (active) return 'border-transparent bg-surface-hover text-fg-primary';
  if (count === 0) return 'border-border-default text-fg-muted opacity-60 hover:opacity-100';
  return 'border-border-default text-fg-muted hover:text-fg-primary';
}

/**
 * Bucket filter chips with live counts.
 *
 * The counts are the point: they turn the filter row into the summary line as
 * well, so a glance at the top of the panel answers "is there anything here?"
 * before any scrolling happens. Empty buckets stay visible but dimmed rather
 * than disappearing, so the row does not reflow as threads are resolved.
 *
 * Horizontally scrollable at 375px — five chips do not fit, and wrapping to a
 * second line would push the list below the fold on a phone.
 */
export function CommentInboxFilters({
  value,
  counts,
  onChange,
  className = '',
}: Readonly<{
  value: CommentInboxFilter;
  counts: CommentInboxCounts;
  onChange: (next: CommentInboxFilter) => void;
  className?: string;
}>) {
  return (
    <div
      aria-label="Filter comments"
      data-intentional-clip="horizontal chip scroller — five filters cannot fit at 375px"
      // The right-edge mask is load-bearing, not decoration: without it a chip
      // sliced by the container edge reads as a layout bug rather than as a
      // scroller, and people do not try to swipe it.
      className={`flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_0,black_calc(100%-1.5rem),transparent_100%)] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {FILTERS.map((filter) => {
        const count = counts[filter.value];
        const active = value === filter.value;
        const accent = accentForFilter(filter.value);
        const stateClassName = classNameForFilter(active, count);

        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={active}
            aria-label={`${filter.label}, ${count} ${count === 1 ? 'comment' : 'comments'}`}
            onClick={() => onChange(filter.value)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${stateClassName}`}
          >
            {filter.value !== 'all' && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: accent }}
              />
            )}
            {filter.label}
            <span aria-hidden="true" className="tabular-nums opacity-70">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
