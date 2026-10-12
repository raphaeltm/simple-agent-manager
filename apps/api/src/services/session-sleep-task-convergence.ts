/** Give an aged teardown its final bounded owner before a terminal writer acts. */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getNodeAgentBackgroundRequestTimeoutMs } from './node-agent';
import { sleepWorkspaceSession } from './session-sleep-execution';
import { settleUnconfirmedSleepStop } from './session-sleep-stopping-failure';
import { sessionSleepInFlightMaxAgeMs } from './session-snapshot-sleep-predicate';
import { claimSessionSnapshotSleep, deferSessionSnapshotStopping } from './session-snapshots';

export const DEFAULT_TASK_SLEEP_CONVERGENCE_LIMIT = 5;

export interface TaskSleepConvergenceBudget {
  remaining: number;
}

export interface TaskSleepIdentity {
  projectId: string;
  chatSessionId: string | null;
  workspaceId: string | null;
  userId: string;
}

/** A read-only handoff check for DO idle cleanup; the durable intent owns teardown. */
export async function stoppingTaskSleepOwnsCleanup(
  database: D1Database,
  identity: Omit<TaskSleepIdentity, 'userId'>
): Promise<boolean> {
  if (!identity.chatSessionId || !identity.workspaceId) return false;
  return !!(await database
    .prepare(
      `SELECT id FROM session_snapshots WHERE project_id = ? AND chat_session_id = ?
    AND workspace_id = ? AND sleep_status = 'stopping' AND sleeping_at IS NULL LIMIT 1`
    )
    .bind(identity.projectId, identity.chatSessionId, identity.workspaceId)
    .first());
}

export async function convergeStaleTaskSleep(
  env: Env,
  identity: TaskSleepIdentity,
  now: Date,
  budget?: TaskSleepConvergenceBudget
): Promise<'none' | 'settled' | 'pending'> {
  if (!identity.chatSessionId || !identity.workspaceId) return 'none';
  const row = await env.DATABASE.prepare(
    `SELECT id FROM session_snapshots
    WHERE project_id = ? AND chat_session_id = ? AND workspace_id = ? AND user_id = ?
      AND sleep_status = 'stopping' AND sleeping_at IS NULL
      AND COALESCE(sleep_stopping_since, sleep_claimed_at, updated_at, created_at) <= ? LIMIT 1`
  )
    .bind(
      identity.projectId,
      identity.chatSessionId,
      identity.workspaceId,
      identity.userId,
      new Date(now.getTime() - sessionSleepInFlightMaxAgeMs(env)).toISOString()
    )
    .first();
  if (!row) return 'none';
  if (budget && budget.remaining <= 0) return 'pending';
  const db = drizzle(env.DATABASE, { schema });
  const claimId = crypto.randomUUID();
  const claim = await claimSessionSnapshotSleep(db, env, {
    chatSessionId: identity.chatSessionId,
    claimId,
    now,
  });
  if (claim.status !== 'claimed') return 'pending';
  if (budget) budget.remaining -= 1;
  try {
    await sleepWorkspaceSession(env, {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      reason: 'Converging interrupted sleep before task terminalization',
      sleepClaimId: claimId,
      stopRequestTimeoutMs: getNodeAgentBackgroundRequestTimeoutMs(env),
    });
    return 'settled';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deferSessionSnapshotStopping(db, env, identity.chatSessionId, claimId, message, now);
    const blocked = await settleUnconfirmedSleepStop(
      env,
      identity.chatSessionId,
      claimId,
      error,
      now
    );
    log.warn('session_sleep.terminal_gate_convergence_failed', {
      chatSessionId: identity.chatSessionId,
      workspaceId: identity.workspaceId,
      blocked,
      error: message,
    });
    return blocked ? 'settled' : 'pending';
  }
}
