import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { guardedChatInterrupt } from '../services/guarded-chat-interrupt';
import * as projectDataService from '../services/project-data';
import { requireSessionWriter } from '../services/session-access';
import { isSleepingContainerRuntime } from '../services/sleeping-container-runtime';
import { resolveLiveAgentSessionForChat } from './chat-workspace-resolver';

export async function interruptChat(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  expectedAgentSessionId?: string,
  expectedPromptStartedAt?: number
) {
  const db = drizzle(env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  const writer = await requireSessionWriter(env, projectId, sessionId, userId, {
    db,
    action: 'interrupt the agent in this session',
  });

  // Resolve the live workspace + running agent session, tenant-scoped and
  // fail-fast (see resolveLiveAgentSessionForChat). Resources belong to the
  // session owner; a grantee's own id never selects them.
  const { workspace, agentSession } = await resolveLiveAgentSessionForChat(db, {
    projectId,
    sessionId,
    userId: writer.ownerUserId,
  });

  if (expectedAgentSessionId && expectedAgentSessionId !== agentSession.id) {
    throw errors.conflict('Runtime changed; inspect status before interrupting');
  }
  if (expectedPromptStartedAt !== undefined) {
    const state = await projectDataService.getSessionState(env, projectId, agentSession.id);
    if (state?.promptStartedAt !== expectedPromptStartedAt) {
      throw errors.conflict('Prompt turn changed; inspect status before interrupting');
    }
  }

  // Capture the turn-end observation instant BEFORE the (slow) VM call, so a
  // prompt that starts while the cancel is in flight is never terminalized by
  // this cancel's own result (.claude/rules/49).
  const observedAt = Date.now();

  // Forward the cancel to the VM agent. A sleeping Instant runtime has no prompt in
  // flight, and forwarding would wake it, so answer as the agent's 409 would.
  const { cancelAgentSessionOnNode } = await import('../services/node-agent');
  const result = isSleepingContainerRuntime(workspace)
    ? { success: false, status: 409 }
    : expectedPromptStartedAt !== undefined
      ? await guardedChatInterrupt(
          env,
          workspace.nodeId,
          workspace.id,
          agentSession.id,
          writer.ownerUserId,
          expectedPromptStartedAt,
          async () => {
            await requireProjectCapability(db, projectId, userId, 'task:write');
            await requireSessionWriter(env, projectId, sessionId, userId, {
              db,
              action: 'interrupt this session',
            });
          }
        )
      : await cancelAgentSessionOnNode(
          workspace.nodeId,
          workspace.id,
          agentSession.id,
          env,
          writer.ownerUserId
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
    await projectDataService.recordSessionTurnEnd(env, projectId, agentSession.id, {
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

  return {
    status: result.success ? 'cancelled' : 'idle',
    message: result.success ? 'Prompt cancel signal sent' : 'No prompt in flight to cancel',
  };
}

export function registerChatCancelRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.post('/:sessionId/cancel', async (c) =>
    c.json(
      await interruptChat(
        c.env,
        getUserId(c),
        requireRouteParam(c, 'projectId'),
        requireRouteParam(c, 'sessionId')
      )
    )
  );
}
