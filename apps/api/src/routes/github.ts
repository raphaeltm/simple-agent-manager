import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { requireAuth, getUserId, optionalAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getInstallationRepositories,
  getRepositoryBranches,
  verifyWebhookSignature,
  generateAppJWT,
} from '../services/github-app';
import * as schema from '../db/schema';
import type { GitHubInstallation, Repository } from '@simple-agent-manager/shared';

const githubRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/github/installations - List user's GitHub App installations
 */
githubRoutes.get('/installations', requireAuth(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

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
githubRoutes.get('/install-url', requireAuth(), async (c) => {
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
githubRoutes.get('/repositories', requireAuth(), async (c) => {
  const userId = getUserId(c);
  const installationId = c.req.query('installation_id');
  const db = drizzle(c.env.DATABASE, { schema });

  // Get user's installations
  const installations = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  if (installations.length === 0) {
    return c.json([]);
  }

  // Filter by installation if specified
  const targetInstallations = installationId
    ? installations.filter((i) => i.installationId === installationId)
    : installations;

  if (targetInstallations.length === 0) {
    throw errors.notFound('Installation');
  }

  // Get repositories from each installation
  const allRepos: Repository[] = [];
  for (const inst of targetInstallations) {
    try {
      const repos = await getInstallationRepositories(inst.installationId, c.env);
      allRepos.push(
        ...repos.map((repo) => ({
          id: repo.id,
          fullName: repo.fullName,
          name: repo.fullName.split('/').pop() || repo.fullName,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
          installationId: inst.id,
        }))
      );
    } catch (err) {
      console.error(`Failed to get repos for installation ${inst.installationId}:`, err);
      // Continue with other installations
    }
  }

  return c.json(allRepos);
});

/**
 * GET /api/github/branches - List branches for a repository
 * Query params: repository (full name like owner/repo), installation_id (DB row id)
 */
githubRoutes.get('/branches', requireAuth(), async (c) => {
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

  try {
    const branches = await getRepositoryBranches(
      targetInstallation.installationId,
      owner!,
      repo!,
      c.env
    );
    return c.json(branches);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to list branches for ${repoFullName}:`, message);
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

  // Verify signature (use a dedicated webhook secret in production)
  const webhookSecret = c.env.ENCRYPTION_KEY;
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

  // Check if installation already exists
  const existing = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.installationId, installationId))
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
      console.error(`GitHub API error ${response.status} for installation ${installationId}:`, errorBody);
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
    console.error(`Failed to save installation ${installationId}:`, message);
    return c.redirect(`${settingsUrl}?github_app=error&reason=${encodeURIComponent(message)}`);
  }
});

/**
 * DELETE /api/github/installations/:id - Remove an installation
 */
githubRoutes.delete('/installations/:id', requireAuth(), async (c) => {
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

export { githubRoutes };
