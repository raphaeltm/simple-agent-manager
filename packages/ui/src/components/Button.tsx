import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantStyle: Record<ButtonVariant, CSSProperties> = {
  primary: {
    backgroundColor: 'var(--sam-color-accent-primary)',
    color: '#ffffff',
    border: '1px solid transparent',
  },
  secondary: {
    backgroundColor: 'var(--sam-color-bg-surface)',
    color: 'var(--sam-color-fg-primary)',
    border: '1px solid var(--sam-color-border-default)',
  },
  danger: {
    backgroundColor: 'var(--sam-color-danger)',
    color: '#ffffff',
    border: '1px solid transparent',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--sam-color-fg-primary)',
    border: '1px solid var(--sam-color-border-default)',
  },
};

const sizeStyle: Record<ButtonSize, CSSProperties> = {
  sm: { minHeight: '36px', padding: '0 12px', fontSize: '0.875rem' },
  md: { minHeight: '44px', padding: '0 16px', fontSize: '0.95rem' },
  lg: { minHeight: '56px', padding: '0 20px', fontSize: '1rem' },
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  const baseStyle: CSSProperties = {
    borderRadius: 'var(--sam-radius-md)',
    fontWeight: 600,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled ? 0.6 : 1,
    transition: 'all 150ms ease',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    ...variantStyle[variant],
    ...sizeStyle[size],
    ...style,
  };

  return (
    <button {...props} disabled={isDisabled} style={baseStyle}>
      {loading ? 'Loading...' : children}
    </button>
  );
}
