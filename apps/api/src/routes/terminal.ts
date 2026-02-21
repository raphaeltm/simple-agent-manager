import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import type { Env } from '../index';
import { requireAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { signTerminalToken } from '../services/jwt';
import * as schema from '../db/schema';
import type { TerminalTokenResponse } from '@simple-agent-manager/shared';

const terminalRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
terminalRoutes.use('*', requireAuth());

/**
 * POST /api/terminal/token - Generate a terminal access token for a workspace.
 * The token can be used to authenticate WebSocket connections to the VM agent.
 */
terminalRoutes.post('/token', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = await c.req.json<{ workspaceId: string }>();

  if (!body.workspaceId) {
    throw errors.badRequest('workspaceId is required');
  }

  // Verify the workspace exists and belongs to the user
  const workspace = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, body.workspaceId),
        eq(schema.workspaces.userId, userId)
      )
    )
    .limit(1);

  const ws = workspace[0];
  if (!ws) {
    throw errors.notFound('Workspace');
  }

  // Check workspace status
  if (ws.status !== 'running' && ws.status !== 'recovery') {
    throw errors.badRequest(`Workspace is not running or recovery (status: ${ws.status})`);
  }

  // Generate the terminal token
  const { token, expiresAt } = await signTerminalToken(userId, body.workspaceId, c.env);

  // Canonical workspace URL is derived from workspace ID and base domain.
  // In multi-workspace-per-node mode, routing no longer depends on vmIp in this record.
  const workspaceUrl = `https://ws-${ws.id}.${c.env.BASE_DOMAIN}`;

  const response: TerminalTokenResponse = {
    token,
    expiresAt,
    workspaceUrl,
  };

  return c.json(response);
});

export { terminalRoutes };
