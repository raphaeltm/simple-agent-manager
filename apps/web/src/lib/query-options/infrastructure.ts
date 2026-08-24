import { queryOptions } from '@tanstack/react-query';

import { getProviderCatalog, listNodes, listWorkspacePorts, listWorkspaces } from '../api';
import { PROVIDER_CATALOG_STALE_TIME_MS } from '../query-stale-times';

const FNV_1A_OFFSET_BASIS = 0x811c9dc5;
const FNV_1A_PRIME = 0x01000193;

function fnv1aBase36(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_1A_PRIME) >>> 0;
  }
  return hash.toString(36);
}

function workspacePortTokenCacheMarker(token: string): string {
  // The VM-agent token participates in request identity, but the raw token must
  // not be placed in TanStack Query keys where devtools/logging can expose it.
  // Ports are not persisted; this non-raw marker only forces a new cache entry
  // when a same-workspace token rotates.
  const forwardHash = fnv1aBase36(token, FNV_1A_OFFSET_BASIS);
  const reverseHash = fnv1aBase36([...token].reverse().join(''), FNV_1A_OFFSET_BASIS);
  return `${token.length}:${forwardHash}:${reverseHash}`;
}

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
  ports: (queryScope: string) => [...workspaceQueryKeys.all(queryScope), 'ports'] as const,
  portList: (
    queryScope: string,
    workspaceId: string,
    workspaceUrl: string,
    tokenCacheMarker: string
  ) => [...workspaceQueryKeys.ports(queryScope), workspaceId, { workspaceUrl, tokenCacheMarker }] as const,
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

export function workspacePortsQueryOptions(
  queryScope: string,
  workspaceUrl: string,
  workspaceId: string,
  token: string
) {
  return queryOptions({
    queryKey: workspaceQueryKeys.portList(
      queryScope,
      workspaceId,
      workspaceUrl,
      workspacePortTokenCacheMarker(token)
    ),
    queryFn: ({ signal }) => listWorkspacePorts(workspaceUrl, workspaceId, token, signal),
  });
}
