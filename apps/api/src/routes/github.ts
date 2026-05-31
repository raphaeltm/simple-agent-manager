import type { GitHubInstallation, Repository } from '@simple-agent-manager/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, optionalAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getAuthenticatedUserOrganizations,
  getInstallationRepositories,
  getRepositoryBranches,
  getUserAccessibleInstallations,
  verifyUserInstallationAccess,
} from '../services/github-app';
import {
  getCanonicalAccountInput,
  type GitHubDb,
  type GitHubInstallationAccountRow,
  normalizeAccountType,
  upsertCanonicalInstallationAccount,
} from '../services/github-installation-accounts';
import {
  getExternalInstallationId,
  getStoredInstallationId,
} from '../services/github-installation-ids';
import {
  isDatabaseConflictError,
  summarizeAccessibleInstallations,
  summarizeInstallationRows,
} from '../services/github-route-helpers';
import { getGitHubUserAccessToken } from '../services/github-user-access-token';
import { handleGitHubWebhook } from './github-webhook';

const githubRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/github/installations - List user's GitHub App installations
 *
 * Syncs installations from GitHub on each request so that users see every
 * installation their authenticated GitHub account can access.
 */
githubRoutes.get('/installations', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Sync: discover installations the user can access but doesn't have a DB record for
  const accessToken = await getGitHubUserAccessToken(c, userId);
  log.info('github.installations_sync.token_status', {
    userId,
    tokenPresent: Boolean(accessToken),
  });
  if (accessToken) {
    await syncUserInstallations(db, userId, accessToken);
  }

  const installations = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  const response: GitHubInstallation[] = installations.map((inst) => ({
    id: inst.id,
    userId: inst.userId,
    installationId: getExternalInstallationId(inst),
    accountType: inst.accountType as 'personal' | 'organization',
    accountName: inst.accountName,
    createdAt: inst.createdAt,
    updatedAt: inst.updatedAt,
  }));

  return c.json(response);
});

/**
 * GET /api/github/install-url - Get GitHub App installation URL
 * Requires GITHUB_APP_SLUG env var per constitution principle XI (no hardcoded values).
 */
githubRoutes.get('/install-url', requireAuth(), requireApproved(), async (c) => {
  // The app slug must be configured via environment variable
  const appSlug = c.env.GITHUB_APP_SLUG;
  if (!appSlug) {
    throw errors.internal('GITHUB_APP_SLUG environment variable not configured');
  }
  const url = `https://github.com/apps/${appSlug}/installations/new`;
  return c.json({ url });
});

/** GET /api/github/repositories - List repositories from installations */
githubRoutes.get('/repositories', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const installationRowId = c.req.query('installation_id');
  const db = drizzle(c.env.DATABASE, { schema });

  // Get user's installations
  const installations = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  if (installations.length === 0) {
    return c.json({ repositories: [] });
  }

  // Filter by installation if specified (match by DB row ID, consistent with branches endpoint)
  const targetInstallations = installationRowId
    ? installations.filter((i) => i.id === installationRowId)
    : installations;

  if (targetInstallations.length === 0) {
    throw errors.notFound('Installation');
  }

  // Fetch repositories from all installations in parallel
  const repoResults = await Promise.allSettled(
    targetInstallations.map(async (inst) => {
      const repos = await getInstallationRepositories(getExternalInstallationId(inst), c.env);
      return repos.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        name: repo.fullName.split('/').pop() || repo.fullName,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        installationId: inst.id,
      }));
    })
  );

  const allRepos: Repository[] = [];
  const failedInstallations: string[] = [];
  for (let i = 0; i < repoResults.length; i++) {
    const result = repoResults[i]!;
    if (result.status === 'fulfilled') {
      allRepos.push(...result.value);
    } else {
      const inst = targetInstallations[i]!;
      log.error('github.get_repos_failed', {
        accountName: inst.accountName,
        installationId: inst.id,
        error: String(result.reason),
      });
      failedInstallations.push(inst.accountName);
    }
  }

  return c.json({
    repositories: allRepos,
    ...(failedInstallations.length > 0 && { failedInstallations }),
  });
});

/**
 * GET /api/github/branches - List branches for a repository
 * Query params: repository (full name like owner/repo), installation_id (DB row id)
 */
