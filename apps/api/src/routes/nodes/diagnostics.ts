import { Hono } from 'hono';

import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireNodeOwnership } from '../../middleware/node-auth';
import { signNodeManagementToken } from '../../services/jwt';
import {
  fetchNodeAgent,
  getNodeAgentRequestTimeoutMs,
  listNodeEventsOnNode,
  nodeAgentRawRequest,
} from '../../services/node-agent';
import {
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeContainersFromNode,
} from '../../services/node-agent-diagnostics';

export const nodeDiagnosticsRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /:id/events — Proxy node events from the VM Agent.
 * Node events are proxied through the control plane because vm-* DNS records are
 * DNS-only (no Cloudflare SSL termination), so the browser cannot reach them directly
 * from an HTTPS page. Workspace events use ws-{id} subdomains which ARE Cloudflare-proxied.
 */
nodeDiagnosticsRoutes.get('/:id/events', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json({ events: [], nextCursor: null });
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);

  try {
    const result = await listNodeEventsOnNode(nodeId, c.env, userId, limit);
    return c.json(result);
  } catch {
    // Node agent may be unreachable — return empty rather than 500
    return c.json({ events: [], nextCursor: null });
  }
});

/**
 * GET /:id/system-info — Proxy system info from the VM Agent.
 * Returns CPU, memory, disk, Docker, software versions, and agent info.
 * Only available when the node is running.
 */
nodeDiagnosticsRoutes.get('/:id/system-info', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json(
      { error: 'NODE_NOT_RUNNING', message: 'System info unavailable when node is not running' },
      400
    );
  }

  try {
    const result = await getNodeSystemInfoFromNode(nodeId, c.env, userId);
    return c.json(result);
  } catch {
    // Node agent may be unreachable — return 503
    return c.json({ error: 'UNAVAILABLE', message: 'Could not reach node agent' }, 503);
  }
});

/**
 * GET /:id/logs — Proxy node logs from the VM Agent.
 * Passes through query params (source, level, container, since, until, search, cursor, limit)
 * to the VM Agent's /logs endpoint. Only available when the node is running.
 */
nodeDiagnosticsRoutes.get('/:id/logs', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json({ entries: [], nextCursor: null, hasMore: false });
  }

  // Pass through all query params to the VM Agent
  const queryString = new URL(c.req.url).searchParams.toString();

  try {
    const result = await getNodeLogsFromNode(nodeId, c.env, userId, queryString);
    return c.json(result);
  } catch {
    // Node agent may be unreachable — return empty rather than 500
    return c.json({ entries: [], nextCursor: null, hasMore: false });
  }
});

/**
 * GET /:id/containers — Proxy Docker container list from the VM Agent.
 * Used by log filters to offer per-container selection.
 */
nodeDiagnosticsRoutes.get('/:id/containers', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json({ containers: [], nodeId, unavailableReason: 'node_not_running' });
  }

  try {
    const result = await listNodeContainersFromNode(nodeId, c.env, userId);
    return c.json({
      ...(typeof result === 'object' && result !== null ? result : { containers: [] }),
      nodeId,
    });
  } catch {
    return c.json({ containers: [], nodeId, unavailableReason: 'node_agent_unreachable' }, 503);
  }
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

/**
 * GET /:id/events/export — Download the raw SQLite event database from the VM Agent.
 * Streams the binary file through to the browser as an attachment download.
 */
nodeDiagnosticsRoutes.get('/:id/events/export', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }
  if (node.status !== 'running') {
    throw errors.badRequest('Node is not running');
  }

  try {
    const response = await nodeAgentRawRequest(nodeId, c.env, '/events/export', userId);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`VM agent returned ${response.status}: ${body}`);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/x-sqlite3',
        'Content-Disposition':
          response.headers.get('Content-Disposition') ||
          `attachment; filename="events-${nodeId}.db"`,
        'Content-Length': response.headers.get('Content-Length') || '',
      },
    });
  } catch {
    throw errors.badRequest('Could not download events database — node agent may be unreachable');
  }
});

/**
 * GET /:id/metrics/export — Download the raw SQLite metrics database from the VM Agent.
 * Streams the binary file through to the browser as an attachment download.
 */
nodeDiagnosticsRoutes.get('/:id/metrics/export', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }
  if (node.status !== 'running') {
    throw errors.badRequest('Node is not running');
  }

  try {
    const response = await nodeAgentRawRequest(nodeId, c.env, '/metrics/export', userId);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`VM agent returned ${response.status}: ${body}`);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/x-sqlite3',
        'Content-Disposition':
          response.headers.get('Content-Disposition') ||
          `attachment; filename="metrics-${nodeId}.db"`,
        'Content-Length': response.headers.get('Content-Length') || '',
      },
    });
  } catch {
    throw errors.badRequest('Could not download metrics database — node agent may be unreachable');
  }
});

/**
 * GET /:id/debug-package — Download a tar.gz archive with all diagnostic data
 * from the VM Agent: logs (cloud-init, journald, Docker), metrics DB, events DB,
 * system info, boot events, and system state snapshots.
 */
nodeDiagnosticsRoutes.get('/:id/debug-package', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }
  if (node.status !== 'running') {
    throw errors.badRequest('Node is not running');
  }

  try {
    const response = await nodeAgentRawRequest(nodeId, c.env, '/debug-package', userId);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`VM agent returned ${response.status}: ${body}`);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/gzip',
        'Content-Disposition':
          response.headers.get('Content-Disposition') ||
          `attachment; filename="debug-${nodeId}.tar.gz"`,
      },
    });
  } catch {
    throw errors.badRequest('Could not download debug package — node agent may be unreachable');
  }
});
