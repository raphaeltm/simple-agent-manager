import {
  parseProviderLimitWait,
  type ProviderLimitWait,
} from '@simple-agent-manager/scheduler-core';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { resolveProfileCredentialContext } from './composable-credentials/profile-context';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { resolveProviderLimitProfileId } from './provider-limit-approval-context';
import {
  sameWorkspaceCallbackIdentity,
  type WorkspaceCallbackIdentitySnapshot,
} from './workspace-callback-identity';
import { resolveWorkspaceRuntimeIds } from './workspace-runtime-assets';

const nullableString = v.nullable(v.string());
const identityString = v.pipe(v.string(), v.minLength(1));
const ProviderLimitPinTaskSchema = v.pipe(
  v.object({
    id: v.nullable(identityString),
    taskStatus: nullableString,
    taskStartedAt: nullableString,
    agent_profile_hint: nullableString,
    agent_configuration_id: nullableString,
    skill_id: nullableString,
    admission_state: nullableString,
    provider_limit_wait_json: nullableString,
    workspaceId: identityString,
    userId: identityString,
    projectId: nullableString,
    chatSessionId: nullableString,
    status: v.string(),
    nodeId: nullableString,
    nodeStatus: nullableString,
    callbackGeneration: nullableString,
  }),
  // A missing joined task is legitimate only when every joined task field is NULL.
  v.check(
    (row) =>
      row.id !== null ||
      [
        row.taskStatus,
        row.taskStartedAt,
        row.agent_profile_hint,
        row.agent_configuration_id,
        row.skill_id,
        row.admission_state,
        row.provider_limit_wait_json,
      ].every((value) => value === null)
  )
);
type ProviderLimitPinTask = v.InferOutput<typeof ProviderLimitPinTaskSchema>;
const ScopedPinGenerationSchema = v.object({
  credentialGeneration: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER)
  ),
});

function pinStateUnavailable() {
  // Never expose validation issues: these rows can contain credential-adjacent state.
  return errors.conflict('Provider credential recovery state is unavailable; retry shortly');
}

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
    `SELECT t.id, t.admission_state, t.provider_limit_wait_json,t.agent_profile_hint,t.agent_configuration_id,t.skill_id,
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
    .all();
  const parsed = v.safeParse(v.array(ProviderLimitPinTaskSchema), tasks.results);
  // This is an authorization set, not a display list: skipping a bad row could omit a hold.
  if (!parsed.success) throw pinStateUnavailable();
  const rows = parsed.output;
  if (expectedWorkspace && (!rows[0] || !sameWorkspaceCallbackIdentity(rows[0], expectedWorkspace)))
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
  await rows.reduce<Promise<void>>(
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
  const refusal = (check: string, action: string) =>
    log.warn('provider_limit.credential_pin_refused', {
      taskId: task.id,
      workspaceId,
      projectId: task.projectId,
      sessionId: task.chatSessionId,
      requestedAgentSessionId,
      approvedAgentSessionId: approval?.firstInjection?.agentSessionId,
      requestedAgentType,
      approvedAgentType: approval?.agentType,
      check,
      action,
    });
  // A foreign callback cannot consume or revoke this run's owner consent.
  if (
    approval &&
    ((requestedAgentType !== undefined &&
      approval.agentType !== undefined &&
      requestedAgentType !== approval.agentType) ||
      (approval.firstInjection !== undefined &&
        requestedAgentSessionId !== approval.firstInjection.agentSessionId))
  ) {
    refusal('callback_identity_mismatch', 'request_refused');
    throw errors.conflict('Provider recovery approval belongs to a different agent callback');
  }
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
        runConfigurationId: task.agent_configuration_id,
      })
    : null;
  const current =
    approval?.expiresAt !== undefined ? await readCurrentScopedPin(env, task, request) : null;
  let invalidCheck = scopedApprovalFailure(
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
    !invalidCheck &&
    request.finalInjection &&
    wait?.credentialKey &&
    key === wait.credentialKey &&
    wait.phase !== 'blocked'
  ) {
    const authorization = await authorizeFinalInjection(env, task, wait, request);
    if (authorization === 'superseded') {
      refusal('attribution_superseded', 'request_refused');
      throw errors.conflict('Credential attribution was superseded; retry the current request');
    }
    invalidCheck = authorization === 'authorized' ? null : 'final_injection_authority';
  }
  if (
    wait?.credentialKey &&
    key === wait.credentialKey &&
    wait.phase !== 'blocked' &&
    !invalidCheck
  )
    return;
  let reason = 'Blocked: provider recovery credential pin is unavailable; review before resuming.';
  if (wait?.phase === 'blocked') reason = wait.reason;
  else if (wait?.credentialKey)
    reason = 'Blocked: selected provider credential changed; review before resuming.';
  const blocked = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = 'provider_limit_blocked', admission_reason = ?, admission_next_retry_at = NULL
    WHERE id = ? AND workspace_id = ? AND status IS ? AND started_at IS ?
      AND status IN ('queued','delegated','in_progress','sleeping')
      AND admission_state IS ? AND provider_limit_wait_json IS ?`
  )
    .bind(
      wait
        ? JSON.stringify({ ...wait, phase: 'blocked', reason, ownerOverride: undefined })
        : task.provider_limit_wait_json,
      reason,
      task.id,
      workspaceId,
      task.taskStatus,
      task.taskStartedAt,
      task.admission_state,
      task.provider_limit_wait_json
    )
    .run();
  const didBlock = blocked.meta.changes === 1;
  refusal(
    invalidCheck ?? (wait?.phase === 'blocked' ? 'already_blocked' : 'credential_pin_mismatch'),
    didBlock ? 'blocked' : 'block_cas_lost'
  );
  throw errors.conflict(
    didBlock
      ? 'Provider limit recovery requires review; task blocked'
      : 'Provider recovery state changed; refresh before retrying'
  );
}

