import { useEffect, useRef } from 'react';
import { SHORTCUTS, matchesShortcut } from '../lib/keyboard-shortcuts';

export interface ShortcutHandlers {
  [shortcutId: string]: () => void;
}

/**
 * Registers global keyboard shortcuts on `window`.
 *
 * @param handlers — Map of shortcut ID to callback. Only IDs present in the
 *   SHORTCUTS registry are matched. Missing IDs are silently ignored.
 * @param enabled — When false, all shortcuts are suppressed.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled: boolean): void {
  // Keep a stable ref to handlers so the event listener doesn't need re-registration
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;

      // Skip if the user is typing in a regular input/textarea WITHOUT a
      // modifier key. Shortcuts with Cmd/Ctrl modifiers should still fire
      // even when focused on an input.
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (isTextInput && !e.metaKey && !e.ctrlKey) {
        return;
      }

      // Try to match against registered shortcuts
      for (const shortcut of SHORTCUTS) {
        if (!matchesShortcut(e, shortcut)) continue;

        const handler = handlersRef.current[shortcut.id];
        if (!handler) continue;

        e.preventDefault();
        e.stopPropagation();
        handler();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}
