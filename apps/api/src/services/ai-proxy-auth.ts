/**
 * AI proxy auth: verify a workspace callback token, resolve the workspace, its
 * running agent session and trial, and record which credential served the call.
 * Re-exported from `ai-proxy-shared.ts`, so callers keep importing from there.
 */
import type { AgentCredentialScope } from '@simple-agent-manager/shared';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { verifyCallbackToken } from './jwt';
import type { PreloadedRuntimeRows } from './workspace-runtime-assets';

// =============================================================================
// Auth: Callback Token Verification + Workspace Resolution
// =============================================================================

export interface AIProxyAuthResult {
  workspaceId: string;
  userId: string;
  projectId: string | null;
  chatSessionId?: string | null;
  trialId?: string;
  agentType?: string | null;
  agentSessionId?: string | null;
  /**
   * The workspace and running-session rows auth loaded, handed to
   * `resolveSessionProfileCredentialContext` so the proxy picks the run's profile
   * exactly as the agent-key callback does, without reading them again.
   */
  runtimeRows: PreloadedRuntimeRows;
  agentCredentialReference?: string | null;
  agentCredentialSource?: 'user' | 'project' | 'platform' | null;
  agentCredentialProvider?: string | null;
  agentProviderMode?: string | null;
  agentCredentialGeneration: number;
}

export type AIProxyCredentialAttribution = {
  credentialReference: string;
  credentialSource: 'user' | 'project' | 'platform';
  /** Resolution tier that chose the credential; platform attributions imply 'platform'. */
  credentialScope?: AgentCredentialScope | null;
  credentialProvider?: string | null;
  providerMode?: string | null;
};

/**
 * Extract a callback token from either `Authorization: Bearer <token>` or
 * `x-api-key: <token>` headers. Returns null if neither is present.
 */
export function extractCallbackToken(
  authHeader: string | undefined,
  xApiKeyHeader: string | undefined
): string | null {
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (xApiKeyHeader) {
    return xApiKeyHeader;
  }
  return null;
}

/**
 * Verify a callback token and resolve the workspace → userId/projectId.
 * Rejects node-scoped tokens (only workspace-scoped tokens allowed).
 */
