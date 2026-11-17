/**
 * Project-wide comment inbox — the cross-anchor read behind
 * `GET /api/projects/:projectId/comments`.
 *
 * Every anchor kind lives in the shared anchored comment tables (DO migration 073), so the
 * inbox is one ranked read with a single budget, then a split back into the per-kind API
 * shapes. The response keeps message, file and inbox-item threads apart because the clients
 * map them with different mappers.
 */
import {
  countReadableProjectThreads,
  hydrateThreadRecordsByIds,
  listProjectThreadCandidates,
} from './anchored-comment-store';
import type {
  ListProjectCommentThreadsInput,
  ProjectCommentInboxResult,
  ProjectCommentThreadCandidate,
} from './comment-contracts';
import {
  resolveProjectCommentListLimit,
  resolveProjectCommentListMaxBytes,
} from './comment-normalization';
import { readSessionTopics, toMessageCommentThread } from './comments';
import { toInboxItemCommentThread } from './inbox-item-comments';
import { toLibraryFileCommentThread } from './library-file-comments';
import type { Env } from './types';

/**
 * The `limit` most recently active threads across every anchor kind that fit the byte budget.
 *
 * One ranking over every kind, by recency: no kind has a reserved share, so a page can be all
 * message threads when those are the most recently active (the same rule as before the tables
 * were unified). The ranking is `updated_at DESC, id ASC`, a total order, so repeated calls
 * return the same sequence. Candidates are read in windows of `limit + 1`; a thread that would
 * overflow the RPC payload budget is skipped and the next window is read, so oversized recent
 * threads cannot empty the page while older ones fit. Inbox-item authorization is applied before
 * either selection or counting, so private task activity cannot leak through pagination metadata
 * or crowd visible threads out of the page.
 */
export function listProjectCommentInbox(
  sql: SqlStorage,
  env: Env,
  input: ListProjectCommentThreadsInput
): ProjectCommentInboxResult {
  const limit = resolveProjectCommentListLimit(env, input.limit);
  const maxBytes = resolveProjectCommentListMaxBytes(env);
  const status = input.status ?? null;
  const readableInboxItemIds = new Set(input.readableInboxItemIds ?? []);

  const selectedIds: string[] = [];
  let selectedBytes = 0;
  let after: ProjectCommentThreadCandidate | null = null;
  // Each window is `limit + 1` rows of ids and sizes. Every pass either fills the page or
  // advances the cursor, so the loop ends after at most totalCount / (limit + 1) + 1 windows.
  for (;;) {
    const window = listProjectThreadCandidates(sql, { status, limit, after });
    for (const candidate of window.candidates) {
      if (selectedIds.length >= limit) break;
      if (
        candidate.anchorKind === 'inbox_item' &&
        (!candidate.inboxItemId || !readableInboxItemIds.has(candidate.inboxItemId))
      ) {
        continue;
      }
      const nextBytes = selectedBytes + candidate.estimatedBytes;
      if (nextBytes > maxBytes) continue;
      selectedIds.push(candidate.id);
      selectedBytes = nextBytes;
    }
    const last = window.candidates.at(-1);
    if (selectedIds.length >= limit || !window.windowFull || !last) break;
    after = last;
  }

  const records = hydrateThreadRecordsByIds(sql, selectedIds);
  const messageThreads = records.flatMap((record) => toMessageCommentThread(record) ?? []);
  const fileThreads = records.flatMap((record) => toLibraryFileCommentThread(record) ?? []);
  const inboxItemThreads = records.flatMap((record) => toInboxItemCommentThread(record) ?? []);
  const returnedCount = messageThreads.length + fileThreads.length + inboxItemThreads.length;
  const sessionIds = [...new Set(messageThreads.map((thread) => thread.sessionId))];
  const totalCount = countReadableProjectThreads(sql, status, [...readableInboxItemIds]);

  return {
    messageThreads,
    fileThreads,
    inboxItemThreads,
    sessions: readSessionTopics(sql, sessionIds),
    // Truncated either because the byte budget skipped a thread, or because more rows match
    // than were returned. `totalCount` is the honest signal; this stays for callers that
    // only need the boolean.
    hasMore: totalCount > returnedCount,
    totalCount,
  };
}
