/**
 * Direction B — "Thread inline". One column: the conversation around the comment, with the
 * thread drawn right after the paragraph it is about, inside the agent's message, like a review
 * comment under a line of code. A long message is split at that paragraph, so the passage and
 * the comment are always on screen together. Scrolling reads the rest of the discussion.
 */
import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import { CommentList, ReaderHeader } from './chrome';
import type { DirectionProps } from './direction-a';
import { splitAtQuote } from './quote-highlight';
import { AnchoredReader } from './reader';
import { ResolveButton, ThreadEntries, ThreadReason, ThreadReply } from './thread-view';
import { ChatItem } from './transcript';

/** Room kept for the pinned reply box on a phone. */
const COMPOSER_PX = 128;

function InlineThread({ wide, props }: { wide: boolean; props: DirectionProps }) {
  const { session, thread, onReply, onToggleResolved } = props;
  return (
    <div className="relative mt-1 mb-3 ml-2 rounded-xl border-2 border-warning/45 bg-surface p-3 sm:ml-8">
      <span
        aria-hidden
        className="absolute -top-[11px] left-5 h-2.5 w-0.5 rounded-full bg-[var(--sam-color-warning)] opacity-60"
      />
      <div className="mb-3 flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <ThreadReason thread={thread} />
        </div>
        <ResolveButton
          resolved={thread.status === 'resolved'}
          onToggle={() => onToggleResolved(thread.id)}
        />
      </div>
      <ThreadEntries thread={thread} dense />
      {wide && (
        <div className="mt-3">
          <ThreadReply
            session={session}
            thread={thread}
            onReply={(body, sendToAgent) => onReply(thread.id, body, sendToAgent)}
          />
        </div>
      )}
    </div>
  );
}

/** The commented message, split after the paragraph that holds the quote. */
function SplitAnchor({
  item,
  wide,
  props,
}: {
  item: DisplayItem;
  wide: boolean;
  props: DirectionProps;
}) {
  if (item.kind !== 'agent_message' && item.kind !== 'user_message') {
    return (
      <>
        <div data-ctx-item={item.id}>
          <ChatItem item={item} />
        </div>
        <InlineThread wide={wide} props={props} />
      </>
    );
  }
  const parts = splitAtQuote(item.text, props.thread.quote);
  const head = [parts.before, parts.passage].filter(Boolean).join('\n\n');
  return (
    <>
      <div data-ctx-item={item.id}>
        <ChatItem item={{ ...item, text: head }} />
      </div>
      <InlineThread wide={wide} props={props} />
      {parts.after && (
        <div data-ctx-item={item.id}>
          <ChatItem item={{ ...item, id: `${item.id}-rest`, text: parts.after }} />
        </div>
      )}
    </>
  );
}

export function DirectionB(props: DirectionProps) {
  const { wide, session, threads, thread, nav, onSelectThread, onReply, onBack } = props;
  const sessionThreads = threads.filter((candidate) => candidate.sessionId === session.id);
  const reader = (
    <AnchoredReader
      session={session}
      threads={sessionThreads}
      activeThread={thread}
      onSelectThread={onSelectThread}
      hideActiveMarker
      quoteRatio={wide ? 0.3 : 0.2}
      footerSpace={wide ? 0 : COMPOSER_PX}
      renderAnchor={(item) => <SplitAnchor item={item} wide={wide} props={props} />}
    />
  );

  if (wide) {
    return (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
        <CommentList threads={threads} activeThreadId={thread.id} onSelect={onSelectThread} />
        <section aria-label="Conversation" className="flex min-h-0 flex-col">
          <ReaderHeader session={session} thread={thread} nav={nav} />
          {reader}
        </section>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <ReaderHeader session={session} thread={thread} nav={nav} onBack={onBack} />
      {reader}
      <footer className="absolute inset-x-0 bottom-0 z-20 border-0 border-t border-solid border-border-default bg-surface px-3 pt-2.5 pb-3">
        <ThreadReply
          session={session}
          thread={thread}
          onReply={(body, sendToAgent) => onReply(thread.id, body, sendToAgent)}
        />
      </footer>
    </div>
  );
}
