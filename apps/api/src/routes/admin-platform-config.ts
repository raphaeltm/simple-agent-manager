import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireActiveSettingsSuperadmin } from '../middleware/settings-admin';
import { jsonValidator, UpdatePlatformIntegrationConfigSchema } from '../schemas';
import { enforceCredentialMutationRateLimit } from '../services/credential-mutation-rate-limit';
import { completeGitHubAppManifest, startGitHubAppManifest } from '../services/github-app-manifest';
import {
  getPlatformConfigStatus,
  savePlatformIntegrationConfig,
} from '../services/platform-config';
import { validatePlatformIntegrationInput } from '../services/platform-config-validation';
import { requestWaitUntil, scheduleSecurityAlert } from '../services/security-alerts';

const adminPlatformConfigRoutes = new Hono<{ Bindings: Env }>();

adminPlatformConfigRoutes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  requireActiveSettingsSuperadmin()
);

async function assertFeedbackProjectSelection(
  env: Env,
  userId: string,
  projectId: string
): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT p.id
     FROM projects p
     INNER JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = ? AND pm.user_id = ? AND pm.status = 'active'
     LIMIT 1`
  )
    .bind(projectId, userId)
    .first<{ id: string }>();
  if (!row) {
    throw errors.badRequest('Operations project must exist and be a project you can access');
  }
}

adminPlatformConfigRoutes.get('/', async (c) => {
  return c.json({
    status: await getPlatformConfigStatus(c.env, {
      userId: getUserId(c),
      includeActorLabels: true,
    }),
  });
});

adminPlatformConfigRoutes.put(
  '/',
  jsonValidator(UpdatePlatformIntegrationConfigSchema),
  async (c) => {
    const { config } = c.req.valid('json');
    const userId = getUserId(c);
    if (config.googleInfrastructure || config.clear?.includes('googleInfrastructureOAuth')) {
      await enforceCredentialMutationRateLimit(c.env, userId, 'google-infra-oauth');
    }
    if (config.feedback?.remove && config.feedback.projectId?.trim()) {
      throw errors.badRequest(
        'Choose an Operations project or clear the runtime selection, not both'
      );
    }
    const feedbackProjectId = config.feedback?.projectId?.trim();
    if (feedbackProjectId) {
      await assertFeedbackProjectSelection(c.env, userId, feedbackProjectId);
    }
    const validation = await validatePlatformIntegrationInput(c.env, config);
    if (!validation.ok) {
      throw errors.badRequest('Platform configuration is invalid', { errors: validation.errors });
    }
    const changes = await savePlatformIntegrationConfig(c.env, config, userId);
    scheduleSecurityAlert(c.env, requestWaitUntil(c), {
      kind: 'integration-changed',
      actorUserId: userId,
      changes,
    });
    return c.json({
      status: await getPlatformConfigStatus(c.env, { userId, includeActorLabels: true }),
    });
  }
);

const StartManifestSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.maxLength(100))),
  organization: v.optional(v.pipe(v.string(), v.maxLength(100))),
});
const CompleteManifestSchema = v.object({
  code: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  state: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

/**
 * POST /api/admin/platform-config/github-app/manifest — start creating the GitHub App through
 * GitHub's manifest flow. Returns the manifest and the URL the browser posts it to.
 */
adminPlatformConfigRoutes.post(
  '/github-app/manifest',
  jsonValidator(StartManifestSchema),
  async (c) => {
    const userId = getUserId(c);
    await enforceCredentialMutationRateLimit(c.env, userId, 'github-app-manifest');
    return c.json(await startGitHubAppManifest(c.env, userId, c.req.valid('json')));
  }
);

/**
 * POST /api/admin/platform-config/github-app/manifest/complete — GitHub sent the administrator
 * back with `code` and `state`: convert the code and store the new App as platform config.
 */
adminPlatformConfigRoutes.post(
  '/github-app/manifest/complete',
  jsonValidator(CompleteManifestSchema),
  async (c) => {
    const userId = getUserId(c);
    const { code, state } = c.req.valid('json');
    const created = await completeGitHubAppManifest(c.env, userId, code, state);
    const validation = await validatePlatformIntegrationInput(c.env, created.config);
    if (!validation.ok) {
      throw errors.badRequest('GitHub returned an App SAM cannot use', {
        errors: validation.errors,
      });
    }
    // The same owner alert as a save from the settings page: the App's credentials are
    // integration settings, so storing them must not be a silent path (security-alerts.ts).
    const changes = await savePlatformIntegrationConfig(c.env, created.config, userId);
    scheduleSecurityAlert(c.env, requestWaitUntil(c), {
      kind: 'integration-changed',
      actorUserId: userId,
      changes,
    });
    return c.json({
      app: {
        slug: created.slug,
        htmlUrl: created.htmlUrl,
        owner: created.owner,
        installUrl: `https://github.com/apps/${created.slug}/installations/new`,
      },
      // The admin page stores this status in the same query the GET fills, so it carries the
      // same actor labels.
      status: await getPlatformConfigStatus(c.env, { userId, includeActorLabels: true }),
    });
  }
);

export { adminPlatformConfigRoutes };
