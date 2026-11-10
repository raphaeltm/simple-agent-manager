/**
 * The one place that decides HOW the control plane reaches a node's vm-agent.
 *
 * - `cf-container` runtime: the VmAgentContainer Durable Object (handled by the caller).
 * - `reverse-tunnel` transport: `http://127.0.0.1:{leasePort}` on the control-plane box, via the
 *   node's frpc. No per-node DNS record exists for these nodes, so there is NO fallback to the
 *   public `{nodeId}.vm.{BASE_DOMAIN}` hostname: a missing lease fails closed.
 * - anything else (`vm-public-dns`, `cloudflare-tunnel`, legacy NULL): the public backend
 *   hostname from {@link getNodeBackendBaseUrl}, unchanged.
 *
 * Transport is read from the node row, never from the request, and the lease must belong to the
 * node's CURRENT incarnation, so a released or superseded lease can never be routed to.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getNodeBackendBaseUrl, type NodeBackendBaseUrlEnv } from './node-agent-readiness';
import { reverseTunnelUpstreamOrigin } from './node-reverse-tunnel-config';

export type NodeAgentRoute =
  | { kind: 'container'; runtime: 'cf-container' }
  | { kind: 'reverse-tunnel'; port: number; origin: string }
  | { kind: 'public'; origin: string };

export class NodeAgentRouteError extends Error {
  override name = 'NodeAgentRouteError';
  constructor(
    readonly nodeId: string,
    message: string
  ) {
    super(message);
  }
}

export interface NodeAgentRouteRow {
  runtime: string | null;
  transport: string | null;
  leasePort: number | null;
}

/** One D1 read: runtime, transport and the current incarnation's active lease port. */
export async function readNodeAgentRouteRow(
  env: Pick<Env, 'DATABASE'>,
  nodeId: string
): Promise<NodeAgentRouteRow | null> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      runtime: schema.nodes.runtime,
      transport: schema.nodes.transport,
      leasePort: schema.nodeReverseTunnelLeases.port,
    })
    .from(schema.nodes)
    .leftJoin(
      schema.nodeReverseTunnelLeases,
      and(
        eq(schema.nodeReverseTunnelLeases.nodeId, schema.nodes.id),
        eq(schema.nodeReverseTunnelLeases.runtimeIncarnationId, schema.nodes.runtimeIncarnationId),
        eq(schema.nodeReverseTunnelLeases.status, 'active')
      )
    )
    .where(eq(schema.nodes.id, nodeId))
    .get();
  return row ?? null;
}

/** Resolve a route from an already-loaded row (lets callers fold this into their own query). */
export function nodeAgentRouteFromRow(
  nodeId: string,
  row: NodeAgentRouteRow | null,
  env: NodeBackendBaseUrlEnv
): NodeAgentRoute {
  if (row?.runtime === 'cf-container') return { kind: 'container', runtime: 'cf-container' };
  if (row?.transport === 'reverse-tunnel') {
    if (!row.leasePort) {
      throw new NodeAgentRouteError(
        nodeId,
        `Node ${nodeId} uses the reverse-tunnel transport but has no active lease for its current incarnation`
      );
    }
    return {
      kind: 'reverse-tunnel',
      port: row.leasePort,
      origin: reverseTunnelUpstreamOrigin(row.leasePort),
    };
  }
  return { kind: 'public', origin: getNodeBackendBaseUrl(nodeId, env) };
}

export async function resolveNodeAgentRoute(
  env: Pick<Env, 'DATABASE'> & NodeBackendBaseUrlEnv,
  nodeId: string
): Promise<NodeAgentRoute> {
  return nodeAgentRouteFromRow(nodeId, await readNodeAgentRouteRow(env, nodeId), env);
}

/**
 * Re-target a URL that was built against {@link getNodeBackendBaseUrl} to the node's real
 * route, keeping path and query. Public routes are returned unchanged.
 */
export function retargetNodeAgentUrl(url: string, route: NodeAgentRoute): string {
  if (route.kind !== 'reverse-tunnel') return url;
  const original = new URL(url);
  const target = new URL(route.origin);
  target.pathname = original.pathname;
  target.search = original.search;
  return target.toString();
}
