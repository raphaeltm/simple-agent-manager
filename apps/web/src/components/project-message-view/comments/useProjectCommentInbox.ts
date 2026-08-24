import {
  DEFAULT_PROJECT_COMMENT_INBOX_FILE_LIMIT,
  DEFAULT_PROJECT_COMMENT_INBOX_SESSION_LIMIT,
} from '@simple-agent-manager/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { listLibraryFiles } from '../../../lib/api/library';
import {
  libraryFileCommentsQueryOptions,
  messageCommentsQueryOptions,
  projectChatSessionsQueryOptions,
} from '../../../lib/query-options';
import { fileThreadToUi } from '../../library/useLibraryFileComments';
import { type CommentInboxItem, toInboxItem } from './comment-inbox';
import { normalizeThread } from './comment-utils';

function envInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ProjectCommentInboxResult {
  items: CommentInboxItem[];
  loading: boolean;
  /** Sources actually scanned, and how many exist — see `coverageNote`. */
  scannedSessions: number;
  scannedFiles: number;
  /**
   * True when the fan-out cap kept the scan from covering every source. The page
   * MUST surface this: a capped list that looks complete is worse than no list,
   * because the reader concludes there is nothing outstanding (rule 65).
   */
  truncated: boolean;
}

/**
 * Project-wide comment inbox, assembled by fanning out over recent sessions and
 * library files.
 *
 * This is a client-side join standing in for an endpoint that does not exist
 * yet. It is honest about that: the fan-out is bounded by explicit limits and
 * reports whether it was truncated, so the UI can say "scanned the 25 most
 * recent sessions" rather than implying it looked everywhere. A production
 * build of this feature should add `GET /api/projects/:id/comments` and delete
 * the fan-out — the returned shape is designed so only this file changes.
 */
export function useProjectCommentInbox(projectId: string): ProjectCommentInboxResult {
  const queryScope = useQueryScope();
  const enabled = Boolean(projectId && queryScope);

  const sessionLimit = envInt(
    import.meta.env.VITE_PROJECT_COMMENT_INBOX_SESSION_LIMIT,
    DEFAULT_PROJECT_COMMENT_INBOX_SESSION_LIMIT
  );
  const fileLimit = envInt(
    import.meta.env.VITE_PROJECT_COMMENT_INBOX_FILE_LIMIT,
    DEFAULT_PROJECT_COMMENT_INBOX_FILE_LIMIT
  );

  const sessionsQuery = useQuery({
    ...projectChatSessionsQueryOptions(queryScope, projectId, sessionLimit),
    enabled,
  });

  const filesQuery = useQuery({
    queryKey: ['auth', queryScope, 'comment-inbox-files', projectId, fileLimit],
    queryFn: async () =>
      (await listLibraryFiles(projectId, { limit: fileLimit, sortBy: 'updatedAt', sortOrder: 'desc' }))
        .files,
    enabled,
  });

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);

  const sessionThreadQueries = useQueries({
    queries: sessions.map((session) => ({
      ...messageCommentsQueryOptions(queryScope, projectId, session.id),
      enabled,
    })),
  });

  const fileThreadQueries = useQueries({
    queries: files.map((file) => ({
      ...libraryFileCommentsQueryOptions(queryScope, projectId, file.id),
      enabled,
    })),
  });

  const items = useMemo<CommentInboxItem[]>(() => {
    const collected: CommentInboxItem[] = [];

    sessions.forEach((session, index) => {
      for (const thread of sessionThreadQueries[index]?.data ?? []) {
        collected.push(
          toInboxItem(normalizeThread(thread), {
            kind: 'session',
            sessionId: session.id,
            sessionTopic: session.topic || 'Untitled chat',
            messageId: thread.anchor.messageId,
          })
        );
      }
    });

    files.forEach((file, index) => {
      for (const thread of fileThreadQueries[index]?.data ?? []) {
        collected.push(
          toInboxItem(fileThreadToUi(thread), {
            kind: 'library_file',
            fileId: file.id,
            fileName: file.filename,
          })
        );
      }
    });

    return collected;
  }, [sessions, files, sessionThreadQueries, fileThreadQueries]);

  // Stale-while-revalidate: only the first pass, before anything has arrived,
  // may gate rendering (rule 48).
  const loading =
    enabled &&
    sessionsQuery.isPending &&
    filesQuery.isPending &&
    items.length === 0;

  return {
    items,
    loading,
    scannedSessions: sessions.length,
    scannedFiles: files.length,
    truncated: sessions.length >= sessionLimit || files.length >= fileLimit,
  };
}
