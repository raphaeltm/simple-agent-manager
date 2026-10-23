import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  parseProjectPullRequestUrl,
  type PullRequestSnapshot,
  upsertPullRequestSnapshot,
} from '../operations/pull-request-core';
import { resolveAdminSetting } from './admin-settings';
import { findProjectsForGitHubRepository } from './github-project-event-producer';

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
  ).filter((project) => project.repository.toLowerCase() === repositoryFullName);
  if (projects.length === 0 || !repositoryFullName) return;

  if (event === 'pull_request') {
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
    if (!parsed || parsed.number !== number) return;
    const state =
      action === 'closed' || pr?.state === 'closed'
        ? pr?.merged === true
          ? 'merged'
          : 'closed'
        : 'open';
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
    return;
  }

  if (payload.action !== 'completed') return;
  const check = record(payload[event]);
  const sha = string(check?.head_sha);
  if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) return;
  const conclusion = string(check?.conclusion);
  const checksState =
    conclusion === 'success'
      ? 'success'
      : conclusion === 'neutral' || conclusion === 'skipped'
        ? 'neutral'
        : conclusion === null
          ? 'pending'
          : 'failure';
  const updatedAt = string(check?.completed_at) ?? new Date().toISOString();
  const cap = Number(await resolveAdminSetting(env, 'operations.pullRequestCheckUpdateCap'));
  await Promise.all(
    projects.map(async (project) => {
      const result = await env.DATABASE.prepare(
        `UPDATE pull_requests SET checks_state = ?, checks_updated_at = ?
       WHERE id IN (SELECT id FROM pull_requests WHERE project_id = ? AND repository = ? AND head_sha = ? LIMIT ?)
       AND (checks_updated_at IS NULL OR checks_updated_at <= ?)`
      )
        .bind(checksState, updatedAt, project.id, repositoryFullName, sha, cap, updatedAt)
        .run();
      if ((result.meta.changes ?? 0) >= cap)
        log.warn('github.pr_checks_update_capped', { projectId: project.id });
    })
  );
}
