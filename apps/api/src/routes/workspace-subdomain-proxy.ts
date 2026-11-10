/**
 * Browser traffic for workspace subdomains (`ws-{id}.*` and `ws-{id}--{port}.*`): authenticate
 * (session, terminal token, port-access cookie/token, public-port setting), authorize against
 * D1, then proxy to the node's vm-agent. Extracted verbatim from `index.ts` (rule 18).
 *
 * On a self-hosted box the same handler also answers Caddy forward_auth for WebSocket upgrades
 * (`routes/self-host-gateway.ts`): when the request is a gateway authorization request it
 * returns the upstream decision instead of fetching, so the gateway runs exactly this auth.
 */
import type { WorkspaceStatus } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Next } from 'hono';

import { createAuth } from '../auth';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { stripPreviewAuthCookies } from '../lib/preview-cookies';
import { parseWorkspaceSubdomain } from '../lib/workspace-subdomain';
import { signTerminalToken, verifyTerminalToken } from '../services/jwt';
import { getNodeBackendBaseUrl } from '../services/node-agent-readiness';
import {
  type NodeAgentRoute,
  NodeAgentRouteError,
  nodeAgentRouteFromRow,
  readNodeAgentRouteRow,
} from '../services/node-agent-route';
import {
  gatewayDecisionResponse,
  gatewayUnsupportedRuntimeResponse,
  isGatewayAuthorizationRequest,
} from '../services/node-websocket-gateway';
import { assertSessionUserApproved } from '../services/signup-approval';
import { recordNodeRoutingMetric } from '../services/telemetry';
import { assertTerminalTokenSessionLive } from '../services/terminal-token-liveness';
import {
  fetchVmAgentContainer,
  getVmAgentContainerConfig,
  SAM_PROXIED_REQUEST_HEADER,
} from '../services/vm-agent-container';
import { resolveWorkspacePortAccess } from './workspace-port-access';
import {
  isExpectedWorkspacePortsUpstreamUnavailable,
  isWorkspacePortsListRequest,
  workspacePortsReadinessPayload,
  workspacePortsStateForStatus,
} from './workspaces/ports-readiness';

