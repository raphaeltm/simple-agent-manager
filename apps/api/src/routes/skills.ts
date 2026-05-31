import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { requireOwnedProject } from '../middleware/project-auth';
import { CreateSkillSchema, jsonValidator, UpdateSkillSchema } from '../schemas';
import * as skillService from '../services/skills';

export const skillRoutes = new Hono<{ Bindings: Env }>();

skillRoutes.use('/*', requireAuth(), requireApproved());

skillRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);
  const skills = await skillService.listSkills(db, projectId, userId);
  return c.json({ items: skills });
});

skillRoutes.post('/', jsonValidator(CreateSkillSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);
  const skill = await skillService.createSkill(db, projectId, userId, c.req.valid('json'), c.env);
  return c.json(skill, 201);
});

skillRoutes.get('/:skillId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const skillId = requireRouteParam(c, 'skillId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);
  const skill = await skillService.getSkill(db, projectId, skillId, userId);
  return c.json(skill);
});

skillRoutes.patch('/:skillId', jsonValidator(UpdateSkillSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const skillId = requireRouteParam(c, 'skillId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);
  const skill = await skillService.updateSkill(db, projectId, skillId, userId, c.req.valid('json'));
  return c.json(skill);
});

skillRoutes.delete('/:skillId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const skillId = requireRouteParam(c, 'skillId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);
  await skillService.deleteSkill(db, projectId, skillId, userId);
  return c.json({ success: true });
});
