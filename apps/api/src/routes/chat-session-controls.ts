/**
 * Session-scoped lifecycle controls for the project chat (rule 26: session routes first).
 *
 * POST /api/projects/:projectId/sessions/:sessionId/sleep
 * POST /api/projects/:projectId/sessions/:sessionId/agent-sessions/:agentSessionId/resume
 *
 * The workspace routes these mirror (`/api/workspaces/:id/sleep`, `.../resume`) are reachable
 * only by the workspace owner. These authorize a session writer — the owner or an active
 * grantee — and then act on the session owner's workspace through the same services, so a
 * grantee's id never selects a workspace, node or agent session.
 */
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { requireSessionWriter } from '../services/session-access';
import { isSafeSleepDeferral, sleepWorkspaceSession } from '../services/session-sleep';
import { resolveLiveWorkspaceForSession } from './chat-workspace-resolver';
import { resumeOwnedAgentSession } from './workspaces/agent-session-suspend-resume';

export function registerChatSessionControlRoutes(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.post('/:sessionId/sleep', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    const writer = await requireSessionWriter(c.env, projectId, sessionId, userId, {
      db,
      action: 'put this session to sleep',
    });
    const workspace = await resolveLiveWorkspaceForSession(db, {
      projectId,
      sessionId,
      userId: writer.ownerUserId,
    });
    if (!workspace) throw errors.notFound('No active workspace found for this session');

    const result = await sleepWorkspaceSession(c.env, {
      workspaceId: workspace.id,
      userId: writer.ownerUserId,
      reason:
        writer.role === 'grantee'
          ? 'Explicit session sleep by a shared-access member'
          : 'Explicit session sleep API request',
    }).catch((error) => {
      if (isSafeSleepDeferral(error)) {
        throw errors.conflict(error.message);
      }
      throw error;
    });
    return c.json(result);
  });

  chatRoutes.post('/:sessionId/agent-sessions/:agentSessionId/resume', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const agentSessionId = requireRouteParam(c, 'agentSessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    const writer = await requireSessionWriter(c.env, projectId, sessionId, userId, {
      db,
      action: 'resume the agent in this session',
    });
    // The agent session must belong to the workspace bound to THIS chat session: a grant on
    // one session never reaches another session's agent.
    const workspace = await resolveLiveWorkspaceForSession(db, {
      projectId,
      sessionId,
      userId: writer.ownerUserId,
    });
    if (!workspace) throw errors.notFound('No active workspace found for this session');

    return c.json(
      await resumeOwnedAgentSession(c.env, db, {
        workspaceId: workspace.id,
        agentSessionId,
        ownerUserId: writer.ownerUserId,
      })
    );
  });
}
