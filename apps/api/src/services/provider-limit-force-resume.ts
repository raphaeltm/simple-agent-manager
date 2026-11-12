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
import {
  parseProviderLimitSnapshotRow,
  resolveProviderLimitProfileId,
} from './provider-limit-approval-context';
import type { ProviderLimitWait } from './provider-limit-policy';
import {
  loadProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalD1Fence,
} from './provider-limit-recovery-approval';
import { requireSessionWriter } from './session-access';
import {
  canRepairSessionRecoveryRunner,
  ensureSessionRecovery,
  type SessionRecoveryResult,
} from './session-recovery';
import { getTaskRunnerStatus, nudgeTaskRunnerDO } from './task-runner-do';

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
  assertSavedSessionAuthority(writer, task, ownerUserId);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const snapshotRow = await env.DATABASE.prepare(
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
    .first();
  const snapshot = parseProviderLimitSnapshotRow(snapshotRow);
  if (!snapshot)
    throw errors.conflict('The saved snapshot is unavailable, expired, or already restoring');
  const profileId = await resolveSavedProviderLimitSelection(
    env,
    task,
    ownerUserId,
    wait,
    snapshot
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
      profileId,
      skillId: task.skillId,
      agentType: snapshot.agent_type,
      expiresAt: wait.deadlineAt,
      recoveryPending: true,
      ownerUserId,
      snapshotId: snapshot.id,
    },
    // Existing scheduled deliveries are fenced by this key immediately before submit.
    scheduleKey: `provider-limit:${task.id}:override:${crypto.randomUUID()}`,
  } satisfies ProviderLimitWait);
  const changed = await env.DATABASE.prepare(
    `UPDATE tasks SET agent_profile_hint=?,provider_limit_wait_json=?,admission_state='provider_limit_recovery_pending',admission_reason=NULL,
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
      profileId,
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
      profileId
    )
    .run();
  if (!changed.meta.changes)
    throw errors.conflict('Task changed while resuming; refresh and try again');

  const recoveryApproval = {
    receipt: overridden,
    ownerUserId,
    snapshotId: snapshot.id,
    expiresAt: wait.deadlineAt,
    sourceCredentialReference: snapshot.agent_credential_reference,
  };

  // Never clear a claim, even when an RPC response is lost. The normal runner's
  // authority checks and alarms own restoration and receipt reconciliation.
  if (snapshot.recovery_status === 'waking') {
    let nudged: boolean;
    try {
      nudged = await nudgeTaskRunnerDO(
        env,
        task.id,
        'Owner resumed despite provider limit',
        recoveryApproval
      );
    } catch {
      throw errors.conflict('Resume accepted, but the runner did not confirm; refresh shortly');
    }
    if (!nudged) {
      await handleRefusedRecoveryNudge(env, task, snapshot.recovery_attempt_id, restoreHold);
    }
  } else {
    let result: SessionRecoveryResult;
    try {
      result = await ensureSessionRecovery(env, task.projectId, task.chatSessionId, {
        taskId: task.id,
        projectId: task.projectId,
        chatSessionId: task.chatSessionId,
        requiredProjectMemberId: ownerUserId,
        providerLimitApproval: recoveryApproval,
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
  await acknowledgeProviderLimitRecovery(
    env,
    task.id,
    overridden,
    false,
    snapshot.recovery_status === 'waking' ? snapshot.recovery_attempt_id : undefined
  );
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

async function handleRefusedRecoveryNudge(
  env: Env,
  task: Pick<schema.Task, 'id' | 'projectId' | 'userId' | 'chatSessionId'>,
  recoveryAttemptId: string | null,
  restoreHold: () => Promise<void>
): Promise<never> {
  let status;
  try {
    status = await getTaskRunnerStatus(env, task.id);
  } catch {
    throw errors.conflict('Resume accepted, but the runner did not confirm; refresh shortly');
  }
  // Claim-before-runner crashes need the pending receipt for bounded repair.
  if (
    canRepairSessionRecoveryRunner(status, {
      taskId: task.id,
      projectId: task.projectId,
      userId: task.userId,
      chatSessionId: task.chatSessionId ?? '',
      recoveryAttemptId: recoveryAttemptId ?? '',
    })
  )
    throw errors.conflict('Resume accepted; the recovery runner will be repaired shortly');
  await restoreHold();
  throw errors.conflict('The existing recovery runner is unavailable; try again shortly');
}

/** Exact approval CAS: a newer rejection/approval must retain its own intent. */
export async function acknowledgeProviderLimitRecovery(
  env: Env,
  taskId: string,
  receipt: string,
  requireCommittedRun = false,
  expectedRecoveryAttemptId?: string | null
) {
  const approval = await loadProviderLimitRecoveryApproval(env, taskId, receipt);
  if (!approval) return;
  const fence = providerLimitRecoveryApprovalD1Fence('tasks', approval, true, requireCommittedRun);
  // A claim can advance after the DO's authority read but before its ACK.
  // Clear only the attempt that this caller actually nudged.
  const claimFence =
    expectedRecoveryAttemptId === undefined
      ? { sql: '', params: [] }
      : {
          sql: `AND EXISTS (SELECT 1 FROM session_snapshots acknowledged_snapshot
      WHERE acknowledged_snapshot.id=? AND acknowledged_snapshot.project_id=tasks.project_id
        AND acknowledged_snapshot.chat_session_id=tasks.chat_session_id
        AND acknowledged_snapshot.user_id=tasks.user_id
        AND acknowledged_snapshot.recovery_attempt_id IS ?)`,
          params: [approval.snapshotId, expectedRecoveryAttemptId],
        };
  await env.DATABASE.prepare(
    `UPDATE tasks SET admission_state=NULL,admission_reason=NULL,admission_next_retry_at=NULL
     WHERE id=? AND admission_state='provider_limit_recovery_pending' ${fence.sql} ${claimFence.sql}`
  )
    .bind(taskId, ...fence.params, ...claimFence.params)
    .run();
}

/** Resolve and validate the exact account/profile the saved session used. */
async function resolveSavedProviderLimitSelection(
  env: Env,
  task: schema.Task,
  ownerUserId: string,
  wait: ProviderLimitWait,
  snapshot: NonNullable<ReturnType<typeof parseProviderLimitSnapshotRow>>
) {
  const db = drizzle(env.DATABASE, { schema });
  const profileId = await resolveProviderLimitProfileId(db, env, task);
  const profile = await resolveProfileCredentialContext(db, {
    userId: ownerUserId,
    projectId: task.projectId,
    profileId,
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
    snapshot.agent_profile_id !== profileId ||
    profileId === undefined ||
    (task.agentProfileHint !== null && !profile) ||
    (profile && profile.agentType !== snapshot.agent_type) ||
    (await credentialLimitReferenceKey(snapshot.agent_credential_reference)) !==
      wait.credentialKey ||
    (await credentialLimitReferenceKey(reference)) !== wait.credentialKey
  )
    throw errors.conflict(
      'The selected account or profile changed; review the provider hold before resuming'
    );

  return profileId;
}

function assertSavedSessionAuthority(
  writer: Awaited<ReturnType<typeof requireSessionWriter>>,
  task: schema.Task,
  ownerUserId: string
): void {
  if (
    writer.role !== 'owner' ||
    writer.ownerUserId !== ownerUserId ||
    writer.session.taskId !== task.id ||
    writer.session.status !== 'sleeping'
  )
    throw errors.conflict('The saved session authority changed; refresh before resuming');
}
