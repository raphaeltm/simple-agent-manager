/**
 * Cross-surface comment inbox model.
 *
 * Comment threads are already anchor-agnostic at the presentation layer (see
 * `UiCommentThread` in `comment-utils.ts`). What was missing is a way to *find*
 * them: a thread lives next to the one message it annotates, so the only way to
 * discover an unresolved comment was to scroll the conversation that contains
 * it. This module adds the second half — a flat, sortable, groupable view over
 * threads from any anchor kind, shared by the session drawer and the
 * project-level Comments page so both cannot drift.
 *
 * Deliberately contains no fetching and no React: it is pure derivation over
 * threads the caller already has.
 */

import type { MessageCommentAuthor } from '../../../lib/api/comments';
import { authorDisplayName, type UiCommentThread } from './comment-utils';

/**
 * Where a thread is anchored. This is the ONLY part of an inbox item that
 * varies by anchor kind — everything else reads through `UiCommentThread`.
 */
export type CommentInboxSource =
  | {
      kind: 'session';
      sessionId: string;
      /** Human-readable session topic, for the "where is this?" line. */
      sessionTopic: string;
      /** Jump target inside the conversation. */
      messageId: string;
      /** Role of the annotated message, so the row can say "on SAM's reply". */
      messageRole?: 'user' | 'assistant' | null;
    }
  | {
      kind: 'library_file';
      fileId: string;
      fileName: string;
    };

export interface CommentInboxItem {
  thread: UiCommentThread;
  source: CommentInboxSource;
  /** Thread creation, or the most recent reply if there is one. */
  lastActivityAt: number;
  /** Author of that most recent activity. */
  lastActor: MessageCommentAuthor;
  /** Root comment + replies. */
  messageCount: number;
}

/**
 * The four states a reader actually cares about, in triage order.
 *
 * `needs_you` is the load-bearing one: it is the answer to "has anything
 * happened that I have not seen?", which is the question that currently has no
 * surface at all. It is derived, not stored — see `bucketFor`.
 */
export type CommentInboxBucket = 'needs_you' | 'with_agent' | 'open' | 'resolved';

export const COMMENT_BUCKET_LABELS: Record<CommentInboxBucket, string> = {
  needs_you: 'Needs you',
  with_agent: 'With agent',
  open: 'Open',
  resolved: 'Resolved',
};

/**
 * Bucket accent colours. Kept as raw token references rather than Tailwind
 * classes because the timeline dot needs a bare CSS colour string too, and one
 * source beats two that can disagree.
 */
export const COMMENT_BUCKET_COLORS: Record<CommentInboxBucket, string> = {
  needs_you: 'var(--sam-color-warning)',
  with_agent: 'var(--sam-color-info)',
  open: 'var(--sam-color-fg-muted)',
  resolved: 'var(--sam-color-success)',
};

export const COMMENT_BUCKET_ORDER: CommentInboxBucket[] = [
  'needs_you',
  'with_agent',
  'open',
  'resolved',
];

/**
 * Last activity on a thread. Replies are appended, but a thread can be
 * optimistically reordered mid-flight, so take the max rather than the tail.
 */
function lastActivity(thread: UiCommentThread): { at: number; actor: MessageCommentAuthor } {
  let at = thread.createdAt;
  let actor = thread.author;
  for (const reply of thread.replies) {
    if (reply.createdAt >= at) {
      at = reply.createdAt;
      actor = reply.author;
    }
  }
  return { at, actor };
}

export function toInboxItem(thread: UiCommentThread, source: CommentInboxSource): CommentInboxItem {
  const { at, actor } = lastActivity(thread);
  return {
    thread,
    source,
    lastActivityAt: at,
    lastActor: actor,
    messageCount: thread.replies.length + 1,
  };
}

