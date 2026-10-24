/**
 * Query keys and options for the Ideas list and the idea page.
 *
 * Keys follow the barrel's invariant, `['auth', queryScope, 'ideas', …]`. Neither is
 * persisted: an idea carries the title and plan a person wrote, plus agent-written notes.
 *
 * Derived state moves on its own — a chat starts, a pull request opens, an agent asks
 * something — so both reads poll while the tab is visible. `poll-intervals.ts` explains why
 * `refetchInterval` is the right mechanism: it stops on a hidden tab, which a bare
 * `setInterval` never did.
 */
import { queryOptions } from '@tanstack/react-query';

import { getIdeaLinks, getProjectIdea, listIdeaUpdates, listProjectIdeas } from '../api';
import { IDEA_DETAIL_POLL_MS, IDEAS_POLL_MS } from '../poll-intervals';

export const ideaQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'ideas'] as const,
  list: (queryScope: string, projectId: string) =>
    [...ideaQueryKeys.all(queryScope), 'list', projectId] as const,
  detail: (queryScope: string, projectId: string, ideaId: string) =>
    [...ideaQueryKeys.all(queryScope), 'detail', projectId, ideaId] as const,
  updates: (queryScope: string, projectId: string, ideaId: string) =>
    [...ideaQueryKeys.all(queryScope), 'updates', projectId, ideaId] as const,
  links: (queryScope: string, projectId: string, ideaId: string) =>
    [...ideaQueryKeys.all(queryScope), 'links', projectId, ideaId] as const,
};

export function ideasListQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: ideaQueryKeys.list(queryScope, projectId),
    queryFn: () => listProjectIdeas(projectId),
    refetchInterval: IDEAS_POLL_MS,
  });
}

export function ideaDetailQueryOptions(queryScope: string, projectId: string, ideaId: string) {
  return queryOptions({
    queryKey: ideaQueryKeys.detail(queryScope, projectId, ideaId),
    queryFn: () => getProjectIdea(projectId, ideaId),
    refetchInterval: IDEA_DETAIL_POLL_MS,
  });
}

/**
 * The idea's updates timeline (T3). Polled with the page: an agent can post a note while you
 * are reading, and that is the point of the timeline.
 */
export function ideaUpdatesQueryOptions(queryScope: string, projectId: string, ideaId: string) {
  return queryOptions({
    queryKey: ideaQueryKeys.updates(queryScope, projectId, ideaId),
    queryFn: () => listIdeaUpdates(projectId, ideaId),
    refetchInterval: IDEA_DETAIL_POLL_MS,
  });
}

/**
 * What else is linked to the idea (T1): its files, its related ideas, and the chats and pull
 * requests recorded against it. Not polled — links change when work happens, and the detail
 * read already carries the state that moves.
 */
export function ideaLinksQueryOptions(queryScope: string, projectId: string, ideaId: string) {
  return queryOptions({
    queryKey: ideaQueryKeys.links(queryScope, projectId, ideaId),
    queryFn: () => getIdeaLinks(projectId, ideaId),
  });
}
