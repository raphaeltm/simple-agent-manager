import type { DurabilityFoundationHooks } from './durability-foundation';
import { requireScheduleMember } from './project-event-schedules-authority';
import { scheduleLimits } from './project-event-schedules-config';
import { createSchedule } from './project-event-schedules-storage';
import { ProjectEventValidationError } from './project-events-contracts';
import { readEventById } from './project-events-storage-helpers';
import { readSubscriptionById } from './project-events-storage-helpers';
import { subscriptionCanMatchProjectEvent } from './project-events-visibility';
import { mapWatch, pauseWatch, readWatchRow } from './project-standing-watches-storage';
import type { Env } from './types';

function candidates(sql: SqlStorage, env: Env, projectId: string) {
  // The active watch cap bounds the outer loop; each match lookup seeks its
  // canonical subscription index and never walks the project's event history.
  return sql
    .exec(
      `SELECT * FROM project_standing_watches WHERE project_id = ? AND state = 'active'
    ORDER BY next_eligible_at, id LIMIT ?`,
      projectId,
      scheduleLimits(env).maxWatches
    )
    .toArray();
}

export function computeStandingWatchAlarmTime(sql: SqlStorage, env: Env, projectId: string | null) {
  if (!projectId) return null;
  let next: number | null = null;
  for (const row of candidates(sql, env, projectId)) {
    const watch = mapWatch(row);
    if (watch.executionCount >= watch.maxExecutions) continue;
    const match = sql
      .exec(
        `SELECT matched_at FROM project_event_matches
      WHERE project_id = ? AND subscription_id = ? AND state = 'matched' AND batch_id IS NULL
      ORDER BY matched_at, id LIMIT 1`,
        projectId,
        watch.subscriptionId
      )
      .toArray()[0];
    if (typeof match?.matched_at !== 'number') continue;
    const due = Math.max(
      watch.nextEligibleAt,
      match.matched_at,
      typeof row.next_attempt_at === 'number' ? row.next_attempt_at : 0
    );
    next = next === null ? due : Math.min(next, due);
  }
  return next;
}

export async function runStandingWatchAlarm(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks
) {
  const projectId = hooks.getProjectId();
  if (!projectId) return;
  const limits = scheduleLimits(env);
  let processed = 0;
  for (const row of candidates(sql, env, projectId)) {
    if (processed >= limits.sweepBatchSize) break;
    const watch = mapWatch(row);
    if (
      watch.executionCount >= watch.maxExecutions ||
      watch.nextEligibleAt > Date.now() ||
      (typeof row.next_attempt_at === 'number' && row.next_attempt_at > Date.now())
    )
      continue;
    const match = sql
      .exec(
        `SELECT id, event_id FROM project_event_matches WHERE project_id = ?
      AND subscription_id = ? AND state = 'matched' AND batch_id IS NULL
      ORDER BY matched_at, id LIMIT 1`,
        projectId,
        watch.subscriptionId
      )
      .toArray()[0];
    if (typeof match?.id !== 'string' || typeof match.event_id !== 'string') continue;
    processed++;
    // Reserve a finite retry deadline before any external authority read.
    sql.exec(
      `UPDATE project_standing_watches SET next_attempt_at = ?
      WHERE project_id = ? AND id = ? AND version = ? AND state = 'active'`,
      Date.now() + limits.retryBaseMs,
      projectId,
      watch.id,
      watch.version
    );
    try {
      await requireScheduleMember(env, projectId, watch.creatorUserId);
      hooks.transactionSync(() => {
        const current = readWatchRow(sql, projectId, watch.id);
        const now = Date.now();
        if (
          !current ||
          current.state !== 'active' ||
          current.version !== watch.version ||
          current.next_eligible_at > now ||
          current.execution_count >= current.max_executions
        )
          return;
        const live = sql
          .exec(
            `SELECT id FROM project_schedules WHERE watch_id = ?
          AND execution_finished_at IS NULL AND state IN ('pending','processing','admitted','ambiguous') LIMIT ?`,
            watch.id,
            watch.maxConcurrent
          )
          .toArray();
        if (live.length >= watch.maxConcurrent) return;
        const event = readEventById(sql, projectId, String(match.event_id));
        const subscription = readSubscriptionById(sql, projectId, watch.subscriptionId);
        if (!subscriptionCanMatchProjectEvent(subscription, event)) {
          sql.exec(
            `UPDATE project_event_matches SET state = 'recorded_not_injected',
            lifecycle_checked_at = ?, reason = 'Standing watch audience denied'
            WHERE project_id = ? AND id = ? AND state = 'matched'`,
            now,
            projectId,
            String(match.id)
          );
          return;
        }
        const result = createSchedule(
          sql,
          env,
          projectId,
          { userId: watch.creatorUserId, chatSessionId: null },
          {
            action: watch.action,
            dueAt: now,
            displayTimezone: 'UTC',
            expiresAt: now + limits.lateGraceMs,
            idempotencyKey: `watch:${watch.id}:${match.event_id}`,
            reason: watch.reason,
          },
          now
        );
        if (!result.changed) return;
        sql.exec(
          `UPDATE project_schedules SET watch_id = ?, source_event_id = ?
          WHERE project_id = ? AND id = ?`,
          watch.id,
          String(match.event_id),
          projectId,
          result.schedule.id
        );
        const claimed = sql.exec(
          `UPDATE project_event_matches SET state = 'recorded_not_injected',
          lifecycle_checked_at = ?, reason = ? WHERE project_id = ? AND id = ? AND state = 'matched'
          AND batch_id IS NULL`,
          now,
          `Standing watch action ${result.schedule.id}`,
          projectId,
          String(match.id)
        ).rowsWritten;
        if (!claimed) throw new Error('Standing watch match admission changed');
        sql.exec(
          `UPDATE project_standing_watches SET execution_count = execution_count + 1,
          next_eligible_at = ?, next_attempt_at = NULL, updated_at = ?, last_error = NULL
          WHERE project_id = ? AND id = ? AND version = ? AND state = 'active'`,
          now + watch.cooldownMs,
          now,
          projectId,
          watch.id,
          watch.version
        );
      });
    } catch (error) {
      if (error instanceof ProjectEventValidationError && /project access/.test(error.message)) {
        hooks.transactionSync(() =>
          pauseWatch(
            sql,
            env,
            projectId,
            watch.id,
            {
              expectedVersion: watch.version,
              paused: true,
              reason: 'Creator project access was revoked',
            },
            Date.now()
          )
        );
        continue;
      }
      sql.exec(
        `UPDATE project_standing_watches SET last_error = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND version = ? AND state = 'active'`,
        error instanceof Error
          ? error.message.slice(0, limits.promptBytes)
          : 'Watch admission failed',
        Date.now(),
        projectId,
        watch.id,
        watch.version
      );
    }
  }
}
