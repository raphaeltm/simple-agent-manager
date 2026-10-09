import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import {
  createConnectorAuthorizationServer,
  revokeConnectorConnection,
} from '../services/connector-oauth';
import {
  connectorUrl,
  getConnectorSettings,
  getConnectorSettingsConfig,
  updateConnectorSettings,
} from '../services/connector-settings';

interface ConnectionRow {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
function pageSize(env: Env): number {
  const parsed = Number(env.CONNECTOR_LIST_PAGE_SIZE);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : 50;
}
async function connections(env: Env, userId?: string, cursor?: string) {
  const limit = pageSize(env);
  if (userId) {
    const page = await (
      await createConnectorAuthorizationServer(env)
    )
      .getOAuthApi(env)
      .listUserGrants(userId, { limit: Math.min(limit, 99), cursor });
    const ids = page.items.map((grant) => {
      const metadata: unknown = grant.metadata;
      return v.parse(v.object({ connectionId: v.string() }), metadata).connectionId;
    });
    if (!ids.length) return { connections: [], nextCursor: page.cursor ?? null };
    const rows = await env.DATABASE.prepare(
      `SELECT id,user_id,client_id,client_name,scopes,created_at,last_used_at,revoked_at FROM connector_oauth_grants WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')}) AND revoked_at IS NULL`
    )
      .bind(userId, ...ids)
      .all<ConnectionRow>();
    return { connections: rows.results.map(mapConnection), nextCursor: page.cursor ?? null };
  }
  const rows = await env.DATABASE.prepare(
    'SELECT id,user_id,client_id,client_name,scopes,created_at,last_used_at,revoked_at FROM connector_oauth_grants WHERE id>? ORDER BY id LIMIT ?'
  )
    .bind(cursor ?? '', limit + 1)
    .all<ConnectionRow>();
  const page = rows.results.slice(0, limit);
  return {
    connections: page.map(mapConnection),
    nextCursor: rows.results.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
function mapConnection(row: ConnectionRow) {
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: v.parse(v.array(v.string()), JSON.parse(row.scopes)),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
export const connectorSettingsRoutes = new Hono<{ Bindings: Env }>();
connectorSettingsRoutes.use('*', requireAuth(), requireApproved());
connectorSettingsRoutes.get('/settings', async (c) => {
  const settings = await getConnectorSettings(c.env);
  return c.json({
    enabled: settings.enabled,
    writeEnabled: settings.writeEnabled,
    url: connectorUrl(c.env),
  });
});
connectorSettingsRoutes.get('/connections', async (c) =>
  c.json(await connections(c.env, c.get('auth').user.id, c.req.query('cursor')))
);
connectorSettingsRoutes.delete('/connections/:id', async (c) => {
  if (!(await revokeConnectorConnection(c.env, c.req.param('id'), c.get('auth').user.id)))
    throw errors.notFound('Connection');
  return c.json({ revoked: true });
});
export const connectorAdminRoutes = new Hono<{ Bindings: Env }>();
connectorAdminRoutes.use('*', requireAuth(), requireApproved(), requireSuperadmin());
connectorAdminRoutes.get('/settings', async (c) =>
  c.json({ settings: await getConnectorSettingsConfig(c.env) })
);
connectorAdminRoutes.patch(
  '/settings',
  jsonValidator(v.record(v.string(), v.unknown())),
  async (c) =>
    c.json({
      settings: await updateConnectorSettings(c.env, c.req.valid('json'), c.get('auth').user.id),
    })
);
connectorAdminRoutes.get('/connections', async (c) =>
  c.json(await connections(c.env, undefined, c.req.query('cursor')))
);
connectorAdminRoutes.delete('/connections/:id', async (c) => {
  if (!(await revokeConnectorConnection(c.env, c.req.param('id'))))
    throw errors.notFound('Connection');
  return c.json({ revoked: true });
});
connectorAdminRoutes.get('/clients', async (c) => {
  await c.env.DATABASE.prepare(
    'DELETE FROM connector_oauth_clients WHERE expires_at IS NOT NULL AND expires_at<=?'
  )
    .bind(Date.now())
    .run();
  const rows = await c.env.DATABASE.prepare(
    'SELECT id,client_name,redirect_hosts,created_at,blocked FROM connector_oauth_clients WHERE id>? ORDER BY id LIMIT ?'
  )
    .bind(c.req.query('cursor') ?? '', pageSize(c.env) + 1)
    .all<{
      id: string;
      client_name: string;
      redirect_hosts: string;
      created_at: string;
      blocked: number;
    }>();
  return c.json({
    nextCursor:
      rows.results.length > pageSize(c.env)
        ? (rows.results[pageSize(c.env) - 1]?.id ?? null)
        : null,
    clients: rows.results.slice(0, pageSize(c.env)).map((row) => ({
      id: row.id,
      clientName: row.client_name,
      redirectHosts: v.parse(v.array(v.string()), JSON.parse(row.redirect_hosts)),
      createdAt: row.created_at,
      blocked: Boolean(row.blocked),
    })),
  });
});
connectorAdminRoutes.patch(
  '/clients/:id',
  jsonValidator(v.object({ blocked: v.boolean() })),
  async (c) => {
    const result = await c.env.DATABASE.prepare(
      'UPDATE connector_oauth_clients SET blocked=? WHERE id=?'
    )
      .bind(c.req.valid('json').blocked ? 1 : 0, c.req.param('id'))
      .run();
    if (!result.meta.changes) throw errors.notFound('Client');
    return c.json({ blocked: c.req.valid('json').blocked });
  }
);
