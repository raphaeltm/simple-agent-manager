/**
 * Read a chat comment in its conversation, from the Comments page or a comment notification
 * (`/projects/:id/comments/:sessionId/:threadId`).
 *
 * The conversation is the main surface, opened on the commented words; the thread sits beside
 * it on a desktop and in a bottom sheet on a phone, so scrolling the conversation never loses
 * the comment and the comment never hides the context. Previous/next walk the Comments page's
 * order; "Open in chat" goes to the live chat at this comment.
 */
import type { ToolCallContentItem } from '@simple-agent-manager/acp-client';
import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useAuth } from '../../components/AuthProvider';
import {
  lastActivitySummary,
  toInboxItem,
} from '../../components/project-message-view/comments/comment-inbox';
import {
  authorDisplayName,
  normalizeThread,
  type UiMessageCommentThread,
} from '../../components/project-message-view/comments/comment-utils';
import {
  buildCommentedMessageDescriber,
  formatCommentedMessageLabel,
} from '../../components/project-message-view/comments/commented-message-label';
import { QuotedAnchor } from '../../components/project-message-view/comments/CommentPrimitives';
import { threadCallbacks } from '../../components/project-message-view/comments/MessageCommentPanels';
import { useCommentsRailViewport } from '../../components/project-message-view/comments/useCommentsRailViewport';
import { useMessageComments } from '../../components/project-message-view/comments/useMessageComments';
import { useProjectCommentInbox } from '../../components/project-message-view/comments/useProjectCommentInbox';
import { loadToolCallContent } from '../../components/project-message-view/load-tool-content';
import { groupToolCallItems } from '../../components/project-message-view/tool-call-groups';
import { chatMessagesToConversationItems } from '../../components/project-message-view/types';
import { useProjectContext } from '../ProjectContext';
import {
  buildRowLocator,
  commentNavigation,
  commentReaderPath,
  openInChatPath,
} from './reader-model';
import { ReaderConversation, type ReaderMarker } from './ReaderConversation';
import { ReaderHeader } from './ReaderHeader';
import { ReaderThreadPanel, ReaderThreadSheet } from './ReaderThread';
import { useCommentReaderTranscript } from './useCommentReaderTranscript';

/** Where the quoted words land, as a fraction of the visible conversation height. */
const QUOTE_RATIO_WIDE = 0.3;
const QUOTE_RATIO_PHONE = 0.2;

function markerLabel(thread: UiMessageCommentThread, viewerId: string | null): string {
  const who =
    viewerId && thread.author.id === viewerId
      ? 'You'
      : (authorDisplayName(thread.author).split(/\s+/)[0] ?? 'Someone');
  return thread.replies.length > 0 ? `${who} +${thread.replies.length}` : who;
}

