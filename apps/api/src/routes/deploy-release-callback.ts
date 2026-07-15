/**
 * Deploy release callback route — node fetches signed apply payload.
 *
 * Called by the VM agent (deployment mode) to fetch the full signed apply
 * payload for a specific release sequence. Uses callback JWT auth — this
 * endpoint MUST be mounted before projectsRoutes to avoid the session auth
 * middleware leak (see .claude/rules/34-vm-agent-callback-auth.md).
 */
import { and, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { errors } from '../middleware/error';
import {
  type ComposeImageArtifactDownload,
  createComposeImageArtifactDownloads,
} from '../services/compose-image-artifacts';
import {
  buildComposePublishApplyPayload,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
  DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB,
} from '../services/compose-publish-apply';
import { collectSecretNames, renderComposeForApply } from '../services/compose-renderer';
import { signDeployPayload, signRouteConfigPayload } from '../services/deploy-signing';
import { buildVerifiedCustomRouteTargets } from '../services/deployment-custom-domains';
import { loadDeploymentInterpolationEnv } from '../services/deployment-environment-config';
import {
  buildDeploymentRouteTargets,
  collectEnvironmentRouteHostnames,
  type DeploymentRouteTarget,
} from '../services/deployment-routing';
import { buildVolumeMountDescriptors } from '../services/deployment-volumes';
import { cleanupAppRouteDNSRecords, upsertAppRouteDNSRecord } from '../services/dns';
import { verifyCallbackToken } from '../services/jwt';
import { mintProjectRegistryCredential } from '../services/registry-credentials';
import { getEncryptionKey, loadResolvedSecrets } from './deployment-releases';

const deployReleaseCallbackRoute = new Hono<{ Bindings: Env }>();
const DEFAULT_DEPLOY_PAYLOAD_EXPIRY_SECONDS = 3_600;

async function verifyNodeCallback(c: Context<{ Bindings: Env }>, nodeId: string) {
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
}

deployReleaseCallbackRoute.get('/:id/deployment-env', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallback(c, nodeId);
  const environmentId = c.req.query('environmentId');
  if (!environmentId) {
    throw errors.badRequest('Missing required query parameter: environmentId');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const nodeRows = await db
    .select({ userId: schema.nodes.userId })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  const node = nodeRows.at(0);
  if (!node) {
    throw errors.notFound('Node');
  }

  const envRows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      configUpdatedAt: schema.deploymentEnvironments.configUpdatedAt,
    })
    .from(schema.deploymentEnvironments)
    .innerJoin(schema.projects, eq(schema.deploymentEnvironments.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.deploymentEnvironments.id, environmentId),
        eq(schema.deploymentEnvironments.nodeId, nodeId),
        eq(schema.projects.userId, node.userId)
      )
    )
    .limit(1);
  const environment = envRows.at(0);
  if (!environment) {
    throw errors.notFound('Deployment environment');
  }

  const config = await loadDeploymentInterpolationEnv(db, environmentId, getEncryptionKey(c.env));
  return c.json({
    environmentId,
    interpolationEnv: config.values,
    configUpdatedAt: environment.configUpdatedAt ?? null,
  });
});

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
  await verifyNodeCallback(c, nodeId);

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
    .select({
      userId: schema.nodes.userId,
      ipAddress: schema.nodes.ipAddress,
      providerInstanceId: schema.nodes.providerInstanceId,
    })
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
      requiresVolumes: schema.deploymentEnvironments.requiresVolumes,
    })
    .from(schema.deploymentEnvironments)
    .innerJoin(schema.projects, eq(schema.deploymentEnvironments.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.deploymentEnvironments.id, environmentId),
        eq(schema.deploymentEnvironments.nodeId, nodeId),
        eq(schema.projects.userId, node.userId)
      )
    )
    .limit(1);

  if (envRows.length === 0) {
    throw errors.notFound('Deployment environment');
  }
  // Safe: envRows.length is checked above (throws 404 if empty)
  const deployEnv = envRows[0]!;

  // Volume-requiring environments need the node's providerInstanceId to build
  // volume mount descriptors (volumes are matched to the node by attachedServerId,
  // which equals the provider instance id). If the node has not yet reported its
  // providerInstanceId, serving the payload would silently omit ALL volume mounts
  // and the app would deploy against ephemeral container storage — data loss.
  // Reject with 422 so the node retries once provisioning has populated the field.
  if (deployEnv.requiresVolumes && !node.providerInstanceId) {
    throw errors.unprocessable(
      'Deployment node has not reported its provider instance id yet; retry after provisioning completes',
      { environmentId, nodeId, seq }
    );
  }

  // Find the release by version (seq) within the environment
  const releaseRows = await db
    .select()
    .from(schema.deploymentReleases)
    .where(
      and(
        eq(schema.deploymentReleases.environmentId, environmentId),
        eq(schema.deploymentReleases.version, seq)
      )
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
  let interpolationEnv: Record<string, string> = {};
  let artifacts: ComposeImageArtifactDownload[] = [];
  let isR2ComposePublishRelease = false;
  const environmentConfig = await loadDeploymentInterpolationEnv(
    db,
    environmentId,
    getEncryptionKey(c.env)
  );

  if (release.source === 'compose-publish') {
    const submission = JSON.parse(release.manifest);
    const applied = buildComposePublishApplyPayload(submission, {
      environmentId,
      baseDomain: c.env.BASE_DOMAIN,
      routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
      routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
      releaseId: release.id,
      defaultMemoryLimitMb: parsePositiveInt(
        c.env.DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB,
        DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB
      ),
      defaultLogMaxSize:
        c.env.DEPLOYMENT_LOG_MAX_SIZE?.trim() || DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
      defaultLogMaxFile:
        c.env.DEPLOYMENT_LOG_MAX_FILE?.trim() || DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
    });
    routes = applied.routes;
    composeYaml = applied.composeYaml;
    interpolationEnv = environmentConfig.values;
    if (applied.artifacts.length > 0) {
      artifacts = await createComposeImageArtifactDownloads(c.env, applied.artifacts);
      isR2ComposePublishRelease = true;
    }

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
        throw errors.conflict(
          'Deployment node does not have an IP address yet; retry after provisioning completes'
        );
      }
      await Promise.all(
        routes.map((route) => upsertAppRouteDNSRecord(route.hostname, nodeIp, c.env))
      );
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
        throw errors.conflict(
          'Deployment node does not have an IP address yet; retry after provisioning completes'
        );
      }

      await Promise.all(
        routes.map((route) => upsertAppRouteDNSRecord(route.hostname, nodeIp, c.env))
      );
    }

    // Resolve secret references — inject decrypted values for the node
    const secretNames = collectSecretNames(manifest);
    const resolvedSecrets =
      secretNames.length > 0
        ? await loadResolvedSecrets(db, environmentId, secretNames, getEncryptionKey(c.env))
        : {};

    // Render the Compose YAML from the manifest. Secret values are supplied as
    // transient interpolation env, not materialized into the compose file.
    const rendered = renderComposeForApply(manifest, {
      environmentId,
      releaseId: release.id,
      routeTargets: routes,
      resolvedSecrets,
      baseInterpolationEnv: environmentConfig.values,
    });
    composeYaml = rendered.composeYaml;
    interpolationEnv = rendered.interpolationEnv;
  }

  // Append VERIFIED custom domains as additional signed RouteTargets, reusing
  // each parent public route's loopback hostPort so node-local Caddy renders a
  // site block (ACME HTTP-01 + reverse_proxy) for the user's hostname. These
  // ride inside the signed payload's `routes` (covered by routesHash) but are
  // EXCLUDED from the grey-cloud DNS upsert above — the user owns the custom
  // hostname's DNS record (they point a CNAME at the SAM route target).
  const customTargets = await buildVerifiedCustomRouteTargets(db, environmentId, routes);
  if (customTargets.length > 0) {
    routes = [...routes, ...customTargets];
  }

  const cleanupStaleRoutes = async () => {
    const priorReleaseRows = await db
      .select({ manifest: schema.deploymentReleases.manifest })
      .from(schema.deploymentReleases)
      .where(
        and(
          eq(schema.deploymentReleases.environmentId, environmentId),
          lt(schema.deploymentReleases.version, seq)
        )
      );
    const previousHostnames = collectEnvironmentRouteHostnames(
      priorReleaseRows.map((row) => row.manifest),
      {
        environmentId,
        baseDomain: c.env.BASE_DOMAIN,
        routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
        routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
      }
    );
    const currentHostnames = new Set(routes.map((route) => route.hostname));
    const staleHostnames = previousHostnames.filter((hostname) => !currentHostnames.has(hostname));
    if (staleHostnames.length === 0) {
      return;
    }
    const deleted = await cleanupAppRouteDNSRecords(staleHostnames, c.env);
    log.info('deploy_release.stale_route_dns_cleaned', {
      nodeId,
      environmentId,
      releaseId: release.id,
      requested: staleHostnames.length,
      deleted,
    });
  };
  let executionCtx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = null;
  }
  executionCtx?.waitUntil(
    cleanupStaleRoutes().catch((err) => {
      log.error('deploy_release.stale_route_dns_cleanup_failed', {
        nodeId,
        environmentId,
        releaseId: release.id,
        error: err instanceof Error ? err.message : String(err),
      });
    })
  );

  const expiresAt =
    Math.floor(Date.now() / 1000) +
    parsePositiveInt(c.env.DEPLOY_PAYLOAD_EXPIRY_SECONDS, DEFAULT_DEPLOY_PAYLOAD_EXPIRY_SECONDS);
  const volumeMounts = await buildVolumeMountDescriptors(
    db,
    environmentId,
    node.providerInstanceId ?? ''
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
      interpolationEnv,
      artifacts,
      volumeMounts,
    },
    c.env
  );

  // Mint short-lived pull-only registry credentials for legacy private image
  // pulls. R2-backed compose-publish releases deliberately do not receive
  // registry credentials; build-backed images are loaded locally from signed R2
  // artifacts and image-only services are limited to unauthenticated pulls.
  // Best-effort: if minting fails (e.g., CF_ACCOUNT_ID not configured),
  // the payload is still served without credentials (public images still work).
  let registryCredentials: { server: string; username: string; password: string } | null = null;
  if (!isR2ComposePublishRelease) {
    try {
      const creds = await mintProjectRegistryCredential(
        c.env,
        deployEnv.projectId,
        node.userId,
        '', // no task context in deploy callback
        environmentId,
        { permissions: ['pull'] }
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
  }

  log.info('deploy_release.served', {
    nodeId,
    environmentId,
    seq,
    releaseId: release.id,
    routeCount: routes.length,
    artifactCount: artifacts.length,
    volumeMountCount: volumeMounts.length,
    interpolationEnvKeyCount: Object.keys(interpolationEnv).length,
    hasRegistryCredentials: registryCredentials !== null,
  });

  return c.json({
    environmentId,
    nodeId,
    seq,
    expiresAt,
    composeYaml,
    interpolationEnv,
    routes,
    artifacts,
    volumeMounts,
    signature,
    registryCredentials,
  });
});

