/**
 * Five-minute inbox sweep, isolated in the cron (`scheduled/handler.ts`):
 * 0. send due question reminders (push resend at the `inbox.question*Percent` points; slice G);
 * 1. expire open asks past `expires_at` (compare-and-set on `open`) and tell the agent. A question
 *    whose push no device confirmed is first extended by `inbox.questionUndeliveredGraceMinutes`,
 *    up to its `max_expires_at` (the delivery contract of rule 47 requirement 8); an expired
 *    question stops its task, as a question marker's expiry did (`ask-notice.ts`);
 * 2. retry notices that were not queued (`notified_at IS NULL` on a closed ask) for
 *    `inbox.noticeRetryMinutes` after the item closed, the way the secret request sweep retries
 *    `runtime_secret_requests.notified_at`.
 * Each step reads at most `inbox.sweepBatchSize` rows, so a tick is bounded (rule 47) and one step
 * cannot starve another. At the default 10 each step drains 120 rows an hour: a question needs one
 * row per reminder and one to expire, so a burst of 100 questions expiring together drains in
 * about 50 minutes (raise the setting, up to 50, for more). Every selected row leaves the candidate set: a reminder advances `next_escalation_at`, an
 * extension moves `expires_at`, an expiry closes the row, a notice past its window ages out.
 * The schedule has the ProjectData marker alarm's precision of one sweep tick (five minutes).
 */
import {
  getInboxLimits,
  type InboxAskNoticeOutcome,
  type InboxAskNoticeRow,
  type InboxLimits,
  nextQuestionReminderAt,
  notifyClosedAsk,
  questionUndeliveredExtension,
} from '@simple-agent-manager/operations';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { createOperationPorts } from '../../operation-ports';
import { notificationsPort } from '../../project-data-ports/notifications';

/**
 * A notice is retried only once its inline attempt is at least this old, so the sweep does not race
 * a write that is still queuing it. A racing retry is harmless anyway: it reuses the delivery id.
 */
const NOTICE_RETRY_GRACE_MS = 60_000;

const NOTICE_COLUMNS = `id, project_id, kind, title, status, answer_json, source_session_id,
  source_task_id, source_workspace_id, created_at, resolved_by_user_id, assignee_user_id`;
/** A question's schedule columns (migration 0247), read with the notice columns. */
const SCHEDULE_COLUMNS = `${NOTICE_COLUMNS}, expires_at, max_expires_at, notification_id,
  next_escalation_at, escalation_count`;

function noticeRow(row: Record<string, unknown>): InboxAskNoticeRow | null {
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const id = text(row.id);
  const projectId = text(row.project_id);
  const kind = text(row.kind);
  const title = text(row.title);
  const status = text(row.status);
  if (!id || !projectId || !kind || !title || !status) return null;
  return {
    id,
    projectId,
    kind,
    title,
    status,
    answerJson: text(row.answer_json),
    sourceSessionId: text(row.source_session_id),
    sourceTaskId: text(row.source_task_id),
    sourceWorkspaceId: text(row.source_workspace_id),
    createdAt: typeof row.created_at === 'number' ? row.created_at : null,
    resolvedByUserId: text(row.resolved_by_user_id),
    assigneeUserId: text(row.assignee_user_id),
  };
}

const OUTCOMES: Record<string, InboxAskNoticeOutcome> = {
  answered: 'answered',
  done: 'done',
  archived: 'archived',
  expired: 'expired',
};

