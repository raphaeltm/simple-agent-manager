/** Exact owner consent carried through the existing snapshot claim and runner. */
import { type SQL, sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import type { Env } from '../env';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { parseProviderLimitWait } from './provider-limit-policy';

export interface ProviderLimitRecoveryApproval {
  receipt: string;
  ownerUserId: string;
  snapshotId: string;
  expiresAt: number;
  sourceCredentialReference: string | null;
}

/** Alias is an internal SQL identifier, never caller input. Both claim and task
 * CAS use this same condition; a preflight read cannot authorize a later write. */
export function providerLimitRecoveryApprovalCondition(
  taskAlias: string,
  approval: ProviderLimitRecoveryApproval | null | undefined,
  allowCommittedRun = false,
  requireCommittedRun = false
): SQL | undefined {
  if (!approval) return undefined;
  const task = sql.raw(taskAlias);
  const committed = allowCommittedRun
    ? sql`(${task}.status='in_progress' AND
      ROUND((julianday(${task}.started_at)-julianday('1970-01-01'))*86400000) >=
        json_extract(${approval.receipt},'$.ownerOverride.grantedAt')
      AND json_type(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt')='integer'
      AND json_type(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.credentialGeneration')='integer'
      AND json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.credentialGeneration')>0
      AND json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt') >=
        json_extract(${approval.receipt},'$.ownerOverride.grantedAt')
      AND json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.authorizedAt') < ${approval.expiresAt}
      AND EXISTS (SELECT 1 FROM workspaces committed_workspace JOIN agent_sessions committed_agent
        ON committed_agent.workspace_id=committed_workspace.id
        WHERE committed_workspace.id=${task}.workspace_id AND committed_workspace.user_id=${task}.user_id
          AND committed_workspace.project_id=${task}.project_id
          AND committed_workspace.status IN ('running','recovery')
          AND committed_workspace.chat_session_id=${task}.chat_session_id
          AND committed_agent.status IN ('running','recovery')
          AND committed_workspace.callback_generation IS json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.callbackGeneration')
          AND committed_workspace.id=json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.workspaceId')
          AND committed_agent.id=json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.agentSessionId')
          AND committed_agent.user_id=${task}.user_id
          AND committed_agent.agent_credential_reference IS ${approval.sourceCredentialReference}
          AND committed_agent.agent_credential_generation >= json_extract(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection.credentialGeneration')
          AND committed_agent.agent_profile_id IS json_extract(${approval.receipt},'$.ownerOverride.profileId')
          AND committed_agent.skill_id IS json_extract(${approval.receipt},'$.ownerOverride.skillId')
          AND committed_agent.agent_type=json_extract(${approval.receipt},'$.ownerOverride.agentType')))`
    : sql`0`;
  const source = sql`EXISTS (SELECT 1 FROM session_snapshots approved_snapshot JOIN agent_sessions approved_agent
      ON approved_agent.id=json_extract(${approval.receipt},'$.sourceAgentSessionId')
        AND approved_agent.workspace_id=approved_snapshot.workspace_id
        AND approved_agent.user_id=approved_snapshot.user_id
      WHERE approved_snapshot.id=${approval.snapshotId}
        AND approved_snapshot.project_id=${task}.project_id
        AND approved_snapshot.chat_session_id=${task}.chat_session_id
        AND approved_snapshot.user_id=${task}.user_id
        AND approved_agent.agent_credential_reference IS ${approval.sourceCredentialReference}
        AND approved_agent.agent_credential_generation=json_extract(${approval.receipt},'$.sourceCredentialGeneration')
        AND approved_agent.agent_profile_id IS json_extract(${approval.receipt},'$.ownerOverride.profileId')
        AND approved_agent.agent_type=json_extract(${approval.receipt},'$.ownerOverride.agentType'))`;
  const progress = requireCommittedRun
    ? committed
    : sql`((${approval.expiresAt} >
    (julianday('now')-julianday('1970-01-01'))*86400000 AND ${source}) OR ${committed})`;
  return sql`${task}.user_id=${approval.ownerUserId}
    AND ${task}.status NOT IN ('completed','failed','cancelled')
    AND json_valid(${task}.provider_limit_wait_json)
    AND json_remove(${task}.provider_limit_wait_json,'$.ownerOverride.firstInjection')=
        json_remove(${approval.receipt},'$.ownerOverride.firstInjection')
    AND ${task}.agent_profile_hint IS json_extract(${approval.receipt},'$.ownerOverride.profileId')
    AND ${task}.skill_id IS json_extract(${approval.receipt},'$.ownerOverride.skillId')
    AND (json_extract(${approval.receipt},'$.ownerOverride.profileId') IS NULL OR
      EXISTS (SELECT 1 FROM agent_profiles approved_profile
        WHERE approved_profile.id=json_extract(${approval.receipt},'$.ownerOverride.profileId')
          AND (approved_profile.project_id=${task}.project_id OR
            (approved_profile.project_id IS NULL AND approved_profile.user_id=${task}.user_id))
          AND COALESCE((SELECT approved_skill.agent_type FROM skills approved_skill
            WHERE approved_skill.id=${task}.skill_id AND approved_skill.project_id=${task}.project_id),
            approved_profile.agent_type)=json_extract(${approval.receipt},'$.ownerOverride.agentType')))
    AND ${progress}
    AND EXISTS (SELECT 1 FROM project_members approved_member JOIN users approved_user ON approved_user.id=approved_member.user_id
      WHERE approved_member.project_id=${task}.project_id AND approved_member.user_id=${task}.user_id
        AND approved_member.status='active' AND approved_member.role IN ('owner','admin','maintainer')
        AND approved_user.status='active')`;
}

export function providerLimitRecoveryApprovalD1Fence(
  taskAlias: string,
  approval: ProviderLimitRecoveryApproval | null | undefined,
  allowCommittedRun = false,
  requireCommittedRun = false
) {
  const condition = providerLimitRecoveryApprovalCondition(
    taskAlias,
    approval,
    allowCommittedRun,
    requireCommittedRun
  );
  if (!condition) return { sql: '', params: [] };
  const query = new SQLiteSyncDialect().sqlToQuery(condition);
  return { sql: `AND (${query.sql})`, params: query.params };
}

export async function providerLimitRecoveryApprovalIsCurrent(
  env: Env,
  taskId: string,
  projectId: string,
  approval: ProviderLimitRecoveryApproval,
  allowCommittedRun = false
): Promise<boolean> {
  const fence = providerLimitRecoveryApprovalD1Fence('approved_task', approval, allowCommittedRun);
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS valid FROM tasks approved_task WHERE approved_task.id=? AND approved_task.project_id=? ${fence.sql}`
  )
    .bind(taskId, projectId, ...fence.params)
    .first();
  return row?.valid === 1;
}

/** A receipt may gain only the final-injection marker while an RPC ACK is lost. */
export async function loadProviderLimitRecoveryApproval(
  env: Env,
  taskId: string,
  receipt: string
): Promise<ProviderLimitRecoveryApproval | null> {
  const wait = parseProviderLimitWait(receipt);
  const approval = wait?.ownerOverride;
  if (!wait || !approval?.ownerUserId || !approval.snapshotId || approval.expiresAt === undefined)
    return null;
  const reference = await env.DATABASE.prepare(
    `SELECT agent_credential_reference AS reference FROM agent_sessions
     WHERE user_id=? AND id IN (?,(SELECT json_extract(provider_limit_wait_json,'$.ownerOverride.firstInjection.agentSessionId') FROM tasks WHERE id=?))
     ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`
  )
    .bind(
      approval.ownerUserId,
      wait.sourceAgentSessionId ?? null,
      taskId,
      wait.sourceAgentSessionId ?? null
    )
    .first();
  if (
    typeof reference?.reference !== 'string' ||
    (await credentialLimitReferenceKey(reference.reference)) !== wait.credentialKey
  )
    return null;
  return {
    receipt,
    ownerUserId: approval.ownerUserId,
    snapshotId: approval.snapshotId,
    expiresAt: approval.expiresAt,
    sourceCredentialReference: reference.reference,
  };
}
