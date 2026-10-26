/** Durable admission intents. The existing GitHub recovery sweep drains these records. */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { githubTriggerRecoveryConfig } from './github-trigger-recovery-config';
import * as projectData from './project-data';
import { TERMINAL_STATUS_VALUES } from './task-status';
import {
  admitAndSubmitTriggerExecution,
  type TriggerAdmissionInput,
  type TriggerTaskSubmitter,
} from './trigger-admission';
import { readTriggerAdmissionSnapshot } from './trigger-admission-snapshot';
import {
  EXECUTION_HOLDS_RUN_SLOT_BINDINGS,
  EXECUTION_HOLDS_RUN_SLOT_SQL,
  TRIGGER_RUN_TASK_ID_SQL,
} from './trigger-run-slots';

export interface GitHubQueueInput extends TriggerAdmissionInput {
  githubDeliveryId: string;
  subjectKey: string | null;
  subjectAffinity: boolean;
  queueMaxPending: number;
  queueTtlSeconds: number;
}
export type GitHubQueueResult = {
  outcome: string;
  executionId: string;
  taskId?: string;
  sessionId?: string;
  reason?: string;
};

/** Stable repository identity, with GitHub's shared issue/PR number namespace. */
export function githubSubjectKey(repositoryId: number, number: unknown): string | null {
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? `github:${repositoryId}:${number}`
    : null;
}

