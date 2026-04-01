import type { TerminalTokenResponse } from '@simple-agent-manager/shared';
import { and,eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { getUserId,requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator, TerminalRequestSchema } from '../schemas';
import { signTerminalToken } from '../services/jwt';
import * as projectDataService from '../services/project-data';

const terminalRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
terminalRoutes.use('*', requireAuth(), requireApproved());

/**
 * POST /api/terminal/token - Generate a terminal access token for a workspace.
 * The token can be used to authenticate WebSocket connections to the VM agent.
 */
terminalRoutes.post('/token', jsonValidator(TerminalRequestSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = c.req.valid('json');

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

  // Check workspace status — allow 'creating' so the UI can connect to
  // the boot-log WebSocket endpoint during workspace provisioning.
  if (ws.status !== 'running' && ws.status !== 'recovery' && ws.status !== 'creating') {
    throw errors.badRequest(`Workspace is not accessible (status: ${ws.status})`);
  }

  // Generate the terminal token
  const { token, expiresAt } = await signTerminalToken(userId, body.workspaceId, c.env);

  // Canonical workspace URL is derived from workspace ID and base domain.
  // In multi-workspace-per-node mode, routing no longer depends on vmIp in this record.
  const workspaceUrl = `https://ws-${ws.id}.${c.env.BASE_DOMAIN}`;

  // Record terminal activity for workspace idle detection
  if (ws.projectId) {
    c.executionCtx.waitUntil(
      projectDataService.updateTerminalActivity(
        c.env, ws.projectId, ws.id, ws.chatSessionId
      ).catch(() => {
        // Best-effort: don't block token generation
      })
    );
  }

  const response: TerminalTokenResponse = {
    token,
    expiresAt,
    workspaceUrl,
  };

  return c.json(response);
});

/**
 * POST /api/terminal/activity - Report terminal activity for idle detection.
 * Called periodically by the frontend while a terminal session is active.
 */
terminalRoutes.post('/activity', jsonValidator(TerminalRequestSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = c.req.valid('json');

  const workspace = await db
    .select({
      id: schema.workspaces.id,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
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

  if (ws.projectId) {
    await projectDataService.updateTerminalActivity(
      c.env, ws.projectId, ws.id, ws.chatSessionId
    );
  }

  return c.json({ ok: true });
});

export { terminalRoutes };
