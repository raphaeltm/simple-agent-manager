/**
 * Custom domain routes for deployment public routes.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/custom-domains.
 * Auth: session cookie + active project membership/capabilities (browser CRUD
 * — NOT a VM-agent callback, so standard session auth applies).
 *
 * A user attaches their own subdomain (CNAME) to an existing public route of a
 * deployment environment. SAM does NOT create the DNS record — the user points
 * a CNAME at the SAM-owned route hostname. Verification updates desired routing
 * configuration; the deployment node observes that desired revision through the
 * heartbeat route-config flow and applies Caddy without requiring an app release.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import {
  customDomainExpectedTargetChanged,
  findRouteTargetForDomain,
  getEnvironmentPublicRouteTargets,
  recordCustomDomainEvent,
  requestRoutingRevision,
} from '../services/deployment-custom-domains';
import { verifyCustomDomainTarget } from '../services/deployment-domain-verify';
import type { DeploymentRouteTarget } from '../services/deployment-routing';

// =============================================================================
// Validation
// =============================================================================

/**
 * Custom hostname: a fully-qualified subdomain (at least three labels, e.g.
 * app.theircompany.com). Rejects wildcards (no `*`), apex/root domains (fewer
 * than three labels), and malformed names. v1 is subdomains-only.
 */
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?:${HOSTNAME_LABEL}\\.){2,}[a-z]{2,63}$`);

const AttachCustomDomainSchema = v.object({
  service: v.pipe(v.string('service is required'), v.minLength(1, 'service is required')),
  port: v.pipe(
    v.number('port is required'),
    v.integer('port must be an integer'),
    v.minValue(1, 'port must be between 1 and 65535'),
    v.maxValue(65_535, 'port must be between 1 and 65535')
  ),
  hostname: v.pipe(
    v.string('hostname is required'),
    v.transform((value) => value.trim().toLowerCase()),
    v.regex(
      HOSTNAME_RE,
      'hostname must be a subdomain (e.g. app.example.com) — no wildcards or apex domains'
    )
  ),
});

// =============================================================================
// Helpers
// =============================================================================

type DeploymentDb = ReturnType<typeof drizzle<typeof schema>>;

type EnvironmentContext = Pick<
  schema.DeploymentEnvironmentRow,
  | 'id'
  | 'projectId'
  | 'nodeId'
  | 'status'
  | 'desiredRoutingRevision'
  | 'observedRoutingRevision'
  | 'observedRoutingStatus'
  | 'observedRoutingError'
>;

/** Throws notFound when the (projectId, envId) pair does not resolve to an environment. */
async function requireEnvironment(
  db: DeploymentDb,
  projectId: string,
  envId: string
): Promise<EnvironmentContext> {
  const [environment] = await db
    .select({
      id: schema.deploymentEnvironments.id,
      projectId: schema.deploymentEnvironments.projectId,
      nodeId: schema.deploymentEnvironments.nodeId,
      status: schema.deploymentEnvironments.status,
      desiredRoutingRevision: schema.deploymentEnvironments.desiredRoutingRevision,
      observedRoutingRevision: schema.deploymentEnvironments.observedRoutingRevision,
      observedRoutingStatus: schema.deploymentEnvironments.observedRoutingStatus,
      observedRoutingError: schema.deploymentEnvironments.observedRoutingError,
    })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId)
      )
    )
    .limit(1);

  if (!environment) {
    throw errors.notFound('Deployment environment');
  }
  return environment;
}

/** Find the public route target a custom domain attaches to, by (service, port). */
function findParentRoute(
  routes: DeploymentRouteTarget[],
  service: string,
  port: number
): { route: DeploymentRouteTarget; routeIndex: number } | null {
  const routeIndex = routes.findIndex((r) => r.service === service && r.containerPort === port);
  if (routeIndex < 0) {
    return null;
  }
  const route = routes[routeIndex];
  if (!route) {
    return null;
  }
  return { route, routeIndex };
}

/** Resolve the node IP backing an environment (used as a flattened A-record match). */
async function resolveNodeIp(db: DeploymentDb, nodeId: string | null): Promise<string | undefined> {
  if (!nodeId) {
    return undefined;
  }
  const [node] = await db
    .select({ ipAddress: schema.nodes.ipAddress })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  return node?.ipAddress ?? undefined;
}

function environmentCanServeRoutes(environment: EnvironmentContext): boolean {
  return environment.status === 'active' || environment.status === 'starting';
}

function deriveServingStatus(
  row: schema.DeploymentCustomDomainRow,
  environment: EnvironmentContext,
  parent: DeploymentRouteTarget | null
): string {
  if (row.deletedAt || row.desiredState === 'deleted') {
    return 'removed';
  }
  if (row.desiredState === 'deactivating') {
    return 'deactivating';
  }
  if (row.verificationStatus === 'failed') {
    return 'dns_failed';
  }
  if (row.verificationStatus !== 'verified') {
    return 'pending_dns';
  }
  if (!parent) {
    return 'route_missing';
  }
  if (!row.verifiedCnameTarget || customDomainExpectedTargetChanged(row, parent)) {
    return 'dns_recheck_required';
  }
  if (!environmentCanServeRoutes(environment)) {
    return 'inactive_environment_stopped';
  }
  if (
    row.activationRoutingRevision &&
    environment.observedRoutingRevision < row.activationRoutingRevision
  ) {
    return 'activating';
  }
  if (row.routingStatus === 'active') {
    return 'active';
  }
  return row.routingStatus;
}

/** Serialize a custom-domain row plus DNS/routing/serving lifecycle context. */
function toCustomDomainResponse(
  row: schema.DeploymentCustomDomainRow,
  routes: DeploymentRouteTarget[],
  environment: EnvironmentContext
) {
  const parent = findRouteTargetForDomain(routes, row);
  const targetChanged = customDomainExpectedTargetChanged(row, parent);
  const servingStatus = deriveServingStatus(row, environment, parent);
  const routingStatus =
    servingStatus === 'inactive_environment_stopped' ? row.routingStatus : servingStatus;
  return {
    id: row.id,
    environmentId: row.environmentId,
    service: row.service,
    port: row.port,
    routeIndex: row.routeIndex,
    hostname: row.hostname,
    verificationStatus: row.verificationStatus,
    verificationError: row.verificationError,
    verifiedAt: row.verifiedAt,
    verifiedCnameTarget: row.verifiedCnameTarget,
    desiredState: row.desiredState,
    routingStatus,
    servingStatus,
    activationRoutingRevision: row.activationRoutingRevision,
    deactivationRoutingRevision: row.deactivationRoutingRevision,
    deletedAt: row.deletedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    cnameTarget: parent?.hostname ?? null,
    routeTargetChanged: targetChanged,
    environmentStatus: environment.status,
    desiredRoutingRevision: environment.desiredRoutingRevision,
    observedRoutingRevision: environment.observedRoutingRevision,
    observedRoutingStatus: environment.observedRoutingStatus,
    observedRoutingError: environment.observedRoutingError,
  };
}

// =============================================================================
// Routes
// =============================================================================

const deploymentCustomDomainRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments/:envId/custom-domains
 * Attach a custom hostname to an existing public route. Persists pending DNS.
 */
deploymentCustomDomainRoutes.post(
  '/:projectId/environments/:envId/custom-domains',
  requireAuth(),
  requireApproved(),
  jsonValidator(AttachCustomDomainSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'deployment:manage');
    const environment = await requireEnvironment(db, projectId, envId);

    const { service, port, hostname } = c.req.valid('json');

    const routes = await getEnvironmentPublicRouteTargets(db, c.env, envId);
    const parent = findParentRoute(routes, service, port);
    if (!parent) {
      throw errors.badRequest(
        `No public route found for service "${service}" on port ${port} in this environment's latest release`
      );
    }

    const existing = await db
      .select({ id: schema.deploymentCustomDomains.id })
      .from(schema.deploymentCustomDomains)
      .where(eq(schema.deploymentCustomDomains.hostname, hostname))
      .limit(1);
    if (existing.length > 0) {
      throw errors.conflict(`Custom domain "${hostname}" is already attached`);
    }

    const id = ulid();
    await db.insert(schema.deploymentCustomDomains).values({
      id,
      environmentId: envId,
      service,
      port,
      routeIndex: parent.routeIndex,
      hostname,
      verificationStatus: 'pending',
      desiredState: 'active',
      routingStatus: 'pending_dns',
      createdBy: userId,
    });

    await recordCustomDomainEvent(db, {
      projectId,
      environmentId: envId,
      customDomainId: id,
      hostname,
      nodeId: environment.nodeId,
      eventType: 'custom_domain.attached',
      message: 'custom domain attached and waiting for DNS verification',
      detail: { service, port, cnameTarget: parent.route.hostname },
    });

    const [created] = await db
      .select()
      .from(schema.deploymentCustomDomains)
      .where(eq(schema.deploymentCustomDomains.id, id))
      .limit(1);
    if (!created) {
      throw errors.internal('Custom domain was not persisted');
    }

    log.info('deployment_custom_domain.attached', {
      projectId,
      envId,
      domainId: id,
      hostname,
      service,
      port,
    });

    return c.json(toCustomDomainResponse(created, routes, environment), 201);
  }
);

