/**
 * GitHub personal-installation leak-row sweep service
 *
 * PR #1236 added a personal-install owner guard to the OAuth/sync discovery path
 * (and this branch adds the same guard to the webhook `installation.created`
 * path) so that a SAM user can only own a GitHub *personal* installation whose
 * account identity matches their own GitHub identity.
 *
 * Those guards stop NEW leaked rows. This service is the one-time (re-runnable)
 * reconciliation for residual rows that were inserted before the guards existed:
 * personal `github_installations` rows whose installation's true GitHub account
 * id does NOT match the owning user's `github_id`. It generalizes two manual prod
 * DELETEs (rows `01KTEWYMY2QASTZRD78XD3B673`, `01KTF1PY8D4NBQPGA7WHCFW1DZ`).
 *
 * Why this cannot be pure SQL: the `users` table stores `github_id` (numeric)
 * but no login, and `github_installation_accounts` stores the login but no
 * numeric account id. There is no in-DB way to compare an installation's true
 * GitHub account identity against the owning user's GitHub identity. Detection
 * requires resolving the installation's account via the GitHub App API
 * (`getInstallationAccount`) and comparing its numeric id to the owning user's
 * `github_id`.
 *
 * CASCADE safety (rule 31): `projects.installation_id` references
 * `github_installations.id` with `ON DELETE CASCADE`, so deleting an installation
 * row cascade-deletes its projects (and downstream tasks/triggers). Any
 * personal row referenced by a project is therefore SKIPPED (counted as
 * `skippedReferenced`) and surfaced in the summary rather than silently
 * destroying project data. Deletes are scoped `DELETE ... WHERE id = ? AND
 * user_id = ?` — never `DROP TABLE`.
 */
import { and, eq, gt } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { generateAppJWT, getInstallationAccount } from './github-app';
import { getExternalInstallationId } from './github-installation-ids';

/**
 * Default max personal installations checked per sweep invocation. Each row costs
 * one GitHub subrequest (resolve the installation account) plus a couple of D1
 * reads/writes, so this keeps a single Workers request well under the
 * 1000-subrequest / 30s limits. Override with
 * `GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE`.
 */
const DEFAULT_LEAK_SWEEP_BATCH_SIZE = 50;
/** Emit a progress log every this many processed rows within a batch. */
const LEAK_SWEEP_PROGRESS_INTERVAL = 25;

export interface LeakSweepSummary {
  /** Personal installation rows examined in this batch. */
  total: number;
  /** Confirmed-mismatched personal rows deleted. */
  deleted: number;
  /** Personal rows whose account matched the owning user (kept). */
  matched: number;
  /** Mismatched personal rows SKIPPED because a project references them (cascade guard). */
  skippedReferenced: number;
  /** Rows whose owning user is missing or has no `github_id` (cannot compare). */
  noUser: number;
  /** Rows whose installation account could not be resolved (404 / no account / no numeric id). */
  accountUnresolved: number;
  /** Rows whose account fetch threw (transient — a re-run retries them). */
  fetchFailed: number;
  /**
   * True when the batch filled to its limit, so more personal rows may remain.
   * Re-run the route with `afterId = nextCursor` until this is false. A cursor is
   * used (not a plain offset) because matched/skipped rows are NOT removed, so an
   * offset would either loop forever or skip rows after deletions.
   */
  hasMore: boolean;
  /** Highest `github_installations.id` processed in this batch; pass as `afterId` to continue. */
  nextCursor: string | null;
}

/**
 * One-time (re-runnable) sweep over personal `github_installations` rows. Processes
 * at most `limit` rows per invocation (cursor-paginated by `id`) so a single
 * Workers request stays under the subrequest/time limits. A single failing
 * account resolution is skipped + logged and does NOT abort the batch.
 *
 * Idempotent: matched/skipped rows are left untouched, and deletes are scoped by
 * `(id, userId)`. Re-running with `afterId = summary.nextCursor` advances through
 * the table; the admin re-runs until `summary.hasMore` is false.
 */
