import { queryOptions } from '@tanstack/react-query';

import { getProviderCatalog, listNodes, listWorkspaces } from '../api';
import { PROVIDER_CATALOG_STALE_TIME_MS } from '../query-stale-times';

/**
 * Node, workspace and provider-catalog reads.
 *
 * The node and workspace lists were already on TanStack Query, but with **unscoped**
 * keys (`['nodes','list']`, `['workspaces','list',status]`) declared inline in
 * `pages/Nodes.tsx` and `pages/Workspaces.tsx` — with `Nodes.tsx` importing
 * `workspacesKeys` across a page boundary. Relocating both here scopes them to the
 * authenticated identity and removes the page-to-page coupling.
 *
 * ## Was the unscoped key a cross-account leak?
 *
 * No — and the fix should not be described as one. `AuthProvider` clears the whole
 * QueryClient inside its identity-transition `useLayoutEffect` and renders `null`
 * (unmounting every consumer) while the transition is in flight, so a second user
 * could never observe the first user's entry. Unscoped keys are also structurally
 * unpersistable, because `shouldDehydratePersistedQuery` requires `key[0] === 'auth'`.
 *
 * Scoping them removes the dependency on that single `clear()` call staying correct
 * forever, and makes the keys consistent with the invariant documented in `index.ts`.
 * It is defence in depth, not a patched vulnerability.
 *
 * Node and workspace payloads carry runtime/infrastructure metadata, so none of
 * these are persistable.
 */
export const nodeQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'nodes'] as const,
  list: (queryScope: string) => [...nodeQueryKeys.all(queryScope), 'list'] as const,
  catalog: (queryScope: string) => [...nodeQueryKeys.all(queryScope), 'catalog'] as const,
};

export const workspaceQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'workspaces'] as const,
  lists: (queryScope: string) => [...workspaceQueryKeys.all(queryScope), 'list'] as const,
  list: (queryScope: string, status?: string) =>
    [...workspaceQueryKeys.lists(queryScope), { status: status ?? null }] as const,
};

export function nodeListQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: nodeQueryKeys.list(queryScope),
    queryFn: listNodes,
  });
}

export function workspaceListQueryOptions(queryScope: string, status?: string) {
  return queryOptions({
    queryKey: workspaceQueryKeys.list(queryScope, status),
    queryFn: () => listWorkspaces(status),
  });
}

export function providerCatalogQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: nodeQueryKeys.catalog(queryScope),
    queryFn: async () => (await getProviderCatalog()).catalogs ?? [],
    staleTime: PROVIDER_CATALOG_STALE_TIME_MS,
  });
}
