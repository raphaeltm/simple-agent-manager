import {
  parseProviderLimitWait,
  type ProviderLimitWait,
} from '@simple-agent-manager/scheduler-core';
import {
  DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS,
} from '@simple-agent-manager/shared';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { evaluateRunawayCostCeiling } from '../scheduled/stuck-task-ceiling';
import { getSelectedAgentCredentialReference } from './agent-key-resolution';
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
  acknowledgeProviderLimitRecovery,
  confirmProviderLimitRecoveryRunner,
} from './provider-limit-force-resume';
import { repairProviderLimitIntents } from './provider-limit-parking';
import { presentBlockedProviderLimitWait } from './provider-limit-recovery';
import {
  loadProviderLimitRecoveryApproval,
  type ProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalD1Fence,
  providerLimitRecoveryApprovalIsCurrent,
} from './provider-limit-recovery-approval';
import { requireSessionWriter } from './session-access';
import {
  canRepairSessionRecoveryRunner,
  ensureSessionRecovery,
  startMissingSessionRecoveryRunner,
} from './session-recovery';
import { getTaskRunnerStatus, nudgeTaskRunnerDO } from './task-runner-do';

export function resolveProviderLimitRecoveryRpcTimeoutMs(env: Env): number {
  return parsePositiveInt(
    env.PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS,
    DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS
  );
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
  const recoveryProgress = await captureOwnerRecoveryProgress(env, task, approval?.snapshotId);
  let valid = pendingApprovalMatchesTask(task, wait, now);
  // Restore commits before the runner transitions the task to in_progress.
  // Preserve this bounded intent while that exact runner finishes; this read
  // neither acknowledges consent nor authorizes any new recovery side effect.
  if (valid && (await materializedOwnerRecoveryIsCurrent(env, task, receipt))) return;
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
    valid &&= await savedSessionAuthorityMatches(env, task, approval, task.chatSessionId);
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
      profileMatchesApproval(profile, profileId, approval) &&
      (await credentialLimitReferenceKey(reference)) === wait.credentialKey;
  }
  if (
    valid &&
    snapshot &&
    !(await pendingRecoveryScopeIsCurrent(env, task, wait, snapshot, receipt))
  )
    return;
  if (!valid || !snapshot || !task.chatSessionId) {
    await blockRevokedOwnerApproval(env, task, wait, receipt, recoveryProgress);
    return;
  }
  await dispatchOwnerApprovedRecovery(env, task, wait, snapshot, receipt, task.chatSessionId);
}

/** A materialized or completed restore still belongs to its exact live recovery attempt. */
async function materializedOwnerRecoveryIsCurrent(
  env: Env,
  task: schema.Task,
  receipt: string
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
       AND s.recovery_workspace_id=t.workspace_id
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
  return current?.valid === 1 && wait.deadlineAt > Date.now();
}

async function blockRevokedOwnerApproval(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  receipt: string,
  recoveryProgress: string | null
): Promise<void> {
  const reason = 'Blocked: the approved provider limit recovery expired or its authority changed.';
  const blocked = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',
         admission_reason=?,admission_next_retry_at=NULL
       WHERE id=? AND provider_limit_wait_json IS ? AND admission_state='provider_limit_recovery_pending'
         AND project_id=? AND user_id=? AND chat_session_id IS ?
         AND status IN ('sleeping','queued','delegated') AND status=? AND workspace_id IS ?
         AND agent_profile_hint IS ? AND skill_id IS ?
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
      wait.ownerOverride?.snapshotId ?? null,
      recoveryProgress
    )
    .run();
  if (!blocked.meta.changes) return;
  if (task.chatSessionId)
    await projectData
      .syncProviderLimitAttention(env, task.projectId, task.id, task.chatSessionId)
      .catch(() => undefined);
}

/** Retry only the approved task; an ambiguous response preserves its pending receipt. */
async function dispatchOwnerApprovedRecovery(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  snapshot: SavedProviderLimitSnapshot,
  receipt: string,
  chatSessionId: string
): Promise<void> {
  const approval: ProviderLimitRecoveryApproval = {
    receipt,
    ownerUserId: task.userId,
    snapshotId: snapshot.id,
    expiresAt: wait.deadlineAt,
    sourceCredentialReference: snapshot.agent_credential_reference,
  };
  // The timeout bounds only this sweep's wait. The same durable approval guards
  // any late claim/start, while acknowledgement stays exclusively in this caller.
  const accepted = await withinRecoveryRpcBudget(env, async () => {
    if (snapshot.recovery_status === 'waking') {
      if (
        await nudgeTaskRunnerDO(
          env,
          task.id,
          'Retry owner-approved provider limit recovery',
          approval
        )
      )
        return snapshot.recovery_attempt_id;
      const status = await getTaskRunnerStatus(env, task.id);
      if (
        !snapshot.recovery_attempt_id ||
        !canRepairSessionRecoveryRunner(status, {
          taskId: task.id,
          projectId: task.projectId,
          userId: task.userId,
          chatSessionId,
          recoveryAttemptId: snapshot.recovery_attempt_id,
        })
      )
        return false;
      const result = await startMissingSessionRecoveryRunner(
        env,
        task.projectId,
        chatSessionId,
        {
          taskId: task.id,
          projectId: task.projectId,
          chatSessionId,
          requiredProjectMemberId: task.userId,
          providerLimitApproval: approval,
        },
        snapshot.recovery_attempt_id
      );
      return result.status === 'waking'
        ? confirmProviderLimitRecoveryRunner(env, task.id, task.projectId, chatSessionId, approval)
        : null;
    }
    const result = await ensureSessionRecovery(env, task.projectId, chatSessionId, {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId,
      requiredProjectMemberId: task.userId,
      providerLimitApproval: approval,
    });
    return result.status === 'waking'
      ? confirmProviderLimitRecoveryRunner(env, task.id, task.projectId, chatSessionId, approval)
      : null;
  });
  if (
    !accepted ||
    !(await providerLimitRecoveryApprovalIsCurrent(env, task.id, task.projectId, approval))
  )
    return;
  await acknowledgeProviderLimitRecovery(env, task.id, receipt, false, accepted);
}

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
    approval.agentType &&
    approval.expiresAt === wait.deadlineAt &&
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
    (profile === null || profile.agentType === approval?.agentType)
  );
}

/** Timing out neither releases a claim nor revokes the owner's durable consent. */
async function withinRecoveryRpcBudget<T>(
  env: Env,
  operation: () => Promise<T>
): Promise<T | false> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), resolveProviderLimitRecoveryRpcTimeoutMs(env));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
