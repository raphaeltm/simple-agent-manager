import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  ACTIVE_ADMISSION_STATES,
  first,
  getVmAdmissionConfig,
  type VmAdmissionState,
} from './vm-admission-control-types';

async function nudgeTaskRunner(env: Env, taskId: string, reason: string): Promise<boolean> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  const stub = env.TASK_RUNNER.get(id) as unknown as {
    nudge(reason?: string): Promise<boolean>;
  };
  return stub.nudge(reason);
}

export async function wakeVmAdmissionWaiters(
  env: Env,
  input: {
    scopeKey?: string | null;
    providerDomainKey?: string | null;
    userId?: string | null;
    reason: string;
  }
): Promise<number> {
  const config = getVmAdmissionConfig(env);
  const binds: unknown[] = [];
  const filters = [`state IN ('queued', 'waiting')`];
  if (input.scopeKey) {
    filters.push('scope_key = ?');
    binds.push(input.scopeKey);
  } else if (input.providerDomainKey) {
    filters.push('provider_domain_key = ?');
    binds.push(input.providerDomainKey);
  } else if (input.userId) {
    filters.push('user_id = ?');
    binds.push(input.userId);
  }
  binds.push(config.wakeBatchSize);
  const rows = await env.DATABASE.prepare(
    `
      SELECT vm_task_admissions.task_id, tasks.id AS live_task_id
      FROM vm_task_admissions
      LEFT JOIN tasks ON tasks.id = vm_task_admissions.task_id
      WHERE ${filters.join(' AND ')}
      ORDER BY vm_task_admissions.enqueued_at ASC
      LIMIT ?
    `
  )
    .bind(...binds)
    .all<{ task_id: string; live_task_id: string | null }>();

  let nudged = 0;
  for (const row of rows.results ?? []) {
    if (!row.live_task_id) {
      await cancelOrphanedAdmission(env, row.task_id, input.reason);
      continue;
    }
    try {
      if (await nudgeTaskRunner(env, row.task_id, input.reason)) nudged++;
    } catch (err) {
      log.warn('vm_admission.wake_waiter_failed', {
        taskId: row.task_id,
        reason: input.reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return nudged;
}

async function cancelOrphanedAdmission(env: Env, taskId: string, wakeReason: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE vm_task_admissions
         SET state = 'cancelled',
           reason = 'task_deleted_cleanup',
           next_retry_at = NULL,
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
         WHERE task_id = ?
           AND state IN ('queued', 'waiting')`
      ).bind(now, now, taskId),
      env.DATABASE.prepare(`DELETE FROM vm_provisioning_leases WHERE owner_task_id = ?`).bind(taskId),
    ]);
    log.warn('vm_admission.orphaned_waiter_cancelled', { taskId, wakeReason });
  } catch (err) {
    log.warn('vm_admission.orphaned_waiter_cancel_failed', {
      taskId,
      wakeReason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getVmAdmissionDiagnostics(
  env: Env,
  taskId: string
): Promise<{
  admission: Record<string, unknown> | null;
  lease: Record<string, unknown> | null;
  providerCapacity: Record<string, unknown> | null;
}> {
  const admission = await first<Record<string, unknown>>(
    env.DATABASE,
    `SELECT * FROM vm_task_admissions WHERE task_id = ? LIMIT 1`,
    [taskId]
  );
  const lease = admission?.scope_key
    ? await first<Record<string, unknown>>(
        env.DATABASE,
        `SELECT * FROM vm_provisioning_leases WHERE scope_key = ? LIMIT 1`,
        [admission.scope_key]
      )
    : null;
  const providerCapacity = admission?.provider_domain_key
    ? await first<Record<string, unknown>>(
        env.DATABASE,
        `SELECT * FROM vm_provider_capacity_state WHERE provider_domain_key = ? LIMIT 1`,
        [admission.provider_domain_key]
      )
    : null;
  return { admission, lease, providerCapacity };
}

export function isActiveVmAdmissionState(state: string | null | undefined): boolean {
  return !!state && ACTIVE_ADMISSION_STATES.has(state as VmAdmissionState);
}
