import type { Context } from 'hono';

import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { verifyCallbackToken } from './jwt';

export async function verifyNodeCallbackAuth(
  c: Context<{ Bindings: Env }>,
  nodeId: string
): Promise<void> {
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  // Workspace-scoped tokens CANNOT be used for node-level endpoints.
  if (payload.scope === 'workspace') {
    log.error('node_auth.rejected_workspace_scoped_token', {
      tokenWorkspace: payload.workspace,
      nodeId,
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden('Insufficient token scope');
  }

  if (payload.workspace !== nodeId) {
    throw errors.unauthorized('Callback token does not match node');
  }
}