/** Approval expiry bounds handoff; every selected-scope fence still applies to refreshes. */
function scopedApprovalFailure(
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
): string | null {
  // The deadline bounds starting recovery, not refreshing the same committed run.
  // A pre-sleep started_at or a bootstrap agent row cannot prove that handoff.
  const committedRun =
    task.taskStatus === 'in_progress' &&
    task.taskStartedAt !== null &&
    approval !== undefined &&
    Date.parse(task.taskStartedAt) >= approval.grantedAt;
  if (!approval) return null;
  // Only the historical admission override (key + grant time) is unscoped.
  const scoped = Object.keys(approval).some(
    (field) => !['credentialKey', 'grantedAt'].includes(field)
  );
  if (!scoped) return null;
  if (approval.expiresAt === undefined) return 'missing_approval_expiry';
  if (!current) return 'current_scope_unavailable';
  if (
    approval.expiresAt <= now &&
    !(
      committedRun &&
      hasPriorInjection(task, approval, requestedAgentSessionId, current.credentialGeneration)
    )
  )
    return 'approval_expired_without_committed_injection';
  if (requestedAgentType !== undefined && requestedAgentType !== approval.agentType)
    return 'agent_type_mismatch';
  if (taskProfileId !== approval.profileId) return 'task_profile_mismatch';
  if (runtimeProfileId === undefined) return 'runtime_profile_unavailable';
  if (runtimeSkillId !== approval.skillId || task.skill_id !== approval.skillId)
    return 'skill_mismatch';
  if (task.agent_configuration_id !== (approval.runConfigurationId ?? null))
    return 'run_configuration_mismatch';
  if ((profile?.profileId ?? null) !== approval.profileId) return 'resolved_profile_mismatch';
  if (profile !== null && profile.agentType !== null && profile.agentType !== approval.agentType)
    return 'resolved_agent_type_mismatch';
  return null;
}

/** The final scope is read after profile/skill resolution; membership is never cached. */
function scopedPinPredicate(task: ProviderLimitPinTask, request: ProviderLimitPinRequest) {
  return {
    sql: `FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
      JOIN agent_sessions a ON a.workspace_id=w.id AND a.user_id=w.user_id
      WHERE t.id=? AND t.provider_limit_wait_json IS ? AND t.status=? AND t.started_at IS ?
        AND t.agent_profile_hint IS ? AND t.skill_id IS ? AND t.agent_configuration_id IS ? AND t.admission_state IS ?
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
      task.agent_configuration_id,
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
  const row = await env.DATABASE.prepare(
    `SELECT a.agent_credential_generation AS credentialGeneration ${scope.sql}
    ORDER BY a.updated_at DESC, a.created_at DESC LIMIT 1`
  )
    .bind(...scope.values)
    .first();
  if (row === null) return null;
  const parsed = v.safeParse(ScopedPinGenerationSchema, row);
  if (!parsed.success) throw pinStateUnavailable();
  return parsed.output;
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

// Shared atomic marker/deadline fence for release and supersession classification.
const FINAL_INJECTION_AUTHORITY_SQL = `AND (
        json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection') IS NULL OR (
          json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.workspaceId')=w.id
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.callbackGeneration') IS w.callback_generation
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.agentSessionId')=a.id
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.credentialGeneration')<=a.agent_credential_generation
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt')>=json_extract(t.provider_limit_wait_json,'$.ownerOverride.grantedAt')
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt')<json_extract(t.provider_limit_wait_json,'$.ownerOverride.expiresAt')))
      AND (
        (ROUND((julianday('now')-2440587.5)*86400000)
          >=json_extract(t.provider_limit_wait_json,'$.ownerOverride.grantedAt')
          AND ROUND((julianday('now')-2440587.5)*86400000)
          <json_extract(t.provider_limit_wait_json,'$.ownerOverride.expiresAt'))
        OR (t.status='in_progress' AND julianday(t.started_at)>=julianday(
            json_extract(t.provider_limit_wait_json,'$.ownerOverride.grantedAt')/1000.0,'unixepoch')
          AND json_extract(t.provider_limit_wait_json,'$.ownerOverride.firstInjection') IS NOT NULL)
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
    !task.provider_limit_wait_json ||
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
      // Preserve receipt field order; parsing the schema canonicalizes it differently.
      JSON.stringify({
        ...JSON.parse(task.provider_limit_wait_json),
        ownerOverride: {
          ...JSON.parse(task.provider_limit_wait_json).ownerOverride,
          firstInjection,
        },
      }),
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
