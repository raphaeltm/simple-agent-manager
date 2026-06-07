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
import { getRepositoryMetadata } from './github-app';

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
  },
): Promise<BackfillResult> {
  const { projectId, repository, externalInstallationId } = params;

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
    metadata = await getRepositoryMetadata(externalInstallationId, owner, repo, env);
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
    if (/SQLITE_CONSTRAINT|UNIQUE/i.test(message)) {
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
}

/**
 * One-time bulk backfill over every dormant legacy GitHub-backed project
 * (`repo_provider = 'github' AND github_repo_id IS NULL`). Groups rows by
 * installation so each installation token is minted once, and processes one
 * project at a time. A single failing/inaccessible repo is skipped + logged and
 * does NOT abort the batch.
 */
export async function bulkBackfillGithubRepoIds(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
): Promise<BulkBackfillSummary> {
  const rows = await db
    .select({
      projectId: schema.projects.id,
      repository: schema.projects.repository,
      installationId: schema.projects.installationId,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.repoProvider, 'github'), isNull(schema.projects.githubRepoId)));

  const summary: BulkBackfillSummary = {
    total: rows.length,
    backfilled: 0,
    skippedNoRepo: 0,
    skippedCollision: 0,
    fetchFailed: 0,
    noInstallation: 0,
  };

  // Cache external installation ids so we don't re-query per project.
  const externalInstallationCache = new Map<string, string | null>();

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

  for (const row of rows) {
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

    const result = await backfillProjectGithubRepoId(db, env, {
      projectId: row.projectId,
      repository: row.repository,
      externalInstallationId,
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
  }

  log.info('github_repo_id_backfill.bulk_complete', { ...summary });
  return summary;
}
