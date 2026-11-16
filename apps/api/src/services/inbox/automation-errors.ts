/**
 * Failing automations as inbox error items (inbox slice E). An automation (`triggers` row) that
 * has failed `inbox.automationFailureThreshold` runs in a row files one item for its owner; it is
 * updated in place as the streak grows or the automation is auto-paused
 * (`trigger-admission.ts`, `TRIGGER_AUTO_PAUSE_AFTER_FAILURES`), and closes by itself when a run
 * succeeds or the automation is resumed (both end the streak in `consecutiveFailureCount`, which
 * honours the resume reset sequence) or when it is disabled or deleted.
 *
 * Both halves run in the five-minute operational cron as one isolated step, each half isolated on its own:
 * - file: automations with a failed run completed inside `inbox.errorLookbackMinutes`
 *   (`idx_trigger_executions_failed_completed`) that their item does not reflect yet, one row per
 *   automation, at most `4 × inbox.errorSweepBatchSize` checked (one streak read each) and
 *   `inbox.errorSweepBatchSize` filed per tick;
 * - close: open or archived automation items holding a dedupe key (`idx_asks_error_key`), each
 *   with its latest finished run read in the same statement
 *   (`idx_trigger_executions_trigger_finished`, one seek per item); only items that can close or
 *   need Resume are returned, at most `4 × inbox.errorSweepBatchSize`, so a still-failing
 *   automation costs one seek a tick and never holds a slot.
 */
import {
  getInboxLimits,
  quotedName,
  resolveSystemError,
  type SystemErrorInput,
} from '@simple-agent-manager/operations';
import { classifyFailure } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { consecutiveFailureCount } from '../trigger-failure-window';
import { fileAndNotify, systemErrorDeps } from './system-errors';

interface FailingTriggerRow {
  trigger_id: string;
  project_id: string;
  user_id: string;
  name: string | null;
  status: string;
  error_message: string | null;
}

const KEY_PREFIX = 'error:automation:';

/** The item for an automation `failures` runs into a failure streak. Never quotes the error. */
export function automationFailureError(row: FailingTriggerRow, failures: number): SystemErrorInput {
  const name = quotedName(row.name, 'An automation');
  const paused = row.status === 'paused';
  return {
    projectId: row.project_id,
    assigneeUserId: row.user_id,
    source: 'automation',
    subjectId: row.trigger_id,
    title: paused
      ? `Automation ${name} was paused after ${failures} failed runs`
      : `Automation ${name} failed its last ${failures} runs`,
    body: classifyFailure(row.error_message).explanation,
    actions: paused ? ['resume'] : [],
    links: [{ kind: 'trigger', id: row.trigger_id, label: row.name }],
    failureCount: failures,
  };
}

export interface AutomationErrorSweepStats {
  checked: number;
  filed: number;
  closed: number;
}

/**
 * The newest finished run inside an automation's current failure window
 * (`auto_pause_reset_sequence`, moved by a resume): the streak ended when it succeeded or when
 * none has finished since a resume. A run still in flight decides nothing, so an item does not
 * close and reopen around it. One seek on `idx_trigger_executions_trigger_finished`.
 */
const LATEST_FINISHED_STATUS_SQL = `(SELECT e.status FROM trigger_executions e
  WHERE e.trigger_id = tr.id AND e.status IN ('completed', 'failed')
    AND (tr.auto_pause_reset_sequence IS NULL
      OR e.sequence_number >= tr.auto_pause_reset_sequence)
  ORDER BY e.sequence_number DESC LIMIT 1)`;