export async function verifyAIProxyAuth(
  token: string,
  env: Env,
  db: ReturnType<typeof drizzle>
): Promise<AIProxyAuthResult> {
  // Unified scope check — rejects non-workspace tokens via verifyCallbackToken (F-010)
  const tokenPayload = await verifyCallbackToken(token, env, { expectedScope: 'workspace' });

  const workspaceId = tokenPayload.workspace;

  const workspace = await db
    .select({
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      agentProfileHint: schema.workspaces.agentProfileHint,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();

  if (!workspace?.userId) {
    log.error('ai_proxy.workspace_not_found', { workspaceId });
    throw new AIProxyAuthError('Workspace not found', 404);
  }

  let agentType: string | null = null;
  if (workspace.agentProfileHint) {
    const profile = await db
      .select({ agentType: schema.agentProfiles.agentType })
      .from(schema.agentProfiles)
      .where(
        and(
          eq(schema.agentProfiles.id, workspace.agentProfileHint),
          eq(schema.agentProfiles.userId, workspace.userId),
          or(
            isNull(schema.agentProfiles.projectId),
            workspace.projectId
              ? eq(schema.agentProfiles.projectId, workspace.projectId)
              : isNull(schema.agentProfiles.projectId)
          )
        )
      )
      .get();
    agentType = profile?.agentType ?? null;
  }

  const agentSessionConditions = [
    eq(schema.agentSessions.workspaceId, workspaceId),
    eq(schema.agentSessions.userId, workspace.userId),
    inArray(schema.agentSessions.status, ['running', 'recovery']),
  ];
  if (agentType) agentSessionConditions.push(eq(schema.agentSessions.agentType, agentType));
  const agentSession = await db
    .select({
      id: schema.agentSessions.id,
      agentType: schema.agentSessions.agentType,
      agentProfileId: schema.agentSessions.agentProfileId,
      skillId: schema.agentSessions.skillId,
      agentCredentialReference: schema.agentSessions.agentCredentialReference,
      agentCredentialSource: schema.agentSessions.agentCredentialSource,
      agentCredentialProvider: schema.agentSessions.agentCredentialProvider,
      agentProviderMode: schema.agentSessions.agentProviderMode,
      agentCredentialGeneration: schema.agentSessions.agentCredentialGeneration,
    })
    .from(schema.agentSessions)
    .where(and(...agentSessionConditions))
    .orderBy(desc(schema.agentSessions.updatedAt), desc(schema.agentSessions.createdAt))
    .limit(1)
    .get();

  if (!agentType) agentType = agentSession?.agentType ?? null;

  // Check if this workspace belongs to a trial
  let trialId: string | undefined;
  if (workspace.projectId) {
    const trial = await db
      .select({ id: schema.trials.id })
      .from(schema.trials)
      .where(eq(schema.trials.projectId, workspace.projectId))
      .get();
    trialId = trial?.id;
  }

  return {
    workspaceId,
    userId: workspace.userId,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
    trialId,
    agentType,
    agentSessionId: agentSession?.id ?? null,
    runtimeRows: {
      workspace: {
        id: workspaceId,
        userId: workspace.userId,
        projectId: workspace.projectId,
        agentProfileHint: workspace.agentProfileHint,
      },
      agentSession: agentSession
        ? {
            id: agentSession.id,
            profileId: agentSession.agentProfileId,
            skillId: agentSession.skillId,
          }
        : null,
    },
    agentCredentialReference: agentSession?.agentCredentialReference ?? null,
    agentCredentialSource:
      agentSession?.agentCredentialSource === 'user' ||
      agentSession?.agentCredentialSource === 'project' ||
      agentSession?.agentCredentialSource === 'platform'
        ? agentSession.agentCredentialSource
        : null,
    agentCredentialProvider: agentSession?.agentCredentialProvider ?? null,
    agentProviderMode: agentSession?.agentProviderMode ?? null,
    agentCredentialGeneration: agentSession?.agentCredentialGeneration ?? 0,
  };
}

export async function updateAIProxyAgentCredentialAttribution(
  env: Env,
  auth: Pick<
    AIProxyAuthResult,
    'agentSessionId' | 'workspaceId' | 'userId' | 'agentType' | 'agentCredentialGeneration'
  >,
  attribution: AIProxyCredentialAttribution
): Promise<void> {
  if (!auth.agentSessionId) return;
  if (!Number.isInteger(auth.agentCredentialGeneration) || auth.agentCredentialGeneration < 0) {
    log.warn('ai_proxy.credential_attribution_update_skipped', {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      agentSessionId: auth.agentSessionId,
      agentType: auth.agentType ?? null,
      reason: 'missing_generation',
    });
    return;
  }
  const credentialScope =
    attribution.credentialScope ??
    (attribution.credentialSource === 'platform' ? 'platform' : null);
  const existing = await env.DATABASE.prepare(
    `SELECT agent_credential_source, agent_credential_scope, agent_credential_reference, agent_credential_provider,
            agent_provider_mode, agent_credential_generation
       FROM agent_sessions
      WHERE id = ?
        AND workspace_id = ?
        AND user_id = ?
        AND (agent_type IS NULL OR ? IS NULL OR agent_type = ?)
      LIMIT 1`
  )
    .bind(
      auth.agentSessionId,
      auth.workspaceId,
      auth.userId,
      auth.agentType ?? null,
      auth.agentType ?? null
    )
    .first<{
      agent_credential_source: string | null;
      agent_credential_scope: string | null;
      agent_credential_reference: string | null;
      agent_credential_provider: string | null;
      agent_provider_mode: string | null;
      agent_credential_generation: number;
    }>();
  if (
    existing &&
    existing.agent_credential_generation === auth.agentCredentialGeneration &&
    existing.agent_credential_source === attribution.credentialSource &&
    existing.agent_credential_scope === credentialScope &&
    existing.agent_credential_reference === attribution.credentialReference &&
    existing.agent_credential_provider === (attribution.credentialProvider ?? null) &&
    existing.agent_provider_mode === (attribution.providerMode ?? null)
  ) {
    return;
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
        AND workspace_id = ?
        AND user_id = ?
        AND (agent_type IS NULL OR ? IS NULL OR agent_type = ?)
        AND agent_credential_generation = ?`
  )
    .bind(
      attribution.credentialSource,
      credentialScope,
      attribution.credentialReference,
      attribution.credentialProvider ?? null,
      attribution.providerMode ?? null,
      new Date().toISOString(),
      auth.agentSessionId,
      auth.workspaceId,
      auth.userId,
      auth.agentType ?? null,
      auth.agentType ?? null,
      auth.agentCredentialGeneration
    )
    .run();

  if ((update.meta.changes ?? 0) !== 1) {
    log.warn('ai_proxy.credential_attribution_update_skipped', {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      agentSessionId: auth.agentSessionId,
      agentType: auth.agentType ?? null,
      expectedGeneration: auth.agentCredentialGeneration,
    });
  }
}

export class AIProxyAuthError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'AIProxyAuthError';
  }
}
