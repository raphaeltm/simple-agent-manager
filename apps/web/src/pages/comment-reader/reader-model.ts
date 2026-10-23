/**
 * Pure derivations for the comment reader: which rendered row a comment is on, the comment
 * order the previous/next controls walk, and the link into the chat itself.
 */
import {
  type CommentInboxItem,
  groupInbox,
} from '../../components/project-message-view/comments/comment-inbox';
import { mergedRowAliases } from '../../components/project-message-view/message-aliases';
import type { DisplayItem } from '../../components/project-message-view/tool-call-groups';
import type { ChatMessageResponse } from '../../lib/api';

/**
 * Resolves a stored row id to the rendered row that shows it: the row itself, the reply a
 * streamed chunk was merged into, or the tool-call group a call or thought was folded into.
 */
export function buildRowLocator(
  rows: readonly ChatMessageResponse[],
  items: readonly DisplayItem[]
): (rowId: string) => string | null {
  const rowOf = new Map<string, string>();
  for (const item of items) {
    rowOf.set(item.id, item.id);
    if (item.kind === 'tool_call' && item.messageId) rowOf.set(item.messageId, item.id);
    if (item.kind !== 'tool_call_group') continue;
    for (const inner of item.items) {
      rowOf.set(inner.id, item.id);
      if (inner.kind === 'tool_call' && inner.messageId) rowOf.set(inner.messageId, item.id);
    }
  }
  for (const [rowId, itemId] of mergedRowAliases(rows, items)) {
    const row = rowOf.get(itemId);
    if (row && !rowOf.has(rowId)) rowOf.set(rowId, row);
  }
  return (rowId) => rowOf.get(rowId) ?? null;
}

export interface CommentNavigation {
  /** 1-based place of this comment in the Comments page order; null when not listed. */
  position: number | null;
  total: number;
  previous: CommentInboxItem | null;
  next: CommentInboxItem | null;
}

/**
 * Previous/next follow the Comments page's own order (triage buckets, newest first), over the
 * chat comments the reader can open. Library comments open in the library instead.
 */
export function commentNavigation(
  items: readonly CommentInboxItem[],
  viewerId: string | null,
  threadId: string
): CommentNavigation {
  const ordered = groupInbox(items, viewerId)
    .flatMap((group) => group.items)
    .filter((item) => item.source.kind === 'session');
  const index = ordered.findIndex((item) => item.thread.id === threadId);
  return {
    position: index === -1 ? null : index + 1,
    total: ordered.length,
    previous: index > 0 ? (ordered[index - 1] ?? null) : null,
    next: index !== -1 && index < ordered.length - 1 ? (ordered[index + 1] ?? null) : null,
  };
}

export function commentReaderPath(projectId: string, sessionId: string, threadId: string): string {
  return `/projects/${projectId}/comments/${encodeURIComponent(sessionId)}/${encodeURIComponent(threadId)}`;
}

/**
 * The chat at this comment: the thread opens focused, and the chat pages history in until
 * the commented message's own time, then lands on it.
 */
export function openInChatPath(
  projectId: string,
  sessionId: string,
  threadId: string,
  anchor: { messageId: string; createdAt: number | null }
): string {
  const params = new URLSearchParams({ commentThread: threadId, commentMessage: anchor.messageId });
  if (anchor.createdAt !== null) params.set('commentAt', String(anchor.createdAt));
  return `/projects/${projectId}/chat/${encodeURIComponent(sessionId)}?${params.toString()}`;
}