githubRoutes.get('/branches', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const repoFullName = c.req.query('repository');
  const installationRowId = c.req.query('installation_id');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!repoFullName) {
    throw errors.badRequest('repository query parameter is required');
  }

  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw errors.badRequest('repository must be in owner/repo format');
  }
  const [owner, repo] = parts;

  // Get user's installations
  const installations = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  if (installations.length === 0) {
    throw errors.notFound('No GitHub installations found');
  }

  // Use the specified installation or find the one that has access
  const targetInstallation = installationRowId
    ? installations.find((i) => i.id === installationRowId)
    : installations[0];

  if (!targetInstallation) {
    throw errors.notFound('Installation');
  }

  // Validate the repository owner matches the installation's account.
  // Prevents using the installation token to enumerate arbitrary repositories.
  // See SSRF-VULN-03 in Shannon security assessment.
  if (owner!.toLowerCase() !== targetInstallation.accountName.toLowerCase()) {
    throw errors.forbidden(
      `Repository owner "${owner}" does not match installation account "${targetInstallation.accountName}"`
    );
  }

  try {
    const defaultBranch = c.req.query('default_branch') || undefined;
    const branches = await getRepositoryBranches(
      getExternalInstallationId(targetInstallation),
      owner!,
      repo!,
      c.env,
      defaultBranch
    );
    return c.json(branches);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('github.list_branches_failed', { repository: repoFullName, error: message });
    throw errors.internal(`Failed to list branches: ${message}`);
  }
});

githubRoutes.post('/webhook', handleGitHubWebhook);

