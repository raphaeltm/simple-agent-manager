import {
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { evaluateRunawayCostCeiling } from '../scheduled/stuck-task-ceiling';
import { getSelectedAgentCredentialReference } from './agent-key-resolution';
import { resolveProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import * as projectData from './project-data';
import {
  parseProviderLimitSnapshotRow,
  resolveProviderLimitProfileId,
} from './provider-limit-approval-context';
import { acknowledgeProviderLimitRecovery } from './provider-limit-force-resume';
import { repairProviderLimitIntents } from './provider-limit-parking';
import { parseProviderLimitWait, type ProviderLimitWait } from './provider-limit-policy';
import { presentBlockedProviderLimitWait } from './provider-limit-recovery';
import { requireSessionWriter } from './session-access';
import { ensureSessionRecovery } from './session-recovery';
import { nudgeTaskRunnerDO } from './task-runner-do';

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
      task.admissionState !== 'provider_limit_recovery_pending' ||
      !['sleeping', 'queued', 'delegated'].includes(task.status)
    )
      return false;
    await repairOwnerApprovedRecovery(env, task, wait, now);
    return true;
  }
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
  if (current.phase === 'blocked') await presentBlockedProviderLimitWait(env, task, current);
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

/** The owner's release and this intent share one task-row CAS. A worker crash
 * before the recovery RPC therefore leaves a bounded cron-consumable receipt. */
