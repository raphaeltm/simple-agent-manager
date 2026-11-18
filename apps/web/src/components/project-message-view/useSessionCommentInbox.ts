/**
 * The chat's comment threads, as the header chip, the drawer, the desktop rail and the timeline
 * all read them.
 *
 * One derivation for all four, so they cannot disagree about how many threads are outstanding
 * or name the same commented message differently. Extracted from `SessionMessageView` to keep
 * that file under the 500-line ceiling (`.claude/rules/18-file-size-limits.md`); the memo deps
 * and behaviour are unchanged.
 */
import { useMemo } from 'react';

import type { MessageCommentThread } from '../../lib/api/comments';
import { type CommentInboxItem, countBuckets, toInboxItem } from './comments/comment-inbox';
import {
  buildCommentedMessageDescriber,
  type DescribeCommentedMessage,
} from './comments/commented-message-label';
import type { DisplayItem } from './tool-call-groups';

export interface SessionCommentInbox {
  /** One phrase per commented message ("the agent's reply", "Olivia's message"). */
  describeCommentedMessage: DescribeCommentedMessage;
  items: CommentInboxItem[];
  counts: ReturnType<typeof countBuckets>;
  /** Threads that are not resolved — the header chip and the rail badge. */
  unresolvedCount: number;
}

export function useSessionCommentInbox({
  sessionId,
  sessionTopic,
  comments,
  displayItems,
  ownerName,
  viewerIsOwner,
  viewerId,
}: {
  sessionId: string;
  sessionTopic: string | null | undefined;
  comments: MessageCommentThread[];
  displayItems: DisplayItem[];
  ownerName: string;
  viewerIsOwner: boolean;
  viewerId: string | null;
}): SessionCommentInbox {
  const describeCommentedMessage = useMemo(
    () => buildCommentedMessageDescriber(displayItems, { ownerName, viewerIsOwner }),
    [displayItems, ownerName, viewerIsOwner]
  );

  const items = useMemo<CommentInboxItem[]>(
    () =>
      comments.map((thread) => {
        const message = describeCommentedMessage(thread.anchor.messageId);
        return toInboxItem(thread, {
          kind: 'session',
          sessionId,
          sessionTopic: sessionTopic ?? 'This session',
          messageId: thread.anchor.messageId,
          messageDescription: message.loaded ? message.phrase : null,
        });
      }),
    [comments, describeCommentedMessage, sessionTopic, sessionId]
  );

  const counts = useMemo(() => countBuckets(items, viewerId), [items, viewerId]);

  return useMemo(
    () => ({
      describeCommentedMessage,
      items,
      counts,
      unresolvedCount: counts.all - counts.resolved,
    }),
    [describeCommentedMessage, items, counts]
  );
}
