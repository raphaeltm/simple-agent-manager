import {
  dispatchOwnerApprovedRecovery,
  withinRecoveryRpcBudget,
} from './provider-limit-owner-dispatch';
export { resolveProviderLimitRecoveryRpcTimeoutMs } from './provider-limit-owner-dispatch';
import { type ProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getSelectedAgentCredentialReference } from './agent-credential-selection';
import {
  type ProfileCredentialContext,
  resolveProfileCredentialContext,
} from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import * as projectData from './project-data';
import {
  parseProviderLimitSnapshotRow,
  resolveProviderLimitProfileId,
} from './provider-limit-approval-context';
import {
  loadProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalD1Fence,
} from './provider-limit-recovery-approval';
import { requireSessionWriter } from './session-access';
import { sessionRecoveryMaxAttempts } from './session-snapshot-recovery-budget';
import { sessionRecoveryClaimLeaseMs } from './session-snapshot-recovery-conditions';
import { getTaskRunnerStatus } from './task-runner-do';

/** Canonical SQLite representation of recovery progress, excluding lease-only timestamps. */
const OWNER_RECOVERY_PROGRESS_SQL = `json_object(
  'workspaceId', progress_snapshot.workspace_id,
  'recoveryStatus', progress_snapshot.recovery_status,
  'recoveryTaskId', progress_snapshot.recovery_task_id,
  'recoveryAttemptId', progress_snapshot.recovery_attempt_id,
  'recoveryWorkspaceId', progress_snapshot.recovery_workspace_id,
  'sleepStatus', progress_snapshot.sleep_status,
  'sleepingAt', progress_snapshot.sleeping_at,
  'status', progress_snapshot.status,
  'snapshotGeneration', progress_snapshot.snapshot_generation)`;

async function captureOwnerRecoveryProgress(
  env: Env,
  task: schema.Task,
  snapshotId: string | undefined
) {
  const row = await env.DATABASE.prepare(
    `SELECT ${OWNER_RECOVERY_PROGRESS_SQL} AS progress FROM session_snapshots progress_snapshot
     WHERE progress_snapshot.id=? AND progress_snapshot.project_id=?
       AND progress_snapshot.chat_session_id IS ? AND progress_snapshot.user_id=?`
  )
    .bind(snapshotId ?? null, task.projectId, task.chatSessionId, task.userId)
    .first();
  if (!row) return null;
  if (typeof row.progress !== 'string')
    throw new Error('Provider recovery progress is unavailable');
  return row.progress;
}

/** The owner's release and this intent share one task-row CAS. A worker crash
 * before the recovery RPC therefore leaves a bounded cron-consumable receipt. */
