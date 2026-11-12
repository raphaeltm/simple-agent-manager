/**
 * POST /api/projects/:id/hosted-git/token — a short-lived clone/push credential for a person
 * using a SAM-hosted repository from their own machine (self-host only).
 *
 * Session-authenticated (mounted inside projectsRoutes). Read needs `project:read`; write needs
 * `workspace:write`, the capability that lets a member change the project's work. Returns 404
 * for any project that is not on this install's own git server, so Cloudflare installs and
 * GitHub/GitLab projects are unaffected.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { hostedGitHost, isLocalHostedGitActive } from '../../services/hosted-git/backend';
import { mintHostedGitToken } from '../../services/hosted-git/tokens';

const hostedGitTokenRoutes = new Hono<{ Bindings: Env }>();

hostedGitTokenRoutes.post('/:id/hosted-git/token', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const scope = c.req.query('scope') === 'write' ? 'write' : 'read';
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectCapability(
    db,
    projectId,
    userId,
    scope === 'write' ? 'workspace:write' : 'project:read'
  );
  if (
    !isLocalHostedGitActive(c.env) ||
    project.repoProvider !== 'artifacts' ||
    !project.artifactsRepoId
  ) {
    throw errors.notFound('SAM-hosted repository');
  }
  const minted = await mintHostedGitToken(c.env, { repo: project.artifactsRepoId, scope });
  return c.json({
    cloneUrl: project.repository,
    host: hostedGitHost(c.env),
    username: 'x',
    token: minted.token,
    scope,
    expiresAt: minted.expiresAt,
  });
});

export { hostedGitTokenRoutes };
