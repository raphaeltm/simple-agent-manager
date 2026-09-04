import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import { signCallbackToken, verifyCallbackToken } from '../../services/jwt';
import { createWorkspaceOnNode } from '../../services/node-agent';
import { nodeStatusTerminatesCallbacks } from '../../services/node-callback-auth';
import { signalWorkspaceDeletionUnconfirmedCallback } from '../../services/workspace-deletion-callback-signal';
import {
  resolveWorkspaceGitSource,
  type WorkspaceGitSourceProject,
} from '../../services/workspace-git-source';

export const ACTIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery'] as const);
export const WORKSPACE_CALLBACK_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'creating',
  'running',
  'recovery',
]);
export const WORKSPACE_CALLBACK_PROVISIONING_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'creating',
  'error',
]);

export interface WorkspaceCallbackIdentitySnapshot {
  workspaceId: string;
  userId: string;
  projectId: string | null;
  chatSessionId: string | null;
  status: string;
  nodeId: string | null;
  nodeStatus: string | null;
}

export function isActiveWorkspaceStatus(status: string): boolean {
  return ACTIVE_WORKSPACE_STATUSES.has(status as 'running' | 'recovery');
}

export async function assertWorkspaceAcceptsCallback<
  T extends { status: string; nodeId: string | null; nodeStatus: string | null },
>(
  env: Env,
  workspace: T | null | undefined,
  workspaceId: string,
  callback: string,
  allowedStatuses: ReadonlySet<string> = WORKSPACE_CALLBACK_ACTIVE_STATUSES
): Promise<T> {
  if (!workspace || !allowedStatuses.has(workspace.status)) {
    const observedStatus = workspace?.status ?? 'missing';
    await signalWorkspaceDeletionUnconfirmedCallback(env, workspaceId, callback);
    log.info('workspace_callback.terminal_resource', {
      workspaceId,
      status: observedStatus,
      callback,
      action: 'terminal_gone',
    });
    throw errors.gone(`Workspace is ${observedStatus}; callback resource is gone`);
  }

  if (
    !workspace.nodeId ||
    !workspace.nodeStatus ||
    nodeStatusTerminatesCallbacks(workspace.nodeStatus)
  ) {
    const observedNodeStatus = workspace.nodeStatus ?? 'missing';
    log.info('workspace_callback.terminal_node', {
      workspaceId,
      nodeId: workspace.nodeId ?? null,
      nodeStatus: observedNodeStatus,
      workspaceStatus: workspace.status,
      callback,
      action: 'terminal_gone',
    });
    throw errors.gone(`Workspace node is ${observedNodeStatus}; callback resource is gone`);
  }
  return workspace;
}

export async function assertWorkspaceCallbackResourceById(
  env: Env,
  workspaceId: string,
  callback: string,
  allowedStatuses: ReadonlySet<string> = WORKSPACE_CALLBACK_ACTIVE_STATUSES
): Promise<WorkspaceCallbackIdentitySnapshot> {
  const workspace = await loadWorkspaceCallbackIdentity(env, workspaceId);
  return assertWorkspaceAcceptsCallback(env, workspace, workspaceId, callback, allowedStatuses);
}

export async function loadWorkspaceCallbackIdentity(
  env: Env,
  workspaceId: string
): Promise<WorkspaceCallbackIdentitySnapshot | null> {
  const db = drizzle(env.DATABASE, { schema });
  const rows = await db
    .select({
      workspaceId: schema.workspaces.id,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export function sameWorkspaceCallbackIdentity(
  current: WorkspaceCallbackIdentitySnapshot,
  expected: WorkspaceCallbackIdentitySnapshot
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    current.userId === expected.userId &&
    current.projectId === expected.projectId &&
    current.chatSessionId === expected.chatSessionId &&
    current.status === expected.status &&
    current.nodeId === expected.nodeId &&
    current.nodeStatus === expected.nodeStatus
  );
}

interface WorkspaceCallbackTransitionValues {
  status: string;
  updatedAt: string;
  lastActivityAt?: string;
  errorMessage?: string | null;
  workspaceProfile?: 'full' | 'lightweight';
}

/** Exact D1 CAS for callback-driven workspace transitions. */
export async function transitionWorkspaceFromCallback(
  env: Env,
  expected: WorkspaceCallbackIdentitySnapshot,
  callback: string,
  values: WorkspaceCallbackTransitionValues,
  allowedStatuses: ReadonlySet<string> = WORKSPACE_CALLBACK_ACTIVE_STATUSES
): Promise<WorkspaceCallbackIdentitySnapshot> {
  const assignments = ['status = ?', 'updated_at = ?'];
  const bindings: Array<string | null> = [values.status, values.updatedAt];
  if (values.lastActivityAt !== undefined) {
    assignments.push('last_activity_at = ?');
    bindings.push(values.lastActivityAt);
  }
  if (values.errorMessage !== undefined) {
    assignments.push('error_message = ?');
    bindings.push(values.errorMessage);
  }
  if (values.workspaceProfile !== undefined) {
    assignments.push('workspace_profile = ?');
    bindings.push(values.workspaceProfile);
  }

  const result = await env.DATABASE.prepare(
    `UPDATE workspaces
        SET ${assignments.join(', ')}
      WHERE id = ?
        AND user_id = ?
        AND project_id IS ?
        AND chat_session_id IS ?
        AND node_id IS ?
        AND status = ?
        AND EXISTS (
          SELECT 1 FROM nodes
           WHERE nodes.id = workspaces.node_id
             AND nodes.status = ?
        )`
  )
    .bind(
      ...bindings,
      expected.workspaceId,
      expected.userId,
      expected.projectId,
      expected.chatSessionId,
      expected.nodeId,
      expected.status,
      expected.nodeStatus
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    await assertWorkspaceCallbackIdentityCurrent(env, expected, callback, allowedStatuses);
    throw errors.gone('Workspace callback state changed; callback resource is gone');
  }
  return { ...expected, status: values.status };
}

/**
 * Rule 49 callback fence: re-read the complete workspace incarnation at the
 * final side-effect/secret-delivery boundary. A callback authenticated before
 * deletion began must not act on a now-stopping (or reassigned) workspace.
 */
export async function assertWorkspaceCallbackIdentityCurrent(
  env: Env,
  expected: WorkspaceCallbackIdentitySnapshot,
  callback: string,
  allowedStatuses: ReadonlySet<string> = WORKSPACE_CALLBACK_ACTIVE_STATUSES
): Promise<WorkspaceCallbackIdentitySnapshot> {
  const current = await loadWorkspaceCallbackIdentity(env, expected.workspaceId);
  const active = await assertWorkspaceAcceptsCallback(
    env,
    current,
    expected.workspaceId,
    callback,
    allowedStatuses
  );
  if (!sameWorkspaceCallbackIdentity(active, expected)) {
    log.info('workspace_callback.incarnation_changed', {
      workspaceId: expected.workspaceId,
      expectedNodeId: expected.nodeId,
      currentNodeId: active.nodeId,
      callback,
      action: 'terminal_gone',
    });
    throw errors.gone('Workspace callback identity changed; callback resource is gone');
  }
  return active;
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
    log.warn('workspace_auth.rejected_node_scoped_token', {
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
    await env.DATABASE.prepare(`UPDATE workspaces SET dispatched_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), workspaceId)
      .run();
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
