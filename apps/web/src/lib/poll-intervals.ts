/**
 * Canonical cadences for the app's hand-rolled background polls.
 *
 * Centralized so the same 10s literal is not re-declared at every call site and
 * so each cadence is env-overridable per `.claude/rules/60-request-io-and-bundle-budgets.md`
 * ("Polling intervals MUST be env-configurable with a `DEFAULT_*` constant") and
 * constitution Principle XI.
 *
 * Every consumer below drives its interval through `useVisibilityAwarePoll`, so
 * these cadences only apply while the tab is visible.
 */

function resolveIntervalMs(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
const DEFAULT_WORKSPACE_PORTS_POLL_MS = 10_000;
export const WORKSPACE_PORTS_POLL_MS = resolveIntervalMs(
  import.meta.env.VITE_WORKSPACE_PORTS_POLL_MS,
  DEFAULT_WORKSPACE_PORTS_POLL_MS
);
