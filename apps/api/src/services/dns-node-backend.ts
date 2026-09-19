/**
 * Proxied (orange-cloud) A records for node VM backends.
 *
 * Cloudflare's edge terminates TLS and re-encrypts to the Origin CA certificate
 * the VM agent serves. Split out of `dns.ts`; see
 * `.claude/rules/18-file-size-limits.md`.
 */

import { completeAbortableResponse } from '@simple-agent-manager/providers';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  dnsRecordIdResponseSchema,
  findDNSRecordByName,
  getDnsTTL,
  getNodeBackendHostname,
  isDuplicateRecordConflict,
  readCloudflareErrorDetail,
  updateDNSRecord,
} from './dns-core';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

/**
 * Create a proxied (orange-clouded) A record for a workspace VM backend.
 * Cloudflare's edge terminates TLS using the domain's SSL/TLS settings and
 * re-encrypts to the origin using the Origin CA certificate served by the VM agent.
 *
 * Uses `{id}.vm.{BASE_DOMAIN}` (two-level subdomain) to bypass Cloudflare
 * same-zone routing. The wildcard Worker route *.{domain}/* only matches
 * single-level subdomains, so {id}.vm.{domain} is NOT intercepted.
 */
export async function createBackendDNSRecord(
  workspaceId: string,
  ip: string,
  env: Env
): Promise<string> {
  return createNodeBackendDNSRecord(workspaceId, ip, env);
}

/**
 * Create a proxied (orange-clouded) A record for a node VM backend.
 * Cloudflare's edge handles TLS termination; the VM agent serves HTTPS
 * with an Origin CA certificate that CF trusts.
 *
 * Uses {nodeId}.vm.{BASE_DOMAIN} (two-level subdomain) to bypass Cloudflare
 * same-zone routing. The wildcard Worker route *.{domain}/* only matches
 * single-level subdomains, so {nodeId}.vm.{domain} is NOT intercepted.
 * This allows Worker subrequests (from DO alarms) to reach the VM directly.
 */
export async function createNodeBackendDNSRecord(
  nodeId: string,
  ip: string,
  env: Env,
  signal?: AbortSignal,
  recoverExisting = false
): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  const hostname = getNodeBackendHostname(nodeId, env.BASE_DOMAIN);
  if (recoverExisting) {
    const existing = await findDNSRecordByName(hostname, env, signal, true);
    if (existing) {
      assertRecoveredBackendDNSIdentity(existing, hostname, ip);
      return existing.id;
    }
  }
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `${nodeId.toLowerCase()}.vm`,
        content: ip,
        ttl: getDnsTTL(env),
        proxied: true, // Orange-clouded — CF edge terminates TLS, re-encrypts to Origin CA
      }),
    },
    timeoutMs,
    signal
  );

  const readable = signal ? await completeAbortableResponse(response, signal) : response;
  if (!readable.ok) {
    const detail = await readCloudflareErrorDetail(
      readable,
      `Failed to create backend DNS record: ${response.status}`
    );

    // Same concurrent-create race as upsertAppRouteDNSRecord, and the reason this
    // sibling is fixed alongside it (rule 75 §6). Two paths create this record —
    // node provisioning (services/node-provisioning.ts) and the heartbeat backfill
    // (routes/node-lifecycle.ts) — and the loser used to throw. That path only
    // stamps nodes.error_message and leaves backend_dns_record_id NULL, so every
    // later heartbeat retried the same losing POST forever, and node deletion
    // (which deletes by that id) left the real record orphaned in the zone.
    // Resolving the winner lets the id be persisted, which fixes both.
    const recoveredId = await recoverBackendDNSCreateConflict({
      detailCode: detail.code,
      env,
      hostname,
      ip,
      nodeId,
      recoverExisting,
      signal,
    });
    if (recoveredId) return recoveredId;

    throw new Error(detail.message);
  }

  const data = await readResponseJson(
    readable,
    dnsRecordIdResponseSchema,
    'cloudflare.dns.create_backend_record'
  );
  return data.result.id;
}

