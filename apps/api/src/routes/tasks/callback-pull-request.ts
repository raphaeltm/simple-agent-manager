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
  await persistCallbackPullRequest(env, projectId, taskId, repository, prUrl);
}

async function persistCallbackPullRequest(
  env: Env,
  projectId: string,
  taskId: string,
  repository: string,
  prUrl: string
): Promise<void> {
  const stored = await ensurePullRequest(env, projectId, repository, prUrl);
  if (!stored) log.warn('task.callback.pr_repository_mismatch', { taskId, projectId });
}

export async function prepareStatusCallbackPullRequest(
  db: TaskDb,
  projectId: string,
  task: Pick<schema.Task, 'outputPrUrl'>,
  body: {
    outputPrUrl?: string | null;
    gitPushResult?: { commitSha?: string | null; prUrl?: string | null };
  }
) {
  const update: Partial<schema.NewTask> =
    body.outputPrUrl === undefined ? {} : { outputPrUrl: body.outputPrUrl?.trim() || null };
  const repository = await prepareCallbackPullRequest(
    db,
    projectId,
    task,
    body.gitPushResult,
    update
  );
  return {
    options: {
      outputPrNumber: update.outputPrNumber,
      outputCommitSha: update.outputCommitSha,
    },
    store: async (env: Env, taskId: string, revalidateWorkspace: () => Promise<unknown>) => {
      if (!repository || !update.outputPrUrl) return;
      await revalidateWorkspace();
      try {
        await persistCallbackPullRequest(env, projectId, taskId, repository, update.outputPrUrl);
      } catch (error) {
        log.warn('task.callback.pr_storage_failed', { taskId, projectId, error: String(error) });
        await persistCallbackPullRequest(
          env,
          projectId,
          taskId,
          repository,
          update.outputPrUrl
        ).catch((retryError) => {
          log.warn('task.callback.pr_storage_retry_failed', {
            taskId,
            projectId,
            error: String(retryError),
          });
        });
      }
    },
  };
}