async function repairOwnerApprovedRecovery(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  now: number
): Promise<void> {
  const approval = wait.ownerOverride;
  const receipt = task.providerLimitWaitJson;
  if (!receipt) return;
  const db = drizzle(env.DATABASE, { schema });
  const permittedStatus = ['sleeping', 'queued', 'delegated'].includes(task.status);
  if (!permittedStatus) return;
  let valid = Boolean(
    wait.origin === 'callback' &&
    approval?.recoveryPending &&
    approval.ownerUserId === task.userId &&
    approval.snapshotId &&
    approval.credentialKey !== null &&
    approval.credentialKey === wait.credentialKey &&
    approval.skillId === task.skillId &&
    approval.agentType &&
    approval.expiresAt === wait.deadlineAt &&
    wait.deadlineAt > now &&
    task.chatSessionId &&
    wait.sourceAgentSessionId &&
    Number.isSafeInteger(wait.sourceCredentialGeneration)
  );
  // Resolve canonical profile IDs here too: the task's raw hint is not an ID.
  const profileId = await resolveProviderLimitProfileId(db, env, {
    projectId: task.projectId,
    userId: task.userId,
    agentProfileHint: task.agentProfileHint,
  });
  valid &&= profileId !== undefined && approval?.profileId === profileId;
  const rawSnapshot = await env.DATABASE.prepare(
    `SELECT s.id,s.recovery_status,s.recovery_task_id,s.recovery_attempt_id,s.updated_at,
       a.agent_type,a.agent_profile_id,a.agent_credential_reference,a.agent_credential_generation
     FROM session_snapshots s JOIN agent_sessions a
       ON a.id=? AND a.workspace_id=s.workspace_id AND a.user_id=s.user_id
     JOIN workspaces w ON w.id=s.workspace_id
     WHERE s.id=? AND s.project_id=? AND s.chat_session_id=? AND s.user_id=?
       AND s.runtime='vm' AND s.sleep_status='sleeping' AND s.sleeping_at IS NOT NULL
       AND s.expires_at>? AND julianday(s.expires_at) IS NOT NULL
       AND ((s.status='available' AND s.degradation='none') OR
         (s.status='degraded' AND s.degradation IS NOT NULL AND s.degradation!='none'))
       AND w.user_id=s.user_id AND w.project_id=s.project_id AND w.status IN ('sleeping','deleted','stopped')
       AND (s.recovery_status IS NULL OR s.recovery_status='failed' OR
         (s.recovery_status='waking' AND s.recovery_task_id=? AND s.recovery_attempt_id IS NOT NULL))
       AND EXISTS (SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
         WHERE m.project_id=s.project_id AND m.user_id=s.user_id AND m.status='active'
         AND m.role IN ('owner','admin','maintainer') AND u.status='active')`
  )
    .bind(
      wait.sourceAgentSessionId ?? null,
      approval?.snapshotId ?? null,
      task.projectId,
      task.chatSessionId,
      task.userId,
      new Date(now).toISOString(),
      task.id
    )
    .first<unknown>();
  const snapshot = parseProviderLimitSnapshotRow(rawSnapshot);
  valid &&= Boolean(
    snapshot &&
    snapshot.agent_type === approval?.agentType &&
    snapshot.agent_profile_id === profileId &&
    snapshot.agent_credential_generation === wait.sourceCredentialGeneration &&
    typeof snapshot.agent_credential_reference === 'string' &&
    (await credentialLimitReferenceKey(snapshot.agent_credential_reference)) === wait.credentialKey
  );
  if (valid && task.chatSessionId) {
    const authority = await requireSessionWriter(
      env,
      task.projectId,
      task.chatSessionId,
      task.userId,
      {
        action: 'complete the approved provider limit recovery',
      }
    ).catch((error: unknown) => {
      // Authorization refusals revoke approval; transient RPC failures retain it.
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        [403, 404, 409].includes(Number(error.statusCode))
      )
        return null;
      throw error;
    });
    valid &&= Boolean(
      authority &&
      authority.role === 'owner' &&
      authority.ownerUserId === approval?.ownerUserId &&
      authority.session.taskId === task.id &&
      authority.session.status === 'sleeping'
    );
  }
  if (valid && snapshot) {
    const profile = await resolveProfileCredentialContext(db, {
      userId: task.userId,
      projectId: task.projectId,
      profileId,
      skillId: task.skillId,
    });
    const reference = await getSelectedAgentCredentialReference(
      db,
      task.userId,
      snapshot.agent_type,
      getCredentialEncryptionKey(env),
      task.projectId,
      profile
    );
    valid &&=
      (profileId === null || Boolean(profile)) &&
      (await credentialLimitReferenceKey(reference)) === wait.credentialKey;
  }
  if (valid && snapshot) {
    // Session authority and credential selection cross RPC/decryption awaits.
    // Re-read every D1 scope immediately before dispatch; a stale read must not
    // nudge a runner or acquire a claim after cancellation or source mutation.
    const current = await env.DATABASE.prepare(
      `SELECT 1 AS valid FROM tasks t
       JOIN session_snapshots s ON s.id=? AND s.project_id=t.project_id
         AND s.chat_session_id=t.chat_session_id AND s.user_id=t.user_id
       JOIN agent_sessions a ON a.id=? AND a.workspace_id=s.workspace_id AND a.user_id=s.user_id
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE t.id=? AND t.project_id=? AND t.user_id=? AND t.chat_session_id=?
         AND t.status=? AND t.workspace_id IS ? AND t.agent_profile_hint IS ? AND t.skill_id IS ?
         AND t.admission_state='provider_limit_recovery_pending' AND t.provider_limit_wait_json IS ?
         AND s.updated_at=? AND s.recovery_status IS ? AND s.recovery_task_id IS ? AND s.recovery_attempt_id IS ?
         AND s.runtime='vm' AND s.sleep_status='sleeping' AND s.sleeping_at IS NOT NULL
         AND s.expires_at>? AND julianday(s.expires_at) IS NOT NULL
         AND ((s.status='available' AND s.degradation='none') OR
           (s.status='degraded' AND s.degradation IS NOT NULL AND s.degradation!='none'))
         AND w.user_id=s.user_id AND w.project_id=s.project_id AND w.status IN ('sleeping','deleted','stopped')
         AND a.agent_credential_generation=? AND a.agent_credential_reference IS ?
         AND a.agent_type=? AND a.agent_profile_id IS ?
         AND EXISTS (SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
           WHERE m.project_id=t.project_id AND m.user_id=t.user_id AND m.status='active'
           AND m.role IN ('owner','admin','maintainer') AND u.status='active')`
    )
      .bind(
        snapshot.id,
        wait.sourceAgentSessionId,
        task.id,
        task.projectId,
        task.userId,
        task.chatSessionId,
        task.status,
        task.workspaceId,
        task.agentProfileHint,
        task.skillId,
        receipt,
        snapshot.updated_at,
        snapshot.recovery_status,
        snapshot.recovery_task_id,
        snapshot.recovery_attempt_id,
        new Date(Date.now()).toISOString(),
        wait.sourceCredentialGeneration,
        snapshot.agent_credential_reference,
        snapshot.agent_type,
        snapshot.agent_profile_id
      )
      .first();
    if (current?.valid !== 1 || wait.deadlineAt <= Date.now()) return;
  }
  if (!valid || !snapshot || !task.chatSessionId) {
    const reason =
      'Blocked: the approved provider limit recovery expired or its authority changed.';
    const blocked = await env.DATABASE.prepare(
      `UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',
         admission_reason=?,admission_next_retry_at=NULL
       WHERE id=? AND provider_limit_wait_json IS ? AND admission_state='provider_limit_recovery_pending'
         AND project_id=? AND user_id=? AND chat_session_id IS ?
         AND status IN ('sleeping','queued','delegated')
         AND agent_profile_hint IS ? AND skill_id IS ?`
    )
      .bind(
        JSON.stringify({ ...wait, phase: 'blocked', reason, ownerOverride: undefined }),
        reason,
        task.id,
        receipt,
        task.projectId,
        approval?.ownerUserId ?? null,
        task.chatSessionId,
        task.agentProfileHint,
        task.skillId
      )
      .run();
    if (!blocked.meta.changes) return;
    if (task.chatSessionId)
      await projectData
        .syncProviderLimitAttention(env, task.projectId, task.id, task.chatSessionId)
        .catch(() => undefined);
    return;
  }
  // Neither path releases or replaces the snapshot claim or creates a new prompt.
  // Failed/ambiguous acknowledgements retain this exact approval for the next sweep.
  if (snapshot.recovery_status === 'waking') {
    if (!(await nudgeTaskRunnerDO(env, task.id, 'Retry owner-approved provider limit recovery')))
      return;
  } else {
    const result = await ensureSessionRecovery(env, task.projectId, task.chatSessionId, {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId,
      requiredProjectMemberId: task.userId,
    });
    if (result.status !== 'waking') return;
  }
  await acknowledgeProviderLimitRecovery(env, task.id, receipt);
}
