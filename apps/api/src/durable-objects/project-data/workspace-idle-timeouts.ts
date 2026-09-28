/**
 * Workspace idle timeouts: the ProjectData alarm section that retires a workspace whose active chat
 * session has gone quiet for the project's workspace idle timeout, and the alarm time it needs.
 *
 * `workspace_activity.next_idle_check_at` is the sweep's own record of when it next needs to look at
 * a row: the idle deadline of a workspace that is not idle yet, or the backoff retry of one it could
 * not retire. New activity and a session wake clear it (`activity.ts`), and a row without one is
 * first checked a check interval after its latest activity. The sweep and the alarm scheduler read
 * this through one query fragment, so the alarm is armed only for a row the sweep will act on, and
 * every row the sweep checks leaves with a later check time or is deleted — no row can hold the
 * alarm at its floor. A changed project timeout applies from each workspace's next check.
 */
import {
  DEFAULT_IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_WORKSPACE_IDLE_BACKOFF_BASE_MS,
  DEFAULT_WORKSPACE_IDLE_BACKOFF_MAX_MS,
  DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS,
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
  WORKSPACE_IDLE_CHECK_INTERVAL_MS,
} from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { recordActivityEventInternal } from './activity';
import {
  listReporterScopedTaskCandidates,
  terminalizeIdleTaskInD1,
} from './idle-cleanup-terminalization';
import { materializeSession, resolveMaterializationPassConfig } from './materialization';
import { parseMinEarliest, parseWorkspaceIdleCheck } from './row-schemas';
import { upsertActivityState } from './session-state';
import { stopSessionInternal } from './sessions';
import type { Env } from './types';

// Shares the `idle_cleanup` log namespace so the existing event names are unchanged.
const log = createModuleLogger('idle_cleanup');
const WORKSPACE_IDLE_BACKOFF_EXPONENT_SAFETY_CAP = 30;

/**
 * The rows the sweep owns — activity for a workspace's current session while that session is
 * active — with their latest activity and their next check. Binds the check interval.
 */
const WORKSPACE_IDLE_CHECKS_CTE = `
  WITH tracked AS (
    SELECT wa.workspace_id, wa.session_id, wa.idle_check_retry_count, wa.next_idle_check_at,
           max(COALESCE(wa.last_terminal_activity_at, 0), COALESCE(wa.last_message_at, 0),
               COALESCE(cs.updated_at, 0), wa.created_at) AS last_activity_at
      FROM workspace_activity wa
     INNER JOIN chat_sessions cs ON cs.id = wa.session_id AND cs.workspace_id = wa.workspace_id
     WHERE cs.status = 'active'
  ),
  checks AS (
    SELECT workspace_id, session_id, idle_check_retry_count, last_activity_at,
           COALESCE(next_idle_check_at, last_activity_at + ?) AS next_check_at
      FROM tracked
  )`;

type WorkspaceIdleCheck = ReturnType<typeof parseWorkspaceIdleCheck>;

/** Why an idle workspace was kept for a later retry instead of retired. */
type WorkspaceIdleDeferral =
  | 'reporter_identity_incomplete'
  | 'candidate_overflow'
  | 'no_candidate_tasks'
  | 'runtime_preserved';

interface WorkspaceIdleSweep {
  sql: SqlStorage;
  env: Env;
  projectId: string | null;
  now: number;
  timeoutMs: number;
  candidateLimit: number;
  deleteWorkspaceInD1: (workspaceId: string, projectId: string) => Promise<void>;
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
  scheduleSummarySync: () => void;
}

/**
 * Check every tracked workspace whose next check is due: record the idle deadline of one that is
 * not idle yet, and retire or defer one that is.
 */
export async function checkWorkspaceIdleTimeouts(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  deleteWorkspaceInD1: (workspaceId: string, projectId: string) => Promise<void>,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
  scheduleSummarySync: () => void
): Promise<void> {
  const now = Date.now();
  const candidateLimit = parsePositiveInt(
    env.IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP,
    DEFAULT_IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP
  );
  const dueChecks = selectDueWorkspaceIdleChecks(sql, now, candidateLimit);
  if (dueChecks.length === 0) return;

  const timeoutMs = await resolveWorkspaceIdleTimeoutMs(env, projectId);
  if (timeoutMs === null) {
    for (const check of dueChecks) recordWorkspaceIdleRetry(sql, env, now, check);
    return;
  }
  const sweep: WorkspaceIdleSweep = {
    sql,
    env,
    projectId,
    now,
    timeoutMs,
    candidateLimit,
    deleteWorkspaceInD1,
    broadcastEvent,
    scheduleSummarySync,
  };
  for (const check of dueChecks) {
    await runWorkspaceIdleCheck(sweep, check);
  }
}

