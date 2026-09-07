/**
 * GitHub repo-id backfill service
 *
 * Durable fix for the git-token name-scoping stopgap (PR #1238). Legacy
 * GitHub-backed projects created before the numeric repo id was captured have
 * `projects.github_repo_id IS NULL`. Name-based token scoping is rename-fragile
 * and incompatible with custom GitHub CLI policies (which require the numeric id).
 *
 * This service fetches the stable numeric id (and node id + canonical full name)
 * from the GitHub API using an installation token and persists it. It is shared
 * by two callers:
 *   - Part A: lazy self-heal on the git-token mint path (runtime.ts) — heals a
 *     legacy project the first time it mints a token.
 *   - Part B: one-time bulk backfill for dormant projects (admin route).
 *
 * The UPDATE is idempotent: it only touches rows where `github_repo_id IS NULL`,
 * so it is safe to run concurrently and repeatedly.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getInstallationToken, getRepositoryMetadata } from './github-app';

/**
 * Default max projects healed per bulk-backfill invocation. Each project costs up
 * to two GitHub subrequests (token mint — cached per installation — plus a repo
 * metadata GET) and one D1 UPDATE, so this keeps a single invocation well under
 * the Workers 1000-subrequest / 30s limits. Override with
 * `GITHUB_REPO_ID_BACKFILL_BATCH_SIZE`. The backfill is idempotent (guarded by
 * `github_repo_id IS NULL`), so the admin re-runs until `hasMore` is false.
 */
const DEFAULT_BULK_BACKFILL_BATCH_SIZE = 50;
/** Emit a progress log every this many processed projects within a batch. */
const BULK_BACKFILL_PROGRESS_INTERVAL = 25;

export type BackfillStatus = 'backfilled' | 'skipped_no_repo' | 'skipped_collision' | 'fetch_failed';

export interface BackfillResult {
  status: BackfillStatus;
  /**
   * The numeric repo id when known. Populated for `backfilled` and
   * `skipped_collision` so a caller can scope the current token mint correctly
   * even when persistence was skipped. Null for `skipped_no_repo`/`fetch_failed`.
   */
  githubRepoId: number | null;
  githubRepoNodeId: string | null;
  /** Canonical `owner/repo` full name from GitHub, when fetched. */
  fullName: string | null;
}

/**
 * Fetch and persist `github_repo_id` (+ node id + canonical name) for a single
 * legacy GitHub-backed project.
 *
 * Never throws for the expected "can't heal this one" cases (repo inaccessible,
 * unparseable name, unique collision) — it returns a structured status so the
 * caller can decide whether to fall back to name-based scoping. Unexpected
 * database errors that are not unique-constraint collisions are rethrown.
 */
