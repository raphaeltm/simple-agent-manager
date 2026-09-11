import { generateCloudInit, validateCloudInitSize } from '@simple-agent-manager/cloud-init';
import {
  isTransientCapacityError,
  type Provider,
  ProviderError,
  type ProviderRequestContext,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from '@simple-agent-manager/providers';
import { type CredentialProvider, type TaskMode } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { createNodeBackendDNSRecord, deleteDNSRecord } from './dns';
import { GcpApiError, sanitizeGcpError } from './gcp-errors';
import { signNodeCallbackToken } from './jwt';
import { type DurableNodeAllocation,NodeAllocationUncertainError, recoverNodeAllocation } from './node-allocation-recovery';
import {
  assertNodeAllocationPlanCurrent,
  type NodeAllocationPlanRole,
} from './node-allocation-validation';
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
import { resolveEffectiveNodeHostMemoryReserveMb } from './workspace-resource-capacity';

const NODE_ERROR_MESSAGE_MAX_LENGTH = 500;

type ProvisionNodeRow = typeof schema.nodes.$inferSelect;

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
  projectId?: string | null;
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
  /** Durable direct allocation owner: retries reconcile this nonce, never repeat an uncertain POST. */
  durableAllocation?: DurableNodeAllocation;
  /** Explicit lifecycle cancellation for provider work; detached HTTP callers omit this. */
  signal?: AbortSignal;
  /** Fail-closed recovery-authority check at the provider allocation boundary. */
  assertExternalMutationAuthority?: () => Promise<void>;
  /** Project context used for placement-authority checks when no taskContext exists. */
  authorityProjectId?: string | null;
}

function provisionAuthorityProjectId(
  taskContext: ProvisionTaskContext | undefined,
  options: ProvisionNodeOptions | undefined,
  deploymentContext: DeploymentProvisionContext | undefined
): string | null {
  return (
    taskContext?.projectId ?? options?.authorityProjectId ?? deploymentContext?.projectId ?? null
  );
}

function creatingProvisioningPredicate(
  node: ProvisionNodeRow,
  runtimeIncarnationId: string | null,
  providerInstanceId: string | null = node.providerInstanceId
) {
  return and(
    eq(schema.nodes.id, node.id),
    eq(schema.nodes.userId, node.userId),
    eq(schema.nodes.status, 'creating'),
    eq(schema.nodes.runtime, 'vm'),
    eq(schema.nodes.nodeClass, 'managed'),
    sql`${schema.nodes.providerInstanceId} IS ${providerInstanceId}`,
    sql`${schema.nodes.runtimeIncarnationId} IS ${runtimeIncarnationId}`
  );
}

function providerIdentityRecordPredicate(
  node: ProvisionNodeRow,
  runtimeIncarnationId: string | null
) {
  return and(
    eq(schema.nodes.id, node.id),
    eq(schema.nodes.userId, node.userId),
    eq(schema.nodes.runtime, 'vm'),
    eq(schema.nodes.nodeClass, 'managed'),
    sql`${schema.nodes.runtimeIncarnationId} IS ${runtimeIncarnationId}`,
    sql`${schema.nodes.status} NOT IN ('deleted', 'stopped')`
  );
}

function d1WriteChanged(result: { meta?: { changes?: number | null } } | undefined): boolean {
  return (result?.meta?.changes ?? 0) === 1;
}

async function deleteCreatedProviderVmDirectly(input: {
  provider: Pick<Provider, 'deleteVM'>;
  providerInstanceId: string;
  nodeId: string;
  providerContext?: ProviderRequestContext;
}): Promise<void> {
  try {
    if (input.providerContext) await input.provider.deleteVM(input.providerInstanceId, input.providerContext);
    else await input.provider.deleteVM(input.providerInstanceId);
  } catch (err) {
    log.error('node_provisioning.created_vm_direct_cleanup_failed', {
      nodeId: input.nodeId,
      providerInstanceId: input.providerInstanceId,
      ...serializeError(err),
    });
  }
}

