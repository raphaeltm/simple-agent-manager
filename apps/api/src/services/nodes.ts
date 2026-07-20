import { generateCloudInit, validateCloudInitSize } from '@simple-agent-manager/cloud-init';
import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import {
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
  type CredentialSource,
  type TaskMode,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { createNodeBackendDNSRecord, deleteDNSRecord } from './dns';
import { GcpApiError, sanitizeGcpError } from './gcp-errors';
import { signNodeCallbackToken } from './jwt';
import { persistError } from './observability';
import { createProviderForUser } from './provider-credentials';
import { destroyVmAgentContainer } from './vm-agent-container';

const NODE_ERROR_MESSAGE_MAX_LENGTH = 500;

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
  /** 'workspace' (default) or 'deployment'. */
  nodeRole?: 'workspace' | 'deployment';
  /** 'shared' (default) or 'exclusive'. Exclusive deployment nodes accept one environment. */
  nodeMode?: 'shared' | 'exclusive';
  /** Runtime substrate. Defaults to traditional VM. */
  runtime?: 'vm' | 'cf-container';
}

export interface ProvisionedNode {
  id: string;
  userId: string;
  name: string;
  status: string;
  vmSize: string;
  vmLocation: string;
  cloudProvider: string | null;
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
}

export async function provisionNode(
  nodeId: string,
  env: Env,
  taskContext?: ProvisionTaskContext,
  options?: ProvisionNodeOptions,
  deploymentContext?: DeploymentProvisionContext
): Promise<void> {
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

  try {
    const providerResult = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      attributionProjectId
    );
    if (!providerResult) {
      throw new Error(
        targetProvider
          ? `Cloud provider "${targetProvider}" not connected`
          : 'Cloud provider account not connected'
      );
    }
    attemptedProvider = providerResult.providerName;

    // Persist the resolved provider identity before external provisioning so
    // cleanup never has to guess which third-party API owns the VM.
    await db
      .update(schema.nodes)
      .set({
        cloudProvider: providerResult.providerName,
        credentialSource: providerResult.credentialSource,
        credentialAttributionUserId: attributionUserId,
        credentialAttributionProjectId:
          providerResult.credentialSource === 'project' ? attributionProjectId : null,
        credentialAttributionSource: providerResult.credentialSource,
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
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    const provider = providerResult.provider;

    const baseImageOverride = resolveHetznerBaseImageOverride(
      providerResult.providerName,
      env.HETZNER_BASE_IMAGE
    );

    const vm = await provider.createVM({
      name: `node-${node.id.toLowerCase()}`,
      size: node.vmSize as 'small' | 'medium' | 'large',
      location: node.vmLocation,
      userData: cloudInit,
      ...(baseImageOverride ? { image: baseImageOverride } : {}),
      labels: {
        node: node.id.toLowerCase(),
        managed: 'simple-agent-manager',
        role: isDeploymentNode ? 'deployment' : 'workspace',
      },
    });

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
          status: 'creating',
          errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.nodes.id, node.id));
      return;
    }

    let backendDnsRecordId: string | null = null;
    let dnsErrorMessage: string | null = null;
    try {
      backendDnsRecordId = await createNodeBackendDNSRecord(node.id, vm.ip, env);
    } catch (dnsErr) {
      log.error('node_provisioning.dns_record_failed', {
        nodeId: node.id,
        ...serializeError(dnsErr),
      });
      dnsErrorMessage = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
    }

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
  } catch (err) {
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
      await persistError(env.OBSERVABILITY_DATABASE, {
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
      });
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

  if (node.runtime === 'cf-container') {
    await destroyVmAgentContainer(env, node.id).catch((err) => {
      log.error('node_stop.cf_container_destroy_failed', { nodeId, ...serializeError(err) });
      throw err;
    });
  }

  // Delete the cloud provider server since stopped nodes cannot be restarted
  if (node.providerInstanceId) {
    const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
    const attributionUserId = node.credentialAttributionUserId ?? userId;
    const attributionProjectId =
      node.credentialAttributionSource === 'project'
        ? (node.credentialAttributionProjectId ?? null)
        : null;
    const providerResult = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      attributionProjectId
    );
    if (providerResult) {
      try {
        await providerResult.provider.deleteVM(node.providerInstanceId);
      } catch (err) {
        log.error('node_stop.delete_vm_failed', { nodeId, ...serializeError(err) });
      }
    }
  }

  // Delete the DNS record since the node is being permanently stopped
  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
    } catch (err) {
      log.error('node_stop.delete_dns_failed', { nodeId, ...serializeError(err) });
    }
  }

  // Mark node and workspaces as deleted since stopped nodes are non-recoverable
  await db
    .update(schema.workspaces)
    .set({
      status: 'deleted',
      updatedAt: now,
    })
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  await db
    .update(schema.nodes)
    .set({
      status: 'deleted',
      healthStatus: 'stale',
      updatedAt: now,
    })
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)));
}

