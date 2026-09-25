import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS } from './session-snapshot-artifacts';
import { TERMINAL_SESSION_SLEEP_STATUS } from './session-snapshot-sleep-failure';

/**
 * Terminal task statuses whose conversation SAM keeps by SLEEPING it (final
 * snapshot, then runtime teardown, wakeable until the snapshot expires) instead
 * of tearing the workspace down.
 *
 * - `completed`: the agent finished; its final response drains, then it sleeps.
 * - `failed`: the run failed, but uncommitted or unpushed work in the workspace
 *   is still the user's (policy `a3780107`). `failed-task-preservation.ts`
 *   decides whether a failed task's runtime can be preserved at all.
 * - `cancelled` is deliberately absent. A cancel is an explicit user or parent
 *   stop (policy `486d1dd1`) and keeps the immediate destructive cleanup.
 *
 * This is the ONE authority for every consumer (`.claude/rules/67`): widening a
 * single consumer would make the sleep machinery and the reapers disagree about
 * who owns a terminal task's runtime. Consumers:
 *
 * - `classifySessionIdleness` (`session-idleness.ts`) — stale-prompt drain and
 *   immediate reclaim once the prompt turn has ended.
 * - `cancelScheduledSessionSleep` (`session-snapshot-sleep-cancel.ts`) — activity
 *   re-reports fence, but never erase, the terminal sleep intent.
 * - `isCompletingSessionProtected` (`project-data/completion-drain.ts`) — the
 *   terminal-session reconciler defers while the finishing turn drains.
 * - node-cleanup `sweepTerminalCfContainers` and `sweepOrphanedWorkspaces`, through
 *   {@link sleepLifecycleOwnsTerminalTaskWorkspaceSql}.
 */
export const SLEEP_PRESERVED_TERMINAL_TASK_STATUSES = ['completed', 'failed'] as const;

export type SleepPreservedTerminalTaskStatus =
  (typeof SLEEP_PRESERVED_TERMINAL_TASK_STATUSES)[number];

/**
 * What makes a runtime one the session-sleep sweep can claim. The claimer's own
 * discovery selector (`reconcileUnscheduledSessionSleeps` in
 * `scheduled/session-sleep.ts`) and the sleep path's resumable-agent checks
 * (`services/session-sleep.ts`) read these, and so does everything that must agree
 * with the claimer: failed-task preservation's hand-over check and the reapers'
 * ownership predicate below. A runtime handed to the sleep lifecycle that its
 * claimer would skip is never slept and, being exempt, never reaped.
 */
export const SLEEP_CLAIMABLE_WORKSPACE_STATUSES = ['running', 'recovery'] as const;
export const SLEEP_CLAIMABLE_NODE_ROLE = 'workspace';
export const SLEEP_SNAPSHOT_NODE_RUNTIMES = ['vm', 'cf-container'] as const;
export const SLEEP_RESUMABLE_AGENT_SESSION_STATUSES = ['running', 'recovery', 'sleeping'] as const;

/** SQL list literal of static identifiers (never user input). */
function sqlList(values: readonly string[]): string {
  return `(${values.map((value) => `'${value}'`).join(', ')})`;
}

/**
 * SQL list literal of {@link SLEEP_PRESERVED_TERMINAL_TASK_STATUSES}, for raw
 * predicates that cannot bind an array. Built from the constant so the two
 * cannot drift.
 */
export const SLEEP_PRESERVED_TERMINAL_TASK_STATUS_SQL = sqlList(
  SLEEP_PRESERVED_TERMINAL_TASK_STATUSES
);

export function isSleepPreservedTerminalTaskStatus(
  status: string | null | undefined
): status is SleepPreservedTerminalTaskStatus {
  return (SLEEP_PRESERVED_TERMINAL_TASK_STATUSES as readonly string[]).includes(status ?? '');
}

/** The sleep sweep's attempt budget, as every consumer of "gave up" must read it. */
export function sessionSleepMaxAttempts(env: Pick<Env, 'SESSION_SLEEP_MAX_ATTEMPTS'>): number {
  return parsePositiveInt(env.SESSION_SLEEP_MAX_ATTEMPTS, DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS);
}

export interface SessionSleepAttemptState {
  sleepingAt: string | null;
  sleepAfter: string | null;
  sleepStatus: string | null;
  sleepAttempts: number;
  status: string;
  captureGeneration: string | null;
}

/**
 * The sleep lifecycle has given up on this row: not asleep, no retry scheduled,
 * and either terminally failed or failed with its retry budget
 * (`SESSION_SLEEP_MAX_ATTEMPTS`) spent. It mirrors what the sweep will no longer
 * select (`runSessionSleepSweep`): a `failed` row with no retry time is still
 * re-selected while attempts remain — raising the budget re-arms it — and a
 * repairable capture (degraded, or a capture in progress) is retried past the
 * budget. Every writer that ends a sleep episode leaves this shape
 * (`failSessionSnapshotSleepBeforeTeardown`, the selection-time exhaustion,
 * `terminalizeMissingSleepSource`). {@link exhaustedSessionSleepSql} is the same
 * definition in SQL.
 */
