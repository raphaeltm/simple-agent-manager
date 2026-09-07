import { generateCloudInit, validateCloudInitSize } from '@simple-agent-manager/cloud-init';
import {
  isTransientCapacityError,
  type NativeVMConfig,
  ProviderError,
  type ProviderRequestContext,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from '@simple-agent-manager/providers';
import {
  type CapacityPlacementSnapshot,
  type CredentialProvider,
  type CredentialSource,
  DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH,
  isUserOwnedNodeClass,
  type TaskMode,
} from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { capacityPlacementSnapshotDbValues } from './capacity-placement-snapshot';
import { createNodeBackendDNSRecord, deleteDNSRecord } from './dns';
import { GcpApiError, sanitizeGcpError } from './gcp-errors';
import { signNodeCallbackToken } from './jwt';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { persistError } from './observability';
import {
  createProviderForUser,
  exactProviderCredentialBindingFromPlacementSnapshot,
} from './provider-credentials';
import {
  applyNativePlanToVmConfig,
  assertNativePlanConcrete,
  observedHardwareDbValues,
} from './runtime-allocation';
import { deleteNodeResourcesStrict } from './strict-node-deletion';
import { WORKSPACE_DELETION_DIAGNOSTIC_PREFIX } from './workspace-deletion';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';
import { resolveEffectiveNodeHostMemoryReserveMb } from './workspace-resource-capacity';

const NODE_ERROR_MESSAGE_MAX_LENGTH = 500;

type NodeAllocationPlanGuardRow = {
  id: string;
  user_id: string;
  status: string;
  capacity_pool_id: string | null;
  capacity_pool_scope: string | null;
  capacity_pool_revision: number | null;
  capacity_source_id: string | null;
  capacity_pool_candidate_id: string | null;
  capacity_pool_project_id: string | null;
  placement_credential_reference: string | null;
  placement_credential_version: number | null;
  provider_instance_type: string | null;
  pool_status: string | null;
  pool_revision: number | null;
  pool_configuration_state: string | null;
  source_status: string | null;
  source_credential_reference: string | null;
  source_credential_version: number | null;
  candidate_status: string | null;
  candidate_catalog_availability: string | null;
  candidate_provider_instance_type: string | null;
};

function managedNodeStopDiagnostic(env: Env): string {
  const configuredMaxLength = Number.parseInt(
    env.WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH ?? '',
    10
  );
  const maxLength =
    Number.isInteger(configuredMaxLength) && configuredMaxLength > 0
      ? configuredMaxLength
      : DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH;
  return `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: managed node teardown pending`.slice(
    0,
    maxLength
  );
}

export async function assertNodeAllocationPlanCurrent(
  env: Env,
  nodeId: string,
  userId: string,
  projectId: string | null
): Promise<void> {
  if (typeof env.DATABASE.prepare !== 'function') return;
  const row = await env.DATABASE.prepare(
    `SELECT
       n.id,
       n.user_id,
       n.status,
       n.capacity_pool_id,
       n.capacity_pool_scope,
       n.capacity_pool_revision,
       n.capacity_source_id,
       n.capacity_pool_candidate_id,
       n.capacity_pool_project_id,
       n.placement_credential_reference,
       n.placement_credential_version,
       n.provider_instance_type,
       p.status AS pool_status,
       p.revision AS pool_revision,
       p.configuration_state AS pool_configuration_state,
       s.status AS source_status,
       s.credential_reference AS source_credential_reference,
       s.credential_version AS source_credential_version,
       c.status AS candidate_status,
       c.catalog_availability AS candidate_catalog_availability,
       c.provider_instance_type AS candidate_provider_instance_type
     FROM nodes n
     LEFT JOIN capacity_pools p ON p.id = n.capacity_pool_id
     LEFT JOIN capacity_sources s ON s.id = n.capacity_source_id
     LEFT JOIN capacity_pool_candidates c ON c.id = n.capacity_pool_candidate_id
     WHERE n.id = ?`
  )
    .bind(nodeId)
    .first<NodeAllocationPlanGuardRow>();

  if (!row) {
    throw new Error('Node allocation record disappeared before provider allocation');
  }
  if (row.user_id !== userId) {
    throw new Error('Node allocation user changed before provider allocation');
  }
  if (row.status === 'deleted' || row.status === 'stopped') {
    throw new Error('Node allocation lifecycle is no longer active');
  }
  if (!row.capacity_pool_id) return;

  if (!row.pool_status) {
    throw new Error('Selected capacity pool no longer exists');
  }
  if (row.pool_status !== 'active' || row.pool_configuration_state !== 'configured-ready') {
    throw new Error(
      `Selected capacity pool is not currently usable (${row.pool_configuration_state ?? row.pool_status})`
    );
  }
  if (row.capacity_pool_revision !== row.pool_revision) {
    throw new Error('Selected capacity pool changed after placement was planned');
  }
  if (row.capacity_pool_scope === 'project' && row.capacity_pool_project_id !== projectId) {
    throw new Error('Selected project capacity pool no longer matches this allocation');
  }
  if (!row.source_status || row.source_status !== 'active') {
    throw new Error('Selected capacity source is not currently active');
  }
  if (!row.candidate_status || row.candidate_status !== 'active') {
    throw new Error('Selected capacity candidate is not currently active');
  }
  if (row.candidate_catalog_availability === 'last-known-unavailable') {
    throw new Error('Selected capacity candidate is no longer available in the provider catalog');
  }
  if (
    row.provider_instance_type &&
    row.candidate_provider_instance_type &&
    row.provider_instance_type !== row.candidate_provider_instance_type
  ) {
    throw new Error('Selected capacity candidate no longer matches the planned native offering');
  }
  if (
    row.placement_credential_reference &&
    row.source_credential_reference &&
    row.placement_credential_reference !== row.source_credential_reference
  ) {
    throw new Error('Selected capacity source credential reference changed after placement');
  }
  if (
    row.placement_credential_version !== null &&
    row.source_credential_version !== null &&
    row.placement_credential_version !== row.source_credential_version
  ) {
    throw new Error('Selected capacity source credential generation changed after placement');
  }
}

export interface CreateNodeInput {
  userId: string;
  credentialAttributionUserId?: string | null;
  credentialAttributionProjectId?: string | null;
  credentialAttributionSource?: CredentialSource | null;
  name: string;
  vmSize: string;
  vmLocation: string;
  heartbeatStaleAfterSeconds: number;
  cloudProvider?: string;
  /** Provider-native instance type/SKU selected from a compute pool. */
  providerInstanceType?: string | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: NativeVMConfig['architecture'] | null;
  /** 'workspace' (default) or 'deployment'. */
  nodeRole?: 'workspace' | 'deployment';
  /** 'shared' (default) or 'exclusive'. Exclusive deployment nodes accept one environment. */
  nodeMode?: 'shared' | 'exclusive';
  /** Runtime substrate. Defaults to traditional VM. */
  runtime?: 'vm' | 'cf-container';
  /** Capacity pool/source/candidate audit snapshot for auto-provisioned placement. */
  capacityPlacementSnapshot?: CapacityPlacementSnapshot | null;
}

export interface ProvisionedNode {
  id: string;
  userId: string;
  name: string;
  status: string;
  vmSize: string;
  vmLocation: string;
  cloudProvider: string | null;
  providerInstanceType: string | null;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: string | null;
  runtime: string;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  healthStatus: string;
  heartbeatStaleAfterSeconds: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolves the Hetzner base image override from the `HETZNER_BASE_IMAGE` env var.
 *
 * The default (returned as `undefined`) lets the Hetzner provider pick its own
 * default — currently `docker-ce` (Hetzner's Docker marketplace image, which
 * skips Docker install and saves ~30-60s on cold provisioning). Setting
 * `HETZNER_BASE_IMAGE=ubuntu-24.04` provides an emergency rollback without a
 * code change. The override is only applied for the Hetzner provider; other
 * providers have their own image resolution logic.
 *
 * Exported for unit-testing the env-var → provider plumbing.
 */
export function resolveHetznerBaseImageOverride(
  targetProvider: CredentialProvider | undefined,
  envValue: string | undefined
): string | undefined {
  if (targetProvider !== 'hetzner') return undefined;
  const trimmed = envValue?.trim();
  return trimmed ? trimmed : undefined;
}

export async function createNodeRecord(env: Env, input: CreateNodeInput): Promise<ProvisionedNode> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  const nodeId = ulid();
  const capacitySnapshotValues = capacityPlacementSnapshotDbValues(input.capacityPlacementSnapshot);

  await db.insert(schema.nodes).values({
    id: nodeId,
    userId: input.userId,
    credentialAttributionUserId: input.credentialAttributionUserId ?? input.userId,
    credentialAttributionProjectId:
      input.credentialAttributionSource === 'project'
        ? (input.credentialAttributionProjectId ?? null)
        : null,
    credentialAttributionSource: input.credentialAttributionSource ?? 'user',
    name: input.name,
    status: 'creating',
    vmSize: input.vmSize,
    vmLocation: input.vmLocation,
    cloudProvider: input.cloudProvider ?? null,
    healthStatus: 'stale',
    heartbeatStaleAfterSeconds: input.heartbeatStaleAfterSeconds,
    nodeRole: input.nodeRole ?? 'workspace',
    nodeMode: input.nodeMode ?? 'shared',
    runtime: input.runtime ?? 'vm',
    runtimeIncarnationId: crypto.randomUUID(),
    ...capacitySnapshotValues,
    providerInstanceType: input.providerInstanceType ?? capacitySnapshotValues.providerInstanceType,
    providerInstanceBootDiskSizeGb:
      input.providerInstanceBootDiskSizeGb ?? capacitySnapshotValues.providerInstanceBootDiskSizeGb,
    providerInstanceImage:
      input.providerInstanceImage ?? capacitySnapshotValues.providerInstanceImage,
    providerInstanceArchitecture:
      input.providerInstanceArchitecture ?? capacitySnapshotValues.providerInstanceArchitecture,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id: nodeId,
    userId: input.userId,
    name: input.name,
    status: 'creating',
    vmSize: input.vmSize,
    vmLocation: input.vmLocation,
    cloudProvider: input.cloudProvider ?? null,
    providerInstanceType: input.providerInstanceType ?? capacitySnapshotValues.providerInstanceType,
    providerInstanceBootDiskSizeGb:
      input.providerInstanceBootDiskSizeGb ?? capacitySnapshotValues.providerInstanceBootDiskSizeGb,
    providerInstanceImage:
      input.providerInstanceImage ?? capacitySnapshotValues.providerInstanceImage,
    providerInstanceArchitecture:
      input.providerInstanceArchitecture ?? capacitySnapshotValues.providerInstanceArchitecture,
    runtime: input.runtime ?? 'vm',
    ipAddress: null,
    lastHeartbeatAt: null,
    healthStatus: 'stale',
    heartbeatStaleAfterSeconds: input.heartbeatStaleAfterSeconds,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Optional task context for cloud-init (enables message reporter on VM). */
export interface ProvisionTaskContext {
  projectId: string;
  chatSessionId: string;
  taskId: string;
  taskMode?: TaskMode;
}

/** Deployment node context for cloud-init (sets role=deployment + environmentId). */
export interface DeploymentProvisionContext {
  environmentId: string;
}

export interface ProvisionNodeOptions {
  /**
   * When true, re-throw provider failures (preserving `ProviderError.category` and
   * `providerCode`) instead of silently writing a `status:'error'` node row and
   * returning. The TaskRunner size-fallback descent loop sets this so it can branch
   * on the error category (capacity → descend; anything else → fail fast).
   *
   * On a `transient_capacity` failure this also DELETES the failed node row before
   * throwing, so failed size attempts leave no orphaned `error` rows. Non-capacity
   * failures keep the existing `status:'error'` row before re-throwing.
   *
   * Legacy callers omit this and retain the original swallow-and-record behavior.
   */
  rethrowProviderError?: boolean;
  /** Explicit lifecycle cancellation for provider work; detached HTTP callers omit this. */
  signal?: AbortSignal;
  /** Fail-closed recovery-authority check at the provider allocation boundary. */
  assertExternalMutationAuthority?: () => Promise<void>;
}

export async function provisionNode(
  nodeId: string,
  env: Env,
  taskContext?: ProvisionTaskContext,
  options?: ProvisionNodeOptions,
  deploymentContext?: DeploymentProvisionContext
): Promise<void> {
  const providerContext: ProviderRequestContext | undefined = options?.signal
    ? { signal: options.signal }
    : undefined;
  throwIfProviderRequestAborted(providerContext);
  const db = drizzle(env.DATABASE, { schema });

  const nodes = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)).limit(1);

  const node = nodes[0];
  if (!node) {
    return;
  }

  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  let attemptedProvider = targetProvider;
  const attributionUserId = node.credentialAttributionUserId ?? node.userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? taskContext?.projectId ?? null)
      : null;
  const exactCredential = exactProviderCredentialBindingFromPlacementSnapshot(node);

  try {
    await assertNodeAllocationPlanCurrent(
      env,
      node.id,
      node.userId,
      taskContext?.projectId ?? null
    );
    const providerResult = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      attributionProjectId,
      exactCredential
    );
    if (!providerResult) {
      throw new Error(
        targetProvider
          ? `Cloud provider "${targetProvider}" not connected`
          : 'Cloud provider account not connected'
      );
    }
    throwIfProviderRequestAborted(providerContext);
    attemptedProvider = providerResult.providerName;
    assertNativePlanConcrete(providerResult.providerName, node);

    // Persist the resolved provider identity before external provisioning so
    // cleanup never has to guess which third-party API owns the VM.
    const runtimeIncarnationId = crypto.randomUUID();
    await db
      .update(schema.nodes)
      .set({
        cloudProvider: providerResult.providerName,
        credentialSource: providerResult.credentialSource,
        credentialAttributionUserId: attributionUserId,
        credentialAttributionProjectId:
          providerResult.credentialSource === 'project' ? attributionProjectId : null,
        credentialAttributionSource: providerResult.credentialSource,
        placementCredentialSource:
          providerResult.exactCredentialBinding?.credentialSource ?? node.placementCredentialSource,
        placementCredentialReference:
          providerResult.exactCredentialBinding?.credentialReference ??
          node.placementCredentialReference,
        placementCredentialVersion:
          providerResult.exactCredentialBinding?.credentialVersion ??
          node.placementCredentialVersion,
        placementCredentialFingerprint:
          providerResult.exactCredentialBinding?.credentialFingerprint ??
          node.placementCredentialFingerprint,
        runtimeIncarnationId,
        runtimeTerminationConfirmedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.nodes.id, node.id));

    const callbackToken = await signNodeCallbackToken(node.id, env);

    const isDeploymentNode = !!deploymentContext;

    const cloudInit = generateCloudInit({
      nodeId: node.id,
      hostname: `node-${node.id.toLowerCase()}`,
      controlPlaneUrl: `https://api.${env.BASE_DOMAIN}`,
      jwksUrl: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`,
      callbackToken,
      provider: providerResult.providerName,
      logJournalMaxUse: env.LOG_JOURNAL_MAX_USE,
      logJournalKeepFree: env.LOG_JOURNAL_KEEP_FREE,
      logJournalMaxRetention: env.LOG_JOURNAL_MAX_RETENTION,
      projectId: taskContext?.projectId,
      chatSessionId: taskContext?.chatSessionId,
      taskId: taskContext?.taskId,
      taskMode: taskContext?.taskMode,
      dockerDnsServers: env.DOCKER_DNS_SERVERS,
      originCaCertificateUrl: `https://api.${env.BASE_DOMAIN}/api/nodes/${node.id}/origin-ca-certificate`,
      vmAgentPort: env.VM_AGENT_PORT,
      vmAgentMemoryReserveMb: String(resolveEffectiveNodeHostMemoryReserveMb(env)),
      samInfraSliceMemoryMinMb: env.SAM_INFRA_SLICE_MEMORY_MIN_MB,
      dockerMemoryMinMb: env.DOCKER_MEMORY_MIN_MB,
      heartbeatDockerStatsTimeout: env.HEARTBEAT_DOCKER_STATS_TIMEOUT,
      heartbeatWorkspaceMetricsMaxContainers: env.HEARTBEAT_WORKSPACE_METRICS_MAX_CONTAINERS,
      heartbeatWorkspaceMetricsMaxOutputBytes: env.HEARTBEAT_WORKSPACE_METRICS_MAX_OUTPUT_BYTES,
      devcontainerCacheEnabled: env.DEVCONTAINER_CACHE_ENABLED,
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
      errorReportFlushInterval: env.ERROR_REPORT_FLUSH_INTERVAL,
      errorReportMaxBatchSize: env.ERROR_REPORT_MAX_BATCH_SIZE,
      errorReportMaxBatchBytes: env.ERROR_REPORT_MAX_BATCH_BYTES,
      errorReportMaxQueueSize: env.ERROR_REPORT_MAX_QUEUE_SIZE,
      errorReportHttpTimeout: env.ERROR_REPORT_HTTP_TIMEOUT,
      errorReportRetryInitial: env.ERROR_REPORT_RETRY_INITIAL,
      errorReportRetryMax: env.ERROR_REPORT_RETRY_MAX,
      errorReportMaxAttempts: env.ERROR_REPORT_MAX_ATTEMPTS,
      errorReportDbPath: env.ERROR_REPORT_DB_PATH,
      errorReportDbBusyTimeout: env.ERROR_REPORT_DB_BUSY_TIMEOUT,
      errorReportSpoolDir: env.ERROR_REPORT_SPOOL_DIR,
      errorReportArtifactMaxBytes: env.ERROR_REPORT_ARTIFACT_MAX_BYTES,
      errorReportSpoolMaxBytes: env.ERROR_REPORT_SPOOL_MAX_BYTES,
      errorReportRetention: env.ERROR_REPORT_RETENTION,
      errorReportCollectorTimeout: env.ERROR_REPORT_COLLECTOR_TIMEOUT,
      errorReportMaxCollectorDocs: env.ERROR_REPORT_MAX_COLLECTOR_DOCS,
      errorReportMaxDocumentBytes: env.ERROR_REPORT_MAX_DOCUMENT_BYTES,
      errorReportMaxValueDepth: env.ERROR_REPORT_MAX_VALUE_DEPTH,
      errorReportMaxValueItems: env.ERROR_REPORT_MAX_VALUE_ITEMS,
      errorReportMaxStringBytes: env.ERROR_REPORT_MAX_STRING_BYTES,
      errorReportEventLimit: env.ERROR_REPORT_EVENT_LIMIT,
      errorReportResponseMaxBytes: env.ERROR_REPORT_RESPONSE_MAX_BYTES,
      errorReportStoredErrorMaxBytes: env.ERROR_REPORT_STORED_ERROR_MAX_BYTES,
      errorReportCollectorConcurrency: env.ERROR_REPORT_COLLECTOR_CONCURRENCY,
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    const provider = providerResult.provider;

    const baseImageOverride = resolveHetznerBaseImageOverride(
      providerResult.providerName,
      env.HETZNER_BASE_IMAGE
    );

    // Last authority check before the paid provider allocation. A revocation
    // that races createVM is handled by the post-request check below, which can
    // strictly destroy the resource using the persisted provider identity.
    await assertNodeAllocationPlanCurrent(
      env,
      node.id,
      node.userId,
      taskContext?.projectId ?? null
    );
    await options?.assertExternalMutationAuthority?.();
    const vmConfig = applyNativePlanToVmConfig(
      {
        name: `node-${node.id.toLowerCase()}`,
        size: node.vmSize as 'small' | 'medium' | 'large',
        location: node.vmLocation,
        instanceType: node.providerInstanceType ?? undefined,
        userData: cloudInit,
        ...(baseImageOverride ? { image: baseImageOverride } : {}),
        labels: buildNodeProviderLabels({
          nodeId: node.id,
          isDeploymentNode,
          environmentLabel: resolveEnvironmentLabel(env),
          installationId: resolveInstallationId(env),
        }),
      },
      node
    );
    const vm = providerContext
      ? await provider.createVM(vmConfig, providerContext)
      : await provider.createVM(vmConfig);
    throwIfProviderRequestAborted(providerContext);

    // Persist the provider identity before the post-request authority check so
    // a revocation that races createVM can strictly destroy the paid resource.
    await db
      .update(schema.nodes)
      .set({
        providerInstanceId: vm.id,
        ...observedHardwareDbValues(vm),
        ipAddress: vm.ip || null,
        runtimeTerminationConfirmedAt: null,
        status: 'creating',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.nodes.id, node.id));
    try {
      await assertNodeAllocationPlanCurrent(
        env,
        node.id,
        node.userId,
        taskContext?.projectId ?? null
      );
      await options?.assertExternalMutationAuthority?.();
    } catch (authorityErr) {
      log.error('node_provisioning.authority_revoked_after_create', {
        nodeId: node.id,
        providerInstanceId: vm.id,
        ...serializeError(authorityErr),
      });
      try {
        await deleteNodeResourcesStrict(node.id, node.userId, env, {
          cleanupDns: false,
          expectedRuntime: {
            userId: node.userId,
            runtime: node.runtime,
            providerInstanceId: vm.id,
            runtimeIncarnationId,
          },
        });
      } catch (cleanupErr) {
        log.error('node_provisioning.authority_revoked_cleanup_failed', {
          nodeId: node.id,
          providerInstanceId: vm.id,
          ...serializeError(cleanupErr),
        });
      }
      throw authorityErr;
    }

    // Scaleway allocates IPs asynchronously after boot — vm.ip will be empty.
    // Store the provider instance ID and mark as pending-ip; heartbeat backfill
    // will capture the IP when the VM agent sends its first heartbeat.
    if (!vm.ip) {
      log.info('node_provisioning.awaiting_ip_backfill', {
        nodeId: node.id,
        providerInstanceId: vm.id,
      });
      await db
        .update(schema.nodes)
        .set({
          cloudProvider: providerResult.providerName,
          credentialSource: providerResult.credentialSource,
          credentialAttributionUserId: attributionUserId,
          credentialAttributionProjectId:
            providerResult.credentialSource === 'project' ? attributionProjectId : null,
          credentialAttributionSource: providerResult.credentialSource,
          providerInstanceId: vm.id,
          ...observedHardwareDbValues(vm),
          runtimeTerminationConfirmedAt: null,
          status: 'creating',
          errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.nodes.id, node.id));
      throwIfProviderRequestAborted(providerContext);
      return;
    }

    let backendDnsRecordId: string | null = null;
    let dnsErrorMessage: string | null = null;
    try {
      backendDnsRecordId = await createNodeBackendDNSRecord(node.id, vm.ip, env);
    } catch (dnsErr) {
      throwIfProviderRequestAborted(providerContext);
      log.error('node_provisioning.dns_record_failed', {
        nodeId: node.id,
        ...serializeError(dnsErr),
      });
      dnsErrorMessage = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
    }

    throwIfProviderRequestAborted(providerContext);
    await db
      .update(schema.nodes)
      .set({
        cloudProvider: providerResult.providerName,
        credentialSource: providerResult.credentialSource,
        credentialAttributionUserId: attributionUserId,
        credentialAttributionProjectId:
          providerResult.credentialSource === 'project' ? attributionProjectId : null,
        credentialAttributionSource: providerResult.credentialSource,
        providerInstanceId: vm.id,
        ...observedHardwareDbValues(vm),
        runtimeTerminationConfirmedAt: null,
        ipAddress: vm.ip,
        backendDnsRecordId,
        status: dnsErrorMessage ? 'error' : 'running',
        healthStatus: dnsErrorMessage ? 'unhealthy' : 'stale',
        errorMessage: dnsErrorMessage
          ? truncateNodeErrorMessage(`Backend DNS record creation failed: ${dnsErrorMessage}`)
          : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.nodes.id, node.id));
    throwIfProviderRequestAborted(providerContext);
  } catch (err) {
    rethrowIfProviderRequestAborted(err, providerContext);
    // Sanitize GCP errors to prevent leaking resource paths in client-visible errorMessage
    const errorMessage =
      err instanceof GcpApiError
        ? sanitizeGcpError(err, 'node-provisioning')
        : err instanceof Error
          ? err.message
          : String(err);
    const providerName = attemptedProvider ?? 'unknown';
    const statusCode = err instanceof ProviderError ? err.statusCode : undefined;

    log.error('node_provisioning.failed', {
      nodeId: node.id,
      provider: providerName,
      vmSize: node.vmSize,
      vmLocation: node.vmLocation,
      statusCode,
      error: errorMessage,
    });

    // Persist detailed error to observability database
    try {
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
          source: 'api',
          level: 'error',
          message: `Node provisioning failed: ${errorMessage}`,
          context: {
            component: 'node-provisioning',
            nodeId: node.id,
            userId: node.userId,
            provider: providerName,
            vmSize: node.vmSize,
            vmLocation: node.vmLocation,
            statusCode,
          },
          nodeId: node.id,
          userId: node.userId,
        },
        env
      );
    } catch (obsErr) {
      log.error('node_provisioning.observability_persist_failed', serializeError(obsErr));
    }

    const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);

    // Descent-loop mode: re-throw so the caller can branch on the error category.
    // On a transient_capacity failure, delete the failed node row first so failed
    // size attempts leave no orphaned `error` rows (decision #1).
    if (options?.rethrowProviderError) {
      if (isCapacityFailure) {
        await db.delete(schema.nodes).where(eq(schema.nodes.id, node.id));
      } else {
        const truncatedError = truncateNodeErrorMessage(errorMessage);
        await db
          .update(schema.nodes)
          .set({
            status: 'error',
            healthStatus: 'unhealthy',
            errorMessage: `[${providerName}] ${truncatedError}`,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.nodes.id, node.id));
      }
      throw err;
    }

    // Legacy mode: store the actual error message (truncated) in the node record.
    const truncatedError = truncateNodeErrorMessage(errorMessage);
    await db
      .update(schema.nodes)
      .set({
        status: 'error',
        healthStatus: 'unhealthy',
        errorMessage: `[${providerName}] ${truncatedError}`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.nodes.id, node.id));
  }
}

