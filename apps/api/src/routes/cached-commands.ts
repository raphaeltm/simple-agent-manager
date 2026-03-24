/**
 * Cached slash commands routes — CRUD for per-project command cache.
 *
 * Mounted at /api/projects/:projectId/cached-commands
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import { getUserId, requireAuth, requireApproved } from '../middleware/auth';
import { requireOwnedProject } from '../middleware/project-auth';
import { errors } from '../middleware/error';
import * as schema from '../db/schema';
import * as projectDataService from '../services/project-data';

const cachedCommandRoutes = new Hono<{ Bindings: Env }>();

cachedCommandRoutes.use('/*', requireAuth(), requireApproved());

/**
 * GET /api/projects/:projectId/cached-commands
 * Retrieve cached slash commands for a project.
 * Optional query param: ?agentType=claude-code
 */
cachedCommandRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('projectId is required');

  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const agentType = c.req.query('agentType') || undefined;
  const commands = await projectDataService.getCachedCommands(c.env, projectId, agentType);

  return c.json({ commands });
});

/**
 * POST /api/projects/:projectId/cached-commands
 * Persist slash commands discovered during an ACP session.
 */
cachedCommandRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('projectId is required');

  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<{
    agentType: string;
    commands: Array<{ name: string; description: string }>;
  }>();

  if (!body.agentType || typeof body.agentType !== 'string') {
    throw errors.badRequest('agentType is required');
  }
  if (!Array.isArray(body.commands)) {
    throw errors.badRequest('commands must be an array');
  }

  // Validate each command entry
  const validCommands = body.commands
    .filter((cmd) => cmd.name && typeof cmd.name === 'string')
    .map((cmd) => ({
      name: cmd.name.trim(),
      description: typeof cmd.description === 'string' ? cmd.description.trim() : '',
    }));

  await projectDataService.cacheCommands(c.env, projectId, body.agentType, validCommands);

  return c.json({ cached: validCommands.length }, 200);
});

export { cachedCommandRoutes };
