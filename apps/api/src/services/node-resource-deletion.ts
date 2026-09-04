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
  errors: string[];
}

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
  let runtimeTerminationConfirmed = userOwned || Boolean(node.runtimeTerminationConfirmedAt);

  if (userOwned) {
    result.providerVmDeleteSkippedReason = 'user-owned node — no cloud VM to delete';
  } else if (!runtimeTerminationConfirmed) {
    try {
      const strictResult = await deleteNodeResourcesStrict(nodeId, userId, env, {
        cleanupDns: false,
      });
      runtimeTerminationConfirmed = true;
      result.providerVmDeleted = strictResult.providerVm === 'deleted';
      if (!result.providerVmDeleted) {
        result.providerVmDeleteSkippedReason =
          strictResult.providerVm === 'already-absent'
            ? 'provider VM already absent'
            : 'strict deletion confirmed no provider instance';
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      log.error('node_delete.runtime_termination_unconfirmed', {
        nodeId,
        ...serializeError(err),
      });
    }
  }

  result.runtimeTerminationConfirmed = runtimeTerminationConfirmed;

  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
      result.backendDnsDeleted = true;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      log.error('node_delete.delete_dns_failed', { nodeId, ...serializeError(err) });
    }
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

  await db
    .update(schema.workspaces)
    .set({ status: 'deleted', updatedAt: now })
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));
  await finalizeWorkspaceLifecycleClosure(env, {
    nodeId,
    userId,
    agentSessionStatus: 'completed',
    nowIso: now,
    reason: 'delete_node_resources',
  });
  return result;
}
