import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import {
  buildReleaseRouteTargets,
  type DeploymentRouteTarget,
  type DeploymentRouteTargetOptions,
} from './deployment-routing';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type CustomDomainDesiredState = 'active' | 'deactivating' | 'deleted';
export type CustomDomainRoutingStatus =
  | 'pending_dns'
  | 'failed'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'deactivated'
  | 'route_missing'
  | 'dns_recheck_required'
  | 'inactive_environment_stopped';

export interface CustomDomainLifecycleEventInput {
  projectId: string;
  environmentId: string;
  customDomainId?: string | null;
  hostname: string;
  nodeId?: string | null;
  nodeIdentifier?: string | null;
  routingRevision?: number | null;
  eventType: string;
  level?: 'info' | 'warn' | 'error';
  message: string;
  detail?: Record<string, unknown> | null;
}

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

  return buildReleaseRouteTargets(
    latestRelease.manifest,
    routeTargetOptions(workerEnv, environmentId)
  );
}

export function findRouteTargetForDomain(
  routes: DeploymentRouteTarget[],
  domain: Pick<schema.DeploymentCustomDomainRow, 'service' | 'port'>
): DeploymentRouteTarget | null {
  return (
    routes.find(
      (route) => route.service === domain.service && route.containerPort === domain.port
    ) ?? null
  );
}

export function customDomainExpectedTargetChanged(
  domain: Pick<schema.DeploymentCustomDomainRow, 'verifiedCnameTarget'>,
  parent: DeploymentRouteTarget | null
): boolean {
  return !!domain.verifiedCnameTarget && !!parent && domain.verifiedCnameTarget !== parent.hostname;
}

/**
 * Build additional signed RouteTargets for an environment's active, verified
 * custom domains, reusing each parent public route's loopback hostPort.
 *
 * A custom domain is matched to its parent route by (service, containerPort).
 * It is included only when it is desired active, not deleted/deactivating, DNS
 * was verified against the same current SAM CNAME target, and the parent route
 * still exists. Target mismatch is intentionally excluded so route reordering or
 * hostname changes cannot silently keep serving a domain under stale DNS.
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
      verifiedCnameTarget: schema.deploymentCustomDomains.verifiedCnameTarget,
    })
    .from(schema.deploymentCustomDomains)
    .where(
      and(
        eq(schema.deploymentCustomDomains.environmentId, environmentId),
        eq(schema.deploymentCustomDomains.verificationStatus, 'verified'),
        eq(schema.deploymentCustomDomains.desiredState, 'active'),
        isNull(schema.deploymentCustomDomains.deletedAt)
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
    if (!domain.verifiedCnameTarget || domain.verifiedCnameTarget !== parent.hostname) {
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

export async function recordCustomDomainEvent(
  db: Db,
  input: CustomDomainLifecycleEventInput
): Promise<void> {
  await db.insert(schema.deploymentCustomDomainEvents).values({
    id: ulid(),
    projectId: input.projectId,
    environmentId: input.environmentId,
    customDomainId: input.customDomainId ?? null,
    hostname: input.hostname,
    nodeId: input.nodeId ?? null,
    nodeIdentifier: input.nodeIdentifier ?? input.nodeId ?? null,
    routingRevision: input.routingRevision ?? null,
    eventType: input.eventType,
    level: input.level ?? 'info',
    message: input.message,
    detailJson: input.detail ? JSON.stringify(input.detail) : null,
  });
}

export async function requestRoutingRevision(db: Db, environmentId: string): Promise<number> {
  await db
    .update(schema.deploymentEnvironments)
    .set({
      desiredRoutingRevision: sql`${schema.deploymentEnvironments.desiredRoutingRevision} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.deploymentEnvironments.id, environmentId));

  const [environment] = await db
    .select({ desiredRoutingRevision: schema.deploymentEnvironments.desiredRoutingRevision })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, environmentId))
    .limit(1);
  return environment?.desiredRoutingRevision ?? 0;
}

export async function reconcileCustomDomainRoutingObservation(
  db: Db,
  environmentId: string,
  observedRevision: number,
  observedStatus: string | null | undefined,
  now: string
): Promise<void> {
  if (!Number.isFinite(observedRevision) || observedRevision <= 0) {
    return;
  }

  if (observedStatus === 'failed') {
    return;
  }

  await db
    .update(schema.deploymentCustomDomains)
    .set({ routingStatus: 'active' })
    .where(
      and(
        eq(schema.deploymentCustomDomains.environmentId, environmentId),
        eq(schema.deploymentCustomDomains.desiredState, 'active'),
        eq(schema.deploymentCustomDomains.verificationStatus, 'verified'),
        lte(schema.deploymentCustomDomains.activationRoutingRevision, observedRevision),
        isNull(schema.deploymentCustomDomains.deletedAt)
      )
    );

  await db
    .update(schema.deploymentCustomDomains)
    .set({
      desiredState: 'deleted',
      routingStatus: 'deactivated',
      deletedAt: now,
    })
    .where(
      and(
        eq(schema.deploymentCustomDomains.environmentId, environmentId),
        eq(schema.deploymentCustomDomains.desiredState, 'deactivating'),
        lte(schema.deploymentCustomDomains.deactivationRoutingRevision, observedRevision),
        isNull(schema.deploymentCustomDomains.deletedAt)
      )
    );
}
