/**
 * Internal endpoints for the self-hosted box's gateway processes (deploy/selfhost/):
 *
 * - `POST /frps-plugin?op=Login|NewProxy|Ping|NewWorkConn` — frps server plugin. Authenticated with HTTP
 *   basic auth whose password is REVERSE_TUNNEL_GATEWAY_SECRET (frps sends the userinfo of
 *   its plugin `addr`). Decisions: services/node-reverse-tunnel-authz.ts.
 * - `GET /node-websocket` — Caddy forward_auth for node WebSocket upgrades. Authenticated with
 *   the `X-SAM-Gateway-Secret` header. It re-dispatches the original request through the SAM
 *   app so the EXISTING ws-* / logs-stream authentication runs unchanged
 *   (services/node-websocket-gateway.ts), and returns either that handler's refusal (401, 302
 *   port-token redirect, 403, 503, ...) for Caddy to send to the client, or a decision naming
 *   the loopback upstream and the headers Caddy must forward.
 *
 * - `POST /inbound-email` — the box's sam-mx SMTP receiver hands over one inbound agent email
 *   (routes/self-host-gateway-inbound-email.ts). Same secret header, plus its own on-switch.
 *
 * All are unreachable from the internet: frps and Caddy call celld directly on loopback, and
 * the box's Caddy answers 404 for this path prefix on its public listener. Both also fail
 * closed here: with no (or a too-short) REVERSE_TUNNEL_GATEWAY_SECRET they answer 404, which
 * is every Cloudflare deployment, and a wrong secret is 401. These routes do not use session
 * auth and are mounted before every session-auth router.
 */
import { type Context, Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readRequestJsonRecord, RequestBodyTooLargeError } from '../lib/runtime-validation';
import { parseWorkspaceSubdomain } from '../lib/workspace-subdomain';
import type { InboundDeps } from '../services/agent-email/inbound';
import { authorizeFrpsPluginRequest } from '../services/node-reverse-tunnel-authz';
import {
  getReverseTunnelGatewaySecret,
  isAcceptedGatewaySecret,
} from '../services/node-reverse-tunnel-config';
import {
  GATEWAY_HEADER,
  isGatewayDecisionFor,
  markGatewayAuthorizationRequest,
} from '../services/node-websocket-gateway';
import { handleInboundEmailGateway } from './self-host-gateway-inbound-email';

/** frps plugin bodies are a few hundred bytes; bound them well above that. */
export const FRPS_PLUGIN_MAX_BODY_BYTES = 16 * 1024;
export const GATEWAY_SECRET_HEADER = 'X-SAM-Gateway-Secret';
/** The WebSocket's original host, set by Caddy (client values are stripped before forward_auth). */
export const GATEWAY_ORIGINAL_HOST_HEADER = 'X-SAM-Gateway-Original-Host';

/** Basic-auth username frps sends (deploy/selfhost/frps/frps.toml); only the password matters. */
const FRPS_PLUGIN_BASIC_USER = 'frps';

/** Logs-stream WebSocket on the API host (routes/nodes/diagnostics.ts). */
const LOGS_STREAM_PATH_RE = /^\/api\/nodes\/[A-Za-z0-9_-]{1,64}\/logs\/stream$/;

/** Headers the gateway itself consumes; never forwarded into the re-dispatched request. */
const GATEWAY_INPUT_HEADERS = [
  'host',
  GATEWAY_SECRET_HEADER.toLowerCase(),
  GATEWAY_ORIGINAL_HOST_HEADER.toLowerCase(),
  'x-forwarded-host',
  'x-forwarded-uri',
  'x-forwarded-method',
  'x-forwarded-proto',
];

export type GatewayDispatch = (
  request: Request,
  env: Env,
  executionCtx: Context<{ Bindings: Env }>['executionCtx']
) => Response | Promise<Response>;

function notFound(): Response {
  return Response.json({ error: 'NOT_FOUND', message: 'Not found' }, { status: 404 });
}

function unauthorized(): Response {
  return Response.json(
    { error: 'UNAUTHORIZED', message: 'Gateway authentication failed' },
    { status: 401 }
  );
}

function basicAuthPassword(header: string | undefined): string | null {
  if (!header?.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length).trim());
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== FRPS_PLUGIN_BASIC_USER) return null;
  return decoded.slice(separator + 1);
}

function frpsReply(decision: { allow: true } | { allow: false; reason: string }): Response {
  return Response.json(
    decision.allow
      ? { reject: false, unchange: true }
      : { reject: true, reject_reason: decision.reason }
  );
}

/** Which original requests the gateway may authorize: node WebSocket upgrades only. */
function isGatewayTarget(env: Env, host: string, path: string): boolean {
  const baseDomain = env.BASE_DOMAIN || '';
  if (!baseDomain) return false;
  const workspace = parseWorkspaceSubdomain(host, baseDomain);
  if (workspace && !('error' in workspace)) return true;
  return host === `api.${baseDomain}` && LOGS_STREAM_PATH_RE.test(path);
}