async function cleanupCreatedVmAfterProvisioningRace(input: {
  node: ProvisionNodeRow;
  env: Env;
  provider: Pick<Provider, 'deleteVM'>;
  providerInstanceId: string;
  runtimeIncarnationId: string | null;
  backendDnsRecordId?: string | null;
  providerContext?: ProviderRequestContext;
}): Promise<void> {
  if (input.backendDnsRecordId) {
    try {
      await deleteDNSRecord(input.backendDnsRecordId, input.env, input.providerContext?.signal);
    } catch (dnsErr) {
      log.error('node_provisioning.created_vm_dns_cleanup_failed', {
        nodeId: input.node.id,
        backendDnsRecordId: input.backendDnsRecordId,
        ...serializeError(dnsErr),
      });
    }
  }

  try {
    await deleteNodeResourcesStrict(input.node.id, input.node.userId, input.env, {
      cleanupDns: false,
      providerRequestContext: input.providerContext,
      expectedRuntime: {
        userId: input.node.userId,
        runtime: input.node.runtime,
        providerInstanceId: input.providerInstanceId,
        runtimeIncarnationId: input.runtimeIncarnationId,
      },
    });
    return;
  } catch (strictErr) {
    log.error('node_provisioning.created_vm_strict_cleanup_failed', {
      nodeId: input.node.id,
      providerInstanceId: input.providerInstanceId,
      ...serializeError(strictErr),
    });
  }

  await deleteCreatedProviderVmDirectly({
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    nodeId: input.node.id,
    providerContext: input.providerContext,
  });
}