/**
 * When the workspace idle section next needs the alarm: the earliest check any tracked row is due
 * for, never sooner than the minimum re-arm delay.
 */
export function computeWorkspaceIdleAlarmTime(
  sql: SqlStorage,
  now: number = Date.now()
): number | null {
  const row = sql
    .exec(
      `${WORKSPACE_IDLE_CHECKS_CTE}
       SELECT MIN(next_check_at) AS earliest FROM checks`,
      WORKSPACE_IDLE_CHECK_INTERVAL_MS
    )
    .toArray()[0];
  const earliest = row ? parseMinEarliest(row, 'workspace_idle_timeouts.min_next_check') : null;
  return earliest === null
    ? null
    : Math.max(earliest, now + DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS);
}

/** Due checks, most overdue first, so a bounded page always reaches the oldest work. */
function selectDueWorkspaceIdleChecks(
  sql: SqlStorage,
  now: number,
  limit: number
): WorkspaceIdleCheck[] {
  return sql
    .exec(
      `${WORKSPACE_IDLE_CHECKS_CTE}
       SELECT workspace_id, session_id, idle_check_retry_count, last_activity_at
         FROM checks
        WHERE next_check_at <= ?
        ORDER BY next_check_at ASC, workspace_id ASC
        LIMIT ?`,
      WORKSPACE_IDLE_CHECK_INTERVAL_MS,
      now,
      limit
    )
    .toArray()
    .map((row) => parseWorkspaceIdleCheck(row));
}

/**
 * The project's workspace idle timeout, else the installation default; `null` when the project's
 * setting could not be read. The sweep then records no verdict: falling back to a default shorter
 * than the project's setting would retire workspaces early.
 */
async function resolveWorkspaceIdleTimeoutMs(
  env: Env,
  projectId: string | null
): Promise<number | null> {
  const installationDefault = parsePositiveInt(
    env.WORKSPACE_IDLE_TIMEOUT_MS,
    DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS
  );
  if (!projectId) return installationDefault;
  try {
    const project = await env.DATABASE.prepare(
      'SELECT workspace_idle_timeout_ms FROM projects WHERE id = ?'
    )
      .bind(projectId)
      .first<{ workspace_idle_timeout_ms: number | null }>();
    const projectTimeoutMs = project?.workspace_idle_timeout_ms ?? 0;
    return projectTimeoutMs > 0 ? projectTimeoutMs : installationDefault;
  } catch (err) {
    log.warn('d1_project_timeout_query_failed', { projectId, ...serializeError(err) });
    return null;
  }
}

async function runWorkspaceIdleCheck(
  sweep: WorkspaceIdleSweep,
  check: WorkspaceIdleCheck
): Promise<void> {
  const idleDeadline = check.lastActivityAt + sweep.timeoutMs;
  if (idleDeadline > sweep.now) {
    recordWorkspaceIdleDeadline(sweep.sql, check.workspaceId, idleDeadline);
    return;
  }

  // The retry is recorded before any await: it holds even if retiring throws or the object is
  // evicted mid-check, and activity arriving meanwhile clears it rather than being overwritten.
  const retry = recordWorkspaceIdleRetry(sweep.sql, sweep.env, sweep.now, check);
  try {
    const outcome = await retireIdleWorkspace(sweep, check);
    if (outcome !== 'retired') {
      log.info('workspace_idle_check_deferred', {
        workspaceId: check.workspaceId,
        reason: outcome,
        ...retry,
      });
    }
  } catch (err) {
    log.error('workspace_idle_timeout_cleanup_failed', {
      workspaceId: check.workspaceId,
      ...retry,
      ...serializeError(err),
    });
  }
}

/** A workspace that is not idle yet is next checked when it would become idle. */
function recordWorkspaceIdleDeadline(
  sql: SqlStorage,
  workspaceId: string,
  idleDeadline: number
): void {
  sql.exec(
    `UPDATE workspace_activity
        SET idle_check_retry_count = 0,
            next_idle_check_at = ?
      WHERE workspace_id = ?`,
    idleDeadline,
    workspaceId
  );
}

/** A check that could not retire an idle workspace is retried after a bounded, growing delay. */
function recordWorkspaceIdleRetry(
  sql: SqlStorage,
  env: Env,
  now: number,
  check: WorkspaceIdleCheck
): { retryCount: number; nextIdleCheckAt: number } {
  const retryCount = check.idleCheckRetryCount + 1;
  const nextIdleCheckAt = now + workspaceIdleRetryDelayMs(env, check.idleCheckRetryCount);
  sql.exec(
    `UPDATE workspace_activity
        SET idle_check_retry_count = ?,
            next_idle_check_at = ?
      WHERE workspace_id = ?`,
    retryCount,
    nextIdleCheckAt,
    check.workspaceId
  );
  return { retryCount, nextIdleCheckAt };
}

