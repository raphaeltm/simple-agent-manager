import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, eq, ne, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from './env';

export type GitHubProjectCandidate = {
  id: string;
  name: string;
  repository: string;
  githubRepoId: number | null;
};

/**
 * Projects a GitHub webhook for this repository concerns. Projects owned by the system sentinel
 * user are left out at the source (`.claude/rules/40`): they are leftovers of the retired
 * anonymous trial, nobody can open them, and every webhook routed to one is paid for in Durable
 * Object and D1 row writes. One such project bound to a busy repository took about 10,000 events
 * a day in production (2026-11-13). Both callers want the exclusion: the project-event producer
 * and pull-request tracking.
 */
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
      name: schema.projects.name,
      repository: schema.projects.repository,
      githubRepoId: schema.projects.githubRepoId,
    })
    .from(schema.projects)
    .where(and(where, ne(schema.projects.userId, SYSTEM_USER_ID)));
}
