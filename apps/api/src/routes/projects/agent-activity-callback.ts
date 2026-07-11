import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { AcpSessionActivityReportSchema, jsonValidator } from '../../schemas';
import { verifyCallbackToken } from '../../services/jwt';
import { hibernateAgentSessionOnNode } from '../../services/node-agent';
import * as projectDataService from '../../services/project-data';
import { markVmAgentContainerActiveWorkEndedBestEffort } from '../../services/vm-agent-container';

/**
 * Agent activity callback route — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket requireAuth() middleware that validates browser session
 * cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 * Accepts workspace-scoped tokens (the VM agent's callback token).
 *
 * The VM agent calls this endpoint from session_host_reporting.go:reportActivity()
 * to signal "prompting" / "idle" transitions. The signal is ephemeral (no
 * persistence) — it broadcasts to DO WebSocket clients so the UI can show
 * real-time "Agent is working..." indicators.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const agentActivityCallbackRoute = new Hono<{ Bindings: Env }>();

agentActivityCallbackRoute.post(
  '/:id/acp-sessions/:sessionId/activity',
  jsonValidator(AcpSessionActivityReportSchema),
  async (c) => {
    // Verify callback JWT (not BetterAuth session cookie)
    const token = extractBearerToken(c.req.header('Authorization'));
    const payload = await verifyCallbackToken(token, c.env);

    if (payload.scope !== 'workspace' && payload.scope !== 'node') {
      log.error('acp_activity.invalid_token_scope', {
        scope: payload.scope,
        action: 'rejected',
      });
      throw errors.forbidden('Invalid token scope for activity report');
    }

    const projectId = c.req.param('id');
    const sessionId = c.req.param('sessionId');
    const body = c.req.valid('json');

    // Verify node matches assigned node
    const existing = await projectDataService.getAcpSession(c.env, projectId, sessionId);
    if (!existing) {
      throw errors.notFound('ACP session not found');
    }
    if (existing.nodeId !== body.nodeId) {
      log.error('acp_activity.node_mismatch', {
        sessionId,
        projectId,
        expectedNodeId: existing.nodeId,
        receivedNodeId: body.nodeId,
        action: 'rejected',
      });
      throw errors.forbidden('Node identity verification failed');
    }

    await projectDataService.reportAcpSessionActivity(c.env, projectId, sessionId, body.activity, {
      promptStartedAt: body.promptStartedAt,
      agentType: body.agentType,
      restartCount: body.restartCount,
      statusError: body.statusError,
    });
    if (body.activity === 'idle' || body.activity === 'error') {
      if (body.activity === 'idle' && existing.workspaceId && existing.nodeId && existing.acpSdkSessionId) {
        const db = drizzle(c.env.DATABASE, { schema });
        const workspace = await db
          .select({
            id: schema.workspaces.id,
            userId: schema.workspaces.userId,
            chatSessionId: schema.workspaces.chatSessionId,
            runtime: schema.nodes.runtime,
          })
          .from(schema.workspaces)
          .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
          .where(eq(schema.workspaces.id, existing.workspaceId))
          .get();
        if (workspace?.runtime === 'cf-container' && workspace.chatSessionId) {
          await hibernateAgentSessionOnNode(
            existing.nodeId,
            existing.workspaceId,
            existing.acpSdkSessionId,
            c.env,
            workspace.userId,
            {
              chatSessionId: workspace.chatSessionId,
              runtime: 'cf-container',
            }
          ).catch((err) => {
            log.warn('acp_activity.session_snapshot_failed', {
              projectId,
              sessionId,
              workspaceId: existing.workspaceId,
              nodeId: existing.nodeId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
      await markVmAgentContainerActiveWorkEndedBestEffort(
        c.env,
        existing.nodeId,
        `agent_activity_${body.activity}`
      );
    }
    return c.body(null, 204);
  },
);

export { agentActivityCallbackRoute };
