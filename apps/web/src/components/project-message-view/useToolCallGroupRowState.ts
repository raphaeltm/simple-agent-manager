/**
 * Row-level state for tool-call activity cards, shared by both chat surfaces.
 *
 * `ProjectMessageView` and `WorkspaceChatView` each render the grouped display
 * array through their own virtualized list, and each needs the same three
 * answers per row: is this group expanded, what happens when it is toggled, and
 * is this row the live tail. Deriving that twice is how the two surfaces drifted
 * in the first place — the workspace view shipped uncontrolled and flickering
 * while project chat did not (`.claude/rules/24`).
 *
 * WHY THE WORKING SIGNAL IS A PARAMETER, AND WHAT IT MUST BE
 *
 * Callers pass `agentIsWorking`, and on both surfaces that value must come from
 * `useCompletionDockWorking` — anything `!== 'idle'`, plus a 1 s idle stabiliser.
 * NOT `isWorkingActivity`, which covers only `prompting`/`recovering`:
 *
 * - project chat's `onMessage` sets `responding` for every non-user row (every
 *   `tool_call` and `tool_call_update` included), so between "call A completed"
 *   and the next row a prompting-only predicate goes false and the glyph flashes
 *   settled — the exact per-call flicker `groupLive` exists to prevent;
 * - the workspace view reaches `responding` from any agent row and from the
 *   hydrated session-state snapshot, so the same reasoning applies for the whole
 *   of a streaming turn.
 *
 * It stays a parameter rather than a hook call in here because the two surfaces
 * hold `agentActivity` in different places (`useSessionLifecycle` vs local
 * state), and threading the derived boolean is cheaper than teaching this hook
 * about both.
 */
import { useCallback, useMemo } from 'react';

import type { DisplayItem } from './tool-call-groups';
import { isToolCallGroupExpanded, useToolCallGroupExpansion } from './useToolCallGroupExpansion';

export interface ToolCallGroupRowState {
  /** Whether the row for `groupId` renders expanded. */
  groupExpandedFor: (groupId: string) => boolean;
  /** Toggle handler for a group header. Stable for the surface's lifetime. */
  onToggleGroup: (groupId: string) => void;
  /** Whether the row for `itemId` is the live tail (agent mid-turn). */
  groupLiveFor: (itemId: string) => boolean;
}

/**
 * Identities change exactly when a row's answer can change — the expansion set,
 * the working flag, or which row is last — so a row renderer that lists the
 * returned object as a dependency keeps `AcpConversationItemView`'s memo honest
 * instead of rebuilding every windowed row on every parent render
 * (`.claude/rules/64`).
 */
export function useToolCallGroupRowState(
  displayItems: readonly DisplayItem[],
  agentIsWorking: boolean
): ToolCallGroupRowState {
  const expansion = useToolCallGroupExpansion();
  const { toggleGroup } = expansion;
  const lastDisplayId = displayItems[displayItems.length - 1]?.id ?? null;

  const groupExpandedFor = useCallback(
    (groupId: string) => isToolCallGroupExpanded(expansion, groupId),
    [expansion]
  );

  const groupLiveFor = useCallback(
    (itemId: string) => agentIsWorking && itemId === lastDisplayId,
    [agentIsWorking, lastDisplayId]
  );

  return useMemo(
    () => ({ groupExpandedFor, onToggleGroup: toggleGroup, groupLiveFor }),
    [groupExpandedFor, toggleGroup, groupLiveFor]
  );
}
