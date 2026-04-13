import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved,requireAuth } from '../middleware/auth';
import { requireOwnedProject } from '../middleware/project-auth';
import { CreateAgentProfileSchema, jsonValidator, SetProjectDefaultProfileSchema,UpdateAgentProfileSchema } from '../schemas';
import * as agentProfileService from '../services/agent-profiles';

const agentProfileRoutes = new Hono<{ Bindings: Env }>();

// All routes require authentication
agentProfileRoutes.use('/*', requireAuth(), requireApproved());

/** GET / — List all profiles for a project (includes global profiles) */
agentProfileRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const profiles = await agentProfileService.listProfiles(db, projectId, userId, c.env);
  return c.json({ items: profiles });
});

/** POST / — Create a new profile scoped to a project */
agentProfileRoutes.post('/', jsonValidator(CreateAgentProfileSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = c.req.valid('json');
  const profile = await agentProfileService.createProfile(db, projectId, userId, body, c.env);
  return c.json(profile, 201);
});

/** GET /:profileId — Get a single profile */
agentProfileRoutes.get('/:profileId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const profileId = requireRouteParam(c, 'profileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const profile = await agentProfileService.getProfile(db, projectId, profileId, userId);
  return c.json(profile);
});

/** PUT /:profileId — Update a profile */
agentProfileRoutes.put('/:profileId', jsonValidator(UpdateAgentProfileSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const profileId = requireRouteParam(c, 'profileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = c.req.valid('json');
  const profile = await agentProfileService.updateProfile(db, projectId, profileId, userId, body);
  return c.json(profile);
});

/** DELETE /:profileId — Delete a profile */
agentProfileRoutes.delete('/:profileId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const profileId = requireRouteParam(c, 'profileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  await agentProfileService.deleteProfile(db, projectId, profileId, userId);
  return c.json({ success: true });
});

/** POST /resolve — Resolve a profile by name or ID for task execution */
agentProfileRoutes.post('/resolve', jsonValidator(SetProjectDefaultProfileSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = c.req.valid('json');
  const resolved = await agentProfileService.resolveAgentProfile(
    db,
    projectId,
    body.profileNameOrId,
    userId,
    c.env
  );
  return c.json(resolved);
});

export { agentProfileRoutes };