/**
 * Which bucket an item belongs to, from the perspective of `viewerId`.
 *
 * Note this is a *derived* signal, not a read receipt: "the last person to
 * speak was not me" is a good enough proxy for "your turn" without inventing
 * per-user read state. A real read model would refine `needs_you` only — the
 * other three buckets are viewer-independent.
 */
export function bucketFor(item: CommentInboxItem, viewerId: string | null): CommentInboxBucket {
  return bucketForThread(item.thread.status, item.lastActor.id, viewerId);
}

/**
 * The same rule, for callers that have already reduced a thread to its last
 * actor and do not need a full `CommentInboxItem`.
 *
 * This exists so the chat timeline can key its dot to the *bucket* rather than
 * to the raw `status`. Keying on status looked equivalent and was not: a thread
 * you replied to last is `status: 'open'` but belongs in the neutral `open`
 * bucket, not `needs_you` — so the timeline rendered it amber ("waiting on
 * you") while the drawer rendered the very same thread grey. One definition,
 * two entry points, so the two surfaces cannot disagree again.
 */
export function bucketForThread(
  status: UiCommentThread['status'],
  lastActorId: string,
  viewerId: string | null
): CommentInboxBucket {
  if (status === 'resolved') return 'resolved';
  if (status === 'sent') return 'with_agent';
  if (viewerId && lastActorId !== viewerId) return 'needs_you';
  return 'open';
}

/** Newest activity first — the only ordering that makes an inbox scannable. */
export function byRecency(a: CommentInboxItem, b: CommentInboxItem): number {
  return b.lastActivityAt - a.lastActivityAt;
}

export type CommentInboxFilter = 'all' | CommentInboxBucket;

export interface CommentInboxCounts extends Record<CommentInboxBucket, number> {
  all: number;
}

export function countBuckets(
  items: readonly CommentInboxItem[],
  viewerId: string | null
): CommentInboxCounts {
  const counts: CommentInboxCounts = {
    all: items.length,
    needs_you: 0,
    with_agent: 0,
    open: 0,
    resolved: 0,
  };
  for (const item of items) counts[bucketFor(item, viewerId)] += 1;
  return counts;
}

export function filterInbox(
  items: readonly CommentInboxItem[],
  filter: CommentInboxFilter,
  viewerId: string | null
): CommentInboxItem[] {
  const matching =
    filter === 'all' ? [...items] : items.filter((item) => bucketFor(item, viewerId) === filter);
  return matching.sort(byRecency);
}

export interface CommentInboxGroup {
  bucket: CommentInboxBucket;
  items: CommentInboxItem[];
}

/** Groups in triage order, omitting empty buckets so the page has no dead headings. */
export function groupInbox(
  items: readonly CommentInboxItem[],
  viewerId: string | null
): CommentInboxGroup[] {
  const groups = new Map<CommentInboxBucket, CommentInboxItem[]>();
  for (const item of items) {
    const bucket = bucketFor(item, viewerId);
    const existing = groups.get(bucket);
    if (existing) existing.push(item);
    else groups.set(bucket, [item]);
  }
  return COMMENT_BUCKET_ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    bucket,
    items: (groups.get(bucket) ?? []).sort(byRecency),
  }));
}

/**
 * One-line "what happened last", e.g. `SAM replied` / `You commented`.
 * Written from the viewer's perspective because that is what makes a list of
 * twenty threads readable at a glance.
 */
export function lastActivitySummary(item: CommentInboxItem, viewerId: string | null): string {
  const isViewer = Boolean(viewerId) && item.lastActor.id === viewerId;
  const who = isViewer ? 'You' : authorDisplayName(item.lastActor);
  const isReply = item.messageCount > 1 && item.lastActivityAt !== item.thread.createdAt;
  if (!isReply) return `${who} commented`;
  return `${who} replied`;
}

/** Short "where does this live" label for a cross-source list. */
export function sourceLabel(source: CommentInboxSource): string {
  return source.kind === 'session' ? source.sessionTopic : source.fileName;
}
