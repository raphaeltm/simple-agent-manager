/**
 * Lightweight chat session state route.
 *
 * Mounted under /api/projects/:projectId/sessions before /:sessionId detail.
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import * as projectDataService from '../services/project-data';
import { getChatSessionRouteContext } from './chat-route-context';

const chatStateRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/projects/:projectId/sessions/:sessionId/state
 * Read the lightweight ACP activity snapshot for a chat session.
 */
chatStateRoutes.get('/:sessionId/state', async (c) => {
  const { projectId, sessionId } = await getChatSessionRouteContext(c);

  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Chat session');
  }

  let agentSessionId: string | null = null;
  let agentType: string | null = null;
  try {
    const acpSessions = await projectDataService.listAcpSessions(c.env, projectId, {
      chatSessionId: sessionId,
      limit: 1,
    });
    agentSessionId = acpSessions.sessions[0]?.id ?? null;
    agentType = acpSessions.sessions[0]?.agentType ?? null;
  } catch (err) {
    log.warn('chat.state_agent_session_lookup_failed', {
      projectId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let state = null;
  if (agentSessionId) {
    try {
      state = await projectDataService.getSessionState(c.env, projectId, agentSessionId);
    } catch (err) {
      log.warn('chat.state_snapshot_lookup_failed', {
        projectId,
        sessionId,
        agentSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({ state, agentSessionId, agentType });
});

export { chatStateRoutes };
