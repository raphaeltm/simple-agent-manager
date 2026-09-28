import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toAgentSessionResponse } from '../../lib/mappers';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { AppError, errors } from '../../middleware/error';
import { resumeAgentSessionOnNode, suspendAgentSessionOnNode } from '../../services/node-agent';
import { isSleepingContainerNode } from '../../services/sleeping-container-runtime';
import { resumeVmAgentContainer } from '../../services/vm-agent-container';
import { getOwnedNode, getOwnedNodeAgentSession } from './_helpers';

// Suspend and resume, split out of agent-sessions.ts (.claude/rules/18). Auth is applied
// per-route, as in agent-sessions.ts, so nothing leaks to routers sharing the base path.
const agentSessionSuspendResumeRoutes = new Hono<{ Bindings: Env }>();

agentSessionSuspendResumeRoutes.post(
  '/:id/agent-sessions/:sessionId/suspend',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    const { workspace, session } = await getOwnedNodeAgentSession(
      db,
      c.req.param('id'),
      c.req.param('sessionId'),
      userId
    );

    if (session.status !== 'running' && session.status !== 'error') {
      throw errors.badRequest(`Session cannot be suspended from status: ${session.status}`);
    }

    // A slept Instant runtime runs nothing to suspend, and the request would restore it first.
    if (!(await isSleepingContainerNode(db, workspace.nodeId))) {
      try {
        await suspendAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
      } catch (e) {
        log.warn('agent_session.suspend_on_node_failed', {
          sessionId: session.id,
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          error: String(e),
        });
      }
    }

    const now = new Date().toISOString();
    await db
      .update(schema.agentSessions)
      .set({
        status: 'suspended',
        suspendedAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.agentSessions.id, session.id));

    return c.json(
      toAgentSessionResponse({
        ...session,
        status: 'suspended',
        suspendedAt: now,
        errorMessage: null,
        updatedAt: now,
      })
    );
  }
);

agentSessionSuspendResumeRoutes.post(
  '/:id/agent-sessions/:sessionId/resume',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    const { workspace, session } = await getOwnedNodeAgentSession(
      db,
      c.req.param('id'),
      c.req.param('sessionId'),
      userId
    );

    const node = await getOwnedNode(db, workspace.nodeId, userId);
    // Intentional WIDE gate: recovery must fire whenever EITHER the node or the
    // session looks not-running in D1. These D1 prechecks can be stale — the
    // container may have already died and been marked 'recovery'/'error' — so a
    // narrower gate would let a dead-D1 precheck block the very recovery that
    // heals it. The Durable Object owns the live container generation and
    // reconciles D1 itself; over-triggering here is safe because the DO
    // fast-paths an already-running container. Do NOT narrow this gate without
    // re-checking the recovery contract.
    if (
      node.runtime === 'cf-container' &&
      (node.status !== 'running' || session.status !== 'running')
    ) {
      const recovery = await resumeVmAgentContainer(c.env, node.id, session.id);
      if (!recovery.ok) {
        if (!recovery.code || !recovery.message) {
          throw errors.internal('Instant session recovery failed.');
        }
        const statusCode =
          recovery.code === 'RUNTIME_STOPPED'
            ? 410
            : recovery.code === 'RUNTIME_RECOVERING'
              ? 503
              : 409;
        throw new AppError(statusCode, recovery.code, recovery.message);
      }

      // Recovery succeeded. The Durable Object (persistRuntimeRecovered) has
      // ALREADY reconciled the agent_sessions row in D1 for THIS request —
      // including error_message: when the interrupted prompt needs manual retry
      // it persists RUNTIME_REQUEST_INTERRUPTED_MESSAGE so reloads / other
      // devices see "your message needs manual retry". The local `session`
      // snapshot read before recovery is now stale. Re-fetch and return the
      // DO-reconciled row; do NOT fall through to the status rewrite below
      // (S4+CF3), which would clobber the DO-written status/error_message back
      // to running / null.
      const [recovered] = await db
        .select()
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, session.id))
        .limit(1);
      return c.json(
        toAgentSessionResponse(
          recovered ?? {
            ...session,
            status: 'running',
            stoppedAt: null,
            suspendedAt: null,
            errorMessage: null,
            updatedAt: new Date().toISOString(),
          }
        )
      );
    }

    // Non cf-container, or an already-running cf-container session: fall through
    // to the legacy/VM lifecycle rewrite below.

    // Already running -- idempotent
    if (session.status === 'running') {
      return c.json(toAgentSessionResponse(session));
    }

    // Resume is allowed from suspended, stopped, or error states.
    // For suspended sessions, also tell the VM agent to resume.
    if (session.status === 'suspended') {
      try {
        await resumeAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
      } catch (e) {
        log.warn('agent_session.resume_on_node_failed', {
          sessionId: session.id,
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          error: String(e),
        });
      }
    }

    const now = new Date().toISOString();
    await db
      .update(schema.agentSessions)
      .set({
        status: 'running',
        stoppedAt: null,
        suspendedAt: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.agentSessions.id, session.id));

    return c.json(
      toAgentSessionResponse({
        ...session,
        status: 'running',
        stoppedAt: null,
        suspendedAt: null,
        errorMessage: null,
        updatedAt: now,
      })
    );
  }
);

export { agentSessionSuspendResumeRoutes };
