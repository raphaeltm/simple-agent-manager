/**
 * Failing automations as inbox error items (inbox slice E). An automation (`triggers` row) that
 * has failed `inbox.automationFailureThreshold` runs in a row files one item for its owner; it is
 * updated in place as the streak grows or the automation is auto-paused
 * (`trigger-admission.ts`, `TRIGGER_AUTO_PAUSE_AFTER_FAILURES`), and closes by itself when a run
 * succeeds or the automation is resumed (both end the streak in `consecutiveFailureCount`, which
 * honours the resume reset sequence) or when it is disabled or deleted.
 *
 * Both halves run in the minute cron as one isolated step:
 * - file: failed runs completed inside `inbox.errorLookbackMinutes`
 *   (`idx_trigger_executions_failed_completed`) whose failure the trigger's item does not reflect
 *   yet, at most `inbox.errorSweepBatchSize` automations per tick, one streak read each;
 * - close: open (or archived) automation items holding a dedupe key (`idx_asks_error_key`), at
 *   most four times `inbox.errorSweepBatchSize` per tick, oldest first, one read each
 *   (`automationRecovered`); an item whose automation has since been auto-paused is refreshed
 *   to say so and offer Resume (one streak read and one update).
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

/**
 * Whether the streak ended: the newest finished run inside the current failure window
 * (`auto_pause_reset_sequence`, moved by a resume) succeeded, or none has finished since a resume.
 * A run still in flight decides nothing, so an item does not close and reopen around it.
 */
async function automationRecovered(
  env: Env,
  projectId: string,
  triggerId: string
): Promise<boolean> {
  const latest = await env.DATABASE.prepare(
    `SELECT e.status FROM trigger_executions e
       JOIN triggers tr ON tr.id = e.trigger_id AND tr.project_id = ?
      WHERE e.trigger_id = ? AND e.status IN ('completed', 'failed')
        AND (tr.auto_pause_reset_sequence IS NULL
          OR e.sequence_number >= tr.auto_pause_reset_sequence)
      ORDER BY e.sequence_number DESC, e.created_at DESC LIMIT 1`
  )
    .bind(projectId, triggerId)
    .first<{ status: string }>();
  return latest?.status !== 'failed';
}

export interface AutomationErrorSweepStats {
  checked: number;
  filed: number;
  closed: number;
}

export async function runInboxAutomationErrorSweep(
  env: Env,
  now = Date.now()
): Promise<AutomationErrorSweepStats> {
  const limits = await getInboxLimits(systemErrorDeps(env));
  const threshold = limits.automationFailureThreshold;
  const since = new Date(now - limits.errorLookbackMinutes * 60_000).toISOString();
  // The newest failed run per automation whose item does not reflect it yet.
  const candidates = await env.DATABASE.prepare(
    `SELECT e.trigger_id, tr.project_id, tr.user_id, tr.name, tr.status, e.error_message
       FROM trigger_executions e
       JOIN triggers tr ON tr.id = e.trigger_id AND tr.project_id = e.project_id
      WHERE e.status = 'failed' AND e.completed_at > ? AND tr.status IN ('active', 'paused')
        AND NOT EXISTS (SELECT 1 FROM asks a
          WHERE a.kind = 'error' AND a.project_id = tr.project_id
            AND a.dedupe_key = '${KEY_PREFIX}' || tr.id
            AND a.updated_at >= CAST((julianday(e.completed_at) - 2440587.5) * 86400000 AS INTEGER))
      ORDER BY e.completed_at DESC LIMIT ?`
  )
    .bind(since, threshold > 0 ? limits.errorSweepBatchSize * 4 : 0)
    .all<FailingTriggerRow>();
  const seen = new Set<string>();
  let checked = 0;
  let filed = 0;
  for (const row of candidates.results ?? []) {
    if (seen.has(row.trigger_id) || seen.size >= limits.errorSweepBatchSize) continue;
    seen.add(row.trigger_id);
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

  const open = await env.DATABASE.prepare(
    `SELECT a.project_id, a.dedupe_key, a.answer_spec_json, tr.id AS trigger_id,
            tr.status AS trigger_status, tr.user_id, tr.name,
            (SELECT e.error_message FROM trigger_executions e
              WHERE e.trigger_id = tr.id AND e.status = 'failed'
              ORDER BY e.sequence_number DESC LIMIT 1) AS error_message
       FROM asks a
       LEFT JOIN triggers tr ON tr.project_id = a.project_id
         AND tr.id = substr(a.dedupe_key, ${KEY_PREFIX.length + 1})
      WHERE a.kind = 'error' AND a.dedupe_key IS NOT NULL
        AND a.dedupe_key >= 'error:automation:' AND a.dedupe_key < 'error:automation;'
        AND a.status IN ('open', 'archived')
        -- A paused automation whose item already offers Resume cannot recover until a person
        -- acts, so it does not hold a slot of this page (rule 47); a resume brings it back.
        AND NOT (tr.status = 'paused' AND a.answer_spec_json LIKE '%"resume"%')
      ORDER BY a.updated_at LIMIT ?`
  )
    .bind(limits.errorSweepBatchSize * 4)
    .all<{
      project_id: string;
      dedupe_key: string;
      answer_spec_json: string | null;
      trigger_id: string | null;
      trigger_status: string | null;
      user_id: string | null;
      name: string | null;
      error_message: string | null;
    }>();
  let closed = 0;
  for (const item of open.results ?? []) {
    const subjectId = item.dedupe_key.slice(KEY_PREFIX.length);
    try {
      let resolution: 'recovered' | 'cancelled' | null = null;
      // Deleted or switched off by a person: there is nothing left to fix.
      if (!item.trigger_id || item.trigger_status === 'disabled') resolution = 'cancelled';
      else if (await automationRecovered(env, item.project_id, item.trigger_id))
        resolution = 'recovered';
      if (resolution) {
        closed += await resolveSystemError(
          { env },
          { projectId: item.project_id, source: 'automation', subjectId, resolution }
        );
        continue;
      }
      // Auto-pause happens at the next fire (`trigger-admission.ts`) and records no run, so the
      // failed-run scan above never sees it: refresh the item here so it says paused and offers
      // Resume.
      const triggerId = item.trigger_id;
      if (
        triggerId &&
        item.trigger_status === 'paused' &&
        item.user_id &&
        !(item.answer_spec_json ?? '').includes('"resume"')
      ) {
        const streak = await consecutiveFailureCount(env, triggerId, 50);
        if (streak.count > 0) {
          const refreshed = await fileAndNotify(
            env,
            automationFailureError(
              {
                trigger_id: triggerId,
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
        }
      }
    } catch (error) {
      log.error('inbox.automation_error_close_failed', {
        projectId: item.project_id,
        triggerId: subjectId,
        ...serializeError(error),
      });
    }
  }

  const stats = { checked, filed, closed };
  if (filed > 0 || closed > 0) log.info('inbox.automation_error_sweep', stats);
  return stats;
}
