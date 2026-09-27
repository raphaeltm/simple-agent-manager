import { ChevronDown } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TouchEvent,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { CHAT_LIST_COMPONENTS, type ChatListContext } from './MessageListScaffold';
import type { DisplayItem } from './tool-call-groups';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';

interface ConversationPaneProps {
  lc: UseSessionLifecycleResult;
  displayItems: DisplayItem[];
  /** The floating session header, laid over the top of the pane. */
  header: ReactNode;
  headerHeight: number;
  chatLogRef: RefObject<HTMLDivElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  renderItem: (index: number, item: DisplayItem) => ReactNode;
  listContext: ChatListContext;
  /** Selected-text comment controls, positioned over the conversation. */
  selectionControls: ReactNode;
  /** Docked desktop comments rail, beside the conversation. */
  commentRail: ReactNode;
  /** Session tool rail on the pane's right edge. */
  toolRail: ReactNode;
}

/** Keys that scroll a focused conversation toward older messages. */
const SCROLL_UP_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home']);
/** Finger travel toward the bottom of the screen that counts as swiping back through history. */
const SWIPE_UP_THRESHOLD_PX = 10;

/**
 * Whether the reader has scrolled toward older messages in this chat: a wheel or
 * trackpad scroll up, a swipe down, or a key that scrolls up. Only the reader's
 * own input counts — the list's position does not, because a chat can open away
 * from the bottom when its newest message is taller than the screen.
 */
function useReaderScrolledUp() {
  const [scrolledUp, setScrolledUp] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const handlers = useMemo(
    () => ({
      onWheel: (event: WheelEvent<HTMLDivElement>) => {
        if (event.deltaY < 0) setScrolledUp(true);
      },
      onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
        touchStartY.current = event.touches[0]?.clientY ?? null;
      },
      onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
        const startY = touchStartY.current;
        const y = event.touches[0]?.clientY;
        if (startY !== null && y !== undefined && y - startY > SWIPE_UP_THRESHOLD_PX) {
          setScrolledUp(true);
        }
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (SCROLL_UP_KEYS.has(event.key)) setScrolledUp(true);
      },
    }),
    []
  );
  return [scrolledUp, handlers] as const;
}

/** The conversation itself — virtualized, DO-only — or its empty state. */
export function ConversationPane({
  lc,
  displayItems,
  header,
  headerHeight,
  chatLogRef,
  virtuosoRef,
  renderItem,
  listContext,
  selectionControls,
  commentRail,
  toolRail,
}: Readonly<ConversationPaneProps>) {
  const [readerScrolledUp, scrollIntentHandlers] = useReaderScrolledUp();

  if (displayItems.length === 0) {
    return (
      <div className="relative flex flex-1 min-h-0 min-w-0 flex-row">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {header}
            <div
              className="flex flex-1 items-center justify-center"
              style={{ paddingTop: headerHeight }}
            >
              <span className="text-fg-muted text-sm">
                {lc.sessionState === 'active'
                  ? 'Waiting for messages...'
                  : 'No messages in this session.'}
              </span>
            </div>
          </div>
          {commentRail}
        </div>
        {toolRail}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 min-w-0 relative flex flex-row">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <div
          ref={chatLogRef}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          {...scrollIntentHandlers}
        >
          {header}
          <div className="flex-1 min-h-0">
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: '100%' }}
              data={displayItems}
              firstItemIndex={lc.firstItemIndex}
              initialTopMostItemIndex={displayItems.length - 1}
              followOutput={(isAtBottom: boolean) => (isAtBottom ? 'smooth' : false)}
              alignToBottom
              atBottomThreshold={50}
              atBottomStateChange={(atBottom) => lc.setShowScrollButton(!atBottom)}
              // A chat opens on its newest page; scrolling up to the top pages older
              // history in (the list header's "Load earlier messages" button stays
              // as the visible and keyboard path to the same load). Only once the
              // reader has scrolled up: Virtuoso reports the top as reached
              // whenever the first row is rendered, and a page of tool calls can
              // fold into a few rows that fit on screen, so opening such a chat
              // would otherwise page its whole history in unasked.
              startReached={lc.hasMore && readerScrolledUp ? lc.loadMore : undefined}
              overscan={200}
              itemContent={renderItem}
              context={listContext}
              components={CHAT_LIST_COMPONENTS}
            />
          </div>

          {/* Scroll to bottom button */}
          {lc.showScrollButton && (
            <button
              type="button"
              onClick={() => {
                virtuosoRef.current?.scrollToIndex({
                  index: 'LAST',
                  behavior: 'smooth',
                });
              }}
              className="sam-scroll-button absolute right-4 z-10 flex items-center justify-center w-11 h-11 rounded-full border border-[var(--sam-form-border)] bg-[var(--sam-form-bg)] shadow-md cursor-pointer hover:bg-page"
              data-agent-active={lc.agentActivity !== 'idle'}
              aria-label="Scroll to bottom"
            >
              <ChevronDown size={16} className="text-fg-muted" />
            </button>
          )}

          {selectionControls}
        </div>
        {commentRail}
      </div>
      {toolRail}
    </div>
  );
}