export interface DeleteNodeResourcesResult {
  nodeFound: boolean;
  providerVmDeleted: boolean;
  providerVmDeleteSkippedReason: string | null;
  backendDnsDeleted: boolean;
  errors: string[];
}

export async function deleteNodeResources(
  nodeId: string,
  userId: string,
  env: Env
): Promise<DeleteNodeResourcesResult> {
  const db = drizzle(env.DATABASE, { schema });
  const result: DeleteNodeResourcesResult = {
    nodeFound: false,
    providerVmDeleted: false,
    providerVmDeleteSkippedReason: null,
    backendDnsDeleted: false,
    errors: [],
  };

  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    return result;
  }
  result.nodeFound = true;

  if (node.providerInstanceId) {
    const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
    const attributionUserId = node.credentialAttributionUserId ?? userId;
    const attributionProjectId =
      node.credentialAttributionSource === 'project'
        ? (node.credentialAttributionProjectId ?? null)
        : null;
    const providerResult2 = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      attributionProjectId
    );
    if (providerResult2) {
      try {
        await providerResult2.provider.deleteVM(node.providerInstanceId);
        result.providerVmDeleted = true;
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        log.error('node_delete.delete_vm_failed', { nodeId, ...serializeError(err) });
      }
    } else {
      result.providerVmDeleteSkippedReason = 'cloud provider credential unavailable';
      result.errors.push('Cloud provider credential unavailable; provider VM may still exist.');
      log.error('node_cleanup.credential_missing_vm_orphaned', {
        nodeId,
        userId,
        providerInstanceId: node.providerInstanceId,
        cloudProvider: node.cloudProvider,
      });
    }
  }

  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
      result.backendDnsDeleted = true;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      log.error('node_delete.delete_dns_failed', { nodeId, ...serializeError(err) });
    }
  }

  // Cascade workspace status: mark all workspaces on this node as deleted
  const now = new Date().toISOString();
  await db
    .update(schema.workspaces)
    .set({ status: 'deleted', updatedAt: now })
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  return result;
}

export async function retireDeletedDeploymentNodeRecord(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeId: string,
  userId: string
): Promise<void> {
  const now = new Date().toISOString();

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
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  await db
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
        eq(schema.nodes.nodeRole, 'deployment')
      )
    );
}

function truncateNodeErrorMessage(message: string): string {
  return message.length > NODE_ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, NODE_ERROR_MESSAGE_MAX_LENGTH) + '...'
    : message;
}

type NodeDb = ReturnType<typeof drizzle<typeof schema>>;
type NodeRow = typeof schema.nodes.$inferSelect;
type ProviderForUserResult = NonNullable<Awaited<ReturnType<typeof createProviderForUser>>>;

async function requireStrictNode(db: NodeDb, nodeId: string, userId: string): Promise<NodeRow> {
  const rows = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = rows[0];
  if (!node) {
    throw new Error(`Node ${nodeId} not found for strict deletion`);
  }
  return node;
}

function getStrictNodeCredentialContext(node: NodeRow, userId: string) {
  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  const attributionUserId = node.credentialAttributionUserId ?? userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? null)
      : null;
  return { targetProvider, attributionUserId, attributionProjectId };
}

async function requireStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<ProviderForUserResult> {
  const { targetProvider, attributionUserId, attributionProjectId } =
    getStrictNodeCredentialContext(node, userId);
  const providerResult = await createProviderForUser(
    db,
    attributionUserId,
    getCredentialEncryptionKey(env),
    env,
    targetProvider,
    attributionProjectId
  );
  if (!providerResult) {
    throw new Error(
      `Cloud provider credentials missing for strict node deletion: node=${node.id} provider=${node.cloudProvider ?? 'unknown'} instance=${node.providerInstanceId}`
    );
  }
  return providerResult;
}

type StrictProviderResolution =
  | { state: 'present'; providerResult: ProviderForUserResult }
  | { state: 'absent'; providersChecked: CredentialProvider[] };

