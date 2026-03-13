import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { generateCloudInit, validateCloudInitSize } from '@workspace/cloud-init';
import { ulid } from '../lib/ulid';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { createNodeBackendDNSRecord, deleteDNSRecord } from './dns';
import { createProvider } from '@simple-agent-manager/providers';
import { signCallbackToken } from './jwt';
import { getUserCloudProviderConfig } from './provider-credentials';

export interface CreateNodeInput {
  userId: string;
  name: string;
  vmSize: string;
  vmLocation: string;
  heartbeatStaleAfterSeconds: number;
}

export interface ProvisionedNode {
  id: string;
  userId: string;
  name: string;
  status: string;
  vmSize: string;
  vmLocation: string;
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

  try {
    const credResult = await getUserCloudProviderConfig(db, node.userId, env.ENCRYPTION_KEY);
    if (!credResult) {
      throw new Error('Cloud provider account not connected');
    }

    const callbackToken = await signCallbackToken(node.id, env);

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
      dockerDnsServers: env.DOCKER_DNS_SERVERS,
      originCaCert: env.ORIGIN_CA_CERT,
      originCaKey: env.ORIGIN_CA_KEY,
      vmAgentPort: env.VM_AGENT_PORT,
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    const provider = createProvider(credResult.config);

    const vm = await provider.createVM({
      name: `node-${node.id.toLowerCase()}`,
      size: node.vmSize as 'small' | 'medium' | 'large',
      location: node.vmLocation,
      userData: cloudInit,
      labels: {
        node: node.id,
        managed: 'simple-agent-manager',
      },
    });

    let backendDnsRecordId: string | null = null;
    try {
      backendDnsRecordId = await createNodeBackendDNSRecord(node.id, vm.ip, env);
    } catch (dnsErr) {
      console.error('Failed to create node backend DNS record:', dnsErr);
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
    await db
      .update(schema.nodes)
      .set({
        status: 'error',
        healthStatus: 'unhealthy',
        errorMessage: err instanceof Error ? err.message : 'Node provisioning failed',
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
    const credResult = await getUserCloudProviderConfig(db, userId, env.ENCRYPTION_KEY);
    if (credResult) {
      try {
        const provider = createProvider(credResult.config);
        await provider.deleteVM(node.providerInstanceId);
      } catch (err) {
        console.error('Failed to delete node server:', err);
      }
    }
  }

  // Delete the DNS record since the node is being permanently stopped
  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
    } catch (err) {
      console.error('Failed to delete node backend DNS record:', err);
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
    const credResult = await getUserCloudProviderConfig(db, userId, env.ENCRYPTION_KEY);
    if (credResult) {
      try {
        const provider = createProvider(credResult.config);
        await provider.deleteVM(node.providerInstanceId);
      } catch (err) {
        console.error('Failed to delete node server:', err);
      }
    }
  }

  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
    } catch (err) {
      console.error('Failed to delete node backend DNS record:', err);
    }
  }
}
