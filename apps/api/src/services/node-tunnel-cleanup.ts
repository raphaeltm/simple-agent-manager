/**
 * Retryable deletion of managed-node tunnel resources (CNAME, connectors, tunnel).
 *
 * Only journal rows in `cleanup_pending` are touched, and a row only gets there when its
 * incarnation is provably not the node's live runtime (node row gone, incarnation replaced,
 * or termination proof recorded) or when the provisioner knows no VM was requested. Each
 * row deletes only its OWN resources: the DNS record is deleted by id and only while it
 * still points at this row's tunnel, so a replacement incarnation that took over the shared
 * `{nodeId}.vm` hostname is never touched. Failures keep the row pending with backoff; the
 * identity is never dropped (rule 47: bounded retry rate, no lifetime cap that loses state).
 */
import { log, serializeError } from '../lib/logger';
import {
  type CloudflareCallOptions,
  deleteDnsRecordById,
  deleteTunnel,
  getDnsRecord,
  listDnsRecordsByName,
  listTunnelsByExactName,
  tunnelCnameTarget,
} from './cloudflare-tunnel-api';
import { DEFAULT_CF_API_TIMEOUT_MS } from './dns-core';
import { getTimeoutMs } from './fetch-timeout';
import { resolveNodeTunnelCleanupConfig, type TunnelEnv } from './node-tunnel-config';
import {
  listDueNodeTunnelCleanups,
  type NodeTunnelRow,
  releaseNonLiveNodeTunnels,
} from './node-tunnel-journal';

const LAST_ERROR_MAX_LENGTH = 500;

type CleanupEnv = TunnelEnv;

async function cleanupOptions(env: CleanupEnv): Promise<CloudflareCallOptions> {
  const interactive = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const background = (await resolveNodeTunnelCleanupConfig(env)).requestTimeoutMs;
  return { timeoutMs: Math.min(interactive, background) };
}

export async function nodeTunnelCleanupBackoffMs(
  env: Parameters<typeof resolveNodeTunnelCleanupConfig>[0],
  attempts: number
): Promise<number> {
  const { backoffBaseMs: base, backoffMaxMs: max } = await resolveNodeTunnelCleanupConfig(env);
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(base * 2 ** exponent, max);
}

async function deleteOwnDnsRecord(
  env: CleanupEnv,
  row: NodeTunnelRow,
  options: CloudflareCallOptions
): Promise<void> {
  if (!row.tunnelId) {
    // No tunnel was ever recorded, so no record of ours can point anywhere: nothing to fence on.
    return;
  }
  const target = tunnelCnameTarget(row.tunnelId);
  const ours = (record: { name: string; type: string; content?: string } | null) =>
    !!record &&
    record.name === row.hostname &&
    record.type === 'CNAME' &&
    record.content === target;
  if (row.dnsRecordId) {
    const record = await getDnsRecord(env, row.dnsRecordId, options);
    if (ours(record)) await deleteDnsRecordById(env, row.dnsRecordId, options);
  }
  // A create whose response was lost leaves an unrecorded record. Only an exact pointer at
  // THIS incarnation's tunnel is ours; a replacement incarnation's record never matches.
  for (const record of await listDnsRecordsByName(env, row.hostname, options)) {
    if (ours(record)) await deleteDnsRecordById(env, record.id, options);
  }
}

async function deleteOwnTunnels(
  env: CleanupEnv,
  row: NodeTunnelRow,
  options: CloudflareCallOptions
): Promise<void> {
  // The name embeds the random incarnation UUID: every exact match is this incarnation's,
  // including a duplicate left by a lost create response.
  const ids = new Set(
    (await listTunnelsByExactName(env, row.tunnelName, options)).map((t) => t.id)
  );
  if (row.tunnelId) ids.add(row.tunnelId);
  for (const id of ids) await deleteTunnel(env, id, options);
}