export function ProjectCommentReader() {
  const { projectId } = useProjectContext();
  const { sessionId = '', threadId = '' } = useParams<{ sessionId: string; threadId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const viewerId = user?.id ?? null;
  const wide = useCommentsRailViewport();

  const transcript = useCommentReaderTranscript(projectId, sessionId, threadId);
  const messageComments = useMessageComments(projectId, sessionId, Boolean(sessionId));
  const inbox = useProjectCommentInbox(projectId);
  const { context, rows } = transcript;

  const items = useMemo(() => groupToolCallItems(chatMessagesToConversationItems(rows)), [rows]);
  const locate = useMemo(() => buildRowLocator(rows, items), [rows, items]);

  // The live per-session list is what mutations keep current; the context copy covers the
  // first render and a thread the list has not paged in.
  const thread = useMemo<UiMessageCommentThread | null>(
    () =>
      messageComments.comments.find((candidate) => candidate.id === threadId) ??
      (context ? normalizeThread(context.thread) : null),
    [context, messageComments.comments, threadId]
  );
  const anchorMessageId = thread?.anchor.messageId ?? context?.anchor.messageId ?? null;
  const anchorItemId = anchorMessageId ? locate(anchorMessageId) : null;
  const anchorRow = useMemo(
    () => rows.find((row) => row.id === anchorMessageId) ?? null,
    [anchorMessageId, rows]
  );
  const quote = thread?.anchor.quote ?? null;

  const others = useMemo(
    () => messageComments.comments.filter((candidate) => candidate.id !== threadId),
    [messageComments.comments, threadId]
  );
  const otherQuotes = useMemo(
    () =>
      others.flatMap((other) => {
        const itemId = locate(other.anchor.messageId);
        return itemId && other.anchor.quote ? [{ itemId, quote: other.anchor.quote }] : [];
      }),
    [locate, others]
  );
  const markers = useMemo(() => {
    const byItem = new Map<string, ReaderMarker[]>();
    const all = thread ? [thread, ...others] : others;
    for (const candidate of all) {
      const itemId = locate(candidate.anchor.messageId);
      if (!itemId) continue;
      const list = byItem.get(itemId) ?? [];
      list.push({
        threadId: candidate.id,
        label: markerLabel(candidate, viewerId),
        active: candidate.id === threadId,
      });
      byItem.set(itemId, list);
    }
    return byItem;
  }, [locate, others, thread, threadId, viewerId]);

  const nav = useMemo(
    () => commentNavigation(inbox.items, viewerId, threadId),
    [inbox.items, threadId, viewerId]
  );
  const inboxPath = (item: (typeof inbox.items)[number] | null) =>
    item && item.source.kind === 'session'
      ? commentReaderPath(projectId, item.source.sessionId, item.thread.id)
      : null;
  const inboxTopic = inbox.items.find(
    (item) => item.source.kind === 'session' && item.source.sessionId === sessionId
  );

  const describe = useMemo(
    () =>
      buildCommentedMessageDescriber(items, {
        ownerName: 'The chat owner',
        viewerIsOwner: context?.viewerAccess === 'owner',
      }),
    [context?.viewerAccess, items]
  );
  const title =
    context?.session.topic ||
    (inboxTopic?.source.kind === 'session' ? inboxTopic.source.sessionTopic : null) ||
    'Untitled chat';
  const subtitle = anchorItemId ? formatCommentedMessageLabel(describe(anchorItemId)) : null;

  const canSendToAgent = context?.viewerAccess === 'owner' || context?.viewerAccess === 'grantee';
  const { createThread, reply, resolve, reopen, sendToAgent } = messageComments;
  // useMessageComments refreshes the Comments page list after every mutation, as in the chat.
  const callbacks = useMemo(
    () =>
      threadCallbacks(
        {
          mentionProjectId: projectId,
          createThread,
          reply,
          resolve,
          reopen,
          sendToAgent: canSendToAgent ? sendToAgent : undefined,
        },
        canSendToAgent
      ),
    [canSendToAgent, createThread, projectId, reopen, reply, resolve, sendToAgent]
  );

  const selectThread = useCallback(
    (nextThreadId: string) => {
      if (nextThreadId === threadId) return;
      navigate(commentReaderPath(projectId, sessionId, nextThreadId), { replace: true });
    },
    [navigate, projectId, sessionId, threadId]
  );
  const onLoadToolContent = useCallback(
    (messageId: string): Promise<ToolCallContentItem[]> =>
      loadToolCallContent(projectId, sessionId, messageId),
    [projectId, sessionId]
  );

  // Phone: the collapsed sheet covers the bottom of the conversation; measure it so the words
  // land above it and nothing scrolls underneath it for good.
  const [sheet, setSheet] = useState({ open: false, replying: false });
  const sheetRef = useRef<HTMLElement>(null);
  const sheetOpen = useRef(false);
  useLayoutEffect(() => {
    sheetOpen.current = sheet.open;
  }, [sheet.open]);
  const [sheetHeight, setSheetHeight] = useState(0);
  const hasThread = thread !== null;
  useLayoutEffect(() => {
    const element = sheetRef.current;
    if (wide || !element) {
      setSheetHeight(0);
      return;
    }
    const measure = () => {
      if (!sheetOpen.current) setSheetHeight(Math.round(element.getBoundingClientRect().height));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [wide, hasThread]);
  // Opening another comment starts with its sheet collapsed again.
  useLayoutEffect(() => setSheet({ open: false, replying: false }), [threadId]);

  // A comment the server says is gone, or that failed to load, offers no actions: a cached copy
  // from the session's comment list must not contradict the message the page shows.
  const showThread = !transcript.notFound && !transcript.error;
  const summary = thread
    ? lastActivitySummary(
        toInboxItem(thread, {
          kind: 'session',
          sessionId,
          sessionTopic: title,
          messageId: thread.anchor.messageId,
        }),
        viewerId
      )
    : '';
  const openInChatTo = anchorMessageId
    ? openInChatPath(projectId, sessionId, threadId, {
        messageId: anchorMessageId,
        createdAt: anchorRow?.createdAt ?? null,
      })
    : `/projects/${projectId}/chat/${encodeURIComponent(sessionId)}`;

  let body;
  if (transcript.notFound) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="m-0 text-sm text-fg-primary">This comment is no longer available.</p>
        <p className="m-0 max-w-sm text-xs text-fg-muted">
          It may have been deleted, or you may no longer have access to its chat.
        </p>
        <Link to={`/projects/${projectId}/comments`} className="text-sm text-accent">
          Back to comments
        </Link>
      </div>
    );
  } else if (transcript.error) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <Alert variant="error">Couldn&rsquo;t load this conversation: {transcript.error}</Alert>
        <Button size="sm" variant="secondary" onClick={transcript.retry}>
          Try again
        </Button>
      </div>
    );
  } else if (!context) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2" role="status">
        <Spinner size="md" />
        <span className="text-sm text-fg-muted">Loading the conversation…</span>
      </div>
    );
  } else if (!context.anchor.found) {
    body = (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        style={{ paddingBottom: sheetHeight + 24 }}
      >
        <p className="m-0 text-sm text-fg-primary">
          The message this comment is on is no longer in the chat.
        </p>
        {quote && (
          <div className="w-full max-w-md text-left">
            <QuotedAnchor quote={quote} />
          </div>
        )}
        <Link to={openInChatTo} className="text-sm text-accent">
          Open the chat
        </Link>
      </div>
    );
  } else {
    body = (
      <ReaderConversation
        projectId={projectId}
        items={items}
        rowsKey={`${rows[0]?.id ?? ''}:${rows.length}`}
        firstRowId={rows[0]?.id ?? null}
        anchorItemId={anchorItemId}
        quote={quote}
        others={otherQuotes}
        markers={markers}
        landingKey={threadId}
        onSelectThread={selectThread}
        onLoadToolContent={onLoadToolContent}
        hasEarlier={transcript.hasEarlier}
        hasLater={transcript.hasLater}
        loadingEarlier={transcript.loadingEarlier}
        loadingLater={transcript.loadingLater}
        loadEarlier={transcript.loadEarlier}
        loadLater={transcript.loadLater}
        quoteRatio={wide ? QUOTE_RATIO_WIDE : QUOTE_RATIO_PHONE}
        bottomInset={sheetHeight}
      />
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="comment-reader">
      {/* First child in both layouts, so crossing the breakpoint never remounts it. */}
      <section
        aria-label="Comment in its conversation"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <ReaderHeader
          title={title}
          subtitle={subtitle}
          backTo={`/projects/${projectId}/comments`}
          position={nav.position}
          total={nav.total}
          previousTo={inboxPath(nav.previous)}
          nextTo={inboxPath(nav.next)}
          openInChatTo={openInChatTo}
        />
        {body}
      </section>
      {showThread &&
        thread &&
        (wide ? (
          <ReaderThreadPanel
            thread={thread}
            others={others}
            summary={summary}
            mentionProjectId={projectId}
            callbacks={callbacks}
            onSelectThread={selectThread}
          />
        ) : (
          <ReaderThreadSheet
            ref={sheetRef}
            thread={thread}
            others={others}
            summary={summary}
            mentionProjectId={projectId}
            callbacks={callbacks}
            onSelectThread={selectThread}
            open={sheet.open}
            replying={sheet.replying}
            onOpenChange={(open, replying = false) => setSheet({ open, replying })}
          />
        ))}
    </div>
  );
}
