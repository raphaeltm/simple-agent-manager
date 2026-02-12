import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { getUserId } from './auth';
import { nodes, type Node, workspaces, type Workspace } from '../db/schema';
import type { Env } from '../index';

/**
 * Validates that the authenticated user owns a node.
 * Returns null if node does not exist or is not owned by the user.
 */
export async function requireNodeOwnership(
  c: Context<{ Bindings: Env }>,
  nodeId: string
): Promise<Node | null> {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE);

  const result = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, nodeId),
        eq(nodes.userId, userId)
      )
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Validates that the authenticated user owns a workspace that belongs to a node.
 * If nodeId is provided, the workspace must be attached to that same node.
 */
export async function requireNodeScopedWorkspaceOwnership(
  c: Context<{ Bindings: Env }>,
  workspaceId: string,
  nodeId?: string
): Promise<Workspace | null> {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE);

  const result = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.userId, userId)
      )
    )
    .limit(1);

  const workspace = result[0];
  if (!workspace) {
    return null;
  }

  if (nodeId && workspace.nodeId !== nodeId) {
    return null;
  }

  return workspace;
}
