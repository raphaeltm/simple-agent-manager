/**
 * D1 access for reverse-tunnel port leases (`node_reverse_tunnel_leases`, migration 0232).
 *
 * Status machine: active -> released. A lease is written BEFORE the provider VM is requested,
 * fenced on the node row still carrying that exact live incarnation, and is released when its
 * incarnation is provably no longer the node's live runtime ({@link LIVE_INCARNATION_SQL}, the
 * same predicate the Cloudflare tunnel journal uses) or when the provisioner knows no VM was
 * ever requested for it. Releasing is the whole cleanup: frps holds no state SAM must delete,
 * and the frps plugin refuses Login/NewProxy/Ping/NewWorkConn for a released lease, so a straggling frpc
 * is disconnected at its next heartbeat. Rows are never deleted.
 */
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import {
  deriveReverseTunnelCredential,
  hashReverseTunnelCredential,
  resolveReverseTunnelPortRange,
  resolveReverseTunnelPortReuseMinAgeSeconds,
  type ReverseTunnelEnv,
} from './node-reverse-tunnel-config';
import { isReverseTunnelInstallation } from './node-tunnel-config';
import { LIVE_INCARNATION_SQL } from './node-tunnel-journal';

export type ReverseTunnelLeaseStatus = 'active' | 'released';

export interface ReverseTunnelLeaseRow {
  id: string;
  nodeId: string;
  userId: string;
  runtimeIncarnationId: string;
  port: number;
  credentialHash: string;
  status: ReverseTunnelLeaseStatus;
}

export const REVERSE_TUNNEL_LEASE_COLUMNS = `id, node_id AS nodeId, user_id AS userId,
  runtime_incarnation_id AS runtimeIncarnationId, port, credential_hash AS credentialHash, status`;

/**
 * Fence for writing a lease: the exact live managed VM incarnation. Same shape as the
 * Cloudflare tunnel provisioning fence (node-tunnel-provisioning.ts).
 */
const NODE_LIVE_FENCE_SQL = `id = ? AND user_id = ? AND runtime = 'vm' AND node_class = 'managed'
  AND runtime_incarnation_id = ? AND runtime_termination_confirmed_at IS NULL
  AND status NOT IN ('deleted', 'stopped', 'destroying')`;

type LeaseEnv = Pick<Env, 'DATABASE'>;

/**
 * Why no lease was written. `port_range_exhausted`: every port in the range is held by an
 * active lease. `port_range_cooling_down`: some ports are free but were released less than the
 * minimum reuse age ago, so reissuing one could hand a new node's traffic to the previous
 * holder's still-connected frpc. Both are capacity conditions; the others are not.
 */
export type ReverseTunnelLeaseErrorCode =
  | 'port_range_exhausted'
  | 'port_range_cooling_down'
  | 'incarnation_not_live'
  | 'lease_released'
  | 'credential_mismatch';

