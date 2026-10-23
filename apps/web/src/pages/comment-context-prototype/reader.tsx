/**
 * The anchored reader shared by directions A and B: a scrollable window of the chat that opens
 * with the commented passage highlighted at about a third of the height, loads earlier and
 * later messages around it, and offers a way back to the passage after scrolling away.
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import type { ChatSession, ContextThread } from './mock-session';
import {
  activeRange,
  type QuoteSpec,
  rangePlacement,
  scrollRangeIntoView,
  useQuoteHighlights,
} from './quote-highlight';
import { Transcript } from './transcript';

const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 3;
const LOAD_STEP = 4;
/** Distance from an edge, in px, that loads more once the reader has been scrolled by hand. */
const EDGE_LOAD_PX = 120;

function initialWindow(session: ChatSession, anchorId: string) {
  const index = Math.max(
    0,
    session.items.findIndex((item) => item.id === anchorId)
  );
  return {
    sessionId: session.id,
    start: Math.max(0, index - WINDOW_BEFORE),
    end: Math.min(session.items.length, index + WINDOW_AFTER + 1),
  };
}

/** Where the session's comments sit, as dots on a thin track; the loaded window is shaded. */
function PositionTrack({
  session,
  threads,
  activeThreadId,
  start,
  end,
  onSelect,
}: {
  session: ChatSession;
  threads: ContextThread[];
  activeThreadId: string;
  start: number;
  end: number;
  onSelect: (id: string) => void;
}) {
  const total = Math.max(1, session.items.length);
  return (
    <div
      aria-label="Where this is in the chat"
      className="pointer-events-none absolute inset-y-4 right-1.5 w-3"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-default" />
      <div
        className="absolute left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-[color-mix(in_srgb,var(--sam-color-fg-muted)_35%,transparent)]"
        style={{ top: `${(start / total) * 100}%`, height: `${((end - start) / total) * 100}%` }}
      />
      {threads.map((thread) => {
        const index = session.items.findIndex((item) => item.id === thread.anchorId);
        const active = thread.id === activeThreadId;
        return (
          <button
            key={thread.id}
            type="button"
            aria-label={`Comment by ${thread.entries[0]?.author.name ?? 'someone'}`}
            onClick={() => onSelect(thread.id)}
            className={`pointer-events-auto absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
              active ? 'h-3 w-3 ring-2 ring-[var(--sam-color-bg-canvas)]' : 'h-2 w-2'
            }`}
            style={{
              top: `${((index + 0.5) / total) * 100}%`,
              background: active ? 'var(--sam-color-warning)' : 'var(--sam-color-info)',
            }}
          />
        );
      })}
    </div>
  );
}

