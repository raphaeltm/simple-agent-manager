import type {
  InboxConversation,
  InboxItem,
  InboxItemCommentThread,
  InboxItemContext,
  InboxReplyMessage,
} from '@simple-agent-manager/shared';
import { Bot, MessageSquare, Paperclip } from 'lucide-react';
import {
  forwardRef,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { formatFileSize } from '../../lib/file-utils';
import { RenderedMarkdown } from '../MarkdownRenderer';
import {
  conversationEntries,
  type InboxConversationEntry,
  latestResponseId,
  replierName,
  replyDisplayText,
} from './inbox-conversation-model';
import { formatAge } from './inbox-model';
import { InboxItemBody } from './InboxItemView';
import { useInboxConversation } from './useInboxConversation';

function AgentAvatar() {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--sam-person-auto)] text-[var(--sam-person-ink)] ring-2 ring-[var(--sam-separator)]"
    >
      <Bot size={15} strokeWidth={2.2} />
    </span>
  );
}

/** An agent turn: avatar in the gutter, the content, then the answer controls if it carries them. */
const AgentTurn = forwardRef<
  HTMLDivElement,
  { children: ReactNode; controls?: ReactNode; meta?: string; testId: string }
>(function AgentTurn({ children, controls, meta, testId }, ref) {
  return (
    <div ref={ref} className="flex min-w-0 items-start gap-2.5" data-testid={testId}>
      <AgentAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {children}
        {/* The time belongs to the message, before the buttons it carries. */}
        {meta && <span className="text-xs text-fg-muted">{meta}</span>}
        {controls && (
          <div
            role="group"
            aria-label="Answer the agent"
            className="min-w-0 pt-0.5"
            data-testid="inbox-answer-controls"
          >
            {controls}
          </div>
        )}
      </div>
    </div>
  );
});