/**
 * GET /api/nodes/:id/deploy-routes?revision=R&environmentId=E
 *
 * Returns a signed route-only Caddy configuration payload. The node applies this
 * without running Docker Compose, so custom-domain verify/delete can reconcile
 * live routing independently from application release applies.
 */
deployReleaseCallbackRoute.get('/:id/deploy-routes', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallback(c, nodeId);

  const revisionStr = c.req.query('revision');
  const environmentId = c.req.query('environmentId');
  if (!revisionStr || !environmentId) {
    throw errors.badRequest('Missing required query parameters: revision, environmentId');
  }

  const routingRevision = Number.parseInt(revisionStr, 10);
  if (!Number.isFinite(routingRevision) || routingRevision <= 0) {
    throw errors.badRequest('Invalid revision parameter');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const nodeRows = await db
    .select({ userId: schema.nodes.userId })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  const node = nodeRows.at(0);
  if (!node) {
    throw errors.notFound('Node');
  }

  const envRows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      projectId: schema.deploymentEnvironments.projectId,
      nodeId: schema.deploymentEnvironments.nodeId,
      status: schema.deploymentEnvironments.status,
      observedAppliedSeq: schema.deploymentEnvironments.observedAppliedSeq,
      desiredRoutingRevision: schema.deploymentEnvironments.desiredRoutingRevision,
      observedRoutingRevision: schema.deploymentEnvironments.observedRoutingRevision,
    })
    .from(schema.deploymentEnvironments)
    .innerJoin(schema.projects, eq(schema.deploymentEnvironments.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.deploymentEnvironments.id, environmentId),
        eq(schema.deploymentEnvironments.nodeId, nodeId),
        eq(schema.projects.userId, node.userId)
      )
    )
    .limit(1);
  const deployEnv = envRows.at(0);
  if (!deployEnv) {
    throw errors.notFound('Deployment environment');
  }
  if (routingRevision < deployEnv.desiredRoutingRevision) {
    throw errors.conflict('Requested routing revision is stale; wait for the latest heartbeat');
  }
  if (routingRevision > deployEnv.desiredRoutingRevision) {
    throw errors.badRequest('Requested routing revision is newer than desired state');
  }
  if (routingRevision <= deployEnv.observedRoutingRevision) {
    throw errors.conflict('Requested routing revision is already observed');
  }

  const currentSeq = deployEnv.observedAppliedSeq ?? 0;
  if (currentSeq <= 0) {
    throw errors.conflict('Deployment environment has no applied release for route reconciliation');
  }

  const releaseRows = await db
    .select()
    .from(schema.deploymentReleases)
    .where(
      and(
        eq(schema.deploymentReleases.environmentId, environmentId),
        eq(schema.deploymentReleases.version, currentSeq)
      )
    )
    .limit(1);
  const release = releaseRows.at(0);
  if (!release) {
    throw errors.notFound('Applied deployment release');
  }

  let routes: DeploymentRouteTarget[];
  if (release.source === 'compose-publish') {
    const submission = JSON.parse(release.manifest);
    routes = buildComposePublishApplyPayload(submission, {
      environmentId,
      baseDomain: c.env.BASE_DOMAIN,
      routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
      routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
      releaseId: release.id,
      defaultMemoryLimitMb: parsePositiveInt(
        c.env.DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB,
        DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB
      ),
      defaultLogMaxSize:
        c.env.DEPLOYMENT_LOG_MAX_SIZE?.trim() || DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
      defaultLogMaxFile:
        c.env.DEPLOYMENT_LOG_MAX_FILE?.trim() || DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
    }).routes;
  } else {
    routes = buildDeploymentRouteTargets(JSON.parse(release.manifest), {
      environmentId,
      baseDomain: c.env.BASE_DOMAIN,
      routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
      routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
    });
  }

  const customTargets = await buildVerifiedCustomRouteTargets(db, environmentId, routes);
  if (customTargets.length > 0) {
    routes = [...routes, ...customTargets];
  }

  const expiresAt =
    Math.floor(Date.now() / 1000) +
    parsePositiveInt(c.env.DEPLOY_PAYLOAD_EXPIRY_SECONDS, DEFAULT_DEPLOY_PAYLOAD_EXPIRY_SECONDS);
  const signature = await signRouteConfigPayload(
    {
      environmentId,
      nodeId,
      currentSeq,
      routingRevision,
      expiresAt,
      routes,
    },
    c.env
  );

  log.info('deploy_routes.served', {
    nodeId,
    environmentId,
    currentSeq,
    routingRevision,
    routeCount: routes.length,
  });

  return c.json({
    environmentId,
    nodeId,
    currentSeq,
    routingRevision,
    expiresAt,
    routes,
    signature,
  });
});

export { deployReleaseCallbackRoute };
