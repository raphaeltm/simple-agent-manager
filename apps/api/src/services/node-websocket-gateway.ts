/**
 * Gateway decisions: how the Worker answers Caddy's forward_auth for node WebSockets on a
 * self-hosted box (routes/self-host-gateway.ts).
 *
 * celld cannot hand a WebSocket obtained from an outbound `fetch()` back to the browser, so on
 * the reverse-tunnel transport Caddy carries the socket. The Worker must still make every auth
 * decision. To guarantee it makes EXACTLY the decision it makes today, the gateway re-dispatches
 * the original request through the normal SAM app with an in-process marker; the existing
 * handlers (ws-* proxy, logs stream) run their unchanged authentication and authorization and,
 * at the point where they would `fetch` the node, return a decision naming the upstream and the
 * request headers they would have sent instead.
 *
 * The marker is a WeakMap entry keyed by the Request object, so no HTTP input can set it. The
 * decision response carries a per-request random nonce so the gateway can tell a decision from
 * any other 2xx the inner dispatch might produce (which it then refuses).
 */
import type { NodeAgentRoute } from './node-agent-route';
import { REVERSE_TUNNEL_UPSTREAM_HOST } from './node-reverse-tunnel-config';

/** Response headers Caddy copies into the upstream request (deploy/selfhost/caddy/sam.d/). */
export const GATEWAY_HEADER = {
  decision: 'X-SAM-Gateway-Decision',
  upstream: 'X-SAM-Upstream',
  upstreamUri: 'X-SAM-Upstream-Uri',
  upstreamAuthorization: 'X-SAM-Upstream-Authorization',
  upstreamCookie: 'X-SAM-Upstream-Cookie',
  nodeId: 'X-SAM-Node-Id',
  workspaceId: 'X-SAM-Workspace-Id',
} as const;

const gatewayRequestNonces = new WeakMap<Request, string>();

/** Mark an inner request as a gateway authorization request; returns its decision nonce. */
export function markGatewayAuthorizationRequest(request: Request): string {
  const nonce = crypto.randomUUID();
  gatewayRequestNonces.set(request, nonce);
  return nonce;
}

export function isGatewayAuthorizationRequest(request: Request): boolean {
  return gatewayRequestNonces.has(request);
}

/** The handler's upstream request, as it would have been sent to the node. */
export interface GatewayUpstreamRequest {
  /** Path and query on the node agent (e.g. `/terminal/ws?token=...`). */
  url: URL;
  headers: Headers;
}

function unsupported(message: string): Response {
  return Response.json(
    { error: 'GATEWAY_UNSUPPORTED_TRANSPORT', message },
    { status: 502, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Build the forward_auth decision for an authorized request. Only reverse-tunnel nodes can be
 * reached through the gateway (their upstream is a loopback lease port on this box); any other
 * route is refused rather than guessed, so a misrouted socket never reaches a public hostname.
 */
export function gatewayDecisionResponse(
  request: Request,
  route: NodeAgentRoute | null,
  upstream: GatewayUpstreamRequest
): Response {
  const nonce = gatewayRequestNonces.get(request);
  if (!nonce) throw new Error('gatewayDecisionResponse called for a non-gateway request');
  if (!route || route.kind !== 'reverse-tunnel') {
    return unsupported('Node is not reachable through the self-hosted WebSocket gateway');
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.set(GATEWAY_HEADER.decision, nonce);
  headers.set(GATEWAY_HEADER.upstream, `${REVERSE_TUNNEL_UPSTREAM_HOST}:${route.port}`);
  headers.set(GATEWAY_HEADER.upstreamUri, `${upstream.url.pathname}${upstream.url.search}`);
  // Always present (possibly empty): Caddy replaces the client's Authorization and Cookie
  // with exactly what the Worker would have forwarded, so a stripped credential stays stripped.
  headers.set(GATEWAY_HEADER.upstreamAuthorization, upstream.headers.get('authorization') ?? '');
  headers.set(GATEWAY_HEADER.upstreamCookie, upstream.headers.get('cookie') ?? '');
  headers.set(GATEWAY_HEADER.nodeId, upstream.headers.get('x-sam-node-id') ?? '');
  headers.set(GATEWAY_HEADER.workspaceId, upstream.headers.get('x-sam-workspace-id') ?? '');
  return new Response(null, { status: 200, headers });
}

/** The handler reached a runtime the gateway can never carry (an Instant container). */
export function gatewayUnsupportedRuntimeResponse(): Response {
  return unsupported('Instant workspaces are not reachable through the self-hosted gateway');
}

/** True when `response` is the decision minted for `request` (and not some other 2xx). */
export function isGatewayDecisionFor(request: Request, response: Response): boolean {
  const nonce = gatewayRequestNonces.get(request);
  return !!nonce && response.headers.get(GATEWAY_HEADER.decision) === nonce;
}
