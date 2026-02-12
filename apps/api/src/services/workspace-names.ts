import { and, eq, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

function normalizeDisplayName(name: string): string {
  return name.trim().toLowerCase();
}

export interface UniqueDisplayNameResult {
  displayName: string;
  normalizedDisplayName: string;
}

/**
 * Generate a unique display name within a node.
 * Auto-suffixes duplicates with " (n)".
 */
export async function resolveUniqueWorkspaceDisplayName(
  db: DrizzleD1Database<typeof schema>,
  nodeId: string,
  requestedName: string,
  excludeWorkspaceId?: string
): Promise<UniqueDisplayNameResult> {
  const baseName = requestedName.trim();
  if (!baseName) {
    throw new Error('Workspace name is required');
  }

  const baseNormalized = normalizeDisplayName(baseName);

  const filter = excludeWorkspaceId
    ? and(
      eq(schema.workspaces.nodeId, nodeId),
      ne(schema.workspaces.id, excludeWorkspaceId)
    )
    : eq(schema.workspaces.nodeId, nodeId);

  const existing = await db
    .select({
      displayName: schema.workspaces.displayName,
      name: schema.workspaces.name,
      normalizedDisplayName: schema.workspaces.normalizedDisplayName,
    })
    .from(schema.workspaces)
    .where(filter);

  const taken = new Set(
    existing
      .map((w) => (w.normalizedDisplayName ?? normalizeDisplayName(w.displayName ?? w.name)))
      .filter(Boolean)
  );

  if (!taken.has(baseNormalized)) {
    return {
      displayName: baseName,
      normalizedDisplayName: baseNormalized,
    };
  }

  let suffix = 2;
  while (suffix < 10_000) {
    const candidateDisplayName = `${baseName} (${suffix})`;
    const candidateNormalized = normalizeDisplayName(candidateDisplayName);
    if (!taken.has(candidateNormalized)) {
      return {
        displayName: candidateDisplayName,
        normalizedDisplayName: candidateNormalized,
      };
    }
    suffix++;
  }

  throw new Error('Unable to allocate a unique workspace name');
}
