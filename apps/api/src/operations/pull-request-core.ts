import {
  canonicalProjectPullRequestUrl,
  type PullRequestRef,
  type PullRequestState,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { resolveAdminSetting } from '../services/admin-settings';
import { getInstallationToken } from '../services/github-app';
import type { OperationContext } from './types';

export interface ParsedPullRequestUrl {
  repository: string;
  number: number;
  url: string;
}

/** Reject arbitrary hosts, paths and cross-repository PRs before writing D1. */
export function parseProjectPullRequestUrl(
  value: string,
  projectRepository: string
): ParsedPullRequestUrl | null {
  const url = canonicalProjectPullRequestUrl(value, projectRepository);
  if (!url) return null;
  const repository = projectRepository.toLowerCase();
  const number = Number(url.slice(url.lastIndexOf('/') + 1));
  return { repository, number, url };
}

export interface PullRequestSnapshot extends ParsedPullRequestUrl {
  title: string | null;
  state: PullRequestState['state'];
  isDraft: boolean;
  headRef: string | null;
  headSha: string | null;
  baseRef: string | null;
  authorLogin: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function refreshedState(pr: Record<string, unknown>): PullRequestState['state'] {
  if (pr.merged === true) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return 'open';
}

/** A URL-only writer creates a placeholder; it cannot overwrite webhook state. */
export async function ensurePullRequest(
  env: Env,
  projectId: string,
  projectRepository: string,
  value: string
): Promise<ParsedPullRequestUrl | null> {
  const ref = parseProjectPullRequestUrl(value, projectRepository);
  if (!ref) return null;
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO pull_requests
      (id, project_id, repository, number, url, state, is_draft, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?)`
  )
    .bind(ulid(), projectId, ref.repository, ref.number, ref.url, now, '1970-01-01T00:00:00.000Z')
    .run();
  return ref;
}

/** The GitHub updated_at clock prevents late delivery from reopening a merged PR. */
export async function upsertPullRequestSnapshot(
  env: Env,
  projectId: string,
  pr: PullRequestSnapshot
): Promise<void> {
  const now = new Date().toISOString();
  const previous = await env.DATABASE.prepare(
    'SELECT head_sha FROM pull_requests WHERE project_id = ? AND repository = ? AND number = ?'
  )
    .bind(projectId, pr.repository, pr.number)
    .first<{ head_sha: string | null }>();
  await env.DATABASE.prepare(
    `INSERT INTO pull_requests
      (id, project_id, repository, number, url, title, state, is_draft, head_ref, head_sha,
       base_ref, author_login, merged_at, closed_at, created_at, updated_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, repository, number) DO UPDATE SET
       url = excluded.url, title = excluded.title, state = excluded.state,
       is_draft = excluded.is_draft, head_ref = excluded.head_ref, head_sha = excluded.head_sha,
       base_ref = excluded.base_ref, author_login = excluded.author_login,
       merged_at = excluded.merged_at, closed_at = excluded.closed_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at, last_synced_at = excluded.last_synced_at,
       checks_state = CASE WHEN pull_requests.head_sha IS NOT excluded.head_sha THEN NULL ELSE pull_requests.checks_state END,
       checks_updated_at = CASE WHEN pull_requests.head_sha IS NOT excluded.head_sha THEN NULL ELSE pull_requests.checks_updated_at END
     WHERE excluded.updated_at > pull_requests.updated_at`
  )
    .bind(
      ulid(),
      projectId,
      pr.repository,
      pr.number,
      pr.url,
      pr.title,
      pr.state,
      Number(pr.isDraft),
      pr.headRef,
      pr.headSha,
      pr.baseRef,
      pr.authorLogin,
      pr.mergedAt,
      pr.closedAt,
      pr.createdAt,
      pr.updatedAt,
      now
    )
    .run();
  // A synchronized PR may orphan observations for its previous head commit.
  if (previous?.head_sha && previous.head_sha !== pr.headSha) {
    await env.DATABASE.prepare(
      `DELETE FROM pull_request_checks
       WHERE project_id = ? AND repository = ? AND head_sha = ?
         AND NOT EXISTS (
           SELECT 1 FROM pull_requests
           WHERE project_id = ? AND repository = ? AND head_sha = ?)`
    )
      .bind(
        projectId,
        pr.repository,
        previous.head_sha,
        projectId,
        pr.repository,
        previous.head_sha
      )
      .run();
  }
}

export type PullRequestStates = Record<string, PullRequestState | null>;

async function refreshSettings(env: Env) {
  const [cap, ttlSeconds, budgetPerHour, backoffSeconds, timeoutMs] = await Promise.all([
    resolveAdminSetting(env, 'operations.pullRequestRefreshCap'),
    resolveAdminSetting(env, 'operations.pullRequestRefreshTtlSeconds'),
    resolveAdminSetting(env, 'operations.pullRequestRefreshBudgetPerHour'),
    resolveAdminSetting(env, 'operations.pullRequestRefreshBackoffSeconds'),
    resolveAdminSetting(env, 'operations.pullRequestRefreshTimeoutMs'),
  ]);
  return {
    cap: Number(cap),
    ttlSeconds: Number(ttlSeconds),
    budgetPerHour: Number(budgetPerHour),
    backoffSeconds: Number(backoffSeconds),
    timeoutMs: Number(timeoutMs),
  };
}

async function claimRefreshBudget(
  env: Env,
  installationId: string,
  budgetPerHour: number
): Promise<boolean> {
  const now = Date.now();
  const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
  await env.DATABASE.prepare(
    'INSERT OR IGNORE INTO pull_request_refresh_budget (installation_id, window_start, used) VALUES (?, ?, 0)'
  )
    .bind(installationId, windowStart)
    .run();
  const result = await env.DATABASE.prepare(
    `UPDATE pull_request_refresh_budget SET
       used = CASE WHEN window_start = ? THEN used + 1 ELSE 1 END,
       window_start = ?
     WHERE installation_id = ? AND blocked_until <= ?
       AND (window_start != ? OR used < ?)`
  )
    .bind(windowStart, windowStart, installationId, now, windowStart, budgetPerHour)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function refreshOne(
  env: Env,
  projectId: string,
  ref: ParsedPullRequestUrl,
  settings: Awaited<ReturnType<typeof refreshSettings>>
): Promise<void> {
  const project = await env.DATABASE.prepare(
    `SELECT gi.external_installation_id AS external_id, gi.installation_id AS stored_id
     FROM projects p JOIN github_installations gi ON gi.id = p.installation_id
     WHERE p.id = ? AND lower(p.repository) = ? AND p.repo_provider = 'github'`
  )
    .bind(projectId, ref.repository)
    .first<{ external_id: string | null; stored_id: string }>();
  if (!project) return;
  const installationId = project.external_id || project.stored_id;
  if (!(await claimRefreshBudget(env, installationId, settings.budgetPerHour))) return;
  const { token } = await getInstallationToken(installationId, env);
  const response = await fetch(
    `https://api.github.com/repos/${ref.repository.split('/').map(encodeURIComponent).join('/')}/pulls/${ref.number}`,
    {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
      },
      signal: AbortSignal.timeout(settings.timeoutMs),
    }
  );
  // Secondary limits may return 403 without either rate-limit header.
  if (response.status === 429 || response.status === 403) {
    const retry = Number(response.headers.get('retry-after'));
    const until =
      Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : settings.backoffSeconds) * 1000;
    await env.DATABASE.prepare(
      'UPDATE pull_request_refresh_budget SET blocked_until = max(blocked_until, ?) WHERE installation_id = ?'
    )
      .bind(until, installationId)
      .run();
    return;
  }
  if (!response.ok) return;
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const pr = body as Record<string, unknown>;
  const nested = (key: string): Record<string, unknown> => {
    const value = pr[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const createdAt = str(pr.created_at);
  const updatedAt = str(pr.updated_at);
  if (
    pr.number !== ref.number ||
    canonicalProjectPullRequestUrl(str(pr.html_url) ?? '', ref.repository) !== ref.url ||
    str(
      nested('base').repo && (nested('base').repo as Record<string, unknown>).full_name
    )?.toLowerCase() !== ref.repository ||
    !createdAt ||
    !updatedAt
  )
    return;
  await upsertPullRequestSnapshot(env, projectId, {
    ...ref,
    title: str(pr.title),
    state: refreshedState(pr),
    isDraft: pr.draft === true,
    headRef: str(nested('head').ref),
    headSha: str(nested('head').sha),
    baseRef: str(nested('base').ref),
    authorLogin: str(nested('user').login),
    mergedAt: str(pr.merged_at),
    closedAt: str(pr.closed_at),
    createdAt,
    updatedAt,
  });
}

/** Read stored state only; single-context callers may schedule refresh separately. */
export async function getPullRequestStates(
  ctx: OperationContext,
  projectId: string,
  refs: readonly Pick<PullRequestRef, 'url'>[],
  options: { refresh?: 'single' } = {}
): Promise<PullRequestStates> {
  const env = ctx.env;
  const result: PullRequestStates = {};
  if (refs.length === 0) return result;
  const project = await env.DATABASE.prepare('SELECT repository FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ repository: string }>();
  if (!project) return result;
  const ttlSeconds = Number(
    await resolveAdminSetting(env, 'operations.pullRequestRefreshTtlSeconds')
  );
  const settings = options.refresh === 'single' && ctx.execCtx ? await refreshSettings(env) : null;
  const parsedRefs = [
    ...new Map(
      refs
        .map((ref) => parseProjectPullRequestUrl(ref.url, project.repository))
        .filter((ref): ref is ParsedPullRequestUrl => ref !== null)
        .map((ref) => [ref.url, ref])
    ).values(),
  ];
  if (parsedRefs.length === 0) return result;
  const rows = await env.DATABASE.prepare(
    `SELECT url, state, is_draft, title, checks_state, merged_at, updated_at, last_synced_at
     FROM pull_requests WHERE project_id = ? AND url IN (SELECT value FROM json_each(?))`
  )
    .bind(projectId, JSON.stringify(parsedRefs.map((ref) => ref.url)))
    .all<{
      url: string;
      state: PullRequestState['state'];
      is_draft: number;
      title: string | null;
      checks_state: PullRequestState['checksState'];
      merged_at: string | null;
      updated_at: string;
      last_synced_at: string | null;
    }>();
  const byUrl = new Map(rows.results.map((row) => [row.url, row]));
  let scheduled = 0;
  for (const parsed of parsedRefs) {
    const row = byUrl.get(parsed.url);
    const stale =
      !row?.last_synced_at || Date.now() - Date.parse(row.last_synced_at) > ttlSeconds * 1000;
    result[parsed.url] = row?.last_synced_at
      ? {
          state: row.state,
          isDraft: Boolean(row.is_draft),
          title: row.title,
          checksState: row.checks_state,
          mergedAt: row.merged_at,
          updatedAt: row.updated_at,
          stale,
        }
      : null;
    if (settings && stale && ctx.execCtx && scheduled < settings.cap) {
      scheduled++;
      ctx.execCtx.waitUntil(
        refreshOne(env, projectId, parsed, settings).catch((error) => {
          log.warn('github.pr_refresh_failed', { projectId, error: String(error) });
        })
      );
    }
  }
  return result;
}