/**
 * GET /api/projects/:projectId/environments/:envId/custom-domains
 * List non-deleted custom domains for an environment, each with lifecycle state.
 */
deploymentCustomDomainRoutes.get(
  '/:projectId/environments/:envId/custom-domains',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectAccess(db, projectId, userId);
    const environment = await requireEnvironment(db, projectId, envId);

    const [rows, routes] = await Promise.all([
      db
        .select()
        .from(schema.deploymentCustomDomains)
        .where(
          and(
            eq(schema.deploymentCustomDomains.environmentId, envId),
            isNull(schema.deploymentCustomDomains.deletedAt)
          )
        )
        .orderBy(schema.deploymentCustomDomains.createdAt),
      getEnvironmentPublicRouteTargets(db, c.env, envId),
    ]);

    return c.json({
      customDomains: rows.map((row) => toCustomDomainResponse(row, routes, environment)),
    });
  }
);

/**
 * POST /api/projects/:projectId/environments/:envId/custom-domains/:domainId/verify
 * Resolve the hostname via Cloudflare DoH and queue route-only reconciliation.
 */
deploymentCustomDomainRoutes.post(
  '/:projectId/environments/:envId/custom-domains/:domainId/verify',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const domainId = c.req.param('domainId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'deployment:manage');
    const environment = await requireEnvironment(db, projectId, envId);

    const [domain] = await db
      .select()
      .from(schema.deploymentCustomDomains)
      .where(
        and(
          eq(schema.deploymentCustomDomains.id, domainId),
          eq(schema.deploymentCustomDomains.environmentId, envId),
          isNull(schema.deploymentCustomDomains.deletedAt)
        )
      )
      .limit(1);
    if (!domain) {
      throw errors.notFound('Custom domain');
    }
    if (domain.desiredState === 'deactivating' || domain.desiredState === 'deleted') {
      throw errors.badRequest('Cannot verify a domain that is being removed');
    }

    const routes = await getEnvironmentPublicRouteTargets(db, c.env, envId);
    const parent = findParentRoute(routes, domain.service, domain.port);
    if (!parent) {
      await db
        .update(schema.deploymentCustomDomains)
        .set({ routingStatus: 'route_missing' })
        .where(eq(schema.deploymentCustomDomains.id, domainId));
      throw errors.badRequest(
        `The public route for service "${domain.service}" on port ${domain.port} no longer exists in this environment's latest release`
      );
    }

    const nodeIp = await resolveNodeIp(db, environment.nodeId);
    const ok = await verifyCustomDomainTarget(
      domain.hostname,
      parent.route.hostname,
      nodeIp,
      c.env
    );

    const now = new Date().toISOString();
    const verificationError = ok
      ? null
      : `${domain.hostname} does not resolve to ${parent.route.hostname}${
          nodeIp ? ` or ${nodeIp}` : ''
        }. Set a CNAME record pointing ${domain.hostname} at ${parent.route.hostname}.`;

    let activationRoutingRevision: number | null = domain.activationRoutingRevision;
    if (ok) {
      activationRoutingRevision = await requestRoutingRevision(db, envId);
    }

    await db
      .update(schema.deploymentCustomDomains)
      .set({
        verificationStatus: ok ? 'verified' : 'failed',
        verificationError,
        verifiedAt: ok ? now : null,
        verifiedCnameTarget: ok ? parent.route.hostname : domain.verifiedCnameTarget,
        desiredState: 'active',
        routingStatus: ok ? 'activating' : 'failed',
        activationRoutingRevision,
      })
      .where(eq(schema.deploymentCustomDomains.id, domainId));

    await recordCustomDomainEvent(db, {
      projectId,
      environmentId: envId,
      customDomainId: domainId,
      hostname: domain.hostname,
      nodeId: environment.nodeId,
      routingRevision: activationRoutingRevision,
      eventType: ok ? 'custom_domain.verify_succeeded' : 'custom_domain.verify_failed',
      level: ok ? 'info' : 'warn',
      message: ok
        ? 'custom domain DNS verified; route activation requested'
        : 'custom domain DNS verification failed',
      detail: { cnameTarget: parent.route.hostname, verificationError },
    });

    const [updatedEnvironment, updated] = await Promise.all([
      requireEnvironment(db, projectId, envId),
      db
        .select()
        .from(schema.deploymentCustomDomains)
        .where(eq(schema.deploymentCustomDomains.id, domainId))
        .limit(1),
    ]);
    const updatedDomain = updated[0];
    if (!updatedDomain) {
      throw errors.internal('Custom domain verification update was not persisted');
    }

    log.info('deployment_custom_domain.verified', {
      projectId,
      envId,
      domainId,
      hostname: domain.hostname,
      verified: ok,
      routingRevision: activationRoutingRevision,
    });

    return c.json(toCustomDomainResponse(updatedDomain, routes, updatedEnvironment));
  }
);

