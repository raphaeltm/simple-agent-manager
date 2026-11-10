/**
 * Provision the Cloudflare named tunnel for one managed workspace node incarnation.
 *
 * Ordering (every step idempotent, so a retry or durable resume converges):
 *   1. journal the exact (node, incarnation, tunnel name) BEFORE any Cloudflare or provider
 *      mutation, fenced on the node row still carrying that live incarnation;
 *   2. adopt-or-create the named tunnel; a lost create response is resolved by re-reading
 *      Cloudflare's inventory for the deterministic name (rule 75), never by a blind retry;
 *   3. set remote ingress to the VM agent's loopback tunnel listener, catch-all 404;
 *   4. point the existing `{nodeId}.vm.{BASE_DOMAIN}` hostname at the tunnel with a
 *      proxied CNAME (no new hostnames, no Worker routes);
 *   5. fetch the per-tunnel connector token for the protected cloud-init only.
 * The account API token never leaves the control plane; the connector token is returned to
 * the caller and is never logged or persisted.
 */
import { log } from '../lib/logger';
import {
  type CloudflareCallOptions,
  type CloudflareDnsRecord,
  CloudflareTunnelApiError,
  createProxiedTunnelCname,
  createRemoteTunnel,
  getDnsRecord,
  getTunnelToken,
  listDnsRecordsByName,
  listTunnelsByExactName,
  putTunnelIngress,
  tunnelCnameTarget,
} from './cloudflare-tunnel-api';
import { isDuplicateRecordConflict } from './dns-core';
import { cleanupNodeTunnelRow } from './node-tunnel-cleanup';
import {
  buildNodeTunnelIngress,
  buildNodeTunnelName,
  nodeTunnelHostname,
  resolveVmAgentTunnelPort,
  type TunnelEnv,
} from './node-tunnel-config';
import { withJournaledTunnelCreate } from './node-tunnel-create-journal';
import {
  NODE_TUNNEL_COLUMNS,
  type NodeTunnelRow,
  type OwnedNodeTunnelAssignment,
  readNodeTunnelByIncarnation,
  releaseNonLiveNodeTunnels,
  updateOwnedNodeTunnel,
} from './node-tunnel-journal';

export interface NodeTunnelProvisioning {
  tunnelId: string;
  tunnelName: string;
  hostname: string;
  tunnelPort: string;
  /** Per-tunnel connector token. SECRET: cloud-init only; never log or persist. */
  connectorToken: string;
}

/** The tunnel setup step in progress, reported so a failure or abort names where it stopped. */
export type NodeTunnelProvisioningPhase = 'journal' | 'tunnel' | 'ingress' | 'dns' | 'token';

export interface EnsureNodeTunnelInput {
  nodeId: string;
  userId: string;
  runtimeIncarnationId: string;
  signal?: AbortSignal;
  /**
   * Called as each step starts. A callback rather than a wrapped error, so an abort still
   * surfaces as the caller's own `signal.reason` (see `rethrowIfProviderRequestAborted`).
   */
  onPhase?: (phase: NodeTunnelProvisioningPhase) => void;
}

/** Fence for every node-row write: the exact live managed VM incarnation. */
const NODE_LIVE_FENCE_SQL = `id = ? AND user_id = ? AND runtime = 'vm' AND node_class = 'managed'
  AND runtime_incarnation_id = ? AND runtime_termination_confirmed_at IS NULL
  AND status NOT IN ('deleted', 'stopped', 'destroying')`;

/**
 * Superseded rows cleaned inline before taking over the shared hostname. Only the most recent
 * one can hold the CNAME (a CNAME is exclusive and every incarnation cleans its predecessor
 * first), so a small fixed bound suffices; the sweep owns any older backlog.
 */
const SUPERSEDED_CLEANUP_LIMIT = 2;

class NodeTunnelFenceError extends Error {
  override name = 'NodeTunnelFenceError';
}

