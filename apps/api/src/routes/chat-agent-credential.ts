import {
  type AgentCredentialScope,
  credentialIdFromReference,
  type SessionAgentCredentialResponse,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { getSession, listAcpSessions } from '../services/project-data';
import { getChatSessionRouteContext } from './chat-route-context';

/**
 * GET /:sessionId/agent-credential — which account the chat's agent ran on and which
 * tier chose it (profile pin, project pin, default, platform), as recorded by the
 * agent-key callback (`agent_sessions.agent_credential_*`). The live session is the
 * chat's own ACP session (`acp_sessions.chat_session_id`), never "latest in the
 * workspace". Account names are private: only the person who ran the session sees one.
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
    const runtime = acp.sessions[0];
    const empty: SessionAgentCredentialResponse = { credential: null };
    if (!runtime?.workspaceId) return c.json(empty);

    const [row] = await db
      .select({
        userId: schema.agentSessions.userId,
        agentType: schema.agentSessions.agentType,
        source: schema.agentSessions.agentCredentialSource,
        scope: schema.agentSessions.agentCredentialScope,
        reference: schema.agentSessions.agentCredentialReference,
      })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.id, runtime.id),
          eq(schema.agentSessions.workspaceId, runtime.workspaceId)
        )
      )
      .limit(1);
    if (!row?.reference) return c.json(empty);

    const isOwnSession = row.userId === userId;
    const credentialId = credentialIdFromReference(row.reference);
    let accountName: string | null = null;
    if (isOwnSession && credentialId) {
      const [credential] = await db
        .select({ name: schema.ccCredentials.name })
        .from(schema.ccCredentials)
        .where(
          and(eq(schema.ccCredentials.id, credentialId), eq(schema.ccCredentials.ownerId, userId))
        )
        .limit(1);
      accountName = credential?.name ?? null;
    }

    const response: SessionAgentCredentialResponse = {
      credential: {
        agentType: row.agentType,
        credentialSource: row.source ?? null,
        credentialScope: (row.scope as AgentCredentialScope | null) ?? null,
        accountName,
        isOwnSession,
      },
    };
    return c.json(response);
  });
}
