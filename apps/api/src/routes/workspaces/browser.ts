import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { getUserId, requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { signTerminalToken } from '../../services/jwt';
import { getOwnedWorkspace, isActiveWorkspaceStatus } from './_helpers';

const browserRoutes = new Hono<{ Bindings: Env }>();

/** Default timeout for browser sidecar proxy requests (configurable via BROWSER_PROXY_TIMEOUT_MS). */
const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 30_000;

const FORWARDED_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
];

/**
 * Proxy a browser sidecar request to the VM agent for a workspace.
 */
async function proxyBrowserToVmAgent(
  env: Env,
  nodeId: string,
  workspaceId: string,
  userId: string,
  vmPath: string,
  method: string,
  body?: ReadableStream<Uint8Array> | null,
  contentType?: string
): Promise<Response> {
  const rawTimeout = parseInt(env.BROWSER_PROXY_TIMEOUT_MS ?? '');
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const workspaceUrl = `${protocol}://${nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}`;
  const { token } = await signTerminalToken(userId, workspaceId, env);

  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/${vmPath}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
  };

  const fetchOpts: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    fetchOpts.body = body;
    headers['Content-Type'] = contentType || 'application/json';
    // @ts-expect-error — duplex required for streaming bodies in Workers/Node 18+
    fetchOpts.duplex = 'half';
  }

  let res: Response;
  try {
    res = await fetch(url, fetchOpts);
  } catch (fetchErr) {
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    log.error('browser_proxy.fetch_error', {
      workspaceId,
      vmPath,
      url,
      error: errMsg,
    });
    throw errors.badRequest(
      `Workspace agent unreachable: ${errMsg.includes('timeout') || errMsg.includes('abort') ? 'request timed out' : 'connection failed'}`
    );
  }

  if (!res.ok) {
    const text = await res.text();
    log.error('browser_proxy.vm_agent_error', {
      workspaceId,
      vmPath,
      status: res.status,
      body: text,
    });
    if (res.status === 404) throw errors.notFound('Browser sidecar not found');
    if (res.status >= 500) throw errors.internal(`Workspace agent unavailable (${res.status})`);
    throw errors.badRequest('VM agent returned an error');
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has('Content-Type')) {
    responseHeaders.set('Content-Type', 'application/json');
  }

  return new Response(res.body, { status: res.status, headers: responseHeaders });
}

// POST /:id/browser — start browser sidecar
browserRoutes.post('/:id/browser', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!isActiveWorkspaceStatus(workspace.status)) {
    throw errors.badRequest(`Workspace is not accessible (status: ${workspace.status})`);
  }
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no assigned node');
  }

  return proxyBrowserToVmAgent(
    c.env, workspace.nodeId, workspace.id, userId,
    'browser', 'POST', c.req.raw.body, c.req.header('Content-Type')
  );
});

// GET /:id/browser — get browser sidecar status
browserRoutes.get('/:id/browser', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!isActiveWorkspaceStatus(workspace.status)) {
    throw errors.badRequest(`Workspace is not accessible (status: ${workspace.status})`);
  }
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no assigned node');
  }

  return proxyBrowserToVmAgent(
    c.env, workspace.nodeId, workspace.id, userId,
    'browser', 'GET'
  );
});

// DELETE /:id/browser — stop browser sidecar
browserRoutes.delete('/:id/browser', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!isActiveWorkspaceStatus(workspace.status)) {
    throw errors.badRequest(`Workspace is not accessible (status: ${workspace.status})`);
  }
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no assigned node');
  }

  return proxyBrowserToVmAgent(
    c.env, workspace.nodeId, workspace.id, userId,
    'browser', 'DELETE'
  );
});

// GET /:id/browser/ports — list active socat forwarders
browserRoutes.get('/:id/browser/ports', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!isActiveWorkspaceStatus(workspace.status)) {
    throw errors.badRequest(`Workspace is not accessible (status: ${workspace.status})`);
  }
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no assigned node');
  }

  return proxyBrowserToVmAgent(
    c.env, workspace.nodeId, workspace.id, userId,
    'browser/ports', 'GET'
  );
});

export { browserRoutes };
