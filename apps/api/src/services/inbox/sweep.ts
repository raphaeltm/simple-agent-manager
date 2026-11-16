/**
 * Five-minute inbox sweep, isolated in the cron (`scheduled/handler.ts`):
 * 1. expire open asks past `expires_at` (compare-and-set on `open`) and tell the agent;
 * 2. retry notices that were not queued (`notified_at IS NULL` on a closed ask) for
 *    `inbox.noticeRetryMinutes` after the item closed, the way the secret request sweep retries
 *    `runtime_secret_requests.notified_at`.
 * Both steps share one budget of `inbox.sweepBatchSize` rows, so a tick is bounded (rule 47);
 * a notice past its retry window leaves the candidate set.
 */
import {
  getInboxLimits,
  type InboxAskNoticeOutcome,
  type InboxAskNoticeRow,
  notifyClosedAsk,
} from '@simple-agent-manager/operations';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { createOperationPorts } from '../../operation-ports';

/**
 * A notice is retried only once its inline attempt is at least this old, so the sweep does not race
 * a write that is still queuing it. A racing retry is harmless anyway: it reuses the delivery id.
 */
const NOTICE_RETRY_GRACE_MS = 60_000;

const NOTICE_COLUMNS = `id, project_id, kind, title, status, answer_json, source_session_id,
  source_task_id, resolved_by_user_id, assignee_user_id`;

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
}

export async function runInboxAskSweep(env: Env, now = Date.now()): Promise<InboxSweepStats> {
  const deps = { env, ports: createOperationPorts(env) };
  const limits = await getInboxLimits(deps);
  let budget = limits.sweepBatchSize;
  let expired = 0;
  let noticesRetried = 0;

  const due = await env.DATABASE.prepare(
    `SELECT ${NOTICE_COLUMNS} FROM asks
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`
  )
    .bind(now, budget)
    .all<Record<string, unknown>>();
  for (const raw of due.results ?? []) {
    // Claim first, from the key columns alone, so a row the notice cannot be built from still
    // leaves the candidate set instead of blocking the head of the queue every tick.
    if (typeof raw.id !== 'string' || typeof raw.project_id !== 'string') continue;
    const claimed = await env.DATABASE.prepare(
      `UPDATE asks SET status = 'expired', resolved_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'open'`
    )
      .bind(now, now, raw.id, raw.project_id)
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
  budget -= (due.results ?? []).length;

  if (budget > 0) {
    const unnotified = await env.DATABASE.prepare(
      `SELECT ${NOTICE_COLUMNS} FROM asks
        WHERE notified_at IS NULL AND status IN ('answered', 'done', 'archived', 'expired')
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

  if (expired > 0 || noticesRetried > 0) {
    log.info('inbox_ask.sweep', { expired, noticesRetried });
  }
  return { expired, noticesRetried };
}
