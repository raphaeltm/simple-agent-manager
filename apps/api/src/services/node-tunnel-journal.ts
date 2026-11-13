/**
 * D1 access for the managed-node tunnel ownership journal (`node_cloudflare_tunnels`).
 *
 * Status machine: provisioning -> active -> cleanup_pending -> cleaned. A row only enters
 * `cleanup_pending` when its incarnation is provably not the node's live runtime (see
 * {@link LIVE_INCARNATION_SQL}) or when the provisioner knows no VM was ever requested for
 * it. `cleaned` is written only after Cloudflare confirmed every resource gone. Nothing
 * deletes rows, so a failed cleanup never loses the tunnel/DNS identity.
 */
import type { Env } from '../env';

export type NodeTunnelStatus = 'provisioning' | 'active' | 'cleanup_pending' | 'cleaned';

export interface NodeTunnelRow {
  id: string;
  nodeId: string;
  userId: string;
  runtimeIncarnationId: string;
  accountId: string;
  zoneId: string;
  tunnelName: string;
  tunnelId: string | null;
  hostname: string;
  dnsRecordId: string | null;
  status: NodeTunnelStatus;
  cleanupReason: string | null;
  cleanupAttempts: number;
  cleanupNextAttemptAt: string | null;
  lastError: string | null;
  /** POSTs without an observed terminal response; absence from inventory is not finality. */
  pendingCreateCount: number;
  /**
   * When the latest unobserved POST was sent. Rows from before migration 0233 have no stamp and
   * fall back to `created_at`, which precedes every POST for the row.
   */
  pendingCreateSince: string;
}

export const NODE_TUNNEL_COLUMNS = `id, node_id AS nodeId, user_id AS userId,
  runtime_incarnation_id AS runtimeIncarnationId, account_id AS accountId, zone_id AS zoneId,
  tunnel_name AS tunnelName, tunnel_id AS tunnelId, hostname, dns_record_id AS dnsRecordId,
  status, cleanup_reason AS cleanupReason, cleanup_attempts AS cleanupAttempts,
  cleanup_next_attempt_at AS cleanupNextAttemptAt, last_error AS lastError,
  pending_create_count AS pendingCreateCount,
  COALESCE(pending_create_last_at, created_at) AS pendingCreateSince`;

/**
 * True while `t`'s incarnation is still the node's live runtime: the node row exists, carries
 * exactly this incarnation, and has no runtime termination proof. Everything else (row
 * deleted, incarnation replaced, strict/rejection/owner-attested termination proof) means no
 * runtime of this incarnation can still be served by the tunnel. A `deleted` status label
 * alone is NOT proof (rule 44), so it is deliberately not consulted.
 */
export const LIVE_INCARNATION_SQL = `EXISTS (
  SELECT 1 FROM nodes n
   WHERE n.id = t.node_id
     AND n.runtime_incarnation_id = t.runtime_incarnation_id
     AND n.runtime_termination_confirmed_at IS NULL)`;

export const OWNED_STATUSES_SQL = `t.status IN ('provisioning', 'active')`;

type JournalEnv = Pick<Env, 'DATABASE'>;

export async function readNodeTunnelByIncarnation(
  env: JournalEnv,
  nodeId: string,
  runtimeIncarnationId: string
): Promise<NodeTunnelRow | null> {
  return await env.DATABASE.prepare(
    `SELECT ${NODE_TUNNEL_COLUMNS} FROM node_cloudflare_tunnels
      WHERE node_id = ? AND runtime_incarnation_id = ?`
  )
    .bind(nodeId, runtimeIncarnationId)
    .first<NodeTunnelRow>();
}

export async function readNodeTunnelById(
  env: JournalEnv,
  id: string
): Promise<NodeTunnelRow | null> {
  return await env.DATABASE.prepare(
    `SELECT ${NODE_TUNNEL_COLUMNS} FROM node_cloudflare_tunnels WHERE id = ?`
  )
    .bind(id)
    .first<NodeTunnelRow>();
}

/**
 * The only column assignments an owned-row update may make. A closed literal set, so no caller
 * can ever interpolate a computed string into the SQL below.
 */
export type OwnedNodeTunnelAssignment =
  | 'tunnel_id = ?'
  | "dns_record_id = ?, status = 'active'"
  // Provisioning finished: an earlier attempt's recorded cause is no longer current.
  | 'last_error = NULL';