/**
 * The original request Caddy is asking about, or null when it is not a node WebSocket upgrade
 * the gateway may authorize (any other target is refused rather than re-dispatched).
 */
function forwardedGatewayTarget(env: Env, headers: Headers): URL | null {
  // Not X-Forwarded-Host: celld rebuilds request.url from that header, so Caddy sets it to the
  // API host (keeping this request on this route) and sends the socket's host separately.
  const host = (headers.get(GATEWAY_ORIGINAL_HOST_HEADER) ?? '').toLowerCase().replace(/:\d+$/, '');
  const uri = headers.get('X-Forwarded-Uri') ?? '';
  const method = (headers.get('X-Forwarded-Method') ?? '').toUpperCase();
  const upgrade = (headers.get('Upgrade') ?? '').toLowerCase();
  let original: URL | null = null;
  try {
    original = host && uri.startsWith('/') ? new URL(`https://${host}${uri}`) : null;
  } catch {
    original = null;
  }
  // The target check reads the URL that is re-dispatched (original.hostname), and the host
  // must survive URL parsing unchanged: WHATWG parsing drops tabs/newlines, applies IDNA and
  // reads userinfo, so a header whose parsed host differs from its text is refused outright
  // rather than authorized as whichever workspace the parser happened to produce.
  const allowed =
    !!original &&
    original.hostname === host &&
    method === 'GET' &&
    upgrade === 'websocket' &&
    isGatewayTarget(env, original.hostname, original.pathname);
  if (!allowed) {
    log.warn('self_host_gateway.forward_auth_not_a_gateway_route', {
      host,
      method,
      upgrade: upgrade || null,
      action: 'rejected',
    });
    return null;
  }
  return original;
}

/** Map the re-dispatched handler's answer onto what Caddy's forward_auth understands. */
function toForwardAuthResponse(inner: Request, response: Response, host: string): Response {
  if (isGatewayDecisionFor(inner, response)) {
    const decision = new Headers(response.headers);
    decision.delete(GATEWAY_HEADER.decision);
    return new Response(null, { status: 200, headers: decision });
  }
  if ((response.status >= 200 && response.status < 300) || response.status === 101) {
    // Authorized-looking but no decision: never let Caddy proxy without an upstream.
    log.error('self_host_gateway.forward_auth_missing_decision', {
      host,
      status: response.status,
      action: 'rejected',
    });
    return Response.json(
      { error: 'GATEWAY_NO_DECISION', message: 'Gateway could not route this request' },
      { status: 502 }
    );
  }
  // The handler's own refusal (401, 302 port-token redirect, 403, 404, 503 ...) goes to the
  // client unchanged; strip anything that looks like a decision header defensively.
  const refusal = new Headers(response.headers);
  for (const name of Object.values(GATEWAY_HEADER)) refusal.delete(name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: refusal,
  });
}

export function createSelfHostGatewayRoutes(
  dispatch: GatewayDispatch,
  options: { inboundEmailDeps?: InboundDeps } = {}
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/inbound-email', (c) => handleInboundEmailGateway(c, options.inboundEmailDeps));

  routes.post('/frps-plugin', async (c) => {
    const secret = getReverseTunnelGatewaySecret(c.env);
    if (!secret) return notFound();
    const presented = basicAuthPassword(c.req.header('Authorization'));
    if (presented === null || !isAcceptedGatewaySecret(c.env, presented)) {
      log.warn('self_host_gateway.frps_plugin_unauthenticated', { action: 'rejected' });
      return unauthorized();
    }
    let body: unknown;
    try {
      body = await readRequestJsonRecord(c.req.raw, 'frps-plugin', FRPS_PLUGIN_MAX_BODY_BYTES);
    } catch (err) {
      // frps needs a 200 JSON verdict to report the refusal to frpc.
      return frpsReply({
        allow: false,
        reason: err instanceof RequestBodyTooLargeError ? 'request too large' : 'malformed request',
      });
    }
    return frpsReply(await authorizeFrpsPluginRequest(c.env, c.req.query('op'), body));
  });

  routes.get('/node-websocket', async (c) => {
    const secret = getReverseTunnelGatewaySecret(c.env);
    if (!secret) return notFound();
    if (!isAcceptedGatewaySecret(c.env, c.req.header(GATEWAY_SECRET_HEADER) ?? '')) {
      log.warn('self_host_gateway.forward_auth_unauthenticated', { action: 'rejected' });
      return unauthorized();
    }
    const original = forwardedGatewayTarget(c.env, c.req.raw.headers);
    if (!original) {
      return Response.json(
        { error: 'FORBIDDEN', message: 'Not a gateway WebSocket route' },
        { status: 403 }
      );
    }
    const headers = new Headers(c.req.raw.headers);
    for (const name of GATEWAY_INPUT_HEADERS) headers.delete(name);
    const inner = new Request(original.toString(), { method: 'GET', headers });
    markGatewayAuthorizationRequest(inner);
    const response = await dispatch(inner, c.env, c.executionCtx);
    return toForwardAuthResponse(inner, response, original.hostname);
  });

  return routes;
}
