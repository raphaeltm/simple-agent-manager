import type {
  MessageCommentAction,
  MessageCommentAuthor,
  MessageCommentReply,
  MessageCommentStatus,
  MessageCommentThread,
} from '../../../lib/api/comments';

export type CommentSyncState = 'synced' | 'pending' | 'failed';

export type UiMessageCommentReply = MessageCommentReply & {
  syncState?: CommentSyncState;
};

/**
 * The anchor-agnostic subset of a comment thread that the presentational
 * components (`CommentThread`, `CommentThreadList`) actually render.
 *
 * Anchoring is the ONLY thing that differs between a message comment and a
 * library-file comment, and these components never read the anchor beyond its
 * quote. Typing them on this instead of on `UiMessageCommentThread` is what lets
 * library-file threads reuse them without forging a `kind: 'message'` anchor.
 */
export type UiCommentThread = {
  id: string;
  clientId?: string | null;
  projectId?: string;
  author: MessageCommentAuthor;
  body: string;
  status: MessageCommentStatus;
  createdAt: number;
  updatedAt: number;
  anchor: { quote?: string | null };
  replies: UiMessageCommentReply[];
  syncState?: CommentSyncState;
};

export type UiMessageCommentThread = Omit<MessageCommentThread, 'replies'> & {
  replies: UiMessageCommentReply[];
  syncState?: CommentSyncState;
};

export interface MessageCommentDraft {
  anchorId: string;
  quote?: string;
}

export interface MessageCommentSummary {
  count: number;
  unresolvedCount: number;
}

export const COMMENT_STATUS_LABELS = {
  open: 'Open',
  sent: 'Sent to agent',
  resolved: 'Resolved',
} satisfies Record<MessageCommentStatus, string>;

let optimisticIdSequence = 0;

function createOptimisticIdSegment(): string {
  const cryptoApi = globalThis.crypto;

  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const values = cryptoApi.getRandomValues(new Uint32Array(4));
    return Array.from(values, (value) => value.toString(36).padStart(7, '0')).join('');
  }

  optimisticIdSequence += 1;
  return `${Date.now().toString(36)}-${optimisticIdSequence.toString(36)}`;
}

export function createOptimisticId(prefix: string): string {
  return `optimistic:${prefix}:${createOptimisticIdSegment()}`;
}

export function commentsForMessage(
  comments: readonly UiMessageCommentThread[],
  messageId: string
): UiMessageCommentThread[] {
  return comments.filter((comment) => comment.anchor.messageId === messageId);
}

export function summarizeComments(comments: readonly UiMessageCommentThread[]): MessageCommentSummary {
  return {
    count: comments.length,
    unresolvedCount: comments.filter((comment) => comment.status !== 'resolved').length,
  };
}

export function relativeCommentTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function authorDisplayName(author: MessageCommentAuthor): string {
  return author.name?.trim() || author.email?.split('@')[0] || (author.kind === 'agent' ? 'Agent' : 'Someone');
}

export function buildOptimisticAuthor(user: {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
} | null): MessageCommentAuthor {
  return {
    id: user?.id ?? 'optimistic-user',
    name: user?.name ?? user?.email?.split('@')[0] ?? 'You',
    email: user?.email ?? null,
    avatarUrl: user?.image ?? null,
    kind: 'human',
  };
}

export function normalizeThread(thread: MessageCommentThread): UiMessageCommentThread {
  return {
    ...thread,
    replies: thread.replies.map((reply) => ({ ...reply, syncState: 'synced' })),
    syncState: 'synced',
  };
}

export function threadStatusForAction(action: MessageCommentAction): MessageCommentStatus {
  return action === 'send_to_agent' ? 'sent' : 'open';
}

export function upsertThread(
  previous: readonly UiMessageCommentThread[] | undefined,
  incoming: MessageCommentThread
): UiMessageCommentThread[] {
  const normalized = normalizeThread(incoming);
  const current = previous ?? [];
  const index = current.findIndex((candidate) => {
    if (candidate.id === incoming.id) return true;
    return Boolean(candidate.clientId && incoming.clientId && candidate.clientId === incoming.clientId);
  });
  if (index === -1) return [...current, normalized].sort(compareThreads);
  return [...current.slice(0, index), normalized, ...current.slice(index + 1)].sort(compareThreads);
}

export function compareThreads(a: UiMessageCommentThread, b: UiMessageCommentThread): number {
  if (a.anchor.messageId !== b.anchor.messageId) {
    return a.anchor.messageId.localeCompare(b.anchor.messageId);
  }
  return a.createdAt - b.createdAt;
}
