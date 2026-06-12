/**
 * Deploy release callback route — node fetches signed apply payload.
 *
 * Called by the VM agent (deployment mode) to fetch the full signed apply
 * payload for a specific release sequence. Uses callback JWT auth — this
 * endpoint MUST be mounted before projectsRoutes to avoid the session auth
 * middleware leak (see .claude/rules/34-vm-agent-callback-auth.md).
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { errors } from '../middleware/error';
import { renderCompose } from '../services/compose-renderer';
import { signDeployPayload } from '../services/deploy-signing';
import { buildDeploymentRouteTargets } from '../services/deployment-routing';
import { upsertAppRouteDNSRecord } from '../services/dns';
import { verifyCallbackToken } from '../services/jwt';

const deployReleaseCallbackRoute = new Hono<{ Bindings: Env }>();
const DEFAULT_DEPLOY_PAYLOAD_EXPIRY_SECONDS = 3_600;

/**
 * GET /api/nodes/:id/deploy-release?seq=N&environmentId=E
 *
 * Returns a signed apply payload for the requested release sequence.
 * The node calls this when the heartbeat response includes a
 * pendingReleaseSeq greater than the node's current applied seq.
 */
deployReleaseCallbackRoute.get('/:id/deploy-release', async (c) => {
  const nodeId = c.req.param('id');

  // Verify callback JWT auth (same pattern as heartbeat/ready)
  const token = extractBearerToken(c.req.header('Authorization'));
  let payload;
  try {
    payload = await verifyCallbackToken(token, c.env, { expectedScope: 'node' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid callback token';
    if (message.includes('scope')) {
      throw errors.forbidden('Insufficient token scope');
    }
    throw errors.unauthorized('Invalid callback token');
  }

  if (payload.workspace !== nodeId) {
    throw errors.unauthorized('Callback token does not match node');
  }

  // Parse query parameters
  const seqStr = c.req.query('seq');
  const environmentId = c.req.query('environmentId');

  if (!seqStr || !environmentId) {
    throw errors.badRequest('Missing required query parameters: seq, environmentId');
  }

  const seq = parseInt(seqStr, 10);
  if (isNaN(seq) || seq <= 0) {
    throw errors.badRequest('Invalid seq parameter');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  // Look up the node to get its userId for authorization
  const nodeRows = await db
    .select({ userId: schema.nodes.userId, ipAddress: schema.nodes.ipAddress })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  const node = nodeRows.at(0);
  if (!node) {
    throw errors.notFound('Node');
  }

  // Verify the environment exists and belongs to the same user as the node
  // (environment → project → userId must match node → userId)
  const envRows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      projectId: schema.deploymentEnvironments.projectId,
      nodeId: schema.deploymentEnvironments.nodeId,
    })
    .from(schema.deploymentEnvironments)
    .innerJoin(
      schema.projects,
      eq(schema.deploymentEnvironments.projectId, schema.projects.id),
    )
    .where(
      and(
        eq(schema.deploymentEnvironments.id, environmentId),
        eq(schema.deploymentEnvironments.nodeId, nodeId),
        eq(schema.projects.userId, node.userId),
      ),
    )
    .limit(1);

  if (envRows.length === 0) {
    throw errors.notFound('Deployment environment');
  }

  // Find the release by version (seq) within the environment
  const releaseRows = await db
    .select()
    .from(schema.deploymentReleases)
    .where(
      and(
        eq(schema.deploymentReleases.environmentId, environmentId),
        eq(schema.deploymentReleases.version, seq),
      ),
    )
    .limit(1);

  const release = releaseRows.at(0);
  if (!release) {
    throw errors.notFound('Deployment release');
  }
  const manifest = JSON.parse(release.manifest);

  const routes = buildDeploymentRouteTargets(manifest, {
    environmentId,
    baseDomain: c.env.BASE_DOMAIN,
    routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
    routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
  });

  if (routes.length > 0) {
    const nodeIp = node.ipAddress;
    if (!nodeIp) {
      throw errors.conflict('Deployment node does not have an IP address yet; retry after provisioning completes');
    }

    await Promise.all(routes.map((route) => upsertAppRouteDNSRecord(route.hostname, nodeIp, c.env)));
  }

  // Render the Compose YAML from the manifest
  const composeYaml = renderCompose(manifest, {
    environmentId,
    releaseId: release.id,
    routeTargets: routes,
  });

  const expiresAt = Math.floor(Date.now() / 1000) + parsePositiveInt(
    c.env.DEPLOY_PAYLOAD_EXPIRY_SECONDS,
    DEFAULT_DEPLOY_PAYLOAD_EXPIRY_SECONDS,
  );

  // Sign the payload with the deploy signing key
  const signature = await signDeployPayload(
    {
      environmentId,
      nodeId,
      seq,
      expiresAt,
      composeYaml,
      routes,
    },
    c.env,
  );

  log.info('deploy_release.served', {
    nodeId,
    environmentId,
    seq,
    releaseId: release.id,
    routeCount: routes.length,
  });

  return c.json({
    environmentId,
    nodeId,
    seq,
    expiresAt,
    composeYaml,
    routes,
    signature,
    registryCredentials: null, // TODO: parallel work — registry credential minting
  });
});

export { deployReleaseCallbackRoute };
