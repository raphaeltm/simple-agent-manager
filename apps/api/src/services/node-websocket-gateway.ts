/**
 * Gateway decisions for node WebSockets on the self-hosted box.
 *
 * celld cannot hand a WebSocket from an outbound `fetch()` back to the browser, so on the
 * reverse-tunnel transport the box's Caddy carries the socket and asks the API (forward_auth)
 * whether to. The self-host gateway route (`selfhost/reverse-tunnel/gateway.ts`) re-dispatches
 * the original request through the normal app with an in-process marker. The existing ws-*
 * proxy and logs-stream handlers then run their unchanged authentication and, where they would
 * `fetch` the node, return a decision naming the upstream and the headers they would have sent.
 *
 * The marker is a WeakMap entry keyed by the Request object, so no HTTP input can set it, and
 * the decision carries a per-request random nonce, so the gateway can tell it from any other
 * 2xx. Only the self-host gateway marks requests: on Cloudflare `isGatewayAuthorizationRequest`
 * is one WeakMap lookup that is always false.
 */
import type { NodeAgentRoute } from './node-agent-route';

/** Response headers the box's Caddy copies into the upstream request. */
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

/** True when `response` is the decision minted for `request` (and not some other 2xx). */
export function isGatewayDecisionFor(request: Request, response: Response): boolean {
  const nonce = gatewayRequestNonces.get(request);
  return !!nonce && response.headers.get(GATEWAY_HEADER.decision) === nonce;
}

function unsupported(message: string): Response {
  return Response.json(
    { error: 'GATEWAY_UNSUPPORTED_TRANSPORT', message },
    { status: 502, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * The forward_auth decision for an authorized request. Only a node on a build-extension route
 * (a loopback lease port on this box) can be carried by the gateway; any other route is
 * refused rather than guessed, so a misrouted socket never reaches a public hostname.
 */
export function gatewayDecisionResponse(
  request: Request,
  route: NodeAgentRoute,
  upstream: { url: URL; headers: Headers }
): Response {
  const nonce = gatewayRequestNonces.get(request);
  if (!nonce) throw new Error('gatewayDecisionResponse called for a non-gateway request');
  if (route.kind !== 'extension') {
    return unsupported('Node is not reachable through the self-hosted WebSocket gateway');
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.set(GATEWAY_HEADER.decision, nonce);
  headers.set(GATEWAY_HEADER.upstream, new URL(route.origin).host);
  headers.set(GATEWAY_HEADER.upstreamUri, `${upstream.url.pathname}${upstream.url.search}`);
  // Always present (possibly empty): Caddy replaces the client's Authorization and Cookie with
  // exactly what the Worker would have forwarded, so a stripped credential stays stripped.
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
