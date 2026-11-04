import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `accent` and `raised` are the SAM Glass variants: a lit green primary with a glow, and a
 * secondary that sits raised on the glass. Use them on SAM Glass surfaces; the older variants
 * stay for screens that have not moved over yet.
 */
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent' | 'raised';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-fg-on-accent border border-transparent',
  secondary:
    'bg-surface text-fg-primary border border-border-default hover:bg-[var(--sam-button-secondary-hover-bg)]',
  danger: 'bg-danger text-fg-on-accent border border-transparent',
  ghost:
    'bg-transparent text-fg-primary border border-border-default hover:bg-[var(--sam-form-focus-inset)]',
  accent:
    'border-0 text-[var(--sam-on-accent)] bg-[linear-gradient(180deg,var(--sam-accent-top),var(--sam-accent-bottom))] shadow-[inset_0_1px_0_rgb(255_255_255/0.32),inset_0_-1px_0_rgb(0_0_0/0.2),var(--sam-shadow-accent)] hover:brightness-105',
  raised: 'sam-raised border-0 text-fg-primary hover:brightness-110',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-[0.95rem]',
  lg: 'min-h-14 px-5 text-base',
};

/**
 * The classes a Button renders with, for elements that must look like one but are not a
 * `<button>` (a router link that navigates, for example).
 */
export function buttonClassName({
  variant = 'primary',
  size = 'md',
  disabled = false,
}: { variant?: ButtonVariant; size?: ButtonSize; disabled?: boolean } = {}): string {
  return `inline-flex items-center justify-center gap-2 whitespace-nowrap ${variant === 'accent' || variant === 'raised' ? 'rounded-[var(--sam-radius-control)]' : 'rounded-md'} font-semibold transition-all duration-150 ease-in-out ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${variantClasses[variant]} ${sizeClasses[size]}`;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  style,
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);

  return (
    <button
      {...props}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`${buttonClassName({ variant, size, disabled: isDisabled })} ${className}`}
      style={style}
    >
      {children}
    </button>
  );
}
