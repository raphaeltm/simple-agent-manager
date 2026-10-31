import type { Repository } from '@simple-agent-manager/shared';
import { and, eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, optionalAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getAuthenticatedGitHubUser,
  getRepositoryBranches,
  getUserAccessibleInstallations,
  getUserInstallationRepositories,
} from '../services/github-app';
import {
  getCanonicalAccountInput,
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
} from '../services/github-route-helpers';
import { getGitHubUserAccessToken } from '../services/github-user-access-token';
import { getGitHubAppConfig } from '../services/platform-config';
import {
  deleteInstallationRow,
  getRequiredGitHubUserAccessToken,
  isAuthenticatedUsersPersonalInstallation,
} from './github-installation-sync';
import { registerGitHubInstallationsRoute } from './github-installations';
import { handleGitHubWebhook } from './github-webhook';

const githubRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/github/installations - List user's GitHub App installations
 *
 * Syncs installations from GitHub on each request so that users see every
 * installation their authenticated GitHub account can access.
 */
registerGitHubInstallationsRoute(githubRoutes);

/**
 * GET /api/github/install-url - Get GitHub App installation URL
 * Requires GitHub App slug from runtime config or environment fallback.
 */
githubRoutes.get('/install-url', requireAuth(), requireApproved(), async (c) => {
  const appSlug = (await getGitHubAppConfig(c.env))?.slug;
  if (!appSlug) {
    throw errors.internal('GitHub App slug is not configured');
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

  const accessToken = await getRequiredGitHubUserAccessToken(c, userId);

  // Fetch repositories from all installations in parallel
  const repoResults = await Promise.allSettled(
    targetInstallations.map(async (inst) => {
      const repos = await getUserInstallationRepositories(
        accessToken,
        getExternalInstallationId(inst),
        {
          flow: 'repositories',
          userId,
          installationId: inst.id,
        }
      );
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
  for (const [i, result] of repoResults.entries()) {
    // repoResults is 1:1 with targetInstallations (produced via
    // targetInstallations.map(...)), so this index is always in range —
    // guard defensively rather than crash the whole repos listing.
    const inst = targetInstallations[i];
    if (!inst) {
      log.error('github.get_repos_result_index_mismatch', { index: i });
      continue;
    }
    if (result.status === 'fulfilled') {
      allRepos.push(...result.value);
    } else {
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
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo) {
    throw errors.badRequest('repository must be in owner/repo format');
  }

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

  const accessToken = await getRequiredGitHubUserAccessToken(c, userId);

  // Validate the repository owner matches the installation's account.
  // Prevents using the installation token to enumerate arbitrary repositories.
  // See SSRF-VULN-03 in Shannon security assessment.
  if (owner.toLowerCase() !== targetInstallation.accountName.toLowerCase()) {
    throw errors.forbidden(
      `Repository owner "${owner}" does not match installation account "${targetInstallation.accountName}"`
    );
  }

  const userRepos = await getUserInstallationRepositories(
    accessToken,
    getExternalInstallationId(targetInstallation),
    {
      flow: 'branches',
      userId,
      installationId: targetInstallation.id,
      repository: repoFullName.toLowerCase(),
    }
  );
  const hasUserRepoAccess = userRepos.some(
    (githubRepo) => githubRepo.fullName.toLowerCase() === repoFullName.toLowerCase()
  );
  if (!hasUserRepoAccess) {
    throw errors.forbidden('Repository is not accessible through the selected installation');
  }

  try {
    const defaultBranch = c.req.query('default_branch') || undefined;
    const branches = await getRepositoryBranches(
      getExternalInstallationId(targetInstallation),
      owner,
      repo,
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

  const accessToken = await getGitHubUserAccessToken(c, auth.user.id);
  log.info('github.installation_callback.token_status', {
    userId: auth.user.id,
    installationId,
    tokenPresent: Boolean(accessToken),
  });
  if (!accessToken) {
    return c.redirect(`${settingsUrl}?github_app=error&reason=github_user_token_unavailable`);
  }

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

  // Verify the setup callback's installation_id against the authenticated
  // GitHub user's accessible installations before saving it.
  let insertAttempted = false;
  try {
    const [authenticatedGitHubUser, accessibleInstallations] = await Promise.all([
      getAuthenticatedGitHubUser(accessToken, { flow: 'callback', userId: auth.user.id }),
      getUserAccessibleInstallations(accessToken, {
        flow: 'callback',
        userId: auth.user.id,
        installationId,
      }),
    ]);
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

    if (
      normalizeAccountType(accessibleInstallation.account.type) === 'personal' &&
      !isAuthenticatedUsersPersonalInstallation(accessibleInstallation, authenticatedGitHubUser)
    ) {
      log.warn('github.personal_installation_owner_mismatch', {
        installationId,
        userId: auth.user.id,
        authenticatedGitHubUserId: authenticatedGitHubUser.id,
        authenticatedGitHubLogin: authenticatedGitHubUser.login,
        installationAccountId: accessibleInstallation.account.id ?? null,
        installationAccountLogin: accessibleInstallation.account.login,
      });
      if (existing[0]) {
        await deleteInstallationRow(db, auth.user.id, existing[0].id);
      }
      return c.redirect(`${settingsUrl}?github_app=error&reason=installation_not_accessible`);
    }

    const existingInstallation = existing[0];
    if (existingInstallation) {
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
export { githubRoutes };
