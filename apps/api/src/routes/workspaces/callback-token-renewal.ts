/**
 * POST /api/workspaces/:id/callback-token/renew — VM agent callback.
 *
 * The VM agent calls this (packages/vm-agent/internal/server/workspace_callback_token_renewal.go)
 * before a workspace callback token expires, so a workspace that stays awake longer than
 * CALLBACK_TOKEN_EXPIRY_MS keeps working. Auth is two callback JWTs, never a session cookie
 * (.claude/rules/34): the workspace's current token in `Authorization`, and the hosting
 * node's id and node token in the JSON body. See
 * `services/workspace-callback-token-renewal.ts` for the binding rules.
 *
 * `workspacesRoutes` applies no session middleware, so this callback route is safe to
 * mount there next to the other workspace callbacks (`/:id/messages`, `/:id/git-token`).
 */
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { errors } from '../../middleware/error';
import { renewWorkspaceCallbackToken } from '../../services/workspace-callback-token-renewal';

const MAX_NODE_ID_LENGTH = 128;
const MAX_NODE_TOKEN_LENGTH = 16 * 1024;

const RenewalRequestSchema = v.object({
  nodeId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_NODE_ID_LENGTH)),
  nodeToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_NODE_TOKEN_LENGTH)),
});

const callbackTokenRenewalRoutes = new Hono<{ Bindings: Env }>();

callbackTokenRenewalRoutes.post('/:id/callback-token/renew', async (c) => {
  const workspaceId = c.req.param('id');
  const workspaceToken = extractBearerToken(c.req.header('Authorization'));

  // The body carries a credential, so validation failures must never echo it back
  // (jsonValidator interpolates offending values into its 400 message).
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw errors.badRequest('Invalid callback token renewal request');
  }
  const parsed = v.safeParse(RenewalRequestSchema, raw);
  if (!parsed.success) {
    throw errors.badRequest('Invalid callback token renewal request');
  }

  const result = await renewWorkspaceCallbackToken(c.env, {
    workspaceId,
    workspaceToken,
    nodeId: parsed.output.nodeId,
    nodeToken: parsed.output.nodeToken,
  });
  // The response can carry a credential; no intermediary may store it.
  c.header('Cache-Control', 'no-store');
  return c.json(result);
});

export { callbackTokenRenewalRoutes };
