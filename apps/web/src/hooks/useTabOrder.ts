import { useState, useCallback, useRef } from 'react';

/**
 * Manages user-controllable tab ordering backed by localStorage.
 *
 * Tabs are assigned numeric sort positions. New tabs get the highest
 * position (rightmost). Reordering updates positions via array splice.
 * Stale IDs (tabs that no longer exist) are pruned on each getSortedTabs call.
 */

interface TabOrderState {
  /** Map of tab ID → sort position */
  positions: Record<string, number>;
  /** Next position counter (monotonically increasing) */
  nextPosition: number;
}

const STORAGE_KEY_PREFIX = 'sam-tab-order-';

function loadState(workspaceId: string): TabOrderState {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as TabOrderState;
      if (parsed && typeof parsed.nextPosition === 'number' && parsed.positions) {
        return parsed;
      }
    }
  } catch {
    // Corrupted data — start fresh
  }
  return { positions: {}, nextPosition: 0 };
}

function saveState(workspaceId: string, state: TabOrderState): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${workspaceId}`, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — silently fail
  }
}

export interface UseTabOrderReturn<T extends { id: string }> {
  /** Sort tabs by stored order. Unknown tabs are appended in their original order. */
  getSortedTabs: (tabs: T[]) => T[];
  /** Assign a sort position to a new tab (rightmost). */
  assignOrder: (tabId: string) => void;
  /** Reorder a tab from one index to another (in the sorted array). */
  reorderTab: (fromIndex: number, toIndex: number) => void;
  /** Remove a tab's stored position. */
  removeTab: (tabId: string) => void;
}

export function useTabOrder<T extends { id: string }>(
  workspaceId: string | undefined
): UseTabOrderReturn<T> {
  const [state, setState] = useState<TabOrderState>(() =>
    workspaceId ? loadState(workspaceId) : { positions: {}, nextPosition: 0 }
  );

  // Keep a ref so callbacks always see the latest state without re-creating
  const stateRef = useRef(state);
  stateRef.current = state;

  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const persist = useCallback((newState: TabOrderState) => {
    setState(newState);
    stateRef.current = newState;
    if (workspaceIdRef.current) {
      saveState(workspaceIdRef.current, newState);
    }
  }, []);

  const assignOrder = useCallback(
    (tabId: string) => {
      const current = stateRef.current;
      if (current.positions[tabId] !== undefined) return; // Already has a position
      const newState: TabOrderState = {
        positions: { ...current.positions, [tabId]: current.nextPosition },
        nextPosition: current.nextPosition + 1,
      };
      persist(newState);
    },
    [persist]
  );

  const removeTab = useCallback(
    (tabId: string) => {
      const current = stateRef.current;
      if (current.positions[tabId] === undefined) return;
      const rest = Object.fromEntries(
        Object.entries(current.positions).filter(([key]) => key !== tabId)
      );
      persist({ ...current, positions: rest });
    },
    [persist]
  );

  const getSortedTabs = useCallback(
    (tabs: T[]): T[] => {
      const current = stateRef.current;
      const knownIds = new Set(tabs.map((t) => t.id));

      // Auto-assign positions to any tabs that don't have one yet
      let needsUpdate = false;
      let { nextPosition } = current;
      const updatedPositions = { ...current.positions };

      for (const tab of tabs) {
        if (updatedPositions[tab.id] === undefined) {
          updatedPositions[tab.id] = nextPosition++;
          needsUpdate = true;
        }
      }

      // Prune stale IDs
      for (const id of Object.keys(updatedPositions)) {
        if (!knownIds.has(id)) {
          delete updatedPositions[id];
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        persist({ positions: updatedPositions, nextPosition });
      }

      return [...tabs].sort((a, b) => {
        const posA = updatedPositions[a.id] ?? Number.MAX_SAFE_INTEGER;
        const posB = updatedPositions[b.id] ?? Number.MAX_SAFE_INTEGER;
        return posA - posB;
      });
    },
    [persist]
  );

  const reorderTab = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;

      const current = stateRef.current;
      // Get entries sorted by position
      const entries = Object.entries(current.positions).sort(([, a], [, b]) => a - b);

      if (fromIndex < 0 || fromIndex >= entries.length || toIndex < 0 || toIndex >= entries.length) {
        return;
      }

      // Splice to reorder
      const [moved] = entries.splice(fromIndex, 1);
      if (!moved) return;
      entries.splice(toIndex, 0, moved);

      // Reassign positions sequentially
      const newPositions: Record<string, number> = {};
      entries.forEach(([id], idx) => {
        newPositions[id] = idx;
      });

      persist({ positions: newPositions, nextPosition: entries.length });
    },
    [persist]
  );

  return { getSortedTabs, assignOrder, reorderTab, removeTab };
}
