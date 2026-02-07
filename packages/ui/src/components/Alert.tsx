import type { CSSProperties, ReactNode } from 'react';

interface AlertProps {
  variant: 'error' | 'warning' | 'success' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

const variantStyles: Record<AlertProps['variant'], { bg: string; fg: string; border: string }> = {
  error: {
    bg: 'rgba(239, 68, 68, 0.1)',
    fg: '#f87171',
    border: 'rgba(239, 68, 68, 0.3)',
  },
  warning: {
    bg: 'rgba(245, 158, 11, 0.1)',
    fg: '#fbbf24',
    border: 'rgba(245, 158, 11, 0.3)',
  },
  success: {
    bg: 'rgba(34, 197, 94, 0.1)',
    fg: '#4ade80',
    border: 'rgba(34, 197, 94, 0.3)',
  },
  info: {
    bg: 'rgba(52, 211, 153, 0.1)',
    fg: '#34d399',
    border: 'rgba(52, 211, 153, 0.3)',
  },
};

export function Alert({ variant, children, onDismiss, className = '' }: AlertProps) {
  const v = variantStyles[variant];
  const style: CSSProperties = {
    padding: 'var(--sam-space-4)',
    borderRadius: 'var(--sam-radius-md)',
    border: `1px solid ${v.border}`,
    backgroundColor: v.bg,
    color: v.fg,
    fontSize: '0.875rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--sam-space-3)',
  };

  const dismissStyle: CSSProperties = {
    background: 'none',
    border: 'none',
    color: v.fg,
    cursor: 'pointer',
    padding: 'var(--sam-space-1)',
    fontSize: '1rem',
    lineHeight: 1,
    opacity: 0.7,
    flexShrink: 0,
  };

  return (
    <div className={className} style={style} role="alert">
      <div style={{ flex: 1 }}>{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} style={dismissStyle} aria-label="Dismiss">
          &times;
        </button>
      )}
    </div>
  );
}
