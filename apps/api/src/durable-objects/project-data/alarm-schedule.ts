/**
 * Shared ProjectData alarm scheduling.
 *
 * Keep every path that reschedules the Durable Object alarm on the same
 * candidate set. Lifecycle checks are coupled: heartbeat updates must not hide
 * task reconciliation or workspace idle deadlines.
 */
import { createModuleLogger } from '../../lib/logger';
import * as acpSessions from './acp-sessions';
import * as attention from './attention';
import { resolveDurableExecutionConfig } from './durable-execution-config';
import * as idleCleanup from './idle-cleanup';
import * as mailbox from './mailbox';
import { computeScheduleAlarmTime } from './project-event-schedules-runner';
import {
  computeProjectEventMaterializationAlarmTime,
  computeProjectEventRetentionAlarmTime,
} from './project-events-scheduler';
import { computeStandingWatchAlarmTime } from './project-standing-watches-runner';
import { computePromptDeliveryAlarmTime } from './prompt-delivery';
import * as reconciliation from './reconciliation';
import { parseMetaValue } from './row-schemas';
import { computeSessionActivityProbeAlarmTime } from './session-activity-reconciliation';
import { computeStorageSafetyAlarmTime } from './storage-safety-alarm-time';
import { computeTaskWaitAlarmTime } from './task-waits';
import type { Env } from './types';

const log = createModuleLogger('project_data.alarm_schedule');

/**
 * The maintenance sections `ProjectData.alarm()` runs, in the order it runs them. Storage safety
 * stays second: it is the quota firebreak and must reclaim bytes before heavier lifecycle work.
 */
export const PROJECT_DATA_ALARM_SECTIONS = [
  'runtime_heartbeat_timeouts',
  'storage_safety',
  'workspace_idle_timeouts',
  'expired_idle_cleanups',
  'task_reconciliation',
  'attention_expiry',
  'session_activity_probe',
  'mailbox_delivery_sweep',
  'project_event_wake_materialization',
  'scheduled_actions',
  'task_waits',
  'prompt_delivery',
  'project_event_retention',
] as const;

export type ProjectDataAlarmSection = (typeof PROJECT_DATA_ALARM_SECTIONS)[number];

/** When each section next needs the alarm; `null` means it has nothing scheduled. */
export type ProjectDataAlarmSectionTimes = Record<ProjectDataAlarmSection, number | null>;

/**
 * Retry spacing for a section whose schedule could not be computed or whose run threw.
 *
 * Deliberately NOT env-configurable, for the reason `STORAGE_SAFETY_MIN_ALARM_SPACING_MS` gives:
 * it is a safety invariant, not a cadence. A failing section whose due time is already in the past
 * would otherwise re-arm the alarm at `now` on every tick — a hot loop through a successful
 * `alarm()` that no platform backoff throttles.
 */
export const PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS = 60_000;

/**
 * Per-section due times. One section's schedule query failing must not stop the others from being
 * scheduled (`.claude/rules/53`), so each is computed in isolation; a failed one is retried after
 * `PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS` rather than dropped.
 */
