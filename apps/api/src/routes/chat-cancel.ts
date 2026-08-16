import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';
import { requireSessionCreator } from './chat-session-ownership';
import { resolveLiveAgentSessionForChat } from './chat-workspace-resolver';

export function registerChatCancelRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  /**
   * POST /api/projects/:projectId/sessions/:sessionId/cancel
   * Cancel the current in-flight prompt on the running agent session.
   * Sends a cancel signal to the VM agent which interrupts the agent
   * without tearing down the session — the user can send a follow-up.
   */
  chatRoutes.post('/:sessionId/cancel', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await requireSessionCreator(c.env, projectId, sessionId, userId);

    // Resolve the live workspace + running agent session, tenant-scoped and
    // fail-fast (see resolveLiveAgentSessionForChat).
    const { workspace, agentSession } = await resolveLiveAgentSessionForChat(db, {
      projectId,
      sessionId,
      userId,
    });

    // Capture the turn-end observation instant BEFORE the (slow) VM call, so a
    // prompt that starts while the cancel is in flight is never terminalized by
    // this cancel's own result (.claude/rules/49).
    const observedAt = Date.now();

    // Forward the cancel to the VM agent
    const { cancelAgentSessionOnNode } = await import('../services/node-agent');
    const result = await cancelAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      c.env,
      userId
    );

    // 409 means no prompt in flight — not an error from the user's perspective
    if (!result.success && result.status !== 409) {
      throw errors.internal('Failed to cancel prompt on agent');
    }

    // A cancel/interrupt is a turn ending. Record the terminal transition from
    // the control-plane end rather than waiting for the VM's `idle` activity
    // report, which is exactly the report that goes missing on abnormal endings
    // and wedges the stop button, message delivery, and idle scheduling together.
    try {
      await projectDataService.recordSessionTurnEnd(c.env, projectId, agentSession.id, {
        reason: 'cancelled',
        observedAt,
      });
    } catch (err) {
      log.warn('chat.cancel_turn_end_record_failed', {
        projectId,
        sessionId,
        acpSessionId: agentSession.id,
        ...serializeError(err),
      });
    }

    return c.json({
      status: result.success ? 'cancelled' : 'idle',
      message: result.success ? 'Prompt cancel signal sent' : 'No prompt in flight to cancel',
    });
  });
}
