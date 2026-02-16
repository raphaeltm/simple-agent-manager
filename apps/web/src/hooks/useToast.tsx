import { createContext, useCallback, useContext, useRef, useState, type FC, type ReactNode } from 'react';
import { ToastContainer, type ToastData, type ToastVariant } from '@simple-agent-manager/ui';

/**
 * Default auto-dismiss duration (milliseconds).
 * Override via the `duration` option when calling `addToast`.
 */
const DEFAULT_TOAST_DURATION_MS = 4_000;

interface AddToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss duration in ms. 0 = never auto-dismiss. Default: 4000. */
  duration?: number;
}

interface ToastContextValue {
  /** Add a toast notification. */
  addToast: (options: AddToastOptions) => void;
  /** Convenience: show a success toast. */
  success: (message: string) => void;
  /** Convenience: show an error toast. */
  error: (message: string) => void;
  /** Convenience: show an info toast. */
  info: (message: string) => void;
  /** Convenience: show a warning toast. */
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

/**
 * Provider that manages toast notifications and renders the ToastContainer.
 * Wrap your app (or a subtree) with this provider.
 */
export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    (options: AddToastOptions) => {
      const id = `toast-${nextId++}`;
      const variant = options.variant ?? 'info';
      const duration = options.duration ?? DEFAULT_TOAST_DURATION_MS;

      const toast: ToastData = { id, message: options.message, variant };
      setToasts((prev) => [...prev, toast]);

      if (duration > 0) {
        const timer = setTimeout(() => {
          dismiss(id);
        }, duration);
        timersRef.current.set(id, timer);
      }
    },
    [dismiss]
  );

  const success = useCallback((message: string) => addToast({ message, variant: 'success' }), [addToast]);
  const error = useCallback((message: string) => addToast({ message, variant: 'error', duration: 6000 }), [addToast]);
  const info = useCallback((message: string) => addToast({ message, variant: 'info' }), [addToast]);
  const warning = useCallback((message: string) => addToast({ message, variant: 'warning' }), [addToast]);

  return (
    <ToastContext.Provider value={{ addToast, success, error, info, warning }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
};

/**
 * Hook to access the toast notification system.
 * Must be used within a `<ToastProvider>`.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
