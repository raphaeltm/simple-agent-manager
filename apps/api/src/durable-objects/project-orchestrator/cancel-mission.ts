import { and, asc, eq, gt, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { retireTaskCancellationPrompts } from '../../services/task-cancellation-prompts';
import { taskRecoveryCancellationStatement } from '../../services/task-recovery-cancellation';
import { cancellationConfig } from './cancellation-config';
import { logDecision } from './decision-log';

/** RPC runs under the same mutex as the alarm. A repeat explicitly retries a blocked episode. */
export async function cancelTrackedMission(
  storage: DurableObjectStorage,
  env: Env,
  projectId: string,
  missionId: string,
  serialize: (work: () => Promise<void>) => Promise<void>
): Promise<boolean> {
  if (
    await env.DATABASE.prepare(
      'SELECT 1 FROM missions WHERE id=? AND project_id=? AND workflow_plan_json IS NOT NULL'
    )
      .bind(missionId, projectId)
      .first()
  )
    return false;
  const sql = storage.sql;
  const tracked = sql
    .exec(
      'SELECT status,cancellation_started_at FROM orchestrator_missions WHERE mission_id=?',
      missionId
    )
    .toArray();
  const trackedMission = tracked[0];
  if (!trackedMission) return false;
  if (trackedMission.status !== 'cancelling') {
    sql.exec(
      `UPDATE orchestrator_missions SET status='cancelling', cancellation_started_at=?,
      cancellation_cursor=NULL, cancellation_pass=0 WHERE mission_id=?`,
      Math.max(Date.now(), Number(trackedMission.cancellation_started_at ?? 0) + 1),
      missionId
    );
  }
  sql.exec('DELETE FROM scheduling_queue WHERE mission_id=?', missionId);
  // Persist continuation BEFORE any cross-object work; a crash retains both intent and wakeup.
  await storage.put('projectId', projectId);
  await storage.setAlarm(Date.now() + cancellationConfig(env).intervalMs);
  await env.DATABASE.prepare(
    "UPDATE missions SET status='paused',updated_at=? WHERE id=? AND project_id=?"
  )
    .bind(new Date().toISOString(), missionId, projectId)
    .run();
  await serialize(() => continueMissionCancellation(sql, env, projectId, missionId));
  return true;
}

/** One deadline-bound turn; task status itself is durable successful progress. */
export async function continueMissionCancellation(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string
): Promise<void> {
  const config = cancellationConfig(env);
  const state = sql
    .exec(
      `SELECT cancellation_started_at, cancellation_cursor, cancellation_pass
    FROM orchestrator_missions WHERE mission_id=? AND status='cancelling'`,
      missionId
    )
    .toArray()[0];
  if (!state) return;
  const started = Number(state.cancellation_started_at);
  const block = (reason: string) => {
    sql.exec(
      "UPDATE orchestrator_missions SET status='cancel_blocked' WHERE mission_id=?",
      missionId
    );
    logDecision(sql, missionId, null, 'cancel', reason, Date.now());
    log.error('orchestrator.mission_cancellation_blocked', { projectId, missionId, reason });
  };
  if (Date.now() - started >= config.residenceMs) {
    block('Cancellation deadline exceeded; explicit retry required');
    return;
  }
  // Local expiry precedes D1, so a broken prerequisite cannot keep the alarm alive forever.
  await env.DATABASE.prepare(
    "UPDATE missions SET status='paused',updated_at=? WHERE id=? AND project_id=?"
  )
    .bind(new Date().toISOString(), missionId, projectId)
    .run();
  const deadline = Math.min(Date.now() + config.turnMs, started + config.residenceMs);
  const db = drizzle(env.DATABASE, { schema });
  const eligible = and(
    eq(schema.tasks.missionId, missionId),
    eq(schema.tasks.projectId, projectId),
    notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled'])
  );
  const tasks = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      userId: schema.tasks.userId,
      status: schema.tasks.status,
      chatSessionId: schema.tasks.chatSessionId,
      workspaceId: schema.tasks.workspaceId,
    })
    .from(schema.tasks)
    .where(and(eligible, gt(schema.tasks.id, String(state.cancellation_cursor ?? ''))))
    .orderBy(asc(schema.tasks.id))
    .limit(config.pageSize);
  if (!tasks.length) {
    const remaining = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eligible)
      .limit(1)
      .get();
    if (remaining) {
      const pass = Number(state.cancellation_pass) + 1;
      if (pass >= config.retryPasses) {
        block('Cancellation retries exhausted; explicit retry required');
        return;
      }
      sql.exec(
        'UPDATE orchestrator_missions SET cancellation_cursor=NULL,cancellation_pass=? WHERE mission_id=?',
        pass,
        missionId
      );
      return;
    }
    await completeCancellation(sql, env, projectId, missionId);
    return;
  }
  for (const task of tasks) {
    if (Date.now() >= deadline) break;
    const assertAuthorized = async () => {
      if (
        Date.now() >= deadline ||
        !sql
          .exec(
            `SELECT 1 FROM orchestrator_missions
            WHERE mission_id=? AND status='cancelling' AND cancellation_started_at=?`,
            missionId,
            started
          )
          .toArray().length
      )
        throw new Error('Cancellation episode is no longer authorized');
    };
    const attemptStartedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // A timed-out RPC can retire prompts late, but never publishes a terminal task verdict.
      await Promise.race([
        retireTaskCancellationPrompts(env, task, assertAuthorized, {
          acceptedBefore: attemptStartedAt,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Cancellation turn deadline')),
            Math.max(1, deadline - Date.now())
          );
        }),
      ]);
      await assertAuthorized();
      const now = new Date().toISOString();
      await env.DATABASE.batch([
        env.DATABASE.prepare(
          `UPDATE tasks SET status='cancelled',scheduler_state='cancelled',completed_at=?,updated_at=?
          WHERE id=? AND project_id=? AND mission_id=? AND status=?`
        ).bind(now, now, task.id, projectId, missionId, task.status),
        taskRecoveryCancellationStatement(env.DATABASE, task, now),
      ]);
    } catch (error) {
      log.warn('orchestrator.mission_task_cancellation_deferred', {
        projectId,
        missionId,
        taskId: task.id,
        error: String(error),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    // Failed rows move behind healthy work and are retried only on the next finite pass.
    sql.exec(
      'UPDATE orchestrator_missions SET cancellation_cursor=?,last_checked_at=? WHERE mission_id=?',
      task.id,
      Date.now(),
      missionId
    );
  }
  await completeCancellation(sql, env, projectId, missionId);
}

async function completeCancellation(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string
) {
  const result = await env.DATABASE.prepare(
    `UPDATE missions SET status='cancelled',updated_at=?
    WHERE id=? AND project_id=? AND NOT EXISTS (SELECT 1 FROM tasks
      WHERE tasks.mission_id=missions.id AND tasks.project_id=missions.project_id
        AND tasks.status NOT IN ('completed','failed','cancelled'))`
  )
    .bind(new Date().toISOString(), missionId, projectId)
    .run();
  if (!result.meta.changes) return;
  sql.exec('DELETE FROM orchestrator_missions WHERE mission_id=?', missionId);
  logDecision(sql, missionId, null, 'cancel', 'Mission cancelled by user', Date.now());
}
