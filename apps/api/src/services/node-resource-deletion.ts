import {
  DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH,
  isUserOwnedNodeClass,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteDNSRecord } from './dns';
import { deleteNodeResourcesStrict } from './strict-node-deletion';
import { WORKSPACE_DELETION_DIAGNOSTIC_PREFIX } from './workspace-deletion';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

export interface DeleteNodeResourcesResult {
  nodeFound: boolean;
  /** True only when SAM owns no runtime or managed-runtime termination has strict proof. */
  runtimeTerminationConfirmed: boolean;
  providerVmDeleted: boolean;
  providerVmDeleteSkippedReason: string | null;
  backendDnsDeleted: boolean;
  runtimeTerminationConfirmedAt: string | null;
  runtimeIncarnationId: string | null;
  errors: string[];
}

const RUNTIME_TERMINATION_PENDING_ERROR = 'Managed runtime termination remains unconfirmed';
const DNS_CLEANUP_PENDING_ERROR = 'Node DNS cleanup remains pending';

function deletionDiagnostic(env: Env): string {
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

async function deleteManagedNodeRuntime(
  nodeId: string,
  userId: string,
  env: Env,
  node: schema.Node,
  result: DeleteNodeResourcesResult
): Promise<boolean> {
  try {
    const strictResult = await deleteNodeResourcesStrict(nodeId, userId, env, {
      cleanupDns: false,
      expectedRuntime: {
        userId: node.userId,
        runtime: node.runtime,
        providerInstanceId: node.providerInstanceId,
        runtimeIncarnationId: node.runtimeIncarnationId,
      },
    });
    result.runtimeTerminationConfirmedAt = strictResult.runtimeTerminationConfirmedAt;
    result.runtimeIncarnationId = strictResult.runtimeIncarnationId;
    result.providerVmDeleted = strictResult.providerVm === 'deleted';
    if (!result.providerVmDeleted) {
      result.providerVmDeleteSkippedReason =
        strictResult.providerVm === 'already-absent'
          ? 'provider VM already absent'
          : 'strict deletion confirmed no provider instance';
    }
    return true;
  } catch (err) {
    result.errors.push(RUNTIME_TERMINATION_PENDING_ERROR);
    log.error('node_delete.runtime_termination_unconfirmed', {
      nodeId,
      ...serializeError(err),
    });
    return false;
  }
}

async function deleteNodeBackendDns(
  nodeId: string,
  backendDnsRecordId: string,
  env: Env,
  result: DeleteNodeResourcesResult
): Promise<void> {
  try {
    await deleteDNSRecord(backendDnsRecordId, env);
    result.backendDnsDeleted = true;
  } catch (err) {
    result.errors.push(DNS_CLEANUP_PENDING_ERROR);
    log.error('node_delete.delete_dns_failed', { nodeId, ...serializeError(err) });
  }
}

/**
 * Best-effort node deletion adapter for API callers. Managed runtimes are delegated to the strict
 * provider/container boundary; failures are returned as a durable quarantine rather than hidden.
 */
export async function deleteNodeResources(
  nodeId: string,
  userId: string,
  env: Env
): Promise<DeleteNodeResourcesResult> {
  const db = drizzle(env.DATABASE, { schema });
  const result: DeleteNodeResourcesResult = {
    nodeFound: false,
    runtimeTerminationConfirmed: false,
    providerVmDeleted: false,
    providerVmDeleteSkippedReason: null,
    backendDnsDeleted: false,
    runtimeTerminationConfirmedAt: null,
    runtimeIncarnationId: null,
    errors: [],
  };

  const [node] = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);
  if (!node) return result;

  result.nodeFound = true;
  const userOwned = isUserOwnedNodeClass(node.nodeClass);
  let runtimeTerminationConfirmed = userOwned;

  if (userOwned) {
    result.providerVmDeleteSkippedReason = 'user-owned node — no cloud VM to delete';
  } else {
    runtimeTerminationConfirmed = await deleteManagedNodeRuntime(nodeId, userId, env, node, result);
  }

  result.runtimeTerminationConfirmed = runtimeTerminationConfirmed;

  if (node.backendDnsRecordId) {
    await deleteNodeBackendDns(nodeId, node.backendDnsRecordId, env, result);
  }

  const now = new Date().toISOString();
  if (!runtimeTerminationConfirmed) {
    await db
      .update(schema.workspaces)
      .set({ status: 'stopping', errorMessage: deletionDiagnostic(env), updatedAt: now })
      .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));
    await db
      .update(schema.nodes)
      .set({ status: 'destroying', healthStatus: 'stale', updatedAt: now })
      .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)));
    return result;
  }

  if (userOwned) {
    await db
      .update(schema.workspaces)
      .set({ status: 'deleted', updatedAt: now })
      .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));
    await finalizeWorkspaceLifecycleClosure(env, {
      nodeId,
      userId,
      agentSessionStatus: 'completed',
      nowIso: now,
      reason: 'delete_node_resources_user_owned',
    });
    return result;
  }

  if (!result.runtimeTerminationConfirmedAt) {
    throw new Error('Strict managed-node deletion returned no termination proof');
  }
  const confirmedWorkspaces = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.runtimeDeletionConfirmedAt, result.runtimeTerminationConfirmedAt)
      )
    );
  await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: confirmedWorkspaces.map((workspace) => workspace.id),
    userId,
    agentSessionStatus: 'completed',
    nowIso: now,
    reason: 'delete_node_resources_strict_proof',
  });
  return result;
}
