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
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--sam-color-bg-overlay)',
          zIndex: 'var(--sam-z-dialog-backdrop)' as unknown as number,
        }}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '90vw',
          maxWidth: 520,
          maxHeight: '80vh',
          backgroundColor: 'var(--sam-color-tn-surface)',
          border: '1px solid var(--sam-color-tn-border)',
          borderRadius: 12,
          boxShadow: 'var(--sam-shadow-overlay)',
          zIndex: 'var(--sam-z-dialog)' as unknown as number,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--sam-color-tn-border)',
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--sam-type-card-title-size)',
              fontWeight: 600,
              color: 'var(--sam-color-tn-fg)',
            }}
          >
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--sam-color-tn-fg-muted)',
              cursor: 'pointer',
              fontSize: 18,
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Shortcut list */}
        <div style={{ overflow: 'auto', padding: '12px 20px 20px' }}>
          {CATEGORY_ORDER.map((category) => {
            const shortcuts = grouped.get(category);
            if (!shortcuts) return null;
            const visible = shortcuts.filter(shouldShowShortcut);
            if (visible.length === 0) return null;

            return (
              <div key={category} style={{ marginBottom: 20 }}>
                <h3
                  style={{
                    margin: '0 0 8px',
                    fontSize: 'var(--sam-type-caption-size)',
                    fontWeight: 600,
                    color: 'var(--sam-color-tn-fg-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {category}
                </h3>
                {visible.map((shortcut) => (
                  <div
                    key={shortcut.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 0',
                    }}
                  >
                    <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-tn-fg)' }}>
                      {shortcut.id === 'tab-1'
                        ? 'Switch to tab 1\u20139'
                        : shortcut.description}
                    </span>
                    <kbd
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 'var(--sam-type-caption-size)',
                        color: 'var(--sam-color-tn-fg-bright)',
                        backgroundColor: 'var(--sam-color-tn-selected)',
                        border: '1px solid var(--sam-color-tn-border-highlight)',
                        borderRadius: 4,
                        padding: '2px 8px',
                        whiteSpace: 'nowrap',
                      }}
                    >
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
