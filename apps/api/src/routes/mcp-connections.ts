/**
 * Bring-your-own MCP server routes.
 *
 * Two mount points share one handler set so the personal and project scopes cannot drift:
 *   /api/mcp-connections                          -> personal (projectId null)
 *   /api/projects/:projectId/mcp-connections      -> project-scoped
 *
 * Project-scope writes require `secret:write` (owner/admin only — `maintainer` deliberately
 * has `secret:read` but not `secret:write`), because a connection stores a credential that
 * every member's agents will then use.
 *
 * No read path returns the URL or the token; see `toMcpConnectionResponse`.
 */
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import type { ProjectCapability } from '../middleware/project-auth';
import { CreateMcpConnectionSchema, jsonValidator, UpdateMcpConnectionSchema } from '../schemas';
import { getRuntimeLimits } from '../services/limits';
import {
  createMcpConnection,
  deleteMcpConnection,
  listMcpConnections,
  type McpConnectionScopeRef,
  type McpConnectionWriteLimits,
  updateMcpConnection,
} from '../services/mcp-connections';
import { requireProjectRuntimeAuthorization } from './runtime-project-auth';

type AppContext = Context<{ Bindings: Env }>;

function writeLimits(c: AppContext): McpConnectionWriteLimits {
  const limits = getRuntimeLimits(c.env);
  return {
    maxPerScope: limits.maxMcpConnectionsPerScope,
    urlMaxBytes: limits.mcpConnectionUrlMaxBytes,
    tokenMaxBytes: limits.mcpConnectionTokenMaxBytes,
  };
}

/**
 * Resolves the scope for a request and authorizes the caller for it.
 *
 * Personal scope needs no project check — the scope predicate itself is `userId` bound.
 * Project scope goes through the shared project authorization so membership and capability
 * are enforced before any row is touched.
 */
async function requireScope(
  c: AppContext,
  capability: ProjectCapability,
  projectScoped: boolean
): Promise<{ db: ReturnType<typeof drizzle<typeof schema>>; scope: McpConnectionScopeRef }> {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectScoped) {
    return { db, scope: { userId, projectId: null } };
  }

  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectRuntimeAuthorization(db, projectId, userId, capability);
  return { db, scope: { userId, projectId } };
}

function buildRoutes(projectScoped: boolean): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/', async (c) => {
    const { db, scope } = await requireScope(c, 'project:read', projectScoped);
    return c.json({ items: await listMcpConnections(db, scope) });
  });

  routes.post('/', jsonValidator(CreateMcpConnectionSchema), async (c) => {
    const body = c.req.valid('json');
    const { db, scope } = await requireScope(c, 'secret:write', projectScoped);
    const connection = await createMcpConnection(db, {
      ...scope,
      name: body.name,
      url: body.url,
      authType: body.authType ?? 'bearer',
      token: body.token ?? null,
      enabled: body.enabled ?? true,
      limits: writeLimits(c),
      encryptionKey: getCredentialEncryptionKey(c.env),
    });
    return c.json(connection, 201);
  });

  routes.patch('/:connectionId', jsonValidator(UpdateMcpConnectionSchema), async (c) => {
    const body = c.req.valid('json');
    const connectionId = requireRouteParam(c, 'connectionId');
    const { db, scope } = await requireScope(c, 'secret:write', projectScoped);
    const connection = await updateMcpConnection(db, {
      ...scope,
      connectionId,
      name: body.name,
      url: body.url,
      authType: body.authType,
      token: body.token,
      enabled: body.enabled,
      limits: writeLimits(c),
      encryptionKey: getCredentialEncryptionKey(c.env),
    });
    return c.json(connection);
  });

  routes.delete('/:connectionId', async (c) => {
    const connectionId = requireRouteParam(c, 'connectionId');
    const { db, scope } = await requireScope(c, 'secret:write', projectScoped);
    await deleteMcpConnection(db, scope, connectionId);
    return c.json({ success: true });
  });

  return routes;
}

/** Personal scope: /api/mcp-connections */
export const userMcpConnectionRoutes = new Hono<{ Bindings: Env }>();
userMcpConnectionRoutes.use('/*', requireAuth(), requireApproved());
userMcpConnectionRoutes.route('/', buildRoutes(false));

/** Project scope: /api/projects/:projectId/mcp-connections */
export const projectMcpConnectionRoutes = new Hono<{ Bindings: Env }>();
projectMcpConnectionRoutes.use('/*', requireAuth(), requireApproved());
projectMcpConnectionRoutes.route('/', buildRoutes(true));
