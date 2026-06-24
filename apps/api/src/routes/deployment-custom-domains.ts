/**
 * Custom domain routes for deployment public routes (v1).
 *
 * Scoped under /api/projects/:projectId/environments/:envId/custom-domains.
 * Auth: session cookie + project ownership (browser CRUD — NOT a VM-agent
 * callback, so standard requireAuth/requireApproved/requireOwnedProject apply).
 *
 * A user attaches their own subdomain (CNAME) to an existing public route of a
 * deployment environment. SAM does NOT create the DNS record — the user points
 * a CNAME at the SAM-owned route hostname. SAM verifies the hostname resolves to
 * that target (or the node IP) via Cloudflare DoH, then includes it as an
 * additional signed RouteTarget on the next apply so node-local Caddy provisions
 * TLS + reverse-proxies it. v1: subdomains only, no wildcards, no TXT challenge.
 */

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import { getEnvironmentPublicRouteTargets } from '../services/deployment-custom-domains';
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

/** Throws notFound when the (projectId, envId) pair does not resolve to an environment. */
async function requireEnvironment(
  db: DeploymentDb,
  projectId: string,
  envId: string
): Promise<{ id: string; nodeId: string | null }> {
  const [environment] = await db
    .select({
      id: schema.deploymentEnvironments.id,
      nodeId: schema.deploymentEnvironments.nodeId,
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
  return { route: routes[routeIndex]!, routeIndex };
}

/** Resolve the node IP backing an environment (used as a flattened A-record match). */
async function resolveNodeIp(
  db: DeploymentDb,
  nodeId: string | null
): Promise<string | undefined> {
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

/** Serialize a custom-domain row plus the SAM-owned CNAME target the user must set. */
function toCustomDomainResponse(
  row: schema.DeploymentCustomDomainRow,
  routes: DeploymentRouteTarget[]
) {
  const parent = routes.find((r) => r.service === row.service && r.containerPort === row.port);
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
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    // The exact CNAME target the user must point their hostname at. Null when
    // the parent public route no longer exists in the current release.
    cnameTarget: parent?.hostname ?? null,
  };
}

// =============================================================================
// Routes
// =============================================================================

const deploymentCustomDomainRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments/:envId/custom-domains
 * Attach a custom hostname to an existing public route. Persists pending.
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
    await requireOwnedProject(db, projectId, userId);
    await requireEnvironment(db, projectId, envId);

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
      createdBy: userId,
    });

    const [created] = await db
      .select()
      .from(schema.deploymentCustomDomains)
      .where(eq(schema.deploymentCustomDomains.id, id))
      .limit(1);

    log.info('deployment_custom_domain.attached', {
      projectId,
      envId,
      domainId: id,
      hostname,
      service,
      port,
    });

    return c.json(toCustomDomainResponse(created!, routes), 201);
  }
);

/**
 * GET /api/projects/:projectId/environments/:envId/custom-domains
 * List custom domains for an environment, each with its expected CNAME target.
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
    await requireOwnedProject(db, projectId, userId);
    await requireEnvironment(db, projectId, envId);

    const [rows, routes] = await Promise.all([
      db
        .select()
        .from(schema.deploymentCustomDomains)
        .where(eq(schema.deploymentCustomDomains.environmentId, envId))
        .orderBy(schema.deploymentCustomDomains.createdAt),
      getEnvironmentPublicRouteTargets(db, c.env, envId),
    ]);

    return c.json({ customDomains: rows.map((row) => toCustomDomainResponse(row, routes)) });
  }
);

/**
 * POST /api/projects/:projectId/environments/:envId/custom-domains/:domainId/verify
 * Resolve the hostname via Cloudflare DoH and mark it verified or failed.
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
    await requireOwnedProject(db, projectId, userId);
    const environment = await requireEnvironment(db, projectId, envId);

    const [domain] = await db
      .select()
      .from(schema.deploymentCustomDomains)
      .where(
        and(
          eq(schema.deploymentCustomDomains.id, domainId),
          eq(schema.deploymentCustomDomains.environmentId, envId)
        )
      )
      .limit(1);
    if (!domain) {
      throw errors.notFound('Custom domain');
    }

    const routes = await getEnvironmentPublicRouteTargets(db, c.env, envId);
    const parent = findParentRoute(routes, domain.service, domain.port);
    if (!parent) {
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

    await db
      .update(schema.deploymentCustomDomains)
      .set({
        verificationStatus: ok ? 'verified' : 'failed',
        verificationError,
        verifiedAt: ok ? now : null,
      })
      .where(eq(schema.deploymentCustomDomains.id, domainId));

    const [updated] = await db
      .select()
      .from(schema.deploymentCustomDomains)
      .where(eq(schema.deploymentCustomDomains.id, domainId))
      .limit(1);

    log.info('deployment_custom_domain.verified', {
      projectId,
      envId,
      domainId,
      hostname: domain.hostname,
      verified: ok,
    });

    return c.json(toCustomDomainResponse(updated!, routes));
  }
);

/**
 * DELETE /api/projects/:projectId/environments/:envId/custom-domains/:domainId
 * Detach a custom domain. Its site block drops on the next apply.
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
    await requireOwnedProject(db, projectId, userId);
    await requireEnvironment(db, projectId, envId);

    const [domain] = await db
      .select({ id: schema.deploymentCustomDomains.id })
      .from(schema.deploymentCustomDomains)
      .where(
        and(
          eq(schema.deploymentCustomDomains.id, domainId),
          eq(schema.deploymentCustomDomains.environmentId, envId)
        )
      )
      .limit(1);
    if (!domain) {
      throw errors.notFound('Custom domain');
    }

    await db
      .delete(schema.deploymentCustomDomains)
      .where(eq(schema.deploymentCustomDomains.id, domainId));

    log.info('deployment_custom_domain.deleted', { projectId, envId, domainId });

    return c.json({ id: domainId, deleted: true });
  }
);

export { deploymentCustomDomainRoutes };
