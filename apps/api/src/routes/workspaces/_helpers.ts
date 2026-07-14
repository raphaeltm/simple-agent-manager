import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import { signCallbackToken,verifyCallbackToken } from '../../services/jwt';
import { createWorkspaceOnNode } from '../../services/node-agent';
import {
  resolveWorkspaceGitSource,
  type WorkspaceGitSourceProject,
} from '../../services/workspace-git-source';

export const ACTIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery'] as const);

export function isActiveWorkspaceStatus(status: string): boolean {
  return ACTIVE_WORKSPACE_STATUSES.has(status as 'running' | 'recovery');
}

/** Parse a JSON string into a plain object, returning null on failure or prototype pollution. */
export function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    // Use Object.hasOwn to check only own properties, not the prototype chain.
    // The `in` operator checks the prototype chain, so `'constructor' in {}` is always true.
    if (
      Object.hasOwn(parsed, '__proto__') ||
      Object.hasOwn(parsed, 'constructor') ||
      Object.hasOwn(parsed, 'prototype')
    ) {
      return null;
    }
    return expectJsonRecord(parsed, 'workspace.json');
  } catch {
    return null;
  }
}

export function normalizeWorkspaceReadyStatus(status: unknown): 'running' | 'recovery' {
  if (typeof status !== 'string') return 'running';
  const normalized = status.trim().toLowerCase();
  if (!normalized || normalized === 'running') return 'running';
  if (normalized === 'recovery') return 'recovery';
  throw errors.badRequest('status must be "running" or "recovery"');
}

export async function getOwnedWorkspace(
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspaceId: string,
  userId: string
): Promise<schema.Workspace> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);

  const workspace = rows[0];
  if (!workspace || workspace.status === 'deleted') {
    throw errors.notFound('Workspace');
  }

  return workspace;
}

export async function getOwnedNode(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeId: string,
  userId: string
): Promise<schema.Node> {
  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    throw errors.notFound('Node');
  }

  return node;
}

export function assertNodeOperational(node: schema.Node, action: string): void {
  if (node.status !== 'running') {
    throw errors.badRequest(`Cannot ${action}: node is ${node.status}`);
  }
  if (node.healthStatus === 'unhealthy') {
    throw errors.badRequest(`Cannot ${action}: node is unhealthy`);
  }
}

export async function verifyWorkspaceCallbackAuth(
  c: Context<{ Bindings: Env }>,
  workspaceId: string
): Promise<void> {
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  // Node-scoped tokens CANNOT access workspace-scoped endpoints.
  // This prevents cross-workspace secret access on multi-tenant nodes.
  if (payload.scope === 'node') {
    log.error('workspace_auth.rejected_node_scoped_token', {
      tokenWorkspace: payload.workspace,
      requestedWorkspaceId: workspaceId,
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden('Insufficient token scope');
  }

  // Workspace-scoped tokens: direct workspace match required.
  if (payload.scope === 'workspace') {
    if (payload.workspace === workspaceId) {
      return;
    }
    throw errors.forbidden('Insufficient token scope');
  }

  // Legacy tokens (no scope claim): backward compatible behavior.
  // Direct workspace match.
  if (payload.workspace === workspaceId) {
    log.warn('workspace_auth.legacy_token_no_scope', {
      tokenWorkspace: payload.workspace,
      workspaceId,
      action: 'allowed_legacy',
    });
    return;
  }

  throw errors.forbidden('Insufficient token scope');
}

export async function scheduleWorkspaceCreateOnNode(
  env: Env,
  workspaceId: string,
  nodeId: string,
  userId: string,
  repository: string,
  branch: string,
  project: WorkspaceGitSourceProject,
  gitUserName?: string | null,
  gitUserEmail?: string | null
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  await db
    .update(schema.workspaces)
    .set({ status: 'creating', errorMessage: null, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  try {
    const callbackToken = await signCallbackToken(workspaceId, env);
    const gitSource = await resolveWorkspaceGitSource(db, project);
    await createWorkspaceOnNode(nodeId, env, userId, {
      workspaceId,
      repository,
      branch,
      ...gitSource,
      callbackToken,
      gitUserName,
      gitUserEmail,
    });
    await env.DATABASE.prepare(
      `UPDATE workspaces SET dispatched_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), workspaceId).run();
  } catch (err) {
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to create workspace on node',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, workspaceId));
  }
}
