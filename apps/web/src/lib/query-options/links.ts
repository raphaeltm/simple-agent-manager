import { queryOptions } from '@tanstack/react-query';

import { getIdeaLinks, getLibraryFileLinks, getSessionLinks } from '../api/links';

/**
 * Linked work for one chat or one library file.
 *
 * Keys follow the app-wide `['auth', queryScope, domain, operation, …]` shape documented in
 * `query-options/index.ts`, which `query-persist-config.ts` parses positionally.
 *
 * Deliberately NOT added to `PERSISTED_QUERY_OPERATIONS`: these responses carry chat topics,
 * idea titles and filenames — chat-derived free text, which is on the
 * never-persist-without-security-review list.
 *
 * Both the chat header's "Working on" chip, the tool rail's Related badge and the Related
 * drawer read the session key, so they share one in-flight request and one cache entry; the
 * drawer does not re-fetch when it opens.
 */
export const linkedWorkQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'linked-work'] as const,
  idea: (queryScope: string, projectId: string, ideaId: string) =>
    [...linkedWorkQueryKeys.all(queryScope), 'idea', projectId, ideaId] as const,
  session: (queryScope: string, projectId: string, sessionId: string) =>
    [...linkedWorkQueryKeys.all(queryScope), 'session', projectId, sessionId] as const,
  libraryFile: (queryScope: string, projectId: string, fileId: string) =>
    [...linkedWorkQueryKeys.all(queryScope), 'library-file', projectId, fileId] as const,
};

export function ideaLinksQueryOptions(queryScope: string, projectId: string, ideaId: string) {
  return queryOptions({
    queryKey: linkedWorkQueryKeys.idea(queryScope, projectId, ideaId),
    queryFn: ({ signal }) => getIdeaLinks(projectId, ideaId, { signal }),
  });
}

export function sessionLinksQueryOptions(queryScope: string, projectId: string, sessionId: string) {
  return queryOptions({
    queryKey: linkedWorkQueryKeys.session(queryScope, projectId, sessionId),
    queryFn: ({ signal }) => getSessionLinks(projectId, sessionId, { signal }),
  });
}

export function libraryFileLinksQueryOptions(
  queryScope: string,
  projectId: string,
  fileId: string
) {
  return queryOptions({
    queryKey: linkedWorkQueryKeys.libraryFile(queryScope, projectId, fileId),
    queryFn: ({ signal }) => getLibraryFileLinks(projectId, fileId, { signal }),
  });
}
