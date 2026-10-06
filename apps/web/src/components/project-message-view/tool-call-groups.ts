/**
 * Collapses consecutive tool-call activity into a single display row.
 *
 * A typical agent turn is text → 5–40 tool calls → text, so rendering every
 * call as its own full-width card buries the assistant's prose. This pass folds
 * a maximal run of generic tool calls (and any thinking blocks interleaved with
 * them) into one `tool_call_group` row that states the count; the per-call cards
 * are revealed on demand by `ToolCallGroupCard`.
 *
 * Pure and O(n): it runs inside the same `useMemo` as
 * `chatMessagesToConversationItems`, which rebuilds every item on every incoming
 * token, so it must not allocate more than the items it emits.
 */
import type {
  ConversationItem,
  ThinkingItem,
  ToolCallItem,
} from '@simple-agent-manager/acp-client';

import type { ChatMessageResponse } from '../../lib/api/sessions';
import { matchToolCard } from './tool-cards';
import { chatMessagesToConversationItems } from './types';

/** An item absorbed into a group: a generic tool call or an interleaved thinking block. */
export type GroupedItem = ToolCallItem | ThinkingItem;

export interface ToolCallGroupItem {
  kind: 'tool_call_group';
  /**
   * Id of the FIRST absorbed item. Stable as the group grows at the tail, so
   * the expanded/collapsed state and the jump-highlight target survive new
   * calls streaming in.
   */
  id: string;
  /** Chronological — the render order of the expanded body. */
  items: GroupedItem[];
  /** First item's timestamp, so `nearestItemId` anchoring keeps working. */
  timestamp: number;
}

/** What the virtualized chat list actually renders. */
export type DisplayItem = ConversationItem | ToolCallGroupItem;

export interface ToolCallGroupSummary {
  /** Tool calls only — thinking blocks are absorbed but never counted. */
  toolCallCount: number;
  runningCount: number;
  failedCount: number;
  completedCount: number;
  /** Title of the newest pending/in-progress call, when there is one. */
  liveTitle?: string;
  /** What the group is currently doing, or null when everything has settled. */
  liveKind: 'tool' | 'thinking' | null;
}

/**
 * Typed document cards (`display_from_library`, `upload_to_library`, …) are
 * user-facing content the agent deliberately chose to show, so they are NOT
 * absorbable and break the run (policy `bb0b7af1`).
 */
function isAbsorbable(item: DisplayItem): item is GroupedItem {
  if (item.kind === 'thinking') return true;
  if (item.kind === 'tool_call') return matchToolCard(item) === null;
  return false;
}

/**
 * Folds maximal runs of absorbable items into `tool_call_group` rows.
 *
 * A run that contains no tool call at all (thinking-only) is emitted unchanged:
 * grouping a lone "Thought" behind a "0 tool calls" card would be strictly worse
 * than the existing `ThinkingBlock`.
 */
export function groupToolCallItems(items: readonly ConversationItem[]): DisplayItem[] {
  const display: DisplayItem[] = [];
  let run: GroupedItem[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const first = run[0];
    if (first && run.some((item) => item.kind === 'tool_call')) {
      display.push({
        kind: 'tool_call_group',
        id: first.id,
        items: run,
        timestamp: first.timestamp,
      });
    } else {
      display.push(...run);
    }
    run = [];
  };

  for (const item of items) {
    if (isAbsorbable(item)) {
      run.push(item);
      continue;
    }
    flushRun();
    display.push(item);
  }
  flushRun();

  return display;
}

/**
 * Counts and live-state for a group's collapsed header.
 *
 * `liveTitle` tracks the NEWEST unfinished call because that is the one the user
 * wants to see while a run streams. An active thinking block at the tail wins
 * over it: Claude interleaves `think → tool → think → tool`, and the thing
 * happening right now is the thinking.
 */
export function summarizeToolCallGroup(group: ToolCallGroupItem): ToolCallGroupSummary {
  let toolCallCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let liveTitle: string | undefined;
  let liveKind: 'tool' | 'thinking' | null = null;

  for (const item of group.items) {
    if (item.kind !== 'tool_call') continue;
    toolCallCount++;
    if (item.status === 'failed') {
      failedCount++;
    } else if (item.status === 'completed') {
      completedCount++;
    } else {
      runningCount++;
      liveTitle = item.title;
      liveKind = 'tool';
    }
  }

  const newest = group.items[group.items.length - 1];
  if (newest?.kind === 'thinking' && newest.active) {
    liveKind = 'thinking';
    liveTitle = undefined;
  }

  return { toolCallCount, runningCount, failedCount, completedCount, liveTitle, liveKind };
}

/**
 * How many rows the virtualized list will render for `messages`.
 *
 * Virtuoso's `firstItemIndex` is the prepend anchor: when older history is
 * prepended it must be decreased by the number of rows added AT THE FRONT of the
 * data array, and that data array is the GROUPED one. Counting raw messages
 * over-counts badly — a page of 6 tool calls plus 3 assistant tokens is 9
 * messages but only 2 rows — and Virtuoso then shifts every existing row's
 * absolute index, which jumps the reader's scroll position on every "load
 * earlier". Conversely a page whose trailing tool call merges into the existing
 * first group adds no row at all, and the anchor must not move.
 *
 * Both chat surfaces call this, so the two cannot compute the anchor differently
 * (`.claude/rules/24`).
 *
 * COST: O(n) over the whole loaded history. Deliberately called only on PREPEND —
 * once per "load earlier" page — never on the streaming append path, which
 * already rebuilds the display array in its own memo.
 */
export function countDisplayRows(messages: readonly ChatMessageResponse[]): number {
  return groupToolCallItems(chatMessagesToConversationItems([...messages])).length;
}
