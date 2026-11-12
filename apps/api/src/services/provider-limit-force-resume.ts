/** Owner recovery of a saved callback hold. Reuses the existing claim and runner. */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { errors } from '../middleware/error';
import { getSelectedAgentCredentialReference } from './agent-key-resolution';
import { resolveProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import * as projectData from './project-data';
import type { ProviderLimitWait } from './provider-limit-policy';
import { requireSessionWriter } from './session-access';
import { ensureSessionRecovery, type SessionRecoveryResult } from './session-recovery';
import { nudgeTaskRunnerDO } from './task-runner-do';

export function canResumeProviderLimitTaskAnyway(
  task: Pick<schema.Task, 'status' | 'admissionState'>,
  wait: ProviderLimitWait | null,
  now = Date.now()
): boolean {
  return (
    task.admissionState === 'provider_limit_waiting' &&
    ['sleeping', 'queued', 'delegated'].includes(task.status) &&
    wait?.origin === 'callback' &&
    wait.phase === 'waiting' &&
    wait.credentialKey !== null &&
    wait.deadlineAt > now
  );
}

export async function forceResumeSavedProviderLimitTask(
  env: Env,
  task: schema.Task,
  ownerUserId: string,
  wait: ProviderLimitWait
) {
  if (task.userId !== ownerUserId) throw errors.forbidden('Only the task owner can resume anyway');
  if (!task.chatSessionId || !canResumeProviderLimitTaskAnyway(task, wait))
    throw errors.conflict('This saved task is not waiting on a provider limit');
  const writer = await requireSessionWriter(env, task.projectId, task.chatSessionId, ownerUserId, {
    action: 'resume despite the provider limit',
  });
  if (
    writer.role !== 'owner' ||
    writer.ownerUserId !== ownerUserId ||
    writer.session.taskId !== task.id ||
    writer.session.status !== 'sleeping'
  )
    throw errors.conflict('The saved session authority changed; refresh before resuming');

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const snapshot = await env.DATABASE.prepare(
    `SELECT s.id,s.recovery_status,s.recovery_task_id,s.recovery_attempt_id,s.updated_at,
      a.agent_type,a.agent_profile_id,a.agent_credential_reference,a.agent_credential_generation
     FROM session_snapshots s JOIN workspaces w ON w.id=s.workspace_id
     JOIN agent_sessions a ON a.id=? AND a.workspace_id=s.workspace_id AND a.user_id=s.user_id
     WHERE s.project_id=? AND s.chat_session_id=? AND s.user_id=?
       AND s.runtime='vm' AND s.sleeping_at IS NOT NULL AND s.sleep_status='sleeping'
       AND s.expires_at>? AND julianday(s.expires_at) IS NOT NULL
       AND ((s.status='available' AND s.degradation='none') OR
         (s.status='degraded' AND s.degradation IS NOT NULL AND s.degradation!='none'))
       AND w.project_id=s.project_id AND w.user_id=s.user_id AND w.status IN ('sleeping','deleted','stopped')
       AND (? IS NULL OR ?=s.workspace_id)
       AND (s.recovery_status IS NULL OR s.recovery_status='failed' OR
         (s.recovery_status='waking' AND s.recovery_task_id=? AND s.recovery_attempt_id IS NOT NULL AND ? IS NULL))`
  )
    .bind(
      wait.sourceAgentSessionId ?? null,
      task.projectId,
      task.chatSessionId,
      ownerUserId,
      nowIso,
      task.workspaceId,
      task.workspaceId,
      task.id,
      task.workspaceId
    )
    .first<{
      id: string;
      recovery_status: string | null;
      recovery_task_id: string | null;
      recovery_attempt_id: string | null;
      updated_at: string;
      agent_type: string;
      agent_profile_id: string | null;
      agent_credential_reference: string | null;
      agent_credential_generation: number;
    }>();
  if (!snapshot)
    throw errors.conflict('The saved snapshot is unavailable, expired, or already restoring');
  const db = drizzle(env.DATABASE, { schema });
  const profile = await resolveProfileCredentialContext(db, {
    userId: ownerUserId,
    projectId: task.projectId,
    profileId: task.agentProfileHint,
    skillId: task.skillId,
  });
  const reference = await getSelectedAgentCredentialReference(
    db,
    ownerUserId,
    snapshot.agent_type,
    getCredentialEncryptionKey(env),
    task.projectId,
    profile
  );
  if (
    snapshot.agent_credential_generation !== wait.sourceCredentialGeneration ||
    snapshot.agent_profile_id !== task.agentProfileHint ||
    (task.agentProfileHint !== null && !profile) ||
    (profile && profile.agentType !== snapshot.agent_type) ||
    (await credentialLimitReferenceKey(snapshot.agent_credential_reference)) !==
      wait.credentialKey ||
    (await credentialLimitReferenceKey(reference)) !== wait.credentialKey
  )
    throw errors.conflict(
      'The selected account or profile changed; review the provider hold before resuming'
    );

  const grantNow = Date.now();
  if (wait.deadlineAt <= grantNow)
    throw errors.conflict('Provider wait expired while resuming; refresh and review');
  const grantIso = new Date(grantNow).toISOString();
  const retainedSnapshot = snapshot;
  const overridden = JSON.stringify({
    ...wait,
    phase: 'released',
    ownerOverride: {
      credentialKey: wait.credentialKey,
      grantedAt: grantNow,
      profileId: task.agentProfileHint,
      skillId: task.skillId,
      agentType: snapshot.agent_type,
      expiresAt: wait.deadlineAt,
    },
    // Existing scheduled deliveries are fenced by this key immediately before submit.
    scheduleKey: `provider-limit:${task.id}:override:${crypto.randomUUID()}`,
  } satisfies ProviderLimitWait);
  const changed = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json=?,admission_state=NULL,admission_reason=NULL,
       admission_next_retry_at=NULL,updated_at=?
     WHERE id=? AND project_id=? AND user_id=? AND chat_session_id=?
       AND status=? AND workspace_id IS ? AND agent_profile_hint IS ? AND skill_id IS ?
       AND admission_state='provider_limit_waiting' AND provider_limit_wait_json IS ?
       AND EXISTS (SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
         WHERE m.project_id=tasks.project_id AND m.user_id=tasks.user_id AND m.status='active'
         AND m.role IN ('owner','admin','maintainer') AND u.status='active')
       AND EXISTS (SELECT 1 FROM session_snapshots s JOIN agent_sessions a ON a.id=? AND a.workspace_id=s.workspace_id AND a.user_id=s.user_id
         WHERE s.id=? AND s.updated_at=? AND s.recovery_status IS ? AND s.recovery_task_id IS ? AND s.recovery_attempt_id IS ?
         AND s.expires_at>? AND s.sleeping_at IS NOT NULL AND s.sleep_status='sleeping'
         AND ((s.status='available' AND s.degradation='none') OR
           (s.status='degraded' AND s.degradation IS NOT NULL AND s.degradation!='none'))
         AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=s.workspace_id AND w.user_id=s.user_id
           AND w.project_id=s.project_id AND w.status IN ('sleeping','deleted','stopped'))
         AND a.agent_credential_generation=? AND a.agent_credential_reference IS ?
         AND a.agent_type=? AND a.agent_profile_id IS ?)`
  )
    .bind(
      overridden,
      nowIso,
      task.id,
      task.projectId,
      ownerUserId,
      task.chatSessionId,
      task.status,
      task.workspaceId,
      task.agentProfileHint,
      task.skillId,
      task.providerLimitWaitJson,
      wait.sourceAgentSessionId,
      snapshot.id,
      snapshot.updated_at,
      snapshot.recovery_status,
      snapshot.recovery_task_id,
      snapshot.recovery_attempt_id,
      grantIso,
      wait.sourceCredentialGeneration,
      snapshot.agent_credential_reference,
      snapshot.agent_type,
      task.agentProfileHint
    )
    .run();
  if (!changed.meta.changes)
    throw errors.conflict('Task changed while resuming; refresh and try again');

  // Never clear a claim, even when an RPC response is lost. The normal runner's
  // authority checks and alarms own restoration and receipt reconciliation.
  if (snapshot.recovery_status === 'waking') {
    let nudged: boolean;
    try {
      nudged = await nudgeTaskRunnerDO(env, task.id, 'Owner resumed despite provider limit');
    } catch {
      throw errors.conflict('Resume accepted, but the runner did not confirm; refresh shortly');
    }
    if (!nudged) {
      await restoreHold();
      throw errors.conflict('The existing recovery runner is unavailable; try again shortly');
    }
  } else {
    let result: SessionRecoveryResult;
    try {
      result = await ensureSessionRecovery(env, task.projectId, task.chatSessionId, {
        taskId: task.id,
        projectId: task.projectId,
        chatSessionId: task.chatSessionId,
        requiredProjectMemberId: ownerUserId,
      });
    } catch {
      // A lookup can fail before recovery acquires any claim. Restore only if
      // the original claim is still ours (or this wake definitively failed);
      // an advanced/ambiguous claim keeps its accepted override.
      await restoreHold();
      throw errors.conflict('Recovery did not confirm; refresh and try again shortly');
    }
    if (result.status !== 'waking') {
      await restoreHold();
      throw errors.conflict(`Unable to resume the saved task: ${result.reason}`);
    }
  }
  await projectData
    .syncProviderLimitAttention(env, task.projectId, task.id, task.chatSessionId)
    .catch(() =>
      log.warn('provider_limit.force_resume_attention_sync_failed', { taskId: task.id })
    );
  return { status: 'waking' as const, taskId: task.id };

  async function restoreHold() {
    // A definitive failure restores only our receipt. A concurrent recovery or
    // fresh rejection must never be overwritten, nor its claim released.
    await env.DATABASE.prepare(
      `UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_waiting',
         admission_reason=?,admission_next_retry_at=?
       WHERE id=? AND provider_limit_wait_json IS ? AND (workspace_id IS ? OR (status='sleeping' AND workspace_id IS NULL))
         AND status IN ('sleeping','queued','delegated')
         AND EXISTS (SELECT 1 FROM session_snapshots s WHERE s.id=?
           AND ((s.recovery_attempt_id IS ? AND s.recovery_status IS ?)
             OR (s.recovery_status='failed' AND s.recovery_task_id=tasks.id AND tasks.status='sleeping' AND tasks.workspace_id IS NULL)))`
    )
      .bind(
        task.providerLimitWaitJson,
        wait.reason,
        new Date(wait.nextRetryAt).toISOString(),
        task.id,
        overridden,
        task.workspaceId,
        retainedSnapshot.id,
        retainedSnapshot.recovery_attempt_id,
        retainedSnapshot.recovery_status
      )
      .run();
  }
}
