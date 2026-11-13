import { type RefObject, useCallback, useState } from 'react';

import type { UiCommentThread } from './comment-utils';
import { type QuoteItemKey, type QuoteTarget, useQuoteHighlights } from './quote-highlight';
import { threadToOpen, useQuoteHighlightClicks } from './quote-highlight-clicks';

/** What a thread needs to be painted: message threads and library-file threads both fit. */
export type HighlightableThread = Pick<UiCommentThread, 'id' | 'status' | 'createdAt' | 'anchor'>;

/**
 * Statuses painted by default: every comment still open, including one sent to the agent. A
 * resolved comment is painted only while it is the one being shown. A new status is not
 * painted until it is added here on purpose.
 */
export const DEFAULT_PAINTED_STATUSES: ReadonlySet<HighlightableThread['status']> = new Set([
  'open',
  'sent',
]);

/** Painted words are found in the surface's `[data-comment-anchor]` elements. */
const COMMENT_ANCHOR_KEY: QuoteItemKey = 'commentAnchor';

interface PaintTargets {
  /** Identifies the content below; equal keys mean equal targets. */
  key: string;
  active: QuoteTarget | null;
  others: QuoteTarget[];
}

/** Open threads with a quote, and the active thread whatever its status. */
function paintTargets<T extends HighlightableThread>(
  threads: readonly T[],
  itemIdOf: (thread: T) => string,
  activeId: string | null,
  enabled: boolean
): PaintTargets {
  let active: QuoteTarget | null = null;
  const others: QuoteTarget[] = [];
  if (enabled) {
    for (const thread of threads) {
      const quote = thread.anchor.quote;
      if (!quote || (!DEFAULT_PAINTED_STATUSES.has(thread.status) && thread.id !== activeId)) {
        continue;
      }
      const target = { itemId: itemIdOf(thread), quote, threadId: thread.id };
      if (thread.id === activeId) active = target;
      else others.push(target);
    }
  }
  const describe = (t: QuoteTarget) => [t.threadId, t.itemId, t.quote];
  return {
    key: JSON.stringify([active && describe(active), others.map(describe)]),
    active,
    others,
  };
}

/**
 * Paint comment quotes on a surface (the project chat, a library markdown file), and open a
 * comment when its words are clicked.
 *
 * - Open threads with a quote are painted faintly by default; resolved ones are not.
 * - `activeThreadId`, the thread being shown, is painted strongly, resolved or not.
 * - When `revealKey` changes, the active words are brought on screen as the surface settles.
 * - A click on painted words calls `onOpenThread` with the newest open thread under it.
 *
 * Quotes are found inside `[data-comment-anchor]` elements, whose value `itemIdOf` gives for
 * each thread. Ranges are found again whenever the container's DOM changes, so a virtualized
 * list or late-loading content repaints without being told.
 */
export function useCommentQuoteHighlights<T extends HighlightableThread>({
  containerRef,
  threads,
  itemIdOf,
  activeThreadId,
  revealKey,
  enabled = true,
  onOpenThread,
}: {
  containerRef: RefObject<HTMLElement | null>;
  threads: readonly T[];
  itemIdOf: (thread: T) => string;
  activeThreadId: string | null;
  revealKey: string | null;
  /** False paints nothing, e.g. while the surface shows source rather than rendered text. */
  enabled?: boolean;
  onOpenThread: (thread: T) => void;
}): void {
  // Thread lists are rebuilt on every refetch and realtime event. The targets are kept while
  // what is painted stays the same, so the highlighter does not search again for nothing
  // (React's "adjust state while rendering": the update re-renders before any commit).
  const next = paintTargets(threads, itemIdOf, enabled ? activeThreadId : null, enabled);
  const [painted, setPainted] = useState(next);
  if (painted.key !== next.key) setPainted(next);
  const { active, others } = painted.key === next.key ? painted : next;

  const paintedRef = useQuoteHighlights(containerRef, active, others, '', {
    itemKey: COMMENT_ANCHOR_KEY,
    observeMutations: true,
    revealKey,
  });

  const openClicked = useCallback(
    (targets: QuoteTarget[]) => {
      const threadIds = targets.flatMap((target) => (target.threadId ? [target.threadId] : []));
      const thread = threadToOpen(threadIds, threads, enabled ? activeThreadId : null);
      if (thread) onOpenThread(thread);
    },
    [activeThreadId, enabled, onOpenThread, threads]
  );
  useQuoteHighlightClicks(containerRef, paintedRef, openClicked, enabled);
}
