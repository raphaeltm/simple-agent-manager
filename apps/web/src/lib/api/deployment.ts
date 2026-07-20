import type {
  NodeContainerListResponse,
  NodeLogFilter,
  NodeLogResponse,
  NodeResponse,
  NodeSystemInfo,
} from '@simple-agent-manager/shared';

import { request } from './client';
import type { GcpProject } from './credentials';

// ─── App Deployment Environments ────────────────────────────────────────────

export interface DeploymentObservedState {
  appliedSeq: number | null;
  status: string | null;
  errorMessage: string | null;
  services: unknown | null;
  deployStatus: unknown | null;
  diskTelemetry: unknown | null;
  observedAt: string | null;
}

export interface DeploymentAgentPolicy {
  agentDeployEnabled: boolean;
  agentDeployEnabledBy: string | null;
  agentDeployEnabledAt: string | null;
  agentDeployDisabledAt: string | null;
  allowedDeployProfileIds: string[];
}

export interface DeploymentReleaseSummary {
  id: string;
  environmentId: string;
  version: number;
  status: string;
  createdBy: string;
  createdAt: string;
  submittedBy?: {
    userId: string | null;
    workspaceId: string | null;
    taskId: string | null;
    agentProfileId: string | null;
  } | null;
}

export interface DeploymentEnvironmentNodeSummary extends Pick<
  NodeResponse,
  | 'id'
  | 'name'
  | 'status'
  | 'healthStatus'
  | 'cloudProvider'
  | 'vmSize'
  | 'vmLocation'
  | 'nodeRole'
  | 'ipAddress'
  | 'lastHeartbeatAt'
  | 'errorMessage'
  | 'createdAt'
  | 'updatedAt'
> {}

export type DeploymentEnvironmentStatus =
  | 'created'
  | 'active'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'failed';

export interface DeploymentEnvironment {
  id: string;
  projectId: string;
  name: string;
  status: DeploymentEnvironmentStatus;
  nodeId: string | null;
  provider: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  secretsUpdatedAt: string | null;
  observedDeployment: DeploymentObservedState;
  agentPolicy: DeploymentAgentPolicy;
  latestRelease: DeploymentReleaseSummary | null;
  routeHostnames: string[];
  node: DeploymentEnvironmentNodeSummary | null;
}

export interface DeploymentPublicRoute {
  id: string;
  service: string;
  port: number;
  hostname: string;
  hostPort: number;
  routeIndex: number;
  routesAreLive?: boolean;
}

export type DeploymentCustomDomainVerificationStatus = 'pending' | 'verified' | 'failed';
export type DeploymentCustomDomainDesiredState = 'active' | 'deactivating' | 'deleted';

export interface DeploymentCustomDomain {
  id: string;
  environmentId: string;
  service: string;
  port: number;
  routeIndex: number;
  hostname: string;
  verificationStatus: DeploymentCustomDomainVerificationStatus;
  verificationError: string | null;
  verifiedAt: string | null;
  verifiedCnameTarget: string | null;
  desiredState: DeploymentCustomDomainDesiredState;
  routingStatus: string;
  servingStatus: string;
  activationRoutingRevision: number | null;
  deactivationRoutingRevision: number | null;
  deletedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  cnameTarget: string | null;
  routeTargetChanged: boolean;
  environmentStatus: string;
  desiredRoutingRevision: number;
  observedRoutingRevision: number;
  observedRoutingStatus: string | null;
  observedRoutingError: string | null;
}

export interface CreateDeploymentCustomDomainRequest {
  service: string;
  port: number;
  hostname: string;
}

