import type { GitLabProjectListResponse } from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  listGitLabBranches,
  listGitLabProjects,
  requireGitLabUserAccessToken,
} from '../services/gitlab';

const gitlabRoutes = new Hono<{ Bindings: Env }>();

gitlabRoutes.get('/projects', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const accessToken = await requireGitLabUserAccessToken(c, userId);
  const projects = await listGitLabProjects(c.env, accessToken, c.req.query('search'));
  return c.json({ projects } satisfies GitLabProjectListResponse);
});

gitlabRoutes.get('/branches', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const projectIdRaw = c.req.query('project_id')?.trim();
  const projectId = Number.parseInt(projectIdRaw ?? '', 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw errors.badRequest('project_id is required');
  }

  const accessToken = await requireGitLabUserAccessToken(c, userId);
  const branches = await listGitLabBranches(c.env, accessToken, projectId);
  return c.json(branches);
});

export { gitlabRoutes };
