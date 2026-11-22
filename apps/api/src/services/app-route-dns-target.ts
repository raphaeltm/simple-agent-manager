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
import type { DeploymentRouteTarget } from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { upsertAppRouteDNSRecord } from './dns-app-routes';
import { nodeTransportExtension } from './node-transport-extension';

export interface AppRouteDnsNode {
  transport?: string | null;
  ipAddress: string | null;
}

/** Writes (or, when covered, skips) the A record of every route a release fetch returns. */
export async function upsertReleaseRouteRecords(
  routes: Pick<DeploymentRouteTarget, 'hostname'>[],
  node: AppRouteDnsNode,
  env: Env
): Promise<void> {
  if (routes.length === 0) return;
  // `?? null`: nodeTransportExtension(undefined) means "the installation's transport", which a
  // stored node never is; a node row without the column must take the public path.
  const extension = nodeTransportExtension(node.transport ?? null);
  const address = extension?.appRouteAddress ? extension.appRouteAddress(env) : undefined;
  if (address === null) return;
  const target = address ?? node.ipAddress;
  if (!target) {
    throw errors.conflict(
      'Deployment node does not have an IP address yet; retry after provisioning completes'
    );
  }
  await Promise.all(routes.map((route) => upsertAppRouteDNSRecord(route.hostname, target, env)));
}