export interface DeploymentEnvironmentConfigVar {
  key: string;
  value: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentEnvironmentConfigResponse {
  envVars: DeploymentEnvironmentConfigVar[];
  updatedAt: string | null;
  variableCount: number;
  secretCount: number;
}

export interface UpsertDeploymentEnvironmentConfigVarRequest {
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface DeleteDeploymentEnvironmentResponse {
  id: string;
  deleted: boolean;
  nodeId: string | null;
  nodeDeleted: boolean;
  volumesDetached: number;
  volumesDeleted: number;
  dnsRecordsDeleted: number;
  warnings: string[];
}

export interface DeploymentEnvironmentStopResponse {
  environment: DeploymentEnvironment;
  lifecycle: {
    stopped: boolean;
    alreadyStopped: boolean;
    nodeId: string | null;
    nodeDeleted: boolean;
    volumesDetached: number;
    warnings: string[];
  };
}

export interface DeploymentEnvironmentStartResponse {
  environment: DeploymentEnvironment;
  lifecycle: {
    started: boolean;
    alreadyActive: boolean;
    nodeId: string | null;
    provisioningStarted: boolean;
    volumesAttachScheduled: boolean;
    latestReleaseVersion?: number;
  };
}

export interface DeploymentVolume {
  id: string;
  environmentId: string;
  name: string;
  providerVolumeId: string;
  providerName: string;
  sizeGb: number;
  location: string;
  status: string;
  attachedServerId: string | null;
  linuxDevice: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeploymentVolumeRequest {
  name: string;
  sizeGb: number;
  location: string;
}

export async function listDeploymentEnvironments(
  projectId: string
): Promise<{ environments: DeploymentEnvironment[] }> {
  return request<{ environments: DeploymentEnvironment[] }>(
    `/api/projects/${projectId}/environments`
  );
}

export async function createDeploymentEnvironment(
  projectId: string,
  name: string
): Promise<DeploymentEnvironment> {
  return request<DeploymentEnvironment>(`/api/projects/${projectId}/environments`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function updateDeploymentEnvironmentPolicy(
  projectId: string,
  envId: string,
  data: { agentDeployEnabled?: boolean; allowedDeployProfileIds?: string[] | null }
): Promise<DeploymentEnvironment> {
  return request<DeploymentEnvironment>(`/api/projects/${projectId}/environments/${envId}/policy`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteDeploymentEnvironment(
  projectId: string,
  envId: string
): Promise<DeleteDeploymentEnvironmentResponse> {
  return request<DeleteDeploymentEnvironmentResponse>(
    `/api/projects/${projectId}/environments/${envId}`,
    { method: 'DELETE' }
  );
}

export async function stopDeploymentEnvironment(
  projectId: string,
  envId: string
): Promise<DeploymentEnvironmentStopResponse> {
  return request<DeploymentEnvironmentStopResponse>(
    `/api/projects/${projectId}/environments/${envId}/stop`,
    { method: 'POST' }
  );
}

export async function startDeploymentEnvironment(
  projectId: string,
  envId: string
): Promise<DeploymentEnvironmentStartResponse> {
  return request<DeploymentEnvironmentStartResponse>(
    `/api/projects/${projectId}/environments/${envId}/start`,
    { method: 'POST' }
  );
}

export async function listDeploymentEnvironmentVolumes(
  projectId: string,
  envId: string
): Promise<{ volumes: DeploymentVolume[] }> {
  return request<{ volumes: DeploymentVolume[] }>(
    `/api/projects/${projectId}/environments/${envId}/volumes`
  );
}

export async function createDeploymentEnvironmentVolume(
  projectId: string,
  envId: string,
  data: CreateDeploymentVolumeRequest
): Promise<DeploymentVolume> {
  return request<DeploymentVolume>(`/api/projects/${projectId}/environments/${envId}/volumes`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteDeploymentEnvironmentVolume(
  projectId: string,
  envId: string,
  volumeId: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/api/projects/${projectId}/environments/${envId}/volumes/${volumeId}`,
    { method: 'DELETE' }
  );
}

export async function attachDeploymentEnvironmentVolumes(
  projectId: string,
  envId: string
): Promise<{ volumes: DeploymentVolume[] }> {
  return request<{ volumes: DeploymentVolume[] }>(
    `/api/projects/${projectId}/environments/${envId}/volumes/attach`,
    { method: 'POST' }
  );
}

export async function detachDeploymentEnvironmentVolumes(
  projectId: string,
  envId: string
): Promise<{ volumes: DeploymentVolume[] }> {
  return request<{ volumes: DeploymentVolume[] }>(
    `/api/projects/${projectId}/environments/${envId}/volumes/detach`,
    { method: 'POST' }
  );
}

export async function listDeploymentPublicRoutes(
  projectId: string,
  envId: string
): Promise<{ publicRoutes: DeploymentPublicRoute[] }> {
  return request<{ publicRoutes: DeploymentPublicRoute[] }>(
    `/api/projects/${projectId}/environments/${envId}/public-routes`
  );
}

export async function listDeploymentCustomDomains(
  projectId: string,
  envId: string
): Promise<{ customDomains: DeploymentCustomDomain[] }> {
  return request<{ customDomains: DeploymentCustomDomain[] }>(
    `/api/projects/${projectId}/environments/${envId}/custom-domains`
  );
}

export async function createDeploymentCustomDomain(
  projectId: string,
  envId: string,
  data: CreateDeploymentCustomDomainRequest
): Promise<DeploymentCustomDomain> {
  return request<DeploymentCustomDomain>(
    `/api/projects/${projectId}/environments/${envId}/custom-domains`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function verifyDeploymentCustomDomain(
  projectId: string,
  envId: string,
  domainId: string
): Promise<DeploymentCustomDomain> {
  return request<DeploymentCustomDomain>(
    `/api/projects/${projectId}/environments/${envId}/custom-domains/${domainId}/verify`,
    { method: 'POST' }
  );
}

export async function deleteDeploymentCustomDomain(
  projectId: string,
  envId: string,
  domainId: string
): Promise<DeploymentCustomDomain> {
  return request<DeploymentCustomDomain>(
    `/api/projects/${projectId}/environments/${envId}/custom-domains/${domainId}`,
    { method: 'DELETE' }
  );
}

export async function getDeploymentEnvironmentLogs(
  projectId: string,
  envId: string,
  filter?: Partial<NodeLogFilter>
): Promise<
  NodeLogResponse & { source?: string; nodeId?: string | null; unavailableReason?: string }
> {
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level) params.set('level', filter.level);
  if (filter?.container) params.set('container', filter.container);
  if (filter?.since) params.set('since', filter.since);
  if (filter?.until) params.set('until', filter.until);
  if (filter?.search) params.set('search', filter.search);
  if (filter?.cursor) params.set('cursor', filter.cursor);
  if (filter?.limit) params.set('limit', String(filter.limit));

  const qs = params.toString();
  return request<
    NodeLogResponse & { source?: string; nodeId?: string | null; unavailableReason?: string }
  >(`/api/projects/${projectId}/environments/${envId}/logs${qs ? `?${qs}` : ''}`);
}

export async function listDeploymentEnvironmentContainers(
  projectId: string,
  envId: string
): Promise<NodeContainerListResponse> {
  return request<NodeContainerListResponse>(
    `/api/projects/${projectId}/environments/${envId}/containers`
  );
}

export interface DeploymentEnvironmentMetricsResponse {
  systemInfo: NodeSystemInfo | null;
  nodeId?: string | null;
  fallbackMetrics?: {
    cpuLoadAvg1?: number;
    memoryPercent?: number;
    diskPercent?: number;
  } | null;
  unavailableReason?: string;
}

export async function getDeploymentEnvironmentMetrics(
  projectId: string,
  envId: string
): Promise<DeploymentEnvironmentMetricsResponse> {
  return request<DeploymentEnvironmentMetricsResponse>(
    `/api/projects/${projectId}/environments/${envId}/metrics`
  );
}

export async function getDeploymentEnvironmentConfig(
  projectId: string,
  envId: string
): Promise<DeploymentEnvironmentConfigResponse> {
  return request<DeploymentEnvironmentConfigResponse>(
    `/api/projects/${projectId}/environments/${envId}/runtime-config`
  );
}

export async function upsertDeploymentEnvironmentConfigVar(
  projectId: string,
  envId: string,
  data: UpsertDeploymentEnvironmentConfigVarRequest
): Promise<DeploymentEnvironmentConfigResponse> {
  return request<DeploymentEnvironmentConfigResponse>(
    `/api/projects/${projectId}/environments/${envId}/runtime/env-vars`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function deleteDeploymentEnvironmentConfigVar(
  projectId: string,
  envId: string,
  envKey: string
): Promise<DeploymentEnvironmentConfigResponse> {
  return request<DeploymentEnvironmentConfigResponse>(
    `/api/projects/${projectId}/environments/${envId}/runtime/env-vars/${encodeURIComponent(envKey)}`,
    { method: 'DELETE' }
  );
}

// ─── Environment Secrets (write-only) ──────────────────────────────────────

export interface DeploymentSecretEntry {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export async function listDeploymentSecrets(
  projectId: string,
  envId: string
): Promise<{ secrets: DeploymentSecretEntry[] }> {
  return request<{ secrets: DeploymentSecretEntry[] }>(
    `/api/projects/${projectId}/environments/${envId}/secrets`
  );
}

export async function setDeploymentSecret(
  projectId: string,
  envId: string,
  name: string,
  value: string
): Promise<{ name: string; created: boolean; updatedAt: string }> {
  return request<{ name: string; created: boolean; updatedAt: string }>(
    `/api/projects/${projectId}/environments/${envId}/secrets/${encodeURIComponent(name)}`,
    { method: 'PUT', body: JSON.stringify({ value }) }
  );
}

export async function deleteDeploymentSecret(
  projectId: string,
  envId: string,
  name: string
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    `/api/projects/${projectId}/environments/${envId}/secrets/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
}

// ─── Project Deployment (GCP OIDC for Defang) ─────────────────────────────

export interface ProjectDeploymentGcpResponse {
  connected: boolean;
  provider?: 'gcp';
  gcpProjectId?: string;
  serviceAccountEmail?: string;
  createdAt?: string;
}

export async function getProjectDeploymentGcp(
  projectId: string
): Promise<ProjectDeploymentGcpResponse> {
  return request<ProjectDeploymentGcpResponse>(`/api/projects/${projectId}/deployment/gcp`);
}

export async function setupProjectDeploymentGcp(
  projectId: string,
  data: { oauthHandle: string; gcpProjectId: string }
): Promise<{ success: boolean; credential: ProjectDeploymentGcpResponse }> {
  return request<{ success: boolean; credential: ProjectDeploymentGcpResponse }>(
    `/api/projects/${projectId}/deployment/gcp/setup`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function deleteProjectDeploymentGcp(projectId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/projects/${projectId}/deployment/gcp`, {
    method: 'DELETE',
  });
}

export async function listGcpProjectsForDeploy(
  projectId: string,
  oauthHandle: string
): Promise<{ projects: GcpProject[] }> {
  return request<{ projects: GcpProject[] }>(`/api/projects/${projectId}/deployment/gcp/projects`, {
    method: 'POST',
    body: JSON.stringify({ oauthHandle }),
  });
}

/**
 * Retrieve the OAuth handle after the GCP deployment callback redirect.
 * The handle is stored server-side and never appears in the URL.
 */
export async function getDeployOAuthResult(projectId: string): Promise<{ handle: string }> {
  return request<{ handle: string }>(`/api/projects/${projectId}/deployment/gcp/oauth-result`);
}
