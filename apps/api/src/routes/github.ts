import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId, optionalAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getInstallationRepositories,
  getInstallationToken,
  getRepositoryBranches,
  getAppInstallations,
  verifyWebhookSignature,
  generateAppJWT,
} from '../services/github-app';
import * as schema from '../db/schema';
import type { GitHubInstallation, Repository } from '@simple-agent-manager/shared';
import { getWebhookSecret } from '../lib/secrets';
import { log } from '../lib/logger';

const githubRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/github/installations - List user's GitHub App installations
 *
 * Syncs installations from GitHub on each request so that org members
 * who didn't originally install the app still see org installations.
 * Uses the GitHub App JWT to list all app installations, then checks
 * each against the user's existing DB records. New accessible installations
 * are auto-created for the user.
 */
githubRoutes.get('/installations', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  // Sync: discover installations the user can access but doesn't have a DB record for
  await syncUserInstallations(db, userId, c.env);

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

  const data = JSON.parse(payload);
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Handle installation events
  if (event === 'installation') {
    const action = data.action;
    const installation = data.installation;
    const sender = data.sender;

    if (action === 'created') {
      // Find user by GitHub ID (from the sender who installed the app)
      const users = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.githubId, String(sender.id)))
        .limit(1);

      const foundUser = users[0];
      if (foundUser) {
        // Create installation record
        await db.insert(schema.githubInstallations).values({
          id: ulid(),
          userId: foundUser.id,
          installationId: String(installation.id),
          accountType: installation.account.type === 'Organization' ? 'organization' : 'personal',
          accountName: installation.account.login,
          createdAt: now,
          updatedAt: now,
        });
      }
    } else if (action === 'deleted') {
      // Remove installation record
      await db
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.installationId, String(installation.id)));
    }
  }

  // Handle repository events (renamed, transferred, deleted)
  if (event === 'repository') {
    const action = data.action;
    const repo = data.repository;
    const repoId = repo?.id;

    if (repoId && (action === 'renamed' || action === 'transferred')) {
      // Update repository name for all projects linked by github_repo_id
      const newFullName = (repo.full_name as string)?.toLowerCase();
      if (newFullName) {
        await db
          .update(schema.projects)
          .set({ repository: newFullName, updatedAt: now })
          .where(eq(schema.projects.githubRepoId, repoId));
      }
    } else if (repoId && action === 'deleted') {
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

  if (!installationId) {
    return c.redirect(settingsUrl);
  }

  const auth = c.get('auth');
  if (!auth) {
    // User not logged in — redirect to login, preserving installation_id
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

  if (existing.length > 0) {
    return c.redirect(`${settingsUrl}?github_app=installed`);
  }

  // Fetch installation details from GitHub API and save to DB
  try {
    const jwt = await generateAppJWT(c.env);
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      log.error('github.api_error_for_installation', { status: response.status, installationId, body: errorBody });
      return c.redirect(`${settingsUrl}?github_app=error&reason=github_api_${response.status}`);
    }

    const installation = await response.json() as {
      account: { login: string; type: string };
    };

    await db.insert(schema.githubInstallations).values({
      id: ulid(),
      userId: auth.user.id,
      installationId: installationId,
      accountType: installation.account.type === 'Organization' ? 'organization' : 'personal',
      accountName: installation.account.login,
      createdAt: now,
      updatedAt: now,
    });

    return c.redirect(`${settingsUrl}?github_app=installed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('github.save_installation_failed', { installationId, error: message });
    return c.redirect(`${settingsUrl}?github_app=error&reason=${encodeURIComponent(message)}`);
  }
});

/**
 * DELETE /api/github/installations/:id - Remove an installation
 */
githubRoutes.delete('/installations/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const installationId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

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
 * Fetches all installations of the GitHub App, then for org-type installations
 * that the user doesn't already have a DB record for, checks whether the user
 * is a member of the org. If so, creates a record so the user can see and use
 * the installation.
 *
 * For personal installations, only the account owner should see them (handled
 * by the webhook creating the initial record).
 */
async function syncUserInstallations(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  env: Env
): Promise<void> {
  try {
    // Get the user's GitHub username for membership checks
    const userRows = await db
      .select({ githubId: schema.users.githubId, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    const user = userRows[0];
    if (!user?.githubId) return;

    // Get all app installations from GitHub
    const appInstallations = await getAppInstallations(env);
    if (appInstallations.length === 0) return;

    // Get user's existing installation records
    const existingRecords = await db
      .select({ installationId: schema.githubInstallations.installationId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, userId));

    const existingInstallationIds = new Set(existingRecords.map((r) => r.installationId));

    // Find installations the user doesn't have a record for
    const missingInstallations = appInstallations.filter(
      (inst) => !existingInstallationIds.has(String(inst.id))
    );

    if (missingInstallations.length === 0) return;

    const now = new Date().toISOString();

    for (const inst of missingInstallations) {
      // For org installations, check if the user is a member
      if (inst.account.type === 'Organization') {
        const isMember = await checkOrgMembership(
          String(inst.id),
          inst.account.login,
          user.githubId,
          env
        );
        if (!isMember) continue;
      } else {
        // Personal installations: only the account owner should see them.
        // The webhook handler creates these records; skip if not already present.
        continue;
      }

      // Create the record for this user
      try {
        await db
          .insert(schema.githubInstallations)
          .values({
            id: ulid(),
            userId,
            installationId: String(inst.id),
            accountType: inst.account.type === 'Organization' ? 'organization' : 'personal',
            accountName: inst.account.login,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing(); // Unique(userId, installationId) — skip if already exists
      } catch {
        // Ignore conflicts from race conditions
      }
    }
  } catch (err) {
    // Sync is best-effort — don't block the response if GitHub API is down
    log.error('github.sync_installations_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Check if a GitHub user is a member of an organization.
 * Uses the installation access token to query the org members API.
 */
async function checkOrgMembership(
  installationId: string,
  orgLogin: string,
  githubUserId: string,
  env: Env
): Promise<boolean> {
  try {
    const { token } = await getInstallationToken(installationId, env);

    // List org members and check if the user's GitHub ID is among them
    // Use per_page=100 and paginate if needed
    const perPage = 100;
    const maxPages = 100;

    for (let page = 1; page <= maxPages; page++) {
      const response = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/members?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Simple-Agent-Manager',
          },
        }
      );

      if (!response.ok) {
        // If we can't check membership (e.g., insufficient permissions), skip
        return false;
      }

      const members = (await response.json()) as Array<{ id: number }>;
      if (members.some((m) => String(m.id) === githubUserId)) {
        return true;
      }

      if (members.length < perPage) break;
    }

    return false;
  } catch {
    return false;
  }
}

export { githubRoutes };