export async function backfillProjectGithubRepoId(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  params: {
    projectId: string;
    /** Stored repository, expected `owner/repo` full name. */
    repository: string;
    /** GitHub's external installation id (numeric, as a string). */
    externalInstallationId: string;
    /**
     * Optional pre-minted installation token. The bulk backfill mints one token
     * per installation and passes it here so each installation's repos share a
     * single token (avoids GitHub's installation-token rate limit). When omitted
     * (the lazy self-heal path), a token is minted on demand.
     */
    installationToken?: string;
  },
): Promise<BackfillResult> {
  const { projectId, repository, externalInstallationId, installationToken } = params;

  const slashIndex = repository.indexOf('/');
  const owner = slashIndex > 0 ? repository.slice(0, slashIndex) : null;
  const repo = slashIndex > 0 ? repository.slice(slashIndex + 1) : null;
  if (!owner || !repo) {
    log.warn('github_repo_id_backfill.skipped_no_repo', {
      projectId,
      externalInstallationId,
      reason: 'unparseable_repository',
    });
    return { status: 'skipped_no_repo', githubRepoId: null, githubRepoNodeId: null, fullName: null };
  }

  let metadata;
  try {
    metadata = await getRepositoryMetadata(externalInstallationId, owner, repo, env, installationToken);
  } catch (err) {
    log.warn('github_repo_id_backfill.fetch_failed', {
      projectId,
      externalInstallationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'fetch_failed', githubRepoId: null, githubRepoNodeId: null, fullName: null };
  }

  if (!metadata) {
    // 404/403 — repo deleted or no longer accessible to the installation.
    log.warn('github_repo_id_backfill.skipped_no_repo', {
      projectId,
      externalInstallationId,
      reason: 'repo_inaccessible',
    });
    return { status: 'skipped_no_repo', githubRepoId: null, githubRepoNodeId: null, fullName: null };
  }

  // Idempotent + race-safe: only heal rows still missing the id. Also refresh
  // `repository` to the canonical full name (handles a rename that happened while
  // the id was null).
  try {
    await db
      .update(schema.projects)
      .set({
        githubRepoId: metadata.id,
        githubRepoNodeId: metadata.nodeId,
        repository: metadata.fullName,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.githubRepoId)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A would-be unique collision can come from either the
    // (user_id, github_repo_id) index or the (user_id, installation_id, repository)
    // index when we update the canonical name. Skip persistence but still report
    // the id so the caller can scope correctly.
    if (/UNIQUE constraint failed/i.test(message)) {
      log.warn('github_repo_id_backfill.skipped_collision', {
        projectId,
        externalInstallationId,
        githubRepoId: metadata.id,
        error: message,
      });
      return {
        status: 'skipped_collision',
        githubRepoId: metadata.id,
        githubRepoNodeId: metadata.nodeId,
        fullName: metadata.fullName,
      };
    }
    throw err;
  }

  log.info('github_repo_id_backfill.backfilled', {
    projectId,
    externalInstallationId,
    githubRepoId: metadata.id,
  });
  return {
    status: 'backfilled',
    githubRepoId: metadata.id,
    githubRepoNodeId: metadata.nodeId,
    fullName: metadata.fullName,
  };
}

export interface BulkBackfillSummary {
  total: number;
  backfilled: number;
  skippedNoRepo: number;
  skippedCollision: number;
  fetchFailed: number;
  noInstallation: number;
  /**
   * True when the batch filled to its limit, so more dormant projects may remain.
   * The admin re-runs the route until this is false (the IS NULL guard makes each
   * run pick up the next batch).
   */
  hasMore: boolean;
}

/**
 * One-time (re-runnable) bulk backfill over dormant legacy GitHub-backed projects
 * (`repo_provider = 'github' AND github_repo_id IS NULL`). Processes at most
 * `limit` projects per invocation so a single Workers request stays under the
 * 1000-subrequest / 30s limits; mints one installation token per installation and
 * reuses it across that installation's repos (GitHub rate-limits installation-token
 * creation). A single failing/inaccessible repo is skipped + logged and does NOT
 * abort the batch. The UPDATE is guarded by `github_repo_id IS NULL`, so re-running
 * picks up the next batch — the admin re-runs until `summary.hasMore` is false.
 */
export async function bulkBackfillGithubRepoIds(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  options?: { limit?: number },
): Promise<BulkBackfillSummary> {
  const configuredDefault = Number.parseInt(env.GITHUB_REPO_ID_BACKFILL_BATCH_SIZE ?? '', 10);
  const defaultLimit =
    Number.isFinite(configuredDefault) && configuredDefault > 0
      ? configuredDefault
      : DEFAULT_BULK_BACKFILL_BATCH_SIZE;
  const limit = options?.limit && options.limit > 0 ? options.limit : defaultLimit;

  const rows = await db
    .select({
      projectId: schema.projects.id,
      repository: schema.projects.repository,
      installationId: schema.projects.installationId,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.repoProvider, 'github'), isNull(schema.projects.githubRepoId)))
    .limit(limit);

  const summary: BulkBackfillSummary = {
    total: rows.length,
    backfilled: 0,
    skippedNoRepo: 0,
    skippedCollision: 0,
    fetchFailed: 0,
    noInstallation: 0,
    hasMore: rows.length === limit,
  };

  // Cache external installation ids so we don't re-query per project.
  const externalInstallationCache = new Map<string, string | null>();
  // Cache one installation token per external installation id for the lifetime of
  // this batch — minting one token per repo would hit GitHub's installation-token
  // rate limit on installations with many dormant projects. `null` records a mint
  // failure so we don't retry it for every project under that installation.
  const installationTokenCache = new Map<string, string | null>();

  async function resolveExternalInstallationId(installationId: string): Promise<string | null> {
    const cached = externalInstallationCache.get(installationId);
    if (cached !== undefined) {
      return cached;
    }
    const installRows = await db
      .select({ externalInstallationId: schema.githubInstallations.externalInstallationId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.id, installationId))
      .limit(1);
    const external = installRows[0]?.externalInstallationId ?? null;
    externalInstallationCache.set(installationId, external);
    return external;
  }

  async function resolveInstallationToken(externalInstallationId: string): Promise<string | null> {
    const cached = installationTokenCache.get(externalInstallationId);
    if (cached !== undefined) {
      return cached;
    }
    let token: string | null = null;
    try {
      ({ token } = await getInstallationToken(externalInstallationId, env));
    } catch (err) {
      token = null;
      log.warn('github_repo_id_backfill.bulk_token_mint_failed', {
        externalInstallationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    installationTokenCache.set(externalInstallationId, token);
    return token;
  }

  let processed = 0;
  for (const row of rows) {
    processed++;
    if (!row.installationId) {
      summary.noInstallation++;
      log.warn('github_repo_id_backfill.bulk_skip_no_installation', { projectId: row.projectId });
      continue;
    }

    const externalInstallationId = await resolveExternalInstallationId(row.installationId);
    if (!externalInstallationId) {
      summary.noInstallation++;
      log.warn('github_repo_id_backfill.bulk_skip_no_installation', {
        projectId: row.projectId,
        installationId: row.installationId,
      });
      continue;
    }

    const installationToken = await resolveInstallationToken(externalInstallationId);
    if (!installationToken) {
      // Could not mint a token for this installation — treat as a transient fetch
      // failure so a re-run retries it (the row stays IS NULL).
      summary.fetchFailed++;
      continue;
    }

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: row.projectId,
      repository: row.repository,
      externalInstallationId,
      installationToken,
    });

    switch (result.status) {
      case 'backfilled':
        summary.backfilled++;
        break;
      case 'skipped_no_repo':
        summary.skippedNoRepo++;
        break;
      case 'skipped_collision':
        summary.skippedCollision++;
        break;
      case 'fetch_failed':
        summary.fetchFailed++;
        break;
    }

    if (processed % BULK_BACKFILL_PROGRESS_INTERVAL === 0) {
      log.info('github_repo_id_backfill.bulk_progress', {
        processed,
        total: summary.total,
        backfilled: summary.backfilled,
      });
    }
  }

  log.info('github_repo_id_backfill.bulk_complete', { ...summary });
  return summary;
}
