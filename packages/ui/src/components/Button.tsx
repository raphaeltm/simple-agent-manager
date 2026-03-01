import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-fg-on-accent border border-transparent',
  secondary: 'bg-surface text-fg-primary border border-border-default',
  danger: 'bg-danger text-fg-on-accent border border-transparent',
  ghost: 'bg-transparent text-fg-primary border border-border-default',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-[0.95rem]',
  lg: 'min-h-14 px-5 text-base',
};

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
      className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-all duration-150 ease-in-out ${isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      style={style}
    >
      {loading ? 'Loading...' : children}
    </button>
  );
}
