/**
 * The conversation around a comment, drawn by the chat's own item renderer, opened on the
 * commented words.
 *
 * On first render of the commented message it finds the quote as a DOM range, paints it, and
 * scrolls the words (not the whole message) to `quoteRatio` of the visible height. If the
 * words cannot be found it says so and shows the message from its top. Scrolling near either
 * edge loads more; loading earlier keeps the view still. A "Back to the comment" pill appears
 * whenever the words are off screen.
 */
import type { ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { Spinner } from '@simple-agent-manager/ui';
import { ArrowDown, ArrowUp, MessageSquareQuote } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import {
  boxPlacement,
  itemElement,
  quoteRange,
  type QuoteTarget,
  scrollBoxIntoView,
  targetBox,
  useQuoteHighlights,
} from './quote-highlight';

/** Distance from an edge, in px, at which a reader's own scroll loads more. */
const EDGE_LOAD_PX = 160;
/** Where a message lands when its quoted words cannot be found: its top, just below the edge. */
const MESSAGE_TOP_RATIO = 0.06;

export interface ReaderMarker {
  threadId: string;
  label: string;
  active: boolean;
}

interface ReaderConversationProps {
  projectId: string;
  items: DisplayItem[];
  /** Changes whenever the loaded rows change, so ranges are found again. */
  rowsKey: string;
  /** Id of the oldest loaded row; a change after "load earlier" means rows were prepended. */
  firstRowId: string | null;
  /** Rendered row the comment is on; null when its message is not loaded. */
  anchorItemId: string | null;
  quote: string | null;
  /** Other comments' words in loaded rows, painted faintly. */
  others: readonly QuoteTarget[];
  /** Rendered row id → the comments on it, as chips under the row. */
  markers: ReadonlyMap<string, ReaderMarker[]>;
  /** Changes when another comment is opened, which lands again. */
  landingKey: string;
  onSelectThread: (threadId: string) => void;
  onLoadToolContent: (messageId: string) => Promise<ToolCallContentItem[]>;
  hasEarlier: boolean;
  hasLater: boolean;
  loadingEarlier: boolean;
  loadingLater: boolean;
  loadEarlier: () => void;
  loadLater: () => void;
  /** Where the words land, as a fraction of the visible height. */
  quoteRatio: number;
  /** Pixels at the bottom covered by the phone thread sheet. */
  bottomInset: number;
}

function Edge({
  side,
  hasMore,
  loading,
  onLoad,
}: {
  side: 'earlier' | 'later';
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  if (loading) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-3 text-xs text-fg-muted"
        role="status"
      >
        <Spinner size="sm" />
        {side === 'earlier' ? 'Loading earlier messages…' : 'Loading later messages…'}
      </div>
    );
  }
  if (!hasMore) {
    return (
      <p className="m-0 px-4 py-3 text-center text-xs text-fg-muted">
        {side === 'earlier' ? 'Start of the chat' : 'Latest message'}
      </p>
    );
  }
  const Icon = side === 'earlier' ? ArrowUp : ArrowDown;
  return (
    <div className="flex justify-center px-4 py-2">
      <button
        type="button"
        onClick={onLoad}
        data-reader-edge={side}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border-default bg-surface px-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <Icon size={13} aria-hidden="true" />
        {side === 'earlier' ? 'Earlier messages' : 'Later messages'}
      </button>
    </div>
  );
}

/** Chips shown under one message before the rest fold into "+N more" (presentation only). */
const MARKERS_SHOWN = 3;

function CommentMarkers({
  markers,
  onSelect,
}: {
  markers: ReaderMarker[];
  onSelect: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // The open comment's chip first, so folding never hides it.
  const ordered = [...markers].sort((a, b) => Number(b.active) - Number(a.active));
  const shown = expanded ? ordered : ordered.slice(0, MARKERS_SHOWN);
  const folded = ordered.length - shown.length;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {shown.map((marker) => (
        <button
          key={marker.threadId}
          type="button"
          onClick={() => onSelect(marker.threadId)}
          aria-current={marker.active ? 'true' : undefined}
          className={`inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border px-2 text-xs transition-colors ${
            marker.active
              ? 'border-warning bg-warning-tint text-warning-fg'
              : 'border-border-default text-fg-muted hover:text-fg-primary'
          }`}
        >
          <MessageSquareQuote size={12} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{marker.label}</span>
        </button>
      ))}
      {folded > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex min-h-7 items-center rounded-full border border-border-default px-2 text-xs text-fg-muted transition-colors hover:text-fg-primary"
        >
          +{folded} more
        </button>
      )}
    </div>
  );
}

