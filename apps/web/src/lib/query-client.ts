import { QueryClient } from '@tanstack/react-query';

/**
 * App-wide QueryClient with stale-while-revalidate defaults.
 *
 * Policy:
 *  - `staleTime: 15_000` (15 s) — data is fresh for 15 s after fetch; during
 *    that window re-mounts reuse the cache without hitting the network.
 *  - `refetchOnWindowFocus: false` — the app already has its own polling
 *    (`refetchInterval` per query); avoid surprise refetches on tab focus.
 *  - `retry: 1` — one automatic retry on transient failures; the UI shows
 *    errors quickly rather than blocking behind three silent retries.
 *
 * Rendering contract (ALL migrated pages must follow):
 *  - `isLoading` (== `isPending && !data`) means no cached data yet; show a
 *    skeleton / spinner.
 *  - `isFetching && data` means a background refetch is in progress; keep the
 *    stale content mounted and optionally show a subtle refresh indicator.
 *  - NEVER hide already-rendered content behind a spinner during a refetch.
 *  - `isError && !data` means the initial load failed with nothing cached; show
 *    an error, NOT an empty state — an "empty" list on a failed load is a lie.
 *  - `isError && data` means a background refetch failed but stale data exists;
 *    keep the stale content mounted (do not replace it with an error).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
