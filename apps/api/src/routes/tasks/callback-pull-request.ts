import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ensurePullRequest, parseProjectPullRequestUrl } from '../../operations/pull-request-core';

type TaskDb = ReturnType<typeof drizzle<typeof schema>>;

export async function prepareCallbackPullRequest(
  db: TaskDb,
  projectId: string,
  task: Pick<schema.Task, 'outputPrUrl'>,
  gitPushResult: { commitSha?: string | null; prUrl?: string | null } | undefined,
  stepUpdate: Partial<schema.NewTask>
): Promise<string | null> {
  const candidatePrUrl = stepUpdate.outputPrUrl;
  if (!candidatePrUrl) {
    if (stepUpdate.outputPrUrl !== undefined) {
      stepUpdate.outputPrNumber = null;
      stepUpdate.outputCommitSha = null;
    }
    return null;
  }

  const [project] = await db
    .select({ repository: schema.projects.repository })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const parsed = parseProjectPullRequestUrl(candidatePrUrl, project.repository);
  if (!parsed) {
    stepUpdate.outputPrNumber = null;
    stepUpdate.outputCommitSha = null;
    return project.repository;
  }

  stepUpdate.outputPrNumber = parsed.number;
  if (
    gitPushResult?.commitSha &&
    gitPushResult.prUrl &&
    parseProjectPullRequestUrl(gitPushResult.prUrl, project.repository)?.url === parsed.url
  ) {
    stepUpdate.outputCommitSha = gitPushResult.commitSha;
  } else if (
    gitPushResult?.commitSha ||
    parseProjectPullRequestUrl(task.outputPrUrl ?? '', project.repository)?.url !== parsed.url
  ) {
    stepUpdate.outputCommitSha = null;
  }
  return project.repository;
}

export async function storeCallbackPullRequest(
  env: Env,
  projectId: string,
  taskId: string,
  repository: string | null,
  prUrl: string | null | undefined,
  revalidateWorkspace: () => Promise<unknown>
): Promise<void> {
  if (!repository || !prUrl) return;
  await revalidateWorkspace();
  const stored = await ensurePullRequest(env, projectId, repository, prUrl);
  if (!stored) log.warn('task.callback.pr_repository_mismatch', { taskId, projectId });
}
