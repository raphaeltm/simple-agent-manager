import { useEffect, useRef } from 'react';
import type { UseTabShortcutsReturn, TabShortcutActions } from '../types/multi-terminal';

/**
 * Hook for handling keyboard shortcuts for terminal tabs
 * Supports standard browser/IDE shortcuts for tab management
 */
export function useTabShortcuts(): UseTabShortcutsReturn {
  const actionsRef = useRef<TabShortcutActions | null>(null);

  /**
   * Check if a keyboard event matches a shortcut pattern
   */
  const isShortcutPressed = (event: KeyboardEvent): boolean => {
    // Ctrl+Shift+T: New tab
    if (event.ctrlKey && event.shiftKey && event.key === 'T') {
      return true;
    }

    // Ctrl+Shift+W: Close tab
    if (event.ctrlKey && event.shiftKey && event.key === 'W') {
      return true;
    }

    // Ctrl+Tab: Next tab
    if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) {
      return true;
    }

    // Ctrl+Shift+Tab: Previous tab
    if (event.ctrlKey && event.shiftKey && event.key === 'Tab') {
      return true;
    }

    // Alt+[1-9]: Jump to specific tab
    if (event.altKey && event.key >= '1' && event.key <= '9') {
      return true;
    }

    return false;
  };

  /**
   * Register shortcut actions
   */
  const registerShortcuts = (actions: TabShortcutActions) => {
    actionsRef.current = actions;
  };

  /**
   * Unregister shortcut actions
   */
  const unregisterShortcuts = () => {
    actionsRef.current = null;
  };

  /**
   * Handle keyboard events
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const actions = actionsRef.current;
      if (!actions) return;

      // Check if this is inside a terminal (don't intercept terminal shortcuts)
      const target = event.target as HTMLElement;
      if (target.closest('.xterm')) {
        return;
      }

      // Ctrl+Shift+T: New tab
      if (event.ctrlKey && event.shiftKey && event.key === 't') {
        event.preventDefault();
        actions.onNewTab();
        return;
      }

      // Ctrl+Shift+W: Close tab
      if (event.ctrlKey && event.shiftKey && event.key === 'w') {
        event.preventDefault();
        actions.onCloseTab();
        return;
      }

      // Ctrl+Tab: Next tab (without Shift)
      if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        actions.onNextTab();
        return;
      }

      // Ctrl+Shift+Tab: Previous tab
      if (event.ctrlKey && event.shiftKey && event.key === 'Tab') {
        event.preventDefault();
        actions.onPreviousTab();
        return;
      }

      // Alt+[1-9]: Jump to specific tab
      if (event.altKey && event.key >= '1' && event.key <= '9') {
        event.preventDefault();
        const index = parseInt(event.key, 10) - 1;
        actions.onJumpToTab(index);
        return;
      }

      // macOS variants (Cmd instead of Ctrl)
      if (navigator.platform.includes('Mac')) {
        const isCmdKey = event.metaKey;

        // Cmd+T: New tab
        if (isCmdKey && event.key === 't' && !event.shiftKey) {
          event.preventDefault();
          actions.onNewTab();
          return;
        }

        // Cmd+W: Close tab
        if (isCmdKey && event.key === 'w' && !event.shiftKey) {
          event.preventDefault();
          actions.onCloseTab();
          return;
        }

        // Cmd+Shift+]: Next tab
        if (isCmdKey && event.shiftKey && event.key === ']') {
          event.preventDefault();
          actions.onNextTab();
          return;
        }

        // Cmd+Shift+[: Previous tab
        if (isCmdKey && event.shiftKey && event.key === '[') {
          event.preventDefault();
          actions.onPreviousTab();
          return;
        }

        // Cmd+[1-9]: Jump to specific tab
        if (isCmdKey && event.key >= '1' && event.key <= '9') {
          event.preventDefault();
          const index = parseInt(event.key, 10) - 1;
          actions.onJumpToTab(index);
          return;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return {
    registerShortcuts,
    unregisterShortcuts,
    isShortcutPressed,
  };
}