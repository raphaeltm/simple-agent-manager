import { desc, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  toDeploymentAgentPolicy,
  toObservedDeploymentState,
} from './deployment-control';
import { collectEnvironmentRouteHostnames } from './deployment-routing';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function buildDeploymentEnvironmentResponse(
  db: Db,
  workerEnv: Env,
  row: schema.DeploymentEnvironmentRow,
) {
  const [latestRelease] = await db
    .select({
      id: schema.deploymentReleases.id,
      environmentId: schema.deploymentReleases.environmentId,
      version: schema.deploymentReleases.version,
      status: schema.deploymentReleases.status,
      createdBy: schema.deploymentReleases.createdBy,
      createdAt: schema.deploymentReleases.createdAt,
      manifest: schema.deploymentReleases.manifest,
    })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, row.id))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  const [node] = row.nodeId
    ? await db
      .select({
        id: schema.nodes.id,
        name: schema.nodes.name,
        status: schema.nodes.status,
        healthStatus: schema.nodes.healthStatus,
        cloudProvider: schema.nodes.cloudProvider,
        vmSize: schema.nodes.vmSize,
        vmLocation: schema.nodes.vmLocation,
        nodeRole: schema.nodes.nodeRole,
        ipAddress: schema.nodes.ipAddress,
        lastHeartbeatAt: schema.nodes.lastHeartbeatAt,
        errorMessage: schema.nodes.errorMessage,
        createdAt: schema.nodes.createdAt,
        updatedAt: schema.nodes.updatedAt,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, row.nodeId))
      .limit(1)
    : [];

  const routeHostnames = latestRelease
    ? collectEnvironmentRouteHostnames([latestRelease.manifest], {
      environmentId: row.id,
      baseDomain: workerEnv.BASE_DOMAIN,
      routePortBase: workerEnv.DEPLOYMENT_ROUTE_PORT_BASE,
      routePortSpan: workerEnv.DEPLOYMENT_ROUTE_PORT_SPAN,
    })
    : [];

  return {
    ...row,
    observedDeployment: toObservedDeploymentState(row),
    agentPolicy: toDeploymentAgentPolicy(row),
    latestRelease: latestRelease
      ? {
        id: latestRelease.id,
        environmentId: latestRelease.environmentId,
        version: latestRelease.version,
        status: latestRelease.status,
        createdBy: latestRelease.createdBy,
        createdAt: latestRelease.createdAt,
      }
      : null,
    routeHostnames,
    node: node ?? null,
  };
}
