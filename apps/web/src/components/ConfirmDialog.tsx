import { Button } from '@simple-agent-manager/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useScrollLock } from '../hooks/useScrollLock';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
  loading?: boolean;
}

const variantConfig = {
  danger: {
    iconColorClass: 'text-danger',
    iconBgClass: 'bg-danger-tint',
    iconPath:
      'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  warning: {
    iconColorClass: 'text-warning',
    iconBgClass: 'bg-warning-tint',
    iconPath:
      'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  info: {
    iconColorClass: 'text-accent',
    iconBgClass: 'bg-accent-tint',
    iconPath: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

/**
 * Confirmation dialog component.
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Handle escape key and keep keyboard focus inside the open dialog.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) {
        return;
      }
      if (e.key === 'Escape' && !loading) {
        onClose();
        return;
      }
      if (e.key !== 'Tab') {
        return;
      }

      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, loading, onClose]);

  // Prevent body scroll when open
  useScrollLock(isOpen);

  // Move focus into the dialog and restore it to the opener on close.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const config = variantConfig[variant];
  let confirmButtonVariant: 'danger' | 'secondary' | 'primary' = 'primary';
  if (variant === 'danger') {
    confirmButtonVariant = 'danger';
  } else if (variant === 'warning') {
    confirmButtonVariant = 'secondary';
  }
  const confirmButtonStyle =
    variant === 'warning'
      ? {
          backgroundColor: 'var(--sam-color-warning-tint)',
          borderColor: 'color-mix(in srgb, var(--sam-color-warning) 45%, transparent)',
          color: 'var(--sam-color-warning-fg)',
        }
      : undefined;

  return createPortal(
    <div
      className="fixed inset-0 z-dialog-backdrop overflow-y-auto"
      aria-labelledby="modal-title"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 glass-backdrop-dim transition-opacity duration-150"
        onClick={loading ? undefined : onClose}
      />

      <div className="flex min-h-full items-start justify-center p-3 sm:items-center sm:p-4">
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="relative glass-modal glass-panel-container glass-composited rounded-lg shadow-overlay max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-hidden outline-none flex flex-col"
        >
          <div className="flex items-start overflow-y-auto p-5 sm:p-6">
            <div
              className={`shrink-0 flex items-center justify-center h-12 w-12 rounded-full ${config.iconBgClass}`}
            >
              <svg
                className={`h-6 w-6 ${config.iconColorClass}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={config.iconPath}
                />
              </svg>
            </div>
            <div className="ml-4 flex-1">
              <h3 className="text-base font-semibold text-fg-primary" id="modal-title">
                {title}
              </h3>
              <div className="mt-2 text-sm text-fg-muted">{message}</div>
            </div>
          </div>

          <div className="flex shrink-0 justify-end gap-3 border-t border-border-default p-4 sm:p-6">
            <Button variant="secondary" disabled={loading} onClick={onClose}>
              {cancelLabel}
            </Button>
            <Button
              variant={confirmButtonVariant}
              disabled={loading}
              onClick={onConfirm}
              loading={loading}
              style={confirmButtonStyle}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
