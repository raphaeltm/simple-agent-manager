import { Hono } from 'hono';

import type { Env } from '../../env';
import { requireRouteParam } from '../../lib/route-helpers';
import { getAuth } from '../../middleware/auth';
import { jsonValidator } from '../../schemas';
import { GitHubConfigValueSchema } from '../../schemas/triggers';
import { previewRecentGitHubFilters } from '../../services/github-trigger-filter-preview';

export const githubRoutes = new Hono<{ Bindings: Env }>();
githubRoutes.post('/github/filter-preview', jsonValidator(GitHubConfigValueSchema), async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json(
    await previewRecentGitHubFilters(
      c.env,
      requireRouteParam(c, 'projectId'),
      getAuth(c).user.id,
      c.req.valid('json')
    )
  );
});
