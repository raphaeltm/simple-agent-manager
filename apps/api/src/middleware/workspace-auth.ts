import type { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { workspaces, type Workspace } from '../db/schema';
import { getUserId } from './auth';
import type { Env } from '../index';

/**
 * Validates that the authenticated user owns the specified workspace.
 * Returns null if workspace doesn't exist or user doesn't own it.
 * Returns 404 in both cases to prevent information disclosure.
 *
 * @param c - Hono context (must have auth set)
 * @param workspaceId - ID of workspace to check ownership
 * @returns Workspace if owned by user, null otherwise
 */
export async function requireWorkspaceOwnership(
  c: Context<{ Bindings: Env }>,
  workspaceId: string
): Promise<Workspace | null> {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE);

  const result = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const workspace = result[0];

  // Return null if workspace doesn't exist OR user doesn't own it
  // Both cases return null to prevent information disclosure
  if (!workspace || workspace.userId !== userId) {
    return null;
  }

  return workspace;
}
