import {
  parseProviderLimitWait,
  type ProviderLimitWait,
} from '@simple-agent-manager/scheduler-core';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { resolveProviderLimitProfileId } from './provider-limit-approval-context';
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
  reference: string;
  requestedAgentType?: string;
  requestedAgentSessionId?: string | null;
  finalInjection?: { credentialGeneration: number | undefined };
};

/** Run at the existing attribution/injection choke point for every agent-key
 * response. It never chooses an alternate credential or changes authentication. */
export async function assertProviderLimitCredentialPin(
  env: Env,
  workspaceId: string,
  reference: string,
  expectedWorkspace?: WorkspaceCallbackIdentitySnapshot,
  requestedAgentType?: string,
  requestedAgentSessionId?: string | null,
  finalInjection?: { credentialGeneration: number | undefined }
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
  const request = {
    workspaceId,
    key,
    reference,
    requestedAgentType,
    requestedAgentSessionId,
    finalInjection,
  };
  // Preserve first-conflict ordering: later tasks must not mutate after a refusal.
  await tasks.results.reduce<Promise<void>>(
    (previous, task) => previous.then(() => assertTaskCredentialPin(env, task, request)),
    Promise.resolve()
  );
}

async function assertTaskCredentialPin(
  env: Env,
  task: ProviderLimitPinTask,
  request: ProviderLimitPinRequest
): Promise<void> {
  const { workspaceId, key, requestedAgentType, requestedAgentSessionId } = request;
  if (!task.id) return;
  const wait = parseProviderLimitWait(task.provider_limit_wait_json);
  if (!task.provider_limit_wait_json && !task.admission_state?.startsWith('provider_limit_'))
    return;
  const approval = wait?.ownerOverride;
  const db = drizzle(env.DATABASE, { schema });
  const taskProfileId = await resolveTaskPinProfile(db, env, task, approval);
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
  const current =
    approval?.expiresAt !== undefined ? await readCurrentScopedPin(env, task, request) : null;
  let approvalInvalid = isScopedApprovalInvalid(
    task,
    approval,
    {
      taskProfileId,
      runtimeProfileId,
      runtimeSkillId: runtime?.skillId,
      profile,
      requestedAgentType,
      current,
      requestedAgentSessionId,
    },
    Date.now()
  );
  if (
    approval?.expiresAt !== undefined &&
    !approvalInvalid &&
    request.finalInjection &&
    wait?.credentialKey &&
    key === wait.credentialKey &&
    wait.phase !== 'blocked'
  ) {
    const authorization = await authorizeFinalInjection(env, task, wait, request);
    if (authorization === 'superseded')
      throw errors.conflict('Credential attribution was superseded; retry the current request');
    approvalInvalid = authorization !== 'authorized';
  }
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
    current,
    requestedAgentSessionId,
  }: {
    taskProfileId: string | null | undefined;
    runtimeProfileId: string | null | undefined;
    runtimeSkillId: string | null | undefined;
    profile: Awaited<ReturnType<typeof resolveProfileCredentialContext>>;
    requestedAgentType?: string;
    current: { credentialGeneration: number } | null;
    requestedAgentSessionId?: string | null;
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
    (!current ||
      (approval.expiresAt <= now &&
        !(
          committedRun &&
          hasPriorInjection(task, approval, requestedAgentSessionId, current.credentialGeneration)
        )) ||
      (requestedAgentType !== undefined && requestedAgentType !== approval.agentType) ||
      taskProfileId !== approval.profileId ||
      runtimeProfileId === undefined ||
      runtimeSkillId !== approval.skillId ||
      task.skill_id !== approval.skillId ||
      (profile?.profileId ?? null) !== approval.profileId ||
      (profile !== null && profile.agentType !== approval.agentType))
  );
}

/** The final scope is read after profile/skill resolution; membership is never cached. */
function scopedPinPredicate(task: ProviderLimitPinTask, request: ProviderLimitPinRequest) {
  return {
    sql: `FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
      JOIN agent_sessions a ON a.workspace_id=w.id AND a.user_id=w.user_id
      WHERE t.id=? AND t.provider_limit_wait_json IS ? AND t.status=? AND t.started_at IS ?
        AND t.agent_profile_hint IS ? AND t.skill_id IS ? AND t.admission_state IS ?
        AND t.user_id=w.user_id AND t.project_id=w.project_id
        AND w.id=? AND w.user_id=? AND w.project_id IS ? AND w.chat_session_id IS ?
        AND w.status=? AND w.node_id IS ? AND w.callback_generation IS ?
        AND (SELECT status FROM nodes WHERE id=w.node_id) IS ?
        AND (? IS NULL OR a.id=?) AND a.status IN ('running','recovery')
        AND a.agent_profile_id IS json_extract(t.provider_limit_wait_json,'$.ownerOverride.profileId')
        AND a.skill_id IS t.skill_id
        AND (json_extract(t.provider_limit_wait_json,'$.ownerOverride.profileId') IS NULL OR EXISTS (
          SELECT 1 FROM agent_profiles p
          WHERE p.id=json_extract(t.provider_limit_wait_json,'$.ownerOverride.profileId')
            AND (p.project_id=t.project_id OR (p.project_id IS NULL AND p.user_id=t.user_id))
            AND COALESCE((SELECT agent_type FROM skills WHERE id=t.skill_id AND project_id=t.project_id),p.agent_type)
              =json_extract(t.provider_limit_wait_json,'$.ownerOverride.agentType')))
        AND (a.agent_type IS NULL OR a.agent_type=json_extract(t.provider_limit_wait_json,'$.ownerOverride.agentType'))
        AND EXISTS (SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
          WHERE m.project_id=t.project_id AND m.user_id=t.user_id AND m.status='active'
            AND m.role IN ('owner','admin','maintainer') AND u.status='active')`,
    values: [
      task.id,
      task.provider_limit_wait_json,
      task.taskStatus,
      task.taskStartedAt,
      task.agent_profile_hint,
      task.skill_id,
      task.admission_state,
      task.workspaceId,
      task.userId,
      task.projectId,
      task.chatSessionId,
      task.status,
      task.nodeId,
      task.callbackGeneration,
      task.nodeStatus,
      request.requestedAgentSessionId ?? null,
      request.requestedAgentSessionId ?? null,
    ],
  };
}

