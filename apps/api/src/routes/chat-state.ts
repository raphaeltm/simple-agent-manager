/**
 * Lightweight chat session state route.
 *
 * Mounted under /api/projects/:projectId/sessions before /:sessionId detail.
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import * as projectDataService from '../services/project-data';
import { resolveChatAgentState } from './chat-agent-state';
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

  const { agentSessionId, agentType, state } = await resolveChatAgentState(c.env, {
    projectId,
    sessionId,
    lookupFailureEvent: 'chat.state_agent_session_lookup_failed',
    stateFailureEvent: 'chat.state_snapshot_lookup_failed',
  });

  return c.json({ state, agentSessionId, agentType });
});

export { chatStateRoutes };
