import { completeAbortableResponse } from '@simple-agent-manager/providers';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Default DNS TTL in seconds (1 minute) */
const DEFAULT_DNS_TTL = 60;

/** Default timeout for Cloudflare API calls (per Constitution Principle XI) */
const DEFAULT_CF_API_TIMEOUT_MS = 30_000;

// `code` is deliberately `unknown` rather than `v.optional(v.number())`. Valibot's
// optional() only bypasses a missing/undefined key, so `code: null` or a stringified
// code would fail the whole entry — and readCloudflareErrorDetail swallows parse
// failures and falls back to a generic message. That would silently discard
// Cloudflare's real error text for every caller, including the ones that never asked
// to branch on the code at all. Parse permissively; narrow to a number at use.
const cloudflareErrorSchema = v.object({
  errors: v.optional(
    v.array(
      v.object({
        code: v.optional(v.unknown()),
        message: v.string(),
      })
    )
  ),
});

/**
 * Cloudflare DNS API error codes meaning "this exact record already exists".
 *
 * Raised when a concurrent caller created the record between our lookup and our
 * create. Recoverable: re-resolve and converge on the winner's record.
 *
 * Deliberately EXCLUDES 81053 ("An A, AAAA, or CNAME record with that host
 * already exists"), which reports a different-type collision — a real
 * misconfiguration that retrying cannot fix and must keep surfacing.
 */
const CF_DNS_DUPLICATE_RECORD_CODES = new Set([81057, 81058]);

/**
 * Attempts for a create that lost a duplicate-record race: the original, plus one
 * re-resolve-and-update. Not env-exposed — this bounds an internal recovery loop
 * against a constraint that resolves in a single round trip, not a caller-facing
 * retry policy.
 */
const DNS_UPSERT_RACE_MAX_RETRIES = 1;

/** True when a failed create can be recovered by resolving the winner's record. */
function isDuplicateRecordConflict(code: number | null): boolean {
  return code !== null && CF_DNS_DUPLICATE_RECORD_CODES.has(code);
}

const dnsRecordIdResponseSchema = v.object({
  result: v.object({ id: v.string() }),
});

const dnsRecordListResponseSchema = v.object({
  result: v.array(v.object({
    id: v.string(),
    name: v.string(),
    type: v.string(),
    content: v.optional(v.string()),
    proxied: v.optional(v.boolean()),
  })),
});

/**
 * Read the first Cloudflare API error as a `{ code, message }` pair.
 *
 * A Response body can only be consumed once, so callers that need to branch on
 * the numeric code must read both together rather than calling
 * {@link readCloudflareError} and then re-reading the body.
 */
async function readCloudflareErrorDetail(
  response: Response,
  fallback: string
): Promise<{ code: number | null; message: string }> {
  try {
    const error = await readResponseJson(response, cloudflareErrorSchema, 'cloudflare.dns.error');
    const first = error.errors?.[0];
    // Only a real number is usable for branching; anything else is treated as
    // "no code", which keeps the message intact and excludes it from any retry.
    const code = typeof first?.code === 'number' ? first.code : null;
    return { code, message: first?.message || fallback };
  } catch {
    return { code: null, message: fallback };
  }
}

async function readCloudflareError(response: Response, fallback: string): Promise<string> {
  return (await readCloudflareErrorDetail(response, fallback)).message;
}

/**
 * Get DNS TTL from env or use default (per constitution principle XI).
 */
export function getDnsTTL(env?: { DNS_TTL_SECONDS?: string }): number {
  if (env?.DNS_TTL_SECONDS) {
    const ttl = parseInt(env.DNS_TTL_SECONDS, 10);
    if (!isNaN(ttl) && ttl > 0) {
      return ttl;
    }
  }
  return DEFAULT_DNS_TTL;
}

/**
 * DNS Record interface
 */
export interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

/**
 * DNS Service interface for dependency injection
 */
export interface DNSServiceInterface {
  createRecord(workspaceId: string, ip: string, baseDomain: string): Promise<DNSRecord>;
  deleteRecord(workspaceId: string, baseDomain: string): Promise<boolean>;
  findRecord(workspaceId: string, baseDomain: string): Promise<DNSRecord | null>;
  recordExists(workspaceId: string, baseDomain: string): Promise<boolean>;
}

/**
 * Cloudflare DNS Service implementation
 */
export class DNSService implements DNSServiceInterface {
  constructor(private env: Env) {}

  async createRecord(workspaceId: string, ip: string, _baseDomain: string): Promise<DNSRecord> {
    const id = await createDNSRecord(workspaceId, ip, this.env);
    const ttl = getDnsTTL(this.env);
    return {
      id,
      name: `ws-${workspaceId}`,
      type: 'A',
      content: ip,
      proxied: true,
      ttl,
    };
  }

  async deleteRecord(_workspaceId: string, _baseDomain: string): Promise<boolean> {
    return true;
  }

  async findRecord(_workspaceId: string, _baseDomain: string): Promise<DNSRecord | null> {
    return null;
  }