export async function provisionNode(
  nodeId: string,
  env: Env,
  taskContext?: ProvisionTaskContext,
  options?: ProvisionNodeOptions,
  deploymentContext?: DeploymentProvisionContext
): Promise<{ allocationConfirmed: true } | void> {
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
  let provisioningRuntimeIncarnationId = node.runtimeIncarnationId;
  let providerAllocationRejected = false;
  const attributionUserId = node.credentialAttributionUserId ?? node.userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? taskContext?.projectId ?? null)
      : null;
  const exactCredential = exactProviderCredentialBindingFromPlacementSnapshot(node);
  const authorityProjectId = provisionAuthorityProjectId(taskContext, options, deploymentContext);
  // Caller intent, not the node row: a deployment provision supplies a deployment
  // context, everything else is placing a workspace node.
  const authorityRole: NodeAllocationPlanRole = deploymentContext
    ? { nodeRole: 'deployment', workloadRole: 'deployment' }
    : { nodeRole: 'workspace', workloadRole: 'workspace' };

  const durable = options?.durableAllocation;
  const resuming = !!durable && node.runtimeIncarnationId === durable.incarnationId
    && node.runtimeTerminationConfirmedAt === null;
  if (durable && !resuming && (node.runtimeIncarnationId !== durable.initialIncarnationId
    || node.runtimeTerminationConfirmedAt === null)) {
    throw new NodeAllocationUncertainError('Node incarnation changed before durable allocation');
  }

  try {
    if (!resuming) await assertNodeAllocationPlanCurrent(
      env,
      node.id,
      node.userId,
      authorityProjectId,
      authorityRole
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
    provisioningRuntimeIncarnationId = durable?.incarnationId ?? crypto.randomUUID();
    if (!resuming) {
      const providerIdentityClaim = await db
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
          runtimeIncarnationId: provisioningRuntimeIncarnationId,
          runtimeTerminationConfirmedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(creatingProvisioningPredicate(node, node.runtimeIncarnationId))
        .run();
      if (!d1WriteChanged(providerIdentityClaim)) {
        throw new Error('Node lifecycle changed before provider allocation could be claimed');
      }
    }

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
      vmAgentRequiredVersion: env.VM_AGENT_REQUIRED_VERSION?.trim(),
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
    if (!resuming) {
      await assertNodeAllocationPlanCurrent(env, node.id, node.userId, authorityProjectId, authorityRole);
      await options?.assertExternalMutationAuthority?.();
    }
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
          runtimeIncarnationId: provisioningRuntimeIncarnationId ?? undefined,
        }),
      },
      node
    );
    const vm = await (resuming && durable
      ? recoverNodeAllocation(provider, node, env, durable, providerContext)
      : providerContext
      ? provider.createVM(vmConfig, providerContext)
      : provider.createVM(vmConfig)).catch((err: unknown) => {
      if (err instanceof NodeAllocationUncertainError) throw err;
      // Hetzner's placement/capacity retries only repeat rejected creates. A
      // transport failure has no HTTP status and cannot prove absence. Keep
      // this at the create boundary: later failures and multi-step providers
      // can occur after allocation even when no VM identity reached the caller.
      providerAllocationRejected =
        providerResult.providerName === 'hetzner' &&
        err instanceof ProviderError &&
        err.providerName === 'hetzner' &&
        err.statusCode !== undefined &&
        (err.statusCode === 412 || isTransientCapacityError(err));
      if (durable && !providerAllocationRejected) {
        throw new NodeAllocationUncertainError();
      }
      throw err;
    });
    throwIfProviderRequestAborted(providerContext);

    // Persist the provider identity before the post-request authority check so
    // a revocation that races createVM can strictly destroy the paid resource.
    const providerIdentityRecord = await db
      .update(schema.nodes)
      .set({
        providerInstanceId: vm.id,
        ...(durable ? { status: sql`CASE WHEN ${schema.nodes.status} IN ('creating','running','recovery','error') THEN 'creating' ELSE ${schema.nodes.status} END` } : {}),
        ...observedHardwareDbValues(vm),
        ipAddress: vm.ip || null,
        runtimeTerminationConfirmedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(providerIdentityRecordPredicate(node, provisioningRuntimeIncarnationId))
      .run();
    if (!d1WriteChanged(providerIdentityRecord)) {
      await cleanupCreatedVmAfterProvisioningRace({
        node,
        env,
        provider,
        providerInstanceId: vm.id,
        runtimeIncarnationId: provisioningRuntimeIncarnationId,
        providerContext,
      });
      throw new Error('Node lifecycle changed before provider identity could be recorded');
    }
    try {
      if (['destroying', 'deleted', 'stopped'].includes(node.status)) throw new Error('Node allocation was cancelled');
      await assertNodeAllocationPlanCurrent(
        env,
        node.id,
        node.userId,
        authorityProjectId,
        authorityRole
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
          providerRequestContext: providerContext,
          expectedRuntime: {
            userId: node.userId,
            runtime: node.runtime,
            providerInstanceId: vm.id,
            runtimeIncarnationId: provisioningRuntimeIncarnationId,
          },
        });
      } catch (cleanupErr) {
        log.error('node_provisioning.authority_revoked_cleanup_failed', {
          nodeId: node.id,
          providerInstanceId: vm.id,
          ...serializeError(cleanupErr),
        });
        await deleteCreatedProviderVmDirectly({
          provider,
          providerInstanceId: vm.id,
          nodeId: node.id,
          providerContext,
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
      const awaitingIpUpdate = await db
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
        .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId, vm.id))
        .run();
      if (!d1WriteChanged(awaitingIpUpdate)) {
        await cleanupCreatedVmAfterProvisioningRace({
          node,
          env,
          provider,
          providerInstanceId: vm.id,
          runtimeIncarnationId: provisioningRuntimeIncarnationId,
          providerContext,
        });
        throw new Error('Node lifecycle changed before pending-IP state could be published');
      }
      throwIfProviderRequestAborted(providerContext);
      return { allocationConfirmed: true };
    }

    let backendDnsRecordId: string | null = null;
    let dnsErrorMessage: string | null = null;
    try {
      backendDnsRecordId = durable
        ? await createNodeBackendDNSRecord(node.id, vm.ip, env, providerContext?.signal, true)
        : await createNodeBackendDNSRecord(node.id, vm.ip, env);
    } catch (dnsErr) {
      throwIfProviderRequestAborted(providerContext);
      log.error('node_provisioning.dns_record_failed', {
        nodeId: node.id,
        ...serializeError(dnsErr),
      });
      dnsErrorMessage = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
    }

    throwIfProviderRequestAborted(providerContext);
    const finalUpdate = await db
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
      .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId, vm.id))
      .run();
    if (!d1WriteChanged(finalUpdate)) {
      await cleanupCreatedVmAfterProvisioningRace({
        node,
        env,
        provider,
        providerInstanceId: vm.id,
        runtimeIncarnationId: provisioningRuntimeIncarnationId,
        backendDnsRecordId,
        providerContext,
      });
      throw new Error('Node lifecycle changed before running state could be published');
    }
    throwIfProviderRequestAborted(providerContext);
    return { allocationConfirmed: true };
  } catch (err) {
    if (err instanceof NodeAllocationUncertainError) throw err;
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
        await db
          .delete(schema.nodes)
          .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId))
          .run();
      } else {
        const truncatedError = truncateNodeErrorMessage(errorMessage);
        await db
          .update(schema.nodes)
          .set({
            status: 'error',
            healthStatus: 'unhealthy',
            errorMessage: `[${providerName}] ${truncatedError}`,
            ...(providerAllocationRejected
              ? { runtimeTerminationConfirmedAt: new Date().toISOString() }
              : {}),
            updatedAt: new Date().toISOString(),
          })
          .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId))
          .run();
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
        ...(providerAllocationRejected
          ? { runtimeTerminationConfirmedAt: new Date().toISOString() }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId))
      .run();
  }
}

function truncateNodeErrorMessage(message: string): string {
  return message.length > NODE_ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, NODE_ERROR_MESSAGE_MAX_LENGTH) + '...'
    : message;
}
