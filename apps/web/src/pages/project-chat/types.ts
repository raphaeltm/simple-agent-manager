import {
  DEPLOYMENT_ENVIRONMENT_NAME_RE,
  type TaskExecutionStep,
  type TaskStatus,
} from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to poll task status during provisioning (ms). */
export const TASK_STATUS_POLL_MS = 2000;
/** Max sessions to load in the sidebar. Override via VITE_CHAT_SESSION_LIST_LIMIT. */
const DEFAULT_CHAT_SESSION_LIST_LIMIT = 100;
export const CHAT_SESSION_LIST_LIMIT = parseInt(
  import.meta.env.VITE_CHAT_SESSION_LIST_LIMIT || String(DEFAULT_CHAT_SESSION_LIST_LIMIT)
);

/**
 * Prompts for "Ask an agent" on the Deployments pages, which open a new chat at
 * `?deployHelp=<environment>&deployIntent=fix|deploy`. Only a validated environment name is put
 * into the template, so a link cannot place arbitrary text in the composer. Override via
 * VITE_DEPLOY_HELP_FIX_PROMPT_TEMPLATE / VITE_DEPLOY_HELP_DEPLOY_PROMPT_TEMPLATE; use {environment}.
 */
const DEFAULT_DEPLOY_HELP_FIX_PROMPT_TEMPLATE =
  'The {environment} deployment needs attention. Use the SAM deployment tools to check its status and logs, fix what is wrong, and deploy it again.';
const DEFAULT_DEPLOY_HELP_DEPLOY_PROMPT_TEMPLATE =
  'Deploy this project to the {environment} environment using the SAM deployment tools.';
const DEPLOY_HELP_FIX_PROMPT_TEMPLATE =
  import.meta.env.VITE_DEPLOY_HELP_FIX_PROMPT_TEMPLATE || DEFAULT_DEPLOY_HELP_FIX_PROMPT_TEMPLATE;
const DEPLOY_HELP_DEPLOY_PROMPT_TEMPLATE =
  import.meta.env.VITE_DEPLOY_HELP_DEPLOY_PROMPT_TEMPLATE ||
  DEFAULT_DEPLOY_HELP_DEPLOY_PROMPT_TEMPLATE;

/** The pre-filled request for `?deployHelp`, or null when the environment name is not valid. */
export function deployHelpPrompt(environment: string | null, intent: string | null): string | null {
  if (!environment || !DEPLOYMENT_ENVIRONMENT_NAME_RE.test(environment)) return null;
  const template =
    intent === 'deploy' ? DEPLOY_HELP_DEPLOY_PROMPT_TEMPLATE : DEPLOY_HELP_FIX_PROMPT_TEMPLATE;
  return template.replaceAll('{environment}', environment);
}

/** Max tasks to load for idea tagging. Override via VITE_CHAT_TASK_LIST_LIMIT. */
const DEFAULT_CHAT_TASK_LIST_LIMIT = 200;
export const CHAT_TASK_LIST_LIMIT = parseInt(
  import.meta.env.VITE_CHAT_TASK_LIST_LIMIT || String(DEFAULT_CHAT_TASK_LIST_LIMIT)
);

/** Background sync interval for session list (ms). Override via VITE_SESSION_SYNC_INTERVAL_MS. */
const DEFAULT_SESSION_SYNC_INTERVAL_MS = 30_000;
export const SESSION_SYNC_INTERVAL_MS = parseInt(
  import.meta.env.VITE_SESSION_SYNC_INTERVAL_MS || String(DEFAULT_SESSION_SYNC_INTERVAL_MS)
);

/**
 * Slow reconciliation interval for the session list while the ProjectData
 * WebSocket IS connected (ms). Override via VITE_SESSION_RECONCILE_INTERVAL_MS.
 *
 * `connectionState === 'connected'` means the socket is open — it is NOT a
 * delivery guarantee. `useProjectWebSocket` silently discards malformed frames,
 * and there is no sequence number or gap detector, so a dropped delta would
 * otherwise leave the sidebar wrong for the entire lifetime of that connection.
 * This keeps the original poll's self-healing property at ~1/20th the request
 * rate rather than removing it outright.
 */
const DEFAULT_SESSION_RECONCILE_INTERVAL_MS = 600_000;
export const SESSION_RECONCILE_INTERVAL_MS = parseInt(
  import.meta.env.VITE_SESSION_RECONCILE_INTERVAL_MS ||
    String(DEFAULT_SESSION_RECONCILE_INTERVAL_MS)
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisioningState {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  errorMessage: string | null;
  startedAt: number;
  workspaceId: string | null;
  workspaceUrl: string | null;
  /** VM size originally requested (default-derived). */
  requestedVmSize: string | null;
  /** VM size actually provisioned. Differs from requestedVmSize only when
   *  size-fallback descended on transient capacity exhaustion. */
  provisionedVmSize: string | null;
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Task statuses in which the task runner is still bringing a session's
 * infrastructure up and the agent has not started. `ProvisioningIndicator` is
 * restored for these and nothing else.
 *
 * Deliberately an allowlist. The previous "not terminal and not in_progress"
 * denylist silently admitted the `sleeping` status added by PR #2230 and showed
 * "Starting... Waiting for task runner..." over idle slept conversations. A gate
 * keys on its condition, not on a proxy that merely correlates
 * (`.claude/rules/74-proxy-signals-must-match-the-condition.md`).
 */
export const PROVISIONING_TASK_STATUSES = [
  'queued',
  'delegated',
] as const satisfies readonly TaskStatus[];

export function isProvisioningStatus(status: TaskStatus): boolean {
  return (PROVISIONING_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * How many times the provisioning restore retries a failed task fetch (at
 * TASK_STATUS_POLL_MS intervals) before giving up. Override via
 * VITE_PROVISIONING_RESTORE_RETRIES.
 */
const DEFAULT_PROVISIONING_RESTORE_RETRIES = 3;
export const PROVISIONING_RESTORE_RETRIES = Number.parseInt(
  import.meta.env.VITE_PROVISIONING_RESTORE_RETRIES || String(DEFAULT_PROVISIONING_RESTORE_RETRIES)
);
