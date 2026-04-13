import { generateCloudInit, validateCloudInitSize } from '@simple-agent-manager/cloud-init';
import { ProviderError } from '@simple-agent-manager/providers';
import type { CredentialProvider, TaskMode } from '@simple-agent-manager/shared';
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

export interface CreateNodeInput {
  userId: string;
  name: string;
  vmSize: string;
  vmLocation: string;
  heartbeatStaleAfterSeconds: number;
  cloudProvider?: string;
}

export interface ProvisionedNode {
  id: string;
  userId: string;
  name: string;
  status: string;
  vmSize: string;
  vmLocation: string;
  cloudProvider: string | null;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  healthStatus: string;
  heartbeatStaleAfterSeconds: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createNodeRecord(env: Env, input: CreateNodeInput): Promise<ProvisionedNode> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  const nodeId = ulid();

  await db.insert(schema.nodes).values({
    id: nodeId,
    userId: input.userId,
    name: input.name,
    status: 'creating',
    vmSize: input.vmSize,
    vmLocation: input.vmLocation,
    cloudProvider: input.cloudProvider ?? null,
    healthStatus: 'stale',
    heartbeatStaleAfterSeconds: input.heartbeatStaleAfterSeconds,
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

export async function provisionNode(
  nodeId: string,
  env: Env,
  taskContext?: ProvisionTaskContext,
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });

  const nodes = await db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  const node = nodes[0];
  if (!node) {
    return;
  }

  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;

  try {
    const providerResult = await createProviderForUser(db, node.userId, getCredentialEncryptionKey(env), env, targetProvider);
    if (!providerResult) {
      throw new Error(
        targetProvider
          ? `Cloud provider "${targetProvider}" not connected`
          : 'Cloud provider account not connected',
      );
    }

    // Track credential source on the node record
    if (providerResult.credentialSource === 'platform') {
      await db
        .update(schema.nodes)
        .set({ credentialSource: 'platform' })
        .where(eq(schema.nodes.id, node.id));
    }

    const callbackToken = await signNodeCallbackToken(node.id, env);

    const cloudInit = generateCloudInit({
      nodeId: node.id,
      hostname: `node-${node.id.toLowerCase()}`,
      controlPlaneUrl: `https://api.${env.BASE_DOMAIN}`,
      jwksUrl: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`,
      callbackToken,
      logJournalMaxUse: env.LOG_JOURNAL_MAX_USE,
      logJournalKeepFree: env.LOG_JOURNAL_KEEP_FREE,
      logJournalMaxRetention: env.LOG_JOURNAL_MAX_RETENTION,
      projectId: taskContext?.projectId,
      chatSessionId: taskContext?.chatSessionId,
      taskId: taskContext?.taskId,
      taskMode: taskContext?.taskMode,
      dockerDnsServers: env.DOCKER_DNS_SERVERS,
      originCaCert: env.ORIGIN_CA_CERT,
      originCaKey: env.ORIGIN_CA_KEY,
      vmAgentPort: env.VM_AGENT_PORT,
      nekoImage: env.NEKO_IMAGE,
      nekoPrePull: env.NEKO_PRE_PULL !== 'false',
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    const provider = providerResult.provider;

    const vm = await provider.createVM({
      name: `node-${node.id.toLowerCase()}`,
      size: node.vmSize as 'small' | 'medium' | 'large',
      location: node.vmLocation,
      userData: cloudInit,
      labels: {
        node: node.id.toLowerCase(),
        managed: 'simple-agent-manager',
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
          providerInstanceId: vm.id,
          status: 'creating',
          errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.nodes.id, node.id));
      return;
    }

    let backendDnsRecordId: string | null = null;
    try {
      backendDnsRecordId = await createNodeBackendDNSRecord(node.id, vm.ip, env);
    } catch (dnsErr) {
      log.error('node_provisioning.dns_record_failed', { nodeId: node.id, ...serializeError(dnsErr) });
    }

    await db
      .update(schema.nodes)
      .set({
        providerInstanceId: vm.id,
        ipAddress: vm.ip,
        backendDnsRecordId,
        status: 'running',
        healthStatus: 'stale',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.nodes.id, node.id));
  } catch (err) {
    // Sanitize GCP errors to prevent leaking resource paths in client-visible errorMessage
    const errorMessage = err instanceof GcpApiError
      ? sanitizeGcpError(err, 'node-provisioning')
      : (err instanceof Error ? err.message : String(err));
    const providerName = targetProvider ?? 'unknown';
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

    // Store the actual error message (truncated) in the node record
    const truncatedError = errorMessage.length > 500 ? errorMessage.slice(0, 500) + '...' : errorMessage;
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
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId)
      )
    )
    .limit(1);

  const node = rows[0];
  if (!node) {
    return;
  }

  // Delete the cloud provider server since stopped nodes cannot be restarted
  if (node.providerInstanceId) {
    const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
    const providerResult = await createProviderForUser(db, userId, getCredentialEncryptionKey(env), env, targetProvider);
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
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId)
      )
    );

  await db
    .update(schema.nodes)
    .set({
      status: 'deleted',
      healthStatus: 'stale',
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId)
      )
    );
}

export async function deleteNodeResources(nodeId: string, userId: string, env: Env): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });

  const rows = await db
    .select()
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId)
      )
    )
    .limit(1);

  const node = rows[0];
  if (!node) {
    return;
  }

  if (node.providerInstanceId) {
    const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
    const providerResult2 = await createProviderForUser(db, userId, getCredentialEncryptionKey(env), env, targetProvider);
    if (providerResult2) {
      try {
        await providerResult2.provider.deleteVM(node.providerInstanceId);
      } catch (err) {
        log.error('node_delete.delete_vm_failed', { nodeId, ...serializeError(err) });
      }
    } else {
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
    } catch (err) {
      log.error('node_delete.delete_dns_failed', { nodeId, ...serializeError(err) });
    }
  }

  // Cascade workspace status: mark all workspaces on this node as deleted
  const now = new Date().toISOString();
  await db
    .update(schema.workspaces)
    .set({ status: 'deleted', updatedAt: now })
    .where(and(
      eq(schema.workspaces.nodeId, nodeId),
      eq(schema.workspaces.userId, userId)
    ));
}
