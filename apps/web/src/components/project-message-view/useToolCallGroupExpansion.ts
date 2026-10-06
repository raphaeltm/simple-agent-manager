/**
 * Parent-held expansion state for tool-call activity groups.
 *
 * Virtuoso unmounts rows outside its overscan window, so a group that owned its
 * own `useState` would silently collapse as soon as the user scrolled away and
 * back. The state therefore lives in `ProjectMessageView` (same shape as the
 * comment row state) and each row receives a plain boolean.
 *
 * `?tools=expanded` seeds every group expanded — a developer/debugging escape
 * hatch with no settings UI. The stored set records DEVIATIONS from that default
 * rather than "expanded ids", so the seeded state stays collapsible.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

/** Query parameter and value that seed every group expanded. */
export const TOOLS_EXPANDED_PARAM = 'tools';
export const TOOLS_EXPANDED_VALUE = 'expanded';

const NO_OVERRIDES: ReadonlySet<string> = new Set<string>();

export interface ToolCallGroupExpansion {
  /** Group ids whose state differs from `defaultExpanded`. */
  overrides: ReadonlySet<string>;
  /** Seeded from `?tools=expanded`. */
  defaultExpanded: boolean;
  /** Stable across renders — safe as a memoized row prop (`.claude/rules/64`). */
  toggleGroup: (groupId: string) => void;
}

/** Pure per-row read. Kept out of the hook so row renderers can call it freely. */
export function isToolCallGroupExpanded(
  expansion: ToolCallGroupExpansion,
  groupId: string
): boolean {
  const overridden = expansion.overrides.has(groupId);
  return expansion.defaultExpanded ? !overridden : overridden;
}

export function useToolCallGroupExpansion(): ToolCallGroupExpansion {
  const [searchParams] = useSearchParams();
  const defaultExpanded = searchParams.get(TOOLS_EXPANDED_PARAM) === TOOLS_EXPANDED_VALUE;
  const [overrides, setOverrides] = useState<ReadonlySet<string>>(NO_OVERRIDES);

  const toggleGroup = useCallback((groupId: string) => {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  }, []);

  return useMemo(
    () => ({ overrides, defaultExpanded, toggleGroup }),
    [overrides, defaultExpanded, toggleGroup]
  );
}