export function computeProjectDataAlarmSectionTimes(
  sql: SqlStorage,
  env: Env,
  now: number = Date.now()
): ProjectDataAlarmSectionTimes {
  const projectId = readStoredProjectId(sql);
  const failedRetryAt = now + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS;
  const compute = (section: ProjectDataAlarmSection, fn: () => number | null): number | null => {
    try {
      return fn();
    } catch (error) {
      log.error('section_schedule_failed', {
        projectId,
        section,
        error: error instanceof Error ? error.message : String(error),
        retryAt: failedRetryAt,
      });
      return failedRetryAt;
    }
  };
  const idleTimes = (() => {
    try {
      return idleCleanup.computeIdleAlarmTimes(sql);
    } catch (error) {
      log.error('section_schedule_failed', {
        projectId,
        section: 'workspace_idle_timeouts+expired_idle_cleanups',
        error: error instanceof Error ? error.message : String(error),
        retryAt: failedRetryAt,
      });
      return { idleCleanupTime: failedRetryAt, workspaceIdleCheckTime: failedRetryAt };
    }
  })();

  return {
    runtime_heartbeat_timeouts: compute('runtime_heartbeat_timeouts', () =>
      acpSessions.computeHeartbeatAlarmTime(sql, env)
    ),
    storage_safety: compute('storage_safety', () => computeStorageSafetyAlarmTime(sql, env)),
    workspace_idle_timeouts: idleTimes.workspaceIdleCheckTime,
    expired_idle_cleanups: idleTimes.idleCleanupTime,
    task_reconciliation: compute('task_reconciliation', () =>
      reconciliation.computeReconciliationAlarmTime(sql, env)
    ),
    attention_expiry: compute('attention_expiry', () => attention.computeAttentionAlarmTime(sql)),
    // Conversation-mode sessions contribute no reconciliation alarm (that query is task-scoped), so
    // stale-activity probes need their own entry rather than relying on the ACP heartbeat alarm
    // happening to fire on a similar cadence.
    session_activity_probe: compute('session_activity_probe', () =>
      computeSessionActivityProbeAlarmTime(sql, env)
    ),
    mailbox_delivery_sweep: compute('mailbox_delivery_sweep', () => {
      const pollIntervalMs = Number.parseInt(env.MAILBOX_DELIVERY_POLL_INTERVAL_MS ?? '30000', 10);
      return mailbox.computeMailboxAlarmTime(sql, pollIntervalMs);
    }),
    project_event_wake_materialization: compute('project_event_wake_materialization', () =>
      computeProjectEventMaterializationAlarmTime(sql, env, projectId)
    ),
    scheduled_actions: compute('scheduled_actions', () =>
      earliest([
        computeScheduleAlarmTime(sql, projectId),
        computeStandingWatchAlarmTime(sql, env, projectId),
      ])
    ),
    task_waits: compute('task_waits', () => computeTaskWaitAlarmTime(sql)),
    prompt_delivery: computePromptDeliverySectionTime(sql, env),
    project_event_retention: compute('project_event_retention', () =>
      computeProjectEventRetentionAlarmTime(sql, env, projectId)
    ),
  };
}

/**
 * Invalid durability configuration fails the durable delivery engine closed (no alarm for it)
 * while leaving every other ProjectData lifecycle alarm scheduled.
 */
function computePromptDeliverySectionTime(sql: SqlStorage, env: Env): number | null {
  let deliveryConfig: ReturnType<typeof resolveDurableExecutionConfig>;
  try {
    deliveryConfig = resolveDurableExecutionConfig(env);
  } catch (error) {
    log.error('durable_delivery_config_invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!deliveryConfig.deliveryEnabled) return null;
  try {
    return computePromptDeliveryAlarmTime(sql, deliveryConfig);
  } catch (error) {
    const retryAt = Date.now() + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS;
    log.error('section_schedule_failed', {
      section: 'prompt_delivery',
      error: error instanceof Error ? error.message : String(error),
      retryAt,
    });
    return retryAt;
  }
}

function earliest(times: Iterable<number | null>): number | null {
  let min: number | null = null;
  for (const time of times) {
    if (time !== null && (min === null || time < min)) min = time;
  }
  return min;
}

/**
 * Earliest instant any of `times` needs the alarm. Persisted retry deadlines may be overdue,
 * including epoch zero; Cloudflare rejects non-positive alarm times, so overdue work runs now.
 */
export function earliestAlarmTime(
  times: Iterable<number | null>,
  now: number = Date.now()
): number | null {
  const min = earliest(times);
  return min === null ? null : Math.max(now, min);
}

export function computeProjectDataAlarmTime(sql: SqlStorage, env: Env): number | null {
  return earliestAlarmTime(Object.values(computeProjectDataAlarmSectionTimes(sql, env)));
}

function readStoredProjectId(sql: SqlStorage): string | null {
  const row = sql.exec('SELECT value FROM do_meta WHERE key = ?', 'projectId').toArray()[0];
  return row ? parseMetaValue(row, 'project_data.alarm_schedule.project_id') : null;
}