export function ReaderConversation({
  projectId,
  items,
  rowsKey,
  firstRowId,
  anchorItemId,
  quote,
  others,
  markers,
  landingKey,
  onSelectThread,
  onLoadToolContent,
  hasEarlier,
  hasLater,
  loadingEarlier,
  loadingLater,
  loadEarlier,
  loadLater,
  quoteRatio,
  bottomInset,
}: ReaderConversationProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<'above' | 'visible' | 'below'>('visible');
  const [quoteMissing, setQuoteMissing] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const pendingLanding = useRef(true);
  const userScrolled = useRef(false);
  const prependFromBottom = useRef<number | null>(null);
  const previousFirstRowId = useRef(firstRowId);
  /** What "the comment" is on screen: the quoted words, else the commented message. */
  const target = useRef<Range | HTMLElement | null>(null);
  const targetIsWords = useRef(false);

  const active = useMemo<QuoteTarget | null>(
    () => (anchorItemId ? { itemId: anchorItemId, quote } : null),
    [anchorItemId, quote]
  );
  useQuoteHighlights(scrollerRef, active, others, rowsKey);

  // Opening another comment lands again, and opens the tool-call group it is inside.
  useLayoutEffect(() => {
    pendingLanding.current = true;
    userScrolled.current = false;
    setQuoteMissing(false);
  }, [landingKey]);
  const anchorIsGroup = items.some(
    (item) => item.id === anchorItemId && item.kind === 'tool_call_group'
  );
  useEffect(() => {
    if (!anchorIsGroup || !anchorItemId) return;
    setExpandedGroups((current) =>
      current.has(anchorItemId) ? current : new Set([...current, anchorItemId])
    );
  }, [anchorIsGroup, anchorItemId]);

  // Keep the view still when older rows are added above it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const fromBottom = prependFromBottom.current;
    if (scroller && fromBottom !== null && firstRowId !== previousFirstRowId.current) {
      scroller.scrollTop = scroller.scrollHeight - fromBottom;
      prependFromBottom.current = null;
    }
    previousFirstRowId.current = firstRowId;
  }, [firstRowId]);
  useEffect(() => {
    if (!loadingEarlier) prependFromBottom.current = null;
  }, [loadingEarlier]);

  // Find the comment again whenever rows change, then land on it the first time it renders.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !anchorItemId) {
      target.current = null;
      return;
    }
    const range = quoteRange(scroller, { itemId: anchorItemId, quote });
    // Without the words, the whole commented row, so the notice above the message shows too.
    target.current =
      range ??
      scroller.querySelector<HTMLElement>('[data-reader-anchor="true"]') ??
      itemElement(scroller, anchorItemId);
    targetIsWords.current = range !== null;
    if (!pendingLanding.current || !target.current) return;
    pendingLanding.current = false;
    scrollBoxIntoView(
      scroller,
      targetBox(target.current),
      range ? quoteRatio : MESSAGE_TOP_RATIO,
      bottomInset
    );
    setQuoteMissing(Boolean(quote?.trim()) && range === null);
    setPlacement('visible');
  }, [anchorItemId, quote, quoteRatio, bottomInset, rowsKey, landingKey]);

  // The phone sheet is measured after the first landing; until the reader scrolls, follow it
  // so the words stay above the sheet rather than under it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !target.current || userScrolled.current || pendingLanding.current) return;
    scrollBoxIntoView(
      scroller,
      targetBox(target.current),
      targetIsWords.current ? quoteRatio : MESSAGE_TOP_RATIO,
      bottomInset
    );
  }, [bottomInset, quoteRatio]);

  const requestEarlier = useCallback(() => {
    if (!hasEarlier || loadingEarlier) return;
    const scroller = scrollerRef.current;
    if (scroller) prependFromBottom.current = scroller.scrollHeight - scroller.scrollTop;
    loadEarlier();
  }, [hasEarlier, loadEarlier, loadingEarlier]);
  const requestLater = useCallback(() => {
    if (hasLater && !loadingLater) loadLater();
  }, [hasLater, loadLater, loadingLater]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (target.current) {
      setPlacement(boxPlacement(scroller, targetBox(target.current), bottomInset));
    }
    // Only a person's scroll loads more; the programmatic landing does not.
    if (!userScrolled.current) return;
    if (scroller.scrollTop < EDGE_LOAD_PX) requestEarlier();
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (fromBottom < EDGE_LOAD_PX + bottomInset) requestLater();
  }, [bottomInset, requestEarlier, requestLater]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const mark = () => {
      userScrolled.current = true;
    };
    scroller.addEventListener('wheel', mark, { passive: true });
    scroller.addEventListener('touchmove', mark, { passive: true });
    scroller.addEventListener('keydown', mark);
    return () => {
      scroller.removeEventListener('wheel', mark);
      scroller.removeEventListener('touchmove', mark);
      scroller.removeEventListener('keydown', mark);
    };
  }, []);

  const backToComment = () => {
    const scroller = scrollerRef.current;
    if (!scroller || !target.current) return;
    scrollBoxIntoView(
      scroller,
      targetBox(target.current),
      targetIsWords.current ? quoteRatio : MESSAGE_TOP_RATIO,
      bottomInset
    );
    setPlacement('visible');
  };

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-reader-scroller=""
        role="region"
        aria-label="Conversation around the comment"
        // Native scroll anchoring is off so prepending behaves the same in every browser
        // (Safari has none): the effect above keeps the view still itself.
        className="relative h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
        style={{ paddingBottom: bottomInset }}
      >
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col pt-2 pb-6">
          <Edge
            side="earlier"
            hasMore={hasEarlier}
            loading={loadingEarlier}
            onLoad={requestEarlier}
          />
          {items.map((item) => {
            const isAnchor = item.id === anchorItemId;
            const itemMarkers = markers.get(item.id);
            return (
              <div
                key={item.id}
                className={`sam-message-entry min-w-0 px-4 pb-3 ${
                  isAnchor ? 'border-0 border-l-2 border-solid border-warning/70' : ''
                }`}
                data-reader-anchor={isAnchor ? 'true' : undefined}
              >
                {isAnchor && quoteMissing && (
                  <p className="m-0 mb-2 text-xs text-fg-muted" role="note">
                    The exact words of this comment are not in the message any more, so the whole
                    message is marked.
                  </p>
                )}
                <div data-reader-item={item.id}>
                  <AcpConversationItemView
                    item={item}
                    projectId={projectId}
                    onLoadToolContent={onLoadToolContent}
                    animateText={false}
                    animateUserMessage={false}
                    groupExpanded={
                      item.kind === 'tool_call_group' ? expandedGroups.has(item.id) : undefined
                    }
                    onToggleGroup={toggleGroup}
                  />
                </div>
                {itemMarkers && itemMarkers.length > 0 && (
                  <CommentMarkers markers={itemMarkers} onSelect={onSelectThread} />
                )}
              </div>
            );
          })}
          <Edge side="later" hasMore={hasLater} loading={loadingLater} onLoad={requestLater} />
        </div>
      </div>
      {placement !== 'visible' && anchorItemId && (
        <div
          className="pointer-events-none absolute inset-x-0 flex justify-center"
          style={placement === 'above' ? { top: 10 } : { bottom: bottomInset + 12 }}
        >
          <button
            type="button"
            onClick={backToComment}
            className="pointer-events-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border-default bg-surface px-3.5 text-sm font-medium text-fg-primary shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            {placement === 'above' ? (
              <ArrowUp size={14} aria-hidden="true" />
            ) : (
              <ArrowDown size={14} aria-hidden="true" />
            )}
            Back to the comment
          </button>
        </div>
      )}
    </div>
  );
}
