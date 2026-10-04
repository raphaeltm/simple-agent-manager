/**
 * What the stuck-task sweep records when it keeps an `in_progress` task past the
 * soft timeout because the task's runtime is demonstrably live.
 *
 * Lives outside `stuck-tasks.ts`, which is past the 800-line threshold with a
 * documented exception (`.claude/rules/18`).
 *
 * ## Why this exists
 *
 * Until 2026-10-04 every such skip logged, and persisted to `platform_errors`
 * every five minutes, "Skipped stuck task recovery: VM agent heartbeat is recent
 * (task running N min, hard timeout at 480 min)". Each part misled:
 *
 * - The live basis was usually the task's OWN ACP session heartbeat on an idle
 *   conversation awaiting its user, not a VM heartbeat, and the record never said
 *   which signal held or whether any work was in flight.
 * - The 480-minute "hard timeout" stopped being a kill threshold in PR #1567. A
 *   live runtime is bounded only by the absolute ceiling on runtime-generation age.
 * - 2,506 such rows were written in 7 days, the largest named source in the table.
 *
 * A parent agent read those rows as "recovery is heartbeat-only and bypasses the
 * hard timeout". The records now name the real basis, the work state with its
 * ages, the bound that actually applies, and (for an idle task) whether a sleep
 * is in flight to release its runtime. The durable row is written once per task
 * and liveness basis; the per-sweep log keeps the timeline.
 *
 * Nothing here decides anything. The preserve decision is the classifier's.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { persistError } from '../services/observability';
import {
  livenessEvidenceLogFields,
  type TaskRuntimeLiveness,
} from '../services/task-runtime-liveness';
import {
  loadTaskSleepPreservation,
  type TaskSleepPreservation,
} from '../services/task-sleep-preservation';

/** Historical identifier, kept so existing queries keep finding these rows. */
export const LIVE_RUNTIME_SKIP_RECOVERY_TYPE = 'stuck_task_heartbeat_skip';
/** Historical event name, kept for the same reason. */
export const LIVE_RUNTIME_SKIP_LOG_EVENT = 'stuck_task.skipped_active_heartbeat';

export interface LiveRuntimePreservation {
  task: {
    id: string;
    project_id: string;
    user_id: string;
    workspace_id: string | null;
    chat_session_id: string | null;
  };
  liveness: TaskRuntimeLiveness;
  /** Time since `tasks.started_at`. */
  executionMs: number;
  maxExecutionMs: number;
  absoluteCeilingMs: number;
  /** Age of the allocated runtime generation the ceiling measures; null when unknown. */
  runtimeGenerationMs: number | null;
}

type SleepSummary = Pick<TaskSleepPreservation, 'outcome' | 'sleepStatus' | 'arm'>;

