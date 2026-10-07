import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

/** Rehydrate trusted Git metadata before a cold Instant host restores its session. */
export async function loadInstantRestoreWorkspace(
  env: Env,
  input: { workspaceId: string; userId: string; projectId: string; chatSessionId: string }
) {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      workspaceRepository: schema.workspaces.repository,
      branch: schema.workspaces.branch,
      repository: schema.projects.repository,
      defaultBranch: schema.projects.defaultBranch,
      repoProvider: schema.projects.repoProvider,
      gitUserName: schema.users.name,
      gitUserEmail: schema.users.email,
      githubId: schema.users.githubId,
    })
    .from(schema.workspaces)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.workspaces.projectId))
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaces.userId))
    .where(
      and(
        eq(schema.workspaces.id, input.workspaceId),
        eq(schema.workspaces.userId, input.userId),
        eq(schema.workspaces.projectId, input.projectId),
        eq(schema.workspaces.chatSessionId, input.chatSessionId)
      )
    )
    .get();
  if (
    !row?.repository.trim() ||
    !row.branch.trim() ||
    !row.defaultBranch.trim() ||
    row.workspaceRepository !== row.repository
  ) {
    throw new Error('Instant restore workspace Git identity unavailable or changed');
  }
  // Provider resolution can load OAuth clients; load it only during an actual
  // recovery, keeping the Container module's startup dependency surface small.
  const { resolveWorkspaceGitSource } = await import('./workspace-git-source');
  const source = await resolveWorkspaceGitSource(db, {
    id: input.projectId,
    repoProvider: row.repoProvider,
  });
  return {
    workspaceId: input.workspaceId,
    repository: row.repository,
    branch: row.branch,
    baseBranch: row.defaultBranch,
    defaultBranch: row.defaultBranch,
    ...source,
    gitUserName: row.gitUserName,
    gitUserEmail: row.gitUserEmail,
    githubId: row.githubId,
  };
}
