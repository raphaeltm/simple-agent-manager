import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { resolveProviderLimitProfileId } from './provider-limit-approval-context';
import { parseProviderLimitWait } from './provider-limit-policy';
import {
  sameWorkspaceCallbackIdentity,
  type WorkspaceCallbackIdentitySnapshot,
} from './workspace-callback-identity';
import { resolveWorkspaceRuntimeIds } from './workspace-runtime-assets';

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
    .all<
      WorkspaceCallbackIdentitySnapshot & {
        id: string | null;
        taskStatus: string | null;
        taskStartedAt: string | null;
        agent_profile_hint: string | null;
        skill_id: string | null;
        admission_state: string | null;
        provider_limit_wait_json: string | null;
      }
    >();
  if (
    expectedWorkspace &&
    (!tasks.results[0] || !sameWorkspaceCallbackIdentity(tasks.results[0], expectedWorkspace))
  )
    throw errors.gone('Workspace callback identity changed; callback resource is gone');
  for (const task of tasks.results) {
    if (!task.id) continue;
    const wait = parseProviderLimitWait(task.provider_limit_wait_json);
    if (
      !task ||
      (!task.provider_limit_wait_json && !task.admission_state?.startsWith('provider_limit_'))
    )
      continue;
    const approval = wait?.ownerOverride;
    const db = drizzle(env.DATABASE, { schema });
    const taskProfileId =
      approval?.expiresAt !== undefined
        ? task.projectId
          ? await resolveProviderLimitProfileId(db, env, {
              projectId: task.projectId,
              userId: task.userId,
              agentProfileHint: task.agent_profile_hint,
            })
          : undefined
        : task.agent_profile_hint;
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
    // The deadline bounds starting recovery, not refreshing the same committed run.
    // A pre-sleep started_at or a bootstrap agent row cannot prove that handoff.
    const committedRun =
      task.taskStatus === 'in_progress' &&
      task.taskStartedAt !== null &&
      approval !== undefined &&
      Date.parse(task.taskStartedAt) >= approval.grantedAt;
    const approvalInvalid =
      approval?.expiresAt !== undefined &&
      ((approval.expiresAt <= Date.now() && !committedRun) ||
        (requestedAgentType !== undefined && requestedAgentType !== approval.agentType) ||
        taskProfileId !== approval.profileId ||
        runtimeProfileId === undefined ||
        runtime?.skillId !== approval.skillId ||
        task.skill_id !== approval.skillId ||
        (profile?.profileId ?? null) !== approval.profileId ||
        (profile !== null && profile.agentType !== approval.agentType));
    if (
      wait?.credentialKey &&
      key === wait.credentialKey &&
      wait.phase !== 'blocked' &&
      !approvalInvalid
    )
      continue;
    const reason =
      wait?.phase === 'blocked'
        ? wait.reason
        : wait?.credentialKey
          ? 'Blocked: selected provider credential changed; review before resuming.'
          : 'Blocked: provider recovery credential pin is unavailable; review before resuming.';
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
}
