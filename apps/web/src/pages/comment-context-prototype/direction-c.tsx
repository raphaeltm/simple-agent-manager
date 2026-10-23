/**
 * Direction C — "Expand around". Opens on the commented message alone, passage highlighted,
 * and grows the context on request, one message or all of them, above and below, the way a
 * code review expands the lines around a diff. The comment is never scrolled out of reach and
 * nothing loads that you did not ask for.
 */
import { ChevronDown, ChevronUp, Ellipsis } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import { CommentList, ReaderHeader } from './chrome';
import type { DirectionProps } from './direction-a';
import { AlsoInThisChat } from './direction-a';
import {
  activeRange,
  type QuoteSpec,
  scrollRangeIntoView,
  splitAtQuote,
  useQuoteHighlights,
} from './quote-highlight';
import { ResolveButton, ThreadEntries, ThreadReason, ThreadReply } from './thread-view';
import { ChatItem, Transcript } from './transcript';

const COMPOSER_PX = 128;

function ExpandControl({
  direction,
  remaining,
  onOne,
  onAll,
}: {
  direction: 'earlier' | 'later';
  remaining: number;
  onOne: () => void;
  onAll: () => void;
}) {
  if (remaining <= 0) return null;
  const Icon = direction === 'earlier' ? ChevronUp : ChevronDown;
  return (
    <div className="flex items-center gap-2 px-4 py-2" data-ctx-expand={direction}>
      <span
        aria-hidden
        className="h-px flex-1 border-0 border-t border-dashed border-border-default"
      />
      <button
        type="button"
        onClick={onOne}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-border-default bg-surface px-3 text-xs font-medium text-fg-primary hover:bg-surface-hover"
      >
        <Icon size={14} aria-hidden />
        Show 1 {direction}
      </button>
      {remaining > 1 && (
        <button
          type="button"
          onClick={onAll}
          className="h-8 rounded-full px-2 text-xs font-medium text-fg-muted hover:text-fg-primary"
        >
          All {remaining}
        </button>
      )}
      <span
        aria-hidden
        className="h-px flex-1 border-0 border-t border-dashed border-border-default"
      />
    </div>
  );
}

function MoreOfMessage({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1.5 flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-accent hover:underline"
    >
      <Ellipsis size={14} aria-hidden />
      {label}
    </button>
  );
}

