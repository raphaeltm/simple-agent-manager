import { type RefObject, useEffect, useRef } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface HiddenSiblingState {
  element: HTMLElement;
  ariaHidden: string | null;
  inert: boolean;
}

interface UseModalInteractionOptions {
  enabled: boolean;
  modalRef: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  restoreFocus?: boolean;
  lockScroll?: boolean;
  isolateBackground?: boolean;
}

function isFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[aria-hidden="true"], [inert]')) return false;
  return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(isFocusable);
}

function getModalRoot(modal: HTMLElement): HTMLElement {
  return modal.closest<HTMLElement>('[data-sam-modal-root]') ?? modal;
}

function hideBackgroundSiblings(modal: HTMLElement): HiddenSiblingState[] {
  const modalRoot = getModalRoot(modal);
  const siblings = Array.from(document.body.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot,
  );

  return siblings.map((element) => {
    const state = {
      element,
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element.inert,
    };
    element.setAttribute('aria-hidden', 'true');
    element.inert = true;
    return state;
  });
}

function restoreBackgroundSiblings(states: HiddenSiblingState[]): void {
  states.forEach(({ element, ariaHidden, inert }) => {
    if (ariaHidden === null) {
      element.removeAttribute('aria-hidden');
    } else {
      element.setAttribute('aria-hidden', ariaHidden);
    }
    element.inert = inert;
  });
}

export function useModalInteraction({
  enabled,
  modalRef,
  onEscape,
  restoreFocus = true,
  lockScroll = true,
  isolateBackground = true,
}: UseModalInteractionOptions): void {
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const modal = modalRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    const hiddenSiblingStates = modal && isolateBackground ? hideBackgroundSiblings(modal) : [];

    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    if (lockScroll) {
      document.body.style.overflow = 'hidden';
    }

    modal?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscape?.();
        return;
      }

      if (event.key !== 'Tab') return;

      const currentModal = modalRef.current;
      if (!currentModal) return;

      const focusable = getFocusableElements(currentModal);

      if (focusable.length === 0) {
        event.preventDefault();
        currentModal.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      const active = document.activeElement;
      const activeIsInside = active instanceof Node && currentModal.contains(active);

      if (event.shiftKey && (active === first || active === currentModal || !activeIsInside)) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && (active === last || active === currentModal || !activeIsInside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (lockScroll) {
        document.body.style.overflow = previousBodyOverflow;
      }
      restoreBackgroundSiblings(hiddenSiblingStates);

      const previouslyFocused = previouslyFocusedElementRef.current;
      if (restoreFocus && previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
      previouslyFocusedElementRef.current = null;
    };
  }, [enabled, isolateBackground, lockScroll, modalRef, onEscape, restoreFocus]);
}
