/**
 * ProjectData-local ACP liveness signals for one task: its ACP sessions and
 * whether a prompt turn or harness work is positively in flight.
 *
 * Split out of `task-runtime-liveness.ts` (`.claude/rules/18`). ACP state is read
 * directly from this DO's SQLite storage, never through self-RPC.
 */
import {
  getFreshHarnessWorkLeaseExpiry,
  parseHarnessWorkConfig,
} from '../../services/session-idleness';
import type {
  RuntimeAcpSessionSnapshot,
  RuntimeSessionWorkSnapshot,
  TaskAcpLivenessSignals,
} from '../../services/task-runtime-liveness';
import { listAcpSessions } from './acp-sessions';
import { parseActivityStaleThreshold, WORKING_ACTIVITIES } from './session-state';
import type { Env } from './types';

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

function readTaskSessionWork(
  sql: SqlStorage,
  env: Env,
  opts: { chatSessionId: string; workspaceId: string; limit: number; nowMs: number }
): RuntimeSessionWorkSnapshot | null {
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

  const activityFloor =
    opts.nowMs - parseActivityStaleThreshold(env.SESSION_ACTIVITY_STALE_THRESHOLD_MS);
  const harnessWorkConfig = parseHarnessWorkConfig(env);
  const now = new Date(opts.nowMs);

  for (const row of rows) {
    const activeAcpSessionId = typeof row.acp_session_id === 'string' ? row.acp_session_id : null;
    if (!activeAcpSessionId) continue;

    if (
      isWorkingActivityName(row.activity) &&
      maxFreshEvidence(activityFloor, row.prompt_started_at, row.activity_at) !== null
    ) {
      return {
        active: true,
        activeAcpSessionId,
        reason: 'task_prompt_turn_active',
      };
    }

    const runtimeWorkLeaseExpiry = getFreshHarnessWorkLeaseExpiry(
      {
        runtimeWorkState:
          typeof row.runtime_work_state === 'string' ? row.runtime_work_state : null,
        runtimeWorkUpdatedAt: numberOrNull(row.runtime_work_updated_at),
        runtimeWorkProgressAt: numberOrNull(row.runtime_work_progress_at),
      },
      now,
      harnessWorkConfig.leaseMs,
      harnessWorkConfig.maxDurationMs
    );
    if (runtimeWorkLeaseExpiry) {
      return {
        active: true,
        activeAcpSessionId,
        reason: 'task_runtime_work_active',
      };
    }
  }

  return null;
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
  const nowMs = opts.nowMs ?? Date.now();
  return {
    sessions: sessions as RuntimeAcpSessionSnapshot[],
    total,
    sessionWork: readTaskSessionWork(sql, env, {
      chatSessionId: opts.chatSessionId,
      workspaceId: opts.workspaceId,
      limit: opts.limit,
      nowMs,
    }),
  };
}