/** GET /api/github/callback - Handle callback after GitHub App installation */
githubRoutes.get('/callback', optionalAuth(), async (c) => {
  const installationId = c.req.query('installation_id');
  const settingsUrl = `https://app.${c.env.BASE_DOMAIN}/settings`;
  const auth = c.get('auth');

  log.info('github.installation_callback.received', {
    userId: auth?.user.id,
    authenticated: Boolean(auth),
    installationId: installationId ?? null,
  });

  if (!installationId) {
    return c.redirect(settingsUrl);
  }

  if (!auth) {
    // User not logged in — redirect to login, preserving installation_id
    log.warn('github.installation_callback.unauthenticated', {
      authenticated: false,
      installationId,
    });
    return c.redirect(`https://app.${c.env.BASE_DOMAIN}/?installation_id=${installationId}`);
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Check if this user already has a record for this installation
  const existing = await db
    .select()
    .from(schema.githubInstallations)
    .where(
      and(
        or(
          eq(schema.githubInstallations.installationId, installationId),
          eq(schema.githubInstallations.externalInstallationId, installationId)
        ),
        eq(schema.githubInstallations.userId, auth.user.id)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const existingInstallation = existing[0]!;
    await upsertCanonicalInstallationAccount(
      db,
      {
        installationId,
        accountType: normalizeAccountType(existingInstallation.accountType),
        accountName: existingInstallation.accountName,
      },
      now
    );
    log.info('github.installation_callback.insert_result', {
      userId: auth.user.id,
      installationId,
      result: 'conflict',
      reason: 'already_exists',
    });
    return c.redirect(`${settingsUrl}?github_app=installed`);
  }

  // Verify the setup callback's installation_id against the authenticated
  // GitHub user's accessible installations before saving it.
  let insertAttempted = false;
  try {
    const accessToken = await getGitHubUserAccessToken(c, auth.user.id);
    log.info('github.installation_callback.token_status', {
      userId: auth.user.id,
      installationId,
      tokenPresent: Boolean(accessToken),
    });
    if (!accessToken) {
      return c.redirect(`${settingsUrl}?github_app=error&reason=github_user_token_unavailable`);
    }

    const accessibleInstallations = await getUserAccessibleInstallations(accessToken, {
      flow: 'callback',
      userId: auth.user.id,
      installationId,
    });
    log.info('github.installation_callback.accessible_installations', {
      userId: auth.user.id,
      installationId,
      installationCount: accessibleInstallations.length,
      installations: summarizeAccessibleInstallations(accessibleInstallations),
    });
    const accessibleInstallation = accessibleInstallations.find(
      (inst) => String(inst.id) === installationId
    );
    log.info('github.installation_callback.installation_match', {
      userId: auth.user.id,
      installationId,
      found: Boolean(accessibleInstallation),
    });
    if (!accessibleInstallation) {
      log.warn('github.installation_not_accessible_to_user', {
        installationId,
        userId: auth.user.id,
      });
      return c.redirect(`${settingsUrl}?github_app=error&reason=installation_not_accessible`);
    }

    insertAttempted = true;
    const canonicalAccount = getCanonicalAccountInput(
      installationId,
      accessibleInstallation.account.type,
      accessibleInstallation.account.login
    );
    await upsertCanonicalInstallationAccount(db, canonicalAccount, now);
    await db.insert(schema.githubInstallations).values({
      id: ulid(),
      userId: auth.user.id,
      installationId: getStoredInstallationId(auth.user.id, installationId),
      externalInstallationId: installationId,
      accountType: canonicalAccount.accountType,
      accountName: canonicalAccount.accountName,
      createdAt: now,
      updatedAt: now,
    });
    log.info('github.installation_callback.insert_result', {
      userId: auth.user.id,
      installationId,
      result: 'success',
      accountName: accessibleInstallation.account.login,
      accountType: accessibleInstallation.account.type,
    });

    return c.redirect(`${settingsUrl}?github_app=installed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (insertAttempted) {
      const result = isDatabaseConflictError(err) ? 'conflict' : 'error';
      const details = {
        userId: auth.user.id,
        installationId,
        result,
        error: message,
      };
      if (result === 'conflict') {
        log.warn('github.installation_callback.insert_result', details);
      } else {
        log.error('github.installation_callback.insert_result', details);
      }
    } else {
      log.error('github.installation_callback.failed', {
        userId: auth.user.id,
        installationId,
        error: message,
      });
    }
    const reason = insertAttempted ? 'installation_save_failed' : 'installation_lookup_failed';
    return c.redirect(`${settingsUrl}?github_app=error&reason=${reason}`);
  }
});

/**
 * DELETE /api/github/installations/:id - Remove an installation
 */
githubRoutes.delete('/installations/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const installationId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // Per-user unlink only. Do not delete/tombstone
  // `github_installation_accounts`: canonical org installation state is shared
  // and must survive account deletion or unlink by any one SAM user.
  const result = await db
    .delete(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, installationId),
        eq(schema.githubInstallations.userId, userId)
      )
    )
    .returning();

  if (result.length === 0) {
    throw errors.notFound('Installation');
  }

  return c.json({ success: true });
});

/**
 * Sync GitHub App installations for a user.
 *
 * Fetches installations in user context, then creates any missing per-user
 * records for installations the authenticated GitHub account can access.
 */
async function syncUserInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string
): Promise<void> {
  await syncDirectUserInstallations(db, userId, accessToken);
  await syncSharedOrgInstallations(db, userId, accessToken);
}

async function syncDirectUserInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string
): Promise<void> {
  try {
    log.info('github.installations_sync.token_status', {
      userId,
      tokenPresent: Boolean(accessToken),
    });

    // User-context GitHub verification: only sync installations the
    // authenticated GitHub user can access.
    const accessibleInstallations = await getUserAccessibleInstallations(accessToken, {
      flow: 'sync',
      userId,
    });
    log.info('github.installations_sync.accessible_installations', {
      userId,
      installationCount: accessibleInstallations.length,
      installations: summarizeAccessibleInstallations(accessibleInstallations),
    });
    if (accessibleInstallations.length === 0) return;

    const now = new Date().toISOString();
    for (const inst of accessibleInstallations) {
      await upsertCanonicalInstallationAccount(
        db,
        getCanonicalAccountInput(String(inst.id), inst.account.type, inst.account.login),
        now
      );
    }

    // Get user's existing installation records
    const existingRecords = await db
      .select({
        installationId: schema.githubInstallations.installationId,
        externalInstallationId: schema.githubInstallations.externalInstallationId,
      })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, userId));

    const existingInstallationIds = new Set(
      existingRecords.map((record) => getExternalInstallationId(record))
    );

    const missingInstallations = accessibleInstallations.filter(
      (inst) => !existingInstallationIds.has(String(inst.id))
    );

    log.info('github.installations_sync.missing_installations', {
      userId,
      missingInstallationCount: missingInstallations.length,
      installations: summarizeAccessibleInstallations(missingInstallations),
    });

    if (missingInstallations.length === 0) return;

    for (const inst of missingInstallations) {
      try {
        const canonicalAccount = getCanonicalAccountInput(
          String(inst.id),
          inst.account.type,
          inst.account.login
        );
        await db.insert(schema.githubInstallations).values({
          id: ulid(),
          userId,
          installationId: getStoredInstallationId(userId, String(inst.id)),
          externalInstallationId: String(inst.id),
          accountType: canonicalAccount.accountType,
          accountName: canonicalAccount.accountName,
          createdAt: now,
          updatedAt: now,
        });
        log.info('github.installations_sync.insert_result', {
          userId,
          installationId: String(inst.id),
          result: 'success',
          accountName: inst.account.login,
          accountType: inst.account.type,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = isDatabaseConflictError(err) ? 'conflict' : 'error';
        const details = {
          userId,
          installationId: String(inst.id),
          result,
          accountName: inst.account.login,
          accountType: inst.account.type,
          error: message,
        };
        if (result === 'conflict') {
          log.warn('github.installations_sync.insert_result', details);
        } else {
          log.error('github.installations_sync.insert_result', details);
        }
      }
    }
  } catch (err) {
    log.error('github.sync_installations_failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function syncSharedOrgInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string
): Promise<void> {
  try {
    const organizations = await getAuthenticatedUserOrganizations(accessToken, {
      flow: 'shared-org-discovery',
      userId,
    });
    const orgLogins = organizations.map((org) => org.login);
    log.info('github.shared_org_installations.org_memberships', {
      userId,
      organizationCount: orgLogins.length,
      organizations: orgLogins,
    });
    if (orgLogins.length === 0) return;

    const existingInstallationIds = await getExistingInstallationIds(db, userId);
    const candidates = await getSharedOrgInstallationCandidates(
      db,
      orgLogins,
      existingInstallationIds
    );
    log.info('github.shared_org_installations.candidates', {
      userId,
      candidateCount: candidates.length,
      installations: summarizeInstallationRows(candidates),
    });

    await insertVerifiedSharedInstallations(db, userId, accessToken, candidates);
  } catch (err) {
    log.error('github.shared_org_installations.failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function getExistingInstallationIds(db: GitHubDb, userId: string): Promise<Set<string>> {
  const existingRecords = await db
    .select({
      installationId: schema.githubInstallations.installationId,
      externalInstallationId: schema.githubInstallations.externalInstallationId,
    })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  return new Set(existingRecords.map((record) => getExternalInstallationId(record)));
}

async function getSharedOrgInstallationCandidates(
  db: GitHubDb,
  orgLogins: string[],
  existingInstallationIds: Set<string>
): Promise<GitHubInstallationAccountRow[]> {
  const normalizedOrgLogins = orgLogins.map((login) => login.toLowerCase());
  const knownOrgInstallations = await db
    .select()
    .from(schema.githubInstallationAccounts)
    .where(
      and(
        eq(schema.githubInstallationAccounts.accountType, 'organization'),
        isNull(schema.githubInstallationAccounts.uninstalledAt),
        inArray(schema.githubInstallationAccounts.accountNameNormalized, normalizedOrgLogins)
      )
    );

  const candidates = new Map<string, GitHubInstallationAccountRow>();
  for (const installation of knownOrgInstallations) {
    if (!existingInstallationIds.has(installation.installationId)) {
      candidates.set(installation.installationId, installation);
    }
  }
  return [...candidates.values()];
}

async function insertVerifiedSharedInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string,
  candidates: GitHubInstallationAccountRow[]
): Promise<void> {
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    try {
      const canAccess = await verifyUserInstallationAccess(accessToken, candidate.installationId, {
        flow: 'shared-org-discovery',
        userId,
        installationId: candidate.installationId,
        accountName: candidate.accountName,
      });
      if (!canAccess) {
        log.warn('github.shared_org_installations.verification_skipped', {
          userId,
          installationId: candidate.installationId,
          accountName: candidate.accountName,
          reason: 'not_accessible_to_user',
        });
        continue;
      }
      await insertSharedInstallation(db, userId, candidate, now);
    } catch (err) {
      log.error('github.shared_org_installations.verify_or_insert_failed', {
        userId,
        installationId: candidate.installationId,
        accountName: candidate.accountName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function insertSharedInstallation(
  db: GitHubDb,
  userId: string,
  candidate: GitHubInstallationAccountRow,
  now: string
): Promise<void> {
  try {
    await db.insert(schema.githubInstallations).values({
      id: ulid(),
      userId,
      installationId: getStoredInstallationId(userId, candidate.installationId),
      externalInstallationId: candidate.installationId,
      accountType: 'organization',
      accountName: candidate.accountName,
      createdAt: now,
      updatedAt: now,
    });
    log.info('github.shared_org_installations.insert_result', {
      userId,
      installationId: candidate.installationId,
      result: 'success',
      accountName: candidate.accountName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result = isDatabaseConflictError(err) ? 'conflict' : 'error';
    const details = {
      userId,
      installationId: candidate.installationId,
      result,
      accountName: candidate.accountName,
      error: message,
    };
    if (result === 'conflict') {
      log.warn('github.shared_org_installations.insert_result', details);
    } else {
      log.error('github.shared_org_installations.insert_result', details);
    }
  }
}

export { githubRoutes };