async function readCurrentScopedPin(
  env: Env,
  task: ProviderLimitPinTask,
  request: ProviderLimitPinRequest
) {
  const scope = scopedPinPredicate(task, request);
  return env.DATABASE.prepare(
    `SELECT a.agent_credential_generation AS credentialGeneration ${scope.sql}
    ORDER BY a.updated_at DESC, a.created_at DESC LIMIT 1`
  )
    .bind(...scope.values)
    .first<{ credentialGeneration: number }>();
}

function hasPriorInjection(
  task: ProviderLimitPinTask,
  approval: NonNullable<ProviderLimitWait['ownerOverride']>,
  sessionId: string | null | undefined,
  generation: number
): boolean {
  const first = approval.firstInjection;
  return (
    first !== undefined &&
    approval.expiresAt !== undefined &&
    first.authorizedAt >= approval.grantedAt &&
    first.authorizedAt < approval.expiresAt &&
    first.workspaceId === task.workspaceId &&
    first.callbackGeneration === task.callbackGeneration &&
    first.agentSessionId === sessionId &&
    first.credentialGeneration <= generation
  );
}

// Shared atomic deadline/committed-run fence for release and supersession classification.
const FINAL_INJECTION_AUTHORITY_SQL = `AND (
        (ROUND((julianday('now')-2440587.5)*86400000)
          >=json_extract(t.provider_limit_wait_json,'$.ownerOverride.grantedAt')
          AND ROUND((julianday('now')-2440587.5)*86400000)
          <json_extract(t.provider_limit_wait_json,'$.ownerOverride.expiresAt'))
        OR (t.status='in_progress' AND julianday(t.started_at)>=julianday(
            json_extract(t.provider_limit_wait_json,'$.ownerOverride.grantedAt')/1000.0,'unixepoch')
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt')
            >=json_extract(t.provider_limit_wait_json,'$.ownerOverride.grantedAt')
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt')
            <json_extract(t.provider_limit_wait_json,'$.ownerOverride.expiresAt')
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.workspaceId')=w.id
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.callbackGeneration') IS w.callback_generation
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.agentSessionId')=a.id
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.credentialGeneration')
            <=a.agent_credential_generation)
      )`;

async function authorizeFinalInjection(
  env: Env,
  task: ProviderLimitPinTask,
  wait: ProviderLimitWait,
  request: ProviderLimitPinRequest
): Promise<'authorized' | 'superseded' | 'invalid'> {
  const approval = wait.ownerOverride;
  const generation = request.finalInjection?.credentialGeneration;
  if (
    !approval ||
    !request.requestedAgentSessionId ||
    !Number.isSafeInteger(generation) ||
    !generation ||
    generation < 1
  )
    return 'invalid';
  const now = Date.now();
  const expired = approval.expiresAt !== undefined && now >= approval.expiresAt;
  if (expired && !hasPriorInjection(task, approval, request.requestedAgentSessionId, generation))
    return 'invalid';
  if (now < approval.grantedAt) return 'invalid';
  const firstInjection = approval.firstInjection ?? {
    authorizedAt: now,
    workspaceId: task.workspaceId,
    callbackGeneration: task.callbackGeneration,
    agentSessionId: request.requestedAgentSessionId,
    credentialGeneration: generation,
  };
  // Exact receipt + current returned attribution generation: a lost CAS never releases a secret.
  const scope = scopedPinPredicate(task, request);
  const authorized = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json=?
    WHERE id=? AND EXISTS (SELECT 1 ${scope.sql}
      AND a.agent_credential_generation=? AND a.agent_credential_reference IS ?
      ${FINAL_INJECTION_AUTHORITY_SQL})`
  )
    .bind(
      JSON.stringify({ ...wait, ownerOverride: { ...approval, firstInjection } }),
      task.id,
      ...scope.values,
      generation,
      request.reference
    )
    .run();
  if (authorized.meta.changes === 1) return 'authorized';
  // A newer same-account attribution invalidates this response, not owner consent.
  const newer = await env.DATABASE.prepare(
    `SELECT 1 AS valid ${scope.sql}
    AND a.agent_credential_generation>? AND a.agent_credential_reference IS ?
    ${FINAL_INJECTION_AUTHORITY_SQL} LIMIT 1`
  )
    .bind(...scope.values, generation, request.reference)
    .first();
  return newer?.valid === 1 ? 'superseded' : 'invalid';
}

async function resolveTaskPinProfile(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  task: ProviderLimitPinTask,
  approval: ProviderLimitWait['ownerOverride']
): Promise<string | null | undefined> {
  if (approval?.expiresAt === undefined) return task.agent_profile_hint;
  if (!task.projectId) return undefined;
  return resolveProviderLimitProfileId(db, env, {
    projectId: task.projectId,
    userId: task.userId,
    agentProfileHint: task.agent_profile_hint,
  });
}