export async function repairOwnerApprovedRecovery(
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
  const recoveryProgress = await captureOwnerRecoveryProgress(env, task, approval?.snapshotId);
  let valid = pendingApprovalMatchesTask(task, wait, now);
  // Restore commits before the runner transitions the task to in_progress.
  // Preserve this bounded intent while that exact runner finishes; this read
  // neither acknowledges consent nor authorizes any new recovery side effect.
  if (valid && (await materializedOwnerRecoveryIsCurrent(env, task, receipt))) return;
  // The original provider deadline may be days away. Repair gets one existing
  // claim-lease window and a non-decaying episode budget, including the click.
  const repairDeadline =
    approval?.repairExpiresAt ??
    Math.min(wait.deadlineAt, (approval?.grantedAt ?? now) + sessionRecoveryClaimLeaseMs(env));
  if (
    valid &&
    (now >= repairDeadline || (approval?.repairAttempts ?? 0) >= sessionRecoveryMaxAttempts(env))
  ) {
    // A positive current runner may still be provisioning before workspace materialization.
    // The short timer forbids NEW dispatches; its already-started attempt keeps the original deadline.
    if (await materializedOwnerRecoveryIsCurrent(env, task, receipt, true)) return;
    log.warn('provider_limit.owner_repair_exhausted', {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId,
      snapshotId: approval?.snapshotId,
      attempts: approval?.repairAttempts ?? 0,
      deadline: repairDeadline,
      action: 'block_retaining_snapshot',
    });
    await blockRevokedOwnerApproval(
      env,
      task,
      wait,
      receipt,
      recoveryProgress,
      'Blocked: automatic recovery did not confirm within its repair budget. Review saved work before resuming.'
    );
    return;
  }

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
    // Only this read is raced. A late response has no continuation capable of
    // spending consent or dispatching recovery; an uncertain read defers repair.
    const chatSessionId = task.chatSessionId;
    const authority = await withinRecoveryRpcBudget(env, async () => ({
      matches: await savedSessionAuthorityMatches(env, task, approval, chatSessionId),
    }));
    if (!authority) return;
    valid &&= authority.matches;
  }
  if (valid && snapshot) {
    const profile = await resolveProfileCredentialContext(db, {
      userId: task.userId,
      projectId: task.projectId,
      profileId,
      skillId: task.skillId,
      runConfigurationId: task.agentConfigurationId,
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
      profileMatchesApproval(profile, profileId, approval) &&
      (await credentialLimitReferenceKey(reference)) === wait.credentialKey;
  }
  if (
    valid &&
    snapshot &&
    !(await pendingRecoveryScopeIsCurrent(env, task, wait, snapshot, receipt))
  )
    return;
  if (!valid || !snapshot || !task.chatSessionId || !approval || approval.expiresAt === undefined) {
    await blockRevokedOwnerApproval(env, task, wait, receipt, recoveryProgress);
    return;
  }
  // Spend before dispatch with the exact receipt CAS. Concurrent sweeps lose
  // this CAS. Accounting fields are excluded from consent identity, so a lost
  // nudge cannot revoke an in-flight attempt; newer consent still supersedes it.
  const next: ProviderLimitWait = {
    ...wait,
    ownerOverride: {
      ...approval,
      repairExpiresAt: repairDeadline,
      repairAttempts: (approval.repairAttempts ?? 0) + 1,
    },
  };
  const nextReceipt = JSON.stringify(next);
  const spent = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json=?
    WHERE id=? AND provider_limit_wait_json IS ? AND admission_state='provider_limit_recovery_pending'
      AND status=? AND workspace_id IS ?
      AND (julianday('now')-julianday('1970-01-01'))*86400000 < ?`
  )
    .bind(nextReceipt, task.id, receipt, task.status, task.workspaceId, repairDeadline)
    .run();
  if (!spent.meta.changes) return;
  await dispatchOwnerApprovedRecovery(
    env,
    { ...task, providerLimitWaitJson: nextReceipt },
    next,
    snapshot,
    nextReceipt,
    task.chatSessionId
  );
}

/** A materialized or completed restore still belongs to its exact live recovery attempt. */
async function materializedOwnerRecoveryIsCurrent(
  env: Env,
  task: schema.Task,
  receipt: string,
  includeUnmaterialized = false
): Promise<boolean> {
  const approval = await loadProviderLimitRecoveryApproval(env, task.id, receipt);
  if (!approval) return false;
  const fence = providerLimitRecoveryApprovalD1Fence('t', approval);
  const restored = await env.DATABASE.prepare(
    `SELECT s.recovery_attempt_id AS attempt FROM tasks t JOIN session_snapshots s
       ON s.id=? AND s.project_id=t.project_id AND s.chat_session_id=t.chat_session_id AND s.user_id=t.user_id
     WHERE t.id=? AND t.project_id=? AND t.user_id=? AND t.status IN ('queued','delegated')
       AND t.admission_state='provider_limit_recovery_pending' AND t.provider_limit_wait_json IS ?
       AND s.recovery_status IN ('waking','restored') AND s.recovery_task_id=t.id
       AND s.recovery_attempt_id IS NOT NULL AND s.recovery_attempt_id!=''
       AND (s.recovery_workspace_id=t.workspace_id
         ${includeUnmaterialized ? 'OR (s.recovery_workspace_id IS NULL AND t.workspace_id IS NULL)' : ''})
       ${fence.sql}`
  )
    .bind(approval.snapshotId, task.id, task.projectId, task.userId, receipt, ...fence.params)
    .first<unknown>();
  if (
    !restored ||
    typeof restored !== 'object' ||
    !('attempt' in restored) ||
    typeof restored.attempt !== 'string'
  )
    return false;
  const observed = await withinRecoveryRpcBudget(env, async () => ({
    status: await getTaskRunnerStatus(env, task.id),
  })).catch(() => false as const);
  // This D1 scope is valid, but an unavailable runner cannot prove revocation.
  // Defer without ACK or new work; consent's original deadline still applies.
  if (!observed) return true;
  const status = maybeJsonRecord(observed.status);
  if (
    !status ||
    status.taskId !== task.id ||
    status.projectId !== task.projectId ||
    status.userId !== task.userId ||
    status.completed !== false
  )
    return false;
  const config = maybeJsonRecord(status.config);
  return (
    config?.recoveryAttemptId === restored.attempt &&
    config.resumeSnapshotChatSessionId === task.chatSessionId
  );
}

type SavedProviderLimitSnapshot = NonNullable<ReturnType<typeof parseProviderLimitSnapshotRow>>;

/** RPC refusals revoke authority; transport failures leave the accepted intent intact. */
async function savedSessionAuthorityMatches(
  env: Env,
  task: schema.Task,
  approval: ProviderLimitWait['ownerOverride'],
  chatSessionId: string
): Promise<boolean> {
  const authority = await requireSessionWriter(env, task.projectId, chatSessionId, task.userId, {
    action: 'complete the approved provider limit recovery',
  }).catch((error: unknown) => {
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
  return Boolean(
    authority?.role === 'owner' &&
    authority.ownerUserId === approval?.ownerUserId &&
    authority.session.taskId === task.id &&
    authority.session.status === 'sleeping'
  );
}

/** Independent final fence: do not reuse the earlier eligibility read across awaits. */
async function pendingRecoveryScopeIsCurrent(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  snapshot: SavedProviderLimitSnapshot,
  receipt: string
): Promise<boolean> {
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
         AND t.status=? AND t.workspace_id IS ? AND t.agent_profile_hint IS ? AND t.skill_id IS ? AND t.agent_configuration_id IS ?
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
      task.agentConfigurationId,
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
  return current?.valid === 1 && wait.deadlineAt > Date.now();
}

async function blockRevokedOwnerApproval(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  receipt: string,
  recoveryProgress: string | null,
  reason = 'Blocked: the approved provider limit recovery expired or its authority changed.'
): Promise<void> {
  const blocked = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',
         admission_reason=?,admission_next_retry_at=NULL
       WHERE id=? AND provider_limit_wait_json IS ? AND admission_state='provider_limit_recovery_pending'
         AND project_id=? AND user_id=? AND chat_session_id IS ?
         AND status IN ('sleeping','queued','delegated') AND status=? AND workspace_id IS ?
         AND agent_profile_hint IS ? AND skill_id IS ? AND agent_configuration_id IS ?
         AND (SELECT ${OWNER_RECOVERY_PROGRESS_SQL} FROM session_snapshots progress_snapshot
           WHERE progress_snapshot.id=? AND progress_snapshot.project_id=tasks.project_id
             AND progress_snapshot.chat_session_id IS tasks.chat_session_id
             AND progress_snapshot.user_id=tasks.user_id) IS ?`
  )
    .bind(
      JSON.stringify({ ...wait, phase: 'blocked', reason, ownerOverride: undefined }),
      reason,
      task.id,
      receipt,
      task.projectId,
      wait.ownerOverride?.ownerUserId ?? null,
      task.chatSessionId,
      task.status,
      task.workspaceId,
      task.agentProfileHint,
      task.skillId,
      task.agentConfigurationId,
      wait.ownerOverride?.snapshotId ?? null,
      recoveryProgress
    )
    .run();
  if (!blocked.meta.changes) return;
  if (task.chatSessionId) {
    const chatSessionId = task.chatSessionId;
    // The blocked CAS is durable. This best-effort notification reads current
    // task state; late completion cannot authorize recovery or change its claim.
    await withinRecoveryRpcBudget(env, () =>
      projectData.syncProviderLimitAttention(env, task.projectId, task.id, chatSessionId)
    ).catch(() => undefined);
  }
}

