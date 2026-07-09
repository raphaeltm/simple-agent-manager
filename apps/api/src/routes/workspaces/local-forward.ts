import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  signLocalForwardToken,
  verifyLocalForwardToken,
} from '../../services/jwt';
import { fetchNodeAgent, getNodeAgentRequestTimeoutMs } from '../../services/node-agent';
import { getOwnedWorkspace, isActiveWorkspaceStatus } from './_helpers';

const localForwardRoutes = new Hono<{ Bindings: Env }>();

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function parsePort(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw errors.badRequest(`${field} must be an integer between 1 and 65535`);
  }
  return value;
}

function parseLocalAuthority(value: unknown): string {
  if (typeof value !== 'string') {
    throw errors.badRequest('localAuthority is required');
  }
  const authority = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw errors.badRequest('localAuthority must be host:port using localhost or 127.0.0.1');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw errors.badRequest('localAuthority must be host:port only');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw errors.badRequest('localAuthority must use localhost or 127.0.0.1');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw errors.badRequest('localAuthority must include a valid port');
  }
  return `${parsed.hostname}:${port}`;
}

function deleteConnectionListedHeaders(headers: Headers): void {
  const connection = headers.get('Connection');
  if (!connection) {
    return;
  }
  for (const token of connection.split(',')) {
    const name = token.trim();
    if (name) {
      headers.delete(name);
    }
  }
}

function stripUntrustedForwardHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  deleteConnectionListedHeaders(clean);
  for (const name of Array.from(clean.keys())) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith('x-sam-') ||
      lower.startsWith('x-forwarded-') ||
      lower === 'forwarded' ||
      HOP_BY_HOP_HEADERS.has(lower)
    ) {
      clean.delete(name);
    }
  }
  return clean;
}

function vmAgentBaseUrl(nodeId: string, env: Env): URL {
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  return new URL(`${protocol}://${nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}`);
}

async function requireRoutedWorkspace(c: Context<{ Bindings: Env }>, workspaceId: string, userId: string) {
  const db = drizzle(c.env.DATABASE, { schema });
  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no node assigned');
  }
  if (!isActiveWorkspaceStatus(workspace.status)) {
    throw errors.badRequest(`Workspace is ${workspace.status}, not running`);
  }
  return workspace;
}

localForwardRoutes.post('/:id/forwards', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const remotePort = parsePort((body as Record<string, unknown>).remotePort, 'remotePort');
  const localAuthority = parseLocalAuthority((body as Record<string, unknown>).localAuthority);
  const mode = (body as Record<string, unknown>).mode ?? 'http';
  if (mode !== 'http') {
    throw errors.badRequest('only http local forwarding is supported');
  }

  const workspace = await requireRoutedWorkspace(c, workspaceId, userId);
  const nodeId = workspace.nodeId;
  if (!nodeId) {
    throw errors.badRequest('Workspace has no node assigned');
  }
  const { token, expiresAt } = await signLocalForwardToken({
    userId,
    workspaceId,
    nodeId,
    remotePort,
    mode: 'http',
    localAuthority,
  }, c.env);

  return c.json({
    token,
    expiresAt,
    workspaceId,
    nodeId,
    remotePort,
    mode: 'http',
    localAuthority,
    forwardPath: `/api/workspaces/${encodeURIComponent(workspaceId)}/local-forward/${remotePort}`,
  });
});

async function handleLocalForwardProxy(c: Context<{ Bindings: Env }>) {
  const workspaceId = c.req.param('id');
  const portParam = c.req.param('port');
  const remotePort = parsePort(Number(portParam), 'port');
  const token = c.req.header('X-SAM-Forward-Token');
  if (!token) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Missing local forward token' }, 401);
  }

  let claims;
  try {
    claims = await verifyLocalForwardToken(token, c.env);
  } catch (err) {
    log.warn('local_forward_token_rejected', { workspaceId, ...serializeError(err) });
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid local forward token' }, 401);
  }

  if (claims.workspaceId !== workspaceId || claims.remotePort !== remotePort) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Local forward token scope mismatch' }, 401);
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const workspace = await db
    .select({
      nodeId: schema.workspaces.nodeId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, claims.userId)))
    .get();
  if (!workspace) {
    return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
  }
  if (!workspace.nodeId || workspace.nodeId !== claims.nodeId) {
    return c.json({ error: 'NOT_READY', message: 'Workspace route changed' }, 409);
  }
  if (!isActiveWorkspaceStatus(workspace.status)) {
    return c.json({ error: 'NOT_READY', message: `Workspace is ${workspace.status}` }, 503);
  }

  if (c.req.header('Upgrade')) {
    return c.json({ error: 'UNSUPPORTED_UPGRADE', message: 'WebSocket upgrades are not supported by CLI local forwarding yet' }, 501);
  }

  const sourceUrl = new URL(c.req.url);
  const prefix = `/api/workspaces/${workspaceId}/local-forward/${remotePort}`;
  const subPath = sourceUrl.pathname.startsWith(prefix)
    ? sourceUrl.pathname.slice(prefix.length) || '/'
    : '/';
  const vmUrl = vmAgentBaseUrl(claims.nodeId, c.env);
  vmUrl.pathname = `/workspaces/${workspaceId}/local-forward/${remotePort}${subPath}`;
  vmUrl.search = sourceUrl.search;

  const headers = stripUntrustedForwardHeaders(c.req.raw.headers);
  headers.set('X-SAM-VM-Forward-Token', token);
  headers.set('X-SAM-Local-Authority', claims.localAuthority);
  headers.set('X-Forwarded-Host', claims.localAuthority);
  headers.set('X-Forwarded-Proto', 'http');
  headers.set('X-Forwarded-For', c.req.header('CF-Connecting-IP') ?? '');

  const response = await fetchNodeAgent(claims.nodeId, c.env, vmUrl.toString(), {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    redirect: 'manual',
    // @ts-expect-error Cloudflare Workers support streaming request bodies.
    duplex: c.req.raw.body ? 'half' : undefined,
  }, getNodeAgentRequestTimeoutMs(c.env));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

localForwardRoutes.all('/:id/local-forward/:port', handleLocalForwardProxy);
localForwardRoutes.all('/:id/local-forward/:port/*', handleLocalForwardProxy);

export { localForwardRoutes };
