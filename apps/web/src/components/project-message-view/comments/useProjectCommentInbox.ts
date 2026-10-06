import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { projectCommentsQueryOptions } from '../../../lib/query-options';
import { fileThreadToUi } from '../../library/useLibraryFileComments';
import { type CommentInboxItem, toInboxItem } from './comment-inbox';
import { normalizeThread } from './comment-utils';

export interface ProjectCommentInboxResult {
  items: CommentInboxItem[];
  loading: boolean;
  /** Threads shown. */
  shownCount: number;
  /** Threads that exist in the project, shown or not. */
  totalCount: number;
  /**
   * True when the server's page limit kept the response from covering every
   * thread. The page MUST surface this: a capped list that looks complete is
   * worse than no list, because the reader concludes there is nothing
   * outstanding (.claude/rules/65).
   */
  truncated: boolean;
}

/**
 * Project-wide comment inbox.
 *
 * One request. `GET /api/projects/:projectId/comments` returns every thread in
 * the project — chat and library — ranked by last activity, with the session
 * topics and filenames needed to say where each one lives.
 *
 * This used to be a client-side join that fanned out one request per recent
 * session plus one per library file (up to 52 per page load) because no
 * project-scoped endpoint existed. It does now, so the fan-out is gone: the cap
 * is applied server-side across both anchor kinds, and `totalCount` comes from a
 * real count rather than being inferred from how many sources were scanned.
 */
export function useProjectCommentInbox(projectId: string): ProjectCommentInboxResult {
  const queryScope = useQueryScope();
  const enabled = Boolean(projectId && queryScope);

  const query = useQuery({
    ...projectCommentsQueryOptions(queryScope, projectId),
    enabled,
  });

  const items = useMemo<CommentInboxItem[]>(() => {
    const data = query.data;
    if (!data) return [];

    const collected: CommentInboxItem[] = [];

    for (const thread of data.messageThreads) {
      collected.push(
        toInboxItem(normalizeThread(thread), {
          kind: 'session',
          sessionId: thread.sessionId,
          sessionTopic: data.sessionTopics.get(thread.sessionId) || 'Untitled chat',
          messageId: thread.anchor.messageId,
        })
      );
    }

    for (const thread of data.fileThreads) {
      collected.push(
        toInboxItem(fileThreadToUi(thread), {
          kind: 'library_file',
          fileId: thread.fileId,
          // A thread outlives its file: the row is in the Durable Object, the
          // filename is in D1. Falling back keeps a thread whose file was
          // deleted visible and labelled rather than silently dropping it.
          fileName: data.fileNames.get(thread.fileId) ?? 'Deleted file',
        })
      );
    }

    return collected;
  }, [query.data]);

  // Stale-while-revalidate: only the first pass, before anything has arrived,
  // may gate rendering (.claude/rules/48).
  const shownCount = items.length;
  return {
    items,
    loading: enabled && query.isPending,
    shownCount,
    totalCount: query.data?.totalCount ?? shownCount,
    truncated: query.data?.hasMore ?? false,
  };
}
