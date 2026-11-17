import { assertReverseTunnelUpstreamPort, reverseTunnelUpstreamOrigin } from './config';
import type { ReverseTunnelEnv as Env } from './env';

/**
 * Loopback origin of a reverse-tunnel node's agent: the ACTIVE lease of the node's CURRENT
 * incarnation. A released or superseded lease is never routed to, so a revoked node stops
 * receiving control-plane traffic on the next request, whatever frps still holds open. One
 * indexed read (`node_id` + incarnation unique key); only reverse-tunnel nodes reach it.
 */
export async function resolveReverseTunnelAgentOrigin(env: Env, nodeId: string): Promise<string> {
  const row = await env.DATABASE.prepare(
    `SELECT l.port AS port
       FROM node_reverse_tunnel_leases l
       JOIN nodes n ON n.id = l.node_id AND n.runtime_incarnation_id = l.runtime_incarnation_id
                    AND n.user_id = l.user_id
      WHERE l.node_id = ? AND l.status = 'active'`
  )
    .bind(nodeId)
    .first<{ port: unknown }>();
  const port = row ? Number(row.port) : Number.NaN;
  if (!Number.isInteger(port)) {
    throw new Error(
      `Node ${nodeId} has no active reverse-tunnel lease for its current incarnation`
    );
  }
  // Caddy and fetch() connect to exactly this loopback port: never outside the lease range.
  assertReverseTunnelUpstreamPort(env, port);
  return reverseTunnelUpstreamOrigin(port);
}
