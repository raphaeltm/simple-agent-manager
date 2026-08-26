/**
 * Canonical cadences for the app's hand-rolled background polls.
 *
 * Centralized so the same 10s literal is not re-declared at every call site and
 * so each cadence is env-overridable per `.claude/rules/60-request-io-and-bundle-budgets.md`
 * ("Polling intervals MUST be env-configurable with a `DEFAULT_*` constant") and
 * constitution Principle XI.
 *
 * Consumers drive these through one of two mechanisms, both of which stop polling
 * on a hidden tab:
 *
 *  - `useVisibilityAwarePoll` — for hand-rolled loaders that have not migrated.
 *  - TanStack Query's `refetchInterval` — for migrated queries. The timer still
 *    ticks, but `QueryObserver` only issues a fetch when
 *    `options.refetchIntervalInBackground || focusManager.isFocused()`
 *    (`query-core/build/modern/queryObserver.js`, `#updateRefetchInterval`), and
 *    `focusManager.isFocused()` returns `document.visibilityState !== 'hidden'`.
 *    `refetchIntervalInBackground` defaults to `false` and must not be enabled for
 *    any cadence below, or the hidden-tab guarantee is lost.
 */

import { DEFAULT_DASHBOARD_POLL_INTERVAL_MS } from '@simple-agent-manager/shared';

function resolveIntervalMs(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRatio(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/** Node detail refresh (node record + its workspace list). */
const DEFAULT_NODE_DETAIL_POLL_MS = 10_000;
export const NODE_DETAIL_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_NODE_DETAIL_POLL_MS,
  DEFAULT_NODE_DETAIL_POLL_MS
);

/** Node event-log refresh, proxied through the control plane. */
const DEFAULT_NODE_EVENTS_POLL_MS = 10_000;
export const NODE_EVENTS_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_NODE_EVENTS_POLL_MS,
  DEFAULT_NODE_EVENTS_POLL_MS
);

/** Node system-info (CPU/memory/disk) refresh. */
const DEFAULT_NODE_SYSTEM_INFO_POLL_MS = 10_000;
export const NODE_SYSTEM_INFO_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_NODE_SYSTEM_INFO_POLL_MS,
  DEFAULT_NODE_SYSTEM_INFO_POLL_MS
);

/** Workspace status/state refresh while a workspace is in a transitional state. */
const DEFAULT_WORKSPACE_STATE_POLL_MS = 5_000;
export const WORKSPACE_STATE_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_STATE_POLL_MS,
  DEFAULT_WORKSPACE_STATE_POLL_MS
);

/** Workspace event-log refresh, read directly from the VM agent. */
const DEFAULT_WORKSPACE_EVENTS_POLL_MS = 10_000;
export const WORKSPACE_EVENTS_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_EVENTS_POLL_MS,
  DEFAULT_WORKSPACE_EVENTS_POLL_MS
);

/** Detected-port refresh for the workspace port panel. */
export const DEFAULT_WORKSPACE_PORTS_POLL_MS = 10_000;
export const WORKSPACE_PORTS_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_PORTS_POLL_MS,
  DEFAULT_WORKSPACE_PORTS_POLL_MS
);

/** Maximum delay for workspace port-list exponential backoff. */
export const DEFAULT_WORKSPACE_PORTS_BACKOFF_MAX_MS = 120_000;
export const WORKSPACE_PORTS_BACKOFF_MAX_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_PORTS_BACKOFF_MAX_MS,
  DEFAULT_WORKSPACE_PORTS_BACKOFF_MAX_MS
);

/** Consecutive unavailable responses before the workspace ports circuit opens. */
export const DEFAULT_WORKSPACE_PORTS_FAILURE_BUDGET = 6;
export const WORKSPACE_PORTS_FAILURE_BUDGET = resolvePositiveInteger(
  import.meta.env.VITE_WORKSPACE_PORTS_FAILURE_BUDGET,
  DEFAULT_WORKSPACE_PORTS_FAILURE_BUDGET
);

/** +/- jitter applied to workspace ports backoff delays. */
export const DEFAULT_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO = 0.2;
export const WORKSPACE_PORTS_BACKOFF_JITTER_RATIO = resolveRatio(
  import.meta.env.VITE_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO,
  DEFAULT_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO
);

/** Open-circuit cooldown before a half-open workspace ports readiness probe. */
export const DEFAULT_WORKSPACE_PORTS_CIRCUIT_RESET_MS = 300_000;
export const WORKSPACE_PORTS_CIRCUIT_RESET_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_PORTS_CIRCUIT_RESET_MS,
  DEFAULT_WORKSPACE_PORTS_CIRCUIT_RESET_MS
);

/** Node list refresh on the `/nodes` page. */
const DEFAULT_NODE_LIST_POLL_MS = 10_000;
export const NODE_LIST_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_NODE_LIST_POLL_MS,
  DEFAULT_NODE_LIST_POLL_MS
);

/** Workspace list refresh on the `/workspaces` and `/nodes` pages. */
const DEFAULT_WORKSPACE_LIST_POLL_MS = 10_000;
export const WORKSPACE_LIST_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_LIST_POLL_MS,
  DEFAULT_WORKSPACE_LIST_POLL_MS
);

/**
 * Dashboard active-task refresh.
 *
 * Falls back to the shared `DEFAULT_DASHBOARD_POLL_INTERVAL_MS` so the cadence stays
 * aligned with the rest of the dashboard rather than forking a second default.
 */
export const ACTIVE_TASKS_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_ACTIVE_TASKS_POLL_MS,
  DEFAULT_DASHBOARD_POLL_INTERVAL_MS
);

/**
 * Chat-summary cadences and limits live in `lib/chat-query-config.ts`, mirroring the
 * `lib/project-query-config.ts` convention of keeping a domain's cadence and its
 * result limit together.
 */