function workspaceIdleRetryDelayMs(env: Env, previousRetries: number): number {
  const baseMs = parsePositiveInt(
    env.WORKSPACE_IDLE_BACKOFF_BASE_MS,
    DEFAULT_WORKSPACE_IDLE_BACKOFF_BASE_MS
  );
  const maxMs = Math.max(
    baseMs,
    parsePositiveInt(env.WORKSPACE_IDLE_BACKOFF_MAX_MS, DEFAULT_WORKSPACE_IDLE_BACKOFF_MAX_MS)
  );
  const exponent = Math.min(
    Math.max(previousRetries, 0),
    WORKSPACE_IDLE_BACKOFF_EXPONENT_SAFETY_CAP
  );
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * Fail the idle workspace's tasks and close it, but only once every reporter-scoped task's runtime
 * is conclusively dead; otherwise say why it has to wait.
 */
async function retireIdleWorkspace(
  sweep: WorkspaceIdleSweep,
  check: WorkspaceIdleCheck
): Promise<'retired' | WorkspaceIdleDeferral> {
  const { projectId, timeoutMs } = sweep;
  const { workspaceId, sessionId } = check;
  const idleDurationMs = sweep.now - check.lastActivityAt;
  log.info('workspace_idle_timeout', {
    workspaceId,
    sessionId,
    lastActivity: check.lastActivityAt,
    timeoutMs,
    idleDurationMs,
  });

  if (!projectId) {
    log.warn('workspace_idle_reporter_identity_incomplete', {
      projectId,
      workspaceId,
      sessionId,
      action: 'preserved',
    });
    return 'reporter_identity_incomplete';
  }

  const candidates = await listReporterScopedTaskCandidates(
    sweep.env.DATABASE,
    { projectId, workspaceId, sessionId },
    sweep.candidateLimit
  );
  if (candidates.overflow || candidates.tasks.length === 0) {
    log.warn('workspace_idle_candidates_inconclusive', {
      projectId,
      workspaceId,
      sessionId,
      candidateLimit: sweep.candidateLimit,
      selectedCount: candidates.tasks.length,
      overflow: candidates.overflow,
      action: 'preserved',
    });
    return candidates.overflow ? 'candidate_overflow' : 'no_candidate_tasks';
  }

  const transitions = [];
  for (const { id } of candidates.tasks) {
    transitions.push(
      await terminalizeIdleTaskInD1(sweep.sql, sweep.env, {
        sweep: 'workspace_idle_timeout',
        projectId,
        taskId: id,
        workspaceId,
        sessionId,
        idleDurationMs,
        timeoutMs,
      })
    );
  }
  if (!transitions.every((transition) => transition.outcome === 'failed')) {
    log.info('workspace_idle_runtime_preserved', {
      projectId,
      workspaceId,
      sessionId,
      outcomes: transitions.map((transition) => transition.outcome),
      reasons: transitions.map((transition) => transition.liveness?.reason ?? null),
      action: 'preserved',
    });
    return 'runtime_preserved';
  }

  await closeIdleWorkspace(
    sweep,
    check,
    projectId,
    transitions.map((transition) => transition.taskId)
  );
  return 'retired';
}

async function closeIdleWorkspace(
  sweep: WorkspaceIdleSweep,
  check: WorkspaceIdleCheck,
  projectId: string,
  failedTaskIds: string[]
): Promise<void> {
  const { sql } = sweep;
  const { workspaceId, sessionId } = check;
  stopSessionInternal(sql, sessionId);
  upsertActivityState(sql, sessionId, { activity: 'idle' });
  try {
    materializeSession(sql, sessionId, resolveMaterializationPassConfig(sweep.env));
  } catch (e) {
    log.error('materialize_session_on_idle_timeout_failed', { sessionId, error: String(e) });
  }

  await sweep.deleteWorkspaceInD1(workspaceId, projectId);
  sql.exec('DELETE FROM workspace_activity WHERE workspace_id = ?', workspaceId);

  const reporterTaskId = failedTaskIds[0] ?? null;
  const idleDurationMs = sweep.now - check.lastActivityAt;
  recordActivityEventInternal(
    sql,
    'workspace.idle_timeout',
    'system',
    null,
    workspaceId,
    sessionId,
    reporterTaskId,
    JSON.stringify({
      lastActivity: check.lastActivityAt,
      timeoutMs: sweep.timeoutMs,
      idleDurationMs,
      failedTaskIds,
    })
  );
  sweep.broadcastEvent('workspace.idle_timeout', {
    workspaceId,
    sessionId,
    taskId: reporterTaskId,
    failedTaskIds,
  });
  sweep.scheduleSummarySync();
}
