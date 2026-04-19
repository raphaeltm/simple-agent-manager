import type { ReactNode } from 'react';

interface AlertProps {
  variant: 'error' | 'warning' | 'success' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
  'data-testid'?: string;
}

const variantClasses: Record<AlertProps['variant'], { container: string; dismiss: string }> = {
  error: {
    container: 'bg-danger-tint text-danger-fg border-danger/30',
    dismiss: 'text-danger-fg',
  },
  warning: {
    container: 'bg-warning-tint text-warning-fg border-warning/30',
    dismiss: 'text-warning-fg',
  },
  success: {
    container: 'bg-success-tint text-success-fg border-success/30',
    dismiss: 'text-success-fg',
  },
  info: {
    container: 'bg-info-tint text-info-fg border-info/30',
    dismiss: 'text-info-fg',
  },
};

export function Alert({
  variant,
  children,
  onDismiss,
  className = '',
  'data-testid': testId,
}: AlertProps) {
  const v = variantClasses[variant];

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md border p-4 text-sm ${v.container} ${className}`}
      role="alert"
      data-testid={testId}
    >
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className={`shrink-0 cursor-pointer border-none bg-transparent p-1 text-base leading-none opacity-70 ${v.dismiss}`}
          aria-label="Dismiss"
        >
          &times;
        </button>
      )}
    </div>
  );
}