/** Update an owned (provisioning/active) row. Returns false when cleanup already claimed it. */
export async function updateOwnedNodeTunnel(
  env: JournalEnv,
  id: string,
  assignments: OwnedNodeTunnelAssignment,
  binds: unknown[]
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE node_cloudflare_tunnels AS t SET ${assignments}, updated_at = ?
      WHERE t.id = ? AND ${OWNED_STATUSES_SQL}`
  )
    .bind(...binds, new Date().toISOString(), id)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Move every owned row whose incarnation is no longer live into `cleanup_pending`.
 * Scoped to one node when `nodeId` is given; otherwise installation-wide (sweep).
 *
 * Released rows are due immediately: both releases write `cleanup_next_attempt_at = NULL`, which
 * {@link listDueNodeTunnelCleanups} treats as due. A wall-clock stamp written here could be later
 * than the `now` a sweep captured before releasing, leaving a row released in that same sweep not
 * yet due (idea 01M73MNS3QD04CTD4P0GH7C8RC).
 */
export async function releaseNonLiveNodeTunnels(
  env: JournalEnv,
  reason: string,
  nodeId?: string
): Promise<number> {
  const now = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE node_cloudflare_tunnels AS t
        SET status = 'cleanup_pending', cleanup_reason = ?, cleanup_next_attempt_at = NULL,
            updated_at = ?
      WHERE ${OWNED_STATUSES_SQL}
        ${nodeId ? 'AND t.node_id = ?' : ''}
        AND NOT ${LIVE_INCARNATION_SQL}`
  )
    .bind(reason, now, ...(nodeId ? [nodeId] : []))
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Release one incarnation that the caller KNOWS no VM can still use: failure or cancellation
 * before the provider create call, or a provider-confirmed direct delete. Fenced on the exact
 * node + incarnation.
 */
export async function releaseUnallocatedNodeTunnel(
  env: JournalEnv,
  nodeId: string,
  runtimeIncarnationId: string,
  reason: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE node_cloudflare_tunnels AS t
        SET status = 'cleanup_pending', cleanup_reason = ?, cleanup_next_attempt_at = NULL,
            updated_at = ?
      WHERE t.node_id = ? AND t.runtime_incarnation_id = ? AND ${OWNED_STATUSES_SQL}`
  )
    .bind(reason, now, nodeId, runtimeIncarnationId)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function listDueNodeTunnelCleanups(
  env: JournalEnv,
  now: string,
  limit: number,
  nodeId?: string
): Promise<NodeTunnelRow[]> {
  const result = await env.DATABASE.prepare(
    `SELECT ${NODE_TUNNEL_COLUMNS} FROM node_cloudflare_tunnels
      WHERE status = 'cleanup_pending'
        AND (cleanup_next_attempt_at IS NULL OR cleanup_next_attempt_at <= ?)
        ${nodeId ? 'AND node_id = ?' : ''}
      ORDER BY cleanup_next_attempt_at, id
      LIMIT ?`
  )
    .bind(now, ...(nodeId ? [nodeId] : []), limit)
    .all<NodeTunnelRow>();
  return result.results ?? [];
}

/**
 * Storage-hygiene bound for `last_error` (provisioning and cleanup causes): an error message is
 * diagnostic text, not data, and a fixed cap keeps one row from carrying a huge payload.
 */
export const NODE_TUNNEL_LAST_ERROR_MAX_LENGTH = 500;

/**
 * Record why provisioning of this incarnation's tunnel failed or was cut off, on the journal row
 * itself, so a later cleanup or resume is diagnosable without logs. Never overwrites a cleaned
 * row. Never throws: diagnostics must not change the failure path.
 */
export async function recordNodeTunnelProvisioningError(
  env: JournalEnv,
  nodeId: string,
  runtimeIncarnationId: string,
  message: string
): Promise<void> {
  try {
    await env.DATABASE.prepare(
      `UPDATE node_cloudflare_tunnels SET last_error = ?, updated_at = ?
        WHERE node_id = ? AND runtime_incarnation_id = ? AND status IN ('provisioning', 'active')`
    )
      .bind(
        message.slice(0, NODE_TUNNEL_LAST_ERROR_MAX_LENGTH),
        new Date().toISOString(),
        nodeId,
        runtimeIncarnationId
      )
      .run();
  } catch {
    // The caller already logs the failure with full context.
  }
}
