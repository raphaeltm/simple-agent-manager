/**
 * ProjectData-local ACP liveness signals for one task: its ACP sessions and
 * whether a prompt turn or harness work is positively in flight.
 *
 * Split out of `task-runtime-liveness.ts` (`.claude/rules/18`). ACP state is read
 * directly from this DO's SQLite storage, never through self-RPC.
 */
import type { SessionStateSnapshot } from '@simple-agent-manager/shared';

import {
  getFreshHarnessWorkLeaseExpiry,
  type HarnessWorkConfig,
  parseHarnessWorkConfig,
} from '../../services/session-idleness';
import type {
  RuntimeAcpSessionSnapshot,
  RuntimeSessionWorkSnapshot,
  RuntimeWorkEvidenceSnapshot,
  RuntimeWorkState,
  TaskAcpLivenessSignals,
} from '../../services/task-runtime-liveness';
import { listAcpSessions } from './acp-sessions';
import { parseActivityStaleThreshold, WORKING_ACTIVITIES } from './session-state';
import type { Env } from './types';

/**
 * The `session_state.activity` labels evidence may echo. Typed against the shared
 * snapshot type so a label can only be added here if the schema knows it. Any
 * other stored value is reported as null rather than copied into logs.
 */
const REPORTABLE_ACTIVITIES: ReadonlySet<string> = new Set<SessionStateSnapshot['activity']>([
  'idle',
  'prompting',
  'recovering',
  'error',
  'stopped',
]);

function freshNumber(value: unknown, floor: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) return null;
  return value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maxFreshEvidence(floor: number, ...values: unknown[]): number | null {
  const freshValues = values
    .map((value) => freshNumber(value, floor))
    .filter((value): value is number => value !== null);
  return freshValues.length > 0 ? Math.max(...freshValues) : null;
}

function isWorkingActivityName(value: unknown): boolean {
  return typeof value === 'string' && (WORKING_ACTIVITIES as readonly string[]).includes(value);
}

interface WorkClassificationContext {
  /** Working-activity evidence older than this (ms epoch) is unproven. */
  activityFloor: number;
  now: Date;
  harnessWorkConfig: HarnessWorkConfig;
}

/**
 * Classify one ACP session's work. This is the ONE place that decides whether a
 * prompt turn or harness work is positively in flight: `sessionWork` (a verdict
 * input) and the work evidence (a description) are both read from its answer,
 * so the description cannot disagree with the verdict.
 */
function classifySessionWorkRow(
  row: Record<string, SqlStorageValue>,
  context: WorkClassificationContext
): RuntimeWorkEvidenceSnapshot | null {
  const acpSessionId = typeof row.acp_session_id === 'string' ? row.acp_session_id : null;
  if (!acpSessionId) return null;

  const working = isWorkingActivityName(row.activity);
  let state: RuntimeWorkState;
  if (
    working &&
    maxFreshEvidence(context.activityFloor, row.prompt_started_at, row.activity_at) !== null
  ) {
    state = 'prompt_turn_active';
  } else if (
    getFreshHarnessWorkLeaseExpiry(
      {
        runtimeWorkState:
          typeof row.runtime_work_state === 'string' ? row.runtime_work_state : null,
        runtimeWorkUpdatedAt: numberOrNull(row.runtime_work_updated_at),
        runtimeWorkProgressAt: numberOrNull(row.runtime_work_progress_at),
      },
      context.now,
      context.harnessWorkConfig.leaseMs,
      context.harnessWorkConfig.maxDurationMs
    )
  ) {
    state = 'runtime_work_active';
  } else if (working) {
    state = 'prompt_turn_unproven';
  } else {
    state = row.activity === 'idle' ? 'idle' : 'unknown';
  }

  return {
    acpSessionId,
    state,
    activity:
      typeof row.activity === 'string' && REPORTABLE_ACTIVITIES.has(row.activity)
        ? row.activity
        : null,
    activityAt: numberOrNull(row.activity_at),
    promptStartedAt: numberOrNull(row.prompt_started_at),
    runtimeWorkProgressAt: numberOrNull(row.runtime_work_progress_at),
  };
}

function readTaskSessionWorkEvidence(
  sql: SqlStorage,
  env: Env,
  opts: { chatSessionId: string; workspaceId: string; limit: number; nowMs: number }
): RuntimeWorkEvidenceSnapshot[] {
  const rows = sql
    .exec(
      `SELECT acp.id AS acp_session_id,
              ss.activity AS activity,
              ss.activity_at AS activity_at,
              ss.prompt_started_at AS prompt_started_at,
              ss.runtime_work_state AS runtime_work_state,
              ss.runtime_work_updated_at AS runtime_work_updated_at,
              ss.runtime_work_progress_at AS runtime_work_progress_at
       FROM acp_sessions acp
       LEFT JOIN session_state ss ON ss.session_id = acp.id
       WHERE acp.chat_session_id = ?
         AND acp.workspace_id = ?
         AND acp.status IN ('assigned', 'running')
       ORDER BY COALESCE(acp.started_at, acp.assigned_at, acp.updated_at, acp.created_at) DESC
       LIMIT ?`,
      opts.chatSessionId,
      opts.workspaceId,
      opts.limit
    )
    .toArray();

  const context: WorkClassificationContext = {
    activityFloor:
      opts.nowMs - parseActivityStaleThreshold(env.SESSION_ACTIVITY_STALE_THRESHOLD_MS),
    now: new Date(opts.nowMs),
    harnessWorkConfig: parseHarnessWorkConfig(env),
  };
  return rows
    .map((row) => classifySessionWorkRow(row, context))
    .filter((evidence): evidence is RuntimeWorkEvidenceSnapshot => evidence !== null);
}

/** The newest ACP session with positive in-flight work, as a liveness verdict input. */
function sessionWorkFromEvidence(
  evidence: RuntimeWorkEvidenceSnapshot[]
): RuntimeSessionWorkSnapshot | null {
  const active = evidence.find(
    (entry) => entry.state === 'prompt_turn_active' || entry.state === 'runtime_work_active'
  );
  if (!active) return null;
  return {
    active: true,
    activeAcpSessionId: active.acpSessionId,
    reason:
      active.state === 'prompt_turn_active'
        ? 'task_prompt_turn_active'
        : 'task_runtime_work_active',
  };
}

export function readTaskAcpLivenessSignals(
  sql: SqlStorage,
  env: Env,
  opts: { chatSessionId: string; workspaceId: string; limit: number; nowMs?: number }
): TaskAcpLivenessSignals {
  const { sessions, total } = listAcpSessions(sql, {
    chatSessionId: opts.chatSessionId,
    limit: opts.limit,
  });
  const workEvidence = readTaskSessionWorkEvidence(sql, env, {
    chatSessionId: opts.chatSessionId,
    workspaceId: opts.workspaceId,
    limit: opts.limit,
    nowMs: opts.nowMs ?? Date.now(),
  });
  return {
    sessions: sessions as RuntimeAcpSessionSnapshot[],
    total,
    sessionWork: sessionWorkFromEvidence(workEvidence),
    workEvidence,
  };
}
