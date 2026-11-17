/**
 * Review request cycles for Insights · People "review pickup time" (slice P, migration 0257). The
 * GitHub webhook ingest calls this for three deliveries the App already subscribes to:
 *
 * - `pull_request.review_requested`: open a cycle for that reviewer, unless one is open already.
 * - `pull_request.review_request_removed`: close the open cycle as removed (it is not a pickup).
 * - `pull_request_review.submitted`: stamp the first review on the reviewer's open cycle, and on
 *   the pull request's open team cycles (GitHub does not say which team a reviewer answered for,
 *   so the first review by anyone but the author picks up a team request).
 * - `pull_request.closed`: close the pull request's open cycles as removed (never picked up).
 *
 * Known limits, accepted because they are rare and only skew a statistic: GitHub does not order
 * deliveries, so a `review_requested` delivered after its review (or after its removal) opens a
 * cycle that only a later review or the pull request closing ends; and of two requests to one
 * reviewer racing in, the first to commit keeps its time.
 *
 * Times are GitHub's (`pull_request.updated_at`, `review.submitted_at`), never the delivery time,
 * so a redelivery writes the same values: every statement is idempotent. Bots are skipped: the tab
 * is about where work waits on people. Every statement binds the project (rule 11).
 *
 * A failure is logged and swallowed. These rows only feed a statistic, and the same webhook
 * request still has to persist trigger intake for `pull_request_review` automations.
 */
import { parseProjectPullRequestUrl } from '@simple-agent-manager/operations';

import type { Env } from '../env';
import { log } from '../lib/logger';
import type { GitHubProjectCandidate } from './github-project-repositories';

type ReviewerKind = 'user' | 'team';

