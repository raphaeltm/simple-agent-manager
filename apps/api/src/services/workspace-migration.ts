/**
 * Orphaned workspace migration — finds workspaces with NULL projectId and
 * creates or matches projects based on repository + installationId fields.
 *
 * See: specs/018-project-first-architecture/tasks.md (T021)
 */
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { ulid } from '../lib/ulid';
import * as schema from '../db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Migrate orphaned workspaces (those with NULL projectId) by matching them
 * to existing projects or creating new projects as needed.
 *
 * Returns the number of workspaces migrated.
 */
export async function migrateOrphanedWorkspaces(db: Db): Promise<number> {
  // Find all workspaces with no project association
  const orphans = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      repository: schema.workspaces.repository,
      installationId: schema.workspaces.installationId,
    })
    .from(schema.workspaces)
    .where(isNull(schema.workspaces.projectId));

  if (orphans.length === 0) {
    return 0;
  }

  let migratedCount = 0;

  // Group orphans by (userId, repository, installationId) to batch-match
  const groupKey = (o: { userId: string; repository: string; installationId: string | null }) =>
    `${o.userId}::${o.repository.toLowerCase()}::${o.installationId ?? ''}`;

  const groups = new Map<
    string,
    { userId: string; repository: string; installationId: string | null; workspaceIds: string[] }
  >();

  for (const orphan of orphans) {
    const key = groupKey(orphan);
    const existing = groups.get(key);
    if (existing) {
      existing.workspaceIds.push(orphan.id);
    } else {
      groups.set(key, {
        userId: orphan.userId,
        repository: orphan.repository,
        installationId: orphan.installationId,
        workspaceIds: [orphan.id],
      });
    }
  }

  for (const group of groups.values()) {
    try {
      // Try to find an existing project matching this repo+user+installation
      const conditions = [
        eq(schema.projects.userId, group.userId),
        eq(schema.projects.repository, group.repository),
      ];
      if (group.installationId) {
        conditions.push(eq(schema.projects.installationId, group.installationId));
      }

      const existingProjects = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(...conditions))
        .limit(1);

      let projectId: string;

      if (existingProjects[0]) {
        projectId = existingProjects[0].id;
      } else if (group.installationId) {
        // Create a new project for this repo
        projectId = ulid();
        const repoName = group.repository.split('/').pop() || group.repository;
        const normalizedName = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const now = new Date().toISOString();

        await db.insert(schema.projects).values({
          id: projectId,
          userId: group.userId,
          name: repoName,
          normalizedName,
          installationId: group.installationId,
          repository: group.repository,
          defaultBranch: 'main',
          status: 'active',
          createdBy: group.userId,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        // Can't create a project without installationId — skip
        continue;
      }

      // Update all workspaces in this group
      for (const workspaceId of group.workspaceIds) {
        await db
          .update(schema.workspaces)
          .set({
            projectId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.workspaces.id, workspaceId));
        migratedCount++;
      }
    } catch (err) {
      // Best-effort per group — log and continue
      console.error(
        `Failed to migrate orphaned workspaces for ${group.repository}:`,
        err
      );
    }
  }

  return migratedCount;
}
