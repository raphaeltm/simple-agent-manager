import { type Context, Hono } from 'hono';

import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireNodeOwnership } from '../../middleware/node-auth';
import { signNodeManagementToken } from '../../services/jwt';
import {
  fetchNodeAgent,
  getNodeAgentRequestTimeoutMs,
  listNodeEventsOnNode,
} from '../../services/node-agent';
import {
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeContainersFromNode,
  openNodeDiagnosticDownload,
} from '../../services/node-agent-diagnostics';
import { ownerNodeAccess, runNodeDiagnostic } from '../../services/node-diagnostics-access';

export const nodeDiagnosticsRoutes = new Hono<{ Bindings: Env }>();

async function ownedNode(c: Context<{ Bindings: Env }>, nodeId: string) {
  const node = await requireNodeOwnership(c, nodeId);
  if (!node) throw errors.notFound('Node');
  return node;
}

/**
 * GET /:id/events — Proxy node events from the VM Agent.
 * Node events are proxied through the control plane because vm-* DNS records are
 * DNS-only (no Cloudflare SSL termination), so the browser cannot reach them directly
 * from an HTTPS page. Workspace events use ws-{id} subdomains which ARE Cloudflare-proxied.
 */
nodeDiagnosticsRoutes.get('/:id/events', async (c) => {
  const nodeId = c.req.param('id');
  const node = await ownedNode(c, nodeId);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const outcome = await runNodeDiagnostic(node, ownerNodeAccess(getUserId(c)), (id, userId) =>
    listNodeEventsOnNode(id, c.env, userId, limit)
  );
  // Not running or unreachable: an empty page rather than an error.
  return c.json(outcome.status === 'ok' ? outcome.value : { events: [], nextCursor: null });
});

/**
 * GET /:id/system-info — Proxy system info from the VM Agent.
 * Returns CPU, memory, disk, Docker, software versions, and agent info.
 * Only available when the node is running.
 */
nodeDiagnosticsRoutes.get('/:id/system-info', async (c) => {
  const nodeId = c.req.param('id');
  const node = await ownedNode(c, nodeId);
  const outcome = await runNodeDiagnostic(node, ownerNodeAccess(getUserId(c)), (id, userId) =>
    getNodeSystemInfoFromNode(id, c.env, userId)
  );
  if (outcome.status === 'not_running') {
    return c.json(
      { error: 'NODE_NOT_RUNNING', message: 'System info unavailable when node is not running' },
      400
    );
  }
  if (outcome.status === 'unreachable') {
    return c.json({ error: 'UNAVAILABLE', message: 'Could not reach node agent' }, 503);
  }
  return c.json(outcome.value);
});

/**
 * GET /:id/logs — Proxy node logs from the VM Agent.
 * Passes through query params (source, level, container, since, until, search, cursor, limit)
 * to the VM Agent's /logs endpoint. Only available when the node is running.
 */
nodeDiagnosticsRoutes.get('/:id/logs', async (c) => {
  const nodeId = c.req.param('id');
  const node = await ownedNode(c, nodeId);
  // Pass through all query params to the VM Agent
  const queryString = new URL(c.req.url).searchParams.toString();
  const outcome = await runNodeDiagnostic(node, ownerNodeAccess(getUserId(c)), (id, userId) =>
    getNodeLogsFromNode(id, c.env, userId, queryString)
  );
  // Not running or unreachable: an empty page rather than an error.
  return c.json(
    outcome.status === 'ok' ? outcome.value : { entries: [], nextCursor: null, hasMore: false }
  );
});

/**
 * GET /:id/containers — Proxy Docker container list from the VM Agent.
 * Used by log filters to offer per-container selection.
 */
nodeDiagnosticsRoutes.get('/:id/containers', async (c) => {
  const nodeId = c.req.param('id');
  const node = await ownedNode(c, nodeId);
  const outcome = await runNodeDiagnostic(node, ownerNodeAccess(getUserId(c)), (id, userId) =>
    listNodeContainersFromNode(id, c.env, userId)
  );
  if (outcome.status === 'not_running') {
    return c.json({ containers: [], nodeId, unavailableReason: 'node_not_running' });
  }
  if (outcome.status === 'unreachable') {
    return c.json({ containers: [], nodeId, unavailableReason: 'node_agent_unreachable' }, 503);
  }
  const result = outcome.value;
  return c.json({
    ...(typeof result === 'object' && result !== null ? result : { containers: [] }),
    nodeId,
  });
});

