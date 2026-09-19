/**
 * Name-based cleanup of stale workspace/node DNS records.
 *
 * Split out of `dns.ts`; see `.claude/rules/18-file-size-limits.md`.
 */

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  deleteDNSRecord,
  dnsRecordListResponseSchema,
} from './dns-core';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

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