  async recordExists(workspaceId: string, baseDomain: string): Promise<boolean> {
    const record = await this.findRecord(workspaceId, baseDomain);
    return record !== null;
  }
}

/**
 * Create a DNS A record for a workspace.
 * Uses Cloudflare proxy for automatic HTTPS.
 */
export async function createDNSRecord(
  workspaceId: string,
  ip: string,
  env: Env
): Promise<string> {
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
        name: `ws-${workspaceId}`,
        content: ip,
        ttl: getDnsTTL(env), // Configurable TTL (default 1 minute for fast updates)
        proxied: true, // Enable Cloudflare proxy for HTTPS
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    throw new Error(await readCloudflareError(response, `Failed to create DNS record: ${response.status}`));
  }

  const data = await readResponseJson(response, dnsRecordIdResponseSchema, 'cloudflare.dns.create_record');
  return data.result.id;
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDNSRecord(
  recordId: string,
  env: Env,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    },
    timeoutMs, signal
  );

  // The background caller's deadline must also cover a stalled error body after
  // fetchWithTimeout has received headers and cleared its own request timer.
  const readableResponse = signal ? await completeAbortableResponse(response, signal) : response;
  // Ignore 404 errors (record already deleted)
  if (!readableResponse.ok && readableResponse.status !== 404) {
    throw new Error(await readCloudflareError(readableResponse, `Failed to delete DNS record: ${readableResponse.status}`));
  }
}

/**
 * Update a DNS record with a new IP address.
 */
export async function updateDNSRecord(
  recordId: string,
  ip: string,
  env: Env
): Promise<void> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: ip,
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    throw new Error(await readCloudflareError(response, `Failed to update DNS record: ${response.status}`));
  }
}

async function findDNSRecordByName(
  recordName: string,
  env: Env,
  signal?: AbortSignal,
  requireUnique = false,
): Promise<{ id: string; name: string; type: string; content?: string; proxied?: boolean } | null> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const searchUrl = `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(recordName)}`;
  const response = await fetchWithTimeout(searchUrl, {
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
  }, timeoutMs, signal);
  const readable = signal ? await completeAbortableResponse(response, signal) : response;

  if (!readable.ok) {
    throw new Error(await readCloudflareError(readable, `Failed to find DNS record: ${response.status}`));
  }

  const data = await readResponseJson(readable, dnsRecordListResponseSchema, 'cloudflare.dns.find_record_by_name');
  if (requireUnique && data.result.length > 1) throw new Error('Multiple DNS records match the node backend hostname');
  return data.result[0] ?? null;
}

/**
 * Create or update a grey-cloud A record for an app route hostname.
 *
 * App routes intentionally use HTTP-01 ACME on the deployment node, so these
 * records must not be proxied by Cloudflare.
 */