async function recordCleanupFailure(env: CleanupEnv, row: NodeTunnelRow, err: unknown) {
  const attempts = (row.cleanupAttempts ?? 0) + 1;
  const now = Date.now();
  const message = (err instanceof Error ? err.message : String(err)).slice(
    0,
    LAST_ERROR_MAX_LENGTH
  );
  await env.DATABASE.prepare(
    `UPDATE node_cloudflare_tunnels
        SET cleanup_attempts = ?, cleanup_next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'cleanup_pending'`
  )
    .bind(
      attempts,
      new Date(now + (await nodeTunnelCleanupBackoffMs(env, attempts))).toISOString(),
      message,
      new Date(now).toISOString(),
      row.id
    )
    .run();
  const fields = {
    nodeId: row.nodeId,
    runtimeIncarnationId: row.runtimeIncarnationId,
    tunnelId: row.tunnelId,
    attempts,
    ...serializeError(err),
  };
  if (attempts >= (await resolveNodeTunnelCleanupConfig(env)).stuckAttempts) {
    log.error('node_tunnel.cleanup_stuck', fields);
  } else {
    log.warn('node_tunnel.cleanup_failed', fields);
  }
}

/**
 * Delete one pending row's Cloudflare resources. Returns true once the row is `cleaned`.
 * Never throws: a failure is recorded on the row and retried later.
 */
export async function cleanupNodeTunnelRow(env: CleanupEnv, row: NodeTunnelRow): Promise<boolean> {
  if (row.status !== 'cleanup_pending') return false;
  try {
    if (row.accountId !== env.CF_ACCOUNT_ID || row.zoneId !== env.CF_ZONE_ID) {
      // Fail closed: the configured credentials point at a different account/zone, so they
      // cannot prove these resources gone. Keep the identity for an operator.
      throw new Error('Tunnel journal belongs to a different Cloudflare account or zone');
    }
    const options = await cleanupOptions(env);
    // DNS first: once the hostname stops resolving to the tunnel, the tunnel is unreachable.
    await deleteOwnDnsRecord(env, row, options);
    await deleteOwnTunnels(env, row, options);
    const now = new Date().toISOString();
    const done = await env.DATABASE.prepare(
      `UPDATE node_cloudflare_tunnels
          SET status = 'cleaned', cleaned_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'cleanup_pending'`
    )
      .bind(now, now, row.id)
      .run();
    log.info('node_tunnel.cleaned', {
      nodeId: row.nodeId,
      runtimeIncarnationId: row.runtimeIncarnationId,
      tunnelId: row.tunnelId,
      reason: row.cleanupReason,
    });
    return (done.meta?.changes ?? 0) === 1;
  } catch (err) {
    try {
      await recordCleanupFailure(env, row, err);
    } catch (recordErr) {
      log.error('node_tunnel.cleanup_failure_record_failed', {
        nodeId: row.nodeId,
        ...serializeError(recordErr),
      });
    }
    return false;
  }
}

export interface NodeTunnelCleanupResult {
  released: number;
  attempted: number;
  cleaned: number;
}

/**
 * Release this node's non-live incarnations and try to clean them now. Used right after a
 * runtime termination proof or a provisioning failure. Never throws; the cron sweep is the
 * backstop for anything left pending.
 */
export async function settleNodeTunnels(
  env: CleanupEnv,
  nodeId: string,
  reason: string
): Promise<NodeTunnelCleanupResult> {
  const result: NodeTunnelCleanupResult = { released: 0, attempted: 0, cleaned: 0 };
  try {
    result.released = await releaseNonLiveNodeTunnels(env, reason, nodeId);
    const due = await listDueNodeTunnelCleanups(
      env,
      new Date().toISOString(),
      (await resolveNodeTunnelCleanupConfig(env)).batchSize,
      nodeId
    );
    for (const row of due) {
      result.attempted++;
      if (await cleanupNodeTunnelRow(env, row)) result.cleaned++;
    }
  } catch (err) {
    log.error('node_tunnel.settle_failed', { nodeId, reason, ...serializeError(err) });
  }
  return result;
}

/** Cron sweep: release every non-live owned row, then clean a bounded batch of due rows. */
export async function runNodeTunnelCleanupSweep(
  env: CleanupEnv,
  now: Date = new Date()
): Promise<NodeTunnelCleanupResult> {
  const released = await releaseNonLiveNodeTunnels(env, 'runtime_not_live');
  const due = await listDueNodeTunnelCleanups(
    env,
    now.toISOString(),
    (await resolveNodeTunnelCleanupConfig(env)).batchSize
  );
  let cleaned = 0;
  for (const row of due) {
    if (await cleanupNodeTunnelRow(env, row)) cleaned++;
  }
  return { released, attempted: due.length, cleaned };
}