export async function bulkSweepMismatchedPersonalInstallations(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  options?: { limit?: number; afterId?: string }
): Promise<LeakSweepSummary> {
  const configuredDefault = Number.parseInt(
    env.GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE ?? '',
    10
  );
  const defaultLimit =
    Number.isFinite(configuredDefault) && configuredDefault > 0
      ? configuredDefault
      : DEFAULT_LEAK_SWEEP_BATCH_SIZE;
  const limit = options?.limit && options.limit > 0 ? options.limit : defaultLimit;
  const afterId = options?.afterId;

  const personalFilter = eq(schema.githubInstallations.accountType, 'personal');
  const rows = await db
    .select({
      id: schema.githubInstallations.id,
      userId: schema.githubInstallations.userId,
      installationId: schema.githubInstallations.installationId,
      externalInstallationId: schema.githubInstallations.externalInstallationId,
      accountName: schema.githubInstallations.accountName,
    })
    .from(schema.githubInstallations)
    .where(
      afterId
        ? and(personalFilter, gt(schema.githubInstallations.id, afterId))
        : personalFilter
    )
    .orderBy(schema.githubInstallations.id)
    .limit(limit);

  const summary: LeakSweepSummary = {
    total: rows.length,
    deleted: 0,
    matched: 0,
    skippedReferenced: 0,
    noUser: 0,
    accountUnresolved: 0,
    fetchFailed: 0,
    hasMore: rows.length === limit,
    nextCursor: rows[rows.length - 1]?.id ?? null,
  };

  // Cache the owning user's github_id by userId so we don't re-query per row.
  const userGithubIdCache = new Map<string, string | null>();
  async function resolveUserGithubId(userId: string): Promise<string | null> {
    const cached = userGithubIdCache.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const userRows = await db
      .select({ githubId: schema.users.githubId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const githubId = userRows[0]?.githubId ?? null;
    userGithubIdCache.set(userId, githubId);
    return githubId;
  }

  // Mint one app JWT for the whole batch. The token is valid for 10 minutes,
  // and each row would otherwise re-import the RSA key + re-sign a JWT inside
  // getInstallationAccount. Amortizing it keeps a 50-row batch to one key import.
  const appJwt = await generateAppJWT(env);

  let processed = 0;
  for (const row of rows) {
    processed++;

    const userGithubId = await resolveUserGithubId(row.userId);
    if (!userGithubId) {
      summary.noUser++;
      log.warn('github.installation_leak_sweep.no_user_github_id', {
        installationRowId: row.id,
        userId: row.userId,
      });
      continue;
    }

    // Resolve the installation's true GitHub account identity.
    const externalInstallationId = getExternalInstallationId({
      installationId: row.installationId,
      externalInstallationId: row.externalInstallationId,
    });
    let account;
    try {
      account = await getInstallationAccount(externalInstallationId, env, appJwt);
    } catch (err) {
      summary.fetchFailed++;
      log.warn('github.installation_leak_sweep.account_fetch_failed', {
        installationRowId: row.id,
        externalInstallationId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!account || account.id == null) {
      summary.accountUnresolved++;
      log.warn('github.installation_leak_sweep.account_unresolved', {
        installationRowId: row.id,
        externalInstallationId,
      });
      continue;
    }

    // Match: the row legitimately belongs to this user — keep it.
    if (String(account.id) === userGithubId) {
      summary.matched++;
      continue;
    }

    // Mismatch confirmed. Reference guard: never delete a row another table still
    // references, or we either cascade-delete a project (projects.installation_id
    // is ON DELETE CASCADE -> tasks/triggers) or leave a workspace with a dangling
    // installation_id FK (workspaces.installation_id has no ON DELETE action and
    // SQLite FK enforcement is off in migrations). Surface instead of destroying.
    const referencingProjects = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.installationId, row.id))
      .limit(1);
    const referencingWorkspaces = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.installationId, row.id))
      .limit(1);
    if (referencingProjects.length > 0 || referencingWorkspaces.length > 0) {
      summary.skippedReferenced++;
      log.warn('github.installation_leak_sweep.skipped_referenced', {
        installationRowId: row.id,
        userId: row.userId,
        accountId: String(account.id),
        userGithubId,
        referencedBy: referencingProjects.length > 0 ? 'project' : 'workspace',
      });
      continue;
    }

    await db
      .delete(schema.githubInstallations)
      .where(
        and(
          eq(schema.githubInstallations.id, row.id),
          eq(schema.githubInstallations.userId, row.userId)
        )
      );
    summary.deleted++;
    log.info('github.installation_leak_sweep.deleted_mismatched_personal', {
      installationRowId: row.id,
      userId: row.userId,
      accountId: String(account.id),
      userGithubId,
    });

    if (processed % LEAK_SWEEP_PROGRESS_INTERVAL === 0) {
      log.info('github.installation_leak_sweep.progress', {
        processed,
        total: summary.total,
        deleted: summary.deleted,
      });
    }
  }

  log.info('github.installation_leak_sweep.complete', { ...summary });
  return summary;
}
