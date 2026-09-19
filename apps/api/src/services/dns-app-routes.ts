/**
 * Grey-cloud A records for deployment app-route hostnames.
 *
 * App routes intentionally use HTTP-01 ACME on the deployment node, so these
 * records must not be proxied by Cloudflare. Split out of `dns.ts`; see
 * `.claude/rules/18-file-size-limits.md`.
 */

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  deleteDNSRecord,
  DNS_UPSERT_RACE_MAX_RETRIES,
  dnsRecordIdResponseSchema,
  findDNSRecordByName,
  findDNSRecordMatchesByName,
  getDnsTTL,
  isDuplicateRecordConflict,
  readCloudflareErrorDetail,
} from './dns-core';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

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
  // `for (;;)` rather than a counted loop: the body always returns or throws, and
  // TypeScript cannot prove that of a counted loop — which would force an
  // unreachable trailing throw.
  for (let attempt = 0; ; attempt++) {
    // Deliberately NOT `requireUnique`, unlike the node-backend conflict lookup.
    // That one resolves an id the caller PERSISTS, so adopting one of several
    // records orphans the rest and must fail. Here nothing is persisted: this
    // upsert gates a node's whole release fetch, so failing it would reinstate
    // the exact 500-wedge this function exists to remove (rule 75 §1). Converge
    // the first match and record the anomaly so a stale sibling record — which a
    // node migration can leave behind pointing at the old IP — is still findable.
    const matches = await findDNSRecordMatchesByName(hostname, env);
    if (matches.length > 1) {
      log.warn('dns.app_route_ambiguous_records', {
        hostname,
        matchCount: matches.length,
        recordIds: matches.map((record) => record.id),
      });
    }
    const existing = matches[0] ?? null;
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
