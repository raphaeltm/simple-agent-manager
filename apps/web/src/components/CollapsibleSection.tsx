import { ChevronDown } from 'lucide-react';
import { type FC,type ReactNode, useCallback, useEffect, useState } from 'react';

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
    <div className="border-b border-border-default">
      <button
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1.5 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-fg-primary text-xs font-semibold uppercase tracking-wide text-left"
      >
        <ChevronDown
          size={14}
          className="shrink-0 text-fg-muted transition-transform duration-150 ease-in-out"
          style={{
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}
        />
        <span className="flex-1 min-w-0">{title}</span>
        {badge !== undefined && badge !== 0 && (
          <span
            className="text-xs font-medium text-fg-muted rounded-full leading-tight normal-case tracking-normal"
            style={{
              backgroundColor: 'rgba(120, 124, 153, 0.15)',
              padding: '1px 6px',
            }}
          >
            {badge}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="px-3 pb-2.5">
          {children}
        </div>
      )}
    </div>
  );
};
