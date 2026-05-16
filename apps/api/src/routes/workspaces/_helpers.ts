import type { WorkspaceRuntimeAssetsResponse } from '@simple-agent-manager/shared';
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
  getProfileRuntimeAssets,
  mergeRuntimeAssetRows,
  resolveRuntimeEnvRows,
  resolveRuntimeFileRows,
  type RuntimeAssetRows,
} from '../../services/profile-runtime-assets';

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

export async function getWorkspaceRuntimeAssets(
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspaceId: string,
  encryptionKey: string
): Promise<WorkspaceRuntimeAssetsResponse> {
  const workspaceRows = await db
    .select({ id: schema.workspaces.id, userId: schema.workspaces.userId, projectId: schema.workspaces.projectId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  if (!workspace.projectId) {
    return {
      workspaceId: workspace.id,
      envVars: [],
      files: [],
    };
  }

  const [envRows, fileRows] = await Promise.all([
    db
      .select({
        key: schema.projectRuntimeEnvVars.envKey,
        storedValue: schema.projectRuntimeEnvVars.storedValue,
        valueIv: schema.projectRuntimeEnvVars.valueIv,
        isSecret: schema.projectRuntimeEnvVars.isSecret,
      })
      .from(schema.projectRuntimeEnvVars)
      .where(
        and(
          eq(schema.projectRuntimeEnvVars.projectId, workspace.projectId),
          eq(schema.projectRuntimeEnvVars.userId, workspace.userId)
        )
      ),
    db
      .select({
        path: schema.projectRuntimeFiles.filePath,
        storedContent: schema.projectRuntimeFiles.storedContent,
        contentIv: schema.projectRuntimeFiles.contentIv,
        isSecret: schema.projectRuntimeFiles.isSecret,
      })
      .from(schema.projectRuntimeFiles)
      .where(
        and(
          eq(schema.projectRuntimeFiles.projectId, workspace.projectId),
          eq(schema.projectRuntimeFiles.userId, workspace.userId)
        )
      ),
  ]);

  const projectAssets: RuntimeAssetRows = {
    envVars: await resolveRuntimeEnvRows(envRows, encryptionKey),
    files: await resolveRuntimeFileRows(fileRows, encryptionKey),
  };

  const profileId = await getWorkspaceTaskProfileId(db, workspace.id, workspace.projectId, workspace.userId);
  const profileAssets = profileId
    ? await getProfileRuntimeAssets(db, profileId, workspace.userId, encryptionKey)
    : { envVars: [], files: [] };
  const mergedAssets = mergeRuntimeAssetRows(projectAssets, profileAssets);

  return {
    workspaceId: workspace.id,
    envVars: mergedAssets.envVars,
    files: mergedAssets.files,
  };
}

async function getWorkspaceTaskProfileId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspaceId: string,
  projectId: string,
  userId: string
): Promise<string | null> {
  const taskRows = await db
    .select({ profileId: schema.tasks.agentProfileHint })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, workspaceId),
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.userId, userId)
      )
    )
    .limit(1);

  const profileId = taskRows[0]?.profileId;
  if (!profileId) {
    return null;
  }

  const profileRows = await db
    .select({ id: schema.agentProfiles.id })
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        eq(schema.agentProfiles.projectId, projectId),
        eq(schema.agentProfiles.userId, userId)
      )
    )
    .limit(1);

  return profileRows[0]?.id ?? null;
}

export async function scheduleWorkspaceCreateOnNode(
  env: Env,
  workspaceId: string,
  nodeId: string,
  userId: string,
  repository: string,
  branch: string,
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
    await createWorkspaceOnNode(nodeId, env, userId, {
      workspaceId,
      repository,
      branch,
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
