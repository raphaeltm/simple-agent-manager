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

function resolveNonNegativeInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveRatio(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/**
 * Automation page refresh for one-time schedules and watches (the states that change on their
 * own: a schedule comes due, a watch fires). Triggers and runs refresh on focus and after edits.
 */
export const DEFAULT_AUTOMATION_POLL_MS = 30_000;
export const AUTOMATION_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_AUTOMATION_POLL_MS,
  DEFAULT_AUTOMATION_POLL_MS
);

/**
 * Refresh for an open workflow run while it is active, so a step finishing or starting shows
 * without a reload. Finished runs do not change and are not polled.
 */
export const DEFAULT_WORKFLOW_RUN_POLL_MS = 10_000;
export const WORKFLOW_RUN_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKFLOW_RUN_POLL_MS,
  DEFAULT_WORKFLOW_RUN_POLL_MS
);

/**
 * Deployments refresh while something is changing on its own: a deploy or Start in progress,
 * a pause, or a new domain waiting for DNS. Steps and statuses move without a reload.
 */
export const DEFAULT_DEPLOYMENTS_ACTIVE_POLL_MS = 5_000;
export const DEPLOYMENTS_ACTIVE_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_DEPLOYMENTS_ACTIVE_POLL_MS,
  DEFAULT_DEPLOYMENTS_ACTIVE_POLL_MS
);

/** Deployments refresh when nothing is changing: catches agent deploys and server check-ins. */
export const DEFAULT_DEPLOYMENTS_IDLE_POLL_MS = 30_000;
export const DEPLOYMENTS_IDLE_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_DEPLOYMENTS_IDLE_POLL_MS,
  DEFAULT_DEPLOYMENTS_IDLE_POLL_MS
);

/** Private SAM preference/availability refresh, including changes from another tab. */
export const DEFAULT_SAM_SETTINGS_POLL_MS = 10_000;
export const SAM_SETTINGS_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_SAM_SETTINGS_POLL_MS,
  DEFAULT_SAM_SETTINGS_POLL_MS
);

/** Private SAM refresh while a turn, action, or tracked project task remains active. */
export const DEFAULT_SAM_ACTIVE_POLL_MS = 2_000;
export const SAM_ACTIVE_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_SAM_ACTIVE_POLL_MS,
  DEFAULT_SAM_ACTIVE_POLL_MS
);

/**
 * Safety-net refresh while the running turn's live stream is connected. The stream
 * pushes progress and triggers a refresh when a step settles, so polling can relax.
 */
export const DEFAULT_SAM_STREAMING_POLL_MS = 15_000;
export const SAM_STREAMING_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_SAM_STREAMING_POLL_MS,
  DEFAULT_SAM_STREAMING_POLL_MS
);

/** Delay before reopening a dropped live stream; grows linearly with each attempt. */
export const DEFAULT_SAM_STREAM_RECONNECT_MS = 1_500;
export const SAM_STREAM_RECONNECT_MS = resolveIntervalMs(
  import.meta.env.VITE_SAM_STREAM_RECONNECT_MS,
  DEFAULT_SAM_STREAM_RECONNECT_MS
);

/** Reconnect attempts per turn before the page relies on polling alone. */
export const DEFAULT_SAM_STREAM_MAX_RECONNECTS = 5;
export const SAM_STREAM_MAX_RECONNECTS = resolvePositiveInteger(
  import.meta.env.VITE_SAM_STREAM_MAX_RECONNECTS,
  DEFAULT_SAM_STREAM_MAX_RECONNECTS
);

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

/** Workspace list refresh on the `/nodes` page. */
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

/** Active ACP permission snapshot refresh while at least one request is pending. */
export const DEFAULT_ACP_PERMISSION_POLL_MS = 2_000;
export const ACP_PERMISSION_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_ACP_PERMISSION_POLL_MS,
  DEFAULT_ACP_PERMISSION_POLL_MS
);

/** Slow reconciliation when no ACP interaction currently needs delivery tracking. */
export const DEFAULT_ACP_PERMISSION_RECOVERY_POLL_MS = 30_000;
export const ACP_PERMISSION_RECOVERY_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_ACP_PERMISSION_RECOVERY_POLL_MS,
  DEFAULT_ACP_PERMISSION_RECOVERY_POLL_MS
);

/** Retry budget for transient ACP permission snapshot failures; authorization failures never retry. */
export const DEFAULT_ACP_PERMISSION_QUERY_RETRY_COUNT = 3;
export const ACP_PERMISSION_QUERY_RETRY_COUNT = resolveNonNegativeInteger(
  import.meta.env.VITE_ACP_PERMISSION_QUERY_RETRY_COUNT,
  DEFAULT_ACP_PERMISSION_QUERY_RETRY_COUNT
);

/**
 * Chat-summary cadences and limits live in `lib/chat-query-config.ts`, mirroring the
 * `lib/project-query-config.ts` convention of keeping a domain's cadence and its
 * result limit together.
 */
