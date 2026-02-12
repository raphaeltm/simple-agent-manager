import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { generateCloudInit, validateCloudInitSize } from '@workspace/cloud-init';
import { HETZNER_IMAGE } from '@simple-agent-manager/shared';
import { ulid } from '../lib/ulid';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { decrypt } from './encryption';
import { createNodeBackendDNSRecord, deleteDNSRecord } from './dns';
import { createServer, deleteServer, powerOffServer, SERVER_TYPES } from './hetzner';
import { signCallbackToken } from './jwt';

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

export async function provisionNode(nodeId: string, env: Env): Promise<void> {
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
    const credentials = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, node.userId),
          eq(schema.credentials.provider, 'hetzner')
        )
      )
      .limit(1);

    const credential = credentials[0];
    if (!credential) {
      throw new Error('Hetzner account not connected');
    }

    const hetznerToken = await decrypt(credential.encryptedToken, credential.iv, env.ENCRYPTION_KEY);
    const callbackToken = await signCallbackToken(node.id, env);

    const cloudInit = generateCloudInit({
      nodeId: node.id,
      hostname: `node-${node.id.toLowerCase()}`,
      controlPlaneUrl: `https://api.${env.BASE_DOMAIN}`,
      jwksUrl: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`,
      callbackToken,
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    const server = await createServer(hetznerToken, {
      name: `node-${node.id.toLowerCase()}`,
      serverType: SERVER_TYPES[node.vmSize] || 'cx33',
      location: node.vmLocation,
      image: HETZNER_IMAGE,
      userData: cloudInit,
      labels: {
        node: node.id,
        managed: 'simple-agent-manager',
      },
    });

    let backendDnsRecordId: string | null = null;
    try {
      backendDnsRecordId = await createNodeBackendDNSRecord(node.id, server.publicNet.ipv4.ip, env);
    } catch (dnsErr) {
      console.error('Failed to create node backend DNS record:', dnsErr);
    }

    await db
      .update(schema.nodes)
      .set({
        providerInstanceId: String(server.id),
        ipAddress: server.publicNet.ipv4.ip,
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

  if (node.providerInstanceId) {
    const credentials = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.provider, 'hetzner')
        )
      )
      .limit(1);

    const credential = credentials[0];
    if (credential) {
      const hetznerToken = await decrypt(credential.encryptedToken, credential.iv, env.ENCRYPTION_KEY);
      try {
        await powerOffServer(hetznerToken, node.providerInstanceId);
      } catch (err) {
        console.error('Failed to power off node server:', err);
      }
    }
  }

  await db
    .update(schema.workspaces)
    .set({
      status: 'stopped',
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
      status: 'stopped',
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

  const credentials = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  const credential = credentials[0];
  if (credential && node.providerInstanceId) {
    const hetznerToken = await decrypt(credential.encryptedToken, credential.iv, env.ENCRYPTION_KEY);
    try {
      await deleteServer(hetznerToken, node.providerInstanceId);
    } catch (err) {
      console.error('Failed to delete node server:', err);
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
