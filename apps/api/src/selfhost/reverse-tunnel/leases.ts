import * as v from 'valibot';

import { log, serializeError } from '../../lib/logger';
import { LIVE_INCARNATION_SQL } from '../../services/node-tunnel-journal';
import {
  deriveReverseTunnelCredential,
  hashReverseTunnelCredential,
  resolveReverseTunnelPortRange,
  resolveReverseTunnelPortReuseMinAgeSeconds,
  type ReverseTunnelEnv,
} from './config';
import type { ReverseTunnelEnv as Env } from './env';
import { isReverseTunnelInstallation } from './env';

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

const LeaseRowSchema = v.object({
  id: v.string(), nodeId: v.string(), userId: v.string(), runtimeIncarnationId: v.string(),
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  credentialHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  status: v.picklist(['active', 'released']),
});
export const REVERSE_TUNNEL_LEASE_COLUMNS = `id, node_id AS nodeId, user_id AS userId,
  runtime_incarnation_id AS runtimeIncarnationId, port, credential_hash AS credentialHash, status`;

const NODE_LIVE_FENCE_SQL = `id = ? AND user_id = ? AND runtime = 'vm' AND node_class = 'managed'
  AND transport = 'reverse-tunnel' AND runtime_incarnation_id = ? AND runtime_termination_confirmed_at IS NULL
  AND status NOT IN ('deleted', 'stopped', 'destroying')`;

type LeaseEnv = Pick<Env, 'DATABASE' | 'VM_AGENT_TRANSPORT'>;

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

const UNKNOWN_RELEASE_AT = '9999-12-31T23:59:59.999Z';

export interface ReverseTunnelLeaseProvisioning {
  leaseId: string;
  port: number;
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
  const row = await env.DATABASE.prepare(
    `SELECT ${REVERSE_TUNNEL_LEASE_COLUMNS} FROM node_reverse_tunnel_leases
      WHERE node_id = ? AND runtime_incarnation_id = ?`
  )
    .bind(nodeId, runtimeIncarnationId)
    .first<unknown>();
  const parsed = v.safeParse(LeaseRowSchema, row);
  if (row && !parsed.success) log.warn('node_reverse_tunnel.invalid_lease', { nodeId, runtimeIncarnationId });
  return parsed.success ? parsed.output : null;
}

export async function ensureReverseTunnelLease(
  env: LeaseEnv & ReverseTunnelEnv & Pick<Env, 'ENCRYPTION_KEY'>,
  input: EnsureReverseTunnelLeaseInput
): Promise<ReverseTunnelLeaseProvisioning> {
  if (!input.nodeId || !input.userId || !input.runtimeIncarnationId) throw new Error('Reverse-tunnel owner identity is required');
  // A durable allocation keeps the transport its VM already booted with, even if the
  // installation now selects another transport. Only admission of a NEW lease reads the flag.
  const existing = await readReverseTunnelLeaseByIncarnation(env, input.nodeId, input.runtimeIncarnationId);
  if (existing) return adoptReverseTunnelLease(env, input, existing);
  if (!isReverseTunnelInstallation(env)) throw new Error('Reverse tunnel is disabled');
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
  return adoptReverseTunnelLease(env, input, row);
}

/** Existing authority is adopted only while its exact persisted owner remains live. */
async function adoptReverseTunnelLease(
  env: LeaseEnv & Pick<Env, 'ENCRYPTION_KEY'>,
  input: EnsureReverseTunnelLeaseInput,
  row: ReverseTunnelLeaseRow
): Promise<ReverseTunnelLeaseProvisioning> {
  if (row.userId !== input.userId || row.status !== 'active') {
    throw new ReverseTunnelLeaseError('lease_released', 'Reverse-tunnel lease for this node incarnation was released');
  }
  const live = await env.DATABASE.prepare(`SELECT 1 AS live FROM nodes WHERE ${NODE_LIVE_FENCE_SQL}`)
    .bind(input.nodeId, input.userId, input.runtimeIncarnationId).first<{ live: number }>();
  if (!live) throw new ReverseTunnelLeaseError('incarnation_not_live', 'Reverse-tunnel lease owner is no longer live');
  // A rotated root must never hand a VM a credential the plugin will refuse.
  const credential = await deriveReverseTunnelCredential(env, {
    leaseId: row.id, nodeId: row.nodeId, runtimeIncarnationId: row.runtimeIncarnationId,
  });
  if ((await hashReverseTunnelCredential(credential)) !== row.credentialHash) {
    throw new ReverseTunnelLeaseError('credential_mismatch', 'Reverse-tunnel credential cannot be re-derived for this lease');
  }
  return { leaseId: row.id, port: row.port, credential };
}

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

export async function releaseUnallocatedReverseTunnelLease(
  env: LeaseEnv,
  nodeId: string,
  runtimeIncarnationId: string,
  reason: string
): Promise<boolean> {
  if (!isReverseTunnelInstallation(env)) return false;
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

export async function releaseNonLiveReverseTunnelLeases(
  env: LeaseEnv,
  reason: string,
  nodeId?: string
): Promise<number> {
  if (!isReverseTunnelInstallation(env)) return 0;
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

export async function runReverseTunnelLeaseSweep(
  env: LeaseEnv & Pick<Env, 'VM_AGENT_TRANSPORT'>
): Promise<ReverseTunnelLeaseSweepResult> {
  if (!isReverseTunnelInstallation(env)) {
    return { released: null, skipReason: 'transport_not_reverse_tunnel' };
  }
  return { released: await releaseNonLiveReverseTunnelLeases(env, 'runtime_not_live') };
}
