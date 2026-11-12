import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { resolveProviderLimitProfileId } from './provider-limit-approval-context';
import { parseProviderLimitWait, type ProviderLimitWait } from './provider-limit-policy';
import {
  sameWorkspaceCallbackIdentity,
  type WorkspaceCallbackIdentitySnapshot,
} from './workspace-callback-identity';
import { resolveWorkspaceRuntimeIds } from './workspace-runtime-assets';

type ProviderLimitPinTask = WorkspaceCallbackIdentitySnapshot & {
  id: string | null;
  taskStatus: string | null;
  taskStartedAt: string | null;
  agent_profile_hint: string | null;
  skill_id: string | null;
  admission_state: string | null;
  provider_limit_wait_json: string | null;
};

type ProviderLimitPinRequest = {
  workspaceId: string;
  key: string | null;
  requestedAgentType?: string;
  requestedAgentSessionId?: string | null;
};

/** Run at the existing attribution/injection choke point for every agent-key
 * response. It never chooses an alternate credential or changes authentication. */
export async function assertProviderLimitCredentialPin(
  env: Env,
  workspaceId: string,
  reference: string,
  expectedWorkspace?: WorkspaceCallbackIdentitySnapshot,
  requestedAgentType?: string,
  requestedAgentSessionId?: string | null
): Promise<void> {
  const key = await credentialLimitReferenceKey(reference);
  const tasks = await env.DATABASE.prepare(
    `SELECT t.id, t.admission_state, t.provider_limit_wait_json,t.agent_profile_hint,t.skill_id,
      t.status AS taskStatus, t.started_at AS taskStartedAt,
      w.id AS workspaceId, w.user_id AS userId, w.project_id AS projectId,
      w.chat_session_id AS chatSessionId, w.status, w.node_id AS nodeId, n.status AS nodeStatus,
      w.callback_generation AS callbackGeneration
      FROM workspaces w LEFT JOIN nodes n ON n.id = w.node_id
      LEFT JOIN tasks t ON t.workspace_id = w.id AND t.status IN ('queued','delegated','in_progress','sleeping')
        AND (t.provider_limit_wait_json IS NOT NULL OR t.admission_state LIKE 'provider_limit_%')
      WHERE w.id = ?`
  )
    .bind(workspaceId)
    .all<ProviderLimitPinTask>();
  if (
    expectedWorkspace &&
    (!tasks.results[0] || !sameWorkspaceCallbackIdentity(tasks.results[0], expectedWorkspace))
  )
    throw errors.gone('Workspace callback identity changed; callback resource is gone');
  const request = { workspaceId, key, requestedAgentType, requestedAgentSessionId };
  // Preserve first-conflict ordering: later tasks must not mutate after a refusal.
  await tasks.results.reduce<Promise<void>>(
    (previous, task) => previous.then(() => assertTaskCredentialPin(env, task, request)),
    Promise.resolve()
  );
}

async function assertTaskCredentialPin(
  env: Env,
  task: ProviderLimitPinTask,
  { workspaceId, key, requestedAgentType, requestedAgentSessionId }: ProviderLimitPinRequest
): Promise<void> {
  if (!task.id) return;
  const wait = parseProviderLimitWait(task.provider_limit_wait_json);
  if (!task.provider_limit_wait_json && !task.admission_state?.startsWith('provider_limit_'))
    return;
  const approval = wait?.ownerOverride;
  const db = drizzle(env.DATABASE, { schema });
  let taskProfileId: string | null | undefined = task.agent_profile_hint;
  if (approval?.expiresAt !== undefined) {
    taskProfileId = undefined;
    if (task.projectId) {
      taskProfileId = await resolveProviderLimitProfileId(db, env, {
        projectId: task.projectId,
        userId: task.userId,
        agentProfileHint: task.agent_profile_hint,
      });
    }
  }
  const runtime =
    approval?.expiresAt !== undefined
      ? await resolveWorkspaceRuntimeIds(db, {
          workspaceId,
          agentSessionId: requestedAgentSessionId,
        })
      : null;
  const runtimeProfileId = runtime?.workspace.projectId
    ? await resolveProviderLimitProfileId(db, env, {
        projectId: runtime.workspace.projectId,
        userId: runtime.workspace.userId,
        agentProfileHint: runtime.profileId,
      })
    : null;
  const profile = runtime
    ? await resolveProfileCredentialContext(db, {
        userId: runtime.workspace.userId,
        projectId: runtime.workspace.projectId,
        profileId: runtimeProfileId,
        skillId: runtime.skillId,
      })
    : null;
  const approvalInvalid = isScopedApprovalInvalid(
    task,
    approval,
    {
      taskProfileId,
      runtimeProfileId,
      runtimeSkillId: runtime?.skillId,
      profile,
      requestedAgentType,
    },
    Date.now()
  );
  if (
    wait?.credentialKey &&
    key === wait.credentialKey &&
    wait.phase !== 'blocked' &&
    !approvalInvalid
  )
    return;
  let reason = 'Blocked: provider recovery credential pin is unavailable; review before resuming.';
  if (wait?.phase === 'blocked') reason = wait.reason;
  else if (wait?.credentialKey)
    reason = 'Blocked: selected provider credential changed; review before resuming.';
  await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = 'provider_limit_blocked', admission_reason = ?, admission_next_retry_at = NULL
    WHERE id = ? AND workspace_id = ? AND status IN ('queued','delegated','in_progress','sleeping') AND provider_limit_wait_json IS ?`
  )
    .bind(
      wait
        ? JSON.stringify({ ...wait, phase: 'blocked', reason, ownerOverride: undefined })
        : task.provider_limit_wait_json,
      reason,
      task.id,
      workspaceId,
      task.provider_limit_wait_json
    )
    .run();
  throw errors.conflict('Provider limit recovery requires review; task blocked');
}

/** Approval expiry bounds handoff; every selected-scope fence still applies to refreshes. */
function isScopedApprovalInvalid(
  task: ProviderLimitPinTask,
  approval: ProviderLimitWait['ownerOverride'],
  {
    taskProfileId,
    runtimeProfileId,
    runtimeSkillId,
    profile,
    requestedAgentType,
  }: {
    taskProfileId: string | null | undefined;
    runtimeProfileId: string | null | undefined;
    runtimeSkillId: string | null | undefined;
    profile: Awaited<ReturnType<typeof resolveProfileCredentialContext>>;
    requestedAgentType?: string;
  },
  now: number
): boolean {
  // The deadline bounds starting recovery, not refreshing the same committed run.
  // A pre-sleep started_at or a bootstrap agent row cannot prove that handoff.
  const committedRun =
    task.taskStatus === 'in_progress' &&
    task.taskStartedAt !== null &&
    approval !== undefined &&
    Date.parse(task.taskStartedAt) >= approval.grantedAt;
  return (
    approval?.expiresAt !== undefined &&
    ((approval.expiresAt <= now && !committedRun) ||
      (requestedAgentType !== undefined && requestedAgentType !== approval.agentType) ||
      taskProfileId !== approval.profileId ||
      runtimeProfileId === undefined ||
      runtimeSkillId !== approval.skillId ||
      task.skill_id !== approval.skillId ||
      (profile?.profileId ?? null) !== approval.profileId ||
      (profile !== null && profile.agentType !== approval.agentType))
  );
}