// Proxy requests for workspace subdomains (ws-{id}.*) to the VM agent.
// The wildcard DNS *.{domain} routes through this Worker, so we must proxy
// workspace requests to the actual VM running the agent on the configured port.
// vm-{id} DNS records are orange-clouded; CF edge terminates TLS and re-encrypts
// to the VM agent's Origin CA cert. This handles both HTTP and WebSocket requests.
export async function workspaceSubdomainProxy(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const baseDomain = c.env?.BASE_DOMAIN || '';

  // Parse workspace ID and optional port from subdomain.
  const parsed = parseWorkspaceSubdomain(hostname, baseDomain);
  if (!parsed) {
    await next();
    return;
  }
  if ('error' in parsed) {
    log.info('ws_proxy_invalid_subdomain', { hostname, reason: parsed.error });
    return c.json({ error: 'INVALID_WORKSPACE', message: 'Invalid workspace subdomain' }, 400);
  }
  const { workspaceId, targetPort } = parsed;

  // --- Port-access authentication (cookie + token handshake) ---
  // For port-specific subdomains (ws-{id}--{port}), check the port-access cookie
  // and ?port_token= query param BEFORE the normal session/terminal-token paths.
  // This is necessary because BetterAuth cookies are scoped to api.{BASE_DOMAIN}
  // and are NOT sent to ws-{id}--{port}.{BASE_DOMAIN} subdomains.
  let userId: string | null = null;
  let portAccessRedirect: Response | null = null;
  let publicPortAccess = false;

  if (targetPort !== null) {
    const access = await resolveWorkspacePortAccess(c, url, workspaceId, targetPort);
    if (access instanceof Response) return access;
    ({ userId, portAccessRedirect, publicPortAccess } = access);
    // The 302 is returned after the D1 ownership check below passes.
  }

  // --- Standard session/terminal-token authentication (non-port or fallback) ---
  if (!userId) {
    const auth = await createAuth(c.env);
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    });
    if (session?.user) {
      await assertSessionUserApproved(c.env, session.user);
      userId = session.user.id;
    }
  }

  if (!userId) {
    const token = url.searchParams.get('token');
    if (!token) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    try {
      const payload = await verifyTerminalToken(token, c.env);
      if (payload.workspace !== workspaceId || payload.subject === 'port-proxy') {
        return c.json({ error: 'UNAUTHORIZED', message: 'Invalid workspace token' }, 401);
      }
      await assertTerminalTokenSessionLive(c.env, payload);
      userId = payload.subject;
    } catch (err) {
      log.warn('ws_proxy_terminal_token_rejected', {
        workspaceId,
        ...serializeError(err),
      });
      return c.json({ error: 'UNAUTHORIZED', message: 'Invalid workspace token' }, 401);
    }
  }

  // Look up workspace routing metadata from D1.
  const db = drizzle(c.env.DATABASE, { schema });
  const workspace = await db
    .select({
      nodeId: schema.workspaces.nodeId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .get();

  const portsListRequest = isWorkspacePortsListRequest(c.req.raw.method, url.pathname, workspaceId);
  if (!workspace) {
    if (portsListRequest) {
      return c.json(workspacePortsReadinessPayload('gone', null, 'Workspace not found', false));
    }
    return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
  }

  const workspaceStatus = workspace.status as WorkspaceStatus;
  // One read for runtime, transport and the current incarnation's reverse-tunnel lease port.
  const nodeRouteRow = workspace.nodeId
    ? await readNodeAgentRouteRow(c.env, workspace.nodeId)
    : null;
  const nodeRuntime = nodeRouteRow?.runtime ?? 'vm';
  const gatewayRequest = isGatewayAuthorizationRequest(c.req.raw);

  if (workspaceStatus !== 'running' && workspaceStatus !== 'recovery') {
    // Allow boot-log WebSocket during creation for real-time streaming
    if (workspaceStatus === 'creating' && url.pathname === '/boot-log/ws') {
      // Fall through to proxy
    } else if (portsListRequest) {
      const state = workspacePortsStateForStatus(workspaceStatus);
      return c.json(
        workspacePortsReadinessPayload(
          state,
          workspaceStatus,
          `Workspace is ${workspaceStatus}`,
          state === 'not_ready'
        )
      );
    } else {
      return c.json({ error: 'NOT_READY', message: `Workspace is ${workspaceStatus}` }, 503);
    }
  }

  // 5b continued: Return the 302 redirect now that ownership is verified.
  // This ensures the cookie is only set after the D1 ownership check passes.
  if (portAccessRedirect) {
    return portAccessRedirect;
  }

  if (nodeRuntime === 'cf-container') {
    if (gatewayRequest) return gatewayUnsupportedRuntimeResponse();
    const containerConfig = getVmAgentContainerConfig(c.env);
    if (!containerConfig.enabled) {
      return c.json(
        { error: 'CF_CONTAINER_DISABLED', message: 'Container workspace runtime is disabled' },
        503
      );
    }
    if (!c.env.VM_AGENT_CONTAINER) {
      return c.json(
        { error: 'CF_CONTAINER_UNAVAILABLE', message: 'VM agent container binding is unavailable' },
        503
      );
    }

    const containerId = workspace.nodeId || workspaceId;
    const vmAgentPort = containerConfig.vmAgentPort;
    // The container shares one network namespace with its vm-agent, so the agent's
    // own port is never a workspace port (the vm-agent refuses it too). VM routes
    // target the workspace container's bridge IP, where the host agent does not listen.
    if (targetPort === vmAgentPort) {
      log.warn('ws_proxy_cf_container_reserved_port', {
        workspaceId,
        targetPort,
        action: 'rejected',
      });
      const message = `Port ${targetPort} is reserved for the SAM workspace agent and cannot be proxied`;
      return c.json({ error: 'PORT_RESERVED', message }, 403);
    }
    const containerUrl = new URL(`http://localhost:${vmAgentPort}`);
    containerUrl.pathname = url.pathname;
    containerUrl.search = url.search;

    if (targetPort !== null) {
      const subPath = url.pathname === '/' ? '' : url.pathname;
      containerUrl.pathname = `/workspaces/${workspaceId}/ports/${targetPort}${subPath}`;
      containerUrl.searchParams.delete('port_token');
      try {
        const { token } = await signTerminalToken('port-proxy', workspaceId, c.env);
        containerUrl.searchParams.set('token', token);
      } catch (err) {
        log.error('cf_container_port_proxy_token_error', {
          workspaceId,
          ...serializeError(err),
        });
        return c.json(
          { error: 'TOKEN_ERROR', message: 'Failed to generate port proxy token' },
          500
        );
      }
    }

    const headers = new Headers(c.req.raw.headers);
    if (targetPort !== null) stripPreviewAuthCookies(headers);
    headers.delete('x-sam-node-id');
    headers.delete('x-sam-workspace-id');
    headers.delete('x-forwarded-host');
    headers.delete('x-sam-gateway-secret');
    headers.set('X-SAM-Node-Id', workspace.nodeId || workspaceId);
    headers.set('X-SAM-Workspace-Id', workspaceId);
    headers.set('X-Forwarded-Host', hostname);
    headers.set('X-Forwarded-Proto', 'https');
    // Marks the request as relayed so the vm-agent never grants peer-address
    // (loopback) trust to it; see packages/vm-agent/internal/server/proxy_guard.go.
    headers.set(SAM_PROXIED_REQUEST_HEADER, '1');

    log.info('ws_proxy_cf_container_route', {
      workspaceId,
      nodeId: containerId,
      containerId,
      vmAgentPort,
      targetPort,
      publicPortAccess,
      method: c.req.raw.method,
      path: url.pathname,
    });
    recordNodeRoutingMetric(
      {
        metric: 'ws_proxy_route',
        nodeId: containerId,
        workspaceId,
      },
      c.env
    );

    const containerRequest = new Request(containerUrl.toString(), {
      redirect: targetPort !== null ? 'manual' : c.req.raw.redirect,
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error — Cloudflare Workers support duplex for streaming request bodies
      duplex: c.req.raw.body ? 'half' : undefined,
    });
    let response: Response;
    try {
      response = await fetchVmAgentContainer(c.env, containerId, containerRequest, vmAgentPort);
    } catch (err) {
      if (portsListRequest) {
        return c.json(
          workspacePortsReadinessPayload(
            'not_ready',
            workspaceStatus,
            'Workspace ports are not ready',
            true,
            { runtime: 'cf-container', reason: 'fetch_exception' }
          ),
          202
        );
      }
      throw err;
    }

    if (portsListRequest && isExpectedWorkspacePortsUpstreamUnavailable(response.status)) {
      return c.json(
        workspacePortsReadinessPayload(
          'not_ready',
          workspaceStatus,
          'Workspace ports are not ready',
          true,
          { runtime: 'cf-container', upstreamStatus: response.status }
        ),
        202
      );
    }

    if (targetPort !== null) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('set-cookie');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        // A 101 response must carry its accepted socket through cookie filtering.
        webSocket: response.webSocket,
      });
    }
    return response;
  }

  // Proxy to the VM agent via its proxied (orange-clouded) backend hostname.
  // The explicit scriptless *.vm route prevents recursion through this Worker.
  // Its DNS record selects legacy public-IP or Cloudflare Tunnel transport. A reverse-tunnel
  // node has no DNS record: it is reached on its leased loopback port on this box.
  let nodeRoute: NodeAgentRoute;
  try {
    nodeRoute = nodeAgentRouteFromRow(workspace.nodeId || workspaceId, nodeRouteRow, c.env);
  } catch (err) {
    if (!(err instanceof NodeAgentRouteError)) throw err;
    log.warn('ws_proxy_node_route_unavailable', { workspaceId, nodeId: workspace.nodeId });
    if (portsListRequest) {
      return c.json(
        workspacePortsReadinessPayload(
          'not_ready',
          workspaceStatus,
          'Workspace ports are not ready',
          true,
          { runtime: 'vm', reason: 'node_route_unavailable' }
        ),
        202
      );
    }
    return c.json({ error: 'NODE_UNREACHABLE', message: 'Workspace node is not reachable' }, 503);
  }
  const routedNodeId = (workspace.nodeId || workspaceId).toLowerCase();
  const backendHostname = `${routedNodeId}.vm.${baseDomain}`;
  log.info('ws_proxy_route', {
    workspaceId,
    nodeId: workspace.nodeId || workspaceId,
    backendHostname,
    targetPort,
    publicPortAccess,
    method: c.req.raw.method,
    path: url.pathname,
  });
  recordNodeRoutingMetric(
    {
      metric: 'ws_proxy_route',
      nodeId: workspace.nodeId || workspaceId,
      workspaceId,
    },
    c.env
  );
  // Both origins come from trusted routing config, never from the request: the fixed loopback
  // lease origin for a reverse-tunnel node, the backend hostname for every other transport.
  const vmUrl =
    nodeRoute.kind === 'reverse-tunnel'
      ? new URL(nodeRoute.origin)
      : new URL(getNodeBackendBaseUrl(routedNodeId, c.env));
  vmUrl.pathname = url.pathname;
  vmUrl.search = url.search;

  // Route port-specific requests to the VM agent's port proxy endpoint.
  // ws-{id}--3000.example.com/foo → {backend}/workspaces/{id}/ports/3000/foo
  if (targetPort !== null) {
    const subPath = url.pathname === '/' ? '' : url.pathname;
    vmUrl.pathname = `/workspaces/${workspaceId}/ports/${targetPort}${subPath}`;

    // Strip port_token from the proxied URL (it was already validated above).
    vmUrl.searchParams.delete('port_token');

    // Inject a workspace-scoped JWT so the VM agent can authenticate this request.
    // Port-forwarded URLs are accessed directly by browsers which have no pre-existing
    // workspace session cookie or token. The Worker is a trusted intermediary that has
    // already validated the workspace exists and is running.
    try {
      const { token } = await signTerminalToken('port-proxy', workspaceId, c.env);
      vmUrl.searchParams.set('token', token);
    } catch (err) {
      log.error('port_proxy_token_error', {
        workspaceId,
        ...serializeError(err),
      });
      return c.json({ error: 'TOKEN_ERROR', message: 'Failed to generate port proxy token' }, 500);
    }
  }

  // Strip client-supplied routing headers and inject trusted routing context.
  const headers = new Headers(c.req.raw.headers);
  if (targetPort !== null) stripPreviewAuthCookies(headers);
  headers.delete('x-sam-node-id');
  headers.delete('x-sam-workspace-id');
  headers.delete('x-forwarded-host');
  // The self-hosted gateway secret authenticates Caddy to the Worker; it never goes to a node.
  headers.delete('x-sam-gateway-secret');
  headers.set('X-SAM-Node-Id', workspace.nodeId || workspaceId);
  headers.set('X-SAM-Workspace-Id', workspaceId);

  // Preserve the original client-facing hostname (e.g., ws-abc123--3000.example.com)
  // so the VM agent can forward it to container services. The fetch() to the VM agent
  // rewrites the Host header to the VM hostname for Cloudflare edge routing, losing
  // the original. X-Forwarded-Proto is always https since clients connect via CF edge.
  headers.set('X-Forwarded-Host', hostname);
  headers.set('X-Forwarded-Proto', 'https');

  // Self-hosted WebSocket gateway: everything above (auth, ownership, status, port token,
  // header rewriting) has run unchanged; Caddy proxies the socket to the decided upstream.
  if (gatewayRequest) {
    return gatewayDecisionResponse(c.req.raw, nodeRoute, { url: vmUrl, headers }, c.env);
  }

  let response: Response;
  try {
    response = await fetch(vmUrl.toString(), {
      // A reverse-tunnel node sits on this box's loopback: never follow its redirects there.
      redirect:
        targetPort !== null || nodeRoute.kind === 'reverse-tunnel' ? 'manual' : c.req.raw.redirect,
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error — Cloudflare Workers support duplex for streaming request bodies
      duplex: c.req.raw.body ? 'half' : undefined,
    });
  } catch (err) {
    if (portsListRequest) {
      return c.json(
        workspacePortsReadinessPayload(
          'not_ready',
          workspaceStatus,
          'Workspace ports are not ready',
          true,
          { runtime: 'vm', reason: 'fetch_exception' }
        ),
        202
      );
    }
    throw err;
  }

  if (portsListRequest && isExpectedWorkspacePortsUpstreamUnavailable(response.status)) {
    return c.json(
      workspacePortsReadinessPayload(
        'not_ready',
        workspaceStatus,
        'Workspace ports are not ready',
        true,
        { runtime: 'vm', upstreamStatus: response.status }
      ),
      202
    );
  }

  // 5e: Strip Set-Cookie headers from container responses on port-proxy path.
  // Prevents a malicious container app from overwriting the sam_port_access cookie.
  if (targetPort !== null) {
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
      // Preserve preview WebSockets (including dev-server HMR).
      webSocket: response.webSocket,
    });
  }

  return response;
}
