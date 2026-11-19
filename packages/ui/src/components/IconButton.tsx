import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';

import { Count, type CountTone } from './Count';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name. Include the count when there is one ("Notifications, 2 unread"). */
  label: string;
  icon: ReactNode;
  /** Raised controls sit on the glass (the screen's main toggle, a grouped secondary action). */
  raised?: boolean;
  /** `md` is the 44px touch target; `sm` (36px) only where a row offers several. */
  size?: 'sm' | 'md';
  count?: number | string;
  countTone?: CountTone;
  /** Show the native tooltip with the label (on by default). */
  showTooltip?: boolean;
}

/** A SAM Glass icon button: 44px target, Lucide icon, optional count. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    raised = false,
    size = 'md',
    count,
    countTone = 'active',
    showTooltip = true,
    className = '',
    type = 'button',
    ...props
  },
  ref
) {
  const sizeClass =
    size === 'md' ? 'h-11 w-11 rounded-[var(--sam-radius-control)]' : 'h-9 w-9 rounded-[10px]';
  const surface = raised
    ? 'sam-raised text-fg-primary'
    : 'bg-transparent text-fg-muted hover:text-fg-primary hover:bg-[var(--sam-glass-v2-raised)]';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={showTooltip ? label : undefined}
      className={`relative inline-grid shrink-0 cursor-pointer place-items-center border-0 p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-55 ${sizeClass} ${surface} ${className}`}
      {...props}
    >
      {icon}
      {count !== undefined && count !== 0 && count !== '' && (
        <Count value={count} tone={countTone} floating />
      )}
    </button>
  );
});
