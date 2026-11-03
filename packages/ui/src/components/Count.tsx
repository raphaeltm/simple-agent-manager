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
  className?: string;
}

export function Count({ value, tone = 'active', floating = false, className = '' }: CountProps) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={`inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold leading-none tabular-nums ${toneClasses[tone]} ${
        floating ? 'absolute top-1 right-0.5 shadow-[0_0_0_2px_var(--sam-separator)]' : ''
      } ${className}`}
    >
      {value}
    </span>
  );
}
