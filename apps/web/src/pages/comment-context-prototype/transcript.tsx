/**
 * A window of a real chat transcript, rendered with the production chat item renderer, with
 * the comment markers and the "earlier / later" edges every direction shares.
 */
import { ArrowDown, ArrowUp, MessageSquareQuote } from 'lucide-react';
import type { ReactNode } from 'react';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import { ME } from '../comments-inbox-prototype/mock-data';
import type { ChatSession, ContextThread } from './mock-session';

const NO_CONTENT = () => Promise.resolve([]);

/** One transcript item, drawn by the production chat renderer. */
export function ChatItem({ item }: { item: DisplayItem }) {
  return (
    <AcpConversationItemView
      item={item}
      onLoadToolContent={NO_CONTENT}
      animateText={false}
      animateUserMessage={false}
    />
  );
}

function minutesAgo(at: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function Edge({
  direction,
  remaining,
  firstAt,
  onLoad,
}: {
  direction: 'earlier' | 'later';
  remaining: number;
  firstAt: number;
  onLoad?: () => void;
}) {
  if (remaining <= 0) {
    return (
      <p className="m-0 px-4 py-3 text-center text-xs text-fg-muted">
        {direction === 'earlier' ? `Start of the chat · ${minutesAgo(firstAt)}` : 'Latest message'}
      </p>
    );
  }
  const Icon = direction === 'earlier' ? ArrowUp : ArrowDown;
  return (
    <div className="flex justify-center px-4 py-2">
      <button
        type="button"
        onClick={onLoad}
        data-ctx-edge={direction}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-default bg-surface px-3 text-xs font-medium text-fg-muted hover:text-fg-primary"
      >
        <Icon size={13} aria-hidden />
        {remaining} {direction} {remaining === 1 ? 'message' : 'messages'}
      </button>
    </div>
  );
}

/** Small chips under a commented message: one per thread, the active one emphasized. */
function CommentMarkers({
  threads,
  activeThreadId,
  onSelect,
}: {
  threads: ContextThread[];
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="-mt-2 mb-1 flex flex-wrap gap-1.5">
      {threads.map((thread) => {
        const active = thread.id === activeThreadId;
        const first = thread.entries[0];
        return (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelect(thread.id)}
            aria-pressed={active}
            className={`inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2 text-xs ${
              active
                ? 'border-warning bg-warning-tint text-warning-fg'
                : 'border-border-default text-fg-muted hover:text-fg-primary'
            }`}
          >
            <MessageSquareQuote size={12} aria-hidden className="shrink-0" />
            <span className="truncate">
              {first?.author.id === ME.id ? 'You' : first?.author.name.split(' ')[0]}
              {thread.entries.length > 1 ? ` +${thread.entries.length - 1}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Transcript({
  session,
  start,
  end,
  threads,
  activeThreadId,
  onSelectThread,
  onLoadEarlier,
  onLoadLater,
  renderAfter,
  muted,
  hideActiveMarker = false,
  anchorId,
  renderAnchor,
}: {
  session: ChatSession;
  /** Window into `session.items`: `start` inclusive, `end` exclusive. */
  start: number;
  end: number;
  threads: ContextThread[];
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onLoadEarlier?: () => void;
  onLoadLater?: () => void;
  /** Extra content under an item, e.g. the thread in the inline direction. */
  renderAfter?: (item: DisplayItem) => ReactNode;
  /** Items to show faded (context around the anchor). */
  muted?: (item: DisplayItem) => boolean;
  /** The active thread is drawn in place (inline direction), so skip its chip. */
  hideActiveMarker?: boolean;
  /** The commented message, drawn by the direction instead (split or trimmed). */
  anchorId?: string;
  renderAnchor?: (item: DisplayItem) => ReactNode;
}) {
  const items = session.items.slice(start, end);
  const firstAt = session.items[0]?.timestamp ?? Date.now();
  return (
    <div className="flex min-w-0 flex-col pt-2 pb-6">
      {onLoadEarlier !== undefined || start === 0 ? (
        <Edge direction="earlier" remaining={start} firstAt={firstAt} onLoad={onLoadEarlier} />
      ) : null}
      {items.map((item) => {
        const itemThreads = threads.filter(
          (thread) =>
            thread.anchorId === item.id && !(hideActiveMarker && thread.id === activeThreadId)
        );
        return (
          <div
            key={item.id}
            className={`sam-message-entry px-4 pb-3 transition-opacity ${muted?.(item) ? 'opacity-55' : ''}`}
          >
            {renderAnchor && item.id === anchorId ? (
              renderAnchor(item)
            ) : (
              <div data-ctx-item={item.id}>
                <ChatItem item={item} />
              </div>
            )}
            <CommentMarkers
              threads={itemThreads}
              activeThreadId={activeThreadId}
              onSelect={onSelectThread}
            />
            {renderAfter?.(item)}
          </div>
        );
      })}
      {onLoadLater !== undefined || end === session.items.length ? (
        <Edge
          direction="later"
          remaining={session.items.length - end}
          firstAt={firstAt}
          onLoad={onLoadLater}
        />
      ) : null}
    </div>
  );
}
