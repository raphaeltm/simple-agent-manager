import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
}

const maxWidthMap = {
  sm: '24rem',
  md: '28rem',
  lg: '36rem',
};

export function Dialog({ isOpen, onClose, children, maxWidth = 'md' }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      dialogRef.current?.focus();
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--sam-space-4)',
  };

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'var(--sam-color-bg-overlay)',
    transition: 'opacity 0.15s ease',
  };

  const panelStyle: CSSProperties = {
    position: 'relative',
    backgroundColor: 'var(--sam-color-bg-surface)',
    border: '1px solid var(--sam-color-border-default)',
    borderRadius: 'var(--sam-radius-lg)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    maxWidth: maxWidthMap[maxWidth],
    width: '100%',
    padding: 'var(--sam-space-6)',
  };

  return (
    <div style={overlayStyle} aria-labelledby="dialog-title" role="dialog" aria-modal="true">
      <div style={backdropStyle} onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} style={panelStyle}>
        {children}
      </div>
    </div>
  );
}
