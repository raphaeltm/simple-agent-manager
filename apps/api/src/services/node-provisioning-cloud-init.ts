/**
 * Cloud-init rendering for managed node provisioning. Split out of `node-provisioning.ts`
 * (rule 18) so the transport-specific variables live next to the rest of the boot config.
 */
import { type CloudInitVariables, generateCloudInit } from '@simple-agent-manager/cloud-init';
import { type TaskMode } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import {
  resolveEffectiveNodeHostMemoryReserveMb,
} from '../scheduler-core';
import { nodeTunnelBootVariables } from './node-tunnel-config';
import type { NodeTunnelProvisioning } from './node-tunnel-provisioning';
import { errorReportCloudInitVariables } from './vm-error-report-config';

export interface NodeCloudInitInput {
  env: Env;
  node: { id: string; userId: string };
  runtimeIncarnationId: string | null;
  callbackToken: string;
  providerName: string;
  taskContext?: {
    projectId: string;
    chatSessionId: string;
    taskId: string;
    taskMode?: TaskMode;
  };
  deploymentContext?: { environmentId: string };
  /** Present only for tunnel-transport workspace nodes. */
  tunnel?: NodeTunnelProvisioning | null;
}

export function buildNodeCloudInit(input: NodeCloudInitInput): string {
  const { env, node, taskContext, deploymentContext, tunnel } = input;
  const isDeploymentNode = !!deploymentContext;
  const variables: CloudInitVariables = {
    nodeId: node.id,
    nodeUserId: node.userId,
    nodeRuntimeIncarnationId: input.runtimeIncarnationId ?? undefined,
    hostname: `node-${node.id.toLowerCase()}`,
    controlPlaneUrl: `https://api.${env.BASE_DOMAIN}`,
    jwksUrl: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`,
    callbackToken: input.callbackToken,
    agentDownloadTimeoutSeconds: env.CLOUD_INIT_AGENT_DOWNLOAD_TIMEOUT_SECONDS,
    certMaxAttempts: env.CLOUD_INIT_CERT_MAX_ATTEMPTS,
    certBaseDelaySeconds: env.CLOUD_INIT_CERT_BASE_DELAY_SECONDS,
    certMaxDelaySeconds: env.CLOUD_INIT_CERT_MAX_DELAY_SECONDS,
    certRequestTimeoutSeconds: env.CLOUD_INIT_CERT_REQUEST_TIMEOUT_SECONDS,
    provider: input.providerName,
    logJournalMaxUse: env.LOG_JOURNAL_MAX_USE,
    logJournalKeepFree: env.LOG_JOURNAL_KEEP_FREE,
    logJournalMaxRetention: env.LOG_JOURNAL_MAX_RETENTION,
    projectId: taskContext?.projectId,
    chatSessionId: taskContext?.chatSessionId,
    taskId: taskContext?.taskId,
    taskMode: taskContext?.taskMode,
    dockerDnsServers: env.DOCKER_DNS_SERVERS,
    // Tunnel nodes never fetch an Origin CA certificate: cloudflared terminates TLS at the
    // edge and the agent serves plain HTTP on loopback (the node-lifecycle route also
    // refuses issuance server-side for tunnel transport).
    originCaCertificateUrl: tunnel
      ? undefined
      : `https://api.${env.BASE_DOMAIN}/api/nodes/${node.id}/origin-ca-certificate`,
    vmAgentPort: env.VM_AGENT_PORT,
    vmAgentRequiredVersion: env.VM_AGENT_REQUIRED_VERSION?.trim(),
    vmAgentMemoryReserveMb: String(resolveEffectiveNodeHostMemoryReserveMb(env)),
    samInfraSliceMemoryMinMb: env.SAM_INFRA_SLICE_MEMORY_MIN_MB,
    samInfraSliceCpuWeight: env.SAM_INFRA_SLICE_CPU_WEIGHT,
    samWorkloadSliceCpuWeight: env.SAM_WORKLOAD_SLICE_CPU_WEIGHT,
    dockerMemoryMinMb: env.DOCKER_MEMORY_MIN_MB,
    heartbeatDockerStatsTimeout: env.HEARTBEAT_DOCKER_STATS_TIMEOUT,
    heartbeatWorkspaceMetricsMaxContainers: env.HEARTBEAT_WORKSPACE_METRICS_MAX_CONTAINERS,
    heartbeatWorkspaceMetricsMaxOutputBytes: env.HEARTBEAT_WORKSPACE_METRICS_MAX_OUTPUT_BYTES,
    devcontainerCacheEnabled: env.DEVCONTAINER_CACHE_ENABLED,
    workspaceBuildQueueDepth: env.WORKSPACE_BUILD_QUEUE_DEPTH,
    swapSizeMb: env.SWAP_SIZE_MB,
    swapSwappiness: env.SWAP_SWAPPINESS,
    role: isDeploymentNode ? 'deployment' : undefined,
    environmentId: deploymentContext?.environmentId,
    deploySigningPubKey: isDeploymentNode ? env.DEPLOY_SIGNING_PUBLIC_KEY : undefined,
    deployAcmeEmail: isDeploymentNode ? env.DEPLOY_ACME_EMAIL : undefined,
    deployAcmeCa: isDeploymentNode ? env.DEPLOY_ACME_CA : undefined,
    deployComposeCmd: isDeploymentNode ? env.DEPLOY_COMPOSE_CMD : undefined,
    deployHealthTimeout: isDeploymentNode ? env.DEPLOY_HEALTH_TIMEOUT : undefined,
    sessionSnapshotOperationTimeout: env.SESSION_SNAPSHOT_OPERATION_TIMEOUT,
    sessionSnapshotProgressReportInterval: env.SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL,
    sessionSnapshotProgressReportTimeout: env.SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT,
    ...errorReportCloudInitVariables(env),
  };
  if (tunnel) {
    variables.cloudflareTunnelToken = tunnel.connectorToken;
    variables.cloudflareTunnelPort = tunnel.tunnelPort;
    Object.assign(variables, nodeTunnelBootVariables(env));
  }
  return generateCloudInit(variables);
}
