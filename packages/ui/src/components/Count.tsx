/**
 * A count on an icon button or nav item. Green means running now; amber means waiting on
 * you. Solid, never glass. The number belongs in the owning control's `aria-label` too, so
 * the badge itself is hidden from assistive tech.
 */
export type CountTone = 'active' | 'attention' | 'muted';

const toneClasses: Record<CountTone, string> = {
  active: 'bg-[var(--sam-count-active)] text-[var(--sam-count-active-ink)]',
  attention: 'bg-[var(--sam-color-warning)] text-[var(--sam-attention-ink)]',
  muted: 'bg-[var(--sam-chip-bg)] text-fg-muted shadow-[inset_0_0_0_1px_var(--sam-chip-edge)]',
};

export interface CountProps {
  value: number | string;
  tone?: CountTone;
  /** Floats on the top-right corner of its (positioned) parent instead of sitting inline. */
  floating?: boolean;
  /**
   * Render the number as real text. Use it where the owning control is named by its visible
   * content, so the count is part of what it reads; leave it off where the control has an
   * `aria-label` that already carries the count.
   */
  asText?: boolean;
  className?: string;
}

/**
 * The number is drawn by a pseudo-element from `data-count`, so it never becomes text inside
 * the owning control: its accessible name already carries the count, and visible digits that
 * are not in that name fail WCAG 2.5.3 (label in name).
 */
export function Count({
  value,
  tone = 'active',
  floating = false,
  asText = false,
  className = '',
}: CountProps) {
  return (
    <span
      aria-hidden={asText ? undefined : true}
      data-tone={tone}
      data-count={asText ? undefined : value}
      className={`inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold leading-none tabular-nums ${
        asText ? '' : 'before:content-[attr(data-count)]'
      } ${toneClasses[tone]} ${
        floating ? 'absolute top-1 right-0.5 shadow-[0_0_0_2px_var(--sam-separator)]' : ''
      } ${className}`}
    >
      {asText ? value : null}
    </span>
  );
}
