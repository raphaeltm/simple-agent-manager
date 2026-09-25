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
 * SQL list literal of {@link SLEEP_PRESERVED_TERMINAL_TASK_STATUSES}, for raw
 * predicates that cannot bind an array. Built from the constant so the two
 * cannot drift; the values are static identifiers, never user input.
 */
export const SLEEP_PRESERVED_TERMINAL_TASK_STATUS_SQL = `(${SLEEP_PRESERVED_TERMINAL_TASK_STATUSES.map(
  (status) => `'${status}'`
).join(', ')})`;

export function isSleepPreservedTerminalTaskStatus(
  status: string | null | undefined
): status is SleepPreservedTerminalTaskStatus {
  return (SLEEP_PRESERVED_TERMINAL_TASK_STATUSES as readonly string[]).includes(status ?? '');
}

function assertSqlAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid SQL alias for terminal workspace ownership predicate: ${alias}`);
  }
  return alias;
}

/**
 * SQL predicate: terminal task `taskAlias` hands its workspace `workspaceAlias` to
 * the session-sleep lifecycle, so the node-cleanup orphan reapers must leave it
 * alone. The reapers run before `session_sleep` in every cron tick, so without
 * this they would destroy a runtime before its sleep snapshot could be taken.
 *
 * - A `completed` task owns its workspace whenever it has a chat to resume
 *   (unchanged pre-existing behaviour).
 * - A `failed` task additionally needs an agent session the sleep lifecycle can
 *   snapshot, mirroring the claimer's own selector
 *   (`reconcileUnscheduledSessionSleeps` in `scheduled/session-sleep.ts`). A
 *   failure is often the agent session ending, and a failed workspace the sleep
 *   lifecycle cannot claim must stay reachable by the reapers — otherwise it
 *   would have no escape path at all (`.claude/rules/47`).
 */
export function sleepLifecycleOwnsTerminalTaskWorkspaceSql(
  taskAlias: string,
  workspaceAlias: string
): string {
  const t = assertSqlAlias(taskAlias);
  const w = assertSqlAlias(workspaceAlias);
  return `(
    ${w}.chat_session_id IS NOT NULL
    AND (
      ${t}.status = 'completed'
      OR (
        ${t}.status = 'failed'
        AND EXISTS (
          SELECT 1 FROM agent_sessions resumable_agent
          WHERE resumable_agent.workspace_id = ${w}.id
            AND resumable_agent.status IN ('running', 'recovery', 'sleeping')
        )
      )
    )
  )`;
}
