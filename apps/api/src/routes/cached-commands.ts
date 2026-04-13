/**
 * Cached slash commands routes — CRUD for per-project command cache.
 *
 * Mounted at /api/projects/:projectId/cached-commands
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved,requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { jsonValidator, SaveCachedCommandsSchema } from '../schemas';
import * as projectDataService from '../services/project-data';

/** Default limits for cached commands. Override via env vars. */
const DEFAULT_MAX_CACHED_COMMANDS = 200;
const DEFAULT_MAX_AGENT_TYPE_LENGTH = 64;
const DEFAULT_MAX_COMMAND_NAME_LENGTH = 128;
const DEFAULT_MAX_COMMAND_DESC_LENGTH = 512;

function parseIntSafe(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

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
  const maxAgentTypeLen = parseIntSafe(c.env.CACHED_COMMANDS_MAX_AGENT_TYPE_LENGTH, DEFAULT_MAX_AGENT_TYPE_LENGTH);
  if (agentType && agentType.length > maxAgentTypeLen) {
    throw errors.badRequest('agentType exceeds maximum length');
  }
  const commands = await projectDataService.getCachedCommands(c.env, projectId, agentType);

  return c.json({ commands });
});

/**
 * POST /api/projects/:projectId/cached-commands
 * Persist slash commands discovered during an ACP session.
 */
cachedCommandRoutes.post('/', jsonValidator(SaveCachedCommandsSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('projectId is required');

  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const body = c.req.valid('json');

  // Configurable limits (Constitution Principle XI)
  const maxAgentTypeLen = parseIntSafe(c.env.CACHED_COMMANDS_MAX_AGENT_TYPE_LENGTH, DEFAULT_MAX_AGENT_TYPE_LENGTH);
  const maxCommands = parseIntSafe(c.env.CACHED_COMMANDS_MAX_PER_AGENT, DEFAULT_MAX_CACHED_COMMANDS);
  const maxNameLen = parseIntSafe(c.env.CACHED_COMMANDS_MAX_NAME_LENGTH, DEFAULT_MAX_COMMAND_NAME_LENGTH);
  const maxDescLen = parseIntSafe(c.env.CACHED_COMMANDS_MAX_DESC_LENGTH, DEFAULT_MAX_COMMAND_DESC_LENGTH);

  if (body.agentType.length > maxAgentTypeLen) {
    throw errors.badRequest('agentType exceeds maximum length');
  }

  const validCommands = body.commands
    .filter((cmd): cmd is typeof cmd & { name: string } => typeof cmd.name === 'string' && cmd.name.length > 0)
    .slice(0, maxCommands)
    .map((cmd) => ({
      name: cmd.name.trim().slice(0, maxNameLen),
      description: typeof cmd.description === 'string' ? cmd.description.trim().slice(0, maxDescLen) : '',
    }));

  await projectDataService.cacheCommands(c.env, projectId, body.agentType, validCommands);

  return c.json({ cached: validCommands.length }, 200);
});

export { cachedCommandRoutes };
