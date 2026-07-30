import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Spinner } from './Spinner';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
/** `xs` is the compact tier for dense in-card action rows. */
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Marks an in-flight async action. Disables the button, sets `aria-busy`, and
   * swaps any leading icon for a spinner so the press has visible consequences
   * before the network round trip returns.
   */
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-fg-on-accent border border-transparent',
  secondary: 'bg-surface text-fg-primary border border-border-default hover:bg-[var(--sam-button-secondary-hover-bg)]',
  danger: 'bg-danger text-fg-on-accent border border-transparent',
  ghost: 'bg-transparent text-fg-primary border border-border-default hover:bg-[var(--sam-form-focus-inset)]',
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: 'min-h-7 px-2.5 text-xs',
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-[0.95rem]',
  lg: 'min-h-14 px-5 text-base',
};

const spinnerSize: Record<ButtonSize, 'sm' | 'md'> = {
  xs: 'sm',
  sm: 'sm',
  md: 'sm',
  lg: 'md',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  style,
  onClick,
  ...props
}: ButtonProps) {
  // "Unavailable" and "busy" are different states and need different
  // mechanisms. `disabled` means the action cannot be taken, so the native
  // attribute is right: it leaves the tab order. `loading` is transient, and
  // the native attribute would be actively harmful — setting `disabled` on the
  // element that currently has focus makes the browser blur it to <body> and
  // never restore it, so a keyboard user who activates a button loses their
  // place every time. `aria-disabled` keeps focus and the tab order while
  // still announcing the control as unavailable; the click guard below is what
  // actually prevents activation.
  const isBusy = loading;
  const isUnavailable = Boolean(disabled);
  const isInert = isBusy || isUnavailable;

  return (
    <button
      {...props}
      disabled={isUnavailable}
      aria-disabled={isBusy || undefined}
      aria-busy={isBusy || undefined}
      onClick={(event) => {
        if (isBusy) {
          // preventDefault also suppresses implicit form submission, which a
          // bare `return` would not.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
      className={`sam-pressable inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-all duration-150 ease-in-out ${isInert ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      style={style}
    >
      {/* Decorative: `aria-busy` above already conveys the state, and a labelled
          spinner would be folded into this button's accessible name. */}
      {loading && (
        <Spinner size={spinnerSize[size]} tone="current" decorative className="shrink-0" />
      )}
      {children}
    </button>
  );
}
