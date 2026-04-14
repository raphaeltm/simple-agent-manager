import { Hono } from 'hono';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { AcpSessionHeartbeatSchema, jsonValidator } from '../../schemas';
import { verifyCallbackToken } from '../../services/jwt';
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

nodeAcpHeartbeatRoute.post('/:id/node-acp-heartbeat', jsonValidator(AcpSessionHeartbeatSchema), async (c) => {
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

  const updated = await projectDataService.updateNodeHeartbeats(c.env, projectId, body.nodeId);
  log.info('acp_heartbeat.node_level', { projectId, nodeId: body.nodeId, updatedSessions: updated });
  return c.body(null, 204);
});

export { nodeAcpHeartbeatRoute };