/**
 * GET /:id/logs/stream — WebSocket proxy for real-time log streaming from the VM Agent.
 * Authenticates the user, verifies node ownership, signs a management JWT,
 * and proxies the WebSocket connection to the VM agent's /logs/stream endpoint.
 */
nodeDiagnosticsRoutes.get('/:id/logs/stream', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    throw errors.badRequest(`Node is not running (status: ${node.status})`);
  }

  // Sign a management JWT for the VM agent
  const { token } = await signNodeManagementToken(userId, nodeId, null, c.env);

  // Build the VM agent WebSocket URL with all query params
  const clientUrl = new URL(c.req.url);
  const vmProtocol = c.env.VM_AGENT_PROTOCOL || 'https';
  const vmPort = c.env.VM_AGENT_PORT || '8443';
  const vmUrl = new URL(
    `${vmProtocol}://${nodeId.toLowerCase()}.vm.${c.env.BASE_DOMAIN}:${vmPort}/logs/stream`
  );
  vmUrl.searchParams.set('token', token);

  // Forward filter params from client
  for (const [key, value] of clientUrl.searchParams.entries()) {
    if (key !== 'token') {
      vmUrl.searchParams.set(key, value);
    }
  }

  // Proxy only WebSocket handshake headers to the VM agent. Browser/control-plane
  // credentials such as Cookie or Authorization must not be forwarded because
  // VM-agent diagnostic auth gives Authorization precedence over the query token.
  const clientHeaders = c.req.raw.headers;
  const headers = new Headers();
  for (const name of [
    'Upgrade',
    'Connection',
    'Sec-WebSocket-Key',
    'Sec-WebSocket-Version',
    'Sec-WebSocket-Protocol',
    'Sec-WebSocket-Extensions',
    'Origin',
  ]) {
    const value = clientHeaders.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-SAM-Node-Id', nodeId);

  return fetchNodeAgent(
    nodeId,
    c.env,
    vmUrl.toString(),
    {
      method: 'GET',
      headers,
    },
    getNodeAgentRequestTimeoutMs(c.env)
  );
});

interface NodeDownload {
  path: '/debug-package' | '/events/export' | '/metrics/export';
  contentType: string;
  filename: string;
  extension: string;
  errorMessage: string;
  includeLength?: boolean;
}

async function downloadNodeDiagnostics(
  c: Context<{ Bindings: Env }>,
  options: NodeDownload
): Promise<Response> {
  const nodeId = c.req.param('id');
  if (!nodeId) throw errors.notFound('Node');
  const node = await ownedNode(c, nodeId);
  const outcome = await runNodeDiagnostic(node, ownerNodeAccess(getUserId(c)), (id, userId) =>
    openNodeDiagnosticDownload(id, c.env, userId, options.path)
  );
  if (outcome.status === 'not_running') throw errors.badRequest('Node is not running');
  if (outcome.status === 'unreachable') throw errors.badRequest(options.errorMessage);
  const response = outcome.value;
  const headers: Record<string, string> = {
    'Content-Type': response.headers.get('Content-Type') || options.contentType,
    'Content-Disposition':
      response.headers.get('Content-Disposition') ||
      `attachment; filename="${options.filename}-${nodeId}.${options.extension}"`,
  };
  if (options.includeLength)
    headers['Content-Length'] = response.headers.get('Content-Length') || '';
  return new Response(response.body, { status: 200, headers });
}

/** Download raw VM Agent diagnostic artifacts for an owned, running node. */
nodeDiagnosticsRoutes.get('/:id/events/export', (c) =>
  downloadNodeDiagnostics(c, {
    path: '/events/export',
    contentType: 'application/x-sqlite3',
    filename: 'events',
    extension: 'db',
    errorMessage: 'Could not download events database — node agent may be unreachable',
    includeLength: true,
  })
);

nodeDiagnosticsRoutes.get('/:id/metrics/export', (c) =>
  downloadNodeDiagnostics(c, {
    path: '/metrics/export',
    contentType: 'application/x-sqlite3',
    filename: 'metrics',
    extension: 'db',
    errorMessage: 'Could not download metrics database — node agent may be unreachable',
    includeLength: true,
  })
);

nodeDiagnosticsRoutes.get('/:id/debug-package', (c) =>
  downloadNodeDiagnostics(c, {
    path: '/debug-package',
    contentType: 'application/gzip',
    filename: 'debug',
    extension: 'tar.gz',
    errorMessage: 'Could not download debug package — node agent may be unreachable',
  })
);
