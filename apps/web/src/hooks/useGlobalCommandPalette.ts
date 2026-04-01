import { useCallback,useEffect, useState } from 'react';

/**
 * Hook to manage the global command palette open/close state.
 *
 * Listens for Cmd+K (macOS) / Ctrl+K (other) on the window and toggles
 * the palette. The listener uses capture phase so it fires before other
 * handlers, but only prevents default when the palette is being opened.
 */
export function useGlobalCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  useEffect(() => {
    const isMac =
      typeof navigator !== 'undefined' &&
      /mac/i.test(navigator.platform ?? navigator.userAgent ?? '');

    const handleKeyDown = (e: KeyboardEvent) => {
      // Match Cmd+K (mac) or Ctrl+K (other)
      const modifierPressed = isMac ? e.metaKey : e.ctrlKey;
      if (modifierPressed && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  return { isOpen, open, close, toggle };
}
