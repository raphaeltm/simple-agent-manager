/**
 * POST /api/workspaces/:id/mcp-token/rotate — VM agent callback.
 *
 * After a restart or rebuild hands the VM agent a new-generation callback token, the agent
 * exchanges each agent session's retired SAM MCP token here
 * (packages/vm-agent/internal/server). Auth is the workspace callback JWT in
 * `Authorization`, never a session cookie (.claude/rules/34); the retired MCP token is the
 * second proof, in the body. See `services/mcp-token-rotation.ts`.
 *
 * `workspacesRoutes` applies no session middleware, so this callback route is safe to mount
 * there next to the other workspace callbacks.
 */
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { errors } from '../../middleware/error';
import { rotateWorkspaceMcpToken } from '../../services/mcp-token-rotation';

/** Generated MCP tokens are 43 characters; the bound only stops oversized bodies. */
const MAX_MCP_TOKEN_LENGTH = 1024;

const RotationRequestSchema = v.object({
  mcpToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_MCP_TOKEN_LENGTH)),
});

const mcpTokenRotationRoutes = new Hono<{ Bindings: Env }>();

mcpTokenRotationRoutes.post('/:id/mcp-token/rotate', async (c) => {
  // A success response carries a credential; no intermediary may store any response.
  c.header('Cache-Control', 'no-store');
  const workspaceToken = extractBearerToken(c.req.header('Authorization'));

  // The body carries a credential, so validation failures must never echo it back.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw errors.badRequest('Invalid MCP token rotation request');
  }
  const parsed = v.safeParse(RotationRequestSchema, raw);
  if (!parsed.success) {
    throw errors.badRequest('Invalid MCP token rotation request');
  }

  return c.json(
    await rotateWorkspaceMcpToken(c.env, {
      workspaceId: c.req.param('id'),
      workspaceToken,
      mcpToken: parsed.output.mcpToken,
    })
  );
});

export { mcpTokenRotationRoutes };