/**
 * DELETE /api/projects/:projectId/environments/:envId/custom-domains/:domainId
 * Request route deactivation. Verified domains stay visible until node observes
 * the routing revision and removes the live Caddy site block.
 */
deploymentCustomDomainRoutes.delete(
  '/:projectId/environments/:envId/custom-domains/:domainId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const domainId = c.req.param('domainId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'deployment:manage');
    const environment = await requireEnvironment(db, projectId, envId);

    const [domain] = await db
      .select()
      .from(schema.deploymentCustomDomains)
      .where(
        and(
          eq(schema.deploymentCustomDomains.id, domainId),
          eq(schema.deploymentCustomDomains.environmentId, envId),
          isNull(schema.deploymentCustomDomains.deletedAt)
        )
      )
      .limit(1);
    if (!domain) {
      throw errors.notFound('Custom domain');
    }

    const routes = await getEnvironmentPublicRouteTargets(db, c.env, envId);
    const shouldReconcileRoute =
      domain.verificationStatus === 'verified' && domain.desiredState !== 'deactivating';
    const deactivationRoutingRevision = shouldReconcileRoute
      ? await requestRoutingRevision(db, envId)
      : domain.deactivationRoutingRevision;
    const now = new Date().toISOString();

    await db
      .update(schema.deploymentCustomDomains)
      .set(
        shouldReconcileRoute
          ? {
              desiredState: 'deactivating',
              routingStatus: 'deactivating',
              deactivationRoutingRevision,
            }
          : {
              desiredState: 'deleted',
              routingStatus: 'deactivated',
              deletedAt: now,
            }
      )
      .where(eq(schema.deploymentCustomDomains.id, domainId));

    await recordCustomDomainEvent(db, {
      projectId,
      environmentId: envId,
      customDomainId: domainId,
      hostname: domain.hostname,
      nodeId: environment.nodeId,
      routingRevision: deactivationRoutingRevision,
      eventType: shouldReconcileRoute
        ? 'custom_domain.deactivation_requested'
        : 'custom_domain.deleted_without_live_route',
      message: shouldReconcileRoute
        ? 'custom domain deactivation requested'
        : 'custom domain deleted before route activation',
    });

    const [updatedEnvironment, updated] = await Promise.all([
      requireEnvironment(db, projectId, envId),
      db
        .select()
        .from(schema.deploymentCustomDomains)
        .where(eq(schema.deploymentCustomDomains.id, domainId))
        .limit(1),
    ]);
    const updatedDomain = updated[0];
    if (!updatedDomain) {
      throw errors.internal('Custom domain delete update was not persisted');
    }

    log.info('deployment_custom_domain.deactivation_requested', {
      projectId,
      envId,
      domainId,
      routingRevision: deactivationRoutingRevision,
      immediate: !shouldReconcileRoute,
    });

    return c.json(
      toCustomDomainResponse(updatedDomain, routes, updatedEnvironment),
      shouldReconcileRoute ? 202 : 200
    );
  }
);

export { deploymentCustomDomainRoutes };