export async function runInboxAutomationErrorSweep(
  env: Env,
  now = Date.now()
): Promise<AutomationErrorSweepStats> {
  const limits = await getInboxLimits(systemErrorDeps(env));
  const threshold = limits.automationFailureThreshold;
  const since = new Date(now - limits.errorLookbackMinutes * 60_000).toISOString();
  let checked = 0;
  let filed = 0;
  let closed = 0;

  // File: one row per automation with a failed run in the window that its item does not reflect
  // yet. An archived item reflects every run (the person said they will not act; the key stays
  // until the automation recovers), so it never holds a slot here.
  try {
    const candidates = await env.DATABASE.prepare(
      // SQLite: bare columns of a MAX() aggregate come from the row holding the maximum, so
      // error_message is the newest failed run's.
      `SELECT e.trigger_id, tr.project_id, tr.user_id, tr.name, tr.status, e.error_message,
              MAX(e.completed_at) AS last_failed_at
         FROM trigger_executions e
         JOIN triggers tr ON tr.id = e.trigger_id AND tr.project_id = e.project_id
        WHERE e.status = 'failed' AND e.completed_at > ? AND tr.status IN ('active', 'paused')
          AND NOT EXISTS (SELECT 1 FROM asks a
            WHERE a.project_id = tr.project_id AND a.dedupe_key = '${KEY_PREFIX}' || tr.id
              AND (a.status = 'archived'
                OR a.updated_at >= CAST((julianday(e.completed_at) - 2440587.5) * 86400000 AS INTEGER)))
        GROUP BY e.trigger_id
        ORDER BY last_failed_at DESC LIMIT ?`
    )
      .bind(since, threshold > 0 ? limits.errorSweepBatchSize * 4 : 0)
      .all<FailingTriggerRow>();
    for (const row of candidates.results ?? []) {
      if (filed >= limits.errorSweepBatchSize) break;
      checked += 1;
      try {
        const streak = await consecutiveFailureCount(env, row.trigger_id, Math.max(threshold, 50));
        if (streak.count < threshold) continue;
        const result = await fileAndNotify(
          env,
          automationFailureError(row, streak.count),
          'cron_failure'
        );
        if (result) filed += 1;
      } catch (error) {
        log.error('inbox.automation_error_check_failed', {
          triggerId: row.trigger_id,
          projectId: row.project_id,
          ...serializeError(error),
        });
      }
    }
  } catch (error) {
    log.error('inbox.automation_error_scan_failed', serializeError(error));
  }

  // Close or refresh: only the items that need something, decided in SQL so a still-failing
  // automation costs one index seek and never holds a slot of the page (rule 47). An item closes
  // when its automation is gone or disabled (`cancelled`) or its streak ended (`recovered`); an
  // open item whose automation was auto-paused (at the next fire, `trigger-admission.ts`, which
  // records no run the file half could see) is refreshed to say so and offer Resume.
  try {
    const open = await env.DATABASE.prepare(
      `SELECT * FROM (
         SELECT a.project_id, a.dedupe_key, a.status AS item_status, a.answer_spec_json,
                a.updated_at AS item_updated_at, tr.id AS trigger_id,
                tr.status AS trigger_status, tr.user_id, tr.name,
                ${LATEST_FINISHED_STATUS_SQL} AS latest_status,
                (SELECT e.error_message FROM trigger_executions e
                  WHERE e.trigger_id = tr.id AND e.status = 'failed'
                  ORDER BY e.sequence_number DESC LIMIT 1) AS error_message
           FROM asks a
           LEFT JOIN triggers tr ON tr.project_id = a.project_id
             AND tr.id = substr(a.dedupe_key, ${KEY_PREFIX.length + 1})
          WHERE a.kind = 'error' AND a.dedupe_key IS NOT NULL
            AND a.dedupe_key >= 'error:automation:' AND a.dedupe_key < 'error:automation;'
            AND a.status IN ('open', 'archived'))
        WHERE trigger_id IS NULL OR trigger_status = 'disabled'
           OR latest_status IS NOT 'failed'
           OR (trigger_status = 'paused' AND item_status = 'open'
             AND COALESCE(answer_spec_json, '') NOT LIKE '%"resume"%')
        ORDER BY item_updated_at LIMIT ?`
    )
      .bind(limits.errorSweepBatchSize * 4)
      .all<{
        project_id: string;
        dedupe_key: string;
        trigger_id: string | null;
        trigger_status: string | null;
        user_id: string | null;
        name: string | null;
        latest_status: string | null;
        error_message: string | null;
      }>();
    for (const item of open.results ?? []) {
      const subjectId = item.dedupe_key.slice(KEY_PREFIX.length);
      try {
        // Deleted or switched off by a person: there is nothing left to fix.
        const resolution =
          !item.trigger_id || item.trigger_status === 'disabled'
            ? ('cancelled' as const)
            : item.latest_status !== 'failed'
              ? ('recovered' as const)
              : null;
        if (resolution) {
          closed += await resolveSystemError(
            { env },
            { projectId: item.project_id, source: 'automation', subjectId, resolution }
          );
          continue;
        }
        if (!item.trigger_id || !item.user_id) continue;
        const streak = await consecutiveFailureCount(env, item.trigger_id, 50);
        if (streak.count === 0) continue;
        const refreshed = await fileAndNotify(
          env,
          automationFailureError(
            {
              trigger_id: item.trigger_id,
              project_id: item.project_id,
              user_id: item.user_id,
              name: item.name,
              status: 'paused',
              error_message: item.error_message,
            },
            streak.count
          ),
          'cron_failure'
        );
        if (refreshed) filed += 1;
      } catch (error) {
        log.error('inbox.automation_error_close_failed', {
          projectId: item.project_id,
          triggerId: subjectId,
          ...serializeError(error),
        });
      }
    }
  } catch (error) {
    log.error('inbox.automation_error_close_scan_failed', serializeError(error));
  }

  const stats = { checked, filed, closed };
  if (filed > 0 || closed > 0) log.info('inbox.automation_error_sweep', stats);
  return stats;
}