interface BackendDNSCreateConflictContext {
  detailCode: number | null;
  env: Env;
  hostname: string;
  ip: string;
  nodeId: string;
  recoverExisting: boolean;
  signal?: AbortSignal;
}

async function recoverBackendDNSCreateConflict({
  detailCode,
  env,
  hostname,
  ip,
  nodeId,
  recoverExisting,
  signal,
}: BackendDNSCreateConflictContext): Promise<string | null> {
  if (!isDuplicateRecordConflict(detailCode)) return null;

  const existing = await findRecordAfterConflict(hostname, env, signal);
  if (!existing) return null;

  await reconcileRecoveredBackendRecord(existing, hostname, ip, env, signal, recoverExisting);
  log.info('dns.node_backend_create_race_resolved', {
    nodeId,
    recordId: existing.id,
    code: detailCode,
  });
  return existing.id;
}

async function reconcileRecoveredBackendRecord(
  existing: { id: string; name: string; type: string; content?: string; proxied?: boolean },
  hostname: string,
  ip: string,
  env: Env,
  signal: AbortSignal | undefined,
  recoverExisting: boolean
): Promise<void> {
  if (recoverExisting) {
    // The durable provisioning path already refused a pre-existing record that
    // is not exactly this allocation's. A conflict that lands AFTER that
    // pre-check must be held to the same standard — converging it silently would
    // delete that refusal (rules 63 / 71).
    assertRecoveredBackendDNSIdentity(existing, hostname, ip);
    return;
  }

  if (existing.content === ip) return;

  // 81057 does not guarantee matching content, and the two creators can
  // legitimately disagree on the IP (provisioning uses the provider's
  // allocation, the heartbeat backfill uses the reported address). The caller is
  // the later writer, so converge before handing back an id it will treat as
  // authoritative. updateDNSRecord takes no signal, so re-check the deadline
  // rather than starting a write past it.
  if (signal?.aborted) throw signal.reason;
  await updateDNSRecord(existing.id, ip, env);
}

/**
 * Assert that an already-present backend record is exactly the one this call
 * intended to create.
 *
 * One predicate shared by the two places that can meet an existing record on the
 * durable provisioning path — the `recoverExisting` pre-check and the
 * duplicate-conflict recovery below it. Keeping them on one predicate is what
 * stops the conflict path from quietly accepting a record the pre-check would
 * have rejected.
 */
function assertRecoveredBackendDNSIdentity(
  existing: { name: string; type: string; content?: string; proxied?: boolean },
  hostname: string,
  ip: string
): void {
  if (
    existing.name !== hostname ||
    existing.type !== 'A' ||
    existing.content !== ip ||
    existing.proxied !== true
  ) {
    throw new Error('Existing backend DNS identity differs from the recovered allocation');
  }
}

/**
 * Resolve the record a duplicate-create conflict refers to, or null.
 *
 * `requireUnique` is deliberate: Cloudflare permits several A records for one
 * name (round-robin), so adopting "the first" would persist one id and orphan the
 * rest. An ambiguous zone is a real problem and must surface as the original
 * conflict rather than being silently resolved.
 *
 * A failed lookup is likewise not allowed to mask the original conflict, so it
 * degrades to null and the caller surfaces the create error it already has.
 */
async function findRecordAfterConflict(
  hostname: string,
  env: Env,
  signal?: AbortSignal
): Promise<{ id: string; name: string; type: string; content?: string; proxied?: boolean } | null> {
  try {
    return await findDNSRecordByName(hostname, env, signal, true);
  } catch (err) {
    // A cancelled request is not a resolvable conflict: the caller's deadline has
    // passed, so it must see the abort rather than a DNS error it cannot act on.
    if (signal?.aborted) throw err;
    log.warn('dns.conflict_lookup_failed', { hostname, error: String(err) });
    return null;
  }
}
