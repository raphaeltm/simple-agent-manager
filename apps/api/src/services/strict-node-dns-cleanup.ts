/**
 * Best-effort backend DNS record cleanup for strict node deletion. A DNS failure never fails
 * the teardown: it is logged and persisted as an observability error for follow-up.
 */
import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { deleteDNSRecord } from './dns';
import { getTimeoutMs } from './fetch-timeout';
import { persistError } from './observability';

type NodeRow = typeof schema.nodes.$inferSelect;

async function persistStrictDnsCleanupError(
  env: Env,
  input: {
    nodeId: string;
    userId: string;
    backendDnsRecordId: string;
    err: unknown;
  }
): Promise<void> {
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
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
    },
    env
  );
}

export async function deleteStrictNodeDnsRecord(
  node: Pick<NodeRow, 'id' | 'backendDnsRecordId'>,
  userId: string,
  env: Env,
  requestDeadlineMs?: number,
  signal?: AbortSignal
): Promise<void> {
  if (!node.backendDnsRecordId) return;

  try {
    const remainingMs =
      requestDeadlineMs === undefined ? undefined : requestDeadlineMs - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new Error('Stopped node cleanup DNS deadline exceeded');
    }
    const dnsEnv =
      remainingMs === undefined
        ? env
        : {
            ...env,
            CF_API_TIMEOUT_MS: String(Math.min(getTimeoutMs(env.CF_API_TIMEOUT_MS), remainingMs)),
          };
    if (signal) await deleteDNSRecord(node.backendDnsRecordId, dnsEnv, signal);
    else await deleteDNSRecord(node.backendDnsRecordId, dnsEnv);
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