export interface InboxSweepStats {
  expired: number;
  noticesRetried: number;
  remindersSent: number;
  extended: number;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** Resend a question's push. Best-effort: a reminder that fails is not retried. */
async function resendQuestionPush(env: Env, raw: Record<string, unknown>): Promise<void> {
  const userId = typeof raw.assignee_user_id === 'string' ? raw.assignee_user_id : null;
  const notificationId = typeof raw.notification_id === 'string' ? raw.notification_id : null;
  if (!userId || !notificationId) return;
  try {
    await notificationsPort.resendPush(env, userId, notificationId);
  } catch (error) {
    log.warn('inbox_ask.question_push_resend_failed', {
      askId: raw.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Whether a device confirmed the question's push; an unreadable receipt is "no" (fail safe). */
async function questionPushConfirmed(env: Env, raw: Record<string, unknown>): Promise<boolean> {
  const userId = typeof raw.assignee_user_id === 'string' ? raw.assignee_user_id : null;
  const notificationId = typeof raw.notification_id === 'string' ? raw.notification_id : null;
  if (!userId || !notificationId) return false;
  try {
    return await notificationsPort.hasConfirmedPushDelivery(env, userId, notificationId);
  } catch (error) {
    log.warn('inbox_ask.question_receipt_check_failed', {
      askId: raw.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Step 0: due question reminders. Returns how many rows it selected. */
async function sendDueQuestionReminders(
  env: Env,
  limits: InboxLimits,
  now: number,
  budget: number
): Promise<{ selected: number; sent: number }> {
  const due = await env.DATABASE.prepare(
    `SELECT ${SCHEDULE_COLUMNS} FROM asks
      WHERE status = 'open' AND next_escalation_at IS NOT NULL AND next_escalation_at <= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY next_escalation_at LIMIT ?`
  )
    .bind(now, now, budget)
    .all<Record<string, unknown>>();
  let sent = 0;
  for (const raw of due.results ?? []) {
    try {
      const count = num(raw.escalation_count) ?? 0;
      const createdAt = num(raw.created_at);
      const next =
        createdAt === null
          ? null
          : nextQuestionReminderAt(
              { createdAt, expiresAt: num(raw.expires_at), escalationCount: count },
              limits
            );
      // Compare-and-set on the count read, so two ticks never send the same reminder twice.
      const advanced = await env.DATABASE.prepare(
        `UPDATE asks SET escalation_count = ?, next_escalation_at = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'open' AND escalation_count = ?`
      )
        .bind(count + 1, next, now, raw.id, raw.project_id, count)
        .run();
      if ((advanced.meta?.changes ?? 0) !== 1) continue;
      await resendQuestionPush(env, raw);
      sent += 1;
    } catch (error) {
      log.warn('inbox_ask.question_reminder_failed', {
        askId: raw.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { selected: (due.results ?? []).length, sent };
}

/**
 * A question at its deadline whose push no device confirmed is kept open for the undelivered
 * grace, up to its hard limit, and its push resent. True when it was extended.
 */
async function extendUndeliveredQuestion(
  env: Env,
  limits: InboxLimits,
  raw: Record<string, unknown>,
  now: number
): Promise<boolean> {
  const createdAt = num(raw.created_at);
  if (raw.kind !== 'question' || createdAt === null) return false;
  if (await questionPushConfirmed(env, raw)) return false;
  const { maxExpiresAt, extendedExpiry } = questionUndeliveredExtension(
    limits,
    { createdAt, maxExpiresAt: num(raw.max_expires_at) },
    now
  );
  if (now >= maxExpiresAt || extendedExpiry <= now) return false;
  const extended = await env.DATABASE.prepare(
    `UPDATE asks SET expires_at = ?, next_escalation_at = NULL, updated_at = ?
      WHERE id = ? AND project_id = ? AND status = 'open' AND expires_at = ?`
  )
    .bind(extendedExpiry, now, raw.id, raw.project_id, raw.expires_at)
    .run();
  if ((extended.meta?.changes ?? 0) !== 1) return true;
  log.warn('inbox_ask.question_expiry_deferred_without_delivery', {
    askId: raw.id,
    projectId: raw.project_id,
    extendedExpiry,
    maxExpiresAt,
  });
  await resendQuestionPush(env, raw);
  return true;
}

export async function runInboxAskSweep(env: Env, now = Date.now()): Promise<InboxSweepStats> {
  const deps = { env, ports: createOperationPorts(env) };
  const limits = await getInboxLimits(deps);
  // Each step has its own budget, so due reminders can never starve expiries or notice retries.
  const budget = limits.sweepBatchSize;
  let expired = 0;
  let noticesRetried = 0;
  let extended = 0;

  const reminders = await sendDueQuestionReminders(env, limits, now, budget);

  const due = await env.DATABASE.prepare(
    `SELECT ${SCHEDULE_COLUMNS} FROM asks
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`
  )
    .bind(now, budget)
    .all<Record<string, unknown>>();
  for (const raw of due.results ?? []) {
    // Claim first, from the key columns alone, so a row the notice cannot be built from still
    // leaves the candidate set instead of blocking the head of the queue every tick.
    if (typeof raw.id !== 'string' || typeof raw.project_id !== 'string') continue;
    try {
      if (await extendUndeliveredQuestion(env, limits, raw, now)) {
        extended += 1;
        continue;
      }
    } catch (error) {
      // Fail toward keeping the question: it is looked at again next tick.
      log.warn('inbox_ask.question_extension_failed', {
        askId: raw.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const claimed = await env.DATABASE.prepare(
      `UPDATE asks SET status = 'expired', resolved_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'open' AND expires_at <= ?`
    )
      .bind(now, now, raw.id, raw.project_id, now)
      .run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    expired += 1;
    const row = noticeRow(raw);
    if (!row) {
      log.warn('inbox_ask.sweep_notice_unreadable', { askId: raw.id, projectId: raw.project_id });
      continue;
    }
    await notifyClosedAsk(deps, { ...row, status: 'expired' }, 'expired');
  }
  {
    const unnotified = await env.DATABASE.prepare(
      `SELECT ${NOTICE_COLUMNS} FROM asks
        WHERE notified_at IS NULL AND status IN ('answered', 'done', 'archived', 'expired')
          -- Archiving tells the agent nothing (2026-11-17). New archives set notified_at; this
          -- also covers rows an earlier build archived with no notice.
          AND status != 'archived'
          AND resolved_at > ? AND resolved_at <= ?
        ORDER BY resolved_at LIMIT ?`
    )
      .bind(now - limits.noticeRetryMinutes * 60_000, now - NOTICE_RETRY_GRACE_MS, budget)
      .all<Record<string, unknown>>();
    for (const raw of unnotified.results ?? []) {
      const row = noticeRow(raw);
      const outcome = row ? OUTCOMES[row.status] : undefined;
      if (!row || !outcome) continue;
      // Same delivery id as the first attempt, so a notice that did land is not duplicated.
      if (await notifyClosedAsk(deps, row, outcome)) noticesRetried += 1;
    }
  }

  if (expired > 0 || noticesRetried > 0 || reminders.sent > 0 || extended > 0) {
    log.info('inbox_ask.sweep', {
      expired,
      noticesRetried,
      remindersSent: reminders.sent,
      extended,
    });
  }
  return { expired, noticesRetried, remindersSent: reminders.sent, extended };
}
