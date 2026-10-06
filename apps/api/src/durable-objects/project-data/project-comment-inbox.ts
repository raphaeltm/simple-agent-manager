/**
 * Project-wide comment inbox — the cross-anchor read behind
 * `GET /api/projects/:projectId/comments`.
 *
 * Message threads and library-file threads live in physically separate tables
 * (.claude/rules/63), each owned by its own module. This module is the one place
 * that reads both and applies a *single* budget across them, so the page can ask
 * "what is outstanding in this project" in one request instead of fanning out a
 * request per session and per file.
 *
 * It deliberately does not merge the two into a union type. They are different
 * shapes, and keeping them apart lets the existing per-kind client mappers be
 * reused unchanged.
 */

import type { LibraryFileCommentThread, MessageCommentThread } from '@simple-agent-manager/shared';

import type {
  ListProjectCommentThreadsInput,
  ProjectCommentInboxResult,
  ProjectCommentThreadCandidate,
} from './comment-contracts';
import {
  resolveProjectCommentListLimit,
  resolveProjectCommentListMaxBytes,
} from './comment-normalization';
import {
  hydrateProjectCommentThreads,
  listProjectCommentThreadCandidates,
  readSessionTopics,
} from './comments';
import {
  hydrateProjectFileCommentThreads,
  listProjectFileCommentThreadCandidates,
} from './library-file-comments';
import type { Env } from './types';

/** One thread plus which table it came from, so the merge can split back. */
type RankedThread =
  | { kind: 'message'; candidate: ProjectCommentThreadCandidate }
  | { kind: 'file'; candidate: ProjectCommentThreadCandidate };

function compareRankedThread(a: RankedThread, b: RankedThread): number {
  if (b.candidate.updatedAt !== a.candidate.updatedAt) {
    return b.candidate.updatedAt - a.candidate.updatedAt;
  }
  if (a.candidate.id < b.candidate.id) return -1;
  if (a.candidate.id > b.candidate.id) return 1;
  return 0;
}

/**
 * Reads both anchor kinds and keeps the `limit` most recently active threads
 * across the two.
 *
 * The cap is applied to the *union*, not per source, so one very chatty
 * conversation cannot crowd library threads out of the page and vice versa.
 * Correctness of taking the top `limit` after merging: each source is asked for
 * its own `limit + 1` newest rows, and the true top `limit` of the union is
 * necessarily contained in the union of each source's top `limit` — a thread
 * excluded from its own source's page is older than `limit` threads already in
 * hand, so it cannot belong in the merged page either.
 *
 * `totalCount` is a real `COUNT(*)` over both tables rather than a derived
 * guess, so the UI can state how much it is not showing (.claude/rules/65).
 */
export function listProjectCommentInbox(
  sql: SqlStorage,
  env: Env,
  input: ListProjectCommentThreadsInput
): ProjectCommentInboxResult {
  const limit = resolveProjectCommentListLimit(env, input.limit);
  const maxBytes = resolveProjectCommentListMaxBytes(env);
  const status = input.status ?? null;

  const messagePage = listProjectCommentThreadCandidates(sql, { status, limit });
  const filePage = listProjectFileCommentThreadCandidates(sql, { status, limit });

  // Merge on `updatedAt`, breaking ties by id so repeated identical calls return
  // an identical sequence (rule 65: ties need a total order, or the payload
  // permutes between calls and defeats caching).
  const ranked: RankedThread[] = [
    ...messagePage.candidates.map((candidate): RankedThread => ({ kind: 'message', candidate })),
    ...filePage.candidates.map((candidate): RankedThread => ({ kind: 'file', candidate })),
  ].sort(compareRankedThread);

  const page: RankedThread[] = [];
  let selectedBytes = 0;
  for (const entry of ranked) {
    if (page.length >= limit) break;
    const nextBytes = selectedBytes + entry.candidate.estimatedBytes;
    if (nextBytes > maxBytes) continue;
    page.push(entry);
    selectedBytes = nextBytes;
  }

  const totalCount = messagePage.totalCount + filePage.totalCount;

  const messageIds = page
    .filter(
      (entry): entry is Extract<RankedThread, { kind: 'message' }> => entry.kind === 'message'
    )
    .map((entry) => entry.candidate.id);
  const fileIds = page
    .filter((entry): entry is Extract<RankedThread, { kind: 'file' }> => entry.kind === 'file')
    .map((entry) => entry.candidate.id);

  const messageThreads: MessageCommentThread[] = hydrateProjectCommentThreads(sql, messageIds);
  const fileThreads: LibraryFileCommentThread[] = hydrateProjectFileCommentThreads(sql, fileIds);
  const returnedCount = messageThreads.length + fileThreads.length;

  const sessionIds = [...new Set(messageThreads.map((thread) => thread.sessionId))];

  return {
    messageThreads,
    fileThreads,
    sessions: readSessionTopics(sql, sessionIds),
    // Truncated either because the merge overflowed the budget, or because a
    // source reported more rows than it returned. `totalCount` is the honest
    // signal; this stays for callers that only need the boolean.
    hasMore: totalCount > returnedCount,
    totalCount,
  };
}
