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
import { buildComposePublishApplyPayload } from '../services/compose-publish-apply';
import { collectSecretNames, renderCompose } from '../services/compose-renderer';
import { signDeployPayload } from '../services/deploy-signing';
import { buildDeploymentRouteTargets, type DeploymentRouteTarget } from '../services/deployment-routing';
import { upsertAppRouteDNSRecord } from '../services/dns';
import { verifyCallbackToken } from '../services/jwt';
import { mintProjectRegistryCredential } from '../services/registry-credentials';
import { getEncryptionKey, loadResolvedSecrets } from './deployment-releases';

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
  // Safe: envRows.length is checked above (throws 404 if empty)
  const deployEnv = envRows[0]!;

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

  await db
    .update(schema.deploymentReleases)
    .set({ status: 'applying' })
    .where(eq(schema.deploymentReleases.id, release.id));

  // Two release shapes share this apply path, discriminated by `release.source`:
  //
  //  - compose-publish: the stored manifest IS the captured publish submission
  //    ({ reference, composeYaml, services[] }). We transform the raw compose
  //    in-place (preserving provider:/healthcheck/depends_on, digest-pinning
  //    build images via pushedRef) rather than round-tripping through the lossy
  //    normalized manifest. Routes are derived from each service's `ports:`.
  //
  //  - build-on-node (default): the stored manifest is the normalized
  //    DeploymentManifest. Routes come from manifest.routes and the compose is
  //    re-rendered from the manifest with secret injection.
  let routes: DeploymentRouteTarget[];
  let composeYaml: string;

  if (release.source === 'compose-publish') {
    const submission = JSON.parse(release.manifest);
    const applied = buildComposePublishApplyPayload(submission, {
      environmentId,
      baseDomain: c.env.BASE_DOMAIN,
      routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
      routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
      releaseId: release.id,
    });
    routes = applied.routes;
    composeYaml = applied.composeYaml;

    if (applied.warnings.length > 0) {
      log.warn('deploy_release.compose_publish_warnings', {
        nodeId,
        environmentId,
        seq,
        releaseId: release.id,
        warnings: applied.warnings,
      });
    }

    if (routes.length > 0) {
      const nodeIp = node.ipAddress;
      if (!nodeIp) {
        throw errors.conflict('Deployment node does not have an IP address yet; retry after provisioning completes');
      }
      await Promise.all(routes.map((route) => upsertAppRouteDNSRecord(route.hostname, nodeIp, c.env)));
    }
  } else {
    const manifest = JSON.parse(release.manifest);

    routes = buildDeploymentRouteTargets(manifest, {
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

    // Resolve secret references — inject decrypted values for the node
    const secretNames = collectSecretNames(manifest);
    const resolvedSecrets = secretNames.length > 0
      ? await loadResolvedSecrets(db, environmentId, secretNames, getEncryptionKey(c.env))
      : {};

    // Render the Compose YAML from the manifest
    composeYaml = renderCompose(manifest, {
      environmentId,
      releaseId: release.id,
      routeTargets: routes,
      resolvedSecrets,
    });
  }

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

  // Mint short-lived pull-only registry credentials for private image pulls.
  // Best-effort: if minting fails (e.g., CF_ACCOUNT_ID not configured),
  // the payload is still served without credentials (public images still work).
  let registryCredentials: { server: string; username: string; password: string } | null = null;
  try {
    const creds = await mintProjectRegistryCredential(
      c.env,
      deployEnv.projectId,
      node.userId,
      '', // no task context in deploy callback
      environmentId,
      { permissions: ['pull'] },
    );
    registryCredentials = {
      server: creds.registry,
      username: creds.username,
      password: creds.password,
    };
  } catch (err) {
    log.warn('deploy_release.registry_credentials_skipped', {
      nodeId,
      environmentId,
      seq,
      reason: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  log.info('deploy_release.served', {
    nodeId,
    environmentId,
    seq,
    releaseId: release.id,
    routeCount: routes.length,
    hasRegistryCredentials: registryCredentials !== null,
  });

  return c.json({
    environmentId,
    nodeId,
    seq,
    expiresAt,
    composeYaml,
    routes,
    signature,
    registryCredentials,
  });
});

export { deployReleaseCallbackRoute };