interface Reviewer {
  kind: ReviewerKind;
  key: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function isoOf(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The requested reviewer of a `review_requested` / `review_request_removed` delivery. */
function requestedReviewer(payload: Record<string, unknown>): Reviewer | null {
  const user = record(payload.requested_reviewer);
  if (user) {
    const login = string(user.login);
    if (!login || user.type === 'Bot') return null;
    return { kind: 'user', key: login.toLowerCase() };
  }
  const slug = string(record(payload.requested_team)?.slug);
  return slug ? { kind: 'team', key: slug.toLowerCase() } : null;
}

const OPEN_CYCLE_SQL = `first_review_at IS NULL AND removed_at IS NULL`;

/** The deliveries this module records; `ingestPullRequestWebhook` routes only these here. */
export function isReviewCycleDelivery(event: string, action: unknown): boolean {
  if (event === 'pull_request')
    return (
      action === 'review_requested' || action === 'review_request_removed' || action === 'closed'
    );
  return event === 'pull_request_review' && action === 'submitted';
}

/**
 * Called only after the webhook signature was verified by the route. Never throws: a failure is
 * logged and the delivery's other work (pull request state, trigger intake) goes on.
 */
export async function ingestPullRequestReviewWebhook(
  env: Env,
  event: string,
  repositoryFullName: string,
  projects: GitHubProjectCandidate[],
  payload: Record<string, unknown>
): Promise<void> {
  const action = string(payload.action);
  try {
    const statements = reviewCycleStatements(
      env,
      event,
      action,
      repositoryFullName,
      payload,
      projects
    );
    if (statements.length > 0) await env.DATABASE.batch(statements);
  } catch (error) {
    log.error('github_review_requests.ingest_failed', {
      repository: repositoryFullName,
      event,
      githubAction: action,
      projectIds: projects.map((project) => project.id),
      error: error instanceof Error ? error.message : String(error),
      action: 'dropped',
    });
  }
}

function reviewCycleStatements(
  env: Env,
  event: string,
  action: string | null,
  repositoryFullName: string,
  payload: Record<string, unknown>,
  projects: GitHubProjectCandidate[]
): D1PreparedStatement[] {
  const pr = record(payload.pull_request);
  const url = string(pr?.html_url);
  const number = typeof pr?.number === 'number' ? pr.number : null;
  if (!url || !number) return [];
  const parsed = parseProjectPullRequestUrl(url, repositoryFullName);
  if (parsed?.number !== number) return [];
  const target = { repository: parsed.repository, number };

  let write: ((projectId: string) => D1PreparedStatement) | null = null;
  if (event === 'pull_request' && action === 'closed') {
    // A request still open when the pull request closed (merged or not) was never picked up.
    const at = isoOf(pr?.closed_at) ?? isoOf(pr?.updated_at);
    if (!at) return [];
    write = (projectId) => closePullRequestCycles(env, projectId, target, at);
  } else if (
    event === 'pull_request' &&
    (action === 'review_requested' || action === 'review_request_removed')
  ) {
    const reviewer = requestedReviewer(payload);
    const at = isoOf(pr?.updated_at);
    if (!reviewer || !at) return [];
    write =
      action === 'review_requested'
        ? (projectId) => openCycle(env, projectId, target, reviewer, at)
        : (projectId) => removeCycle(env, projectId, target, reviewer, at);
  } else if (event === 'pull_request_review' && action === 'submitted') {
    const review = record(payload.review);
    const reviewerUser = record(review?.user);
    const login = string(reviewerUser?.login)?.toLowerCase() ?? null;
    const at = isoOf(review?.submitted_at);
    if (!login || !at || reviewerUser?.type === 'Bot') return [];
    const author = string(record(pr?.user)?.login)?.toLowerCase() ?? null;
    write = (projectId) => recordReview(env, projectId, target, login, login === author, at);
  }
  if (!write) return [];
  const statement = write;
  return projects.map((project) => statement(project.id));
}

interface Target {
  repository: string;
  number: number;
}

function openCycle(
  env: Env,
  projectId: string,
  target: Target,
  reviewer: Reviewer,
  requestedAt: string
): D1PreparedStatement {
  // A re-request while one is still open keeps the earlier time: the reviewer has been waited on
  // since then. After a review, the next request opens a new cycle. The primary key makes a
  // redelivery of a closed cycle's request a no-op.
  return env.DATABASE.prepare(
    `INSERT INTO pull_request_review_requests
       (project_id, repository, pr_number, reviewer_kind, reviewer_key, requested_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM pull_request_review_requests
        WHERE project_id = ? AND repository = ? AND pr_number = ? AND reviewer_kind = ?
          AND reviewer_key = ? AND ${OPEN_CYCLE_SQL})
     ON CONFLICT DO NOTHING`
  ).bind(
    projectId,
    target.repository,
    target.number,
    reviewer.kind,
    reviewer.key,
    requestedAt,
    projectId,
    target.repository,
    target.number,
    reviewer.kind,
    reviewer.key
  );
}

function removeCycle(
  env: Env,
  projectId: string,
  target: Target,
  reviewer: Reviewer,
  removedAt: string
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `UPDATE pull_request_review_requests SET removed_at = ?
      WHERE project_id = ? AND repository = ? AND pr_number = ? AND reviewer_kind = ?
        AND reviewer_key = ? AND ${OPEN_CYCLE_SQL} AND requested_at <= ?`
  ).bind(
    removedAt,
    projectId,
    target.repository,
    target.number,
    reviewer.kind,
    reviewer.key,
    removedAt
  );
}

function closePullRequestCycles(
  env: Env,
  projectId: string,
  target: Target,
  closedAt: string
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `UPDATE pull_request_review_requests SET removed_at = ?
      WHERE project_id = ? AND repository = ? AND pr_number = ? AND ${OPEN_CYCLE_SQL}
        AND requested_at <= ?`
  ).bind(closedAt, projectId, target.repository, target.number, closedAt);
}

function recordReview(
  env: Env,
  projectId: string,
  target: Target,
  login: string,
  byAuthor: boolean,
  submittedAt: string
): D1PreparedStatement {
  // The author's own review comment answers no one's request, so it closes no team cycle.
  return env.DATABASE.prepare(
    `UPDATE pull_request_review_requests SET first_review_at = ?
      WHERE project_id = ? AND repository = ? AND pr_number = ? AND ${OPEN_CYCLE_SQL}
        AND requested_at <= ?
        AND ((reviewer_kind = 'user' AND reviewer_key = ?) OR (reviewer_kind = 'team' AND ? = 0))`
  ).bind(
    submittedAt,
    projectId,
    target.repository,
    target.number,
    submittedAt,
    login,
    byAuthor ? 1 : 0
  );
}
