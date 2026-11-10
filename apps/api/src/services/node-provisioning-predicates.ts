/**
 * Compare-and-set predicates and small helpers for `provisionNode`. Split out of
 * `node-provisioning.ts` (rule 18); behavior unchanged.
 */
import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { releaseUnallocatedReverseTunnelLease } from './node-reverse-tunnel-leases';
import { releaseUnallocatedNodeTunnel } from './node-tunnel-journal';

const NODE_ERROR_MESSAGE_MAX_LENGTH = 500;

export type ProvisionNodeRow = typeof schema.nodes.$inferSelect;

export function isProviderCreateRejectedBeforeVmIdentity(
  providerName: string,
  err: unknown
): boolean {
  if (
    providerName !== 'hetzner' ||
    !(err instanceof ProviderError) ||
    err.providerName !== 'hetzner' ||
    err.statusCode === undefined
  ) {
    return false;
  }

  return (
    err.statusCode === 412 || isTransientCapacityError(err) || err.category === 'quota_exceeded'
  );
}

export function creatingProvisioningPredicate(
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

export function providerIdentityRecordPredicate(
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

export function d1WriteChanged(
  result: { meta?: { changes?: number | null } } | undefined
): boolean {
  return (result?.meta?.changes ?? 0) === 1;
}

/**
 * Release one incarnation's tunnel (Cloudflare journal row and/or reverse-tunnel port lease)
 * when the caller KNOWS no VM can still use it: no provider create was ever requested, or the
 * provider confirmed the VM deleted. Each release is one fenced D1 update that is a no-op for
 * a transport the incarnation does not use. Never throws.
 */
export async function releaseTunnelBeforeVm(
  env: Env,
  nodeId: string,
  runtimeIncarnationId: string,
  reason = 'provisioning_failed_before_vm'
): Promise<void> {
  try {
    await releaseUnallocatedNodeTunnel(env, nodeId, runtimeIncarnationId, reason);
  } catch (releaseErr) {
    log.error('node_provisioning.tunnel_release_failed', {
      nodeId,
      runtimeIncarnationId,
      ...serializeError(releaseErr),
    });
  }
  try {
    await releaseUnallocatedReverseTunnelLease(env, nodeId, runtimeIncarnationId, reason);
  } catch (releaseErr) {
    log.error('node_provisioning.reverse_tunnel_release_failed', {
      nodeId,
      runtimeIncarnationId,
      ...serializeError(releaseErr),
    });
  }
}

export function truncateNodeErrorMessage(message: string): string {
  return message.length > NODE_ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, NODE_ERROR_MESSAGE_MAX_LENGTH) + '...'
    : message;
}
