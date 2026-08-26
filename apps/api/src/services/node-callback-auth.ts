import type { Context } from 'hono';

import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { AppError, errors } from '../middleware/error';
import { type CallbackTokenPayload, verifyCallbackToken } from './jwt';

/**
 * A callback token proves the identity carried in `payload.workspace` (a workspaceId for
 * scope='workspace', a nodeId for scope='node'). Endpoints that authorize node/session work MUST
 * check that bound identity against the resource the request targets — never a client-supplied body
 * field. These pure matchers are the building block for that binding. See .claude/rules/28 and
 * .claude/rules/34, and the correctly-scoped verifyNodeCallbackAuth / verifyWorkspaceCallbackAuth.
 */

/** True only when a node-scoped token is bound to exactly this node. */
export function callbackTokenMatchesNode(
  payload: CallbackTokenPayload,
  nodeId: string | null | undefined
): boolean {
  return payload.scope === 'node' && !!nodeId && payload.workspace === nodeId;
}

/** True only when a workspace-scoped token is bound to exactly this workspace. */
export function callbackTokenMatchesWorkspace(
  payload: CallbackTokenPayload,
  workspaceId: string | null | undefined
): boolean {
  return payload.scope === 'workspace' && !!workspaceId && payload.workspace === workspaceId;
}

/**
 * Node statuses for which a callback token must NOT be self-refreshed on heartbeat. A JWT is
 * stateless and self-renews forever via the heartbeat cycle, so once a node is deleted, destroyed,
 * stopping, or stopped we must stop honoring the refresh — otherwise a de-enrolled machine keeps a
 * live, auto-renewing credential until the platform separately checks node status.
 */
export const NODE_CALLBACK_TERMINAL_STATUSES = [
  'deleted',
  'destroyed',
  'destroying',
  'stopped',
  'stopping',
] as const;

const NODE_STATUSES_TERMINATING_CALLBACKS: ReadonlySet<string> = new Set(
  NODE_CALLBACK_TERMINAL_STATUSES
);

const NODE_STATUSES_BLOCKING_TOKEN_REFRESH = NODE_STATUSES_TERMINATING_CALLBACKS;

/** True when a node in this status must not have its callback token refreshed. */
export function nodeStatusBlocksTokenRefresh(status: string | null | undefined): boolean {
  return status != null && NODE_STATUSES_BLOCKING_TOKEN_REFRESH.has(status);
}

/** True when node callbacks should receive a terminal gone response and stop retrying. */
export function nodeStatusTerminatesCallbacks(status: string | null | undefined): boolean {
  return status != null && NODE_STATUSES_TERMINATING_CALLBACKS.has(status);
}

export async function verifyNodeCallbackAuth(
  c: Context<{ Bindings: Env }>,
  nodeId: string,
  options: { requireExplicitScope?: boolean } = {}
): Promise<void> {
  const token = extractBearerToken(c.req.header('Authorization'));
  let payload: CallbackTokenPayload;
  try {
    payload = options.requireExplicitScope
      ? await verifyCallbackToken(token, c.env, { expectedScope: 'node' })
      : await verifyCallbackToken(token, c.env);
  } catch (cause) {
    if (!options.requireExplicitScope) throw cause;
    if (!(cause instanceof AppError)) throw cause;
    const message = cause.message || 'Invalid callback token';
    if (cause.statusCode === 403 || message.includes('scope')) {
      throw errors.forbidden('Insufficient token scope');
    }
    if (cause.statusCode === 401) {
      throw errors.unauthorized('Invalid callback token');
    }
    throw cause;
  }

  if (options.requireExplicitScope && payload.scope !== 'node') {
    throw errors.forbidden('Insufficient token scope');
  }

  // Workspace-scoped tokens CANNOT be used for node-level endpoints.
  if (payload.scope === 'workspace') {
    log.warn('node_auth.rejected_workspace_scoped_token', {
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