export class ReverseTunnelLeaseError extends Error {
  override name = 'ReverseTunnelLeaseError';
  constructor(
    readonly code: ReverseTunnelLeaseErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** Sorts after every ISO timestamp: a released row with no released_at is treated as fresh. */
const UNKNOWN_RELEASE_AT = '9999-12-31T23:59:59.999Z';

export interface ReverseTunnelLeaseProvisioning {
  leaseId: string;
  port: number;
  /** SECRET: cloud-init only; never log or persist. */
  credential: string;
}

export interface EnsureReverseTunnelLeaseInput {
  nodeId: string;
  userId: string;
  runtimeIncarnationId: string;
}

export async function readReverseTunnelLeaseByIncarnation(
  env: LeaseEnv,
  nodeId: string,
  runtimeIncarnationId: string
): Promise<ReverseTunnelLeaseRow | null> {
  return await env.DATABASE.prepare(
    `SELECT ${REVERSE_TUNNEL_LEASE_COLUMNS} FROM node_reverse_tunnel_leases
      WHERE node_id = ? AND runtime_incarnation_id = ?`
  )
    .bind(nodeId, runtimeIncarnationId)
    .first<ReverseTunnelLeaseRow>();
}

/**
 * Allocate (or adopt, on retry/resume) this incarnation's lease and return its port and
 * credential. The port is chosen and written by ONE statement: SQLite executes it with no
 * interleaving writer, so two nodes can never be handed the same port, and the partial unique
 * index on active ports is a second fence. A released port is NOT a candidate until its latest
 * release is older than the minimum reuse age (2 x the frps heartbeat timeout by default,
 * {@link resolveReverseTunnelPortReuseMinAgeSeconds}): by then frps has dropped the previous
 * holder's session, so a new node's traffic cannot reach it. Among candidates: never-used ports
 * in ascending order, then the least recently released. When nothing qualifies the error says
 * whether the range is full or only cooling down ({@link ReverseTunnelLeaseErrorCode}).
 *
 * The credential is derived from the lease id, so the row id is generated first and the hash
 * of the resulting credential is written in the same INSERT. Only the (node, incarnation)
 * conflict is absorbed (retry/resume adopts its own row); any other constraint failure throws.
 */
export async function ensureReverseTunnelLease(
  env: LeaseEnv & ReverseTunnelEnv & Pick<Env, 'ENCRYPTION_KEY'>,
  input: EnsureReverseTunnelLeaseInput
): Promise<ReverseTunnelLeaseProvisioning> {
  const range = resolveReverseTunnelPortRange(env);
  const reuseMinAgeSeconds = resolveReverseTunnelPortReuseMinAgeSeconds(env);
  const nowMs = Date.now();
  const reusableBefore = new Date(nowMs - reuseMinAgeSeconds * 1000).toISOString();
  const leaseId = crypto.randomUUID();
  const candidateCredential = await deriveReverseTunnelCredential(env, {
    leaseId,
    nodeId: input.nodeId,
    runtimeIncarnationId: input.runtimeIncarnationId,
  });
  const now = new Date(nowMs).toISOString();
  await env.DATABASE.prepare(
    `WITH RECURSIVE candidate_ports(port) AS (
       SELECT ? UNION ALL SELECT port + 1 FROM candidate_ports WHERE port < ?
     )
     INSERT INTO node_reverse_tunnel_leases
       (id, node_id, user_id, runtime_incarnation_id, port, credential_hash, status,
        release_reason, created_at, updated_at, released_at)
     SELECT ?, ?, ?, ?, chosen.port, ?, 'active', NULL, ?, ?, NULL
       FROM (
         SELECT c.port AS port,
                (SELECT MAX(l.released_at) FROM node_reverse_tunnel_leases l
                  WHERE l.port = c.port) AS last_released_at
           FROM candidate_ports c
          WHERE NOT EXISTS (
            SELECT 1 FROM node_reverse_tunnel_leases a
             WHERE a.port = c.port AND a.status = 'active')
            AND NOT EXISTS (
            SELECT 1 FROM node_reverse_tunnel_leases r
             WHERE r.port = c.port AND r.status = 'released'
               AND COALESCE(r.released_at, '${UNKNOWN_RELEASE_AT}') > ?)
          ORDER BY last_released_at IS NOT NULL, last_released_at, c.port
          LIMIT 1
       ) chosen
      WHERE EXISTS (SELECT 1 FROM nodes WHERE ${NODE_LIVE_FENCE_SQL})
     ON CONFLICT (node_id, runtime_incarnation_id) DO NOTHING`
  )
    .bind(
      range.start,
      range.end,
      leaseId,
      input.nodeId,
      input.userId,
      input.runtimeIncarnationId,
      await hashReverseTunnelCredential(candidateCredential),
      now,
      now,
      reusableBefore,
      input.nodeId,
      input.userId,
      input.runtimeIncarnationId
    )
    .run();

  const row = await readReverseTunnelLeaseByIncarnation(
    env,
    input.nodeId,
    input.runtimeIncarnationId
  );
  if (!row) {
    const live = await env.DATABASE.prepare(
      `SELECT 1 AS live FROM nodes WHERE ${NODE_LIVE_FENCE_SQL}`
    )
      .bind(input.nodeId, input.userId, input.runtimeIncarnationId)
      .first<{ live: number }>();
    if (!live) {
      throw new ReverseTunnelLeaseError(
        'incarnation_not_live',
        'Node incarnation changed before a reverse-tunnel lease was written'
      );
    }
    throw await noFreePortError(env, input.nodeId, range, reusableBefore, reuseMinAgeSeconds);
  }
  if (row.userId !== input.userId || row.status !== 'active') {
    throw new ReverseTunnelLeaseError(
      'lease_released',
      'Reverse-tunnel lease for this node incarnation was released'
    );
  }
  // Adopting an earlier attempt's row (retry or durable resume): re-derive ITS credential. A
  // mismatch (for example a rotated ENCRYPTION_KEY) must not hand a VM a credential the plugin
  // will refuse; fail closed instead.
  const credential =
    row.id === leaseId
      ? candidateCredential
      : await deriveReverseTunnelCredential(env, {
          leaseId: row.id,
          nodeId: row.nodeId,
          runtimeIncarnationId: row.runtimeIncarnationId,
        });
  if ((await hashReverseTunnelCredential(credential)) !== row.credentialHash) {
    throw new ReverseTunnelLeaseError(
      'credential_mismatch',
      'Reverse-tunnel credential cannot be re-derived for this lease'
    );
  }
  return { leaseId: row.id, port: row.port, credential };
}

/**
 * Distinguish "every port is held" from "only recently released ports remain", record which,
 * and name the earliest moment a cooling port becomes reusable. Failure path only: one
 * statement over the range's released rows (indexed on port, released_at).
 */
async function noFreePortError(
  env: LeaseEnv,
  nodeId: string,
  range: { start: number; end: number },
  reusableBefore: string,
  reuseMinAgeSeconds: number
): Promise<ReverseTunnelLeaseError> {
  const cooling = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS ports, MIN(last_released_at) AS oldest FROM (
       SELECT r.port, MAX(COALESCE(r.released_at, '${UNKNOWN_RELEASE_AT}')) AS last_released_at
         FROM node_reverse_tunnel_leases r
        WHERE r.port BETWEEN ? AND ? AND r.status = 'released'
          AND NOT EXISTS (SELECT 1 FROM node_reverse_tunnel_leases a
                           WHERE a.port = r.port AND a.status = 'active')
        GROUP BY r.port
       HAVING last_released_at > ?)`
  )
    .bind(range.start, range.end, reusableBefore)
    .first<{ ports: number; oldest: string | null }>();
  const coolingPorts = cooling?.ports ?? 0;
  const oldestMs = cooling?.oldest ? Date.parse(cooling.oldest) : Number.NaN;
  const reusableAt = Number.isFinite(oldestMs)
    ? new Date(oldestMs + reuseMinAgeSeconds * 1000).toISOString()
    : null;
  const code: ReverseTunnelLeaseErrorCode =
    coolingPorts > 0 ? 'port_range_cooling_down' : 'port_range_exhausted';
  log.error(`node_reverse_tunnel.${code}`, {
    nodeId,
    rangeStart: range.start,
    rangeEnd: range.end,
    coolingPorts,
    reuseMinAgeSeconds,
    reusableAt,
  });
  if (code === 'port_range_exhausted') {
    return new ReverseTunnelLeaseError(
      code,
      `No free reverse-tunnel port in ${range.start}-${range.end}: every port holds an active lease`
    );
  }
  const firstReusable = reusableAt ? `; the first becomes reusable at ${reusableAt}` : '';
  return new ReverseTunnelLeaseError(
    code,
    `No reverse-tunnel port in ${range.start}-${range.end} is reusable yet: ${coolingPorts} ` +
      `free port(s) were released less than ${reuseMinAgeSeconds}s ago${firstReusable}`
  );
}

/**
 * Release one incarnation that the caller KNOWS no VM can still use: failure or cancellation
 * before the provider create call, or a provider-confirmed direct delete.
 */
export async function releaseUnallocatedReverseTunnelLease(
  env: LeaseEnv,
  nodeId: string,
  runtimeIncarnationId: string,
  reason: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE node_reverse_tunnel_leases
        SET status = 'released', release_reason = ?, released_at = ?, updated_at = ?
      WHERE node_id = ? AND runtime_incarnation_id = ? AND status = 'active'`
  )
    .bind(reason, now, now, nodeId, runtimeIncarnationId)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Release every active lease whose incarnation is no longer live: node row gone, incarnation
 * replaced, or termination proof recorded. Scoped to one node when `nodeId` is given;
 * installation-wide otherwise (cron sweep). One D1 statement; never touches a live lease.
 */
export async function releaseNonLiveReverseTunnelLeases(
  env: LeaseEnv,
  reason: string,
  nodeId?: string
): Promise<number> {
  const now = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE node_reverse_tunnel_leases AS t
        SET status = 'released', release_reason = ?, released_at = ?, updated_at = ?
      WHERE t.status = 'active'
        ${nodeId ? 'AND t.node_id = ?' : ''}
        AND NOT ${LIVE_INCARNATION_SQL}`
  )
    .bind(reason, now, now, ...(nodeId ? [nodeId] : []))
    .run();
  return result.meta?.changes ?? 0;
}

/** Node-scoped release that never throws: the cron sweep is the backstop for a failed write. */
export async function releaseNodeReverseTunnelLeases(
  env: LeaseEnv,
  nodeId: string,
  reason: string
): Promise<number> {
  try {
    return await releaseNonLiveReverseTunnelLeases(env, reason, nodeId);
  } catch (err) {
    log.error('node_reverse_tunnel.release_failed', { nodeId, reason, ...serializeError(err) });
    return 0;
  }
}

export type ReverseTunnelLeaseSweepResult =
  { released: number } | { released: null; skipReason: 'transport_not_reverse_tunnel' };

/**
 * Cron sweep: release every non-live active lease installation-wide (one statement). Runs only
 * on an installation configured for the reverse-tunnel transport; every other deployment
 * (vm-public-dns, cloudflare-tunnel, Instant) makes no D1 call and reports why it skipped, so
 * the tick is distinguishable from "ran and found nothing" in `cron.completed`. Leases are
 * also released node-by-node on every teardown path, which does not depend on this sweep.
 */
export async function runReverseTunnelLeaseSweep(
  env: LeaseEnv & Pick<Env, 'VM_AGENT_TRANSPORT'>
): Promise<ReverseTunnelLeaseSweepResult> {
  if (!isReverseTunnelInstallation(env)) {
    return { released: null, skipReason: 'transport_not_reverse_tunnel' };
  }
  return { released: await releaseNonLiveReverseTunnelLeases(env, 'runtime_not_live') };
}
