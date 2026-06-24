import { and, desc, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  buildReleaseRouteTargets,
  type DeploymentRouteTarget,
  type DeploymentRouteTargetOptions,
} from './deployment-routing';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Route-target derivation options sourced from the worker env for an environment. */
export function routeTargetOptions(
  workerEnv: Env,
  environmentId: string
): DeploymentRouteTargetOptions {
  return {
    environmentId,
    baseDomain: workerEnv.BASE_DOMAIN,
    routePortBase: workerEnv.DEPLOYMENT_ROUTE_PORT_BASE,
    routePortSpan: workerEnv.DEPLOYMENT_ROUTE_PORT_SPAN,
  };
}

/**
 * Derive the public route targets for an environment from its latest release.
 *
 * Custom domains attach to an existing SAM-owned public route; this returns the
 * authoritative set of those routes (hostname, service, containerPort, hostPort)
 * so attach/verify can validate that a requested (service, port) maps to a real
 * public route and recompute the SAM-owned CNAME target the user must point at.
 *
 * Returns an empty array when the environment has no release yet (no public
 * routes exist to attach to).
 */
export async function getEnvironmentPublicRouteTargets(
  db: Db,
  workerEnv: Env,
  environmentId: string
): Promise<DeploymentRouteTarget[]> {
  const [latestRelease] = await db
    .select({ manifest: schema.deploymentReleases.manifest })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, environmentId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  if (!latestRelease) {
    return [];
  }

  return buildReleaseRouteTargets(latestRelease.manifest, routeTargetOptions(workerEnv, environmentId));
}

/**
 * Build additional signed RouteTargets for an environment's VERIFIED custom
 * domains, reusing each parent public route's loopback hostPort.
 *
 * A custom domain is matched to its parent route by (service, containerPort).
 * When the parent route no longer exists in the current release (e.g. the user
 * removed the service), the custom domain is skipped — there is nothing to
 * reverse-proxy it to. The returned targets carry the user's custom hostname so
 * node-local Caddy renders a site block (ACME HTTP-01 + reverse_proxy to the
 * parent hostPort) for it. These ride inside the signed ApplyPayload's `routes`
 * (covered by routesHash) but are EXCLUDED from grey-cloud DNS upsert — the user
 * owns the custom hostname's DNS record.
 */
export async function buildVerifiedCustomRouteTargets(
  db: Db,
  environmentId: string,
  routes: DeploymentRouteTarget[]
): Promise<DeploymentRouteTarget[]> {
  const verified = await db
    .select({
      hostname: schema.deploymentCustomDomains.hostname,
      service: schema.deploymentCustomDomains.service,
      port: schema.deploymentCustomDomains.port,
    })
    .from(schema.deploymentCustomDomains)
    .where(
      and(
        eq(schema.deploymentCustomDomains.environmentId, environmentId),
        eq(schema.deploymentCustomDomains.verificationStatus, 'verified')
      )
    );

  const customTargets: DeploymentRouteTarget[] = [];
  for (const domain of verified) {
    const parent = routes.find(
      (route) => route.service === domain.service && route.containerPort === domain.port
    );
    if (!parent) {
      continue;
    }
    customTargets.push({
      hostname: domain.hostname.toLowerCase(),
      service: parent.service,
      containerPort: parent.containerPort,
      hostPort: parent.hostPort,
    });
  }
  return customTargets;
}
