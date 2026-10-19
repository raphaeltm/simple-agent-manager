/**
 * Member offboarding: preview what a departing member's resources need, then apply the
 * chosen actions and remove them. Split out of `members.ts` (.claude/rules/18).
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { requireProjectCapability } from '../../middleware/project-auth';
import { ApplyProjectMemberOffboardingSchema, jsonValidator } from '../../schemas';
import { applyProjectMemberOffboarding } from '../../services/project-offboarding-apply';
import { createProjectMemberOffboardingPreview } from '../../services/project-offboarding-preview';
import { revokeSessionAccessForDepartedMember } from '../../services/session-access';

export const projectMemberOffboardingRoutes = new Hono<{ Bindings: Env }>();

projectMemberOffboardingRoutes.post('/:id/members/:userId/offboarding-preview', async (c) => {
  const requesterId = getUserId(c);
  const projectId = c.req.param('id');
  const memberUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectCapability(db, projectId, requesterId, 'member:manage');

  const preview = await createProjectMemberOffboardingPreview({
    db,
    database: c.env.DATABASE,
    project,
    memberUserId,
    requestedBy: requesterId,
    defaultAgentType: c.env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    planTtlSeconds: c.env.PROJECT_OFFBOARDING_PLAN_TTL_SECONDS,
  });

  return c.json(preview);
});

projectMemberOffboardingRoutes.post(
  '/:id/members/:userId/offboarding-apply',
  jsonValidator(ApplyProjectMemberOffboardingSchema),
  async (c) => {
    const requesterId = getUserId(c);
    const projectId = c.req.param('id');
    const memberUserId = c.req.param('userId');
    const db = drizzle(c.env.DATABASE, { schema });
    const project = await requireProjectCapability(db, projectId, requesterId, 'member:manage');
    const body = c.req.valid('json');

    const response = await applyProjectMemberOffboarding({
      db,
      project,
      memberUserId,
      actorUserId: requesterId,
      planId: body.planId,
      actions: body.actions,
      finalMemberStatus: body.finalMemberStatus,
      defaultAgentType: c.env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    });
    if (response.status === 'removed') {
      // Per-request membership checks already stop a removed member from driving a shared
      // session; this also deletes their stored grants (and grants on sessions they own) so a
      // later re-approval cannot bring them back.
      await revokeSessionAccessForDepartedMember(c.env, projectId, memberUserId);
    }

    return c.json(response);
  }
);