export interface LiveRuntimePreservationRecord {
  level: 'info' | 'warn';
  /** One durable row per task and value of this key. */
  preservationKey: string;
  message: string;
  fields: Record<string, string | number | null>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function minutes(ms: number): number {
  return Math.round(ms / MINUTE_MS);
}

function formatAge(ms: number | null): string {
  if (ms === null) return 'an unknown time';
  if (ms < MINUTE_MS) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
}

/**
 * Only an agent that reports no work in flight needs its sleep state explained:
 * that is the case where compute stays allocated with nothing being done.
 */
function needsSleepSummary(liveness: TaskRuntimeLiveness): boolean {
  const workState = liveness.evidence?.workState ?? null;
  return (
    liveness.reason === 'task_acp_session_live' && (workState === 'idle' || workState === null)
  );
}

function describeSleep(sleep: SleepSummary | null): string {
  if (!sleep) return '';
  switch (sleep.outcome) {
    case 'preserve':
      return sleep.arm === 'in_flight'
        ? ` Its sleep is in flight or retrying (sleep status: ${sleep.sleepStatus ?? 'unknown'}).`
        : ' Its session already holds a restorable sleep record.';
    case 'none':
      return ' No sleep is scheduled or in flight for it.';
    case 'unknown':
      return ' Its sleep state could not be read.';
    case 'not_run':
      return ' It has no chat session to sleep.';
  }
}

function describeBasis(liveness: TaskRuntimeLiveness): { text: string; level: 'info' | 'warn' } {
  const evidence = liveness.evidence;
  const heartbeat = `ACP heartbeat ${formatAge(evidence?.acpHeartbeatAgeMs ?? null)} ago`;
  switch (liveness.reason) {
    case 'task_prompt_turn_active':
      return {
        level: 'info',
        text:
          `a prompt turn is in progress (last activity ${formatAge(evidence?.lastActivityAgeMs ?? null)} ago; ` +
          `turn started ${formatAge(evidence?.promptStartedAgeMs ?? null)} ago).`,
      };
    case 'task_runtime_work_active':
      return {
        level: 'info',
        text: `agent tool or background work is in flight (last progress ${formatAge(evidence?.runtimeWorkProgressAgeMs ?? null)} ago).`,
      };
    case 'cf_container_active_work':
      return { level: 'info', text: 'its Instant container reports active work.' };
    case 'task_acp_session_live':
      break;
    default:
      return { level: 'info', text: `its runtime is live (${liveness.reason}).` };
  }

  switch (evidence?.workState ?? null) {
    case 'idle':
      return {
        level: 'info',
        text:
          `its agent session is alive but idle (${heartbeat}; control handed back ` +
          `${formatAge(evidence?.lastActivityAgeMs ?? null)} ago; no prompt turn or tool work in flight). ` +
          'Idle sessions are released by automatic sleep, not by stuck-task recovery.',
      };
    case 'prompt_turn_unproven':
      // The heartbeat proves the agent process is alive, not that the turn is
      // progressing. Warn: a long tool call and a wedged prompt look the same.
      return {
        level: 'warn',
        text:
          `its agent session is alive (${heartbeat}), but its prompt turn has reported no progress ` +
          `for ${formatAge(evidence?.lastActivityAgeMs ?? null)} (turn started ` +
          `${formatAge(evidence?.promptStartedAgeMs ?? null)} ago); it may be on a long tool call or wedged.`,
      };
    default:
      return {
        level: 'info',
        text: `its agent session is alive (${heartbeat}; work state: ${evidence?.workState ?? 'not reported'}).`,
      };
  }
}

/** Build the record for one preserved task. Pure, so the wording is testable. */
export function describeLiveRuntimePreservation(
  input: LiveRuntimePreservation,
  sleep: SleepSummary | null
): LiveRuntimePreservationRecord {
  const { liveness } = input;
  const evidenceFields = livenessEvidenceLogFields(liveness);
  const preservationKey = `${liveness.reason}:${evidenceFields.workState ?? 'unreported'}`;
  const basis = describeBasis(liveness);
  const bound =
    input.runtimeGenerationMs === null
      ? `Task started ${minutes(input.executionMs)} min ago; the ${minutes(input.absoluteCeilingMs)}-min absolute ceiling could not be aged.`
      : `Task started ${minutes(input.executionMs)} min ago; a live runtime is bounded only by the ` +
        `${minutes(input.absoluteCeilingMs)}-min absolute ceiling on runtime-generation age ` +
        `(now ${minutes(input.runtimeGenerationMs)} min).`;

  return {
    level: basis.level,
    preservationKey,
    message:
      `Preserved in_progress task past the ${minutes(input.maxExecutionMs)}-min recovery check: ` +
      `${basis.text}${describeSleep(sleep)} Live basis: ${liveness.reason}. ${bound}`,
    fields: {
      preservationKey,
      taskId: input.task.id,
      projectId: input.task.project_id,
      nodeId: liveness.nodeId,
      activeAcpSessionId: liveness.activeAcpSessionId,
      ...evidenceFields,
      executionMs: input.executionMs,
      maxExecutionMs: input.maxExecutionMs,
      absoluteCeilingMs: input.absoluteCeilingMs,
      runtimeGenerationMs: input.runtimeGenerationMs,
      sleepOutcome: sleep?.outcome ?? null,
      sleepStatus: sleep?.sleepStatus ?? null,
      sleepArm: sleep?.arm ?? null,
    },
  };
}

async function loadSleepSummary(
  env: Env,
  task: LiveRuntimePreservation['task']
): Promise<SleepSummary> {
  // Through the shared predicate, never raw columns, so this reads sleep the way
  // the resumer and every terminal gate do (`.claude/rules/58`).
  const preservation = await loadTaskSleepPreservation(env.DATABASE, env, {
    id: task.id,
    projectId: task.project_id,
    chatSessionId: task.chat_session_id,
  });
  return {
    outcome: preservation.outcome,
    sleepStatus: preservation.sleepStatus,
    arm: preservation.arm,
  };
}

async function hasDurableRecord(env: Env, taskId: string, key: string): Promise<boolean> {
  try {
    const existing = await env.OBSERVABILITY_DATABASE.prepare(
      `SELECT id FROM platform_errors WHERE task_id = ? AND context LIKE ? LIMIT 1`
    )
      .bind(taskId, `%"preservationKey":"${key}"%`)
      .first();
    return existing !== null;
  } catch (err) {
    // A failed dedupe read costs one duplicate row, never a lost record.
    log.warn('stuck_task.live_runtime_record_lookup_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Log one preserved live task, and persist one durable row per task and liveness
 * basis. Never throws: diagnostics must not abort the sweep (`.claude/rules/53`).
 */
export async function recordLiveRuntimePreservation(
  env: Env,
  input: LiveRuntimePreservation
): Promise<void> {
  try {
    const sleep = needsSleepSummary(input.liveness)
      ? await loadSleepSummary(env, input.task)
      : null;
    const record = describeLiveRuntimePreservation(input, sleep);
    (record.level === 'warn' ? log.warn : log.info)(LIVE_RUNTIME_SKIP_LOG_EVENT, record.fields);

    if (await hasDurableRecord(env, input.task.id, record.preservationKey)) return;
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: record.level,
        message: record.message,
        context: { recoveryType: LIVE_RUNTIME_SKIP_RECOVERY_TYPE, ...record.fields },
        userId: input.task.user_id,
        nodeId: input.liveness.nodeId,
        workspaceId: input.task.workspace_id,
        taskId: input.task.id,
        sessionId: input.task.chat_session_id,
      },
      env
    );
  } catch (err) {
    log.warn('stuck_task.live_runtime_record_failed', {
      taskId: input.task.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
