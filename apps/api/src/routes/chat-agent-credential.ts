import {
  type AgentCredentialScope,
  credentialIdFromReference,
  type SessionAgentCredential,
  type SessionAgentCredentialResponse,
  type SessionAgentRuntimeConfig,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { errors } from '../middleware/error';
import { getSession, listAcpSessions } from '../services/project-data';
import { parseSessionRuntimeContract } from '../services/session-runtime-contract';
import { getChatSessionRouteContext } from './chat-route-context';

/**
 * GET /:sessionId/agent-credential — which account the chat's agent ran on and which
 * tier chose it (profile pin, project pin, default, platform), as recorded by the
 * agent-key callback (`agent_sessions.agent_credential_*`). The live session is the
 * chat's own ACP session (`acp_sessions.chat_session_id`), never "latest in the
 * workspace". Account names are private: only the person who ran the session sees one.
 * The tier (`credentialScope`) and owner kind (`credentialSource`) are deliberately
 * visible to every project member: the product owner wants members to see which
 * kind of account a run used (for debugging cost and readiness), never which one.
 *
 * The response also carries the session's effective configuration (model, effort,
 * permission mode, skill) from its frozen runtime contract, so a human can see exactly
 * what is running after profile, skill and default overrides were applied.
 */
export function registerChatAgentCredentialRoute(routes: Hono<{ Bindings: Env }>): void {
  routes.get('/:sessionId/agent-credential', async (c) => {
    const { db, projectId, sessionId, userId } = await getChatSessionRouteContext(c);
    c.header('Cache-Control', 'no-store');
    const [chat, acp] = await Promise.all([
      getSession(c.env, projectId, sessionId),
      listAcpSessions(c.env, projectId, { chatSessionId: sessionId, limit: 1 }),
    ]);
    if (!chat) throw errors.notFound('Chat session');
    const acpSession = acp.sessions[0];
    const empty: SessionAgentCredentialResponse = { credential: null, runtime: null };
    if (!acpSession?.workspaceId) return c.json(empty);

    const [row] = await db
      .select({
        userId: schema.agentSessions.userId,
        agentType: schema.agentSessions.agentType,
        source: schema.agentSessions.agentCredentialSource,
        scope: schema.agentSessions.agentCredentialScope,
        reference: schema.agentSessions.agentCredentialReference,
        runtimeContractJson: schema.agentSessions.runtimeContractJson,
        skillName: schema.skills.name,
        skillProjectId: schema.skills.projectId,
      })
      .from(schema.agentSessions)
      .leftJoin(schema.skills, eq(schema.skills.id, schema.agentSessions.skillId))
      .where(
        and(
          eq(schema.agentSessions.id, acpSession.id),
          eq(schema.agentSessions.workspaceId, acpSession.workspaceId)
        )
      )
      .limit(1);
    if (!row) return c.json(empty);

    const isOwnSession = row.userId === userId;
    let credential: SessionAgentCredential | null = null;
    if (row.reference) {
      const credentialId = credentialIdFromReference(row.reference);
      let accountName: string | null = null;
      if (isOwnSession && credentialId) {
        const [stored] = await db
          .select({ name: schema.ccCredentials.name })
          .from(schema.ccCredentials)
          .where(
            and(eq(schema.ccCredentials.id, credentialId), eq(schema.ccCredentials.ownerId, userId))
          )
          .limit(1);
        accountName = stored?.name ?? null;
      }
      credential = {
        agentType: row.agentType,
        credentialSource: row.source ?? null,
        credentialScope: (row.scope as AgentCredentialScope | null) ?? null,
        accountName,
        isOwnSession,
      };
    }

    // The skill's current name (a live join, not part of the frozen contract: a renamed skill
    // shows its new name, a deleted one none). A personal (non-project) skill's name is only
    // shown to the person who ran it.
    const skillName =
      row.skillName && (row.skillProjectId === projectId || isOwnSession) ? row.skillName : null;
    const response: SessionAgentCredentialResponse = {
      credential,
      runtime: readRuntimeConfig(row.runtimeContractJson, skillName, {
        projectId,
        sessionId,
        agentSessionId: acpSession.id,
      }),
    };
    return c.json(response);
  });
}

/** Malformed contracts are data, not a server fault: the panel just omits the row. */
function readRuntimeConfig(
  json: string | null,
  skillName: string | null,
  context: { projectId: string; sessionId: string; agentSessionId: string }
): SessionAgentRuntimeConfig | null {
  try {
    const contract = parseSessionRuntimeContract(json);
    if (!contract) return null;
    return {
      agentType: contract.agentType,
      model: contract.model,
      effort: contract.effort,
      permissionMode: contract.permissionMode,
      opencodeProvider: contract.opencodeProvider,
      skillName,
    };
  } catch (error) {
    log.warn('chat.session_runtime_contract_unreadable', {
      ...context,
      error: serializeError(error),
      action: 'omitted',
    });
    return null;
  }
}
