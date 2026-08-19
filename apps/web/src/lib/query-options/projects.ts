import { queryOptions } from '@tanstack/react-query';

import { getProject, listProjects } from '../api';
import { QUERY_PERSIST_MAX_AGE_MS } from '../query-persist-config';

/**
 * `gcTime` for the ONE query the persister is allowed to write (`projects/list` —
 * see `query-persist-config.ts`).
 *
 * Applied to that query alone, never as a QueryClient default: a global `gcTime`
 * this long would pin node, workspace and admin-diagnosis data in memory too,
 * which is both a memory regression and data the security review says to keep
 * short-lived.
 *
 * Deliberately NOT applied to `projectDetail`. That query is not persisted, and
 * `useProjectIntentPrefetch` populates it after a 120 ms hover — so a 24 h
 * `gcTime` there would pin one full detail payload per project a user merely
 * scrolled past, with no eviction bound. It keeps the default 5 min instead.
 *
 * Matching the persist `maxAge` keeps the two eviction clocks aligned: a query
 * garbage-collected out of memory would be dropped from the next dehydrate, and a
 * restored entry evicted sooner than `maxAge` would make persistence pointless.
 */
const PERSISTED_QUERY_GC_TIME_MS = QUERY_PERSIST_MAX_AGE_MS;

export const projectQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'projects'] as const,
  lists: (queryScope: string) => [...projectQueryKeys.all(queryScope), 'list'] as const,
  list: (queryScope: string, limit?: number) =>
    [...projectQueryKeys.lists(queryScope), { limit: limit ?? null }] as const,
  details: (queryScope: string) => [...projectQueryKeys.all(queryScope), 'detail'] as const,
  detail: (queryScope: string, projectId: string) =>
    [...projectQueryKeys.details(queryScope), projectId] as const,
};

export function projectListQueryOptions(queryScope: string, limit?: number) {
  return queryOptions({
    queryKey: projectQueryKeys.list(queryScope, limit),
    queryFn: async () => (await listProjects(limit)).projects,
    gcTime: PERSISTED_QUERY_GC_TIME_MS,
  });
}

export function projectDetailQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: projectQueryKeys.detail(queryScope, projectId),
    queryFn: () => getProject(projectId),
  });
}
