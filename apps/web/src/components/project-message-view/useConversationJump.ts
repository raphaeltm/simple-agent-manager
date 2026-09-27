import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { nearestItemId } from './timeline-jump';
import type { TimelineJumpTarget } from './timeline-types';
import type { DisplayItem, GroupedItem } from './tool-call-groups';

/**
 * Scroll attempts a jump into freshly loaded history makes before settling. Each
 * attempt waits two frames and checks the target row is on screen: Virtuoso
 * shifts the list to keep its rows in place when older pages arrive at the front,
 * and that shift can land after the scroll that was meant to follow it.
 */
const JUMP_SCROLL_ATTEMPTS = 8;
/** Consecutive checks the target row must stay on screen for the jump to count as landed. */
const JUMP_SETTLED_CHECKS = 2;

/** Whether the list row at 0-based `index` is rendered inside the list's visible area. */
function rowOnScreen(root: HTMLElement | null, index: number): boolean {
  const scroller = root?.querySelector('[data-sam-conversation-scroller="true"]');
  const row = scroller?.querySelector(`[data-index="${index}"]`);
  if (!scroller || !row) return false;
  const view = scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return box.bottom >= view.top && box.top <= view.bottom;
}

interface UseConversationJumpInput {
  sessionId: string;
  displayItems: DisplayItem[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  /** Contains the list's scroller, to confirm a jump's target row is on screen. */
  listRootRef: RefObject<HTMLElement | null>;
  /**
   * Whether the virtualized list is mounted. A chat's transcript can arrive a
   * render before the list does, and a jump resolved then would scroll nothing.
   */
  listReady: boolean;
  /** Pages older history in until the target message (or time) is loaded. */
  loadUntil: (target: TimelineJumpTarget) => Promise<void>;
  loadingMore: boolean;
  /** Message id requested by a route-level deep link, such as Project → Comments. */
  targetMessageId?: string | null;
  /** Timestamp used to load older history before resolving a route-level target. */
  targetMessageTimestamp?: number | null;
  /** Called once a route-level target has been consumed so refreshes do not re-jump. */
  onTargetMessageConsumed?: () => void;
  /** Runs at the start of every jump, before any scrolling. */
  onJump: () => void;
}

interface ConversationJump {
  /** Scroll to a message (or the message nearest a timestamp) and flash it. */
  jumpToMessage: (target: TimelineJumpTarget) => void;
  /** Id of the rendered row currently flashing, or null. */
  highlightedRowId: string | null;
}

/**
 * Jump-to-message for the virtualized conversation, shared by the timeline, the
 * comments rail and drawer, and route-level deep links.
 */
export function useConversationJump({
  sessionId,
  displayItems,
  virtuosoRef,
  listRootRef,
  listReady,
  loadUntil,
  loadingMore,
  targetMessageId,
  targetMessageTimestamp,
  onTargetMessageConsumed,
  onJump,
}: UseConversationJumpInput): ConversationJump {
  // Build item-id → 0-based data index map for jump-to-message from the timeline.
  // Includes EVERY conversation item so any timeline anchor resolves. The value is
  // the ZERO-BASED index into `displayItems` — Virtuoso's `scrollToIndex`
  // operates on the data-array coordinate, NOT the `firstItemIndex`-offset
  // absolute coordinate used for `itemContent`'s `index` arg. Passing the offset
  // value (VIRTUAL_START + i ≈ 100000) is out of range, so Virtuoso never scrolls
  // and the highlighted row stays virtualized-out → a dead click on real
  // (virtualized) sessions. jsdom renders all rows, which hid this locally.
  // Absorbed tool/thinking ids map to their GROUP's row index, so a timeline
  // jump to a tool message still lands on a row that exists.
  //
  // A merged tool call answers to MORE THAN ONE message id, and every one of them
  // can be a jump target (`.claude/rules/44` — enumerate every consumer of the
  // id). `chatMessagesToConversationItems` keeps the FIRST row's id as `item.id`
  // and repoints `messageId` at whichever row carries the content, so a
  // `tool_call_update` row id appears in neither place unless it is registered
  // explicitly. Deep links and MCP-created comment threads can anchor on exactly
  // that row, and an unresolvable anchor silently falls through to
  // `nearestItemId(…, Date.now())` — i.e. the bottom of the conversation.
  //
  // Aliases are registered in a second pass and never overwrite a real item id,
  // so a canonical row can't be shadowed by another row's alias.
  const itemIndexById = useMemo(() => {
    const map = new Map<string, number>();
    const aliases: Array<[string, number]> = [];

    const collect = (item: DisplayItem | GroupedItem, index: number) => {
      map.set(item.id, index);
      if (item.kind === 'tool_call' && item.messageId && item.messageId !== item.id) {
        aliases.push([item.messageId, index]);
      }
    };

    displayItems.forEach((item, i) => {
      collect(item, i);
      if (item.kind === 'tool_call_group') {
        for (const inner of item.items) collect(inner, i);
      }
    });
    for (const [alias, index] of aliases) {
      if (!map.has(alias)) map.set(alias, index);
    }
    return map;
  }, [displayItems]);

  // A jump targets either an exact message (user message, comment anchor) or the
  // nearest message to a timestamp (status/activity entries). A chat opens on its
  // newest page, so the target may predate the loaded window — we set a pending
  // jump and load older pages until the target is loaded, so a jump never
  // dead-clicks and never settles on the wrong message.
  const [pendingJump, setPendingJump] = useState<TimelineJumpTarget | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const consumedTargetMessageRef = useRef<string | null>(null);

  const scrollAndHighlight = useCallback(
    (itemId: string, behavior: 'smooth' | 'auto' = 'smooth'): boolean => {
      const index = itemIndexById.get(itemId);
      if (index === undefined) return false;
      virtuosoRef.current?.scrollToIndex({ index, behavior, align: 'center' });
      setHighlightedItemId(itemId);
      return true;
    },
    [itemIndexById, virtuosoRef]
  );

  const jumpToMessage = useCallback(
    (target: TimelineJumpTarget) => {
      onJump();
      // Fast path: exact message already loaded and on screen.
      if (listReady && target.messageId && itemIndexById.has(target.messageId)) {
        scrollAndHighlight(target.messageId);
        return;
      }
      // Otherwise resolve via the pending-jump effect, loading older pages until
      // the target is loaded first (no-op when the history is already loaded).
      setPendingJump(target);
      void loadUntil(target);
    },
    [itemIndexById, listReady, loadUntil, onJump, scrollAndHighlight]
  );

  // Route-driven jump from the project Comments page. This deliberately reuses
  // the same jump path as the timeline and session comments drawer so URL
  // deep-links inherit the existing virtualized-list coordinate fix and
  // fallback loading behavior.
  useEffect(() => {
    if (!targetMessageId) return;
    const targetKey = `${sessionId}:${targetMessageId}`;
    if (consumedTargetMessageRef.current === targetKey) return;
    consumedTargetMessageRef.current = targetKey;
    jumpToMessage({
      messageId: targetMessageId,
      timestamp: targetMessageTimestamp ?? Date.now(),
    });
    onTargetMessageConsumed?.();
  }, [jumpToMessage, onTargetMessageConsumed, sessionId, targetMessageId, targetMessageTimestamp]);

  // Resolve a pending jump once the target (or the nearest message, after
  // loading settles) is available in the rendered list. The target usually just
  // arrived with older pages, so the jump is instant and confirmed: it scrolls,
  // waits for the list to settle, and scrolls again until the row stays on screen.
  useEffect(() => {
    if (!pendingJump || !listReady) return;
    let targetId: string | undefined;
    if (pendingJump.messageId && itemIndexById.has(pendingJump.messageId)) {
      targetId = pendingJump.messageId;
    } else if (!loadingMore) {
      // No exact anchor, or the anchor never materialized after loading
      // settled → jump to the nearest loaded message by timestamp.
      targetId = nearestItemId(displayItems, pendingJump.timestamp);
    }
    const index = targetId === undefined ? undefined : itemIndexById.get(targetId);
    if (targetId === undefined || index === undefined) return;
    const id = targetId;

    let frame = 0;
    let attempts = 0;
    let onScreenChecks = 0;
    const afterTwoFrames = (step: () => void) => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(step);
      });
    };
    const check = () => {
      onScreenChecks = rowOnScreen(listRootRef.current, index) ? onScreenChecks + 1 : 0;
      if (onScreenChecks >= JUMP_SETTLED_CHECKS || attempts >= JUMP_SCROLL_ATTEMPTS) {
        setPendingJump(null);
        return;
      }
      if (onScreenChecks === 0) {
        attempts += 1;
        scrollAndHighlight(id, 'auto');
      }
      afterTwoFrames(check);
    };
    attempts += 1;
    scrollAndHighlight(id, 'auto');
    afterTwoFrames(check);
    return () => cancelAnimationFrame(frame);
  }, [
    pendingJump,
    listReady,
    itemIndexById,
    displayItems,
    loadingMore,
    listRootRef,
    scrollAndHighlight,
  ]);

  // Auto-clear the jump highlight after the flash animation. The 2200ms here is
  // coupled to the `.sam-message-highlight` animation-duration (2.2s) in index.css
  // — keep the two in sync. Re-jumping resets the timer via this effect's cleanup.
  useEffect(() => {
    if (!highlightedItemId) return;
    const timer = setTimeout(() => setHighlightedItemId(null), 2200);
    return () => clearTimeout(timer);
  }, [highlightedItemId]);

  // A jump can target an absorbed tool id, which resolves to its GROUP's row.
  // Resolve it to the row's own id (not an index): `itemContent`'s `index` is
  // Virtuoso's firstItemIndex-offset coordinate, so comparing indices here would
  // re-introduce the coordinate-space trap `itemIndexById` documents above.
  const highlightedRowId = useMemo(() => {
    if (highlightedItemId === null) return null;
    const index = itemIndexById.get(highlightedItemId);
    return index === undefined ? null : (displayItems[index]?.id ?? null);
  }, [highlightedItemId, itemIndexById, displayItems]);

  return { jumpToMessage, highlightedRowId };
}
