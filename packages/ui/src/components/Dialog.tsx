import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
  /** Accessible label for dialogs without a visible labelled heading. */
  'aria-label'?: string;
  /** ID of the visible element that labels the dialog. */
  'aria-labelledby'?: string;
  /** ID of the element that describes the dialog. */
  'aria-describedby'?: string;
  /**
   * Optional sticky header content rendered above the scrollable body.
   * When provided, the header stays fixed while children scroll independently.
   */
  stickyHeader?: ReactNode;
}

const maxWidthClasses: Record<NonNullable<DialogProps['maxWidth']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Dialog({
  isOpen,
  onClose,
  children,
  maxWidth = 'md',
  stickyHeader,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
}: DialogProps) {
  const generatedLabelId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const labelledby = ariaLabelledby ?? (!ariaLabel ? generatedLabelId : undefined);


  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
      );

      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
        return;
      }

      if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      document.body.style.overflow = 'hidden';
      dialogRef.current?.focus();
    } else {
      document.body.style.overflow = '';
      previouslyFocusedElementRef.current?.focus();
      previouslyFocusedElementRef.current = null;
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-dialog-backdrop flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={labelledby}
      aria-describedby={ariaDescribedby}
    >
      {!ariaLabel && !ariaLabelledby && <span id={generatedLabelId} className="sr-only">Dialog</span>}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop overlay; keyboard dismiss handled by Escape listener above */}
      <div
        className="fixed inset-0 bg-overlay glass-backdrop-dim transition-opacity duration-150 ease-in-out"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`glass-panel-container glass-composited relative w-full max-h-[calc(100dvh-2rem)] flex flex-col rounded-lg glass-modal shadow-overlay ${maxWidthClasses[maxWidth]}`}
      >
        {stickyHeader && (
          <div className="flex-shrink-0">
            {stickyHeader}
          </div>
        )}
        <div className="overflow-y-auto p-6 flex-1">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
