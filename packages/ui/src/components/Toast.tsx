import type { CSSProperties, FC } from 'react';

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

const variantStyles: Record<ToastVariant, { bg: string; border: string; color: string; icon: string }> = {
  success: {
    bg: 'rgba(34, 197, 94, 0.12)',
    border: 'rgba(34, 197, 94, 0.35)',
    color: 'rgb(74, 222, 128)',
    icon: '\u2713', // checkmark
  },
  error: {
    bg: 'rgba(248, 113, 113, 0.12)',
    border: 'rgba(248, 113, 113, 0.35)',
    color: 'rgb(248, 113, 113)',
    icon: '\u2717', // X mark
  },
  warning: {
    bg: 'rgba(251, 191, 36, 0.12)',
    border: 'rgba(251, 191, 36, 0.35)',
    color: 'rgb(251, 191, 36)',
    icon: '\u26A0', // warning
  },
  info: {
    bg: 'rgba(96, 165, 250, 0.12)',
    border: 'rgba(96, 165, 250, 0.35)',
    color: 'rgb(96, 165, 250)',
    icon: '\u2139', // info
  },
};

/**
 * Single toast notification item.
 */
export const Toast: FC<ToastProps> = ({ toast, onDismiss }) => {
  const style = variantStyles[toast.variant];

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`toast-${toast.variant}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        borderRadius: 'var(--sam-radius-md, 8px)',
        backgroundColor: style.bg,
        border: `1px solid ${style.border}`,
        color: style.color,
        fontSize: '0.875rem',
        fontWeight: 500,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
        maxWidth: '400px',
        width: '100%',
        animation: 'sam-toast-slide-in 200ms ease-out',
      }}
    >
      <span style={{ flexShrink: 0, fontSize: '1rem' }}>{style.icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        style={{
          background: 'none',
          border: 'none',
          color: style.color,
          cursor: 'pointer',
          padding: '2px 4px',
          fontSize: '1rem',
          lineHeight: 1,
          opacity: 0.7,
          flexShrink: 0,
        }}
      >
        \u00D7
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

const slideInKeyframes = `
@keyframes sam-toast-slide-in {
  from { transform: translateY(-10px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
`;

let toastStyleInjected = false;

function injectToastStyle() {
  if (toastStyleInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.textContent = slideInKeyframes;
  document.head.appendChild(el);
  toastStyleInjected = true;
}

/**
 * Absolutely-positioned container that renders toasts stacked at the top-right.
 */
export const ToastContainer: FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  injectToastStyle();

  if (toasts.length === 0) return null;

  const containerStyle: CSSProperties = {
    position: 'fixed',
    top: 16,
    right: 16,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    pointerEvents: 'none',
  };

  return (
    <div style={containerStyle} aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} style={{ pointerEvents: 'auto' }}>
          <Toast toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
};
