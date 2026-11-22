/**
 * Where a deployment node's app-route hostnames point in DNS.
 *
 * Public transport (Cloudflare, and any node without an installed transport extension): every
 * route's grey-cloud A record points at the node, which terminates TLS itself. Unchanged.
 *
 * An installed extension may carry app ingress for its nodes instead (the self-host box's reverse
 * tunnel: box Caddy -> tunnel -> node, `selfhost/reverse-tunnel/app-route.ts`). Its
 * `appRouteAddress` then names the address the records point at (the box), or null when the
 * installation's own wildcard record already covers the names and nothing must be written.
 */
import {
  collectEnvironmentRouteHostnames,
  type DeploymentRouteTarget,
  type DeploymentRouteTargetOptions,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { upsertAppRouteDNSRecord } from './dns-app-routes';
import { nodeStatusTerminatesCallbacks } from './node-callback-auth';
import { nodeTransportExtension } from './node-transport-extension';

export interface AppRouteDnsNode {
  transport?: string | null;
  ipAddress: string | null;
}

/**
 * The address a node's app-route records point at: `covered` when the installation's wildcard
 * record already serves them (no records are written), else the transport's ingress address or
 * the node's own IP (null while the node has none yet). The single answer shared by the release
 * fetch that writes the records and the cleanup that judges them
 * (`services/app-route-dns-reconciliation.ts`).
 */
export function appRouteRecordAddress(
  node: AppRouteDnsNode,
  env: Env
): { covered: true } | { covered: false; address: string | null } {
  // `?? null`: nodeTransportExtension(undefined) means "the installation's transport", which a
  // stored node never is; a node row without the column must take the public path.
  const extension = nodeTransportExtension(node.transport ?? null);
  const address = extension?.appRouteAddress ? extension.appRouteAddress(env) : undefined;
  if (address === null) return { covered: true };
  return { covered: false, address: address ?? node.ipAddress };
}

async function assertNodeStillServesRoutes(env: Env, nodeId: string): Promise<void> {
  const row = await env.DATABASE.prepare(
    'SELECT status, runtime_termination_confirmed_at FROM nodes WHERE id = ?'
  )
    .bind(nodeId)
    .first<{ status: string; runtime_termination_confirmed_at: string | null }>();
  if (!row || nodeStatusTerminatesCallbacks(row.status) || row.runtime_termination_confirmed_at) {
    throw errors.gone(`Node ${nodeId} is being released; its route records are not written`);
  }
}

/**
 * Writes (or, when covered, skips) the A record of every route a release fetch returns. With
 * `nodeId`, refuses (410) once that node's teardown has started.
 */
export async function upsertReleaseRouteRecords(
  routes: Pick<DeploymentRouteTarget, 'hostname'>[],
  node: AppRouteDnsNode,
  env: Env,
  nodeId?: string
): Promise<void> {
  if (routes.length === 0) return;
  const resolved = appRouteRecordAddress(node, env);
  if (resolved.covered) return;
  const target = resolved.address;
  if (!target) {
    throw errors.conflict(
      'Deployment node does not have an IP address yet; retry after provisioning completes'
    );
  }
  // Fence: the fetch checked the node on entry, but its teardown may have started since. Its
  // release cleanup lists records before and after the provider deletion, so a write landing
  // after both would point at an IP the provider has freed. Re-read just before writing.
  if (nodeId) await assertNodeStillServesRoutes(env, nodeId);
  await Promise.all(routes.map((route) => upsertAppRouteDNSRecord(route.hostname, target, env)));
}

/**
 * Route hostnames whose records a release fetch must keep although the new release drops them.
 *
 * On a transport that carries app ingress itself (the box), the box keeps serving the latest
 * applied release while the new one applies, and after a failed apply
 * (`selfhost/reverse-tunnel/app-route.ts` authorizes both), so that release's records stay until
 * a later fetch no longer finds it applied. Every other node keeps today's cleanup: nothing is
 * held. A held record that outlives its route resolves to the box, whose decision answers 404,
 * and environment teardown deletes every route record the environment ever had.
 */
export function routeHostnamesHeldDuringApply(
  node: AppRouteDnsNode,
  priorReleases: Array<{ manifest: string; status: string; version: number }>,
  opts: DeploymentRouteTargetOptions
): string[] {
  if (!nodeTransportExtension(node.transport ?? null)?.appRouteAddress) return [];
  let applied: { manifest: string; version: number } | null = null;
  for (const release of priorReleases) {
    if (release.status === 'applied' && (!applied || release.version > applied.version)) {
      applied = release;
    }
  }
  return applied ? collectEnvironmentRouteHostnames([applied.manifest], opts) : [];
}
