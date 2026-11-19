import { type RefObject, useCallback, useEffect } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Escape closes the wizard and Tab stays inside it (WCAG 2.1.2 / 2.4.3).
 *
 * Attached to `document` rather than as an `onKeyDown` prop because the overlay's role is
 * "dialog", a non-interactive role on which jsx-a11y rejects a keyboard handler; keydown
 * bubbles to `document` from anywhere the trap keeps focus, so the behaviour is the same.
 */
export function useWizardKeyboard({
  active,
  dialogRef,
  contentRef,
  onEscape,
}: {
  active: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onEscape: () => void;
}) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // A dialog opened from inside the wizard (the guided agent sign-in) owns the keyboard:
      // its Escape closes only itself, and it traps Tab. Dismissing here as well would throw
      // away the whole setup when the user only meant to back out of the sign-in.
      const nestedDialogOpen = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
        (el) => el !== dialogRef.current
      );
      if (nestedDialogOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null);
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      const focused = document.activeElement;
      if (e.shiftKey) {
        if (focused === first || focused === contentRef.current) {
          e.preventDefault();
          last.focus();
        }
      } else if (focused === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dialogRef, contentRef, onEscape]
  );

  useEffect(() => {
    if (!active) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, handleKeyDown]);
}
