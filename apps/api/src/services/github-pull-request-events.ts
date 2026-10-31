import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  parseProjectPullRequestUrl,
  type PullRequestSnapshot,
  upsertPullRequestSnapshot,
} from '../operations/pull-request-core';
import { resolveAdminSetting } from './admin-settings';
import {
  findProjectsForGitHubRepository,
  type GitHubProjectCandidate,
} from './github-project-repositories';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Called only after the webhook signature was verified by the route. */
export async function ingestPullRequestWebhook(
  env: Env,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!['pull_request', 'check_run', 'check_suite'].includes(event)) return;
  const repo = record(payload.repository);
  const repositoryFullName = string(repo?.full_name)?.toLowerCase() ?? null;
  const repositoryId = typeof repo?.id === 'number' ? repo.id : null;
  if (!repositoryFullName && repositoryId === null) return;
  const projects = (
    await findProjectsForGitHubRepository(env, { repositoryFullName, repositoryId })
  ).filter(
    (project) =>
      project.repository.toLowerCase() === repositoryFullName &&
      (project.githubRepoId === null || project.githubRepoId === repositoryId)
  );
  if (projects.length === 0 || !repositoryFullName) return;

  if (event === 'pull_request')
    await ingestLifecycleWebhook(env, repositoryFullName, projects, payload);
  else await ingestChecksWebhook(env, event, repositoryFullName, projects, payload);
}

async function ingestLifecycleWebhook(
  env: Env,
  repositoryFullName: string,
  projects: GitHubProjectCandidate[],
  payload: Record<string, unknown>
): Promise<void> {
  const action = string(payload.action);
  if (
    !action ||
    ![
      'opened',
      'edited',
      'closed',
      'reopened',
      'synchronize',
      'ready_for_review',
      'converted_to_draft',
    ].includes(action)
  )
    return;
  const pr = record(payload.pull_request);
  const head = record(pr?.head);
  const base = record(pr?.base);
  const author = record(pr?.user);
  const number = typeof pr?.number === 'number' ? pr.number : null;
  const updatedAt = string(pr?.updated_at);
  const createdAt = string(pr?.created_at);
  const url = string(pr?.html_url);
  if (!number || !url || !updatedAt || !createdAt) return;
  const parsed = parseProjectPullRequestUrl(url, repositoryFullName);
  if (parsed?.number !== number) return;
  const state = lifecycleState(action, pr);
  const snapshot: PullRequestSnapshot = {
    ...parsed,
    state,
    title: string(pr?.title),
    isDraft: pr?.draft === true,
    headRef: string(head?.ref),
    headSha: string(head?.sha),
    baseRef: string(base?.ref),
    authorLogin: string(author?.login),
    mergedAt: string(pr?.merged_at),
    closedAt: string(pr?.closed_at),
    createdAt,
    updatedAt,
  };
  await Promise.all(
    projects.map((project) => upsertPullRequestSnapshot(env, project.id, snapshot))
  );
}

function lifecycleState(
  action: string,
  pr: Record<string, unknown> | null
): PullRequestSnapshot['state'] {
  if (action !== 'closed' && pr?.state !== 'closed') return 'open';
  return pr?.merged === true ? 'merged' : 'closed';
}

function checkBelongsToProjectPullRequest(
  check: Record<string, unknown> | null,
  repositoryId: number | null,
  repositoryFullName: string,
  sha: string
): boolean {
  const pullRequests = check?.pull_requests;
  if (!Array.isArray(pullRequests)) return false;
  return pullRequests.some((value) => {
    const pr = record(value);
    const head = record(pr?.head);
    const baseRepo = record(record(pr?.base)?.repo);
    const repoMatches =
      typeof baseRepo?.id === 'number'
        ? baseRepo.id === repositoryId
        : string(baseRepo?.full_name)?.toLowerCase() === repositoryFullName;
    return typeof pr?.number === 'number' && pr.number > 0 && head?.sha === sha && repoMatches;
  });
}

