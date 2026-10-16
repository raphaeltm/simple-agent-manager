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
import { repairProviderLimitIntents } from './provider-limit-parking';
import { parseProviderLimitWait } from './provider-limit-policy';

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
  if (!task || !wait || wait.phase === 'released') return false;
  const expired = wait.phase === 'waiting' && now > wait.deadlineAt;
  const current = expired
    ? {
        ...wait,
        phase: 'blocked' as const,
        reason:
          'Blocked: provider limit wake deadline expired. Review retained work before resuming.',
      }
    : wait;
  if (expired)
    await env.DATABASE.prepare(
      `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = 'provider_limit_blocked', admission_reason = ?, admission_next_retry_at = NULL
      WHERE id = ? AND provider_limit_wait_json IS ?`
    )
      .bind(JSON.stringify(current), current.reason, taskId, task.providerLimitWaitJson)
      .run();
  if (wait.origin === 'callback' && !expired) {
    try {
      await repairProviderLimitIntents(env, task, current);
    } catch {
      /* Persisted intent survives; bounded deadline prevents immortal repair. */
    }
  }
  if (!task.workspaceId) return true;
  // A failed sleep remains visibly blocked without check-ins or stall diagnosis.
  // Only the existing absolute compute ceiling can terminalize retained compute.
  const ceiling = await evaluateRunawayCostCeiling(
    env,
    {
      id: task.id,
      project_id: task.projectId,
      workspace_id: task.workspaceId,
      chat_session_id: task.chatSessionId,
      startedAtMs:
        task.startedAt || task.createdAt
          ? Date.parse(task.startedAt ?? task.createdAt)
          : current.observedAt,
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
  return ceiling.kind !== 'terminalize';
}