/** Retry only the approved task; an ambiguous response preserves its pending receipt. */
/** Persisted consent covers only this owner, task scope and original deadline. */
function pendingApprovalMatchesTask(
  task: schema.Task,
  wait: ProviderLimitWait,
  now: number
): boolean {
  const approval = wait.ownerOverride;
  return Boolean(
    wait.origin === 'callback' &&
    approval?.recoveryPending &&
    approval.ownerUserId === task.userId &&
    approval.snapshotId &&
    approval.credentialKey !== null &&
    approval.credentialKey === wait.credentialKey &&
    approval.skillId === task.skillId &&
    (approval.runConfigurationId ?? null) === task.agentConfigurationId &&
    approval.agentType &&
    approval.expiresAt !== undefined &&
    approval.expiresAt <= wait.deadlineAt &&
    approval.expiresAt > now &&
    wait.deadlineAt > now &&
    task.chatSessionId &&
    wait.sourceAgentSessionId &&
    Number.isSafeInteger(wait.sourceCredentialGeneration)
  );
}

function profileMatchesApproval(
  profile: ProfileCredentialContext | null,
  profileId: string | null | undefined,
  approval: ProviderLimitWait['ownerOverride']
): boolean {
  return (
    (profileId === null || profile !== null) &&
    (profile === null || profile.agentType === null || profile.agentType === approval?.agentType)
  );
}