export function DirectionC(props: DirectionProps) {
  const { wide, session, threads, thread, nav, onSelectThread, onReply, onToggleResolved, onBack } =
    props;
  const sessionThreads = threads.filter((candidate) => candidate.sessionId === session.id);
  const others = sessionThreads.filter((candidate) => candidate.id !== thread.id);
  const anchorIndex = Math.max(
    0,
    session.items.findIndex((item) => item.id === thread.anchorId)
  );
  const [span, setSpan] = useState({ key: thread.id, start: anchorIndex, end: anchorIndex + 1 });
  const view =
    span.key === thread.id ? span : { key: thread.id, start: anchorIndex, end: anchorIndex + 1 };
  const scrollerRef = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  // Within the commented message: only its paragraph shows until you ask for the rest.
  const [whole, setWhole] = useState({ key: thread.id, before: false, after: false });
  const within = whole.key === thread.id ? whole : { key: thread.id, before: false, after: false };

  const specs = useMemo<QuoteSpec[]>(
    () =>
      sessionThreads.map((candidate) => ({
        itemId: candidate.anchorId,
        quote: candidate.quote,
        active: candidate.id === thread.id,
      })),
    [sessionThreads, thread.id]
  );
  useQuoteHighlights(
    scrollerRef,
    specs,
    `${thread.id}:${view.start}:${view.end}:${within.before}:${within.after}`
  );

  // Land on the passage itself: a quote near the end of a long message starts in view.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const range = activeRange(scroller, specs);
    if (scroller && range) {
      scroller.scrollTop = 0;
      scrollRangeIntoView(scroller, range, 0.3);
    }
    // Only when the comment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  // Revealing earlier messages must not push the comment down the screen.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || keepFromBottom.current === null) return;
    scroller.scrollTop = scroller.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
  }, [view.start, within.before]);

  const showStartOfMessage = () => {
    const scroller = scrollerRef.current;
    if (scroller) keepFromBottom.current = scroller.scrollHeight - scroller.scrollTop;
    setWhole({ ...within, before: true });
  };

  const reply = (body: string, sendToAgent: boolean) => onReply(thread.id, body, sendToAgent);

  const threadCard = (
    <section
      aria-label="Comment thread"
      className="mt-3 flex min-w-0 flex-col gap-4 rounded-xl border border-border-default bg-surface p-4"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <ThreadReason thread={thread} />
        </div>
        <ResolveButton
          resolved={thread.status === 'resolved'}
          onToggle={() => onToggleResolved(thread.id)}
        />
      </div>
      <ThreadEntries thread={thread} dense />
      {wide && <ThreadReply session={session} thread={thread} onReply={reply} />}
      <AlsoInThisChat threads={others} onSelect={onSelectThread} />
    </section>
  );

  const renderAnchor = (item: DisplayItem) => {
    if (item.kind !== 'agent_message' && item.kind !== 'user_message') {
      return (
        <>
          <div data-ctx-item={item.id}>
            <ChatItem item={item} />
          </div>
          {threadCard}
        </>
      );
    }
    const parts = splitAtQuote(item.text, thread.quote);
    const text = [within.before ? parts.before : '', parts.passage, within.after ? parts.after : '']
      .filter(Boolean)
      .join('\n\n');
    return (
      <>
        {parts.before && !within.before && (
          <MoreOfMessage label="Show the start of this message" onClick={showStartOfMessage} />
        )}
        <div data-ctx-item={item.id}>
          <ChatItem item={{ ...item, text }} />
        </div>
        {parts.after && !within.after && (
          <MoreOfMessage
            label="Show the rest of this message"
            onClick={() => setWhole({ ...within, after: true })}
          />
        )}
        {threadCard}
      </>
    );
  };

  const showEarlier = (count: number) => {
    const scroller = scrollerRef.current;
    if (scroller) keepFromBottom.current = scroller.scrollHeight - scroller.scrollTop;
    setSpan({ ...view, start: Math.max(0, view.start - count) });
  };
  const showLater = (count: number) =>
    setSpan({ ...view, end: Math.min(session.items.length, view.end + count) });

  const content = (
    <div
      ref={scrollerRef}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      style={{ paddingBottom: wide ? 0 : COMPOSER_PX }}
    >
      <div className="mx-auto flex w-full max-w-[780px] min-w-0 flex-col py-2">
        <ExpandControl
          direction="earlier"
          remaining={view.start}
          onOne={() => showEarlier(1)}
          onAll={() => showEarlier(view.start)}
        />
        <Transcript
          session={session}
          start={view.start}
          end={view.end}
          threads={sessionThreads}
          activeThreadId={thread.id}
          onSelectThread={onSelectThread}
          muted={(item) => item.id !== thread.anchorId}
          anchorId={thread.anchorId}
          renderAnchor={renderAnchor}
          hideActiveMarker
        />
        <ExpandControl
          direction="later"
          remaining={session.items.length - view.end}
          onOne={() => showLater(1)}
          onAll={() => showLater(session.items.length - view.end)}
        />
      </div>
    </div>
  );

  if (wide) {
    return (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
        <CommentList threads={threads} activeThreadId={thread.id} onSelect={onSelectThread} />
        <section aria-label="Comment in context" className="flex min-h-0 flex-col">
          <ReaderHeader session={session} thread={thread} nav={nav} />
          {content}
        </section>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <ReaderHeader session={session} thread={thread} nav={nav} onBack={onBack} />
      {content}
      <footer className="absolute inset-x-0 bottom-0 z-20 border-0 border-t border-solid border-border-default bg-surface px-3 pt-2.5 pb-3">
        <ThreadReply session={session} thread={thread} onReply={reply} />
      </footer>
    </div>
  );
}
