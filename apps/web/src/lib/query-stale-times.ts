/**
 * Per-query `staleTime` overrides for data that is more stable than the
 * QueryClient's 15 s default (`lib/query-client.ts`).
 *
 * Centralized and env-overridable for the same reason as `lib/poll-intervals.ts`:
 * constitution Principle XI bans hardcoded timeouts, and a `staleTime` literal
 * scattered across query-option modules is exactly the kind of value that drifts
 * apart between call sites.
 *
 * These are freshness windows, not cache lifetimes — `gcTime` still governs
 * eviction. Raising one trades staleness for fewer requests; it never risks showing
 * another user's data, because scope isolation is enforced by the query key.
 */

function resolveDurationMs(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Agent catalog (`GET /api/agents`) — the set of installable agent types. Changes
 * only when the platform is redeployed.
 */
const DEFAULT_AGENT_CATALOG_STALE_TIME_MS = 300_000;
export const AGENT_CATALOG_STALE_TIME_MS = resolveDurationMs(
  import.meta.env.VITE_AGENT_CATALOG_STALE_TIME_MS,
  DEFAULT_AGENT_CATALOG_STALE_TIME_MS
);

/**
 * Provider catalog (`GET /api/providers/catalog`) — VM sizes, locations and prices
 * per cloud provider. Effectively static between deploys.
 */
const DEFAULT_PROVIDER_CATALOG_STALE_TIME_MS = 300_000;
export const PROVIDER_CATALOG_STALE_TIME_MS = resolveDurationMs(
  import.meta.env.VITE_PROVIDER_CATALOG_STALE_TIME_MS,
  DEFAULT_PROVIDER_CATALOG_STALE_TIME_MS
);

/**
 * Trial status (`GET /api/trial-status`) — whether a platform-funded trial is still
 * available to this user. Moves only when a trial is claimed or expires, both of
 * which invalidate the query explicitly.
 */
const DEFAULT_TRIAL_STATUS_STALE_TIME_MS = 60_000;
export const TRIAL_STATUS_STALE_TIME_MS = resolveDurationMs(
  import.meta.env.VITE_TRIAL_STATUS_STALE_TIME_MS,
  DEFAULT_TRIAL_STATUS_STALE_TIME_MS
);

/**
 * Cached slash-command registry (`GET /api/projects/:id/cached-commands`).
 * Commands change when an agent reports/persists a new set, and callers explicitly
 * refetch on session changes. Between those events this can stay fresh longer than
 * the app default.
 */
const DEFAULT_CACHED_COMMANDS_STALE_TIME_MS = 300_000;
export const CACHED_COMMANDS_STALE_TIME_MS = resolveDurationMs(
  import.meta.env.VITE_CACHED_COMMANDS_STALE_TIME_MS,
  DEFAULT_CACHED_COMMANDS_STALE_TIME_MS
);

/**
 * Project creation feature flags such as Cloudflare Artifacts availability. These
 * are deployment/config-level values, not per-keystroke user data.
 */
const DEFAULT_PROJECT_CREATE_CONFIG_STALE_TIME_MS = 300_000;
export const PROJECT_CREATE_CONFIG_STALE_TIME_MS = resolveDurationMs(
  import.meta.env.VITE_PROJECT_CREATE_CONFIG_STALE_TIME_MS,
  DEFAULT_PROJECT_CREATE_CONFIG_STALE_TIME_MS
);
