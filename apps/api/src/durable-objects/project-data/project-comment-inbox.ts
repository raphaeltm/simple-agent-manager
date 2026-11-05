/**
 * Project-wide comment inbox — the cross-anchor read behind
 * `GET /api/projects/:projectId/comments`.
 *
 * Every anchor kind lives in the shared anchored comment tables (DO migration 073), so the
 * inbox is one ranked read with a single budget, then a split back into the per-kind API
 * shapes. The response keeps message and file threads apart because the clients map them
 * with different mappers.
 */
import { hydrateThreadRecordsByIds, listProjectThreadCandidates } from './anchored-comment-store';
import type {
  ListProjectCommentThreadsInput,
  ProjectCommentInboxResult,
} from './comment-contracts';
import {
  resolveProjectCommentListLimit,
  resolveProjectCommentListMaxBytes,
} from './comment-normalization';
import { readSessionTopics, toMessageCommentThread } from './comments';
import { toLibraryFileCommentThread } from './library-file-comments';
import type { Env } from './types';

/**
 * The `limit` most recently active threads across every anchor kind.
 *
 * The cap applies to the union, so one chatty conversation cannot crowd library threads off
 * the page. The ranking reads `limit + 1` candidates in `updated_at DESC, id ASC` order (a
 * total order, so repeated calls return the same sequence), then the byte budget skips any
 * thread that would overflow the RPC payload. `totalCount` is a real `COUNT(*)`, so the UI
 * can say how much it is not showing (.claude/rules/65).
 */
export function listProjectCommentInbox(
  sql: SqlStorage,
  env: Env,
  input: ListProjectCommentThreadsInput
): ProjectCommentInboxResult {
  const limit = resolveProjectCommentListLimit(env, input.limit);
  const maxBytes = resolveProjectCommentListMaxBytes(env);
  const page = listProjectThreadCandidates(sql, { status: input.status ?? null, limit });

  const selectedIds: string[] = [];
  let selectedBytes = 0;
  for (const candidate of page.candidates) {
    if (selectedIds.length >= limit) break;
    const nextBytes = selectedBytes + candidate.estimatedBytes;
    if (nextBytes > maxBytes) continue;
    selectedIds.push(candidate.id);
    selectedBytes = nextBytes;
  }

  const records = hydrateThreadRecordsByIds(sql, selectedIds);
  const messageThreads = records.flatMap((record) => toMessageCommentThread(record) ?? []);
  const fileThreads = records.flatMap((record) => toLibraryFileCommentThread(record) ?? []);
  const returnedCount = messageThreads.length + fileThreads.length;
  const sessionIds = [...new Set(messageThreads.map((thread) => thread.sessionId))];

  return {
    messageThreads,
    fileThreads,
    sessions: readSessionTopics(sql, sessionIds),
    // Truncated either because the byte budget skipped a thread, or because more rows match
    // than were returned. `totalCount` is the honest signal; this stays for callers that
    // only need the boolean.
    hasMore: page.totalCount > returnedCount,
    totalCount: page.totalCount,
  };
}
