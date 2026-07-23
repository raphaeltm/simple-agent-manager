import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { AcpSessionHeartbeatSchema, jsonValidator } from '../../schemas';
import { verifyCallbackToken } from '../../services/jwt';
import { callbackTokenMatchesNode } from '../../services/node-callback-auth';
import * as projectDataService from '../../services/project-data';

/**
 * Node-level ACP heartbeat route — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket requireAuth() middleware that validates browser session
 * cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 * Accepts both workspace-scoped and node-scoped tokens because the VM agent's
 * token may be refreshed from workspace-scoped to node-scoped during the node
 * heartbeat response cycle.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
 */
const nodeAcpHeartbeatRoute = new Hono<{ Bindings: Env }>();

nodeAcpHeartbeatRoute.post(
  '/:id/node-acp-heartbeat',
  jsonValidator(AcpSessionHeartbeatSchema),
  async (c) => {
    // Verify callback JWT (not BetterAuth session cookie)
    const token = extractBearerToken(c.req.header('Authorization'));
    const payload = await verifyCallbackToken(token, c.env);

    // Accept both workspace-scoped and node-scoped tokens.
    // Workspace-scoped tokens are the initial token; node-scoped tokens are
    // issued during node heartbeat refresh. Both are valid for node-level
    // ACP heartbeat reporting. Legacy tokens without a scope claim are
    // intentionally rejected — all current VM agents include the scope claim.
    if (payload.scope !== 'workspace' && payload.scope !== 'node') {
      log.error('acp_heartbeat.invalid_token_scope', {
        scope: payload.scope,
        action: 'rejected',
      });
      throw errors.forbidden('Invalid token scope for ACP heartbeat');
    }

    const projectId = c.req.param('id');
    const body = c.req.valid('json');

    // Authoritative auth: bind the token's OWN identity to the node it claims to heartbeat, instead
    // of trusting the client-supplied body.nodeId. A node-scoped token (the steady state, after the
    // first heartbeat refresh) must equal body.nodeId — a pure check, no lookup. A workspace-scoped
    // token (the transient initial token) is accepted only if that workspace is actually assigned to
    // body.nodeId (single indexed PK lookup, hit only during the brief pre-refresh window). Without
    // this, a holder of any valid callback token could keep ANOTHER tenant's sessions alive by
    // supplying a guessed nodeId. See .claude/rules/28 and security-critique #1.
    if (!callbackTokenMatchesNode(payload, body.nodeId)) {
      let authorized = false;
      if (payload.scope === 'workspace') {
        const db = drizzle(c.env.DATABASE, { schema });
        const workspaceRow = await db
          .select({ nodeId: schema.workspaces.nodeId })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, payload.workspace))
          .get();
        authorized = !!workspaceRow && workspaceRow.nodeId === body.nodeId;
      }
      if (!authorized) {
        log.error('acp_heartbeat.callback_token_not_bound_to_node', {
          projectId,
          requestedNodeId: body.nodeId,
          scope: payload.scope,
          tokenIdentity: payload.workspace,
          action: 'rejected',
        });
        throw errors.forbidden('Callback token not authorized for this node');
      }
    }

    let updated: number;
    try {
      updated = await projectDataService.updateNodeHeartbeats(c.env, projectId, body.nodeId);
    } catch (error) {
      log.error('acp_heartbeat.update_failed', {
        projectId,
        nodeId: body.nodeId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    log.debug('acp_heartbeat.node_level', {
      projectId,
      nodeId: body.nodeId,
      updatedSessions: updated,
    });
    return c.body(null, 204);
  }
);

export { nodeAcpHeartbeatRoute };