export async function acceptGitHubTriggerExecution(
  env: Env,
  input: GitHubQueueInput,
  submitter?: TriggerTaskSubmitter
): Promise<GitHubQueueResult> {
  const id = ulid();
  const now = new Date().toISOString();
  const scheduledAt = input.scheduledAt ?? now;
  const expiresAt = new Date(Date.parse(scheduledAt) + input.queueTtlSeconds * 1000).toISOString();
  // Queue cap, duplicate identity and sequence are committed together. No check-then-insert.
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT OR IGNORE INTO trigger_executions
      (id,trigger_id,project_id,status,skip_reason,event_type,scheduled_at,sequence_number,created_at,
       github_delivery_id,admission_snapshot_json,subject_key,queue_expires_at)
      SELECT ?,id,project_id,
        CASE WHEN ? <= ? THEN 'dropped' WHEN (SELECT COUNT(*) FROM trigger_executions e WHERE e.trigger_id=triggers.id AND (e.status='routing' OR (e.status='waiting' AND e.queue_expires_at>?))) >= ? THEN 'dropped' ELSE 'waiting' END,
        CASE WHEN ? <= ? THEN 'queue_expired' WHEN (SELECT COUNT(*) FROM trigger_executions e WHERE e.trigger_id=triggers.id AND (e.status='routing' OR (e.status='waiting' AND e.queue_expires_at>?))) >= ? THEN 'queue_full' ELSE NULL END,
        ?,?,next_execution_sequence,?,?,?,?,?
      FROM triggers WHERE id=? AND project_id=? AND status='active'`
    ).bind(
      id,
      expiresAt,
      now,
      now,
      input.queueMaxPending,
      expiresAt,
      now,
      now,
      input.queueMaxPending,
      input.eventType,
      scheduledAt,
      now,
      input.githubDeliveryId,
      JSON.stringify(input.trigger),
      input.subjectAffinity ? input.subjectKey : null,
      expiresAt,
      input.trigger.id,
      input.trigger.projectId
    ),
    env.DATABASE.prepare(
      `UPDATE triggers SET next_execution_sequence=next_execution_sequence+1 WHERE id=? AND EXISTS(SELECT 1 FROM trigger_executions WHERE id=?)`
    ).bind(input.trigger.id, id),
  ]);
  const row = await env.DATABASE.prepare(
    'SELECT id,sequence_number,admission_snapshot_json,queue_expires_at FROM trigger_executions WHERE trigger_id=? AND github_delivery_id=?'
  )
    .bind(input.trigger.id, input.githubDeliveryId)
    .first<{
      id: string;
      sequence_number: number;
      admission_snapshot_json: string | null;
      queue_expires_at: string | null;
    }>();
  if (!row) return { outcome: 'inactive', executionId: id, reason: 'inactive' };
  if (!row.queue_expires_at) {
    const legacy = await admitAndSubmitTriggerExecution(env, input, submitter);
    return { ...legacy, executionId: row.id };
  }
  // Once persisted, prompt/config survive changes to filters, templates, or source payload retention.
  await env.DATABASE.prepare(
    'UPDATE trigger_executions SET rendered_prompt=COALESCE(rendered_prompt,?) WHERE id=?'
  )
    .bind(
      input.renderPrompt(
        row.id,
        row.sequence_number,
        row.admission_snapshot_json
          ? readTriggerAdmissionSnapshot(row.admission_snapshot_json, input.trigger)
          : input.trigger
      ),
      row.id
    )
    .run();
  return processGitHubTriggerExecution(env, row.id, submitter, input.githubProcessingToken);
}

const terminalPlaceholders = TERMINAL_STATUS_VALUES.map(() => '?').join(',');
// Sleeping tasks remain eligible: existing prompt delivery owns waking and runtime recovery.
const liveTarget = `SELECT e.id FROM trigger_executions e JOIN tasks t ON t.id=${TRIGGER_RUN_TASK_ID_SQL}
  WHERE e.trigger_id=q.trigger_id AND e.subject_key=q.subject_key AND q.subject_key IS NOT NULL
    AND e.id!=q.id AND (q.routed_execution_id IS NULL OR e.id!=q.routed_execution_id) AND t.project_id=q.project_id AND t.status NOT IN (${terminalPlaceholders})
    AND t.chat_session_id IS NOT NULL ORDER BY e.sequence_number LIMIT 1`;

export async function processGitHubTriggerExecution(
  env: Env,
  executionId: string,
  submitter?: TriggerTaskSubmitter,
  processingToken?: string
): Promise<GitHubQueueResult> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare('UPDATE trigger_executions SET queue_attempted_at=? WHERE id=?')
    .bind(now, executionId)
    .run();
  // Snapshot a routing intent before crossing D1 -> ProjectData. Retries always use this target.
  await env.DATABASE.prepare(
    `UPDATE trigger_executions AS q SET status='routing',
      routed_execution_id=(${liveTarget}),
      routed_task_id=(SELECT ${TRIGGER_RUN_TASK_ID_SQL} FROM trigger_executions e WHERE e.id=(${liveTarget})),
      routed_session_id=(SELECT t.chat_session_id FROM tasks t JOIN trigger_executions e ON t.id=${TRIGGER_RUN_TASK_ID_SQL} WHERE e.id=(${liveTarget}))
    WHERE id=? AND status='waiting' AND queue_expires_at>? AND rendered_prompt IS NOT NULL
      AND EXISTS(SELECT 1 FROM triggers WHERE id=q.trigger_id AND status='active')
      AND EXISTS(${liveTarget})`
  )
    .bind(
      ...TERMINAL_STATUS_VALUES,
      ...TERMINAL_STATUS_VALUES,
      ...TERMINAL_STATUS_VALUES,
      executionId,
      now,
      ...TERMINAL_STATUS_VALUES
    )
    .run();
  // FIFO promotion repeats both capacity and subject ownership in the final atomic write.
  await env.DATABASE.prepare(
    `UPDATE trigger_executions AS q SET status='queued',started_at=?,routed_execution_id=NULL,routed_task_id=NULL,routed_session_id=NULL
    WHERE id=? AND status='waiting' AND queue_expires_at>? AND rendered_prompt IS NOT NULL
      AND EXISTS(SELECT 1 FROM triggers tr WHERE tr.id=q.trigger_id AND tr.status='active'
        AND (SELECT COUNT(*) FROM trigger_executions e LEFT JOIN tasks t ON t.id=${TRIGGER_RUN_TASK_ID_SQL}
          WHERE e.trigger_id=tr.id AND ${EXECUTION_HOLDS_RUN_SLOT_SQL}) < CASE WHEN tr.skip_if_running=1 THEN 1 ELSE tr.max_concurrent END)
      AND NOT EXISTS(SELECT 1 FROM trigger_executions older WHERE older.trigger_id=q.trigger_id AND older.status='waiting' AND older.queue_expires_at>? AND older.sequence_number<q.sequence_number)
      AND NOT EXISTS(SELECT 1 FROM trigger_executions e LEFT JOIN tasks t ON t.id=${TRIGGER_RUN_TASK_ID_SQL}
        WHERE q.subject_key IS NOT NULL AND e.subject_key=q.subject_key AND e.trigger_id=q.trigger_id AND e.id!=q.id AND (q.routed_execution_id IS NULL OR e.id!=q.routed_execution_id)
          AND (e.status='queued' OR (e.task_id IS NOT NULL AND t.status NOT IN (${terminalPlaceholders}))))`
  )
    .bind(
      now,
      executionId,
      now,
      ...EXECUTION_HOLDS_RUN_SLOT_BINDINGS,
      now,
      ...TERMINAL_STATUS_VALUES
    )
    .run();
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select()
    .from(schema.triggerExecutions)
    .where(eq(schema.triggerExecutions.id, executionId))
    .get();
  if (!row) throw new Error('GitHub execution removed');
  if (row.status === 'routing') return routeToSession(env, row);
  if (row.status === 'routed') {
    await updateQueueAudit(
      env,
      row,
      'routed',
      `task:${row.routedTaskId};session:${row.routedSessionId};delivery:github-trigger:${row.id}:${row.routedExecutionId}`
    );
    return {
      outcome: 'routed',
      executionId,
      taskId: row.routedTaskId ?? undefined,
      sessionId: row.routedSessionId ?? undefined,
    };
  }
  if (row.status !== 'queued')
    return {
      outcome: row.status,
      executionId,
      taskId: row.taskId ?? undefined,
      reason: row.skipReason ?? undefined,
    };
  const trigger = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.id, row.triggerId))
    .get();
  if (!trigger) throw new Error('GitHub trigger removed');
  const result = await admitAndSubmitTriggerExecution(
    env,
    {
      trigger,
      executionId,
      githubDeliveryId: row.githubDeliveryId ?? undefined,
      eventType: row.eventType ?? 'github',
      triggeredBy: 'github',
      scheduledAt: row.scheduledAt ?? undefined,
      queueManaged: true,
      githubProcessingToken: processingToken,
      renderPrompt: () => row.renderedPrompt ?? '',
    },
    submitter
  );
  if (result.outcome === 'submitted') {
    await env.DATABASE.prepare(
      `UPDATE trigger_executions SET status=CASE
      WHEN (SELECT status FROM tasks WHERE id=task_id)='completed' THEN 'completed'
      WHEN (SELECT status FROM tasks WHERE id=task_id) IN ('failed','cancelled') THEN 'failed'
      ELSE 'running' END WHERE id=? AND status='queued'`
    )
      .bind(executionId)
      .run();
  }
  if (result.outcome === 'failed' || result.outcome === 'pending')
    throw new Error('GitHub queue submission pending');
  if (result.outcome === 'submitted')
    await updateQueueAudit(
      env,
      row,
      'matched',
      `task:${result.taskId};session:${result.sessionId}`
    );
  return { ...result, executionId };
}

async function routeToSession(
  env: Env,
  row: schema.TriggerExecutionRow
): Promise<GitHubQueueResult> {
  if (
    !row.routedExecutionId ||
    !row.routedSessionId ||
    !row.routedTaskId ||
    !row.renderedPrompt ||
    !row.queueExpiresAt
  )
    throw new Error('Incomplete routing intent');
  const deliveryId = `github-trigger:${row.id}:${row.routedExecutionId}`;
  // Once committed, the target is immutable. A timed-out RPC may already have accepted
  // the prompt; reassigning it from a D1 liveness read could start a second agent.
  const receipt = await projectData.getMailboxMessage(env, row.projectId, deliveryId);
  if (!receipt && row.queueExpiresAt <= new Date().toISOString()) {
    const session = await projectData.getSession(env, row.projectId, row.routedSessionId);
    if (!session || session.status === 'archived') {
      await env.DATABASE.prepare(
        "UPDATE trigger_executions SET status='dropped',skip_reason='target_unavailable',completed_at=? WHERE id=? AND status='routing' AND routed_execution_id=?"
      )
        .bind(new Date().toISOString(), row.id, row.routedExecutionId)
        .run();
      await updateQueueAudit(env, row, 'dropped', 'target_unavailable');
      return { outcome: 'dropped', executionId: row.id, reason: 'target_unavailable' };
    }
  }
  const targetPrincipal = await env.DATABASE.prepare(
    'SELECT user_id FROM tasks WHERE id=? AND project_id=?'
  )
    .bind(row.routedTaskId, row.projectId)
    .first<{ user_id: string }>();
  const creatorUserId =
    typeof receipt?.metadata?.creatorUserId === 'string'
      ? receipt.metadata.creatorUserId
      : targetPrincipal?.user_id;
  if (!creatorUserId) throw new Error('Routing target has no execution principal');
  const accepted = await projectData.acceptPromptDelivery(env, row.projectId, {
    deliveryId,
    targetSessionId: row.routedSessionId,
    displayContent: row.renderedPrompt,
    senderType: 'system',
    sourceKind: 'github_trigger',
    sourceTaskId: row.routedTaskId,
    expiresAt: Date.parse(row.queueExpiresAt),
    ttlMs: Math.max(1, Date.parse(row.queueExpiresAt) - Date.now()),
    metadata: {
      triggerId: row.triggerId,
      triggerExecutionId: row.id,
      githubDeliveryId: row.githubDeliveryId,
      subjectKey: row.subjectKey,
      creatorUserId,
    },
  });
  const message = receipt ?? accepted.message;
  // A rejected delivery with no submission checkpoint proves no prompt reached a runtime.
  // Its immutable terminal receipt fences late RPCs, so this intent can safely seek a new run.
  if (
    message.deliveryState === 'failed' &&
    message.terminalReason === 'terminal_target' &&
    message.runtimeIdentity === null &&
    message.acceptedAt === null &&
    message.receiptState === null &&
    row.queueExpiresAt > new Date().toISOString()
  ) {
    await env.DATABASE.prepare(
      `UPDATE trigger_executions SET status='waiting'
      WHERE id=? AND status='routing' AND routed_execution_id=?`
    )
      .bind(row.id, row.routedExecutionId)
      .run();
    return { outcome: 'waiting', executionId: row.id, reason: 'target_unavailable' };
  }
  const delivered = message.deliveryState === 'acked';
  const terminal = ['failed', 'expired', 'ambiguous'].includes(message.deliveryState);
  const outcome = delivered ? 'routed' : terminal ? 'dropped' : 'routing';
  const uncertain =
    terminal &&
    (message.deliveryState === 'ambiguous' ||
      message.runtimeIdentity !== null ||
      message.acceptedAt !== null ||
      message.receiptState !== null);
  const reason = uncertain
    ? 'delivery_uncertain'
    : terminal
      ? message.deliveryState === 'expired'
        ? 'queue_expired'
        : 'target_unavailable'
      : null;
  await env.DATABASE.prepare(
    `UPDATE trigger_executions SET status=?,skip_reason=?,completed_at=? WHERE id=? AND status='routing' AND routed_execution_id=?`
  )
    .bind(
      outcome,
      reason,
      outcome === 'routing' ? null : new Date().toISOString(),
      row.id,
      row.routedExecutionId
    )
    .run();
  await updateQueueAudit(
    env,
    row,
    outcome,
    `task:${row.routedTaskId};session:${row.routedSessionId};delivery:${deliveryId}${reason ? ';' + reason : ''}`
  );
  return {
    outcome,
    executionId: row.id,
    taskId: row.routedTaskId,
    sessionId: row.routedSessionId,
    reason: reason ?? undefined,
  };
}

async function updateQueueAudit(
  env: Env,
  row: schema.TriggerExecutionRow,
  _decision: string,
  _reason: string
) {
  await syncGitHubExecutionAudit(env, row.id);
}

/** Derive audit state inside the write, so an old handler cannot overwrite newer routing evidence. */
export async function syncGitHubExecutionAudit(env: Env, executionId: string) {
  await env.DATABASE.prepare(
    `UPDATE github_webhook_deliveries SET
    decision=(SELECT CASE status WHEN 'waiting' THEN 'queued' WHEN 'queued' THEN 'queued'
      WHEN 'running' THEN 'matched' WHEN 'completed' THEN 'matched' ELSE status END FROM trigger_executions WHERE id=?),
    decision_reason=(SELECT CASE WHEN routed_task_id IS NOT NULL THEN 'task:'||routed_task_id||';session:'||routed_session_id||';delivery:github-trigger:'||id||':'||routed_execution_id||COALESCE(';'||skip_reason,'')
      WHEN task_id IS NOT NULL THEN 'task:'||task_id ELSE COALESCE(skip_reason,'execution:'||id) END FROM trigger_executions WHERE id=?)
    WHERE id=(SELECT github_delivery_id||':'||trigger_id FROM trigger_executions WHERE id=?)`
  )
    .bind(executionId, executionId, executionId)
    .run();
}

/** Bounded serial recovery on the existing operations cadence; waiting does not consume retries. */
export async function drainGitHubTriggerQueue(env: Env, submitter?: TriggerTaskSubmitter) {
  const config = githubTriggerRecoveryConfig(env);
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `UPDATE trigger_executions SET status='dropped',skip_reason='queue_expired',completed_at=?
    WHERE id IN (SELECT id FROM trigger_executions WHERE status IN ('waiting','queued') AND queue_expires_at<=? AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.trigger_execution_id=trigger_executions.id) ORDER BY created_at LIMIT ?)`
  )
    .bind(now, now, config.batchSize)
    .run();
  await env.DATABASE.prepare(
    `UPDATE github_webhook_deliveries SET decision='dropped',decision_reason='queue_expired' WHERE id IN (SELECT github_delivery_id || ':' || trigger_id FROM trigger_executions WHERE status='dropped' AND skip_reason='queue_expired' AND completed_at=?)`
  )
    .bind(now)
    .run();
  const rows = await env.DATABASE.prepare(
    `SELECT id FROM trigger_executions WHERE queue_expires_at IS NOT NULL AND rendered_prompt IS NOT NULL
    AND status IN ('waiting','routing','queued') ORDER BY COALESCE(queue_attempted_at,created_at),sequence_number LIMIT ?`
  )
    .bind(config.batchSize)
    .all<{ id: string }>();
  const started = Date.now();
  for (const row of rows.results) {
    if (Date.now() - started >= config.maxWallTimeMs) break;
    try {
      await processGitHubTriggerExecution(env, row.id, submitter);
    } catch {
      log.warn('github_trigger_queue.retry', { executionId: row.id });
    }
  }
}