export function isSessionSleepExhausted(
  row: SessionSleepAttemptState,
  maxSleepAttempts: number
): boolean {
  if (row.sleepingAt || row.sleepAfter !== null) return false;
  if (row.sleepStatus === TERMINAL_SESSION_SLEEP_STATUS) return true;
  return (
    row.sleepStatus === 'failed' &&
    row.sleepAttempts >= maxSleepAttempts &&
    row.status !== 'degraded' &&
    !row.captureGeneration
  );
}

function assertSqlAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid SQL alias for terminal workspace ownership predicate: ${alias}`);
  }
  return alias;
}

function assertAttemptBudget(maxSleepAttempts: number): number {
  if (!Number.isInteger(maxSleepAttempts) || maxSleepAttempts < 1) {
    throw new Error(`Invalid sleep attempt budget: ${maxSleepAttempts}`);
  }
  return maxSleepAttempts;
}

/** {@link isSessionSleepExhausted} for the snapshot row of `chatSessionIdSql`. */
export function exhaustedSessionSleepSql(
  chatSessionIdSql: string,
  maxSleepAttempts: number
): string {
  return `EXISTS (
    SELECT 1 FROM session_snapshots exhausted_sleep
    WHERE exhausted_sleep.chat_session_id = ${chatSessionIdSql}
      AND exhausted_sleep.sleeping_at IS NULL
      AND exhausted_sleep.sleep_after IS NULL
      AND (
        exhausted_sleep.sleep_status = '${TERMINAL_SESSION_SLEEP_STATUS}'
        OR (
          exhausted_sleep.sleep_status = 'failed'
          AND exhausted_sleep.sleep_attempts >= ${assertAttemptBudget(maxSleepAttempts)}
          AND exhausted_sleep.status != 'degraded'
          AND exhausted_sleep.capture_generation IS NULL
        )
      )
  )`;
}

/**
 * Per-status condition, beyond the chat link every status needs, under which the
 * sleep lifecycle owns a terminal task's workspace. Keyed by the authority's own
 * type, so adding a status above does not compile until its rule is written here.
 */
const SLEEP_LIFECYCLE_OWNERSHIP: Record<
  SleepPreservedTerminalTaskStatus,
  (workspaceAlias: string, maxSleepAttempts: number) => string | null
> = {
  // A completed task owns its workspace whenever it has a chat to resume
  // (unchanged pre-existing behaviour).
  completed: () => null,
  // A failed task owns it only while the sleep lifecycle can actually take it:
  // the claimer's own conditions (`reconcileUnscheduledSessionSleeps`), or an
  // already-slept runtime, and a sleep that has not given up. A failure is often
  // the agent session ending, and a failed workspace the sleep lifecycle cannot
  // or will no longer claim must stay reachable by the reapers — otherwise it has
  // no escape path at all (`.claude/rules/47`), and the reapers are the durable
  // backstop for an exhaustion release or failure teardown that never ran.
  failed: (w, maxSleepAttempts) => `(
    ${w}.project_id IS NOT NULL
    AND ${w}.status IN ${sqlList([...SLEEP_CLAIMABLE_WORKSPACE_STATUSES, 'sleeping'])}
    AND EXISTS (
      SELECT 1 FROM nodes sleep_node
      WHERE sleep_node.id = ${w}.node_id
        AND sleep_node.node_role = '${SLEEP_CLAIMABLE_NODE_ROLE}'
        AND sleep_node.runtime IN ${sqlList(SLEEP_SNAPSHOT_NODE_RUNTIMES)}
    )
    AND EXISTS (
      SELECT 1 FROM agent_sessions resumable_agent
      WHERE resumable_agent.workspace_id = ${w}.id
        AND resumable_agent.status IN ${sqlList(SLEEP_RESUMABLE_AGENT_SESSION_STATUSES)}
    )
    AND NOT ${exhaustedSessionSleepSql(`${w}.chat_session_id`, maxSleepAttempts)}
  )`,
};

/**
 * SQL predicate: terminal task `taskAlias` hands its workspace `workspaceAlias` to
 * the session-sleep lifecycle, so the node-cleanup orphan reapers must leave it
 * alone. The reapers run before `session_sleep` in every cron tick, so without
 * this they would destroy a runtime before its sleep snapshot could be taken.
 */
export function sleepLifecycleOwnsTerminalTaskWorkspaceSql(
  taskAlias: string,
  workspaceAlias: string,
  maxSleepAttempts: number
): string {
  const t = assertSqlAlias(taskAlias);
  const w = assertSqlAlias(workspaceAlias);
  const arms = SLEEP_PRESERVED_TERMINAL_TASK_STATUSES.map((status) => {
    const condition = SLEEP_LIFECYCLE_OWNERSHIP[status](w, maxSleepAttempts);
    return condition ? `(${t}.status = '${status}' AND ${condition})` : `${t}.status = '${status}'`;
  });
  return `(
    ${w}.chat_session_id IS NOT NULL
    AND (${arms.join(' OR ')})
  )`;
}
