/**
 * How the control plane reaches a node's vm-agent, decided from the node row alone.
 *
 * - `cf-container` runtime: the VmAgentContainer Durable Object (the caller handles it).
 * - A transport owned by an installed build extension (`node-transport-extension.ts`): the
 *   origin that extension resolves. The self-host build's reverse tunnel resolves a loopback
 *   lease port of the node's CURRENT incarnation; a released or superseded lease is never
 *   routed to, so revocation takes effect for control-plane traffic on the next request.
 * - Any other transport (`vm-public-dns`, `cloudflare-tunnel`, legacy NULL): the public backend
 *   hostname, exactly as before.
 *
 * A row naming an extension transport that this build did not install fails closed: such a
 * node has no DNS record, so the public hostname would be wrong. The Cloudflare Worker installs
 * no extension and never stores one, so on Cloudflare this module only adds the `transport`
 * column to the node read its callers already made (zero added I/O).
 */
import type { Env } from '../env';
import { AppError } from '../middleware/error';
import { getNodeBackendBaseUrl } from './node-agent-readiness';
import { nodeTransportExtension } from './node-transport-extension';

export type NodeAgentRoute =
  | { kind: 'container' }
  | { kind: 'extension'; origin: string }
  | { kind: 'public'; origin: string };

export interface NodeAgentRouteRow {
  runtime: string | null;
  transport: string | null;
}

/** Transports a build extension owns; they have no public backend hostname. */
const EXTENSION_ONLY_TRANSPORTS: ReadonlySet<string> = new Set(['reverse-tunnel']);

/** A designed 503 (`app.onError` maps it): an unroutable node is unreachable, not a server fault. */
export class NodeAgentRouteError extends AppError {
  override name = 'NodeAgentRouteError';
  constructor(
    readonly nodeId: string,
    message: string
  ) {
    super(503, 'NODE_UNREACHABLE', message);
  }
}

export async function resolveNodeAgentRoute(
  env: Env,
  nodeId: string,
  row: NodeAgentRouteRow | null | undefined
): Promise<NodeAgentRoute> {
  if (row?.runtime === 'cf-container') return { kind: 'container' };
  const transport = row?.transport ?? null;
  const extension = transport ? nodeTransportExtension(transport) : undefined;
  if (extension) {
    try {
      return { kind: 'extension', origin: await extension.resolveAgentOrigin(env, nodeId) };
    } catch (err) {
      throw new NodeAgentRouteError(nodeId, err instanceof Error ? err.message : String(err));
    }
  }
  if (transport && EXTENSION_ONLY_TRANSPORTS.has(transport)) {
    throw new NodeAgentRouteError(
      nodeId,
      `Node ${nodeId} uses the ${transport} transport, which this build cannot route`
    );
  }
  return { kind: 'public', origin: getNodeBackendBaseUrl(nodeId, env) };
}

/** Keep path and query of a URL built against the public hostname; swap its origin. */
export function retargetNodeAgentUrl(url: string, route: NodeAgentRoute): string {
  if (route.kind !== 'extension') return url;
  const original = new URL(url);
  const target = new URL(route.origin);
  target.pathname = original.pathname;
  target.search = original.search;
  return target.toString();
}
