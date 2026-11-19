import {
  parseProviderLimitWait,
  type ProviderLimitWait,
} from '@simple-agent-manager/scheduler-core';
import {
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { evaluateRunawayCostCeiling } from '../scheduled/stuck-task-ceiling';
import { acknowledgeProviderLimitRecovery } from './provider-limit-force-resume';
import { repairOwnerApprovedRecovery } from './provider-limit-owner-recovery';
import { repairProviderLimitIntents } from './provider-limit-parking';
import { presentBlockedProviderLimitWait } from './provider-limit-recovery';
export { resolveProviderLimitRecoveryRpcTimeoutMs } from './provider-limit-owner-recovery';

/** A `waiting` hold past its deadline gets no automatic retry: TaskRunner admission blocks it. */
export function isExpiredProviderLimitWait(wait: ProviderLimitWait, now: number): boolean {
  return wait.phase === 'waiting' && now > wait.deadlineAt;
}

/**
 * Record an expired `waiting` hold as `blocked`, compare-and-set on the exact JSON read, so the
 * chat offers Resume. Shared by the stuck-task sweep (`preserveProviderLimitWait`) and the wake
 * refusal (`ensureSessionRecovery`), which must not claim a wake for it. Presentation is the
 * caller's (`presentBlockedProviderLimitWait`).
 */
export async function blockExpiredProviderLimitWait(
  env: Env,
  task: Pick<schema.Task, 'id' | 'providerLimitWaitJson'>,
  wait: ProviderLimitWait
): Promise<ProviderLimitWait> {
  const blocked: ProviderLimitWait = {
    ...wait,
    phase: 'blocked',
    reason: 'Blocked: provider limit wake deadline expired. Review retained work before resuming.',
  };
  await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = 'provider_limit_blocked', admission_reason = ?, admission_next_retry_at = NULL
    WHERE id = ? AND provider_limit_wait_json IS ?`
  )
    .bind(JSON.stringify(blocked), blocked.reason, task.id, task.providerLimitWaitJson)
    .run();
  return blocked;
}

/** The bounded wait deadline, not queued/delegated timeout, owns admission.
 * A blocked task with no runtime is deliberately held for human action. A live
 * runtime after sleep failed is NOT exempt from the absolute compute ceiling. */
export async function preserveProviderLimitWait(
  env: Env,
  taskId: string,
  now: number
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  const wait = parseProviderLimitWait(task?.providerLimitWaitJson);
  if (!task || !wait) return false;
  if (wait.phase === 'released') {
    if (
      task.admissionState === 'provider_limit_recovery_pending' &&
      task.status === 'in_progress'
    ) {
      await acknowledgeProviderLimitRecovery(env, task.id, task.providerLimitWaitJson ?? '', true);
      return false; // ACK only; the ordinary sweep still owns the live compute ceiling.
    }
    if (
      task.admissionState !== 'provider_limit_recovery_pending' ||
      !['sleeping', 'queued', 'delegated'].includes(task.status)
    )
      return false;
    if (
      task.workspaceId &&
      (await providerLimitComputeCeiling(env, task, wait, now)).kind === 'terminalize'
    )
      return false;
    await repairOwnerApprovedRecovery(env, task, wait, now);
    return true;
  }
  const expired = isExpiredProviderLimitWait(wait, now);
  const current = expired ? await blockExpiredProviderLimitWait(env, task, wait) : wait;
  if (wait.origin === 'callback' && !expired) {
    try {
      await repairProviderLimitIntents(env, task, current);
    } catch {
      /* Persisted intent survives; bounded deadline prevents immortal repair. */
    }
  }
  if (current.phase === 'blocked') await presentBlockedProviderLimitWait(env, task, current);
  if (!task.workspaceId) return true;
  // A failed sleep remains visibly blocked without check-ins or stall diagnosis.
  // Only the existing absolute compute ceiling can terminalize retained compute.
  return (await providerLimitComputeCeiling(env, task, current, now)).kind !== 'terminalize';
}

/** The same compute budget applies before every pending or held repair. */
function providerLimitComputeCeiling(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  now: number
) {
  return evaluateRunawayCostCeiling(
    env,
    {
      id: task.id,
      project_id: task.projectId,
      workspace_id: task.workspaceId,
      chat_session_id: task.chatSessionId,
      startedAtMs:
        task.startedAt || task.createdAt
          ? Date.parse(task.startedAt ?? task.createdAt)
          : wait.observedAt,
    },
    {
      nowMs: now,
      absoluteCeilingMs: parsePositiveInt(
        env.TASK_RUN_ABSOLUTE_CEILING_MS,
        DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS
      ),
      sleepGraceMs: parsePositiveInt(
        env.TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
        DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS
      ),
    }
  );
}