export function AnchoredReader({
  session,
  threads,
  activeThread,
  onSelectThread,
  renderAfter,
  showTrack = false,
  quoteRatio = 0.32,
  footerSpace = 0,
  hideActiveMarker = false,
  renderAnchor,
}: {
  session: ChatSession;
  /** Threads in this session. */
  threads: ContextThread[];
  activeThread: ContextThread;
  onSelectThread: (id: string) => void;
  renderAfter?: (item: DisplayItem) => ReactNode;
  showTrack?: boolean;
  /** Where the passage lands, as a fraction of the reader's height. */
  quoteRatio?: number;
  /** Space kept clear at the bottom (a sheet or pinned composer covers it). */
  footerSpace?: number;
  hideActiveMarker?: boolean;
  renderAnchor?: (item: DisplayItem) => ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(() => initialWindow(session, activeThread.anchorId));
  const [placement, setPlacement] = useState<'above' | 'visible' | 'below'>('visible');
  const prependFrom = useRef<number | null>(null);
  const userScrolled = useRef(false);

  const specs = useMemo<QuoteSpec[]>(
    () =>
      threads.map((thread) => ({
        itemId: thread.anchorId,
        quote: thread.quote,
        active: thread.id === activeThread.id,
      })),
    [threads, activeThread.id]
  );
  useQuoteHighlights(scrollerRef, specs, `${session.id}:${view.start}:${view.end}`);

  // A different comment (or chat): make sure its message is loaded…
  const pendingLanding = useRef(true);
  useLayoutEffect(() => {
    pendingLanding.current = true;
    const index = session.items.findIndex((item) => item.id === activeThread.anchorId);
    setView((current) =>
      current.sessionId === session.id && index >= current.start && index < current.end
        ? current
        : initialWindow(session, activeThread.anchorId)
    );
  }, [session, activeThread.anchorId, activeThread.id]);

  // …then land on its passage once it is rendered.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!pendingLanding.current || !scroller) return;
    const range = activeRange(scroller, specs);
    if (!range) return;
    pendingLanding.current = false;
    userScrolled.current = false;
    scrollRangeIntoView(scroller, range, quoteRatio);
    setPlacement('visible');
  }, [specs, view, quoteRatio]);

  // Keep the reader still while older messages are added above it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || prependFrom.current === null) return;
    scroller.scrollTop = scroller.scrollHeight - prependFrom.current;
    prependFrom.current = null;
  }, [view.start]);

  const loadEarlier = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) prependFrom.current = scroller.scrollHeight - scroller.scrollTop;
    setView((current) => ({ ...current, start: Math.max(0, current.start - LOAD_STEP) }));
  }, []);
  const loadLater = useCallback(() => {
    setView((current) => ({
      ...current,
      end: Math.min(session.items.length, current.end + LOAD_STEP),
    }));
  }, [session.items.length]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const range = activeRange(scroller, specs);
    if (range) setPlacement(rangePlacement(scroller, range));
    if (!userScrolled.current) return;
    if (scroller.scrollTop < EDGE_LOAD_PX && view.start > 0) loadEarlier();
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (fromBottom < EDGE_LOAD_PX && view.end < session.items.length) loadLater();
  }, [loadEarlier, loadLater, session.items.length, specs, view.end, view.start]);

  // Only a person's scroll loads more; the programmatic landing above does not.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const mark = () => {
      userScrolled.current = true;
    };
    scroller.addEventListener('wheel', mark, { passive: true });
    scroller.addEventListener('touchmove', mark, { passive: true });
    return () => {
      scroller.removeEventListener('wheel', mark);
      scroller.removeEventListener('touchmove', mark);
    };
  }, []);

  const backToPassage = () => {
    const scroller = scrollerRef.current;
    const range = activeRange(scroller, specs);
    if (scroller && range) {
      scroller.scrollTo({ top: scroller.scrollTop }); // stop momentum
      scrollRangeIntoView(scroller, range, quoteRatio);
      setPlacement('visible');
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-ctx-reader=""
        className="relative h-full overflow-y-auto overscroll-contain"
        style={{ paddingBottom: footerSpace, paddingRight: showTrack ? 16 : 0 }}
      >
        <Transcript
          session={session}
          start={view.start}
          end={view.end}
          threads={threads}
          activeThreadId={activeThread.id}
          onSelectThread={onSelectThread}
          onLoadEarlier={loadEarlier}
          onLoadLater={loadLater}
          renderAfter={renderAfter}
          hideActiveMarker={hideActiveMarker}
          anchorId={activeThread.anchorId}
          renderAnchor={renderAnchor}
        />
      </div>
      {showTrack && (
        <PositionTrack
          session={session}
          threads={threads}
          activeThreadId={activeThread.id}
          start={view.start}
          end={view.end}
          onSelect={onSelectThread}
        />
      )}
      {placement !== 'visible' && (
        <div
          className="pointer-events-none absolute inset-x-0 flex justify-center"
          style={placement === 'above' ? { top: 10 } : { bottom: footerSpace + 12 }}
        >
          <button
            type="button"
            onClick={backToPassage}
            className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-border-default bg-surface px-3.5 text-sm font-medium text-fg-primary shadow-lg"
          >
            {placement === 'above' ? (
              <ArrowUp size={14} aria-hidden />
            ) : (
              <ArrowDown size={14} aria-hidden />
            )}
            Back to the comment
          </button>
        </div>
      )}
    </div>
  );
}
