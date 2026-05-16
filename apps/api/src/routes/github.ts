import type { GitHubInstallation, Repository } from '@simple-agent-manager/shared';
import { and,eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context,Hono } from 'hono';

import { createAuth } from '../auth';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord, optionalJsonRecord } from '../lib/runtime-validation';
import { getWebhookSecret } from '../lib/secrets';
import { getUserId, optionalAuth,requireApproved, requireAuth } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import {
  getInstallationRepositories,
  getRepositoryBranches,
  getUserAccessibleInstallations,
  verifyWebhookSignature,
} from '../services/github-app';
import {
  getCanonicalAccountType,
  insertUserInstallationLink,
  isDatabaseConflictError,
  summarizeAccessibleInstallations,
  syncUserInstallations,
  tombstoneCanonicalInstallationAccount,
  upsertCanonicalInstallationAccount,
} from './github-installation-accounts';

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
  log.info('github.installations_sync.token_status', { userId, tokenPresent: Boolean(accessToken) });
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
    installationId: inst.installationId,
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

/**
 * GET /api/github/repositories - List repositories from installations
 */
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
      const repos = await getInstallationRepositories(inst.installationId, c.env);
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
      log.error('github.get_repos_failed', { accountName: inst.accountName, installationId: inst.id, error: String(result.reason) });
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
      targetInstallation.installationId,
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

/**
 * POST /api/github/webhook - Handle GitHub App webhooks
 */
githubRoutes.post('/webhook', async (c) => {
  const signature = c.req.header('x-hub-signature-256');
  const event = c.req.header('x-github-event');
  const payload = await c.req.text();

  if (!signature) {
    throw errors.unauthorized('Missing webhook signature');
  }

  const webhookSecret = getWebhookSecret(c.env);
  const isValid = await verifyWebhookSignature(payload, signature, webhookSecret);
  if (!isValid) {
    throw errors.unauthorized('Invalid webhook signature');
  }

  let data: Record<string, unknown>;
  try {
    data = expectJsonRecord(JSON.parse(payload), 'github.webhook');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.badRequest('Invalid JSON in webhook payload');
  }
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Handle installation events
  if (event === 'installation') {
    const action = data.action;
    const installation = optionalJsonRecord(data.installation, 'github.webhook.installation');
    const sender = optionalJsonRecord(data.sender, 'github.webhook.sender');

    if (action === 'created' && installation?.id != null) {
      const account = optionalJsonRecord(installation.account, 'github.webhook.installation.account');
      if (account?.login != null) {
        await upsertCanonicalInstallationAccount(db, {
          installationId: String(installation.id),
          accountType: getCanonicalAccountType(account.type),
          accountName: String(account.login),
          now,
        });
      }
    }

    if (action === 'created' && sender?.id != null && installation?.id != null) {
      // Find user by GitHub ID (from the sender who installed the app)
      const users = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.githubId, String(sender.id)))
        .limit(1);

      const foundUser = users[0];
      if (foundUser) {
        const account = optionalJsonRecord(installation.account, 'github.webhook.installation.account');
        await insertUserInstallationLink(db, {
          userId: foundUser.id,
          installationId: String(installation.id),
          accountType: getCanonicalAccountType(account?.type),
          accountName: String(account?.login ?? ''),
          now,
        });
      }
    } else if (action === 'deleted' && installation?.id != null) {
      // GitHub-source-of-truth uninstall: remove every per-user link and
      // tombstone canonical account state. This is intentionally broader than
      // per-user SAM unlink/account deletion, which must never touch canonical
      // org installation state.
      await db
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.installationId, String(installation.id)));
      await tombstoneCanonicalInstallationAccount(db, String(installation.id), now);
    }
  }

  // Handle repository events (renamed, transferred, deleted)
  if (event === 'repository') {
    const action = data.action;
    const repo = optionalJsonRecord(data.repository, 'github.webhook.repository');
    const repoId = typeof repo?.id === 'number' ? repo.id : undefined;

    if (repoId !== undefined && (action === 'renamed' || action === 'transferred')) {
      // Update repository name for all projects linked by github_repo_id
      const newFullName = typeof repo?.full_name === 'string' ? repo.full_name.toLowerCase() : undefined;
      if (newFullName) {
        await db
          .update(schema.projects)
          .set({ repository: newFullName, updatedAt: now })
          .where(eq(schema.projects.githubRepoId, repoId));
      }
    } else if (repoId !== undefined && action === 'deleted') {
      // Mark projects as detached when the repo is deleted
      await db
        .update(schema.projects)
        .set({ status: 'detached', updatedAt: now })
        .where(eq(schema.projects.githubRepoId, repoId));
    }
  }

  return c.json({ received: true });
});

/**
 * GET /api/github/callback - Handle callback after GitHub App installation
 * This is called when user is redirected back after installing the GitHub App.
 * The Setup URL in GitHub App settings should point here.
 */
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
        eq(schema.githubInstallations.installationId, installationId),
        eq(schema.githubInstallations.userId, auth.user.id)
      )
    )
    .limit(1);

  const existingInstallation = existing[0];
  if (existingInstallation) {
    await upsertCanonicalInstallationAccount(db, {
      installationId,
      accountType: existingInstallation.accountType,
      accountName: existingInstallation.accountName,
      now,
    });
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
    const accessibleInstallation = accessibleInstallations.find((inst) => String(inst.id) === installationId);
    log.info('github.installation_callback.installation_match', {
      userId: auth.user.id,
      installationId,
      found: Boolean(accessibleInstallation),
    });
    if (!accessibleInstallation) {
      log.warn('github.installation_not_accessible_to_user', { installationId, userId: auth.user.id });
      return c.redirect(`${settingsUrl}?github_app=error&reason=installation_not_accessible`);
    }

    insertAttempted = true;
    const accountType = getCanonicalAccountType(accessibleInstallation.account.type);
    await upsertCanonicalInstallationAccount(db, {
      installationId,
      accountType,
      accountName: accessibleInstallation.account.login,
      now,
    });
    await insertUserInstallationLink(db, {
      userId: auth.user.id,
      installationId,
      accountType,
      accountName: accessibleInstallation.account.login,
      now,
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

  // Per-user unlink only. Do not delete `github_installation_accounts` here:
  // org installation discovery for other SAM users depends on canonical rows.
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
 * Get the current user's GitHub access token from BetterAuth.
 * BetterAuth owns OAuth token encryption/refresh; callers should not read the
 * encrypted accounts table directly.
 */
async function getGitHubUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string | null> {
  try {
    const auth = createAuth(c.env);
    const token = await auth.api.getAccessToken({
      headers: c.req.raw.headers,
      body: { providerId: 'github', userId },
    });
    log.info('github.user_access_token.lookup', {
      userId,
      tokenPresent: Boolean(token.accessToken),
      tokenType: getTokenType(token),
      scopes: token.scopes,
    });
    return token.accessToken || null;
  } catch (err) {
    log.warn('github.user_access_token_unavailable', {
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function getTokenType(token: unknown): string | null {
  if (!token || typeof token !== 'object' || !('tokenType' in token)) {
    return null;
  }
  const tokenType = token.tokenType;
  return typeof tokenType === 'string' ? tokenType : null;
}

export { githubRoutes };