export async function stopNodeResources(nodeId: string, userId: string, env: Env): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    return;
  }

  // User-owned (BYO) machines are the user's hardware, never SAM-provisioned infrastructure. "Stop"
  // means take the node offline, NOT destroy it: never delete a cloud VM (there is none), never
  // delete the tunnel CNAME, and keep the node record so the enrolled machine can reconnect. This
  // centralized guard also protects the markIdle failure-fallback that reaches stopNodeResources.
  // See architecture-critique #2.
  if (isUserOwnedNodeClass(node.nodeClass)) {
    await db
      .update(schema.workspaces)
      .set({ status: 'deleted', updatedAt: now })
      .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));
    await finalizeWorkspaceLifecycleClosure(env, {
      nodeId,
      userId,
      agentSessionStatus: 'stopped',
      nowIso: now,
      reason: 'stop_node_resources_user_owned_offline',
    });
    await db
      .update(schema.nodes)
      .set({ status: 'stopped', healthStatus: 'unhealthy', updatedAt: now })
      .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)));
    log.info('node_stop.user_owned_offline', { nodeId, action: 'marked_offline' });
    return;
  }

  // A managed stop is terminal only after the strict provider/container boundary
  // supplies proof. Persist quarantine before I/O so timeouts, provider errors,
  // and process interruption cannot strand a workspace in an apparently terminal state.
  const nodeClaim = await db
    .update(schema.nodes)
    .set({ status: 'destroying', healthStatus: 'stale', updatedAt: now })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        sql`${schema.nodes.status} IS ${node.status}`,
        sql`${schema.nodes.runtime} IS ${node.runtime}`,
        sql`${schema.nodes.providerInstanceId} IS ${node.providerInstanceId}`,
        sql`${schema.nodes.runtimeIncarnationId} IS ${node.runtimeIncarnationId}`
      )
    )
    .run();
  if ((nodeClaim.meta.changes ?? 0) !== 1) {
    throw new Error('Managed node changed before teardown could be claimed');
  }
  await db
    .update(schema.workspaces)
    .set({ status: 'stopping', errorMessage: managedNodeStopDiagnostic(env), updatedAt: now })
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  let strictDeletion;
  try {
    strictDeletion = await deleteNodeResourcesStrict(nodeId, userId, env, {
      cleanupDns: false,
      expectedRuntime: {
        userId: node.userId,
        runtime: node.runtime,
        providerInstanceId: node.providerInstanceId,
        runtimeIncarnationId: node.runtimeIncarnationId,
      },
    });
  } catch (err) {
    log.error('node_stop.runtime_termination_unconfirmed', {
      nodeId,
      ...serializeError(err),
    });
    throw new Error('Managed node teardown remains unconfirmed');
  }
  if (!strictDeletion.runtimeTerminationConfirmedAt) {
    throw new Error('Managed node teardown returned no strict termination proof');
  }

  // Delete the DNS record since the node is being permanently stopped
  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
    } catch (err) {
      log.error('node_stop.delete_dns_failed', { nodeId, ...serializeError(err) });
    }
  }

  // The node may have been reprovisioned while the provider call was in flight.
  // Only the exact incarnation carrying strict proof may cross the terminal fence.
  const terminalNode = await db
    .update(schema.nodes)
    .set({
      status: 'deleted',
      healthStatus: 'stale',
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        eq(schema.nodes.status, 'destroying'),
        sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${strictDeletion.runtimeTerminationConfirmedAt}`,
        sql`${schema.nodes.runtimeIncarnationId} IS ${strictDeletion.runtimeIncarnationId}`
      )
    )
    .run();
  if ((terminalNode.meta.changes ?? 0) !== 1) {
    throw new Error('Managed node teardown proof no longer matches the current incarnation');
  }

  await db
    .update(schema.workspaces)
    .set({
      status: 'deleted',
      errorMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.status, 'stopping'),
        eq(
          schema.workspaces.runtimeDeletionConfirmedAt,
          strictDeletion.runtimeTerminationConfirmedAt
        )
      )
    );

  const confirmedWorkspaces = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        eq(
          schema.workspaces.runtimeDeletionConfirmedAt,
          strictDeletion.runtimeTerminationConfirmedAt
        )
      )
    );
  await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: confirmedWorkspaces.map((workspace) => workspace.id),
    userId,
    agentSessionStatus: 'stopped',
    nowIso: now,
    reason: 'stop_node_resources',
  });
}

export async function retireDeletedDeploymentNodeRecord(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  nodeId: string,
  userId: string,
  proof: { runtimeTerminationConfirmedAt: string | null; runtimeIncarnationId: string | null }
): Promise<void> {
  const now = new Date().toISOString();

  const terminalNode = await db
    .update(schema.nodes)
    .set({
      status: 'deleted',
      healthStatus: 'stale',
      providerInstanceId: null,
      backendDnsRecordId: null,
      ipAddress: null,
      errorMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId),
        eq(schema.nodes.nodeRole, 'deployment'),
        proof.runtimeTerminationConfirmedAt
          ? and(
              sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${proof.runtimeTerminationConfirmedAt}`,
              sql`${schema.nodes.runtimeIncarnationId} IS ${proof.runtimeIncarnationId}`
            )
          : eq(schema.nodes.nodeClass, 'user-owned')
      )
    )
    .run();
  if ((terminalNode.meta.changes ?? 0) !== 1) {
    throw new Error('Deployment node terminal proof no longer matches the current incarnation');
  }

  await db
    .update(schema.deploymentEnvironments)
    .set({
      nodeId: null,
      status: 'stopped',
      observedStatus: 'stopped',
      observedErrorMessage: null,
      observedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.deploymentEnvironments.nodeId, nodeId));

  await db
    .update(schema.workspaces)
    .set({ status: 'deleted', updatedAt: now })
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        proof.runtimeTerminationConfirmedAt
          ? eq(schema.workspaces.runtimeDeletionConfirmedAt, proof.runtimeTerminationConfirmedAt)
          : undefined
      )
    );

  await finalizeWorkspaceLifecycleClosure(env, {
    nodeId,
    userId,
    agentSessionStatus: 'completed',
    nowIso: now,
    reason: 'retire_deleted_deployment_node_record',
  });
}

function truncateNodeErrorMessage(message: string): string {
  return message.length > NODE_ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, NODE_ERROR_MESSAGE_MAX_LENGTH) + '...'
    : message;
}

export type { DeleteNodeResourcesResult } from './node-resource-deletion';
export { deleteNodeResources } from './node-resource-deletion';
export type { StrictNodeDeletionResult } from './strict-node-deletion';
export { deleteNodeResourcesStrict } from './strict-node-deletion';
