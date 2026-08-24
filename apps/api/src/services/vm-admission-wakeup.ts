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
      SELECT task_id
      FROM vm_task_admissions
      WHERE ${filters.join(' AND ')}
      ORDER BY enqueued_at ASC
      LIMIT ?
    `
  )
    .bind(...binds)
    .all<{ task_id: string }>();

  let nudged = 0;
  for (const row of rows.results ?? []) {
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
