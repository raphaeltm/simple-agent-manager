import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown after the label in mono; the current option's count turns green. */
  count?: number;
  /** Accessible name when the label alone is not enough ("Mine, 3 chats"). */
  ariaLabel?: string;
  icon?: ReactNode;
  title?: string;
}

/** A well with raised choices. Buttons carry `aria-pressed`, so each reads as a toggle. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className = '',
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  /** `md` is 30px; `lg` is 40px for touch (mobile drawers). */
  size?: 'md' | 'lg';
  className?: string;
}) {
  const height = size === 'lg' ? 'h-10 text-[15px]' : 'h-[30px] text-[13px]';
  return (
    <div
      role="group"
      aria-label={label}
      className={`sam-well flex gap-0.5 rounded-[var(--sam-radius-control)] p-0.5 ${className}`}
    >
      {options.map((option) => {
        const current = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={current}
            aria-label={option.ariaLabel}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-[9px] border-0 px-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${height} ${
              current
                ? 'sam-raised font-medium text-fg-primary'
                : 'bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
            {option.count !== undefined && (
              <span
                className={`font-mono text-[11px] ${current ? 'text-[var(--sam-status-success-fg)]' : 'text-fg-muted'}`}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