async function ingestChecksWebhook(
  env: Env,
  event: string,
  repositoryFullName: string,
  projects: GitHubProjectCandidate[],
  payload: Record<string, unknown>
): Promise<void> {
  if (
    !['completed', 'created', 'requested', 'rerequested', 'in_progress'].includes(
      String(payload.action)
    )
  )
    return;
  const check = record(payload[event]);
  const sha = string(check?.head_sha);
  const checkId = check?.id;
  const appId = record(check?.app)?.id;
  const checkName = string(check?.name);
  if (
    !sha ||
    !/^[a-f0-9]{40}$/i.test(sha) ||
    typeof checkId !== 'number' ||
    typeof appId !== 'number' ||
    (event === 'check_run' && !checkName)
  )
    return;
  const orderingTime =
    string(check?.updated_at) ?? string(check?.completed_at) ?? string(check?.started_at);
  if (!orderingTime || !Number.isFinite(Date.parse(orderingTime))) return;
  const updatedAt = new Date(orderingTime).toISOString();
  const checksState = checkState(string(check?.conclusion), payload.action);
  // A new run ID for the same app/name supersedes an earlier failed attempt.
  const checkKey = event === 'check_run' ? `${event}:${appId}:${checkName}` : `${event}:${appId}`;
  const cap = Number(await resolveAdminSetting(env, 'operations.pullRequestCheckUpdateCap'));
  const pendingCap = Number(
    await resolveAdminSetting(env, 'operations.pullRequestPendingCheckCap')
  );
  const associated = checkBelongsToProjectPullRequest(
    check,
    typeof record(payload.repository)?.id === 'number'
      ? (record(payload.repository)?.id as number)
      : null,
    repositoryFullName,
    sha
  );
  await Promise.all(
    projects.map(async (project) => {
      await env.DATABASE.prepare(
        `INSERT INTO pull_request_checks (project_id, repository, head_sha, check_key, state, updated_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ? = 1 OR EXISTS (
           SELECT 1 FROM pull_requests WHERE project_id = ? AND repository = ? AND head_sha = ?)
         ON CONFLICT(project_id, repository, head_sha, check_key) DO UPDATE SET
           state = excluded.state, updated_at = excluded.updated_at
         WHERE excluded.updated_at > pull_request_checks.updated_at
            OR (excluded.updated_at = pull_request_checks.updated_at
                AND pull_request_checks.state = 'pending' AND excluded.state != 'pending')`
      )
        .bind(
          project.id,
          repositoryFullName,
          sha,
          checkKey,
          checksState,
          updatedAt,
          Number(associated),
          project.id,
          repositoryFullName,
          sha
        )
        .run();
      const result = await env.DATABASE.prepare(
        `UPDATE pull_requests SET checks_state = (
           SELECT CASE
             WHEN sum(state = 'failure') > 0 THEN 'failure'
             WHEN sum(state = 'pending') > 0 THEN 'pending'
             WHEN sum(state = 'success') > 0 THEN 'success'
             ELSE 'neutral' END
           FROM pull_request_checks WHERE project_id = ? AND repository = ? AND head_sha = ?
         ), checks_updated_at = max(coalesce(checks_updated_at, ''), ?)
         WHERE id IN (SELECT id FROM pull_requests WHERE project_id = ? AND repository = ? AND head_sha = ? LIMIT ?)`
      )
        .bind(
          project.id,
          repositoryFullName,
          sha,
          updatedAt,
          project.id,
          repositoryFullName,
          sha,
          cap
        )
        .run();
      // Only an associated check for an untracked head can grow the unmatched set.
      // Tracked-head updates cannot add orphans; pruning after each one rescans the
      // entire repository on every CI event, usually deleting nothing.
      if (associated && (result.meta.changes ?? 0) === 0) {
        await env.DATABASE.prepare(
          `DELETE FROM pull_request_checks WHERE rowid IN (
             SELECT c.rowid FROM pull_request_checks c
             WHERE c.project_id = ? AND c.repository = ?
               AND NOT EXISTS (
                 SELECT 1 FROM pull_requests p
                 WHERE p.project_id = c.project_id AND p.repository = c.repository
                   AND p.head_sha = c.head_sha)
             ORDER BY c.updated_at DESC, c.rowid DESC LIMIT -1 OFFSET ?)`
        )
          .bind(project.id, repositoryFullName, pendingCap)
          .run();
      }
      if ((result.meta.changes ?? 0) >= cap)
        log.warn('github.pr_checks_update_capped', { projectId: project.id });
    })
  );
}

function checkState(
  conclusion: string | null,
  action: unknown
): 'pending' | 'success' | 'failure' | 'neutral' {
  if (action !== 'completed' || conclusion === null) return 'pending';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'neutral';
  return 'failure';
}
