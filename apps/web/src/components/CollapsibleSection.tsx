import { useState, useEffect, useCallback, type ReactNode, type FC } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleSectionProps {
  /** Section title displayed in the header */
  title: string;
  /** Optional count badge shown next to the title */
  badge?: number | string;
  /** Whether the section starts collapsed. Overridden by persisted state if storageKey is set. */
  defaultCollapsed?: boolean;
  /** localStorage key for persisting collapse state. Omit to disable persistence. */
  storageKey?: string;
  /** Children rendered inside the collapsible body */
  children: ReactNode;
}

/**
 * Collapsible accordion section for the workspace sidebar.
 * Chevron rotates on expand/collapse. State optionally persisted to localStorage.
 */
export const CollapsibleSection: FC<CollapsibleSectionProps> = ({
  title,
  badge,
  defaultCollapsed = false,
  storageKey,
  children,
}) => {
  const [collapsed, setCollapsed] = useState(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored !== null) return stored === 'true';
      } catch {
        // localStorage unavailable
      }
    }
    return defaultCollapsed;
  });

  // Persist collapse state
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(collapsed));
    } catch {
      // localStorage unavailable
    }
  }, [collapsed, storageKey]);

  const toggle = useCallback(() => setCollapsed((prev) => !prev), []);

  return (
    <div
      style={{
        borderBottom: '1px solid var(--sam-color-border-default)',
      }}
    >
      <button
        onClick={toggle}
        aria-expanded={!collapsed}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '8px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sam-color-fg-primary)',
          fontSize: 'var(--sam-type-caption-size)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          textAlign: 'left',
        }}
      >
        <ChevronDown
          size={14}
          style={{
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            flexShrink: 0,
            color: 'var(--sam-color-fg-muted)',
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
        {badge !== undefined && badge !== 0 && (
          <span
            style={{
              fontSize: 'var(--sam-type-caption-size)',
              fontWeight: 500,
              color: 'var(--sam-color-fg-muted)',
              backgroundColor: 'rgba(120, 124, 153, 0.15)',
              borderRadius: 9,
              padding: '1px 6px',
              lineHeight: '1.3',
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            {badge}
          </span>
        )}
      </button>
      {!collapsed && (
        <div style={{ padding: '0 12px 10px 12px' }}>
          {children}
        </div>
      )}
    </div>
  );
};
