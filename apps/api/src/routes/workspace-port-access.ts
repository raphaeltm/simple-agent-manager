/**
 * Port-access authentication for workspace port hosts (`ws-{id}--{port}.*`): the
 * `sam_port_access` cookie, the `?port_token=` handshake (exchanged for that cookie with a 302),
 * and the workspace's public-ports setting. Extracted verbatim from the ws-* proxy (rule 18);
 * the 302 is returned to the caller, which sends it only after its ownership check passes.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { verifyPortAccessToken } from '../services/jwt';

export interface PortAccessResult {
  userId: string | null;
  portAccessRedirect: Response | null;
  publicPortAccess: boolean;
}

/** Resolve port access, or return the HTML "Session expired" response when none applies. */
export async function resolveWorkspacePortAccess(
  c: Context<{ Bindings: Env }>,
  url: URL,
  workspaceId: string,
  targetPort: number
): Promise<PortAccessResult | Response> {
  let userId: string | null = null;
  let portAccessRedirect: Response | null = null;
  let publicPortAccess = false;
  // 5a: Check sam_port_access cookie (subsequent requests)
  const cookieHeader = c.req.raw.headers.get('cookie') || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)sam_port_access=([^\s;]+)/);
  if (cookieMatch?.[1]) {
    try {
      const payload = await verifyPortAccessToken(cookieMatch[1], c.env);
      if (payload.workspace === workspaceId && payload.port === targetPort) {
        userId = payload.subject;
      }
    } catch {
      // Cookie expired or invalid — fall through to token check
    }
  }

  // 5b: Check ?port_token= query param (initial request from expose_port URL)
  if (!userId) {
    const portToken = url.searchParams.get('port_token');
    if (portToken) {
      try {
        const payload = await verifyPortAccessToken(portToken, c.env);
        if (payload.workspace === workspaceId && payload.port === targetPort) {
          // Set cookie and 302 redirect to strip token from URL
          const cookieMaxAge = c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS
            ? parseInt(c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS, 10)
            : 14400;
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
        log.warn('ws_proxy_port_token_rejected', {
          workspaceId,
          targetPort,
          ...serializeError(err),
        });
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

  // 5f: HTML error page for expired/invalid port access
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
      {
        status: 401,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      }
    );
  }

  // Return the 302 redirect after we confirm the DB lookup passes below
  // (moved after DB check to ensure ownership is validated first)

  return { userId, portAccessRedirect, publicPortAccess };
}
