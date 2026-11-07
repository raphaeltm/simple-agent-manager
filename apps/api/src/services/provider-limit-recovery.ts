/** Owner recovery and the durable needs-attention state for provider waits. */
import type * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import * as projectData from './project-data';
import { parseProviderLimitWait, type ProviderLimitWait } from './provider-limit-policy';
import { ensureSessionRecovery } from './session-recovery';
import { nudgeTaskRunnerDO } from './task-runner-do';

/** Stop presenting a parked recovery as an in-flight wake. The snapshot and WIP
 * stay intact; clearing its claim also fences a stale TaskRunner from continuing. */
export async function presentBlockedProviderLimitWait(
  env: Env,
  task: Pick<schema.Task, 'id' | 'projectId' | 'chatSessionId' | 'workspaceId'>,
  wait: ProviderLimitWait
): Promise<void> {
  if (wait.phase !== 'blocked' || !task.chatSessionId) return;
  const now = new Date().toISOString();
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE tasks SET status='sleeping',execution_step=NULL,workspace_id=NULL,updated_at=?
       WHERE id=? AND project_id=?
       AND (workspace_id IS NULL OR EXISTS (SELECT 1 FROM session_snapshots s JOIN workspaces w ON w.id=s.workspace_id
         WHERE s.chat_session_id=tasks.chat_session_id AND s.project_id=tasks.project_id AND s.workspace_id=tasks.workspace_id
         AND s.sleeping_at IS NOT NULL AND s.sleep_status='sleeping' AND w.status IN ('sleeping','deleted','stopped')))
       AND status IN ('queued','delegated','sleeping')
       AND EXISTS (SELECT 1 FROM session_snapshots s WHERE s.project_id=tasks.project_id AND s.chat_session_id=tasks.chat_session_id AND s.sleeping_at IS NOT NULL)
       AND json_valid(provider_limit_wait_json)
       AND json_extract(provider_limit_wait_json,'$.phase')='blocked'
       AND json_extract(provider_limit_wait_json,'$.scheduleKey')=?`
    ).bind(now, task.id, task.projectId, wait.scheduleKey),
    env.DATABASE.prepare(
      `UPDATE session_snapshots SET recovery_status='failed',recovery_error=?,
       recovery_attempt_id=NULL,recovery_claimed_at=NULL,updated_at=?
       WHERE project_id=? AND chat_session_id=? AND sleeping_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=? AND t.project_id=session_snapshots.project_id
         AND t.chat_session_id=session_snapshots.chat_session_id AND t.workspace_id IS NULL
         AND t.status='sleeping' AND json_valid(t.provider_limit_wait_json)
         AND json_extract(t.provider_limit_wait_json,'$.phase')='blocked'
         AND json_extract(t.provider_limit_wait_json,'$.scheduleKey')=?)`
    ).bind(wait.reason, now, task.projectId, task.chatSessionId, task.id, wait.scheduleKey),
  ]);
  await projectData.syncProviderLimitAttention(env, task.projectId, task.id, task.chatSessionId);
}

/** Explicit owner approval accepts the current profile credential and starts a
 * fresh recovery claim. It never rewrites the snapshot or discards saved WIP. */
export async function resumeProviderLimitTask(env: Env, task: schema.Task, ownerUserId: string) {
  if (task.userId !== ownerUserId)
    throw errors.forbidden('Only the task owner can resume this task');
  const wait = parseProviderLimitWait(task.providerLimitWaitJson);
  if (
    wait?.phase !== 'blocked' ||
    !task.chatSessionId ||
    !['sleeping', 'queued', 'delegated', 'in_progress'].includes(task.status)
  )
    throw errors.conflict('This task is not blocked on a provider limit');
  const now = new Date().toISOString();
  const snapshot = await env.DATABASE.prepare(
    `SELECT id FROM session_snapshots WHERE project_id=? AND chat_session_id=? AND user_id=?
     AND sleeping_at IS NOT NULL AND ((status='available' AND degradation='none') OR (status='degraded' AND degradation IS NOT NULL AND degradation!='none')) AND expires_at>?`
  )
    .bind(task.projectId, task.chatSessionId, ownerUserId, now)
    .first();
  if (task.workspaceId) {
    const saved = await env.DATABASE.prepare(
      `SELECT 1 FROM session_snapshots s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.project_id=? AND s.chat_session_id=? AND s.workspace_id=? AND s.user_id=?
       AND s.sleeping_at IS NOT NULL AND s.sleep_status='sleeping' AND w.status IN ('sleeping','deleted','stopped')`
    )
      .bind(task.projectId, task.chatSessionId, task.workspaceId, ownerUserId)
      .first();
    if (!saved)
      throw errors.conflict(
        'The task is still saving its workspace. Resume after it has gone to sleep.'
      );
  }
  if (!snapshot) {
    const anySnapshot = await env.DATABASE.prepare(
      'SELECT 1 FROM session_snapshots WHERE project_id=? AND chat_session_id=?'
    )
      .bind(task.projectId, task.chatSessionId)
      .first();
    // A first dispatch can exhaust unknown-reset admission before it ever has a
    // runtime or snapshot. Resume its existing runner instead of fabricating a wake.
    if (anySnapshot || wait.origin !== 'admission' || task.status !== 'queued')
      throw errors.conflict('The saved snapshot is unavailable or expired');
    const cleared = await env.DATABASE.prepare(
      `UPDATE tasks SET provider_limit_wait_json=NULL,admission_state=NULL,admission_reason=NULL,admission_next_retry_at=NULL
       WHERE id=? AND project_id=? AND user_id=? AND status='queued' AND workspace_id IS NULL AND provider_limit_wait_json IS ?`
    )
      .bind(task.id, task.projectId, ownerUserId, task.providerLimitWaitJson)
      .run();
    if (!cleared.meta.changes)
      throw errors.conflict('Task changed while resuming; refresh and try again');
    try {
      if (!(await nudgeTaskRunnerDO(env, task.id, 'Owner resumed provider-limit admission')))
        throw errors.conflict('The task runner is unavailable');
    } catch (error) {
      await env.DATABASE.prepare(
        `UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',admission_reason=? WHERE id=? AND status='queued' AND workspace_id IS NULL AND provider_limit_wait_json IS NULL`
      )
        .bind(task.providerLimitWaitJson, wait.reason, task.id)
        .run();
      throw error;
    }
    await projectData.syncProviderLimitAttention(env, task.projectId, task.id, task.chatSessionId);
    return { status: 'waking' as const, taskId: task.id };
  }

  // A released receipt keeps window history; admission accepts the current
  // credential after the owner explicitly approved changing it.
  const released = JSON.stringify({
    ...wait,
    phase: 'released',
    attempts: 1,
    scheduleKey: `provider-limit:${task.id}:resume:${crypto.randomUUID()}`,
  });
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE tasks SET status='sleeping',execution_step=NULL,workspace_id=NULL,provider_limit_wait_json=?,
       admission_state=NULL,admission_reason=NULL,admission_next_retry_at=NULL,updated_at=?
       WHERE id=? AND project_id=? AND user_id=? AND workspace_id IS ?
       AND status IN ('sleeping','queued','delegated') AND provider_limit_wait_json IS ?`
    ).bind(
      released,
      now,
      task.id,
      task.projectId,
      ownerUserId,
      task.workspaceId,
      task.providerLimitWaitJson
    ),
    env.DATABASE.prepare(
      `UPDATE session_snapshots SET recovery_status=NULL,recovery_attempt_id=NULL,recovery_claimed_at=NULL,
       recovery_error=NULL,recovery_failed_at=NULL,updated_at=?
       WHERE project_id=? AND chat_session_id=? AND user_id=? AND sleeping_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=? AND t.provider_limit_wait_json IS ? AND t.workspace_id IS NULL AND t.status='sleeping')`
    ).bind(now, task.projectId, task.chatSessionId, ownerUserId, task.id, released),
  ]);
  if (!results[0]?.meta.changes)
    throw errors.conflict('Task changed while resuming; refresh and try again');
  const result = await ensureSessionRecovery(
    env,
    task.projectId,
    task.chatSessionId,
    {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId,
    },
    { wakeCause: 'runtime_lost' }
  ).catch(() => ({
    status: 'unavailable' as const,
    reason: 'Session recovery is temporarily unavailable; try again.',
  }));
  if (result.status !== 'waking') {
    // Approval did not launch: retain a supported retry instead of losing the CTA.
    await env.DATABASE.prepare(
      `UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',admission_reason=?
       WHERE id=? AND provider_limit_wait_json IS ? AND workspace_id IS NULL AND status='sleeping'`
    )
      .bind(task.providerLimitWaitJson, wait.reason, task.id, released)
      .run();
    await presentBlockedProviderLimitWait(env, task, wait);
    throw errors.conflict(`Unable to resume the saved task: ${result.reason}`);
  }
  await projectData.syncProviderLimitAttention(env, task.projectId, task.id, task.chatSessionId);
  return result;
}
