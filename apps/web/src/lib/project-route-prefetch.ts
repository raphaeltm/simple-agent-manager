import type { QueryClient } from '@tanstack/react-query';
import { matchPath } from 'react-router';

import { type ChatSessionListItem, listChatSessions } from './api';
import { CHAT_SESSION_LIST_LIMIT } from './chat-query-config';
import {
  chatSessionMessagesQueryOptions,
  projectChatSessionsQueryOptions,
  projectDetailQueryOptions,
} from './query-options';

/**
 * The project chat sidebar's first session-list read.
 *
 * `useProjectChatState` reads it once through the query cache so it can join a read
 * {@link prefetchProjectRoute} already started, then drops the entry: every later list
 * read goes straight to the network, as it did before, so a remount never shows a list
 * older than the client's default `staleTime`.
 */
export function initialChatSessionListQueryOptions(queryScope: string, projectId: string) {
  return projectChatSessionsQueryOptions(queryScope, projectId, CHAT_SESSION_LIST_LIMIT, true);
}

/**
 * The chat page's first session-list read for a project.
 *
 * Joins the read {@link prefetchProjectRoute} started, or reuses its result while it is
 * within the client's default `staleTime`, then removes the entry so it is consumed once.
 * `prefetched` says the list came from the route read, which started before the chat's
 * socket could subscribe: a session created in between reached no socket.
 */
export async function readInitialSessionList(
  queryClient: QueryClient,
  queryScope: string,
  projectId: string
): Promise<{ sessions: ChatSessionListItem[]; prefetched: boolean }> {
  if (!queryScope) {
    const { sessions } = await listChatSessions(projectId, {
      limit: CHAT_SESSION_LIST_LIMIT,
      includeLive: true,
    });
    return { sessions, prefetched: false };
  }
  const options = initialChatSessionListQueryOptions(queryScope, projectId);
  const prefetched = queryClient.getQueryState(options.queryKey) !== undefined;
  try {
    return { sessions: await queryClient.fetchQuery(options), prefetched };
  } finally {
    queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
  }
}

/** Transcript queries a route prefetch is reading for a conversation that has not opened yet. */
const routePrefetchedTranscripts = new Set<string>();

/**
 * Whether the route prefetch started this transcript's read for the conversation now
 * opening. Consumed by that first open.
 *
 * Opening a chat normally reconciles its cached transcript with the server however fresh
 * it is (`useSessionTranscript`). A transcript the route read moments ago, for this very
 * open, has nothing to reconcile, so that open reconciles only if it has gone stale.
 */
export function takeRoutePrefetchedTranscript(queryHash: string): boolean {
  return routePrefetchedTranscripts.delete(queryHash);
}

/**
 * Starts the reads a cold project deep link will need, at the moment the project route
 * mounts — beside its route-chunk preloads, instead of each read waiting for the
 * component that consumes it.
 *
 * Without this a deep link to `/projects/:id/chat/:sessionId` reads serially: the
 * project detail waits for the `Project` chunk, the chat page waits for the project
 * detail, and the transcript waited for the session list. The URL already names every
 * one of them.
 *
 * Every entry is keyed by the authenticated `queryScope`, exactly as its consumer keys
 * it, so a prefetch can only ever fill the signed-in user's own cache; the server
 * authorises each read as usual.
 */
export function prefetchProjectRoute(
  queryClient: QueryClient,
  queryScope: string,
  pathname: string
): void {
  if (!queryScope) return;
  const project = matchPath('/projects/:id/*', pathname);
  const projectId = project?.params.id;
  if (!projectId) return;

  void queryClient.prefetchQuery(projectDetailQueryOptions(queryScope, projectId));

  const selected = matchPath('/projects/:id/chat/:sessionId', pathname);
  const chatRoute =
    selected ??
    matchPath('/projects/:id/chat', pathname) ??
    // The project index redirects to its chat.
    matchPath('/projects/:id', pathname);
  if (!chatRoute) return;

  void queryClient.prefetchQuery(initialChatSessionListQueryOptions(queryScope, projectId));
  const sessionId = selected?.params.sessionId;
  if (sessionId) {
    const transcript = chatSessionMessagesQueryOptions(queryScope, projectId, sessionId);
    void queryClient.prefetchQuery(transcript);
    // Only a read actually in flight is fresh for the open: a cached copy the prefetch
    // judged fresh enough to skip still gets the open's reconcile.
    const query = queryClient.getQueryCache().find({ queryKey: transcript.queryKey, exact: true });
    if (query?.state.fetchStatus === 'fetching') routePrefetchedTranscripts.add(query.queryHash);
  }
}
