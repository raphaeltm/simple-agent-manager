import * as schema from '@simple-agent-manager/worker-core/schema';
import { eq, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from './env';

export type GitHubProjectCandidate = {
  id: string;
  /** Owner, so a caller can leave out projects no person owns (`SYSTEM_USER_ID`). */
  userId: string;
  name: string;
  repository: string;
  githubRepoId: number | null;
};

export async function findProjectsForGitHubRepository(
  env: Env,
  input: { repositoryFullName: string | null; repositoryId: number | null }
): Promise<GitHubProjectCandidate[]> {
  const predicates: SQL[] = [];
  if (input.repositoryFullName) {
    predicates.push(eq(schema.projects.repository, input.repositoryFullName));
  }
  if (input.repositoryId !== null) {
    predicates.push(eq(schema.projects.githubRepoId, input.repositoryId));
  }
  if (predicates.length === 0) return [];

  const db = drizzle(env.DATABASE, { schema });
  const where = predicates.length === 1 ? predicates[0] : or(...predicates);
  return await db
    .select({
      id: schema.projects.id,
      userId: schema.projects.userId,
      name: schema.projects.name,
      repository: schema.projects.repository,
      githubRepoId: schema.projects.githubRepoId,
    })
    .from(schema.projects)
    .where(where);
}
