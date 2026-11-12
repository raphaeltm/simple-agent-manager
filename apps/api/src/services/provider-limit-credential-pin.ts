import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveSessionProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { parseProviderLimitWait } from './provider-limit-policy';
import {
  sameWorkspaceCallbackIdentity,
  type WorkspaceCallbackIdentitySnapshot,
} from './workspace-callback-identity';

/** Run at the existing attribution/injection choke point for every agent-key
 * response. It never chooses an alternate credential or changes authentication. */
export async function assertProviderLimitCredentialPin(
  env: Env,
  workspaceId: string,
  reference: string,
  expectedWorkspace?: WorkspaceCallbackIdentitySnapshot,
  requestedAgentType?: string
): Promise<void> {
  const key = await credentialLimitReferenceKey(reference);
  const tasks = await env.DATABASE.prepare(
    `SELECT t.id, t.admission_state, t.provider_limit_wait_json,t.agent_profile_hint,t.skill_id,
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
    const profile =
      approval?.expiresAt !== undefined
        ? await resolveSessionProfileCredentialContext(drizzle(env.DATABASE, { schema }), {
            workspaceId,
          })
        : null;
    const approvalInvalid =
      approval?.expiresAt !== undefined &&
      (approval.expiresAt <= Date.now() ||
        (requestedAgentType !== undefined && requestedAgentType !== approval.agentType) ||
        task.agent_profile_hint !== approval.profileId ||
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
