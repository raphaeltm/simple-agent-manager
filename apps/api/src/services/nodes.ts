import { type NativeVMConfig } from '@simple-agent-manager/providers';
import {
  type CapacityPlacementSnapshot,
  type CredentialSource,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { capacityPlacementSnapshotDbValues } from './capacity-placement-snapshot';

export {
  assertNodeAllocationPlanCurrent,
  type NodeAllocationPlanRole,
} from './node-allocation-validation';
export {
  type DeploymentProvisionContext,
  provisionNode,
  type ProvisionNodeOptions,
  type ProvisionTaskContext,
  resolveHetznerBaseImageOverride,
} from './node-provisioning';
export type { DeleteNodeResourcesResult } from './node-resource-deletion';
export { deleteNodeResources } from './node-resource-deletion';
export { retireDeletedDeploymentNodeRecord, stopNodeResources } from './node-resource-lifecycle';
export type { StrictNodeDeletionResult } from './strict-node-deletion';
export { deleteNodeResourcesStrict } from './strict-node-deletion';

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
