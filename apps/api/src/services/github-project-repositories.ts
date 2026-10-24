import { eq, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

export type GitHubProjectCandidate = {
  id: string;
  name: string;
  repository: string;
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
  return db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      repository: schema.projects.repository,
    })
    .from(schema.projects)
    .where(where);
}
