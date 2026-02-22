import { ReactNode, useEffect, useRef } from 'react';
import { Button } from '@simple-agent-manager/ui';

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
    iconColor: 'var(--sam-color-danger)',
    iconBg: 'rgba(239, 68, 68, 0.15)',
    iconPath: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  warning: {
    iconColor: 'var(--sam-color-warning)',
    iconBg: 'rgba(245, 158, 11, 0.15)',
    iconPath: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  info: {
    iconColor: 'var(--sam-color-accent-primary)',
    iconBg: 'rgba(22, 163, 74, 0.15)',
    iconPath: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
};

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

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !loading) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, loading, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const config = variantConfig[variant];

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50, overflowY: 'auto' }}
      aria-labelledby="modal-title"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--sam-color-bg-overlay)',
          transition: 'opacity 0.15s',
        }}
        onClick={loading ? undefined : onClose}
      />

      <div style={{
        display: 'flex',
        minHeight: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sam-space-4)',
      }}>
        <div
          ref={dialogRef}
          tabIndex={-1}
          style={{
            position: 'relative',
            backgroundColor: 'var(--sam-color-bg-surface)',
            borderRadius: 'var(--sam-radius-lg)',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
            border: '1px solid var(--sam-color-border-default)',
            maxWidth: '28rem',
            width: '100%',
            padding: 'var(--sam-space-6)',
            outline: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            <div style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 48,
              width: 48,
              borderRadius: '50%',
              backgroundColor: config.iconBg,
            }}>
              <svg style={{ height: 24, width: 24, color: config.iconColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={config.iconPath} />
              </svg>
            </div>
            <div style={{ marginLeft: 'var(--sam-space-4)', flex: 1 }}>
              <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }} id="modal-title">
                {title}
              </h3>
              <div style={{ marginTop: 'var(--sam-space-2)', fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>{message}</div>
            </div>
          </div>

          <div style={{ marginTop: 'var(--sam-space-6)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--sam-space-3)' }}>
            <Button
              variant="secondary"
              disabled={loading}
              onClick={onClose}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={variant === 'danger' ? 'danger' : 'primary'}
              disabled={loading}
              onClick={onConfirm}
              loading={loading}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
