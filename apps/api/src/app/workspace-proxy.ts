import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { createAuth } from '../auth';
import * as schema from '../db/schema';
import { log, serializeError } from '../lib/logger';
import { parseWorkspaceSubdomain } from '../lib/workspace-subdomain';
import { signTerminalToken, verifyPortAccessToken, verifyTerminalToken } from '../services/jwt';
import { recordNodeRoutingMetric } from '../services/telemetry';
import type { ApiApp } from './types';

export function registerWorkspaceProxy(app: ApiApp): void {
  // Proxy requests for workspace subdomains (ws-{id}.*) to the VM agent.
  // The wildcard DNS *.{domain} routes through this Worker, so we must proxy
  // workspace requests to the actual VM running the agent on the configured port.
  // vm-{id} DNS records are orange-clouded; CF edge terminates TLS and re-encrypts
  // to the VM agent's Origin CA cert. This handles both HTTP and WebSocket requests.
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const hostname = url.hostname;
    const baseDomain = c.env?.BASE_DOMAIN || '';

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

    let userId: string | null = null;
    let portAccessRedirect: Response | null = null;
    let publicPortAccess = false;

    if (targetPort !== null) {
      const cookieHeader = c.req.raw.headers.get('cookie') || '';
      const cookieMatch = cookieHeader.match(/(?:^|;\s*)sam_port_access=([^\s;]+)/);
      if (cookieMatch?.[1]) {
        try {
          const payload = await verifyPortAccessToken(cookieMatch[1], c.env);
          if (payload.workspace === workspaceId && payload.port === targetPort) {
            userId = payload.subject;
          }
        } catch {
          // Cookie expired or invalid — fall through to token check.
        }
      }

      if (!userId) {
        const portToken = url.searchParams.get('port_token');
        if (portToken) {
          try {
            const payload = await verifyPortAccessToken(portToken, c.env);
            if (payload.workspace === workspaceId && payload.port === targetPort) {
              const cookieMaxAge = c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS
                ? parseInt(c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS, 10) : 14400;
              const redirectUrl = new URL(url.toString());
              redirectUrl.searchParams.delete('port_token');
              portAccessRedirect = new Response(null, {
                status: 302,
                headers: {
                  Location: redirectUrl.toString(),
                  'Set-Cookie': `sam_port_access=${portToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cookieMaxAge}`,
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'no-referrer',
                },
              });
              userId = payload.subject;
            }
          } catch (err) {
            log.warn('ws_proxy_port_token_rejected', { workspaceId, targetPort, ...serializeError(err) });
          }
        }
      }

      if (!userId) {
        const db = drizzle(c.env.DATABASE, { schema });
        const publicWorkspace = await db
          .select({
            userId: schema.workspaces.userId,
            portsPublicEnabled: schema.workspaces.portsPublicEnabled,
          })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId))
          .get();

        if (publicWorkspace?.portsPublicEnabled) {
          userId = publicWorkspace.userId;
          publicPortAccess = true;
        }
      }

      if (!userId) {
        return new Response(
          `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Session expired</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333}
h1{font-size:1.4rem}code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:0.9em}</style>
</head><body>
<h1>Session expired</h1>
<p>Your access to this port has expired or is invalid.</p>
<p>Ask the agent to run <code>expose_port</code> again for a fresh link.</p>
</body></html>`,
          { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
        );
      }
    }

    if (!userId) {
      const auth = createAuth(c.env);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      userId = session?.user.id ?? null;
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
        userId = payload.subject;
      } catch (err) {
        log.warn('ws_proxy_terminal_token_rejected', {
          workspaceId,
          ...serializeError(err),
        });
        return c.json({ error: 'UNAUTHORIZED', message: 'Invalid workspace token' }, 401);
      }
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const workspace = await db
      .select({
        nodeId: schema.workspaces.nodeId,
        status: schema.workspaces.status,
      })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
      .get();

    if (!workspace) {
      return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
    }

    if (workspace.status !== 'running' && workspace.status !== 'recovery') {
      if (workspace.status === 'creating' && url.pathname === '/boot-log/ws') {
        // Allow boot-log WebSocket during creation for real-time streaming.
      } else {
        return c.json({ error: 'NOT_READY', message: `Workspace is ${workspace.status}` }, 503);
      }
    }

    if (portAccessRedirect) {
      return portAccessRedirect;
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
    recordNodeRoutingMetric({
      metric: 'ws_proxy_route',
      nodeId: workspace.nodeId || workspaceId,
      workspaceId,
    }, c.env);
    const vmAgentProtocol = c.env.VM_AGENT_PROTOCOL || 'https';
    const vmAgentPort = c.env.VM_AGENT_PORT || '8443';
    const vmUrl = new URL(c.req.url);
    vmUrl.protocol = `${vmAgentProtocol}:`;
    vmUrl.hostname = backendHostname;
    vmUrl.port = vmAgentPort;

    if (targetPort !== null) {
      const subPath = url.pathname === '/' ? '' : url.pathname;
      vmUrl.pathname = `/workspaces/${workspaceId}/ports/${targetPort}${subPath}`;
      vmUrl.searchParams.delete('port_token');

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

    const headers = new Headers(c.req.raw.headers);
    headers.delete('x-sam-node-id');
    headers.delete('x-sam-workspace-id');
    headers.delete('x-forwarded-host');
    headers.set('X-SAM-Node-Id', (workspace.nodeId || workspaceId));
    headers.set('X-SAM-Workspace-Id', workspaceId);
    headers.set('X-Forwarded-Host', hostname);
    headers.set('X-Forwarded-Proto', 'https');

    const response = await fetch(vmUrl.toString(), {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error — Cloudflare Workers support duplex for streaming request bodies.
      duplex: c.req.raw.body ? 'half' : undefined,
    });

    if (targetPort !== null) {
      const headers = new Headers(response.headers);
      headers.delete('set-cookie');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  });
}
