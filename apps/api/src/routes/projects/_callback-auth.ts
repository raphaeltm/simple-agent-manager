import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { verifyCallbackToken } from '../../services/jwt';

/**
 * Verified result of the shared workspace-scoped publish callback auth preamble.
 */
export interface VerifiedWorkspacePublishCallback {
  projectId: string;
  workspaceId: string;
  userId: string;
  db: ReturnType<typeof drizzle<typeof schema>>;
}

/**
 * Shared auth preamble for VM-agent workspace-scoped publish callbacks
 * (compose-publish release ingestion, registry push-credential minting).
 *
 * Verifies the callback JWT (NOT a BetterAuth session cookie), rejects
 * non-workspace token scopes, resolves the workspace's owning project + user,
 * and verifies the workspace's project matches the `:id` route param so a
 * workspace token cannot act on another project. Throws an AppError (caught by
 * the global `app.onError`) on any failure.
 *
 * `logPrefix` namespaces the structured rejection events per route
 * (e.g. 'compose_publish_release', 'registry_push_cred').
 *
 * Kept in its own module (not `_helpers.ts`) so these lightweight callback
 * routes do not drag the GitHub OAuth/installation machinery into their module
 * graph.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
export async function verifyWorkspacePublishCallback(
  c: Context<{ Bindings: Env }>,
  logPrefix: string,
  scopeErrorMessage: string
): Promise<VerifiedWorkspacePublishCallback> {
  // Verify callback JWT (not BetterAuth session cookie)
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  if (payload.scope !== undefined && payload.scope !== 'workspace') {
    log.error(`${logPrefix}.invalid_token_scope`, {
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden(scopeErrorMessage);
  }

  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // The callback JWT carries only a workspaceId. Node-scoped heartbeat tokens
  // carry a node ID in the same claim, so they are rejected above before this
  // lookup. Resolve the owning project + user, then verify the workspace's
  // project matches the route param so a workspace token cannot act on another
  // project.
  const workspaceRows = await db
    .select({
      projectId: schema.workspaces.projectId,
      userId: schema.workspaces.userId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, payload.workspace))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace || !workspace.projectId) {
    log.error(`${logPrefix}.workspace_not_linked`, {
      workspaceId: payload.workspace,
      action: 'rejected',
    });
    throw errors.forbidden('Workspace is not linked to a project');
  }

  if (workspace.projectId !== projectId) {
    log.error(`${logPrefix}.project_mismatch`, {
      workspaceId: payload.workspace,
      expectedProjectId: workspace.projectId,
      receivedProjectId: projectId,
      action: 'rejected',
    });
    throw errors.forbidden('Project identity verification failed');
  }

  return { projectId, workspaceId: payload.workspace, userId: workspace.userId, db };
}
