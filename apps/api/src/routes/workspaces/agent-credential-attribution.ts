/**
 * Records which agent credential a session runs on (`agent_sessions.agent_credential_*`),
 * written by the agent-key callback in `runtime.ts`. `credentialSource` is who owns the
 * credential; `credentialScope` is which resolution tier chose it, including a profile pin.
 */
import type { AgentCredentialScope, CredentialSource } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import type { ResolvedAgentKey } from '../../services/agent-key-resolution';
import { assertProviderLimitCredentialPin } from '../../services/provider-limit-credential-pin';
import {
  assertWorkspaceCallbackIdentityCurrent,
  type WorkspaceCallbackIdentitySnapshot,
} from './_helpers';

export type AgentCredentialAttribution = {
  credentialSource: CredentialSource;
  /** Which resolution tier chose the credential (`agent_sessions.agent_credential_scope`). */
  credentialScope: AgentCredentialScope;
  credentialReference: string;
  credentialProvider?: string | null;
  providerMode?: string | null;
};

type PersistedAgentCredentialAttribution = {
  agentSessionId: string;
  credentialGeneration: number;
};

export async function persistAgentCredentialAttribution(
  env: Env,
  workspace: WorkspaceCallbackIdentitySnapshot,
  input: {
    workspaceId: string;
    agentSessionId?: string | null;
    agentType: string;
    attribution: AgentCredentialAttribution;
  }
): Promise<PersistedAgentCredentialAttribution | null> {
  await assertWorkspaceCallbackIdentityCurrent(env, workspace, 'agent_key');
  if (input.attribution.credentialSource !== 'platform')
    await assertProviderLimitCredentialPin(
      env,
      input.workspaceId,
      input.attribution.credentialReference
    );

  const now = new Date().toISOString();
  if (input.agentSessionId) {
    const update = await env.DATABASE.prepare(
      `UPDATE agent_sessions
          SET agent_credential_source = ?,
              agent_credential_scope = ?,
              agent_credential_reference = ?,
              agent_credential_provider = ?,
              agent_provider_mode = ?,
              agent_credential_generation = agent_credential_generation + 1,
              updated_at = ?
        WHERE id = ?
          AND workspace_id = ?
          AND user_id = ?
          AND (agent_type IS NULL OR agent_type = ?)
      RETURNING id, agent_credential_generation AS credentialGeneration`
    )
      .bind(
        input.attribution.credentialSource,
        input.attribution.credentialScope,
        input.attribution.credentialReference,
        input.attribution.credentialProvider ?? null,
        input.attribution.providerMode ?? null,
        now,
        input.agentSessionId,
        input.workspaceId,
        workspace.userId,
        input.agentType
      )
      .first<PersistedAgentCredentialAttribution>();

    if (!update) {
      throw errors.forbidden('Agent session does not match workspace callback identity');
    }
    return update;
  }

  const target = await env.DATABASE.prepare(
    `SELECT id
       FROM agent_sessions
      WHERE workspace_id = ?
        AND user_id = ?
        AND status IN ('running', 'recovery')
        AND (agent_type IS NULL OR agent_type = ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`
  )
    .bind(input.workspaceId, workspace.userId, input.agentType)
    .first<{ id: string }>();

  if (!target) {
    log.warn('agent_key.credential_attribution_session_missing', {
      workspaceId: input.workspaceId,
      userId: workspace.userId,
      agentType: input.agentType,
    });
    return null;
  }

  const update = await env.DATABASE.prepare(
    `UPDATE agent_sessions
        SET agent_credential_source = ?,
            agent_credential_scope = ?,
            agent_credential_reference = ?,
            agent_credential_provider = ?,
            agent_provider_mode = ?,
            agent_credential_generation = agent_credential_generation + 1,
            updated_at = ?
      WHERE id = ?
      RETURNING id, agent_credential_generation AS credentialGeneration`
  )
    .bind(
      input.attribution.credentialSource,
      input.attribution.credentialScope,
      input.attribution.credentialReference,
      input.attribution.credentialProvider ?? null,
      input.attribution.providerMode ?? null,
      now,
      target.id
    )
    .first<PersistedAgentCredentialAttribution>();
  return update;
}

export function credentialAttributionFromData(
  credentialData: ResolvedAgentKey,
  agentType: string,
  providerMode: string
): AgentCredentialAttribution {
  return {
    credentialSource: credentialData.credentialSource,
    credentialScope: credentialData.credentialScope,
    credentialReference: credentialData.credentialReference,
    credentialProvider:
      credentialData.credentialProvider ?? agentCredentialProviderFallback(agentType),
    providerMode,
  };
}

export function agentCredentialProviderFallback(agentType: string): string {
  if (agentType === 'claude-code' || agentType.includes('claude')) return 'anthropic';
  if (agentType === 'openai-codex' || agentType.includes('codex') || agentType.includes('openai')) {
    return 'openai';
  }
  return agentType;
}

export function platformProxyAttribution(agentType: string): AgentCredentialAttribution {
  const credentialProvider = agentType === 'claude-code' ? 'anthropic' : 'openai';
  return {
    credentialSource: 'platform',
    credentialScope: 'platform',
    credentialReference: `platform_proxy:${credentialProvider}`,
    credentialProvider,
    providerMode: 'sam-proxy',
  };
}
