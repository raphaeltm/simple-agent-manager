import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { toDeploymentAgentPolicy, toObservedDeploymentState } from './deployment-control';
import { collectEnvironmentRouteHostnames } from './deployment-routing';

type Db = ReturnType<typeof drizzle<typeof schema>>;

function cleanOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export interface DeploymentReleaseSubmittedBy {
  userId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  agentProfileId: string | null;
}

/** Normalizes a release manifest's `submittedBy` object. Anything that isn't an object is null. */
export function toReleaseSubmittedBy(value: unknown): DeploymentReleaseSubmittedBy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  return {
    userId: cleanOptionalString(rec.userId),
    workspaceId: cleanOptionalString(rec.workspaceId),
    taskId: cleanOptionalString(rec.taskId),
    agentProfileId: cleanOptionalString(rec.agentProfileId),
  };
}

/**
 * Parses the `submittedBy` JSON text that `json_extract(manifest, '$.submittedBy')` returns.
 * A malformed value is null, never an error, so one bad row cannot fail a list.
 */
export function parseReleaseSubmittedByJson(raw: unknown): DeploymentReleaseSubmittedBy | null {
  if (typeof raw !== 'string') return null;
  try {
    return toReleaseSubmittedBy(JSON.parse(raw));
  } catch {
    return null;
  }
}

function releaseSubmittedBy(manifestJson: string): DeploymentReleaseSubmittedBy | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return toReleaseSubmittedBy((parsed as Record<string, unknown>).submittedBy);
}

/**
 * Custom domains the deployment server has confirmed it routes, for every environment of a
 * project, oldest first. The Deployments list shows the first one as the address people visit;
 * one query per project keeps the list from fetching domains environment by environment.
 */
export async function listRoutedCustomDomainHostnames(
  db: Db,
  projectId: string
): Promise<Map<string, string[]>> {
  const domains = schema.deploymentCustomDomains;
  const rows = await db
    .select({ environmentId: domains.environmentId, hostname: domains.hostname })
    .from(domains)
    .where(
      and(
        inArray(
          domains.environmentId,
          db
            .select({ id: schema.deploymentEnvironments.id })
            .from(schema.deploymentEnvironments)
            .where(eq(schema.deploymentEnvironments.projectId, projectId))
        ),
        eq(domains.desiredState, 'active'),
        eq(domains.routingStatus, 'active'),
        isNull(domains.deletedAt)
      )
    )
    .orderBy(domains.createdAt);
  const byEnvironment = new Map<string, string[]>();
  for (const row of rows) {
    byEnvironment.set(row.environmentId, [
      ...(byEnvironment.get(row.environmentId) ?? []),
      row.hostname,
    ]);
  }
  return byEnvironment;
}

export async function buildDeploymentEnvironmentResponse(
  db: Db,
  workerEnv: Env,
  row: schema.DeploymentEnvironmentRow,
  /** Routed custom-domain hostnames, when the caller read them (`listRoutedCustomDomainHostnames`). */
  customDomainHostnames?: string[]
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
          providerInstanceType: schema.nodes.providerInstanceType,
          providerInstanceVcpuCount: schema.nodes.providerInstanceVcpuCount,
          providerInstanceMemoryMb: schema.nodes.providerInstanceMemoryMb,
          providerInstanceDiskGb: schema.nodes.providerInstanceDiskGb,
          providerInstanceBootDiskSizeGb: schema.nodes.providerInstanceBootDiskSizeGb,
          providerInstanceArchitecture: schema.nodes.providerInstanceArchitecture,
          observedProviderInstanceType: schema.nodes.observedProviderInstanceType,
          observedProviderInstanceVcpuCount: schema.nodes.observedProviderInstanceVcpuCount,
          observedProviderInstanceMemoryMb: schema.nodes.observedProviderInstanceMemoryMb,
          observedProviderInstanceDiskGb: schema.nodes.observedProviderInstanceDiskGb,
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
          submittedBy: releaseSubmittedBy(latestRelease.manifest),
        }
      : null,
    routeHostnames,
    ...(customDomainHostnames ? { customDomainHostnames } : {}),
    node: node ?? null,
  };
}