function ReplyAttachments({ reply }: { reply: InboxReplyMessage }) {
  if (reply.attachments.length === 0) return null;
  return (
    <ul className="m-0 flex max-w-[85%] list-none flex-col items-end gap-1 p-0">
      {reply.attachments.map((file) => (
        <li
          key={file.uploadId}
          className="sam-raised flex max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-secondary"
        >
          <Paperclip size={13} aria-hidden="true" className="shrink-0 text-fg-muted" />
          <span className="min-w-0 truncate">{file.filename}</span>
          <span className="shrink-0 text-[11px] text-fg-muted">{formatFileSize(file.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "12m ago" for a millisecond timestamp. */
function ago(at: number, now: number): string {
  return `${formatAge(new Date(at).toISOString(), now)} ago`;
}

/** The person's reply: an ordinary message in the agent's chat, shown here on the right. */
function ReplyTurn({
  reply,
  viewerId,
  names,
  now,
}: {
  reply: InboxReplyMessage;
  viewerId: string;
  /** Names the item read knows (the latest replier); a reply message carries only a user id. */
  names: ReadonlyMap<string, string | null>;
  now: number;
}) {
  const text = replyDisplayText(reply);
  const who = replierName({ userId: reply.userId, name: names.get(reply.userId ?? '') }, viewerId);
  return (
    <div className="flex min-w-0 flex-col items-end gap-1.5" data-testid="inbox-reply">
      <span className="sr-only">{who} replied:</span>
      {text && (
        <div className="sam-raised max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[15px] whitespace-pre-wrap break-words text-fg-primary [overflow-wrap:anywhere]">
          {text}
        </div>
      )}
      <ReplyAttachments reply={reply} />
      <span className="flex items-center gap-1 text-xs text-fg-muted">
        <MessageSquare size={12} aria-hidden="true" />
        {who === 'You' ? '' : `${who} · `}Sent in the agent’s chat · {ago(reply.createdAt, now)}
      </span>
    </div>
  );
}

/** The agent's response on the item (an anchored comment thread), with any follow-ups in it. */
const ResponseTurn = forwardRef<
  HTMLDivElement,
  { response: InboxItemCommentThread; now: number; controls?: ReactNode }
>(function ResponseTurn({ response, now, controls }, ref) {
  return (
    <AgentTurn
      ref={ref}
      testId="inbox-response"
      controls={controls}
      meta={`Responded on this item · ${ago(response.createdAt, now)}`}
    >
      <span className="sr-only">The agent responded:</span>
      {/* Agent-written markdown: the renderer never renders raw HTML and sanitizes links. */}
      <div className="min-w-0 text-[15px] text-fg-secondary">
        <RenderedMarkdown content={response.body} inline />
      </div>
      {response.replies.map((followUp) => (
        <div key={followUp.id} className="min-w-0 text-[15px] text-fg-secondary">
          <RenderedMarkdown content={followUp.body} inline />
        </div>
      ))}
    </AgentTurn>
  );
});

/**
 * Opening an item the agent has responded on starts at its latest response, where the answer
 * buttons are; a response that arrives while the item is open is announced. Both key on the
 * first page of the conversation (the item read), so reading more pages announces nothing.
 * Runs once per item: the thread is keyed by ref, and a refetch never moves the reader.
 */
function useResponseArrivals(
  conversation: InboxConversation | null,
  latestRef: RefObject<HTMLDivElement | null>
): string {
  const seen = useRef<string | null | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const latest = conversation ? latestResponseId(conversationEntries([conversation])) : null;
  useEffect(() => {
    if (!conversation) return;
    if (seen.current === undefined) {
      seen.current = latest;
      if (latest) latestRef.current?.scrollIntoView?.({ block: 'start' });
      return;
    }
    if (latest && latest !== seen.current) {
      seen.current = latest;
      setAnnouncement('The agent responded on this item.');
    }
  }, [conversation, latest, latestRef]);
  return announcement;
}

/**
 * An inbox item as a conversation (idea 01M7N16AF5HDPH1ZND4D4RJ00J). The ask is the agent's first
 * message; the person's replies and the agent's responses follow in time order. The answer
 * controls sit on the newest agent turn, so there is only ever one set: inside the ask until the
 * agent responds, then on its latest response.
 */
export function InboxConversationThread({
  item,
  context,
  conversation,
  now,
  viewerId,
  stackPosition,
  detail,
  headingRef,
  controls,
}: {
  item: InboxItem;
  context: InboxItemContext | null;
  /** The first conversation page, from the item read; null when the reader cannot see the chat. */
  conversation: InboxConversation | null;
  now: number;
  viewerId: string;
  stackPosition: { index: number; total: number; topic: string | null } | null;
  detail?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  controls: ReactNode;
}) {
  const thread = useInboxConversation({
    projectId: item.projectId,
    itemRef: item.ref,
    first: conversation,
  });
  const lastResponse = latestResponseId(thread.entries);
  const latestReply = item.latestReply;
  const names = useMemo(
    () => new Map(latestReply ? [[latestReply.userId, latestReply.name]] : []),
    [latestReply]
  );
  const latestRef = useRef<HTMLDivElement>(null);
  const announcement = useResponseArrivals(conversation, latestRef);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="inbox-conversation">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <AgentTurn testId="inbox-ask" controls={lastResponse === null ? controls : undefined}>
        <InboxItemBody
          item={item}
          context={context}
          now={now}
          stackPosition={stackPosition}
          detail={detail}
          headingRef={headingRef}
        />
      </AgentTurn>
      {(thread.hasMore || thread.loadingMore || thread.loadError) && (
        <div className="flex flex-wrap items-center gap-2 pl-[38px]">
          {/* One button throughout, so focus stays on it while the next page loads. */}
          <button
            type="button"
            onClick={thread.loadMore}
            aria-disabled={thread.loadingMore}
            aria-busy={thread.loadingMore}
            className="min-h-11 cursor-pointer rounded-md border-0 bg-transparent px-1 text-sm text-accent hover:underline aria-disabled:cursor-default aria-disabled:text-fg-muted aria-disabled:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            {thread.loadingMore
              ? 'Loading more of the conversation…'
              : thread.loadError
                ? 'Could not load more. Try again'
                : 'Show more of the conversation'}
          </button>
        </div>
      )}
      {thread.entries.map((entry: InboxConversationEntry) =>
        entry.kind === 'reply' ? (
          <ReplyTurn
            key={`reply:${entry.id}`}
            reply={entry.reply}
            viewerId={viewerId}
            names={names}
            now={now}
          />
        ) : (
          <ResponseTurn
            key={`response:${entry.id}`}
            ref={entry.id === lastResponse ? latestRef : undefined}
            response={entry.response}
            now={now}
            controls={entry.id === lastResponse ? controls : undefined}
          />
        )
      )}
    </div>
  );
}