async function journalTunnelOwnership(
  env: TunnelEnv,
  input: EnsureNodeTunnelInput,
  tunnelName: string,
  hostname: string
): Promise<NodeTunnelRow> {
  const now = new Date().toISOString();
  // INSERT ... SELECT so the journal row can only be created while the node row still
  // carries this exact live incarnation. OR IGNORE makes a retry/resume adopt its own row.
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO node_cloudflare_tunnels
       (id, node_id, user_id, runtime_incarnation_id, account_id, zone_id, tunnel_name,
        tunnel_id, hostname, dns_record_id, status, cleanup_reason, cleanup_attempts,
        cleanup_next_attempt_at, last_error, created_at, updated_at, cleaned_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'provisioning', NULL, 0, NULL, NULL, ?, ?, NULL
      WHERE EXISTS (SELECT 1 FROM nodes WHERE ${NODE_LIVE_FENCE_SQL})`
  )
    .bind(
      crypto.randomUUID(),
      input.nodeId,
      input.userId,
      input.runtimeIncarnationId,
      env.CF_ACCOUNT_ID,
      env.CF_ZONE_ID,
      tunnelName,
      hostname,
      now,
      now,
      input.nodeId,
      input.userId,
      input.runtimeIncarnationId
    )
    .run();
  const row = await readNodeTunnelByIncarnation(env, input.nodeId, input.runtimeIncarnationId);
  if (!row || row.userId !== input.userId) {
    throw new NodeTunnelFenceError(
      'Node incarnation changed before tunnel ownership was journaled'
    );
  }
  if (row.status !== 'provisioning' && row.status !== 'active') {
    throw new NodeTunnelFenceError('Tunnel for this node incarnation is already being cleaned up');
  }
  if (row.accountId !== env.CF_ACCOUNT_ID || row.zoneId !== env.CF_ZONE_ID) {
    throw new Error('Tunnel journal was written for a different Cloudflare account or zone');
  }
  await writeNodeTunnelFields(env, input, { transport: 'cloudflare-tunnel', tunnelName });
  return row;
}

async function writeNodeTunnelFields(
  env: TunnelEnv,
  input: EnsureNodeTunnelInput,
  fields: { transport: 'cloudflare-tunnel'; tunnelName: string } | { tunnelId: string }
): Promise<void> {
  const [assignments, binds] =
    'tunnelName' in fields
      ? ['transport = ?, tunnel_name = ?', [fields.transport, fields.tunnelName]]
      : ['tunnel_id = ?', [fields.tunnelId]];
  const result = await env.DATABASE.prepare(
    `UPDATE nodes SET ${assignments}, updated_at = ? WHERE ${NODE_LIVE_FENCE_SQL}`
  )
    .bind(
      ...binds,
      new Date().toISOString(),
      input.nodeId,
      input.userId,
      input.runtimeIncarnationId
    )
    .run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new NodeTunnelFenceError('Node incarnation changed during tunnel provisioning');
  }
}

async function persistOwned(
  env: TunnelEnv,
  row: NodeTunnelRow,
  assignments: OwnedNodeTunnelAssignment,
  binds: unknown[]
): Promise<void> {
  if (!(await updateOwnedNodeTunnel(env, row.id, assignments, binds))) {
    throw new NodeTunnelFenceError(
      'Tunnel for this node incarnation was released mid-provisioning'
    );
  }
}

/** Adopt the journal's tunnel, a tunnel created by a lost earlier response, or create one. */
async function ensureNamedTunnel(
  env: TunnelEnv,
  row: NodeTunnelRow,
  options: CloudflareCallOptions
): Promise<string> {
  if (row.tunnelId) return row.tunnelId;
  const adopt = async (): Promise<string | null> => {
    const existing = await listTunnelsByExactName(env, row.tunnelName, options);
    if (existing.length > 1) {
      throw new Error('Multiple live tunnels carry this incarnation name; operator cleanup needed');
    }
    return existing[0]?.id ?? null;
  };
  const adopted = await adopt();
  if (adopted) return adopted;
  try {
    return (
      await withJournaledTunnelCreate(env, row.id, () =>
        createRemoteTunnel(env, row.tunnelName, options)
      )
    ).id;
  } catch (createErr) {
    if (options.signal?.aborted) throw createErr;
    // The create may have succeeded behind a lost response or a name conflict. The name
    // embeds the random incarnation UUID, so an exact match is this incarnation's tunnel.
    const recovered = await adopt();
    if (recovered) {
      log.info('node_tunnel.create_recovered_by_name', { nodeId: row.nodeId, tunnelId: recovered });
      return recovered;
    }
    throw createErr;
  }
}

/** The record pointing this node's hostname at `target`, or a refusal naming the conflict. */
async function ensureTunnelCname(
  env: TunnelEnv,
  row: NodeTunnelRow,
  target: string,
  options: CloudflareCallOptions
): Promise<string> {
  const matches = (record: CloudflareDnsRecord | null) =>
    !!record &&
    record.type === 'CNAME' &&
    record.name === row.hostname &&
    record.content === target &&
    record.proxied === true;

  if (row.dnsRecordId) {
    const existing = await getDnsRecord(env, row.dnsRecordId, options);
    if (matches(existing)) return row.dnsRecordId;
    if (existing) throw new Error('Tunnel DNS record was changed outside this incarnation');
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await listDnsRecordsByName(env, row.hostname, options);
    const own = current.find(matches);
    if (own) return own.id;
    if (current.length > 0) {
      // Another incarnation of this node may still hold the shared hostname. Release and
      // clean every non-live incarnation of this node first; this incarnation's journal
      // row is live (fenced above), so only superseded ones are touched. Retry once.
      if (attempt === 0 && (await cleanupSupersededIncarnations(env, row))) continue;
      throw new Error(
        `Node backend hostname is held by ${current.length} record(s) not owned by this tunnel`
      );
    }
    try {
      const created = await withJournaledTunnelCreate(env, row.id, () =>
        createProxiedTunnelCname(
          env,
          row.hostname,
          target,
          `sam managed node tunnel ${row.tunnelName}`,
          options
        )
      );
      return created.id;
    } catch (err) {
      const conflict =
        err instanceof CloudflareTunnelApiError &&
        err.codes.some((code) => isDuplicateRecordConflict(code));
      const lostResponse = err instanceof CloudflareTunnelApiError && err.status === undefined;
      if (options.signal?.aborted || !(conflict || lostResponse) || attempt > 0) throw err;
      // A concurrent or lost create: re-read and adopt only an exact match (next loop).
    }
  }
  throw new Error('Tunnel DNS record could not be converged');
}

/** Release + clean every superseded incarnation of this node. True when any row was cleaned. */
async function cleanupSupersededIncarnations(env: TunnelEnv, row: NodeTunnelRow): Promise<boolean> {
  await releaseNonLiveNodeTunnels(env, 'superseded_by_new_incarnation', row.nodeId);
  const pending = await env.DATABASE.prepare(
    `SELECT ${NODE_TUNNEL_COLUMNS} FROM node_cloudflare_tunnels
      WHERE node_id = ? AND id != ? AND status = 'cleanup_pending'
      ORDER BY created_at DESC, id
      LIMIT ?`
  )
    .bind(row.nodeId, row.id, SUPERSEDED_CLEANUP_LIMIT)
    .all<NodeTunnelRow>();
  let cleaned = false;
  for (const stale of pending.results ?? []) {
    if (await cleanupNodeTunnelRow(env, stale)) cleaned = true;
  }
  return cleaned;
}

/**
 * Journal, create/adopt, configure and route this incarnation's tunnel; return the connector
 * token for cloud-init. Throws on any failure; the caller decides whether the incarnation
 * can be released (no VM requested) or must wait for runtime termination proof.
 */
export async function ensureNodeTunnelForProvisioning(
  env: TunnelEnv,
  input: EnsureNodeTunnelInput
): Promise<NodeTunnelProvisioning> {
  const tunnelPort = resolveVmAgentTunnelPort(env);
  const tunnelName = buildNodeTunnelName(input.nodeId, input.runtimeIncarnationId);
  const hostname = nodeTunnelHostname(input.nodeId, env);
  const options: CloudflareCallOptions = { signal: input.signal };

  input.onPhase?.('journal');
  const row = await journalTunnelOwnership(env, input, tunnelName, hostname);

  // Resume fast path. `active` is written only after ingress and the CNAME both converged
  // (below), so an earlier attempt that got that far needs just a DNS re-check and the token:
  // two Cloudflare calls instead of six, which is what lets a deadline-cut attempt finish on
  // the next one (rule 81).
  const resumed = await resumeActiveTunnel(env, row, options, input);
  if (resumed) {
    input.onPhase?.('token');
    const connectorToken = await getTunnelToken(env, resumed.tunnelId, options);
    log.info('node_tunnel.provisioning_resumed', {
      nodeId: input.nodeId,
      runtimeIncarnationId: input.runtimeIncarnationId,
      tunnelId: resumed.tunnelId,
      dnsRecordId: resumed.dnsRecordId,
    });
    return { tunnelId: resumed.tunnelId, tunnelName, hostname, tunnelPort, connectorToken };
  }

  input.onPhase?.('tunnel');
  const tunnelId = await ensureNamedTunnel(env, row, options);
  if (row.tunnelId !== tunnelId) {
    await persistOwned(env, row, 'tunnel_id = ?', [tunnelId]);
    row.tunnelId = tunnelId;
  }
  await writeNodeTunnelFields(env, input, { tunnelId });

  input.onPhase?.('ingress');
  await putTunnelIngress(env, tunnelId, buildNodeTunnelIngress(hostname, tunnelPort), options);

  input.onPhase?.('dns');
  const dnsRecordId = await ensureTunnelCname(env, row, tunnelCnameTarget(tunnelId), options);
  await persistOwned(env, row, `dns_record_id = ?, status = 'active'`, [dnsRecordId]);

  input.onPhase?.('token');
  const connectorToken = await getTunnelToken(env, tunnelId, options);
  log.info('node_tunnel.provisioned', {
    nodeId: input.nodeId,
    runtimeIncarnationId: input.runtimeIncarnationId,
    tunnelId,
    dnsRecordId,
  });
  return { tunnelId, tunnelName, hostname, tunnelPort, connectorToken };
}

/**
 * For a row an earlier attempt already made `active`: confirm its CNAME still points at its
 * tunnel and the node row carries the tunnel id, then skip the ingress and DNS convergence
 * steps. Anything unexpected returns null and the full idempotent path runs instead.
 */
async function resumeActiveTunnel(
  env: TunnelEnv,
  row: NodeTunnelRow,
  options: CloudflareCallOptions,
  input: EnsureNodeTunnelInput
): Promise<{ tunnelId: string; dnsRecordId: string } | null> {
  if (row.status !== 'active' || !row.tunnelId || !row.dnsRecordId) return null;
  input.onPhase?.('dns');
  const record = await getDnsRecord(env, row.dnsRecordId, options);
  const target = tunnelCnameTarget(row.tunnelId);
  if (
    !record ||
    record.type !== 'CNAME' ||
    record.name !== row.hostname ||
    record.content !== target ||
    record.proxied !== true
  ) {
    return null;
  }
  await writeNodeTunnelFields(env, input, { tunnelId: row.tunnelId });
  return { tunnelId: row.tunnelId, dnsRecordId: row.dnsRecordId };
}
