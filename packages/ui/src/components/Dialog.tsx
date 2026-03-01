import { type ReactNode, useEffect, useRef } from 'react';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
}

const maxWidthClasses: Record<NonNullable<DialogProps['maxWidth']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
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

  return (
    <div
      className="fixed inset-0 z-dialog-backdrop flex items-center justify-center p-4"
      aria-labelledby="dialog-title"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="fixed inset-0 bg-overlay transition-opacity duration-150 ease-in-out"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`relative w-full rounded-lg border border-border-default bg-surface p-6 shadow-overlay ${maxWidthClasses[maxWidth]}`}
      >
        {children}
      </div>
    </div>
  );
}