export async function upsertAppRouteDNSRecord(
  hostname: string,
  ip: string,
  env: Env,
): Promise<string> {
  // Check-then-act across an await: concurrent callers can both observe "no
  // record" and both POST, and Cloudflare rejects the loser as a duplicate.
  // This is reachable in production — `deploy-release-callback.ts` upserts every
  // route through Promise.all, and overlapping node release fetches run that
  // whole handler concurrently. The loser used to throw, which failed the node's
  // release fetch with a 500 and wedged the deployment before any cert work.
  // Re-resolve once and update in place so the loser converges instead.
  for (let attempt = 0; attempt <= DNS_UPSERT_RACE_MAX_RETRIES; attempt++) {
    const existing = await findDNSRecordByName(hostname, env);
    const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
    const body = JSON.stringify({
      type: 'A',
      name: hostname,
      content: ip,
      ttl: getDnsTTL(env),
      proxied: false,
    });

    const response = await fetchWithTimeout(
      existing
        ? `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${existing.id}`
        : `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`,
      {
        method: existing ? 'PUT' : 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
      },
      timeoutMs,
    );

    if (response.ok) {
      const data = await readResponseJson(response, dnsRecordIdResponseSchema, 'cloudflare.dns.upsert_app_route_record');
      return data.result.id;
    }

    const detail = await readCloudflareErrorDetail(
      response,
      `Failed to upsert app route DNS record: ${response.status}`
    );

    // `!existing` is load-bearing: only the create path can lose this race. On the
    // update path the same code means something else, and widening the tolerance
    // there would retry a PUT against a record we already resolved (rule 75 §4).
    const lostCreateRace = !existing && isDuplicateRecordConflict(detail.code);
    if (!lostCreateRace || attempt === DNS_UPSERT_RACE_MAX_RETRIES) {
      throw new Error(detail.message);
    }

    log.info('dns.app_route_upsert_race_retry', { hostname, code: detail.code });
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error(`Failed to upsert app route DNS record for ${hostname}`);
}

/**
 * Delete the app-route A record for a hostname, if one exists.
 *
 * Idempotent: a missing record (or a record already removed by a concurrent
 * caller) is treated as success. Returns true if a record was found and
 * deleted, false if no matching record existed.
 */
export async function deleteAppRouteDNSRecord(
  hostname: string,
  env: Env,
): Promise<boolean> {
  const existing = await findDNSRecordByName(hostname, env);
  if (!existing) {
    return false;
  }
  await deleteDNSRecord(existing.id, env);
  return true;
}

/**
 * Bulk-deprovision app-route A records by hostname.
 *
 * Used when tearing down a deployment environment (or the node hosting it) so
 * the grey-cloud `r{n}-{service}-{port}-{envId}.apps.{domain}` records created
 * by {@link upsertAppRouteDNSRecord} do not accumulate as orphans. Tolerant of
 * already-deleted records and of individual delete failures (logged, skipped)
 * so a single bad record cannot block the rest of the teardown. Returns the
 * number of records actually deleted.
 */
export async function cleanupAppRouteDNSRecords(
  hostnames: string[],
  env: Env,
): Promise<number> {
  let deleted = 0;
  for (const hostname of hostnames) {
    try {
      if (await deleteAppRouteDNSRecord(hostname, env)) {
        deleted++;
        log.info('dns.app_route_record_cleaned_up', { hostname });
      }
    } catch (err) {
      log.error('dns.app_route_delete_failed', { hostname, error: String(err) });
    }
  }
  return deleted;
}

/**
 * Find and delete any DNS records matching a workspace/node by name.
 * This handles the case where we lost the record ID but a stale A record still exists.
 * Cleans up:
 *   - ws-{id}.{domain} (workspace proxied records)
 *   - vm-{id}.{domain} (legacy backend records, pre two-level subdomain migration)
 *   - {id}.vm.{domain} (current backend records, two-level subdomain format)
 */
export async function cleanupWorkspaceDNSRecords(
  workspaceId: string,
  env: Env
): Promise<number> {
  const baseDomain = env.BASE_DOMAIN;
  const id = workspaceId.toLowerCase();

  // Search for all possible DNS record name formats
  const recordNames = [
    `ws-${id}.${baseDomain}`,       // workspace proxied
    `vm-${id}.${baseDomain}`,       // legacy backend (pre migration)
    `${id}.vm.${baseDomain}`,       // current backend (two-level subdomain)
  ];
  let deleted = 0;

  for (const recordName of recordNames) {
    const searchUrl = `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(recordName)}`;
    const cfTimeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }, cfTimeoutMs);

    if (!response.ok) {
      log.error('dns.search_records_failed', { recordName, status: response.status });
      continue;
    }

    const data = await readResponseJson(response, dnsRecordListResponseSchema, 'cloudflare.dns.cleanup_records');
    const records = data.result || [];

    for (const record of records) {
      try {
        await deleteDNSRecord(record.id, env);
        deleted++;
        log.info('dns.record_cleaned_up', { name: record.name, type: record.type, id: record.id });
      } catch (err) {
        log.error('dns.delete_record_failed', { recordId: record.id, error: String(err) });
      }
    }
  }

  return deleted;
}

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
    timeoutMs, signal
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
    if (isDuplicateRecordConflict(detail.code)) {
      const existing = await findRecordAfterConflict(hostname, env, signal);
      if (existing) {
        if (recoverExisting) {
          // The durable provisioning path already refused a pre-existing record
          // that is not exactly this allocation's. A conflict that lands AFTER
          // that pre-check must be held to the same standard — converging it
          // silently would delete that refusal (rules 63 / 71).
          assertRecoveredBackendDNSIdentity(existing, hostname, ip);
        } else if (existing.content !== ip) {
          // 81057 does not guarantee matching content, and the two creators can
          // legitimately disagree on the IP (provisioning uses the provider's
          // allocation, the heartbeat backfill uses the reported address). The
          // caller is the later writer, so converge before handing back an id it
          // will treat as authoritative. updateDNSRecord takes no signal, so
          // re-check the deadline rather than starting a write past it.
          if (signal?.aborted) throw signal.reason;
          await updateDNSRecord(existing.id, ip, env);
        }
        log.info('dns.node_backend_create_race_resolved', {
          nodeId,
          recordId: existing.id,
          code: detail.code,
        });
        return existing.id;
      }
    }

    throw new Error(detail.message);
  }

  const data = await readResponseJson(readable, dnsRecordIdResponseSchema, 'cloudflare.dns.create_backend_record');
  return data.result.id;
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

/**
 * Get the backend hostname for a workspace VM.
 * Used by the Worker proxy to route subrequests via DNS instead of raw IP.
 */
export function getBackendHostname(workspaceId: string, baseDomain: string): string {
  return getNodeBackendHostname(workspaceId, baseDomain);
}

/**
 * Get the backend hostname for a node VM.
 * Uses {nodeId}.vm.{BASE_DOMAIN} (two-level subdomain to bypass same-zone routing).
 */
export function getNodeBackendHostname(nodeId: string, baseDomain: string): string {
  return `${nodeId.toLowerCase()}.vm.${baseDomain}`;
}

/**
 * Get the workspace URL from a workspace ID.
 */
export function getWorkspaceUrl(workspaceId: string, baseDomain: string): string {
  return `https://ws-${workspaceId}.${baseDomain}`;
}