async function resolveStrictNodeProvider(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<StrictProviderResolution> {
  const providerInstanceId = node.providerInstanceId;
  if (!providerInstanceId) {
    throw new Error(`Cannot strictly resolve provider for node ${node.id}: instance ID is missing`);
  }
  const { targetProvider, attributionUserId, attributionProjectId } =
    getStrictNodeCredentialContext(node, userId);

  if (targetProvider) {
    const providerResult = await requireStrictNodeProvider(db, node, userId, env);
    if (providerResult.providerName !== targetProvider) {
      throw new Error(
        `Cannot strictly delete node ${node.id}: requested provider ${targetProvider} resolved as ${providerResult.providerName}`
      );
    }
    return { state: 'present', providerResult };
  }

  const candidates: ProviderForUserResult[] = [];
  for (const providerName of CREDENTIAL_PROVIDERS) {
    const providerResult = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      providerName,
      attributionProjectId
    );
    if (!providerResult) continue;
    if (providerResult.providerName !== providerName) {
      throw new Error(
        `Cannot strictly delete node ${node.id}: requested provider ${providerName} resolved as ${providerResult.providerName}`
      );
    }
    candidates.push(providerResult);
  }

  if (candidates.length === 0) {
    throw new Error(
      `Cloud provider credentials missing for strict node deletion: node=${node.id} provider=unknown instance=${node.providerInstanceId}`
    );
  }

  const presentCandidates: ProviderForUserResult[] = [];
  for (const candidate of candidates) {
    const vm = await candidate.provider.getVM(providerInstanceId);
    if (vm === null) continue;
    if (!vm || typeof vm !== 'object') {
      throw new Error(
        `Cannot strictly delete node ${node.id}: ambiguous ${candidate.providerName} lookup result`
      );
    }
    presentCandidates.push(candidate);
  }

  if (presentCandidates.length > 1) {
    throw new Error(
      `Cannot strictly delete node ${node.id}: instance ${node.providerInstanceId} matched multiple providers`
    );
  }

  const providerResult = presentCandidates[0];
  return providerResult
    ? { state: 'present', providerResult }
    : { state: 'absent', providersChecked: candidates.map((candidate) => candidate.providerName) };
}

export type StrictNodeDeletionResult = { providerVm: 'no-instance' | 'deleted' | 'already-absent' };

async function deleteStrictProviderInstance(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<StrictNodeDeletionResult['providerVm']> {
  if (!node.providerInstanceId) return 'no-instance';

  const credentialContext = getStrictNodeCredentialContext(node, userId);
  const providerResolution = await resolveStrictNodeProvider(db, node, userId, env);

  if (providerResolution.state === 'absent') {
    log.warn('node_delete.strict_provider_vm_already_absent', {
      nodeId: node.id,
      providersChecked: providerResolution.providersChecked,
      providerInstanceId: node.providerInstanceId,
    });
    return 'already-absent';
  }

  const { providerResult } = providerResolution;

  await db
    .update(schema.nodes)
    .set({
      cloudProvider: providerResult.providerName,
      credentialSource: providerResult.credentialSource,
      credentialAttributionUserId: credentialContext.attributionUserId,
      credentialAttributionProjectId:
        providerResult.credentialSource === 'project'
          ? credentialContext.attributionProjectId
          : null,
      credentialAttributionSource: providerResult.credentialSource,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.nodes.id, node.id));

  await providerResult.provider.deleteVM(node.providerInstanceId);
  return 'deleted';
}

async function persistStrictDnsCleanupError(
  env: Env,
  input: {
    nodeId: string;
    userId: string;
    backendDnsRecordId: string;
    err: unknown;
  }
): Promise<void> {
  await persistError(env.OBSERVABILITY_DATABASE, {
    source: 'api',
    level: 'error',
    message: `Strict node DNS cleanup failed: ${input.err instanceof Error ? input.err.message : String(input.err)}`,
    stack: input.err instanceof Error ? input.err.stack : undefined,
    context: {
      component: 'node-deletion',
      recoveryType: 'strict_node_dns_cleanup_failure',
      nodeId: input.nodeId,
      backendDnsRecordId: input.backendDnsRecordId,
    },
    nodeId: input.nodeId,
    userId: input.userId,
  });
}

async function deleteStrictNodeDnsRecord(node: NodeRow, userId: string, env: Env): Promise<void> {
  if (!node.backendDnsRecordId) return;

  try {
    await deleteDNSRecord(node.backendDnsRecordId, env);
  } catch (err) {
    log.error('node_delete.strict_dns_cleanup_failed', { nodeId: node.id, ...serializeError(err) });
    try {
      await persistStrictDnsCleanupError(env, {
        nodeId: node.id,
        userId,
        backendDnsRecordId: node.backendDnsRecordId,
        err,
      });
    } catch (obsErr) {
      log.error('node_delete.strict_dns_observability_failed', {
        nodeId: node.id,
        ...serializeError(obsErr),
      });
    }
  }
}

/**
 * Strict node teardown for cleanup paths where hiding a failed cloud delete is
 * worse than surfacing a stale D1 row. Unlike deleteNodeResources(), this does
 * not cascade workspace status; callers must update workspace rows only after
 * external resources have actually been removed.
 */
export async function deleteNodeResourcesStrict(
  nodeId: string,
  userId: string,
  env: Env
): Promise<StrictNodeDeletionResult> {
  const db = drizzle(env.DATABASE, { schema });
  const node = await requireStrictNode(db, nodeId, userId);

  const providerVm = await deleteStrictProviderInstance(db, node, userId, env);
  await deleteStrictNodeDnsRecord(node, userId, env);
  return { providerVm };
}
