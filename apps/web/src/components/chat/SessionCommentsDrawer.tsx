import type { CommentMention } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { CornerDownRight, MessageSquareQuote } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import type { MessageCommentAction } from '../../lib/api/comments';
import {
  type CommentInboxFilter,
  type CommentInboxItem,
  countBuckets,
  filterInbox,
} from '../project-message-view/comments/comment-inbox';
import { CommentInboxFilters } from '../project-message-view/comments/CommentInboxFilters';
import { CommentInboxRow } from '../project-message-view/comments/CommentInboxRow';
import { CommentThread } from '../project-message-view/comments/CommentThread';
import type { TimelineJumpTarget } from '../project-message-view/timeline-types';
import { GlassSheet, GlassSheetHeader } from '../shell/GlassSheet';
import { useDialogFocusTrap } from './useDialogFocusTrap';

export interface SessionCommentsDrawerProps {
  items: CommentInboxItem[];
  loading: boolean;
  viewerId: string | null;
  /** Project whose active members can be @mentioned in replies. */
  mentionProjectId?: string;
  onClose: () => void;
  /** Scroll the conversation to the annotated message. */
  onJump: (target: TimelineJumpTarget) => void;
  onReply: (
    threadId: string,
    body: string,
    action: MessageCommentAction,
    mentions: CommentMention[]
  ) => Promise<unknown>;
  onResolve: (threadId: string) => Promise<unknown>;
  onReopen: (threadId: string) => Promise<unknown>;
  /** Absent for viewers who cannot drive the session: hides every Send-to-agent affordance. */
  onSendToAgent?: (threadId: string) => Promise<unknown>;
}

/**
 * Session-scoped comment inbox.
 *
 * Deliberately built as a sibling of `ChatTimelineDrawer`: same glass panel,
 * same mobile-fullscreen / desktop-right-rail geometry, same Escape handling.
 * The two answer adjacent questions ("what happened, in order" vs "what is
 * still open") and users move between them, so they should feel like one
 * mechanism with two lenses rather than two unrelated overlays.
 *
 * A row expands *in place* into the real `CommentThread`, which keeps reply /
 * resolve / reopen / send-to-agent behaviour on exactly one implementation.
 */
export function SessionCommentsDrawer({
  items,
  loading,
  viewerId,
  mentionProjectId,
  onClose,
  onJump,
  onReply,
  onResolve,
  onReopen,
  onSendToAgent,
}: SessionCommentsDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => countBuckets(items, viewerId), [items, viewerId]);
  // Open on whichever bucket has something waiting: landing on an empty "Needs
  // you" tab reads as "comments are broken" rather than "you are up to date".
  const [filter, setFilter] = useState<CommentInboxFilter>(() =>
    counts.needs_you > 0 ? 'needs_you' : 'all'
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const visible = useMemo(() => filterInbox(items, filter, viewerId), [items, filter, viewerId]);
  const showInitialLoading = loading && items.length === 0;
  const showEmpty = !showInitialLoading && visible.length === 0;
  useDialogFocusTrap(panelRef, onClose);

  return (
    <GlassSheet
      label="Session comments"
      panelRef={panelRef}
      onBackdropClick={onClose}
      backdrop="desktop"
      mobile="full"
      widthClassName="w-full md:w-[min(400px,50vw)]"
      zClassName="z-50"
      backdropZClassName="z-40"
      animated={false}
    >
        <GlassSheetHeader
          icon={<MessageSquareQuote size={20} strokeWidth={1.75} />}
          title="Comments"
          onClose={onClose}
          closeLabel="Close comments"
        />

        <div className="shrink-0 border-b border-[var(--sam-hairline)] px-4 pb-2">
          <CommentInboxFilters value={filter} counts={counts} onChange={setFilter} />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {showInitialLoading && (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" />
            </div>
          )}
          {showEmpty && <EmptyInbox filter={filter} total={counts.all} />}
          {!showInitialLoading && !showEmpty && (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-default p-0">
              {visible.map((item) => {
                const expanded = expandedId === item.thread.id;
                const sessionSource = item.source.kind === 'session' ? item.source : null;
                return (
                  <li key={item.thread.id} className="min-w-0">
                    <CommentInboxRow
                      item={item}
                      viewerId={viewerId}
                      selected={expanded}
                      onSelect={() => setExpandedId(expanded ? null : item.thread.id)}
                    />
                    {expanded && (
                      <div className="min-w-0 border-t border-border-default bg-bg-inset px-2.5 py-2.5">
                        <CommentThread
                          comment={item.thread}
                          focused
                          mentionProjectId={mentionProjectId}
                          onReply={onReply}
                          onResolve={onResolve}
                          onReopen={onReopen}
                          onSendToAgent={onSendToAgent}
                        />
                        {sessionSource && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-2"
                            onClick={() => {
                              onJump({
                                messageId: sessionSource.messageId,
                                timestamp: item.thread.createdAt,
                              });
                              onClose();
                            }}
                          >
                            <CornerDownRight size={14} className="mr-1" />
                            Show in conversation
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
    </GlassSheet>
  );
}

/**
 * Empty states are split because "you have no comments" and "you are caught up"
 * are different pieces of news and only one of them is good.
 */
function EmptyInbox({ filter, total }: Readonly<{ filter: CommentInboxFilter; total: number }>) {
  if (total === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <MessageSquareQuote size={22} className="mx-auto mb-2 text-fg-muted opacity-60" />
        <p className="m-0 text-sm text-fg-primary">No comments in this session</p>
        <p className="m-0 mt-1 text-xs text-fg-muted">Select any text in a message to leave one.</p>
      </div>
    );
  }
  const emptyTitle = filter === 'needs_you' ? "You're all caught up" : 'Nothing here';
  const commentNoun = total === 1 ? 'comment' : 'comments';

  return (
    <div className="px-6 py-10 text-center">
      <p className="m-0 text-sm text-fg-primary">{emptyTitle}</p>
      <p className="m-0 mt-1 text-xs text-fg-muted">
        {total} {commentNoun} in this session — switch filters to see them.
      </p>
    </div>
  );
}
