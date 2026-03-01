import { useEffect } from 'react';
import { getShortcutsByCategory, formatShortcut } from '../lib/keyboard-shortcuts';
import type { ShortcutDefinition } from '../lib/keyboard-shortcuts';

interface KeyboardShortcutsHelpProps {
  onClose: () => void;
}

const CATEGORY_ORDER = ['Navigation', 'Tabs', 'Sessions', 'General'];

/** Filter out tab-2 through tab-9 to keep the help overlay concise. */
function shouldShowShortcut(s: ShortcutDefinition): boolean {
  // Show tab-1 as representative, collapse 2-9 into a summary
  if (/^tab-[2-9]$/.test(s.id)) return false;
  return true;
}

/**
 * Full-screen overlay showing all registered keyboard shortcuts,
 * grouped by category. Follows the existing overlay pattern
 * (GitChangesPanel, FileBrowserPanel).
 */
export function KeyboardShortcutsHelp({ onClose }: KeyboardShortcutsHelpProps) {
  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const grouped = getShortcutsByCategory();

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-dialog-backdrop"
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90vw] max-w-[520px] max-h-[80vh] bg-tn-surface border border-tn-border rounded-xl shadow-overlay z-dialog flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-tn-border shrink-0">
          <h2 className="m-0 text-base font-semibold text-tn-fg">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="bg-transparent border-none text-tn-fg-muted cursor-pointer text-lg px-2 py-1 leading-none"
          >
            ×
          </button>
        </div>

        {/* Shortcut list */}
        <div className="overflow-auto px-5 pt-3 pb-5">
          {CATEGORY_ORDER.map((category) => {
            const shortcuts = grouped.get(category);
            if (!shortcuts) return null;
            const visible = shortcuts.filter(shouldShowShortcut);
            if (visible.length === 0) return null;

            return (
              <div key={category} className="mb-5">
                <h3 className="m-0 mb-2 text-xs font-semibold text-tn-fg-muted uppercase tracking-wider">
                  {category}
                </h3>
                {visible.map((shortcut) => (
                  <div
                    key={shortcut.id}
                    className="flex justify-between items-center py-1.5"
                  >
                    <span className="text-xs text-tn-fg">
                      {shortcut.id === 'tab-1'
                        ? 'Switch to tab 1\u20139'
                        : shortcut.description}
                    </span>
                    <kbd className="font-mono text-xs text-tn-fg-bright bg-tn-selected border border-tn-border-highlight rounded-sm px-2 py-0.5 whitespace-nowrap">
                      {shortcut.id === 'tab-1'
                        ? formatShortcut(shortcut).replace('1', '1\u20139')
                        : formatShortcut(shortcut)}
                    </kbd>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
