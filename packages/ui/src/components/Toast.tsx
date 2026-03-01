import type { FC } from 'react';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastData {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

const variantConfig: Record<ToastVariant, { classes: string; borderClass: string; icon: string }> = {
  success: {
    classes: 'bg-success-tint text-success-fg',
    borderClass: 'border-success/35',
    icon: '\u2713', // checkmark
  },
  error: {
    classes: 'bg-danger-tint text-danger-fg',
    borderClass: 'border-danger/35',
    icon: '\u2717', // X mark
  },
  warning: {
    classes: 'bg-warning-tint text-warning-fg',
    borderClass: 'border-warning/35',
    icon: '\u26A0', // warning
  },
  info: {
    classes: 'bg-info-tint text-info-fg',
    borderClass: 'border-info/35',
    icon: '\u2139', // info
  },
};

/**
 * Single toast notification item.
 */
export const Toast: FC<ToastProps> = ({ toast, onDismiss }) => {
  const config = variantConfig[toast.variant];

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`toast-${toast.variant}`}
      className={`flex items-center gap-2.5 rounded-md border px-3.5 py-2.5 text-sm font-medium shadow-dropdown max-w-[400px] w-full animate-[sam-toast-slide-in_200ms_ease-out] ${config.classes} ${config.borderClass}`}
    >
      <span className="shrink-0 text-base">{config.icon}</span>
      <span className="flex-1 leading-[1.4]">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 cursor-pointer border-none bg-transparent px-1 py-0.5 text-base leading-none opacity-70"
      >
        {'\u00D7'}
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

/**
 * Absolutely-positioned container that renders toasts stacked at the top-right.
 * Keyframes defined in packages/ui/src/styles.css (sam-toast-slide-in).
 */
export const ToastContainer: FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-toast flex flex-col gap-2 pointer-events-none"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
};
